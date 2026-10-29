// Missing paths are a real 404, not the app's index.html with 200 (seo-002). Page addresses of the app keep working.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';

let root: string;
let app: App;
let cookie: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-notfound-'));
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Kaveyl Wiki</title>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1);');
  // The real file from the web app (vite copies public/ into the build).
  copyFileSync(join(import.meta.dirname, '..', '..', 'web', 'public', 'robots.txt'), join(web, 'robots.txt'));
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
const isApp = (body: string) => body.startsWith('<!doctype html>');

describe('missing paths', () => {
  it('robots.txt is a real text file that does not lock crawlers out (they must see the noindex)', async () => {
    const res = await get('/robots.txt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toMatch(/^User-agent: \*$/m);
    expect(res.body).not.toMatch(/^Disallow:\s*\S/m);
  });

  it('files that do not exist are 404, not the app', async () => {
    for (const url of ['/sitemap.xml', '/favicon.ico', '/wp-login.php', '/security.txt', '/assets/alt-1234.js', '/assets/app.js.map', '/hilfe/en/handbuch.md', '/hilfe/handbuch/fehlt.webp', '/%73itemap.xml']) {
      const res = await get(url, { cookie });
      expect(res.statusCode, url).toBe(404);
      expect(isApp(res.body), url).toBe(false);
    }
  });

  it('unknown API paths are a JSON 404, also when written with %-escapes or extra slashes', async () => {
    for (const url of ['/api/gibt-es-nicht', '/%61pi/gibt-es-nicht', '/%61%70%69/gibt-es-nicht', '//api/gibt-es-nicht', '/api']) {
      const res = await get(url, { cookie });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'Nicht gefunden' });
    }
  });

  it('a page address the app does not know is 404 but still opens the app', async () => {
    for (const url of ['/gibt-es-nicht', '/login', '/hilfe']) {
      const res = await get(url, { accept: 'text/html' });
      expect(res.statusCode, url).toBe(404);
      expect(isApp(res.body), url).toBe(true);
    }
  });

  it('the app and its note links still open with 200', async () => {
    for (const url of ['/', '/?x=1', '/n/abc123/notiz.md', '/n/abc123/ordner/Gr%C3%BC%C3%9Fe%20und%20mehr.md', '/n/abc123/ordner']) {
      const res = await get(url, { accept: 'text/html' });
      expect(res.statusCode, url).toBe(200);
      expect(isApp(res.body), url).toBe(true);
    }
    expect((await get('/assets/app.js')).statusCode).toBe(200);
  });
});
