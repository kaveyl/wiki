// What the app tells strangers about itself: /health, /api/session and unexpected errors (sec-008, sec-016).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { PathError } from './mounts/model.js';

let root: string;
let app: App;
let cookie: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-disclosure-'));
  app = await buildApp(
    { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'w') },
    { logger: false, nightlyFsck: false },
  );
  app.server.get('/boom', async () => {
    throw new TypeError("Cannot read properties of null (reading 'isAdmin')");
  });
  app.server.get('/boom-path', async () => {
    throw new PathError('Pfad ungültig');
  });
  app.server.get('/boom-422', async () => {
    throw Object.assign(new Error('Absichtliche Meldung'), { statusCode: 422 });
  });
  const setup = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' } });
  cookie = `kw_session=${setup.cookies.find((c) => c.name === 'kw_session')!.value}`;
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string, remoteAddress: string, headers: Record<string, string> = {}) => app.server.inject({ method: 'GET', url, remoteAddress, headers });

describe('/health', () => {
  it('tells a stranger only that it is up', async () => {
    const res = await get('/health', '192.168.1.50');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('a forwarded loopback address does not count as local', async () => {
    // 192.168.x is a trusted proxy by default, so req.ip would be 127.0.0.1 here – the socket peer decides.
    expect((await get('/health', '192.168.1.50', { 'x-forwarded-for': '127.0.0.1' })).json()).toEqual({ status: 'ok' });
  });

  it('names version and git version when signed in or asked from inside (container healthcheck, deploy.sh)', async () => {
    for (const [remoteAddress, headers] of [
      ['192.168.1.50', { cookie }],
      ['127.0.0.1', {}],
      ['::1', {}],
      ['::ffff:127.0.0.1', {}],
    ] as const) {
      const body = (await get('/health', remoteAddress, headers)).json();
      expect(body, remoteAddress).toMatchObject({ status: 'ok', version: expect.any(String), git: expect.stringMatching(/^git version/) });
    }
  });
});

describe('/api/session', () => {
  it('names the version only to the signed in (sec-016)', async () => {
    const stranger = (await get('/api/session', '192.168.1.50')).json();
    expect(stranger).toMatchObject({ user: null, setupRequired: false });
    expect(stranger).not.toHaveProperty('version');
    expect((await get('/api/session', '192.168.1.50', { cookie })).json()).toMatchObject({ user: { username: expect.any(String) }, version: expect.any(String) });
  });
});

describe('error answers', () => {
  it('an unexpected 500 carries a general message, not the internal text', async () => {
    const res = await get('/boom', '192.168.1.50');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Interner Fehler' });
    expect(res.body).not.toMatch(/isAdmin/);
  });

  it('intended messages (4xx) stay as they are', async () => {
    expect((await get('/boom-path', '192.168.1.50')).json()).toEqual({ error: 'Pfad ungültig' });
    const res = await get('/boom-422', '192.168.1.50');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Absichtliche Meldung' });
  });
});
