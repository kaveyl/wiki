// How the built web app is delivered: caching of hashed build files (seo-006), compression (seo-004).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';

let root: string;
let app: App;
let cookie: string;
// Big enough for compression (it starts at 1 KiB).
const JS = `console.log(${JSON.stringify('Kaveyl Wiki '.repeat(400))});`;
const HTML = `<!doctype html><title>Kaveyl Wiki</title><!-- ${'x'.repeat(2000)} -->`;
// Compressed at build time (seo-004): marked, so the test sees whether exactly these files go out.
const PRE = `console.log(${JSON.stringify('vorab '.repeat(400))});`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-static-'));
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  mkdirSync(join(web, 'hilfe'), { recursive: true });
  writeFileSync(join(web, 'index.html'), HTML);
  writeFileSync(join(web, 'assets', 'index-Da4dqZp-.js'), JS);
  writeFileSync(join(web, 'assets', 'index-C2VEWLvZ.css'), 'body{margin:0}'.repeat(200));
  writeFileSync(join(web, 'assets', 'font-AbCdEf12.woff2'), Buffer.alloc(4096, 7));
  writeFileSync(join(web, 'assets', 'Shell-Pre12345.js'), PRE);
  writeFileSync(join(web, 'assets', 'Shell-Pre12345.js.br'), brotliCompressSync(`${PRE}// br`));
  writeFileSync(join(web, 'assets', 'Shell-Pre12345.js.gz'), gzipSync(`${PRE}// gz`));
  writeFileSync(join(web, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"Kaveyl Wiki"}');
  writeFileSync(join(web, 'robots.txt'), 'User-agent: *\nDisallow:\n');
  writeFileSync(join(web, 'hilfe', 'BENUTZERHANDBUCH.md'), '# Handbuch\n');
  app = await buildApp(
    { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: web },
    { logger: false, nightlyFsck: false },
  );
  const setup = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' } });
  cookie = `kw_session=${setup.cookies.find((c) => c.name === 'kw_session')!.value}`;
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => app.server.inject({ method: 'GET', url, headers });

describe('caching of the web app', () => {
  it('hashed build files under /assets/ are cached for a year and never revalidated', async () => {
    for (const url of ['/assets/index-Da4dqZp-.js', '/assets/index-C2VEWLvZ.css']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('public, max-age=31536000, immutable');
    }
  });

  it('files without a hash in the name stay revalidated, so an update arrives at once', async () => {
    for (const url of ['/', '/n/abc/notiz.md', '/sw.js', '/manifest.webmanifest', '/robots.txt', '/hilfe/BENUTZERHANDBUCH.md']) {
      const res = await get(url, { accept: 'text/html' });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('public, max-age=0');
    }
  });
});

describe('compression of the web app', () => {
  const both = { 'accept-encoding': 'gzip, br' };

  it('the page and the build files go out compressed, and unpack to the same bytes', async () => {
    for (const [url, body] of [['/', HTML], ['/assets/index-Da4dqZp-.js', JS]] as const) {
      const res = await get(url, { ...both, accept: 'text/html' });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-encoding'], url).toBe('br');
      expect(String(res.headers.vary), url).toMatch(/accept-encoding/i);
      expect(brotliDecompressSync(res.rawPayload).toString(), url).toBe(body);
    }
    const css = await get('/assets/index-C2VEWLvZ.css', { 'accept-encoding': 'gzip' });
    expect(css.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(css.rawPayload).toString()).toBe('body{margin:0}'.repeat(200));
    // Caching from seo-006 stays.
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('without accept-encoding, for binary files and for a range request nothing is compressed', async () => {
    expect((await get('/assets/index-Da4dqZp-.js')).headers['content-encoding']).toBeUndefined();
    expect((await get('/assets/font-AbCdEf12.woff2', both)).headers['content-encoding']).toBeUndefined();
    const part = await get('/assets/index-Da4dqZp-.js', { ...both, range: 'bytes=0-99' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-encoding']).toBeUndefined();
    expect(part.body).toBe(JS.slice(0, 100));
  });

  it('files compressed at build time go out as they are (.br, .gz), the plain file without accept-encoding', async () => {
    const file = (ext: string) => readFileSync(join(root, 'web', 'assets', `Shell-Pre12345.js${ext}`));
    const br = await get('/assets/Shell-Pre12345.js', both);
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toMatch(/javascript/);
    expect(String(br.headers.vary)).toMatch(/accept-encoding/i);
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(br.rawPayload.equals(file('.br'))).toBe(true);
    const gz = await get('/assets/Shell-Pre12345.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.rawPayload.equals(file('.gz'))).toBe(true);
    const plain = await get('/assets/Shell-Pre12345.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(PRE);
    // The compressed files are no addresses of their own.
    expect((await get('/assets/Shell-Pre12345.js.br')).statusCode).toBe(404);
  });

  it('API answers stay uncompressed (only the delivered app files are compressed)', async () => {
    const res = await get('/api/v1/openapi.json', { ...both, cookie });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(1024);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toHaveProperty('openapi');
  });
});
