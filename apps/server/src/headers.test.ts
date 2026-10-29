// Security headers on every answer of the app: web app, static files, API (sec-007).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';

let root: string;
let app: App;
let cookie: string;
let mountId: string;
const THEME = "\n      document.documentElement.classList.toggle('dark', true);\n    ";
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
/** The directives of a CSP header by name. */
const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...values]) => [name!, values]));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-headers-'));
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), `<!doctype html><title>Kaveyl Wiki</title><script>${THEME}</script><script type="module" src="/assets/app.js"></script>`);
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1);');
  const wiki = join(root, 'projekte', 'wiki');
  mkdirSync(join(wiki, 'docs'), { recursive: true });
  writeFileSync(join(wiki, 'docs', 'home.md'), '# Home\n');
  writeFileSync(join(wiki, 'docs', 'bild.png'), 'png');
  app = await buildApp(
    { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: web },
    { logger: false, nightlyFsck: false },
  );
  await app.manager.start();
  const setup = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' } });
  cookie = `kw_session=${setup.cookies.find((c) => c.name === 'kw_session')!.value}`;
  const m = await app.server.inject({ method: 'POST', url: '/api/mounts', payload: JSON.stringify({ type: 'local', source: wiki, name: 'Wiki' }), headers: { 'content-type': 'application/json', cookie } });
  mountId = (m.json() as { id: string }).id;
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') => app.server.inject({ method: 'GET', url, headers, remoteAddress });

describe('security headers', () => {
  it('web app, static file, deep link, API and 401 all carry them', async () => {
    for (const [url, status] of [
      ['/', 200],
      ['/assets/app.js', 200],
      ['/n/irgendwo/notiz.md', 200], // note link, SPA fallback (index.html)
      ['/health', 200],
      ['/api/mounts', 401], // without a login
    ] as const) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(status);
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['referrer-policy'], url).toBe('same-origin');
      expect(res.headers['x-frame-options'], url).toBe('SAMEORIGIN');
      const csp = directives(String(res.headers['content-security-policy']));
      expect(csp.get('frame-ancestors'), url).toEqual(["'self'"]);
      expect(csp.get('object-src'), url).toEqual(["'none'"]);
      expect(csp.get('base-uri'), url).toEqual(["'self'"]);
      expect(csp.get('form-action'), url).toEqual(["'self'"]);
      expect(res.headers['strict-transport-security'], url).toBeUndefined(); // plain http
    }
  });

  it('the CSP limits scripts to the app itself and the inline theme script by hash (sec-006)', async () => {
    const csp = directives(String((await get('/')).headers['content-security-policy']));
    expect(csp.get('default-src')).toEqual(["'self'"]);
    // Exactly these: no 'unsafe-inline', no hosts or schemes. 'unsafe-eval' only for Excalidraw's font subsetting (app.ts).
    expect(csp.get('script-src')).toEqual(["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", sha(THEME)]);
    expect(csp.get('worker-src')).toEqual(["'self'", 'blob:']);
  });

  it('the real index.html has no inline script other than the ones the CSP allows by hash', () => {
    const html = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'index.html'), 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(inline.map((m) => m[0].slice(0, 8))).toEqual(['<script>']); // plain <script>: the form the server hashes
  });

  it('no answer may be indexed by search engines (seo-001): web app, files, API, errors', async () => {
    for (const [url, headers] of [
      ['/', {}],
      ['/assets/app.js', {}],
      ['/notiz/irgendwo', {}],
      ['/health', {}],
      ['/api/mounts', {}],
      ['/api/gibt-es-nicht', {}],
      [`/api/files/${mountId}/docs/bild.png`, { cookie }],
    ] as const) {
      expect((await get(url, headers)).headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
  });

  it('files from notes keep their own stricter CSP (sandbox)', async () => {
    const res = await get(`/api/files/${mountId}/docs/bild.png`, { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('HSTS only when the request came over https through a trusted proxy', async () => {
    const https = await get('/', { 'x-forwarded-proto': 'https' });
    expect(https.headers['strict-transport-security']).toBe('max-age=15552000');
    expect((await get('/api/mounts', { 'x-forwarded-proto': 'https' })).headers['strict-transport-security']).toBe('max-age=15552000');
    // Someone who is not the proxy cannot claim https.
    expect((await get('/', { 'x-forwarded-proto': 'https' }, '203.0.113.20')).headers['strict-transport-security']).toBeUndefined();
  });
});
