import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { SCHEMA_VERSION } from '../db/db.js';
import { zipBuffer } from './archive.js';

// Database back from a backup in the first-run setup (AD-075).
let root: string;
const apps: App[] = [];
const ADMIN = { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' };

const configFor = (name: string) => ({
  ...loadConfig({}),
  dataPath: join(root, name, 'data'),
  configPath: join(root, name, 'config'),
  localRoots: [join(root, 'projekte')],
  syncIntervalSec: 0,
  commitDelaySec: 0,
  webRoot: join(root, 'no-web'),
  backupRoot: join(root, 'backup'),
});

async function start(name: string, opts: Parameters<typeof buildApp>[1] = {}): Promise<App> {
  const app = await buildApp(configFor(name), { logger: false, nightlyFsck: false, ...opts });
  await app.manager.start();
  apps.push(app);
  return app;
}

async function signIn(app: App): Promise<string> {
  const res = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: ADMIN.email, password: ADMIN.password } });
  expect(res.statusCode, res.body).toBe(200);
  return `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
}

const upload = (app: App, body: Buffer, headers: Record<string, string> = {}) =>
  app.server.inject({ method: 'POST', url: '/api/setup/restore', payload: body, headers: { 'content-type': 'application/x-sqlite3', 'x-kaveyl-wiki-upload': '1', ...headers } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-dbrestore-'));
  mkdirSync(join(root, 'backup'));
  mkdirSync(join(root, 'projekte', 'wiki'), { recursive: true });
  writeFileSync(join(root, 'projekte', 'wiki', 'a.md'), '# A\n');
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

/** The old server: an admin, a source, an encrypted target and a backup of the database on it. */
async function oldServer(archivePassword?: string): Promise<{ zip: Buffer; app: App }> {
  const app = await start('alt');
  const res = await app.server.inject({ method: 'POST', url: '/api/setup', payload: ADMIN });
  const cookie = `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
  const post = async <T,>(url: string, body: unknown) => {
    const r = await app.server.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as T;
  };
  await post('/api/mounts', { type: 'local', source: join(root, 'projekte', 'wiki'), name: 'Wiki' });
  const target = await post<{ id: string }>('/api/backup/targets', { kind: 'local', location: 'nas', ...(archivePassword && { archivePassword }) });
  const plan = await post<{ id: string }>('/api/backup/plans', { targetId: target.id, sources: ['*'], includeDb: true, keep: { daily: 3 } });
  await app.backups.enqueue(plan.id, { trigger: 'manual' });
  const folder = join(root, 'backup', 'nas', 'kaveyl-wiki-datenbank');
  return { zip: readFileSync(join(folder, readdirSync(folder)[0]!)), app };
}

describe('database back in the first-run setup', () => {
  it('takes an encrypted database backup with its key – after the restart everything is there (AD-075)', async () => {
    const { zip, app: old } = await oldServer('Backup-Passwort-1');
    await old.close();
    let restarted = 0;
    const fresh = await start('neu', { requireSetupCode: true, restart: () => restarted++ });
    const code = readFileSync(join(root, 'neu', 'config', 'setup-code'), 'utf8').trim();
    expect((await fresh.server.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({ setupRequired: true, setupCode: true });

    expect((await upload(fresh, zip)).statusCode).toBe(403);
    expect((await upload(fresh, zip, { 'x-setup-code': code })).json()).toEqual({ error: expect.stringMatching(/verschlüsselt – bitte das Backup-Passwort/) });
    expect((await upload(fresh, zip, { 'x-setup-code': code, 'x-backup-password': 'falsch' })).json()).toEqual({ error: expect.stringMatching(/passt nicht/) });
    const ok = await upload(fresh, zip, { 'x-setup-code': encodeURIComponent(code), 'x-backup-password': encodeURIComponent('Backup-Passwort-1') });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ version: SCHEMA_VERSION, users: 1, admins: 1, key: true, restart: true });
    // Meanwhile nobody sets the instance up the other way.
    expect((await fresh.server.inject({ method: 'POST', url: '/api/setup', payload: { ...ADMIN, code } })).statusCode).toBe(409);
    expect((await fresh.server.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({ setupRequired: true, restoring: true });
    await new Promise((r) => setTimeout(r, 700));
    expect(restarted).toBe(1);

    // The start after: the old database with its key, the one of the fresh start kept aside.
    await fresh.close();
    const back = await start('neu', { requireSetupCode: true });
    const cookie = await signIn(back);
    expect((await back.server.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({ setupRequired: false });
    expect(existsSync(join(root, 'neu', 'config', 'setup-code'))).toBe(false);
    expect(existsSync(join(root, 'neu', 'config', 'restore'))).toBe(false);
    expect(readdirSync(join(root, 'neu', 'config', 'backups')).some((n) => /^manuell-vor-wiederherstellung-.*\.db$/.test(n))).toBe(true);
    // The stored backup password is readable again (the key came along): a run onto the old target works.
    const [plan] = (await back.server.inject({ method: 'GET', url: '/api/backup/plans', headers: { cookie } })).json() as { id: string }[];
    expect(await back.backups.enqueue(plan!.id, { trigger: 'manual' })).toMatchObject({ status: 'ok', archives: 2 });
    const log = (await back.server.inject({ method: 'GET', url: '/api/activity?limit=200', headers: { cookie } })).body;
    expect(log).toContain('Datenbank aus einer Sicherung zurückgespielt');
  });

  it('also takes a plain kaveyl-wiki.db, and says clearly what does not fit', async () => {
    const { app: old } = await oldServer();
    const plain = join(root, 'plain.db');
    old.db.prepare('VACUUM INTO ?').run(plain);
    await old.close();
    const fresh = await start('neu');
    // Not a database, a ZIP without one, a foreign database, a newer one, one without an administrator.
    expect((await upload(fresh, Buffer.from('hallo'))).json()).toEqual({ error: expect.stringMatching(/Erwartet/) });
    expect((await upload(fresh, await zipBuffer({ 'Wiki/a.md': '# A' }))).json()).toEqual({ error: expect.stringMatching(/kaveyl-wiki.db fehlt/) });
    const foreign = join(root, 'fremd.db');
    const f = new Database(foreign);
    f.exec('CREATE TABLE users (id TEXT, is_admin INTEGER); PRAGMA user_version = 3;');
    f.close();
    expect((await upload(fresh, readFileSync(foreign))).json()).toEqual({ error: 'Das ist keine Datenbank von Kaveyl Wiki' });
    const variant = (name: string, sql: string) => {
      const file = join(root, name);
      writeFileSync(file, readFileSync(plain));
      const d = new Database(file);
      d.exec(sql);
      d.close();
      return readFileSync(file);
    };
    expect((await upload(fresh, variant('neuer.db', `PRAGMA user_version = ${SCHEMA_VERSION + 1}`))).json()).toEqual({ error: expect.stringMatching(/neueren Version/) });
    expect((await upload(fresh, variant('ohne.db', 'UPDATE users SET is_admin = 0'))).json()).toEqual({ error: expect.stringMatching(/kein aktives Administrator-Konto/) });
    expect((await upload(fresh, variant('trigger.db', 'CREATE TRIGGER t AFTER INSERT ON users BEGIN SELECT 1; END'))).json()).toEqual({ error: 'Das ist keine Datenbank von Kaveyl Wiki' });
    // Columns other than those of its version (e.g. a changed default) – not ours either.
    expect((await upload(fresh, variant('spalte.db', 'ALTER TABLE users ADD COLUMN extra INTEGER DEFAULT 1'))).json()).toEqual({ error: 'Das ist keine Datenbank von Kaveyl Wiki' });
    expect(readdirSync(join(root, 'neu', 'config', 'restore'))).toEqual([]);
    // With a backup password only a fully encrypted ZIP counts – a plain database or ZIP may have been planted.
    expect((await upload(fresh, readFileSync(plain), { 'x-backup-password': 'Backup-Passwort-1' })).json()).toEqual({ error: expect.stringMatching(/nicht verschlüsselt/) });
    expect((await upload(fresh, await zipBuffer({ 'kaveyl-wiki.db': 'x' }), { 'x-backup-password': 'Backup-Passwort-1' })).json()).toEqual({
      error: expect.stringMatching(/nicht \(vollständig\) verschlüsselt/),
    });

    // A source pointing outside the allowed folders passes the check (it is data) – but is never read after the start.
    const ok = await upload(fresh, variant('aussen.db', "UPDATE mounts SET source = '/etc' WHERE type = 'local'"));
    expect(ok.json()).toMatchObject({ users: 1, key: false, restart: false });
    await fresh.close();
    const back = await start('neu');
    const cookie = await signIn(back);
    const mounts = (await back.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } })).json() as { name: string; syncStatus: string }[];
    expect(mounts.find((m) => m.name === 'Wiki')).toMatchObject({ syncStatus: 'error' });
    expect((await back.server.inject({ method: 'GET', url: '/api/search?q=passwd', headers: { cookie } })).body).not.toContain('passwd');
    // After the first account the way is closed.
    expect((await upload(back, readFileSync(plain))).statusCode).toBe(409);
  });
});
