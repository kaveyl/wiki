// Moving, copying and deleting notes run through one operation for the app and for REST/MCP (code-002): same checks,
// same rules, same audit entries – only the way in (and the shape of the answer) differs.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';

let root: string;
let wiki: string;
let app: App;
let admin: string;
let mountId: string;
const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown) =>
  app.server.inject({ method, url, ...(body === undefined ? { headers } : { payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }) });
const session = (res: { cookies: { name: string; value: string }[] }) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-note-ops-'));
  wiki = join(root, 'projekte', 'wiki');
  mkdirSync(join(wiki, 'ziel'), { recursive: true });
  writeFileSync(join(wiki, 'a.md'), '# A\n');
  writeFileSync(join(wiki, 'c.md'), '# C\n');
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  admin = session(await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123' } }));
  mountId = ((await inject('POST', '/api/mounts', { cookie: admin }, { type: 'local', source: wiki, name: 'Wiki' })).json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('the app and REST leave the same audit entries for move, copy and delete (code-002)', async () => {
  const app1 = { cookie: admin };
  const moved = await inject('POST', `/api/notes/${mountId}/move`, app1, { from: 'a.md', to: 'b.md' });
  expect(moved.statusCode).toBe(200);
  expect(moved.json()).toEqual({ mountId, path: 'b.md', warnings: [] });
  const copied = await inject('POST', `/api/notes/${mountId}/copy`, app1, { from: 'b.md', toParent: 'ziel' });
  expect(copied.statusCode).toBe(200);
  expect(copied.json()).toMatchObject({ mountId, path: 'ziel/b.md' });
  expect((await inject('DELETE', `/api/notes/${mountId}/b.md`, app1, {})).json()).toEqual({ ok: true });

  const { token } = (await inject('POST', '/api/tokens', { cookie: admin }, { name: 'skript', scopes: ['write'] })).json() as { token: string };
  const api = { authorization: `Bearer ${token}` };
  const movedApi = await inject('POST', `/api/v1/move/${mountId}`, api, { from: 'c.md', to: 'd.md' });
  expect(movedApi.json()).toEqual({ sourceId: mountId, path: 'd.md', warnings: [] });
  expect((await inject('POST', `/api/v1/copy/${mountId}`, api, { from: 'd.md', toParent: 'ziel' })).json()).toMatchObject({ sourceId: mountId, path: 'ziel/d.md' });
  expect((await inject('DELETE', `/api/v1/notes/${mountId}/d.md`, api, {})).json()).toEqual({ ok: true });
  expect(existsSync(join(wiki, 'ziel', 'b.md')) && existsSync(join(wiki, 'ziel', 'd.md'))).toBe(true);

  const log = (await inject('GET', '/api/activity?category=audit&limit=50', { cookie: admin })).json() as { action: string; message: string; mountId: string | null }[];
  const notes = log.filter((e) => /moved|copied|deleted/.test(e.action)).reverse();
  expect(notes.map((e) => [e.action, e.message])).toEqual([
    ['moved', 'Verschoben: a.md → b.md'],
    ['copied', 'Kopiert: Wiki/b.md → Wiki/ziel/b.md'],
    ['note-deleted', 'Gelöscht: b.md'],
    ['api-moved', 'API: Verschoben: c.md → d.md'],
    ['api-copied', 'API: Kopiert: Wiki/d.md → Wiki/ziel/d.md'],
    ['api-note-deleted', 'API: Gelöscht: d.md'],
  ]);
  for (const e of notes) expect(e.mountId).toBe(mountId);
});

it('moving into another source in the app keeps its answer and its audit entry (code-002)', async () => {
  mkdirSync(join(root, 'projekte', 'ander'), { recursive: true });
  const other = ((await inject('POST', '/api/mounts', { cookie: admin }, { type: 'local', source: join(root, 'projekte', 'ander'), name: 'Ander' })).json() as { id: string }).id;
  const moved = await inject('POST', `/api/notes/${mountId}/move`, { cookie: admin }, { from: 'a.md', to: 'a.md', toMountId: other });
  expect(moved.statusCode).toBe(200);
  expect(moved.json()).toMatchObject({ mountId: other, path: 'a.md' });
  expect(moved.json()).not.toHaveProperty('sourceId');
  const log = (await inject('GET', '/api/activity?category=audit&limit=50', { cookie: admin })).json() as { action: string; message: string }[];
  expect(log.filter((e) => e.action.includes('moved')).map((e) => [e.action, e.message])).toEqual([['moved-across', 'Verschoben: Wiki/a.md → Ander/a.md']]);
});
