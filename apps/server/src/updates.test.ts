// Update hint (AD-062): the release check against a fake GitHub, version comparison, on/off for admins only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { isNewer, parseVersion, UpdateCheck } from './updates.js';

const ADMIN_PW = 'Admin-Passwort-0001';

/** GitHub's „latest release“ answer, or a status code. */
class FakeGitHub {
  answer: { status: number; body?: unknown } = { status: 404 };
  calls = 0;
  private server: Server | null = null;
  url = '';
  async start() {
    this.server = createServer((_req, res) => {
      this.calls++;
      res.statusCode = this.answer.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(this.answer.body ?? { message: 'Not Found' }));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/repos/x/kaveyl-wiki/releases/latest`;
  }
  release(tag: string, name = `Kaveyl Wiki ${tag}`) {
    this.answer = { status: 200, body: { tag_name: tag, name, html_url: `https://github.com/x/kaveyl-wiki/releases/tag/${tag}`, published_at: '2026-11-01T10:00:00Z' } };
  }
  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

describe('version comparison', () => {
  it('reads release, development and tag versions; local builds are never older', () => {
    expect(parseVersion('0.1.2+dev (77584d6)')).toEqual([0, 1, 2]);
    expect(parseVersion('v0.1.10')).toEqual([0, 1, 10]);
    expect(parseVersion('dev')).toBeNull();
    // Beta releases (AD-070): the word sits between number and commit; GitHub tags stay v<X.Y.Z>.
    expect(parseVersion('0.2.0 Beta (abc1234)')).toEqual([0, 2, 0]);
    expect(isNewer('0.2.1', '0.2.0 Beta (abc1234)')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0 Beta (abc1234)')).toBe(false);
    expect(isNewer('0.1.10', '0.1.9 (abc1234)')).toBe(true);
    expect(isNewer('0.2.0', '0.1.12')).toBe(true);
    expect(isNewer('0.1.3', '0.1.3 (abc1234)')).toBe(false);
    expect(isNewer('0.1.2', '0.1.3')).toBe(false);
    expect(isNewer('0.1.4', 'dev')).toBe(false);
  });
});

describe('UpdateCheck', () => {
  let gh: FakeGitHub;
  let kv: Map<string, string>;
  let logged: string[];
  const make = (current = '0.1.3 (abc1234)') =>
    new UpdateCheck({ get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) }, current, (_l, m) => void logged.push(m), gh.url);

  beforeEach(async () => {
    gh = new FakeGitHub();
    await gh.start();
    kv = new Map();
    logged = [];
  });
  afterEach(() => gh.stop());

  it('no public release yet: nothing to show, nothing logged', async () => {
    const s = await make().check();
    expect(s).toMatchObject({ enabled: true, latest: null, newer: false, problem: null });
    expect(s.checkedAt).toBeTruthy();
    expect(logged).toEqual([]);
  });

  it('a newer release is shown and logged once; a security release is marked', async () => {
    const u = make();
    gh.release('v0.1.4');
    expect(await u.check()).toMatchObject({ newer: true, latest: { version: '0.1.4', url: 'https://github.com/x/kaveyl-wiki/releases/tag/v0.1.4', security: false } });
    await u.check();
    expect(logged).toEqual(['Neue Version 0.1.4 von Kaveyl Wiki erschienen']);
    gh.release('v0.1.5', 'Kaveyl Wiki 0.1.5 – Sicherheitsupdate');
    expect((await u.check()).latest).toMatchObject({ version: '0.1.5', security: true });
    expect(logged[1]).toBe('Neue Version 0.1.5 von Kaveyl Wiki erschienen (Sicherheitsupdate)');
  });

  it('the same or an older release is no update', async () => {
    gh.release('v0.1.3');
    expect((await make().check()).newer).toBe(false);
    expect(logged).toEqual([]);
  });

  it('GitHub unreachable or odd: the last result stays, the problem is logged once', async () => {
    const u = make();
    gh.release('v0.1.4');
    await u.check();
    gh.answer = { status: 503 };
    expect(await u.check()).toMatchObject({ newer: true, problem: 'status:503' });
    await u.check();
    gh.answer = { status: 200, body: { tag_name: 'nightly', html_url: 'javascript:alert(1)' } };
    expect((await u.check()).problem).toBe('invalid');
    expect(logged.slice(1)).toEqual(['Update-Prüfung: GitHub antwortet mit 503', 'Update-Prüfung: unerwartete Antwort von GitHub']);
    await gh.stop();
    expect((await u.check()).problem).toBe('unreachable');
  });
});

describe('update routes', () => {
  let gh: FakeGitHub;
  let root: string;
  let app: App;
  let cookie: string;
  type Res = { statusCode: number; json: () => any; cookies: { name: string; value: string }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, c: string | null = cookie) =>
    app.server.inject({ method, url, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}), headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) } }) as Promise<Res>;

  beforeEach(async () => {
    gh = new FakeGitHub();
    await gh.start();
    root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-updates-'));
    const config = { ...loadConfig({}), version: '0.1.3 (abc1234)', dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
    app = await buildApp(config, { logger: false, nightlyFsck: false, updateUrl: gh.url });
    const setup = await req('POST', '/api/setup', { email: 'admin@example.test', password: ADMIN_PW, displayName: 'Anna Admin' }, null);
    cookie = `kw_session=${setup.cookies.find((c) => c.name === 'kw_session')!.value}`;
  });

  afterEach(async () => {
    await app.close();
    await gh.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('admins only; check now; switched off it no longer asks GitHub', async () => {
    await req('POST', '/api/admin/users', { email: 'max@example.test', password: 'Start-Passwort-0001' });
    const max = await req('POST', '/api/login', { email: 'max@example.test', password: 'Start-Passwort-0001' }, null);
    const maxCookie = `kw_session=${max.cookies.find((c) => c.name === 'kw_session')!.value}`;
    for (const [m, u] of [['GET', '/api/admin/updates'], ['PUT', '/api/admin/updates'], ['POST', '/api/admin/updates/check']] as const)
      expect((await req(m, u, m === 'PUT' ? { enabled: false } : m === 'POST' ? {} : undefined, maxCookie)).statusCode).toBe(403);

    expect((await req('GET', '/api/admin/updates')).json()).toMatchObject({ enabled: true, current: '0.1.3 (abc1234)', latest: null, checkedAt: null });
    expect(gh.calls).toBe(0); // nightlyFsck: false – no timer, only „Jetzt prüfen“
    gh.release('v0.1.4');
    expect((await req('POST', '/api/admin/updates/check', {})).json()).toMatchObject({ newer: true, latest: { version: '0.1.4' } });
    expect((await req('PUT', '/api/admin/updates', { enabled: false })).json()).toMatchObject({ enabled: false });
    const log = (await req('GET', '/api/activity?category=audit')).json();
    expect(JSON.stringify(log)).toContain('Update-Hinweis ausgeschaltet');
    expect((await req('PUT', '/api/admin/updates', { enabled: true })).json().enabled).toBe(true);
  });
});
