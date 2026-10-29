// Changes for agents (AD-066): who changed what, as far as the caller may read it; long polling; own changes left out.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, DB_FILE, type App } from './app.js';
import { openDb } from './db/db.js';
import { loadConfig } from './config.js';
import { FakeSmtp } from './mail/fake-smtp.js';
import { signature } from './hooks.js';

let root: string;
let wiki: string;
let app: App;
let admin: string;
let eva: string;
let evaId: string;
let mountId: string;
let smtp: FakeSmtp;
const pushes: Record<string, string>[] = [];
const pushover = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    pushes.push(Object.fromEntries(new URLSearchParams(body)));
    res.setHeader('content-type', 'application/json');
    res.end('{"status":1}');
  });
});
const inject = (method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, body?: unknown) =>
  app.server.inject({ method, url, ...(body === undefined ? { headers: { cookie } } : { payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } }) });
const session = (res: { cookies: { name: string; value: string }[] }) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
const token = async (cookie: string, scopes: string[]) => ((await inject('POST', '/api/tokens', cookie, { name: 'Agent', scopes })).json() as { token: string }).token;
type Page = { cursor: string; reset: boolean; changes: { sourceId: string; path: string; kind: string; by: string | null; byId: string | null; via: string; from?: string }[] };
const changes = async (t: string, q: string) => (await app.server.inject({ method: 'GET', url: `/api/v1/changes?${q}`, headers: bearer(t) })).json() as Page;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-agent-events-'));
  wiki = join(root, 'projekte', 'wiki');
  mkdirSync(join(wiki, 'vorfaelle'), { recursive: true });
  mkdirSync(join(wiki, 'geheim'), { recursive: true });
  writeFileSync(join(wiki, 'vorfaelle', 'platte.md'), '# Platte voll\n\n- [ ] Alte Logs löschen\n');
  writeFileSync(join(wiki, 'geheim', 'lohn.md'), '# Lohn\n');
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  smtp = new FakeSmtp();
  await smtp.start();
  if (!pushover.listening) await new Promise<void>((r) => pushover.listen(0, '127.0.0.1', r));
  pushes.length = 0;
  app = await buildApp(config, { logger: false, nightlyFsck: false, watchBundleMs: 60_000, eventHookOptions: { bundleMs: 60_000, retryMs: [] }, pushoverUrl: `http://127.0.0.1:${(pushover.address() as { port: number }).port}/1/messages.json` });
  await app.manager.start();
  admin = session(await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Anna Admin' } }));
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run();
  mountId = ((await inject('POST', '/api/mounts', admin, { type: 'local', source: wiki, name: 'Wiki' })).json() as { id: string }).id;
  evaId = ((await inject('POST', '/api/admin/users', admin, { email: 'eva@example.test', username: 'eva', displayName: 'Eva Agentin', password: 'Eva-Passwort-0001-lang' })).json() as { id: string }).id;
  app.db.prepare('UPDATE users SET must_change_password = 0').run();
  expect((await inject('POST', `/api/acl/${mountId}`, admin, { target: 'folder', path: 'geheim', subject: 'user', subjectId: evaId, level: 'none' })).statusCode).toBe(200);
  eva = session(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Eva-Passwort-0001-lang' } }));
});

let closed = false;
/** Messages waiting for a person (Beobachten, AD-068: in the database). */
const waiting = (userId: string) => (app.db.prepare('SELECT COUNT(*) AS n FROM follow_queue WHERE user_id = ?').get(userId) as { n: number }).n;
afterEach(async () => {
  if (!closed) await app.close();
  closed = false;
  await smtp.stop();
  rmSync(root, { recursive: true, force: true });
});

it('an agent hears who changed what it may read – not its own writes, not hidden folders', async () => {
  const agent = await token(eva, ['read', 'write', 'mcp']);
  const start = await changes(agent, '');
  expect(start).toMatchObject({ reset: false, changes: [] });
  // The agent writes (left out), the admin ticks the box in the app, something changes in a folder Eva may not read.
  const note = (await app.server.inject({ method: 'GET', url: `/api/v1/notes/${mountId}/vorfaelle/platte.md`, headers: bearer(agent) })).json() as { hash: string; markdown: string };
  const own = await app.server.inject({ method: 'PUT', url: `/api/v1/notes/${mountId}/vorfaelle/platte.md`, payload: { markdown: note.markdown + '\nAgent: 95 % belegt.\n', baseHash: note.hash }, headers: bearer(agent, { 'content-type': 'application/json' }) });
  expect(own.statusCode).toBe(200);
  const now = (await inject('GET', `/api/notes/${mountId}/vorfaelle/platte.md`, admin)).json() as { hash: string; raw: string };
  expect((await inject('PUT', `/api/notes/${mountId}/vorfaelle/platte.md`, admin, { raw: now.raw.replace('- [ ]', '- [x]'), baseHash: now.hash })).statusCode).toBe(200);
  const lohn = (await inject('GET', `/api/notes/${mountId}/geheim/lohn.md`, admin)).json() as { hash: string; raw: string };
  await inject('PUT', `/api/notes/${mountId}/geheim/lohn.md`, admin, { raw: '# Lohn\n\n12\n', baseHash: lohn.hash });
  const page = await changes(agent, `after=${start.cursor}`);
  expect(page.changes).toEqual([{ sourceId: mountId, path: 'vorfaelle/platte.md', kind: 'changed', at: expect.any(String), by: 'Anna Admin', byId: expect.any(String), via: 'app' }]);
  // With own: the agent's write as well, marked as its way in.
  const all = await changes(agent, `after=${start.cursor}&own=true`);
  expect(all.changes.map((c) => [c.by, c.via])).toEqual([
    ['Eva Agentin', 'api'],
    ['Anna Admin', 'app'],
  ]);
  // Only below a path, only in a source.
  expect((await changes(agent, `after=${start.cursor}&path=andere`)).changes).toEqual([]);
  expect((await app.server.inject({ method: 'GET', url: `/api/v1/changes?source=gibtsnicht`, headers: bearer(agent) })).statusCode).toBe(404);
});

it('waits for the next change (long polling) – REST and MCP list_changes', async () => {
  const agent = await token(eva, ['read', 'mcp']);
  const start = await changes(agent, '');
  const waiting = changes(agent, `after=${start.cursor}&wait=5`);
  setTimeout(() => writeFileSync(join(wiki, 'vorfaelle', 'neu.md'), '# Neu von außen\n'), 50);
  const page = await waiting;
  expect(page.changes).toMatchObject([{ path: 'vorfaelle/neu.md', kind: 'created', by: null, via: 'extern' }]);
  const rpc = async (args: object) =>
    (
      (await app.server.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_changes', arguments: args } }, headers: bearer(agent, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }) })).json() as {
        result: { structuredContent: Page; isError?: boolean };
      }
    ).result;
  const first = await rpc({});
  expect(first.structuredContent.changes).toEqual([]);
  const later = rpc({ after: first.structuredContent.cursor, wait_seconds: 5, path: 'vorfaelle' });
  setTimeout(() => writeFileSync(join(wiki, 'vorfaelle', 'platte.md'), '# Platte voll\n\n- [x] Alte Logs löschen\n'), 50);
  expect((await later).structuredContent.changes).toMatchObject([{ path: 'vorfaelle/platte.md', kind: 'changed' }]);
});

type Watches = { watches: { mountId: string; path: string; unread: number }[]; unread: { path: string; kind: string; by: string | null }[]; channels: { mail: boolean; pushover: { available: boolean; userKeySet: boolean } } };
const watches = async (cookie: string) => (await inject('GET', '/api/watches', cookie)).json() as Watches;
const edit = async (cookie: string, path: string, raw: (old: string) => string) => {
  const n = (await inject('GET', `/api/notes/${mountId}/${path}`, cookie)).json() as { hash: string; raw: string };
  expect((await inject('PUT', `/api/notes/${mountId}/${path}`, cookie, { raw: raw(n.raw), baseHash: n.hash })).statusCode).toBe(200);
};

it('Beobachten: a dot for what others change in a followed folder – not own changes, not hidden ones; read when opened', { timeout: 20_000 }, async () => {
  expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle', isDir: true, badge: true })).statusCode).toBe(200);
  // A folder Eva may not read cannot be followed (nothing revealed).
  expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'geheim', isDir: true, badge: true })).statusCode).toBe(404);
  await edit(admin, 'vorfaelle/platte.md', (r) => r.replace('- [ ]', '- [x]'));
  await edit(eva, 'vorfaelle/platte.md', (r) => r + '\nEva war hier.\n');
  let w = await watches(eva);
  expect(w.unread).toEqual([{ mountId, path: 'vorfaelle/platte.md', kind: 'changed', by: 'Anna Admin', at: expect.any(String) }]);
  expect(w.watches).toMatchObject([{ path: 'vorfaelle', unread: 1 }]);
  // Moved by someone else: the dot moves along; read when opened.
  // Right after the app wrote it: the watcher folds both events into nothing – the server looks again anyway.
  renameSync(join(wiki, 'vorfaelle', 'platte.md'), join(wiki, 'vorfaelle', 'platte-alt.md'));
  await expect.poll(async () => (await watches(eva)).unread.map((u) => u.path), { timeout: 8000 }).toEqual(['vorfaelle/platte-alt.md']);
  expect(((await inject('GET', `/api/tree/${mountId}`, admin)).json() as { path: string }[]).map((e) => e.path)).not.toContain('vorfaelle/platte.md');
  await inject('POST', '/api/watches/read', eva, { mountId, path: 'vorfaelle/platte-alt.md' });
  w = await watches(eva);
  expect(w.unread).toEqual([]);
  // Nothing chosen = no longer followed.
  await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle', isDir: true });
  await edit(admin, 'vorfaelle/platte-alt.md', (r) => r + 'x\n');
  expect((await watches(eva)).watches).toEqual([]);
  expect((await watches(eva)).unread).toEqual([]);
});

it('Beobachten: changes come together into one e-mail; Pushover with the person’s own key', async () => {
  expect((await inject('PUT', '/api/admin/mail', admin, { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'wiki@example.test', publicUrl: 'https://wiki.example.test' })).statusCode).toBe(200);
  // Pushover: offered only with the admin's application token and the person's own user key.
  expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle', isDir: true, pushover: true })).statusCode).toBe(400);
  expect((await inject('PUT', '/api/admin/notify', admin, { pushover: { token: 'a'.repeat(30) } })).statusCode).toBe(200);
  expect((await inject('PUT', '/api/account/pushover', eva, { userKey: 'kurz' })).statusCode).toBe(400);
  expect((await inject('PUT', '/api/account/pushover', eva, { userKey: 'e'.repeat(30) })).json()).toEqual({ available: true, userKeySet: true });
  expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle', isDir: true, mail: true, pushover: true })).statusCode).toBe(200);
  await edit(admin, 'vorfaelle/platte.md', (r) => r.replace('- [ ]', '- [x]'));
  writeFileSync(join(wiki, 'vorfaelle', 'neu.md'), '# Neu von außen\n');
  await expect.poll(() => waiting(evaId), { timeout: 5000 }).toBe(2);
  await app.follows.flush();
  const mails = smtp.mails.filter((m) => m.to.includes('eva@example.test'));
  expect(mails).toHaveLength(1);
  expect(mails[0]!.subject).toBe('Kaveyl Wiki: 2 Änderungen in Beobachtetem');
  expect(mails[0]!.text).toContain('Wiki: vorfaelle/platte.md – geändert (Anna Admin)');
  expect(mails[0]!.text).toContain('Wiki: vorfaelle/neu.md – neu angelegt (von außen (Git, anderes Programm))');
  expect(mails[0]!.text).toContain('https://wiki.example.test/n/');
  expect(pushes).toHaveLength(1);
  expect(pushes[0]).toMatchObject({ user: 'e'.repeat(30), title: 'Kaveyl Wiki: 2 Änderungen in Beobachtetem' });
  // No dots: only the channels chosen.
  expect((await watches(eva)).unread).toEqual([]);
});

it('Beobachten: a restart (update) keeps the waiting message – it goes out after the start (AD-068)', async () => {
  expect((await inject('PUT', '/api/admin/mail', admin, { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'wiki@example.test', publicUrl: 'https://wiki.example.test' })).statusCode).toBe(200);
  expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle', isDir: true, mail: true })).statusCode).toBe(200);
  await edit(admin, 'vorfaelle/platte.md', (r) => r.replace('- [ ]', '- [x]'));
  await expect.poll(() => waiting(evaId), { timeout: 5000 }).toBe(1);
  const dbFile = join(root, 'config', DB_FILE);
  await app.close();
  closed = true;
  expect(smtp.mails.filter((m) => m.to.includes('eva@example.test'))).toEqual([]);
  const db = openDb(dbFile);
  expect((db.prepare('SELECT COUNT(*) AS n FROM follow_queue').get() as { n: number }).n).toBe(1);
  db.close();
});

it('Beobachten: each person chooses how often, the admin the daily limit (AD-068)', async () => {
  expect((await inject('GET', '/api/watches', eva)).json()).toMatchObject({ rhythm: 'bundled', dailyAt: '07:00', perDay: 100 });
  expect((await inject('PUT', '/api/account/watch-rhythm', eva, { dailyAt: '7 Uhr' })).statusCode).toBe(400);
  expect((await inject('PUT', '/api/account/watch-rhythm', eva, { dailyAt: '18:30' })).json()).toMatchObject({ rhythm: 'bundled', dailyAt: '18:30' });
  expect((await inject('PUT', '/api/account/watch-rhythm', eva, { rhythm: 'sometimes' })).statusCode).toBe(400);
  expect((await inject('PUT', '/api/account/watch-rhythm', eva, { rhythm: 'daily' })).json()).toEqual({ rhythm: 'daily', dailyAt: '18:30', perDay: 100 });
  expect((await inject('PUT', '/api/admin/notify', eva, { followPerDay: 50 })).statusCode).toBe(403);
  expect((await inject('PUT', '/api/admin/notify', admin, { followPerDay: 0 })).statusCode).toBe(400);
  expect((await inject('PUT', '/api/admin/notify', admin, { followPerDay: 50 })).json()).toMatchObject({ followPerDay: 50 });
  expect((await inject('GET', '/api/watches', eva)).json()).toMatchObject({ rhythm: 'daily', perDay: 50 });
});

it('Ereignis-Webhooks: signed batches with what the person may read, not their own changes; ping; switched off after failures', async () => {
  const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let answer = 200;
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.statusCode = answer;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/kaveyl`;
  try {
    // Only admins; a sensible address.
    expect((await inject('POST', '/api/admin/event-hooks', eva, { name: 'x', url, userId: evaId })).statusCode).toBe(403);
    expect((await inject('POST', '/api/admin/event-hooks', admin, { name: 'x', url: 'ftp://x', userId: evaId })).statusCode).toBe(400);
    const created = (await inject('POST', '/api/admin/event-hooks', admin, { name: 'Server-Agent', url, userId: evaId })).json() as { hook: { id: string }; secret: string };
    expect(created.secret.length).toBeGreaterThan(20);
    expect(JSON.stringify((await inject('GET', '/api/admin/event-hooks', admin)).json())).not.toContain(created.secret);
    // Ping
    expect((await inject('POST', `/api/admin/event-hooks/${created.hook.id}/test`, admin, {})).json()).toEqual({ status: 'HTTP 200' });
    expect(JSON.parse(got[0]!.body)).toMatchObject({ event: 'ping', name: 'Server-Agent' });
    // Changes: the admin's tick reaches the agent; Eva's own write and the hidden folder do not.
    await edit(admin, 'vorfaelle/platte.md', (r) => r.replace('- [ ]', '- [x]'));
    await edit(eva, 'vorfaelle/platte.md', (r) => r + '\nAgent: erledigt.\n');
    await edit(admin, 'geheim/lohn.md', (r) => r + '13\n');
    await app.eventHooks.flush();
    expect(got).toHaveLength(2);
    const batch = got[1]!;
    expect(batch.headers['x-kaveyl-event']).toBe('changes');
    expect(batch.headers['x-kaveyl-signature']).toBe(`sha256=${signature(created.secret, batch.body)}`);
    expect(JSON.parse(batch.body).changes).toEqual([{ sourceId: mountId, source: 'Wiki', path: 'vorfaelle/platte.md', kind: 'changed', at: expect.any(String), by: 'Anna Admin', byId: expect.any(String), via: 'app' }]);
    // A receiver that keeps failing: after 5 failed deliveries the webhook is off.
    answer = 500;
    for (let i = 0; i < 5; i++) {
      await edit(admin, 'vorfaelle/platte.md', (r) => r + `${i}\n`);
      await app.eventHooks.flush();
    }
    expect((await inject('GET', '/api/admin/event-hooks', admin)).json()).toMatchObject([{ active: false, failures: 5, lastStatus: 'HTTP 500' }]);
    const before = got.length;
    await edit(admin, 'vorfaelle/platte.md', (r) => r + 'weiter\n');
    await app.eventHooks.flush();
    expect(got.length).toBe(before);
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

it('Beobachten und Webhook-Filter ziehen beim Verschieben mit; Aushängen räumt auf (code-001)', { timeout: 20_000 }, async () => {
  const got: string[] = [];
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(body);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/kaveyl`;
  const followed = async () => (await watches(eva)).watches.map((w) => w.path).sort();
  const move = async (from: string, to: string) => expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from, to })).statusCode).toBe(200);
  const hooks = async () => (await inject('GET', '/api/admin/event-hooks', admin)).json() as { path: string; mountId: string | null; active: boolean }[];
  try {
    expect((await inject('PUT', '/api/admin/mail', admin, { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'wiki@example.test', publicUrl: 'https://wiki.example.test' })).statusCode).toBe(200);
    expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle/platte.md', isDir: false, badge: true })).statusCode).toBe(200);
    expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle', isDir: true, mail: true })).statusCode).toBe(200);
    expect((await inject('POST', '/api/admin/event-hooks', admin, { name: 'Vorfall-Agent', url, userId: evaId, mountId, path: 'vorfaelle' })).statusCode).toBe(200);
    // The note itself, then its folder (for the note: the folder above it).
    await move('vorfaelle/platte.md', 'vorfaelle/platte-2026.md');
    expect(await followed()).toEqual(['vorfaelle', 'vorfaelle/platte-2026.md']);
    await move('vorfaelle', 'incidents');
    expect(await followed()).toEqual(['incidents', 'incidents/platte-2026.md']);
    expect(await hooks()).toMatchObject([{ mountId, path: 'incidents' }]);
    // The next change at the new place arrives everywhere: dot, e-mail queue, webhook.
    await app.follows.flush();
    await app.eventHooks.flush();
    got.length = 0;
    await edit(admin, 'incidents/platte-2026.md', (r) => r.replace('- [ ]', '- [x]'));
    expect((await watches(eva)).unread.map((u) => u.path)).toEqual(['incidents/platte-2026.md']);
    expect(waiting(evaId)).toBe(1);
    await app.eventHooks.flush();
    expect(got.map((b) => (JSON.parse(b) as { changes: { path: string }[] }).changes.map((c) => c.path))).toEqual([['incidents/platte-2026.md']]);
    // Renamed outside (a note): the watch follows, too.
    renameSync(join(wiki, 'incidents', 'platte-2026.md'), join(wiki, 'incidents', 'platte-alt.md'));
    await expect.poll(followed, { timeout: 8000 }).toEqual(['incidents', 'incidents/platte-alt.md']);
    // Removing the source: watches, dots and waiting messages go; the webhook for it is switched off and reported.
    expect((await app.server.inject({ method: 'DELETE', url: `/api/mounts/${mountId}`, payload: '{}', headers: { 'content-type': 'application/json', cookie: admin } })).statusCode).toBe(200);
    for (const table of ['watches', 'unread']) expect((app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE mount_id = ?`).get(mountId) as { n: number }).n).toBe(0);
    expect(waiting(evaId)).toBe(0);
    expect(await hooks()).toMatchObject([{ mountId, active: false }]);
    expect(JSON.stringify(app.db.prepare("SELECT message FROM activity WHERE action = 'event-hook-off'").all())).toContain('Ereignis-Webhook „Vorfall-Agent“ abgeschaltet: Quelle ausgehängt');
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

it('Beobachten und Webhook-Filter ziehen beim Verschieben in eine andere Quelle mit (code-001)', async () => {
  const ablage = join(root, 'projekte', 'ablage');
  mkdirSync(ablage, { recursive: true });
  const otherId = ((await inject('POST', '/api/mounts', admin, { type: 'local', source: ablage, name: 'Ablage' })).json() as { id: string }).id;
  expect((await inject('PUT', '/api/watches', eva, { mountId, path: 'vorfaelle', isDir: true, badge: true })).statusCode).toBe(200);
  expect((await inject('POST', '/api/admin/event-hooks', admin, { name: 'Vorfall-Agent', url: 'http://127.0.0.1:9/x', userId: evaId, mountId, path: 'vorfaelle/platte.md' })).statusCode).toBe(200);
  expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'vorfaelle', to: 'alt/vorfaelle', toMountId: otherId })).statusCode).toBe(200);
  expect((await watches(eva)).watches).toMatchObject([{ mountId: otherId, path: 'alt/vorfaelle' }]);
  expect((await inject('GET', '/api/admin/event-hooks', admin)).json()).toMatchObject([{ mountId: otherId, path: 'alt/vorfaelle/platte.md', active: true }]);
});

it('the path filter of /changes looks at the old path of a move only when it may be read (sec-001)', async () => {
  const agent = await token(eva, ['read']);
  const start = await changes(agent, '');
  expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'geheim/lohn.md', to: 'vorfaelle/lohn.md' })).statusCode).toBe(200);
  // Asked for the hidden folder: nothing, not even that something left it.
  expect((await changes(agent, `after=${start.cursor}&path=geheim`)).changes).toEqual([]);
  expect((await changes(agent, `after=${start.cursor}&path=vorfaelle`)).changes).toEqual([expect.objectContaining({ path: 'vorfaelle/lohn.md', kind: 'moved' })]);
  expect((await changes(agent, `after=${start.cursor}&path=vorfaelle`)).changes[0]).not.toHaveProperty('from');
});

it('the path filter of an event webhook looks at the old path of a move only when the person may read it (sec-001)', async () => {
  const got: string[] = [];
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(body);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/kaveyl`;
  try {
    // A filter on the folder Eva may not read: a note leaving it must not reveal where it came from.
    expect((await inject('POST', '/api/admin/event-hooks', admin, { name: 'Geheim-Agent', url, userId: evaId, mountId, path: 'geheim' })).statusCode).toBe(200);
    expect((await inject('POST', '/api/admin/event-hooks', admin, { name: 'Vorfall-Agent', url, userId: evaId, mountId, path: 'vorfaelle' })).statusCode).toBe(200);
    expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'geheim/lohn.md', to: 'vorfaelle/lohn.md' })).statusCode).toBe(200);
    await app.eventHooks.flush();
    const batches = got.map((b) => JSON.parse(b) as { name: string; changes: { path: string; from?: string }[] });
    expect(batches.map((b) => b.name)).toEqual(['Vorfall-Agent']);
    expect(batches[0]!.changes).toEqual([expect.objectContaining({ path: 'vorfaelle/lohn.md', kind: 'moved' })]);
    expect(batches[0]!.changes[0]).not.toHaveProperty('from');
  } finally {
    await new Promise<void>((r) => receiver.close(() => r()));
  }
});

it('„Pushover testen“ is limited per account – also for guests – so nobody uses up the instance’s Pushover quota (sec-002)', async () => {
  expect((await inject('PUT', '/api/admin/notify', admin, { pushover: { token: 'a'.repeat(30) } })).statusCode).toBe(200);
  expect((await inject('PUT', '/api/account/pushover', eva, { userKey: 'e'.repeat(30) })).statusCode).toBe(200);
  const test = (cookie: string) => app.server.inject({ method: 'POST', url: '/api/account/pushover/test', payload: '{}', headers: { 'content-type': 'application/json', cookie } });
  for (let i = 0; i < 3; i++) expect((await test(eva)).statusCode).toBe(200);
  const blocked = await test(eva);
  expect(blocked.statusCode).toBe(429);
  expect(blocked.json()).toEqual({ error: 'Zu viele Testnachrichten – höchstens 3 pro Stunde, bitte später noch einmal' });
  expect(pushes).toHaveLength(3);
  // The limit is per account: the admin can still test.
  expect((await inject('PUT', '/api/account/pushover', admin, { userKey: 'f'.repeat(30) })).statusCode).toBe(200);
  expect((await test(admin)).statusCode).toBe(200);
  // A guest the same: may use Pushover for what was shared (Beobachten), so may test it – within the same limit.
  expect((await inject('POST', '/api/admin/users', admin, { email: 'gina@example.test', username: 'gina', displayName: 'Gina Gast', password: 'Gina-Passwort-0001-lang', isGuest: true })).statusCode).toBe(200);
  app.db.prepare('UPDATE users SET must_change_password = 0').run();
  const gina = session(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'gina@example.test', password: 'Gina-Passwort-0001-lang' } }));
  expect((await inject('PUT', '/api/account/pushover', gina, { userKey: 'g'.repeat(30) })).statusCode).toBe(200);
  for (let i = 0; i < 3; i++) expect((await test(gina)).statusCode).toBe(200);
  expect((await test(gina)).statusCode).toBe(429);
  expect(pushes).toHaveLength(7);
});

it('deleting an account removes its Pushover user key and the secrets of webhooks in its name (Hinweis Codeprüfung)', async () => {
  expect((await inject('PUT', '/api/admin/notify', admin, { pushover: { token: 'a'.repeat(30) } })).statusCode).toBe(200);
  expect((await inject('PUT', '/api/account/pushover', eva, { userKey: 'e'.repeat(30) })).statusCode).toBe(200);
  const hook = ((await inject('POST', '/api/admin/event-hooks', admin, { name: 'Evas Agent', url: 'http://127.0.0.1:9/x', userId: evaId })).json() as { hook: { id: string } }).hook.id;
  const secretIds = () => (app.db.prepare('SELECT id FROM secrets ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  expect(secretIds()).toEqual(expect.arrayContaining([`pushover-user:${evaId}`, `event-hook:${hook}`]));
  const res = await app.server.inject({ method: 'DELETE', url: `/api/admin/users/${evaId}`, payload: '{}', headers: { 'content-type': 'application/json', cookie: admin } });
  expect(res.statusCode).toBe(200);
  expect(secretIds().filter((id) => id.includes(evaId) || id.includes(hook))).toEqual([]);
  // The instance's own Pushover token stays.
  expect(secretIds()).toContain('pushover-token');
  expect((await inject('GET', '/api/admin/event-hooks', admin)).json()).toEqual([]);
});
