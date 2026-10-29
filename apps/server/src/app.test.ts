import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { RemoteError } from './import/remote.js';
import { setFallbackLang } from './i18n/index.js';
import { loadConfig } from './config.js';

let root: string;
let app: App;
let cookie: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } });
/** Passwords follow the policy (AD-048); every test user `x` logs in as x@example.test. */
const ADMIN_PW = 'Sehr-geheim-Passwort-123';
const userPw = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}-Passwort-0001`;
const sessionCookie = (res: { cookies: { name: string; value: string }[] }) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;

/** Admin creates `name` with a start password; the user logs in and sets their own (`userPw`). */
async function addUser(name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; cookie: string }> {
  const created = await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ email: `${name}@example.test`, username: name, password: 'Start-Passwort-0001', ...extra }) });
  expect(created.statusCode).toBe(200);
  const login = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: `${name}@example.test`, password: 'Start-Passwort-0001' } });
  const c = sessionCookie(login);
  const changed = await app.server.inject({ method: 'POST', url: '/api/account/password', payload: JSON.stringify({ current: 'Start-Passwort-0001', next: userPw(name) }), headers: { 'content-type': 'application/json', cookie: c } });
  expect(changed.statusCode).toBe(200);
  return { id: (created.json() as { id: string }).id, cookie: c };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-app-'));
  const projects = join(root, 'projekte');
  mkdirSync(join(projects, 'wiki', 'docs'), { recursive: true });
  writeFileSync(join(projects, 'wiki', 'docs', 'home.md'), '# Home\n\nTrilium und Outline.\n');
  const config = {
    ...loadConfig({}),
    dataPath: join(root, 'data'),
    configPath: join(root, 'config'),
    localRoots: [projects],
    syncIntervalSec: 0,
    commitDelaySec: 0,
    webRoot: join(root, 'no-web'),
  };
  app = await buildApp(config, {
    logger: false,
    nightlyFsck: false,
    // The old HedgeDoc server of the import fixture: every picture but the GIF is there.
    importFetcher: async (url) => {
      if (url.endsWith('.gif')) throw new RemoteError('HTTP 404');
      return new Uint8Array([137, 80, 78, 71]);
    },
  });
  await app.manager.start();
  const res = await app.server.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { email: 'admin@example.test', password: ADMIN_PW, displayName: 'Admin' },
  });
  expect(res.statusCode).toBe(200);
  cookie = `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

async function createLocalMount() {
  const res = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'wiki'), name: 'Wiki' }) });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; hasCredential: boolean; credentialId?: string };
}

describe('auth', () => {
  it('allows setup only once and protects the API', async () => {
    expect((await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'x@example.test', password: 'Yyyyyyyyyyyyyyy-1' } })).statusCode).toBe(409);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts' })).statusCode).toBe(401);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } })).statusCode).toBe(200);
  });

  it('logs in with the right password only', async () => {
    const bad = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: 'falsch-falsch' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: ADMIN_PW } });
    expect(ok.statusCode).toBe(200);
    const session = await app.server.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ user: { username: 'admin', isAdmin: true }, setupRequired: false });
  });

  it('changes the password only with the current one and ends other sessions', async () => {
    const other = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: ADMIN_PW } });
    const otherCookie = `kw_session=${other.cookies.find((c) => c.name === 'kw_session')!.value}`;
    const wrong = await app.server.inject({ method: 'POST', url: '/api/account/password', ...json({ current: 'falsch-falsch', next: 'Neues-Passwort-0001' }) });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.server.inject({ method: 'POST', url: '/api/account/password', ...json({ current: ADMIN_PW, next: 'Neues-Passwort-0001' }) });
    expect(ok.statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie: otherCookie } })).statusCode).toBe(401);
    const login = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: 'Neues-Passwort-0001' } });
    expect(login.statusCode).toBe(200);
  });

  it('refuses an overlong new password at once, before checking the current one', async () => {
    const huge = `abc${'1234567890'.repeat(100_000)}d`;
    for (const current of ['falsch-falsch', ADMIN_PW]) {
      const start = performance.now();
      const res = await app.server.inject({ method: 'POST', url: '/api/account/password', ...json({ current, next: huge }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Passwort zu lang – höchstens 256 Zeichen');
      expect(performance.now() - start).toBeLessThan(500);
    }
    const reset = await app.server.inject({ method: 'POST', url: `/api/admin/users/${(await app.server.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json().user.id}/password`, ...json({ password: huge }) });
    expect(reset.statusCode).toBe(400);
  });

  it('rejects state-changing requests that are not JSON (CSRF)', async () => {
    const res = await app.server.inject({ method: 'POST', url: '/api/mounts', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'type=local' });
    expect(res.statusCode).toBe(415);
  });
});

describe('mounts and notes', () => {
  it('creates a local mount inside the allowed roots only', async () => {
    const outside = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: '/etc' }) });
    expect(outside.statusCode).toBe(400);
    const mount = await createLocalMount();
    expect(mount).not.toHaveProperty('credentialId');
    const tree = await app.server.inject({ method: 'GET', url: `/api/tree/${mount.id}`, headers: { cookie } });
    expect((tree.json() as { path: string }[]).map((e) => e.path)).toEqual(['docs', 'docs/home.md']);
  });

  it('„Neuer Ordner …“ for a local source: one plain name inside the roots, admins only', async () => {
    const projects = join(root, 'projekte');
    const make = (parent: string, name: string) => app.server.inject({ method: 'POST', url: '/api/sources/local/folder', ...json({ parent, name }) });
    const ok = await make(projects, ' Annas Wiki ');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ path: join(projects, 'Annas Wiki') });
    expect(existsSync(join(projects, 'Annas Wiki'))).toBe(true);
    expect((await make(projects, 'Annas Wiki')).json()).toMatchObject({ error: expect.stringContaining('gibt es dort schon') });
    for (const bad of ['', '..', '.git', 'a/b', 'a\\b', 'x\u0007y', 'z'.repeat(121)]) expect((await make(projects, bad)).statusCode, bad).toBe(400);
    expect((await make(root, 'draußen')).statusCode).toBe(400);
    expect(existsSync(join(root, 'draußen'))).toBe(false);
    const anna = await addUser('anna');
    const asAnna = await app.server.inject({ method: 'POST', url: '/api/sources/local/folder', payload: JSON.stringify({ parent: projects, name: 'Nicht' }), headers: { 'content-type': 'application/json', cookie: anna.cookie } });
    expect(asAnna.statusCode).toBe(403);
  });

  it('versions for a local folder: own Git, first commit by the person, automatic commits; the folder trash stays (AD-071)', async () => {
    const { id } = await createLocalMount();
    const wiki = join(root, 'projekte', 'wiki');
    // Something deleted before: it lies in the folder trash and stays listed.
    expect((await app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/docs/home.md`, ...json({}) })).statusCode).toBe(200);
    writeFileSync(join(wiki, 'docs', 'neu.md'), '# Neu\n');
    const on = await app.server.inject({ method: 'POST', url: `/api/mounts/${id}/versions`, ...json({}) });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ restored: false, mount: { options: { autoCommit: true } } });
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: wiki, encoding: 'utf8' }).trim();
    expect(sh('log', '--format=%an|%s')).toBe('Admin|docs: Versionen eingeschaltet (Kaveyl Wiki)');
    expect(sh('ls-files')).toBe('docs/neu.md');
    expect(sh('status', '--porcelain')).toBe('');
    // An executable bit from a NAS share or a ZIP is no change.
    execFileSync('chmod', ['+x', join(wiki, 'docs', 'neu.md')]);
    expect(sh('status', '--porcelain')).toBe('');
    const trash = (await app.server.inject({ method: 'GET', url: `/api/trash/${id}`, headers: { cookie } })).json() as { mode: string; items: { files: string[] }[] };
    expect(trash.mode).toBe('git');
    expect(trash.items.some((t) => t.files.includes('docs/home.md'))).toBe(true);
    // Edits are committed from now on; switching on again changes nothing.
    const note = (await app.server.inject({ method: 'GET', url: `/api/notes/${id}/docs/neu.md`, headers: { cookie } })).json() as { raw: string; hash: string };
    await app.server.inject({ method: 'PUT', url: `/api/notes/${id}/docs/neu.md`, ...json({ raw: note.raw + '\nMehr.\n', baseHash: note.hash }) });
    await app.server.inject({ method: 'POST', url: `/api/mounts/${id}/commit-now`, ...json({}) });
    expect(sh('log', '--format=%s').split('\n')).toHaveLength(2);
    expect((await app.server.inject({ method: 'POST', url: `/api/mounts/${id}/versions`, ...json({}) })).statusCode).toBe(200);
    expect(sh('log', '--format=%s').split('\n')).toHaveLength(2);
    // Changed by another program (NAS share, editor): becomes a version as well, by „Kaveyl Wiki“.
    writeFileSync(join(wiki, 'docs', 'neu.md'), '# Neu\n\nVon außen.\n');
    writeFileSync(join(wiki, 'docs', 'bild.png'), Buffer.from([1, 2, 3]));
    for (let i = 0; i < 50 && sh('log', '--format=%s').split('\n').length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sh('log', '-1', '--format=%an|%s')).toBe('Kaveyl Wiki|docs: 2 Dateien außerhalb von Kaveyl Wiki geändert');
    expect(sh('status', '--porcelain')).toBe('');
  });

  it('versions in a local folder: moves keep the history, app and outside changes stay apart, tokens write as their person, encrypted notes stay encrypted (AD-071)', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    const res = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: wiki, name: 'Wiki', versions: true }) });
    const { id } = res.json() as { id: string };
    const anna = await addUser('anna');
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: wiki, encoding: 'utf8' }).trim();
    const commits = () => sh('log', '--format=%s').split('\n').length;
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 80 && !done(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(done()).toBe(true);
    };
    const as = (c: string) => ({ headers: { 'content-type': 'application/json', cookie: c } });
    const get = async (p: string, c = cookie) => (await app.server.inject({ method: 'GET', url: `/api/notes/${id}/${p}`, headers: { cookie: c } })).json() as { hash: string; raw: string };
    const put = async (p: string, raw: string, c = cookie, extra: object = {}) =>
      app.server.inject({ method: 'PUT', url: `/api/notes/${id}/${p}`, payload: JSON.stringify({ raw, baseHash: (await get(p, c)).hash, ...extra }), ...as(c) });
    const commitNow = () => app.server.inject({ method: 'POST', url: `/api/mounts/${id}/commit-now`, ...json({}) });

    // Moved and renamed: the versions follow the note.
    expect((await put('docs/home.md', '# Home\n\nZweite Fassung.\n')).statusCode).toBe(200);
    await commitNow();
    expect((await app.server.inject({ method: 'POST', url: `/api/notes/${id}/move`, ...json({ from: 'docs/home.md', to: 'archiv/Start alt.md' }) })).statusCode).toBe(200);
    await commitNow();
    const history = (await app.server.inject({ method: 'GET', url: `/api/history/${id}/archiv/Start%20alt.md`, headers: { cookie } })).json() as { git: boolean; versions: { path: string }[] };
    expect(history.git).toBe(true);
    expect(history.versions.length).toBeGreaterThanOrEqual(3);
    expect(history.versions.at(-1)!.path).toBe('docs/home.md');
    expect(sh('status', '--porcelain')).toBe('');

    // Anna saves A while another program changes B: two commits, each with its own author.
    writeFileSync(join(wiki, 'b.md'), '# B\n');
    await until(() => sh('status', '--porcelain') === '');
    const before = commits();
    const [saved] = await Promise.all([put('archiv/Start alt.md', '# Home\n\nVon Anna.\n', anna.cookie), Promise.resolve(writeFileSync(join(wiki, 'b.md'), '# B\n\nVon außen.\n'))]);
    expect(saved.statusCode).toBe(200);
    await commitNow();
    await until(() => commits() >= before + 2 && sh('status', '--porcelain') === '');
    const recent = sh('log', `-${commits() - before}`, '--format=%an', '--name-only').split('\n').filter(Boolean);
    expect(recent.join('|')).toMatch(/anna\|archiv\/Start alt\.md/);
    expect(recent.join('|')).toMatch(/Kaveyl Wiki\|b\.md/);
    expect(sh('log', '-1', '--format=%an|%s', '--', 'b.md')).toBe('Kaveyl Wiki|docs: b.md außerhalb von Kaveyl Wiki geändert');
    expect(sh('log', '-1', '--format=%an', '--', 'archiv/Start alt.md')).toBe('anna');

    // A token writes as its person.
    const token = ((await app.server.inject({ method: 'POST', url: '/api/tokens', payload: JSON.stringify({ name: 'Skript', scopes: ['read', 'write'] }), ...as(anna.cookie) })).json() as { token: string }).token;
    const bearer = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const v1 = (await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/b.md`, headers: bearer })).json() as { hash: string };
    expect((await app.server.inject({ method: 'PUT', url: `/api/v1/notes/${id}/b.md`, headers: bearer, payload: JSON.stringify({ markdown: '# B\n\nPer Token.\n', baseHash: v1.hash }) })).statusCode).toBe(200);
    await commitNow();
    await until(() => sh('log', '-1', '--format=%s', '--', 'b.md') !== '' && sh('status', '--porcelain') === '');
    expect(sh('log', '-1', '--format=%an', '--', 'b.md')).toBe('anna');

    // An encrypted folder: only age blocks reach the history, also when another program writes into it.
    const ARMOR = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n';
    mkdirSync(join(wiki, 'tresor'));
    expect((await app.server.inject({ method: 'PUT', url: `/api/encrypted/${id}`, ...json({ folder: 'tresor', encrypted: true }) })).statusCode).toBe(200);
    const created = (await app.server.inject({ method: 'POST', url: `/api/notes/${id}`, ...json({ parent: 'tresor', title: 'Lohn' }) })).json() as { path: string };
    expect((await put(created.path, `---\nencrypted: age\n---\n${ARMOR}`)).statusCode).toBe(200);
    expect((await put(created.path, '# Lohn\n\nGeheimer Klartext.\n')).statusCode).toBe(403);
    await commitNow();
    await until(() => sh('status', '--porcelain') === '');
    const added = sh('log', '-p', '--format=', '--', 'tresor').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added.length).toBeGreaterThan(0);
    for (const line of added) expect(line).toMatch(/^\+(---|encrypted: age|id: .+|-----(BEGIN|END) AGE ENCRYPTED FILE-----|YWdl)?$/);
    // Plain text put into the encrypted folder by another program stays out of the history (sec-002); an age block is taken.
    const head = sh('rev-parse', 'HEAD');
    writeFileSync(join(wiki, 'tresor', 'Klartext.md'), '# Klartext\n\nGeheim von außen.\n');
    writeFileSync(join(wiki, 'tresor', 'bild.png'), 'unverschlüsselt');
    writeFileSync(join(wiki, 'tresor', 'Andere.md'), `---\nencrypted: age\n---\n${ARMOR}`);
    await until(() => sh('log', '-1', '--format=%s') === 'docs: tresor/Andere.md außerhalb von Kaveyl Wiki geändert');
    expect(sh('log', '-p', `${head}..HEAD`)).not.toContain('Geheim von außen');
    expect(sh('ls-files', 'tresor')).not.toMatch(/Klartext|bild/);
    const notes = (await app.server.inject({ method: 'GET', url: `/api/activity?mountId=${id}`, headers: { cookie } })).json() as unknown;
    expect(JSON.stringify(notes)).toContain('nicht in die Versionen übernommen: tresor/Klartext.md, tresor/bild.png');

    // File names are names (sec-005): a line break makes no trailer, `*` takes nothing else along.
    writeFileSync(join(wiki, 'zwei\nCo-authored-by: Mallory <m@x>.md'), '# Z\n');
    await until(() => sh('log', '-1', '--format=%s').includes('Mallory'));
    expect(sh('log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).toBe('');
    expect(sh('log', '-1', '--format=%B').split('\n').filter(Boolean)).toHaveLength(1);
    await Promise.all([put('archiv/Start alt.md', '# Home\n\nWieder Anna.\n', anna.cookie), Promise.resolve(writeFileSync(join(wiki, '*'), 'stern'))]);
    await commitNow();
    await until(() => sh('log', '-1', '--format=%s', '--', ':(literal)*') !== '' && sh('status', '--porcelain', '--', 'archiv') === '');
    expect(sh('log', '-1', '--format=%an', '--', 'archiv/Start alt.md')).toBe('anna');
   }, 30_000);

  it('versions when something goes wrong: a source below a folder with versions, a first commit that fails, a refused Git setting, NAS helper files (AD-071)', async () => {
    const projects = join(root, 'projekte');
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 80 && !done(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(done()).toBe(true);
    };
    const V = join(projects, 'versionen');
    mkdirSync(join(V, 'teil'), { recursive: true });
    writeFileSync(join(V, 'teil', 'a.md'), '# A\n');
    writeFileSync(join(V, '.DS_Store'), 'mac');
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: V, encoding: 'utf8' }).trim();
    const top = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: V, name: 'Versionen', versions: true }) })).json() as { id: string };
    // NAS helper files and other hidden files stay out of the history.
    expect(sh('ls-files')).toBe('teil/a.md');
    expect(sh('status', '--porcelain')).toBe('');
    // A second source on a folder below: what another program changes there becomes a version too.
    const sub = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(V, 'teil'), name: 'Teil', versions: true }) })).json() as { id: string; options: { autoCommit: boolean } };
    expect(sub.options.autoCommit).toBe(true);
    writeFileSync(join(V, 'teil', 'von-aussen.md'), '# Von außen\n');
    await until(() => sh('log', '-1', '--format=%an|%s').startsWith('Kaveyl Wiki|') && sh('status', '--porcelain') === '');
    expect(sh('log', '-1', '--format=%s')).toMatch(/von-aussen\.md außerhalb von Kaveyl Wiki geändert/);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/notes/${sub.id}/von-aussen.md`, ...json({}) })).statusCode).toBe(200);
    await app.server.inject({ method: 'POST', url: `/api/mounts/${sub.id}/commit-now`, ...json({}) });
    const trash = (await app.server.inject({ method: 'GET', url: `/api/trash/${sub.id}`, headers: { cookie } })).json() as { items: { files: string[] }[] };
    expect(trash.items.some((t) => t.files.includes('von-aussen.md'))).toBe(true);

    // A Git setting that could start a program: refused with its own message; the change still reaches the tree.
    execFileSync('git', ['config', 'filter.x.clean', 'cat'], { cwd: V });
    writeFileSync(join(V, 'b.md'), '# B\n');
    let tree: string[] = [];
    for (let i = 0; i < 80 && !tree.includes('b.md'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      tree = ((await app.server.inject({ method: 'GET', url: `/api/tree/${top.id}`, headers: { cookie } })).json() as { path: string }[]).map((e) => e.path);
    }
    expect(tree).toContain('b.md');
    const history = await app.server.inject({ method: 'GET', url: `/api/history/${top.id}/teil/a.md`, headers: { cookie } });
    expect(history.statusCode).toBe(409);
    expect(history.json().error).toMatch(/filter\.x\.clean|Programme starten|start programs/);
    const log = JSON.stringify((await app.server.inject({ method: 'GET', url: `/api/activity?mountId=${top.id}`, headers: { cookie } })).json());
    expect(log).toMatch(/nicht als Version übernommen|not taken as a version/);
    execFileSync('git', ['config', '--unset', 'filter.x.clean'], { cwd: V });

    // The first commit fails (a file git may not read): no source, no half Git – a second try works.
    const L = join(projects, 'halb');
    mkdirSync(L);
    writeFileSync(join(L, 'ok.md'), '# Ok\n');
    writeFileSync(join(L, 'zu.md'), '# Zu\n');
    execFileSync('chmod', ['000', join(L, 'zu.md')]);
    const count = () => app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } }).then((r) => (r.json() as unknown[]).length);
    const before = await count();
    const failed = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: L, name: 'Halb', versions: true }) });
    execFileSync('chmod', ['644', join(L, 'zu.md')]);
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(await count()).toBe(before);
    expect(existsSync(join(L, '.git'))).toBe(false);
    expect((await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: L, name: 'Halb', versions: true }) })).statusCode).toBe(200);
    expect(execFileSync('git', ['ls-files'], { cwd: L, encoding: 'utf8' }).trim().split('\n')).toEqual(['ok.md', 'zu.md']);
  }, 30_000);

  it('a new empty folder mounted with versions starts with one commit; a folder inside a repository keeps that one', async () => {
    const projects = join(root, 'projekte');
    const created = await app.server.inject({ method: 'POST', url: '/api/sources/local/folder', ...json({ parent: projects, name: 'Leer' }) });
    const res = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: (created.json() as { path: string }).path, name: 'Leer', versions: true }) });
    expect(res.statusCode).toBe(200);
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: join(projects, 'Leer'), encoding: 'utf8' }).trim()).toBe('docs: Versionen eingeschaltet (Kaveyl Wiki)');
    // A folder inside an existing repository: no Git of its own, only automatic commits.
    const repo = join(projects, 'repo');
    mkdirSync(join(repo, 'teil'), { recursive: true });
    writeFileSync(join(repo, 'teil', 'a.md'), '# A\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const inner = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(repo, 'teil'), name: 'Teil', versions: true }) });
    expect(inner.json()).toMatchObject({ options: { autoCommit: true } });
    expect(existsSync(join(repo, 'teil', '.git'))).toBe(false);
    // A folder Kaveyl Wiki may not write into: a clear message, no half source, no half Git.
    const locked = join(projects, 'gesperrt');
    mkdirSync(locked);
    writeFileSync(join(locked, 'g.md'), '# G\n');
    execFileSync('chmod', ['555', locked]);
    const before = (await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } })).json().length;
    const refused = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: locked, name: 'Gesperrt', versions: true }) });
    execFileSync('chmod', ['755', locked]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Schreibrecht|write access/);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } })).json()).toHaveLength(before);
    expect(existsSync(join(locked, '.git'))).toBe(false);
    // Repositories have versions anyway.
    const { id } = await createLocalMount();
    app.db.prepare("UPDATE mounts SET type = 'remote' WHERE id = ?").run(id);
    expect((await app.server.inject({ method: 'POST', url: `/api/mounts/${id}/versions`, ...json({}) })).statusCode).toBe(400);
  });

  it('rejects remote URLs with embedded credentials or non-HTTPS schemes', async () => {
    for (const source of ['https://user:pw@example.com/r.git', 'file:///etc', '--upload-pack=x']) {
      const res = await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'remote', source }) });
      expect(res.statusCode).toBe(400);
    }
  });

  it('reads, saves, detects conflicts and searches', async () => {
    const { id } = await createLocalMount();
    const note = (await app.server.inject({ method: 'GET', url: `/api/notes/${id}/docs/home.md`, headers: { cookie } })).json() as {
      raw: string;
      hash: string;
    };
    expect(note.raw).toBe('# Home\n\nTrilium und Outline.\n');
    const saved = await app.server.inject({ method: 'PUT', url: `/api/notes/${id}/docs/home.md`, ...json({ raw: '# Home\n\nNeu.\n', baseHash: note.hash }) });
    expect(saved.json()).toMatchObject({ changed: true });
    const stale = await app.server.inject({ method: 'PUT', url: `/api/notes/${id}/docs/home.md`, ...json({ raw: '# Alt\n', baseHash: note.hash }) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'Die Notiz wurde inzwischen anderswo geändert', currentRaw: '# Home\n\nNeu.\n' });

    const created = await app.server.inject({ method: 'POST', url: `/api/notes/${id}`, ...json({ parent: 'docs', title: 'Trilium Ideen' }) });
    expect(created.json()).toEqual({ path: 'docs/Trilium Ideen.md' });
    const hits = (await app.server.inject({ method: 'GET', url: '/api/search?q=trili', headers: { cookie } })).json() as { notes: { path: string }[] };
    expect(hits.notes.map((h) => h.path)).toEqual(['docs/Trilium Ideen.md']);
  });

  it('keeps the commit pause within 5 s … 1 h and commits on request', async () => {
    const { id } = await createLocalMount();
    const patch = async (commitIdleSec: unknown) =>
      ((await app.server.inject({ method: 'PATCH', url: `/api/mounts/${id}`, ...json({ options: { commitIdleSec } }) })).json() as { options: { commitIdleSec: number } }).options.commitIdleSec;
    expect(await patch(1)).toBe(5);
    expect(await patch(99999)).toBe(3600);
    expect(await patch(300)).toBe(300);
    expect((await app.server.inject({ method: 'POST', url: `/api/mounts/${id}/commit-now`, ...json({}) })).json()).toEqual({ ok: true });
  });

  it('blocks path traversal', async () => {
    const { id } = await createLocalMount();
    const res = await app.server.inject({ method: 'GET', url: `/api/notes/${id}/..%2F..%2Fetc%2Fpasswd`, headers: { cookie } });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('never translates note content, also not under a percent-encoded path', async () => {
    const { id } = await createLocalMount();
    writeFileSync(join(root, 'projekte', 'wiki', 'docs', 'fehlt.md'), '# Nicht gefunden\n\nNicht gefunden\n');
    for (const url of [`/api/notes/${id}/docs/fehlt.md`, `/api/%6eotes/${id}/docs/fehlt.md`, `/%61pi/notes/${id}/docs/fehlt.md`]) {
      const res = await app.server.inject({ method: 'GET', url, headers: { cookie, 'x-kaveyl-wiki-lang': 'en' } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('Not found');
      expect(res.body, url).toContain('"text":"Nicht gefunden"');
    }
    // Errors on the same routes still follow the request language.
    const missing = await app.server.inject({ method: 'GET', url: `/api/%6eotes/${id}/docs/nichts.md`, headers: { cookie, 'x-kaveyl-wiki-lang': 'en' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain('Nicht gefunden');
  });
});

describe('connections', () => {
  it("a connection's token only goes to its own server (wizard, new source, switching)", async () => {
    const conn = await app.server.inject({ method: 'POST', url: '/api/connections', ...json({ kind: 'gitea', name: 'Gitea', baseUrl: 'https://gitea.example', token: 'tok-geheim-1' }) });
    expect(conn.statusCode).toBe(200);
    const id = (conn.json() as { id: string }).id;
    for (const [url, body] of [
      ['/api/sources/branches', { url: 'https://andere.example/x.git', connectionId: id }],
      ['/api/sources/tree', { type: 'remote', source: 'https://andere.example/x.git', branch: 'main', connectionId: id }],
      ['/api/mounts', { type: 'remote', source: 'https://andere.example/x.git', name: 'X', connectionId: id }],
    ] as const) {
      const res = await app.server.inject({ method: 'POST', url, ...json(body) });
      expect(res.statusCode, url).toBe(400);
      expect(res.body, url).toContain('gehört zu https://gitea.example');
    }
  });
});

describe('links', () => {
  it('lists backlinks and offers a link repair after an outside rename in a local folder', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    writeFileSync(join(wiki, 'start.md'), '# Start\n\n[Home](docs/home.md)\n');
    const { id } = await createLocalMount();
    const back = await app.server.inject({ method: 'GET', url: `/api/backlinks/${id}/docs/home.md`, headers: { cookie } });
    expect(back.json()).toEqual([{ path: 'start.md', title: 'Start', count: 1 }]);

    renameSync(join(wiki, 'docs', 'home.md'), join(wiki, 'docs', 'willkommen.md'));
    const offered = async () => {
      const st = await app.server.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
      return (st.json() as { id: string; linkRepairs: number }[]).find((m) => m.id === id)!.linkRepairs;
    };
    const end = Date.now() + 4000;
    while ((await offered()) !== 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(await offered()).toBe(1);
    // Local folder without auto-commit: nothing is changed until the user accepts.
    expect(readFileSync(join(wiki, 'start.md'), 'utf8')).toBe('# Start\n\n[Home](docs/home.md)\n');
    const res = await app.server.inject({ method: 'POST', url: `/api/mounts/${id}/repair-links`, ...json({}) });
    expect(res.json()).toEqual({ files: ['start.md'], links: 1 });
    expect(readFileSync(join(wiki, 'start.md'), 'utf8')).toBe('# Start\n\n[Home](docs/willkommen.md)\n');
    expect(await offered()).toBe(0);
  });
});

describe('fsck', () => {
  it('reports broken links, duplicate ids and index drift without changing anything', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    writeFileSync(join(wiki, 'a.md'), '---\nid: 01JDOPPELT0000000000000000\n---\n# A\n\n[weg](gibts-nicht.md) [ok](docs/home.md) ![b](fehlt.png)\n');
    writeFileSync(join(wiki, 'kopie.md'), '---\nid: 01JDOPPELT0000000000000000\n---\n# Kopie\n');
    const { id } = await createLocalMount();
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/fsck', headers: { cookie } })).json()).toBeNull();
    const res = await app.server.inject({ method: 'POST', url: '/api/admin/fsck', ...json({}) });
    const report = res.json() as { mounts: { mountId: string; issues: { kind: string; path: string }[] }[] };
    const issues = report.mounts.find((m) => m.mountId === id)!.issues.map((i) => `${i.kind}:${i.path}`).sort();
    expect(issues).toEqual(['broken-link:a.md', 'broken-link:a.md', 'duplicate-id:a.md', 'duplicate-id:kopie.md']);
    // The last report is kept.
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/fsck', headers: { cookie } })).json()).toEqual(report);
  });
});

describe('event log', () => {
  const allActivity = () => JSON.stringify(app.db.prepare('SELECT * FROM activity').all());

  it('admins see what one person did (user name in the log, display name in commits)', async () => {
    await addUser('maria', { displayName: 'Maria Muster' });
    const users = (await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    const mariaId = users.find((u) => u.username === 'maria')!.id;
    const login = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } });
    const maria = `kw_session=${login.cookies.find((c) => c.name === 'kw_session')!.value}`;
    app.db.prepare("INSERT INTO activity (at, category, level, actor, action, message) VALUES (?, 'sync', 'info', 'Maria Muster', 'committed', 'Commit abc: docs')").run(new Date().toISOString());
    const res = await app.server.inject({ method: 'GET', url: `/api/activity?userId=${mariaId}`, headers: { cookie } });
    const entries = res.json() as { actor: string; action: string }[];
    expect(entries.map((e) => e.action).sort()).toEqual(['committed', 'login', 'login', 'password-changed']);
    expect(new Set(entries.map((e) => e.actor))).toEqual(new Set(['maria', 'Maria Muster']));
    expect((await app.server.inject({ method: 'GET', url: `/api/activity?userId=${mariaId}`, headers: { cookie: maria } })).statusCode).toBe(403);
  });

  it('records security events but never passwords or tokens', async () => {
    const bad = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: 'Falsches-Passwort-42' } });
    expect(bad.statusCode).toBe(401);
    // Someone types the password into the user name field: that text must not be logged.
    await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'Mein-Geheimes-PW', password: 'x' } });
    await app.server.inject({ method: 'PUT', url: '/api/settings/gitea', ...json({ baseUrl: 'https://gitea.example.test/x', token: 'tok_SUPERGEHEIM_123456' }) });
    await app.server.inject({ method: 'POST', url: '/api/account/password', ...json({ current: ADMIN_PW, next: 'Neues-Passwort-9999' }) });
    const res = await app.server.inject({ method: 'GET', url: '/api/activity?category=audit', headers: { cookie } });
    const entries = res.json() as { action: string; message: string; actor: string | null; detail: { ip?: string } | null }[];
    expect(entries.map((e) => e.action)).toEqual(['password-changed', 'gitea-settings', 'login-failed', 'login-failed', 'setup']);
    expect(entries[2]!.message).toBe('Anmeldung fehlgeschlagen (unbekannte E-Mail)');
    expect(entries[3]).toMatchObject({ actor: 'admin', message: 'Anmeldung fehlgeschlagen für „admin“' });
    expect(entries[1]!.message).toBe('Gitea-Zugang geändert: https://gitea.example.test (neuer Token gesetzt)');
    expect(entries[3]!.detail?.ip).toBeTruthy();
    const everything = allActivity();
    for (const secret of ['Falsches-Passwort-42', 'Mein-Geheimes-PW', 'tok_SUPERGEHEIM_123456', ADMIN_PW, 'Neues-Passwort-9999']) expect(everything).not.toContain(secret);
  });

  it('logs mount changes, keeps retention within limits and makes backups on demand', async () => {
    const { id } = await createLocalMount();
    const list = (await app.server.inject({ method: 'GET', url: `/api/activity?mountId=${id}`, headers: { cookie } })).json() as { action: string }[];
    expect(list.map((e) => e.action)).toContain('mount-added');
    // One way for the log retention: the deletion rules (code-010); the former own route is gone.
    const put = await app.server.inject({ method: 'PUT', url: '/api/admin/cleanup', ...json({ logInfoDays: 0, logProblemDays: 99999, logAuditDays: 400 }) });
    expect(put.json()).toMatchObject({ logInfoDays: 1, logProblemDays: 3650, logAuditDays: 400 });
    expect(allActivity()).toContain('Löschregeln geändert: logInfoDays 30 → 1, logProblemDays 90 → 3650, logAuditDays 365 → 400');
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/retention', headers: { cookie } })).statusCode).toBe(404);
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/retention', ...json({ infoDays: 45 }) })).statusCode).toBe(404);
    const backups = (await app.server.inject({ method: 'POST', url: '/api/admin/backups', ...json({}) })).json() as { name: string; kind: string }[];
    // Its own copy (kind „von Hand“): the night's daily copy is never replaced by it.
    expect(backups.map((b) => b.kind)).toEqual(['manual']);
    expect(backups[0]!.name).toMatch(/^manuell-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    expect(allActivity()).toContain('Datenbank gesichert');
  });
});

describe('users and API tokens', () => {
  it('admins manage users; locked users cannot log in; the last admin is protected', async () => {
    const created = await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ username: 'maria', displayName: 'Maria M.', email: 'maria@example.test', password: 'Start-Passwort-0001' }) });
    expect(created.statusCode).toBe(200);
    const maria = created.json() as { id: string; isAdmin: boolean; mustChangePassword: boolean };
    expect(maria).toMatchObject({ isAdmin: false, mustChangePassword: true });
    // E-mail and user name are unique (case-insensitive); weak passwords are refused.
    expect((await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ email: 'MARIA@example.test', password: 'Start-Passwort-0001' }) })).json().error).toMatch(/schon ein Konto/);
    expect((await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ email: 'm2@example.test', username: 'MARIA', password: 'Start-Passwort-0001' }) })).json().error).toMatch(/vergeben/);
    expect((await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ email: 'm3@example.test', password: 'Passwort-2026-Passwort' }) })).json().error).toMatch(/nicht leicht zu erraten/);
    // Not built from the own address or name either.
    expect((await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ email: 'm4@example.test', username: 'hannelore', password: 'Hannelore-2026-!!!' }) })).json().error).toMatch(/nicht leicht zu erraten/);
    // Without an e-mail address there is no account any more.
    expect((await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ username: 'ohne', password: 'Start-Passwort-0001' }) })).statusCode).toBe(400);
    const login = async (e: string, p: string) => app.server.inject({ method: 'POST', url: '/api/login', payload: { email: e, password: p } });
    // A start password from the admin must be replaced before anything else works.
    const first = await login('Maria@Example.test', 'Start-Passwort-0001');
    expect(first.statusCode).toBe(200);
    const mariaCookie = sessionCookie(first);
    const blocked = await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie: mariaCookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('password-change-required');
    expect((await app.server.inject({ method: 'GET', url: '/api/session', headers: { cookie: mariaCookie } })).json().user.mustChangePassword).toBe(true);
    const asMaria = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: mariaCookie } });
    expect((await app.server.inject({ method: 'POST', url: '/api/account/password', ...asMaria({ current: 'Start-Passwort-0001', next: 'Start-Passwort-0001' }) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'POST', url: '/api/account/password', ...asMaria({ current: 'Start-Passwort-0001', next: 'kurz' }) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'POST', url: '/api/account/password', ...asMaria({ current: 'Start-Passwort-0001', next: userPw('maria') }) })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie: mariaCookie } })).statusCode).toBe(200);
    // A normal user cannot administrate.
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: mariaCookie } })).statusCode).toBe(403);
    await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${maria.id}`, ...json({ disabled: true }) });
    expect((await login('maria@example.test', userPw('maria'))).statusCode).toBe(403); // the right password: told that it is locked
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie: mariaCookie } })).statusCode).toBe(401);
    await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${maria.id}`, ...json({ disabled: false }) });
    await app.server.inject({ method: 'POST', url: `/api/admin/users/${maria.id}/password`, ...json({ password: 'Neues-Passwort-0002' }) });
    expect((await login('maria@example.test', 'Neues-Passwort-0002')).json().user.mustChangePassword).toBe(true);
    // E-mail can be changed, but not to an address someone else has.
    expect((await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${maria.id}`, ...json({ email: 'admin@example.test' }) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${maria.id}`, ...json({ email: 'maria.neu@example.test' }) })).json().email).toBe('maria.neu@example.test');
    const users = (await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    const admin = users.find((u) => u.username === 'admin')!;
    expect((await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${admin.id}`, ...json({ isAdmin: false }) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${admin.id}`, ...json({ isGuest: true }) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/admin/users/${admin.id}`, ...json({}) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/admin/users/${maria.id}`, ...json({}) })).statusCode).toBe(200);
  });

  it('a start password can stay as the admin set it – for accounts of agents (owner 28.10.)', async () => {
    const created = await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ displayName: 'Agent', email: 'agent@example.test', password: 'Agent-Passwort-0001', mustChange: false }) });
    const agent = created.json() as { id: string; mustChangePassword: boolean };
    expect(agent.mustChangePassword).toBe(false);
    const login = async (p: string) => app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'agent@example.test', password: p } });
    const first = await login('Agent-Passwort-0001');
    expect(first.json().user.mustChangePassword).toBe(false);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie: sessionCookie(first) } })).statusCode).toBe(200);
    // A new password from the admin: unticked it stays, without the field it must be changed as before.
    await app.server.inject({ method: 'POST', url: `/api/admin/users/${agent.id}/password`, ...json({ password: 'Agent-Passwort-0002', mustChange: false }) });
    expect((await login('Agent-Passwort-0002')).json().user.mustChangePassword).toBe(false);
    await app.server.inject({ method: 'POST', url: `/api/admin/users/${agent.id}/password`, ...json({ password: 'Agent-Passwort-0003' }) });
    expect((await login('Agent-Passwort-0003')).json().user.mustChangePassword).toBe(true);
  });

  it('deleting an account also removes its access rules and its traces in the log (name, address, IP)', async () => {
    const { id: mountId } = await createLocalMount();
    const maria = await addUser('maria', { displayName: 'Maria Muster' });
    const rule = await app.server.inject({ method: 'POST', url: `/api/acl/${mountId}`, ...json({ target: 'folder', path: 'docs', subject: 'user', subjectId: maria.id, level: 'read' }) });
    expect(rule.statusCode).toBe(200);
    await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: 'Falsch-Passwort-0001' }, headers: { 'x-forwarded-for': '203.0.113.44' } });
    const traces = () =>
      JSON.stringify(app.db.prepare("SELECT actor, message, detail_json FROM activity WHERE actor IN ('maria', 'Maria Muster') OR message LIKE '%maria%' OR detail_json LIKE '%203.0.113.44%'").all());
    expect(traces()).toContain('maria');
    expect((await app.server.inject({ method: 'DELETE', url: `/api/admin/users/${maria.id}`, ...json({}) })).statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM acl_rules WHERE subject = 'user' AND subject_id = ?").get(maria.id)).toEqual({ n: 0 });
    expect(traces()).toBe('[]');
    // What happened stays readable – who it was does not.
    const left = app.db.prepare("SELECT action, actor FROM activity WHERE action IN ('login', 'login-failed', 'password-changed', 'user-deleted')").all() as { action: string; actor: string | null }[];
    expect(left.map((r) => r.action)).toEqual(expect.arrayContaining(['login', 'login-failed', 'user-deleted']));
  });

  it('existing passwords stay valid, even if they miss the policy (AD-048: only checked when set)', async () => {
    const { hashPassword } = await import('./auth/auth.js');
    app.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(await hashPassword('altes-pw-10'), 'admin');
    const res = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: 'altes-pw-10' } });
    expect(res.json().user.mustChangePassword).toBe(false);
    const c = sessionCookie(res);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie: c } })).statusCode).toBe(200);
    // A new one has to meet it.
    const weak = await app.server.inject({ method: 'POST', url: '/api/account/password', payload: JSON.stringify({ current: 'altes-pw-10', next: 'admin@example.test' }), headers: { 'content-type': 'application/json', cookie: c } });
    expect(weak.statusCode).toBe(400);
    const ok = await app.server.inject({ method: 'POST', url: '/api/account/password', payload: JSON.stringify({ current: 'altes-pw-10', next: ADMIN_PW }), headers: { 'content-type': 'application/json', cookie: c } });
    expect(ok.statusCode).toBe(200);
  });

  it('„Angemeldet bleiben“: with it a 30-day cookie, without it a browser-session cookie', async () => {
    const login = (remember?: boolean) => app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: ADMIN_PW, remember } });
    const long = (await login(true)).cookies.find((c) => c.name === 'kw_session')!;
    expect(long.expires!.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const short = (await login(false)).cookies.find((c) => c.name === 'kw_session')!;
    expect(short.expires).toBeUndefined();
    const row = app.db.prepare('SELECT expires_at FROM sessions ORDER BY created_at DESC LIMIT 1').get() as { expires_at: string };
    expect(Date.parse(row.expires_at) - Date.now()).toBeLessThan(25 * 3_600_000);
  });

  it('personal tokens: shown once, scopes enforced, no CSRF needed, revocable, never in logs', async () => {
    const { id } = await createLocalMount();
    const res = await app.server.inject({ method: 'POST', url: '/api/tokens', ...json({ name: 'Skript', scopes: ['read'], expiresDays: 30 }) });
    const { token, info } = res.json() as { token: string; info: { id: string; prefix: string; scopes: string[] } };
    expect(token).toMatch(/^kw_[A-Za-z0-9_-]{40}$/);
    expect(info).toMatchObject({ prefix: token.slice(0, 10), scopes: ['read'] });
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: bearer(token) })).statusCode).toBe(200);
    // read-only: writes are refused, admin routes too, token management only in the browser.
    const note = (await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: bearer(token) })).json() as { hash: string };
    expect((await app.server.inject({ method: 'PUT', url: `/api/v1/notes/${id}/docs/home.md`, headers: { ...bearer(token), 'content-type': 'application/json' }, payload: JSON.stringify({ markdown: '# x\n', baseHash: note.hash }) })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: bearer(token) })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'GET', url: '/api/tokens', headers: bearer(token) })).statusCode).toBe(403);
    // App routes need the browser login, whatever the token may do (AD-047).
    expect((await app.server.inject({ method: 'GET', url: `/api/notes/${id}/docs/home.md`, headers: bearer(token) })).statusCode).toBe(403);
    // write token: works without the JSON/CSRF rule's cookie, author = token owner.
    const w = ((await app.server.inject({ method: 'POST', url: '/api/tokens', ...json({ name: 'Schreiben', scopes: ['read', 'write'] }) })).json() as { token: string }).token;
    expect((await app.server.inject({ method: 'PUT', url: `/api/v1/notes/${id}/docs/home.md`, headers: { ...bearer(w), 'content-type': 'application/json' }, payload: JSON.stringify({ markdown: '# Per Token\n', baseHash: note.hash }) })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: '/api/tokens', headers: { cookie } })).json()).toHaveLength(2);
    await app.server.inject({ method: 'DELETE', url: `/api/tokens/${info.id}`, ...json({}) });
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: bearer(token) })).statusCode).toBe(401);
    expect((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: bearer('kw_falschfalschfalschfalschfalsch') })).statusCode).toBe(401);
    const log = JSON.stringify((await app.server.inject({ method: 'GET', url: '/api/activity?limit=200', headers: { cookie } })).json());
    expect(log).toContain('API-Token erstellt');
    expect(log).not.toContain(token);
    expect(log).not.toContain(w);
  });

  it('renewing a token: new value, same name and rights, the old value stops at once (owner 28.10.)', async () => {
    const { id } = await createLocalMount();
    const { token, info } = (await app.server.inject({ method: 'POST', url: '/api/tokens', ...json({ name: 'Skript', scopes: ['read'], expiresDays: 30 }) })).json() as { token: string; info: { id: string } };
    const renewed = (await app.server.inject({ method: 'POST', url: `/api/tokens/${info.id}/renew`, ...json({}) })).json() as { token: string; info: { id: string; name: string; scopes: string[]; expiresAt: string } };
    expect(renewed.token).not.toBe(token);
    expect(renewed.info).toMatchObject({ id: info.id, name: 'Skript', scopes: ['read'] });
    expect(Math.round((Date.parse(renewed.info.expiresAt) - Date.now()) / 86_400_000)).toBe(30);
    const read = (t: string) => app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: { authorization: `Bearer ${t}` } });
    expect((await read(token)).statusCode).toBe(401);
    expect((await read(renewed.token)).statusCode).toBe(200);
    // An expired token comes back with its validity counted from now.
    app.db.prepare('UPDATE api_tokens SET created_at = ?, expires_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z', info.id);
    expect((await read(renewed.token)).statusCode).toBe(401);
    const back = (await app.server.inject({ method: 'POST', url: `/api/tokens/${info.id}/renew`, ...json({}) })).json() as { token: string; info: { expiresAt: string } };
    expect(Math.round((Date.parse(back.info.expiresAt) - Date.now()) / 86_400_000)).toBe(30);
    expect((await read(back.token)).statusCode).toBe(200);
    // Someone else's token cannot be renewed or deleted through the own routes.
    const maria = await addUser('maria');
    const asMaria = { payload: '{}', headers: { 'content-type': 'application/json', cookie: maria.cookie } };
    expect((await app.server.inject({ method: 'POST', url: `/api/tokens/${info.id}/renew`, ...asMaria })).statusCode).toBe(404);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/tokens/${info.id}`, ...asMaria })).statusCode).toBe(404);
    expect((await read(back.token)).statusCode).toBe(200);
    // „admin“ goes on renewal when the person is no admin any more; with nothing left it is refused.
    const boss = await addUser('boss', { isAdmin: true });
    const asBoss = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: boss.cookie } });
    const both = (await app.server.inject({ method: 'POST', url: '/api/tokens', ...asBoss({ name: 'beides', scopes: ['read', 'admin'] }) })).json() as { info: { id: string } };
    const only = (await app.server.inject({ method: 'POST', url: '/api/tokens', ...asBoss({ name: 'nur admin', scopes: ['admin'] }) })).json() as { info: { id: string } };
    app.db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(boss.id);
    expect((await app.server.inject({ method: 'POST', url: `/api/tokens/${both.info.id}/renew`, ...asBoss({}) })).json().info.scopes).toEqual(['read']);
    expect((await app.server.inject({ method: 'POST', url: `/api/tokens/${only.info.id}/renew`, ...asBoss({}) })).json().error).toMatch(/keine Rechte mehr/);
  });

  it('admins make, list, renew and delete tokens for others; the person sees who made it (owner 28.10.)', async () => {
    const { id } = await createLocalMount();
    const agent = await addUser('agent', { displayName: 'Claude Agent' });
    const guest = await addUser('gast', { isGuest: true });
    const make = (body: Record<string, unknown>) => app.server.inject({ method: 'POST', url: '/api/admin/tokens', ...json(body) });
    const res = await make({ userId: agent.id, name: 'MCP', scopes: ['read', 'write', 'mcp'] });
    expect(res.statusCode).toBe(200);
    const { token, info } = res.json() as { token: string; info: { id: string; createdBy: { name: string } } };
    expect(info.createdBy).toMatchObject({ name: 'Admin' });
    // It acts as the person: the token works, the database knows it as theirs.
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect(app.db.prepare('SELECT user_id FROM api_tokens WHERE id = ?').get(info.id)).toEqual({ user_id: agent.id });
    // At most what the person may: no „admin“ for a normal user, no tokens for guests.
    expect((await make({ userId: agent.id, name: 'x', scopes: ['admin'] })).json().error).toMatch(/Nur Administratoren/);
    expect((await make({ userId: guest.id, name: 'x', scopes: ['read'] })).json().error).toMatch(/Gäste/);
    expect((await make({ userId: 'gibtsnicht', name: 'x', scopes: ['read'] })).statusCode).toBe(400);
    // The person sees it in their own list, with who made it.
    const own = (await app.server.inject({ method: 'GET', url: '/api/tokens', headers: { cookie: agent.cookie } })).json() as { id: string; createdBy: unknown }[];
    expect(own).toEqual([expect.objectContaining({ id: info.id, createdBy: expect.objectContaining({ name: 'Admin' }) })]);
    // Everyone's tokens for admins only – never for the person, never with a token.
    const all = (await app.server.inject({ method: 'GET', url: '/api/admin/tokens', headers: { cookie } })).json() as { id: string; user: { username: string } }[];
    expect(all.map((t) => t.user.username)).toEqual(['agent']);
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/tokens', headers: { cookie: agent.cookie } })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/tokens', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    // Renewed by the person: now only they know the value – the „made by“ goes.
    const mine = (await app.server.inject({ method: 'POST', url: `/api/tokens/${info.id}/renew`, payload: '{}', headers: { 'content-type': 'application/json', cookie: agent.cookie } })).json() as { token: string; info: { createdBy: unknown } };
    expect(mine.info.createdBy).toBeNull();
    // Renewed by the admin: the admin knows it again.
    const again = (await app.server.inject({ method: 'POST', url: `/api/admin/tokens/${info.id}/renew`, ...json({}) })).json() as { token: string; info: { createdBy: unknown } };
    expect(again.info.createdBy).toMatchObject({ name: 'Admin' });
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: { authorization: `Bearer ${mine.token}` } })).statusCode).toBe(401);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/admin/tokens/${info.id}`, ...json({}) })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: { authorization: `Bearer ${again.token}` } })).statusCode).toBe(401);
    const log = JSON.stringify((await app.server.inject({ method: 'GET', url: '/api/activity?limit=200', headers: { cookie } })).json());
    expect(log).toContain('API-Token erstellt für agent');
    expect(log).toContain('API-Token gelöscht für agent');
    for (const t of [token, mine.token, again.token]) expect(log).not.toContain(t);
  });

  it('tokens an admin made for others go when that admin is locked, demoted or deleted; guests keep none (audit 28.10.)', async () => {
    const { id } = await createLocalMount();
    const other = await addUser('chefin', { isAdmin: true });
    const agent = await addUser('agent');
    const asOther = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: other.cookie } });
    const make = async () =>
      ((await app.server.inject({ method: 'POST', url: '/api/admin/tokens', ...asOther({ userId: agent.id, name: 'MCP', scopes: ['read', 'mcp'] }) })).json() as { token: string }).token;
    const read = async (t: string) => (await app.server.inject({ method: 'GET', url: `/api/v1/notes/${id}/docs/home.md`, headers: { authorization: `Bearer ${t}` } })).statusCode;
    // Locked – and demoted – the tokens they made for others stop working.
    let t = await make();
    expect(await read(t)).toBe(200);
    await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${other.id}`, ...json({ isAdmin: false }) });
    expect(await read(t)).toBe(401);
    await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${other.id}`, ...json({ isAdmin: true }) });
    const relog = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'chefin@example.test', password: userPw('chefin') } });
    other.cookie = sessionCookie(relog);
    t = await make();
    await app.server.inject({ method: 'DELETE', url: `/api/admin/users/${other.id}`, ...json({}) });
    expect(await read(t)).toBe(401);
    // A token the agent renewed itself is its own – and an account made a guest keeps none.
    const own = ((await app.server.inject({ method: 'POST', url: '/api/tokens', payload: JSON.stringify({ name: 'eigen', scopes: ['read'] }), headers: { 'content-type': 'application/json', cookie: agent.cookie } })).json() as { token: string }).token;
    expect(await read(own)).toBe(200);
    await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${agent.id}`, ...json({ isGuest: true }) });
    expect(await read(own)).toBe(401);
  });
});

describe('presence', () => {
  it('tracks who has a note open or is typing, and forgets on leave', async () => {
    const { id } = await createLocalMount();
    const beat = async (body: Record<string, unknown>) => (await app.server.inject({ method: 'POST', url: '/api/presence', ...json({ mountId: id, path: 'docs/home.md', ...body }) })).json();
    expect(await beat({ editing: false })).toEqual([{ id: expect.any(String), name: 'Admin', editing: false }]);
    expect(await beat({ editing: true })).toEqual([{ id: expect.any(String), name: 'Admin', editing: true }]);
    expect(await beat({ open: false })).toEqual([]);
  });
});

describe('manual order', () => {
  it('writes order into .kaveyl-wiki.yml (keeping other keys), reads it back and follows renames', async () => {
    const wiki = join(root, 'projekte', 'wiki', 'docs');
    writeFileSync(join(wiki, 'a.md'), '# A\n');
    writeFileSync(join(wiki, 'b.md'), '# B\n');
    writeFileSync(join(wiki, '.kaveyl-wiki.yml'), '# Ordner-Metadaten\nicon: emoji:📁\n');
    const { id } = await createLocalMount();
    const put = await app.server.inject({ method: 'PUT', url: `/api/order/${id}`, ...json({ folder: 'docs', order: ['b.md', 'home.md', 'a.md'] }) });
    expect(put.statusCode).toBe(200);
    expect(readFileSync(join(wiki, '.kaveyl-wiki.yml'), 'utf8')).toBe('# Ordner-Metadaten\nicon: emoji:📁\norder:\n  - b.md\n  - home.md\n  - a.md\n');
    expect((await app.server.inject({ method: 'GET', url: `/api/order/${id}`, headers: { cookie } })).json()).toEqual({ docs: ['b.md', 'home.md', 'a.md'] });
    await app.server.inject({ method: 'POST', url: `/api/notes/${id}/move`, ...json({ from: 'docs/home.md', to: 'docs/start.md' }) });
    expect((await app.server.inject({ method: 'GET', url: `/api/order/${id}`, headers: { cookie } })).json()).toEqual({ docs: ['b.md', 'start.md', 'a.md'] });
    expect((await app.server.inject({ method: 'PUT', url: `/api/order/${id}`, ...json({ folder: 'docs', order: ['../x'] }) })).statusCode).toBe(400);
    // An empty order means alphabetical again: the key goes, other keys stay …
    await app.server.inject({ method: 'PUT', url: `/api/order/${id}`, ...json({ folder: 'docs', order: [] }) });
    expect(readFileSync(join(wiki, '.kaveyl-wiki.yml'), 'utf8')).toBe('# Ordner-Metadaten\nicon: emoji:📁\n');
    expect((await app.server.inject({ method: 'GET', url: `/api/order/${id}`, headers: { cookie } })).json()).toEqual({});
    // … and a file that only held the order is removed.
    await app.server.inject({ method: 'PUT', url: `/api/order/${id}`, ...json({ folder: '', order: ['docs'] }) });
    expect(existsSync(join(root, 'projekte', 'wiki', '.kaveyl-wiki.yml'))).toBe(true);
    await app.server.inject({ method: 'PUT', url: `/api/order/${id}`, ...json({ folder: '', order: [] }) });
    expect(existsSync(join(root, 'projekte', 'wiki', '.kaveyl-wiki.yml'))).toBe(false);
  });
});

describe('order of the sources', () => {
  it('reorders mounts by id list (admin), the list follows the new positions', async () => {
    const a = await createLocalMount();
    mkdirSync(join(root, 'projekte', 'zwei'), { recursive: true });
    const b = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'zwei'), name: 'Zwei' }) })).json() as { id: string };
    const names = async () => ((await app.server.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } })).json() as { name: string }[]).map((m) => m.name);
    const res = await app.server.inject({ method: 'POST', url: '/api/mounts/reorder', ...json({ ids: [b.id, a.id] }) });
    expect(res.statusCode).toBe(200);
    expect(await names()).toEqual(['Zwei', 'Wiki']);
    await app.server.inject({ method: 'POST', url: '/api/mounts/reorder', ...json({ ids: [a.id, b.id] }) });
    expect(await names()).toEqual(['Wiki', 'Zwei']);
  });
});

describe('custom icons', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>');
  const upload = (name: string, body: Buffer, c = cookie, extra: Record<string, string> = { 'x-kaveyl-wiki-upload': '1' }) =>
    app.server.inject({ method: 'POST', url: `/api/icons?name=${encodeURIComponent(name)}`, payload: body, headers: { 'content-type': 'application/octet-stream', cookie: c, ...extra } });

  it('uploads, lists, serves sandboxed and deletes icons; the type comes from the content', async () => {
    const png = await upload('C:\\bilder\\Firma Logo.png', PNG);
    expect(png.statusCode).toBe(200);
    expect(png.json()).toMatchObject({ name: 'Firma Logo', mime: 'image/png', size: 40 });
    const svg = (await upload('stern.png', SVG)).json() as { id: string; mime: string };
    expect(svg.mime).toBe('image/svg+xml');
    expect((await upload('text.png', Buffer.from('kein Bild'))).statusCode).toBe(400);
    expect((await upload('gross.png', Buffer.concat([PNG, Buffer.alloc(300 * 1024)]))).statusCode).toBe(400);
    // CSRF: binary uploads need the custom header.
    expect((await upload('x.png', PNG, cookie, {})).statusCode).toBe(415);
    const list = (await app.server.inject({ method: 'GET', url: '/api/icons', headers: { cookie } })).json() as { name: string }[];
    expect(list.map((i) => i.name)).toEqual(['Firma Logo', 'stern']);
    const got = await app.server.inject({ method: 'GET', url: `/api/icons/${svg.id}`, headers: { cookie } });
    expect(got.headers['content-type']).toBe('image/svg+xml');
    expect(got.headers['content-security-policy']).toContain('sandbox');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.body).toContain('<svg');
    expect((await app.server.inject({ method: 'GET', url: `/api/icons/${svg.id}` })).statusCode).toBe(401);

    // Others may not delete my icon; admins may.
    await addUser('maria');
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    expect((await app.server.inject({ method: 'DELETE', url: `/api/icons/${svg.id}`, payload: '{}', headers: { 'content-type': 'application/json', cookie: maria } })).statusCode).toBe(403);
    const own = (await upload('eigen.png', PNG, maria)).json() as { id: string };
    expect((await app.server.inject({ method: 'DELETE', url: `/api/icons/${own.id}`, payload: '{}', headers: { 'content-type': 'application/json', cookie: maria } })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/icons/${svg.id}`, ...json({}) })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: `/api/icons/${svg.id}`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('access control (AD-020)', () => {
  it('filters tree, search and lists; read-only and hidden notes are enforced on every route', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'team', 'geheim'), { recursive: true });
    writeFileSync(join(wiki, 'team', 'plan.md'), '# Plan\n\nZebrawort im Plan. Siehe [Lohn](geheim/lohn.md).\n');
    writeFileSync(join(wiki, 'team', 'geheim', 'lohn.md'), '# Lohn\n\nZebrawort geheim.\n');
    const { id } = await createLocalMount();
    await addUser('maria');
    const users = (await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    const mariaId = users.find((u) => u.username === 'maria')!.id;
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    const as = (c: string) => ({ headers: { cookie: c } });
    const asJson = (c: string, body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: c } });
    const paths = async (c: string) => ((await app.server.inject({ method: 'GET', url: `/api/tree/${id}`, ...as(c) })).json() as { path: string; access: string }[]).map((e) => `${e.path}:${e.access}`);

    // Without rules: default level `write` for everyone (behaviour as before).
    expect(await paths(maria)).toContain('team/plan.md:write');

    // Group "Team" may read the team folder, the secret subfolder is closed for Maria.
    const team = (await app.server.inject({ method: 'POST', url: '/api/admin/groups', ...json({ name: 'Team' }) })).json() as { id: string };
    await app.server.inject({ method: 'PATCH', url: `/api/admin/groups/${team.id}`, ...json({ members: [mariaId] }) });
    const rule = (body: Record<string, unknown>, c = cookie) => app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...asJson(c, body) });
    expect((await rule({ target: 'mount', subject: 'all', level: 'none' })).statusCode).toBe(200);
    expect((await rule({ target: 'folder', path: 'team', subject: 'group', subjectId: team.id, level: 'read' })).statusCode).toBe(200);
    expect((await rule({ target: 'folder', path: 'team/geheim', subject: 'user', subjectId: mariaId, level: 'none' })).statusCode).toBe(200);

    expect(await paths(maria)).toEqual(['team:read', 'team/plan.md:read']);
    expect((await paths(cookie)).length).toBeGreaterThan(3);
    const mounts = (await app.server.inject({ method: 'GET', url: '/api/mounts', ...as(maria) })).json() as { id: string; access: string }[];
    expect(mounts.map((m) => m.access)).toEqual(['none']);

    // Reading: allowed note with its level; hidden ones look like they do not exist.
    const note = await app.server.inject({ method: 'GET', url: `/api/notes/${id}/team/plan.md`, ...as(maria) });
    expect(note.json()).toMatchObject({ path: 'team/plan.md', access: 'read' });
    for (const url of [`/api/notes/${id}/team/geheim/lohn.md`, `/api/notes/${id}/docs/home.md`, `/api/history/${id}/team/geheim/lohn.md`, `/api/attachments/${id}/docs/home.md`]) {
      expect((await app.server.inject({ method: 'GET', url, ...as(maria) })).statusCode, url).toBe(404);
    }
    // Writing with only read access: 403.
    const hash = (note.json() as { hash: string }).hash;
    expect((await app.server.inject({ method: 'PUT', url: `/api/notes/${id}/team/plan.md`, ...asJson(maria, { raw: '# x\n', baseHash: hash }) })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'POST', url: `/api/notes/${id}`, ...asJson(maria, { parent: 'team', title: 'Neu' }) })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/team/plan.md`, ...asJson(maria, {}) })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'PUT', url: `/api/order/${id}`, ...asJson(maria, { folder: 'team', order: [] }) })).statusCode).toBe(403);

    // Search, tags, recent and backlinks only show what Maria may read.
    const hits = (await app.server.inject({ method: 'GET', url: '/api/search/full?q=Zebrawort', ...as(maria) })).json() as { hits: { path: string }[] };
    expect(hits.hits.map((h) => h.path)).toEqual(['team/plan.md']);
    const quick = (await app.server.inject({ method: 'GET', url: '/api/search?q=zebrawort', ...as(maria) })).json() as { content: { path: string }[] };
    expect(quick.content.map((h) => h.path)).toEqual(['team/plan.md']);
    const recent = (await app.server.inject({ method: 'GET', url: '/api/recent', ...as(maria) })).json() as { path: string }[];
    expect(recent.map((r) => r.path)).toEqual(['team/plan.md']);

    // Managing rules needs `admin` on the target.
    expect((await rule({ target: 'folder', path: 'team', subject: 'all', level: 'write' }, maria)).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'GET', url: `/api/acl/${id}?target=folder&path=team`, ...as(maria) })).statusCode).toBe(403);
    const view = (await app.server.inject({ method: 'GET', url: `/api/acl/${id}?target=folder&path=team/geheim`, ...as(cookie) })).json() as { rules: unknown[]; inherited: unknown[] };
    expect(view.rules).toHaveLength(1);
    expect(view.inherited).toHaveLength(2);

    // Write for the group on one note; moving a folder takes its rules along.
    await rule({ target: 'note', path: 'team/plan.md', subject: 'group', subjectId: team.id, level: 'write' });
    expect((await app.server.inject({ method: 'PUT', url: `/api/notes/${id}/team/plan.md`, ...asJson(maria, { raw: '# Plan\n\nGeändert.\n', baseHash: hash }) })).statusCode).toBe(200);
    await app.server.inject({ method: 'POST', url: `/api/notes/${id}/move`, ...json({ from: 'team/geheim', to: 'team/intern' }) });
    expect(await paths(maria)).toEqual(['team:read', 'team/plan.md:write']);

    // Write on the folder is not enough to delete or move it with a hidden subfolder inside.
    await rule({ target: 'folder', path: 'team', subject: 'group', subjectId: team.id, level: 'write' });
    expect((await app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/team`, ...asJson(maria, {}) })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'POST', url: `/api/notes/${id}/move`, ...asJson(maria, { from: 'team', to: 'docs/team' }) })).statusCode).toBe(403);
    expect(existsSync(join(wiki, 'team', 'intern', 'lohn.md'))).toBe(true);
    await rule({ target: 'folder', path: 'team', subject: 'group', subjectId: team.id, level: 'read' });
    // Syncing needs write on the whole source (AD-020).
    expect((await app.server.inject({ method: 'POST', url: `/api/mounts/${id}/sync`, ...asJson(maria, {}) })).statusCode).toBe(404);
    expect((await app.server.inject({ method: 'POST', url: '/api/sync-all', ...asJson(maria, {}) })).statusCode).toBe(200);

    // Default level and group deletion.
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/acl-default', ...json({ level: 'admin' }) })).statusCode).toBe(400);
    await app.server.inject({ method: 'DELETE', url: `/api/admin/groups/${team.id}`, ...json({}) });
    // Nothing of hers is left in the source: it is hidden altogether, also its name (rules for others do not count).
    expect((await app.server.inject({ method: 'GET', url: `/api/tree/${id}`, ...as(maria) })).statusCode).toBe(404);
    expect(((await app.server.inject({ method: 'GET', url: '/api/mounts', ...as(maria) })).json() as { id: string }[]).map((m) => m.id)).not.toContain(id);

    // A folder renamed outside leaves its rule behind: listed at the source under "Regeln ohne Ziel", removable there.
    renameSync(join(wiki, 'team', 'intern'), join(wiki, 'team', 'extern'));
    const atMount = async () => ((await app.server.inject({ method: 'GET', url: `/api/acl/${id}?target=mount`, ...as(cookie) })).json() as { orphans: { id: string; path: string; folderMissing?: boolean }[] }).orphans;
    const left = await atMount();
    expect(left).toMatchObject([{ path: 'team/intern', folderMissing: true }]);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/acl/rule/${left[0]!.id}`, ...asJson(cookie, {}) })).statusCode).toBe(200);
    expect(await atMount()).toEqual([]);
  });

  it('names for the permissions dialog: guests only see themselves and their own groups (sec-009)', async () => {
    const maria = await addUser('maria');
    const gast = await addUser('gast', { isGuest: true });
    const team = (await app.server.inject({ method: 'POST', url: '/api/admin/groups', ...json({ name: 'Team' }) })).json() as { id: string };
    await app.server.inject({ method: 'POST', url: '/api/admin/groups', ...json({ name: 'Intern' }) });
    await app.server.inject({ method: 'PATCH', url: `/api/admin/groups/${team.id}`, ...json({ members: [gast.id, maria.id] }) });
    type Subjects = { users: { username: string }[]; groups: { name: string; size: number }[] };
    const subjects = async (c: string) => (await app.server.inject({ method: 'GET', url: '/api/acl-subjects', headers: { cookie: c } })).json() as Subjects;

    const forGuest = await subjects(gast.cookie);
    expect(forGuest.users.map((u) => u.username)).toEqual(['gast']);
    expect(forGuest.groups.map((g) => g.name)).toEqual(['Team']);
    for (const c of [maria.cookie, cookie]) {
      const all = await subjects(c);
      expect(all.users.map((u) => u.username).sort()).toEqual(['admin', 'gast', 'maria']);
      expect(all.groups.map((g) => g.name).sort()).toEqual(['Intern', 'Team']);
    }
  });

  it('guests never get „verwalten“ (AD-048): the dialog knows who is a guest, the server refuses such a rule', async () => {
    const { id } = await createLocalMount();
    const gast = await addUser('gast', { isGuest: true });
    const users = ((await app.server.inject({ method: 'GET', url: '/api/acl-subjects', headers: { cookie } })).json() as { users: { id: string; username: string; guest?: boolean }[] }).users;
    expect(users.find((u) => u.username === 'gast')).toMatchObject({ id: gast.id, guest: true });
    expect(users.find((u) => u.username === 'admin')!.guest).toBeFalsy();
    const set = (level: string) => app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'mount', subject: 'user', subjectId: gast.id, level }) });
    const refused = await set('admin');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Gäste/);
    expect((await set('write')).statusCode).toBe(200);
  });
});

describe('Speichern als (AD-039)', () => {
  it('saves an old version and a trash entry as new notes, also into another source, never overwriting', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' };
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: wiki, env, encoding: 'utf8' }).trim();
    writeFileSync(join(wiki, 'docs', 'plan.md'), '# Plan\n\nalt\n');
    sh('init', '-q', '-b', 'main');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'alt');
    const commit = sh('rev-parse', 'HEAD');
    writeFileSync(join(wiki, 'docs', 'plan.md'), '# Plan\n\nneu\n');
    const { id } = await createLocalMount();
    mkdirSync(join(root, 'projekte', 'zwei'));
    const other = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'zwei'), name: 'Zwei' }) })).json() as { id: string };
    const saveAs = (body: object) => app.server.inject({ method: 'POST', url: `/api/history/${id}/save-as`, ...json({ commit, versionPath: 'docs/plan.md', ...body }) });

    const same = await saveAs({ to: 'docs/plan (alt)' });
    expect(same.json()).toEqual({ mountId: id, path: 'docs/plan (alt).md', warnings: [] });
    expect(readFileSync(join(wiki, 'docs', 'plan (alt).md'), 'utf8')).toMatch(/^---\nid: \w{26}\n---\n# Plan\n\nalt\n$/);
    expect(readFileSync(join(wiki, 'docs', 'plan.md'), 'utf8')).toBe('# Plan\n\nneu\n');
    expect((await saveAs({ to: 'docs/plan (alt).md' })).statusCode).toBe(409);
    expect((await saveAs({ to: '' })).statusCode).toBe(400);
    const there = await saveAs({ to: 'archiv/plan', toMountId: other.id });
    expect(there.json()).toMatchObject({ mountId: other.id, path: 'archiv/plan.md' });
    expect(readFileSync(join(root, 'projekte', 'zwei', 'archiv', 'plan.md'), 'utf8')).toContain('# Plan\n\nalt\n');

    // Read-only users may not save anywhere they cannot write.
    await addUser('maria');
    const users = (await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'mount', subject: 'user', subjectId: users.find((u) => u.username === 'maria')!.id, level: 'read' }) });
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    const asMaria = await app.server.inject({
      method: 'POST',
      url: `/api/history/${id}/save-as`,
      payload: JSON.stringify({ commit, versionPath: 'docs/plan.md', to: 'docs/maria' }),
      headers: { 'content-type': 'application/json', cookie: maria },
    });
    expect(asMaria.statusCode).toBe(403);

    // The trash: a deleted note into the other source.
    await app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/docs/home.md`, ...json({}) });
    const items = ((await app.server.inject({ method: 'GET', url: `/api/trash/${id}`, headers: { cookie } })).json() as { items: { id: string; files: string[] }[] }).items;
    const item = items.find((t) => t.files.includes('docs/home.md'))!;
    const back = await app.server.inject({ method: 'POST', url: `/api/trash/${id}/restore`, ...json({ id: item.id, as: 'home aus wiki', toMountId: other.id }) });
    expect(back.json()).toMatchObject({ mountId: other.id, paths: ['home aus wiki.md'] });
    expect(existsSync(join(root, 'projekte', 'zwei', 'home aus wiki.md'))).toBe(true);
  });

  it('saves the editor text of a note gone outside as a new note, never overwriting, only where the user may write (AD-039)', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs', 'geheim'));
    writeFileSync(join(wiki, 'docs', 'bild.png'), 'png');
    writeFileSync(join(wiki, 'docs', 'geheim', 'lohn.png'), 'geheim');
    const { id } = await createLocalMount();
    mkdirSync(join(root, 'projekte', 'zwei'));
    const other = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'zwei'), name: 'Zwei' }) })).json() as { id: string };
    const raw = '# Weg\n\nMeine Eingabe. ![](bild.png) ![](geheim/lohn.png)\n';
    const saveAs = (body: object, c = cookie) =>
      app.server.inject({ method: 'POST', url: `/api/notes/${id}/save-as`, payload: JSON.stringify({ from: 'docs/weg.md', raw, ...body }), headers: { 'content-type': 'application/json', cookie: c } });

    const same = await saveAs({ to: 'docs/weg' });
    expect(same.json()).toEqual({ mountId: id, path: 'docs/weg.md', warnings: [] });
    expect(readFileSync(join(wiki, 'docs', 'weg.md'), 'utf8')).toContain('Meine Eingabe.');
    expect((await saveAs({ to: 'docs/weg.md' })).statusCode).toBe(409);
    expect((await saveAs({ to: '' })).statusCode).toBe(400);
    expect((await saveAs({ to: 'docs/fake', raw: '---\nencrypted: age\n---\nkein Block\n' })).statusCode).toBe(400);
    expect(existsSync(join(wiki, 'docs', 'fake.md'))).toBe(false);

    // Into another source: the files next to it come along – not those the user may not read.
    await addUser('maria');
    const users = (await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    const mariaId = users.find((u) => u.username === 'maria')!.id;
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'folder', path: 'docs/geheim', subject: 'user', subjectId: mariaId, level: 'none' }) });
    const maria = sessionCookie(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } }));
    const there = await saveAs({ to: 'archiv/weg', toMountId: other.id }, maria);
    expect(there.json()).toMatchObject({ mountId: other.id, path: 'archiv/weg.md' });
    expect(existsSync(join(root, 'projekte', 'zwei', 'archiv', 'bild.png'))).toBe(true);
    expect(existsSync(join(root, 'projekte', 'zwei', 'archiv', 'geheim', 'lohn.png'))).toBe(false);

    // Read-only users may not save anywhere they cannot write.
    await app.server.inject({ method: 'POST', url: `/api/acl/${other.id}`, ...json({ target: 'mount', subject: 'user', subjectId: mariaId, level: 'read' }) });
    expect((await saveAs({ to: 'maria', toMountId: other.id }, maria)).statusCode).toBe(403);
    expect(existsSync(join(root, 'projekte', 'zwei', 'maria.md'))).toBe(false);
  });

  it('takes along only files /api/files would serve: no dotfiles, no code or configuration outside attachments', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs', 'config'));
    mkdirSync(join(wiki, 'docs', 'assets'));
    writeFileSync(join(wiki, 'docs', 'bild.png'), 'png');
    writeFileSync(join(wiki, 'docs', 'assets', 'anhang.txt'), 'anhang');
    writeFileSync(join(wiki, 'docs', '.env'), 'SECRET=1');
    writeFileSync(join(wiki, 'docs', 'config', 'secret.json'), '{}');
    const { id } = await createLocalMount();
    mkdirSync(join(root, 'projekte', 'zwei'));
    const other = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'zwei'), name: 'Zwei' }) })).json() as { id: string };
    const maria = await addUser('maria');
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'mount', subject: 'user', subjectId: maria.id, level: 'read' }) });
    const raw = '# Weg\n\n![](bild.png) [a](assets/anhang.txt) [b](.env) [c](config/secret.json)\n';
    const res = await app.server.inject({
      method: 'POST',
      url: `/api/notes/${id}/save-as`,
      payload: JSON.stringify({ from: 'docs/weg.md', raw, to: 'assets/weg', toMountId: other.id }),
      headers: { 'content-type': 'application/json', cookie: maria.cookie },
    });
    expect(res.json()).toMatchObject({ mountId: other.id, path: 'assets/weg.md' });
    const zwei = join(root, 'projekte', 'zwei', 'assets');
    expect(existsSync(join(zwei, 'bild.png'))).toBe(true);
    expect(existsSync(join(zwei, 'assets', 'anhang.txt'))).toBe(true);
    expect(existsSync(join(zwei, '.env'))).toBe(false);
    expect(existsSync(join(zwei, 'config', 'secret.json'))).toBe(false);
  });

  it('an old version and a copied note take along only files the user may read and /api/files would serve', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' };
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: wiki, env, encoding: 'utf8' }).trim();
    mkdirSync(join(wiki, 'docs', 'geheim'));
    mkdirSync(join(wiki, 'docs', 'config'));
    mkdirSync(join(wiki, 'docs', 'assets'));
    writeFileSync(join(wiki, 'docs', 'bild.png'), 'png');
    writeFileSync(join(wiki, 'docs', 'assets', 'anhang.txt'), 'anhang');
    writeFileSync(join(wiki, 'docs', 'geheim', 'lohn.png'), 'geheim');
    writeFileSync(join(wiki, 'docs', '.env'), 'SECRET=1');
    writeFileSync(join(wiki, 'docs', 'config', 'secret.json'), '{}');
    writeFileSync(join(wiki, 'docs', 'plan.md'), '# Plan\n\n![](bild.png) [a](assets/anhang.txt) ![](geheim/lohn.png) [b](.env) [c](config/secret.json)\n');
    sh('init', '-q', '-b', 'main');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'alt');
    const commit = sh('rev-parse', 'HEAD');
    const { id } = await createLocalMount();
    mkdirSync(join(root, 'projekte', 'zwei'));
    const other = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'zwei'), name: 'Zwei' }) })).json() as { id: string };
    const maria = await addUser('maria');
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'folder', path: 'docs/geheim', subject: 'user', subjectId: maria.id, level: 'none' }) });
    const post = (url: string, body: object) => app.server.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: maria.cookie } });
    const only = (dir: string) => {
      expect(existsSync(join(dir, 'bild.png'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'anhang.txt'))).toBe(true);
      expect(existsSync(join(dir, 'geheim', 'lohn.png'))).toBe(false);
      expect(existsSync(join(dir, '.env'))).toBe(false);
      expect(existsSync(join(dir, 'config', 'secret.json'))).toBe(false);
    };

    // The files of an old version come from the history – also those gone since.
    rmSync(join(wiki, 'docs', 'bild.png'));
    const old = await post(`/api/history/${id}/save-as`, { commit, versionPath: 'docs/plan.md', to: 'version/plan', toMountId: other.id });
    expect(old.json()).toMatchObject({ mountId: other.id, path: 'version/plan.md' });
    only(join(root, 'projekte', 'zwei', 'version'));

    writeFileSync(join(wiki, 'docs', 'bild.png'), 'png');
    const copied = await post(`/api/notes/${id}/copy`, { from: 'docs/plan.md', toParent: 'kopie', toMountId: other.id });
    expect(copied.json()).toMatchObject({ mountId: other.id, path: 'kopie/plan.md' });
    only(join(root, 'projekte', 'zwei', 'kopie'));
  });

  it('a copied folder and a note restored from the trash under another name leave out files the user may not read', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs', 'geheim'));
    mkdirSync(join(wiki, 'docs', 'geheim', 'assets'));
    writeFileSync(join(wiki, 'docs', 'bild.png'), 'png');
    writeFileSync(join(wiki, 'docs', 'geheim', 'lohn.png'), 'geheim');
    writeFileSync(join(wiki, 'docs', 'geheim', 'assets', 'vertrag.pdf'), 'geheim');
    writeFileSync(join(wiki, 'docs', 'geheim', 'notiz.md'), '# Notiz\n');
    writeFileSync(join(wiki, 'docs', 'plan.md'), '# Plan\n\n![](bild.png) ![](geheim/lohn.png) [v](geheim/assets/vertrag.pdf)\n');
    const { id } = await createLocalMount();
    mkdirSync(join(root, 'projekte', 'zwei'));
    const other = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'zwei'), name: 'Zwei' }) })).json() as { id: string };
    const maria = await addUser('maria');
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'folder', path: 'docs/geheim', subject: 'user', subjectId: maria.id, level: 'none' }) });
    const post = (url: string, body: object) => app.server.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: maria.cookie } });
    const without = (dir: string) => {
      expect(existsSync(join(dir, 'bild.png'))).toBe(true);
      expect(existsSync(join(dir, 'geheim', 'lohn.png'))).toBe(false);
      expect(existsSync(join(dir, 'geheim', 'assets', 'vertrag.pdf'))).toBe(false);
      expect(existsSync(join(dir, 'geheim', 'notiz.md'))).toBe(false);
    };

    const copied = await post(`/api/notes/${id}/copy`, { from: 'docs', toParent: 'kopie', toMountId: other.id });
    expect(copied.json()).toMatchObject({ mountId: other.id, path: 'kopie/docs' });
    expect(existsSync(join(root, 'projekte', 'zwei', 'kopie', 'docs', 'plan.md'))).toBe(true);
    without(join(root, 'projekte', 'zwei', 'kopie', 'docs'));

    await app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/docs/plan.md`, ...json({}) });
    const items = ((await app.server.inject({ method: 'GET', url: `/api/trash/${id}`, headers: { cookie: maria.cookie } })).json() as { items: { id: string; files: string[] }[] }).items;
    const item = items.find((t) => t.files.includes('docs/plan.md'))!;
    const back = await post(`/api/trash/${id}/restore`, { id: item.id, as: 'zurueck/plan', toMountId: other.id });
    expect(back.json()).toMatchObject({ mountId: other.id, paths: ['zurueck/plan.md'] });
    without(join(root, 'projekte', 'zwei', 'zurueck'));
  });

  it('moving a note into another source or an encrypted note into another folder takes along only readable, servable files', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs', 'geheim', 'assets'), { recursive: true });
    mkdirSync(join(wiki, 'docs', 'config'));
    writeFileSync(join(wiki, 'docs', 'bild.png'), 'png');
    writeFileSync(join(wiki, 'docs', 'geheim', 'lohn.png'), 'geheim');
    writeFileSync(join(wiki, 'docs', 'geheim', 'assets', 'vertrag.pdf'), 'geheim');
    writeFileSync(join(wiki, 'docs', '.env'), 'SECRET=1');
    writeFileSync(join(wiki, 'docs', 'config', 'secret.json'), '{}');
    writeFileSync(join(wiki, 'docs', 'plan.md'), '# Plan\n\n![](bild.png) ![](geheim/lohn.png) [v](geheim/assets/vertrag.pdf) [e](.env) [c](config/secret.json)\n');
    const AGE = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n';
    writeFileSync(join(wiki, 'docs', 'tresor.md'), `---\nencrypted: age\nattachments:\n  - bild.png\n  - geheim/lohn.png\n  - geheim/assets/vertrag.pdf\n---\n${AGE}`);
    const { id } = await createLocalMount();
    mkdirSync(join(root, 'projekte', 'zwei'));
    const other = (await app.server.inject({ method: 'POST', url: '/api/mounts', ...json({ type: 'local', source: join(root, 'projekte', 'zwei'), name: 'Zwei' }) })).json() as { id: string };
    const maria = await addUser('maria');
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'folder', path: 'docs/geheim', subject: 'user', subjectId: maria.id, level: 'none' }) });
    const post = (url: string, body: object) => app.server.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: maria.cookie } });
    const without = (dir: string) => {
      expect(existsSync(join(dir, 'bild.png'))).toBe(true);
      expect(existsSync(join(dir, 'geheim', 'lohn.png'))).toBe(false);
      expect(existsSync(join(dir, 'geheim', 'assets', 'vertrag.pdf'))).toBe(false);
    };

    // Into assets/ of another source: there config/secret.json would become an attachment.
    const across = await post(`/api/notes/${id}/move`, { from: 'docs/plan.md', to: 'assets/plan.md', toMountId: other.id });
    expect(across.json()).toMatchObject({ mountId: other.id, path: 'assets/plan.md' });
    const zwei = join(root, 'projekte', 'zwei', 'assets');
    without(zwei);
    expect(existsSync(join(zwei, '.env'))).toBe(false);
    expect(existsSync(join(zwei, 'config', 'secret.json'))).toBe(false);

    const moved = await post(`/api/notes/${id}/move`, { from: 'docs/tresor.md', to: 'neu/tresor.md' });
    expect(moved.json()).toMatchObject({ mountId: id, path: 'neu/tresor.md' });
    without(join(wiki, 'neu'));
  });
});

describe('trash of deleted notes (AD-025)', () => {
  it('a note deleted in a Git source with auto-commit is in the trash at once (its commit is not waited for)', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' };
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: wiki, env, encoding: 'utf8' }).trim();
    sh('init', '-q', '-b', 'main');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'start');
    const { id } = await createLocalMount();
    await app.server.inject({ method: 'PATCH', url: `/api/mounts/${id}`, ...json({ options: { autoCommit: true, commitIdleSec: 600 } }) });
    // As in production: the commit waits for the pause (the suite otherwise commits at once).
    (app.manager as unknown as { config: { commitDelaySec: number | null } }).config.commitDelaySec = null;
    expect((await app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/docs/home.md`, ...json({}) })).statusCode).toBe(200);
    const trash = (await app.server.inject({ method: 'GET', url: `/api/trash/${id}`, headers: { cookie } })).json() as { mode: string; items: { files: string[] }[] };
    expect(trash.mode).toBe('git');
    expect(trash.items.some((t) => t.files.includes('docs/home.md'))).toBe(true);
    expect(sh('status', '--porcelain')).toBe('');
  });

  it('keeps deleted notes in the folder trash; restore, purge and empty follow the rights; retention is a setting', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    writeFileSync(join(wiki, 'docs', 'plan.md'), '# Plan\n');
    const { id } = await createLocalMount();
    const del = (p: string) => app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/${p}`, ...json({}) });
    expect((await del('docs')).statusCode).toBe(200);
    expect(existsSync(join(wiki, 'docs'))).toBe(false);
    type Trash = { mode: string; days: number; canEmpty: boolean; items: { id: string; path: string; isDir: boolean; files: string[] }[] };
    const list = async (c = cookie) => (await app.server.inject({ method: 'GET', url: `/api/trash/${id}`, headers: { cookie: c } })).json() as Trash;
    const first = await list();
    expect(first).toMatchObject({ mode: 'folder', days: 30, canEmpty: true, items: [{ path: 'docs', isDir: true, files: ['docs/home.md', 'docs/plan.md'] }] });

    // Only read access: sees the entry, may neither restore nor empty.
    await addUser('maria');
    const users = (await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'mount', subject: 'user', subjectId: users.find((u) => u.username === 'maria')!.id, level: 'read' }) });
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    const asMaria = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: maria } });
    expect((await list(maria)).canEmpty).toBe(false);
    expect((await app.server.inject({ method: 'POST', url: `/api/trash/${id}/restore`, ...asMaria({ id: first.items[0]!.id }) })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'POST', url: `/api/trash/${id}/empty`, ...asMaria({}) })).statusCode).toBe(403);

    const restored = await app.server.inject({ method: 'POST', url: `/api/trash/${id}/restore`, ...json({ id: first.items[0]!.id, paths: ['docs/plan.md'] }) });
    expect(restored.json()).toMatchObject({ paths: ['docs/plan.md'], warnings: [] });
    expect(readFileSync(join(wiki, 'docs', 'plan.md'), 'utf8')).toBe('# Plan\n');
    expect((await list()).items[0]!.files).toEqual(['docs/home.md']);
    expect((await app.server.inject({ method: 'POST', url: `/api/trash/${id}/purge`, ...json({ id: first.items[0]!.id }) })).statusCode).toBe(200);
    expect((await list()).items).toEqual([]);

    await del('docs/plan.md');
    expect((await app.server.inject({ method: 'POST', url: `/api/trash/${id}/empty`, ...json({}) })).json()).toEqual({ removed: 1 });
    expect((await list()).items).toEqual([]);

    // The retention is one of the deletion rules (code-010); the former own route is gone.
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/trash-settings', ...json({ days: 0 }) })).statusCode).toBe(404);
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/cleanup', ...json({ trashDays: -1 }) })).json()).toMatchObject({ trashDays: 0 });
    expect((await list()).days).toBe(0);
  });
});

describe('link check (links that lead nowhere, shown in the note)', () => {
  it('names the hrefs whose target is missing, like the check does', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs', 'assets'), { recursive: true });
    writeFileSync(join(wiki, 'docs', 'home.md'), '# Home\n');
    writeFileSync(join(wiki, 'docs', 'ziel.md'), '# Ziel\n');
    writeFileSync(join(wiki, 'docs', 'assets', 'da.pdf'), '%PDF');
    const { id } = await createLocalMount();
    const res = await app.server.inject({
      method: 'POST',
      url: `/api/link-check/${id}/docs/home.md`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { hrefs: ['ziel.md', 'ziel', '/docs/ziel', 'ziel.md#abschnitt', 'fehlt.md', '/docs/fehlt', 'assets/da.pdf', 'assets/weg.pdf', 'https://example.test', '#oben', '../../../etc/passwd', '.git/config'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ broken: ['fehlt.md', '/docs/fehlt', 'assets/weg.pdf', '.git/config'] });
  });
});

describe('HTML export (Phase 6)', () => {
  it('exports a note as one HTML file (images inlined, raw HTML never executed) and a folder as ZIP with rewritten links', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs', 'assets'), { recursive: true });
    mkdirSync(join(wiki, 'docs', 'unter'), { recursive: true });
    writeFileSync(join(wiki, 'docs', 'assets', 'bild.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(wiki, 'docs', 'home.md'), '---\ntitle: Startseite\n---\n# Home\n\nSiehe [Plan](unter/plan.md) und [extern](https://example.test).\n\n![Bild](assets/bild.png)\n\n<script>alert(1)</script>\n\n$a^2$\n');
    writeFileSync(join(wiki, 'docs', 'unter', 'plan.md'), '# Plan\n\nZurück zur [Startseite](../home.md#oben). Nicht mit: [env](../.env), [Skript](skript.sh).\n');
    writeFileSync(join(wiki, 'docs', '.env'), 'GEHEIM=1\n');
    writeFileSync(join(wiki, 'docs', 'unter', 'skript.sh'), 'echo hi\n');
    const { id } = await createLocalMount();
    const one = await app.server.inject({ method: 'GET', url: `/api/export/${id}/docs/home.md`, headers: { cookie } });
    expect(one.statusCode).toBe(200);
    expect(one.headers['content-type']).toContain('text/html');
    expect(one.headers['content-disposition']).toContain("filename*=UTF-8''home.html");
    expect(one.headers['content-security-policy']).toContain("default-src 'none'");
    expect(one.body).toContain('<title>Startseite</title>');
    expect(one.body).toContain('src="data:image/png;base64,iVBORw==');
    expect(one.body).not.toContain('<script>');
    expect(one.body).toContain('&#x3C;script>alert(1)&#x3C;/script>');
    expect(one.body).toContain('href="https://example.test"');
    expect((await app.server.inject({ method: 'GET', url: `/api/export/${id}/docs/home.md?inline=1`, headers: { cookie } })).headers['content-disposition']).toBeUndefined();

    const zip = await app.server.inject({ method: 'GET', url: `/api/export/${id}/docs`, headers: { cookie } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['assets/bild.png', 'home.html', 'index.html', 'unter/plan.html']);
    const home = strFromU8(files['home.html']!);
    expect(home).toContain('href="unter/plan.html"');
    expect(home).toContain('src="assets/bild.png"');
    expect(strFromU8(files['unter/plan.html']!)).toContain('href="../home.html#oben"');
    expect(strFromU8(files['index.html']!)).toContain('2 Notizen');
    expect((await app.server.inject({ method: 'GET', url: `/api/export/${id}/leer`, headers: { cookie } })).statusCode).toBe(404);

    // Markdown: the files as they are, plus what they point to; nothing outside the folder, no dotfiles or scripts.
    const md = await app.server.inject({ method: 'GET', url: `/api/export/${id}/docs?format=md`, headers: { cookie } });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toBe('application/zip');
    expect(md.headers['content-disposition']).toContain("filename*=UTF-8''docs.zip");
    const mdFiles = unzipSync(new Uint8Array(md.rawPayload));
    expect(Object.keys(mdFiles).sort()).toEqual(['assets/bild.png', 'home.md', 'unter/plan.md']);
    expect(strFromU8(mdFiles['home.md']!)).toBe(readFileSync(join(wiki, 'docs', 'home.md'), 'utf8'));
    // One note: itself and its pictures, paths relative to its folder.
    const note = await app.server.inject({ method: 'GET', url: `/api/export/${id}/docs/home.md?format=md`, headers: { cookie } });
    expect(note.headers['content-disposition']).toContain("filename*=UTF-8''home.zip");
    expect(Object.keys(unzipSync(new Uint8Array(note.rawPayload))).sort()).toEqual(['assets/bild.png', 'home.md']);
    // A note that uses no pictures or files: its .md as it is, no ZIP (owner 28.10.).
    const plain = await app.server.inject({ method: 'GET', url: `/api/export/${id}/docs/unter/plan.md?format=md`, headers: { cookie } });
    expect(plain.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(plain.headers['x-content-type-options']).toBe('nosniff');
    expect(plain.headers['content-disposition']).toContain("filename*=UTF-8''plan.md");
    expect(plain.body).toBe(readFileSync(join(wiki, 'docs', 'unter', 'plan.md'), 'utf8'));
    expect((await app.server.inject({ method: 'GET', url: `/api/export/${id}/leer?format=md`, headers: { cookie } })).statusCode).toBe(404);

    // Several marked in the tree (owner 28.10.): one ZIP from their common folder, only what was picked.
    writeFileSync(join(wiki, 'docs', 'unter', 'extra.md'), '# Extra\n');
    for (let i = 0; i < 50 && !(await app.server.inject({ method: 'GET', url: `/api/tree/${id}`, headers: { cookie } })).body.includes('extra.md'); i++) await new Promise((r) => setTimeout(r, 100));
    const exportPick = (paths: unknown, format?: string) =>
      app.server.inject({ method: 'POST', url: `/api/export-pick/${id}`, payload: JSON.stringify({ paths, format }), headers: { 'content-type': 'application/json', cookie } });
    const pick = await exportPick(['docs/unter/plan.md', 'docs/home.md'], 'md');
    expect(pick.headers['content-disposition']).toContain("filename*=UTF-8''docs.zip");
    expect(Object.keys(unzipSync(new Uint8Array(pick.rawPayload))).sort()).toEqual(['assets/bild.png', 'home.md', 'unter/plan.md']);
    const pickHtml = await exportPick(['docs/unter']);
    expect(Object.keys(unzipSync(new Uint8Array(pickHtml.rawPayload))).sort()).toEqual(['index.html', 'unter/extra.html', 'unter/plan.html']);
    expect((await exportPick(['gibt-es-nicht.md'])).statusCode).toBe(404);
    expect((await exportPick(Array.from({ length: 501 }, (_, i) => `n${i}.md`))).statusCode).toBe(400);
  });
});

describe('Markdown import (owner 28.10.)', () => {
  const imp = (id: string, body: unknown, c = cookie) =>
    app.server.inject({ method: 'POST', url: `/api/notes/${id}/import`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: c } });

  it('takes the file as it is under its own name, never over an existing note, never plain into an encrypted folder', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs'), { recursive: true });
    writeFileSync(join(wiki, 'docs', 'Rezept.md'), '# Alt\n');
    const { id } = await createLocalMount();
    const raw = '---\ntags: [kochen]\nid: 01FREMDEID\n---\n# Rezept\n\nMehl, Wasser.\n';
    const res = await imp(id, { parent: 'docs', name: 'Rezept.md', raw });
    expect(res.json()).toEqual({ path: 'docs/Rezept 2.md' });
    const written = readFileSync(join(wiki, 'docs', 'Rezept 2.md'), 'utf8');
    expect(written).toContain('tags: [kochen]');
    expect(written).toContain('Mehl, Wasser.');
    // A fresh id like a copy – a foreign one would clash with the note it came from.
    expect(written).not.toContain('01FREMDEID');
    expect(readFileSync(join(wiki, 'docs', 'Rezept.md'), 'utf8')).toBe('# Alt\n');
    expect((await imp(id, { parent: '', name: 'notiz.markdown', raw: '# N\n' })).json()).toEqual({ path: 'notiz.md' });
    expect((await imp(id, { parent: '', name: 'bild.png', raw: 'x' })).statusCode).toBe(400);
    expect((await imp(id, { parent: '', name: 'kaputt.md', raw: 'a\u0000b' })).statusCode).toBe(400);
    expect((await imp(id, { parent: '', name: 'gross.md', raw: 'x'.repeat(5 * 1024 * 1024 + 1) })).statusCode).toBe(400);
    expect((await imp(id, { parent: '../aussen', name: 'x.md', raw: '# x\n' })).statusCode).toBeGreaterThanOrEqual(400);
    await app.server.inject({ method: 'PUT', url: `/api/encrypted/${id}`, payload: JSON.stringify({ folder: 'docs', encrypted: true }), headers: { 'content-type': 'application/json', cookie } });
    expect((await imp(id, { parent: 'docs', name: 'klar.md', raw: '# klar\n' })).statusCode).toBe(403);
    // Marked as encrypted, plain text inside (audit 28.10. sec-001).
    expect((await imp(id, { parent: 'docs', name: 'falsch.md', raw: '---\nencrypted: age\n---\nGeheimer Klartext\n' })).statusCode).toBe(400);
    expect(existsSync(join(wiki, 'docs', 'falsch.md'))).toBe(false);
    expect(existsSync(join(wiki, 'docs', 'klar.md'))).toBe(false);
  });

  it('needs „schreiben“ in the folder', async () => {
    const { id } = await createLocalMount();
    const maria = await addUser('maria');
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, payload: JSON.stringify({ target: 'mount', subject: 'user', subjectId: maria.id, level: 'read' }), headers: { 'content-type': 'application/json', cookie } });
    expect((await imp(id, { parent: '', name: 'x.md', raw: '# x\n' }, maria.cookie)).statusCode).toBe(403);
  });
});

describe('import from other programs (docs/PLAN-IMPORT.md)', () => {
  const upload = (id: string, data: Uint8Array | string, query: string, c = cookie) =>
    app.server.inject({ method: 'POST', url: `/api/import/${id}/upload?${query}`, payload: Buffer.from(data), headers: { 'content-type': 'application/zip', 'x-kaveyl-wiki-upload': '1', cookie: c } });
  const post = (url: string, body: unknown, c = cookie) => app.server.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: c } });
  const fixture = () => readFileSync(join(import.meta.dirname, 'import', 'fixtures', 'hedgedoc-1.12.0.zip'));

  it('upload → preview → import into a new folder: one commit, a report, never over existing notes', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    const { id } = await createLocalMount();
    expect((await post(`/api/mounts/${id}/versions`, {})).statusCode).toBe(200);
    mkdirSync(join(wiki, 'docs', 'Import aus HedgeDoc'), { recursive: true });
    writeFileSync(join(wiki, 'docs', 'Import aus HedgeDoc', 'alt.md'), '# Alt\n');

    const res = await upload(id, fixture(), 'parent=docs&name=archive.zip');
    expect(res.statusCode).toBe(200);
    const preview = res.json() as { token: string; remote: unknown; format: string; name: string; notes: number; files: number; warnings: { text: string; items: string[] }[]; formats: { id: string }[] };
    expect(preview).toMatchObject({ format: 'hedgedoc', name: 'Import aus HedgeDoc', notes: 60, files: 0 });
    expect(preview.formats.map((f) => f.id)).toEqual(['hedgedoc', 'joplin', 'logseq', 'silverbullet', 'obsidian', 'trilium', 'wikijs', 'outline', 'markdown']);
    expect(preview.warnings.map((w) => w.text)).toContain('Folien – sie erscheinen als normaler Text');
    expect(preview.remote).toEqual({ count: 4, servers: ['127.0.0.1:8097'] });
    // The dialog offers to fetch them instead of the hint; without fetching, the report names them.
    expect(preview.warnings.map((w) => w.text)).not.toContain('Notizen mit Bildern auf dem alten Server – der Export enthält sie nicht, sie bleiben Web-Links');
    // Another format changes the preview (the dialog's choice).
    expect((await post('/api/import/preview', { token: preview.token, format: 'markdown' })).json()).toMatchObject({ format: 'markdown', detected: 'hedgedoc' });

    const run = await post('/api/import/run', { token: preview.token });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toEqual({ folder: 'docs/Import aus HedgeDoc 2', report: 'docs/Import aus HedgeDoc 2/Import-Bericht.md', notes: 60, files: 0, skipped: 0 });
    const folder = join(wiki, 'docs', 'Import aus HedgeDoc 2');
    expect(readdirSync(folder)).toHaveLength(61);
    expect(readFileSync(join(folder, 'Hinweisboxen.md'), 'utf8')).toMatch(/^---\nid: \w+\n---\n# Hinweisboxen\n> \[!TIP\]/);
    const report = readFileSync(join(folder, 'Import-Bericht.md'), 'utf8');
    expect(report).toContain('Importiert aus HedgeDoc am ');
    expect(report).toContain('- Notizen: 60');
    expect(report).toContain('### Leere Notizen – nicht übernommen (1)');
    expect(report).toContain('### Notizen mit Bildern auf dem alten Server – der Export enthält sie nicht, sie bleiben Web-Links (3)');
    expect(report).toContain('- [Jahreshauptversammlung (Folien)](Jahreshauptversammlung%20(Folien).md)');
    expect(readFileSync(join(wiki, 'docs', 'Import aus HedgeDoc', 'alt.md'), 'utf8')).toBe('# Alt\n');
    // The note is found like any other, and the import is one commit.
    expect((await app.server.inject({ method: 'GET', url: `/api/notes/${id}/docs/Import aus HedgeDoc 2/Protokoll 3.md`, headers: { cookie } })).statusCode).toBe(200);
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: wiki, encoding: 'utf8' }).trim();
    for (let i = 0; i < 50 && !sh('log', '-1', '--format=%s').includes('Import'); i++) await post(`/api/mounts/${id}/commit-now`, {}).then(() => new Promise((r) => setTimeout(r, 100)));
    expect(sh('log', '-1', '--format=%an|%s')).toBe('Admin|docs: Import aus HedgeDoc (Kaveyl Wiki)');
    expect(sh('show', '--format=', '--shortstat', 'HEAD')).toMatch(/^61 files changed/);
    // Done: the upload is gone.
    expect((await post('/api/import/run', { token: preview.token })).statusCode).toBe(400);
    expect(readdirSync(join(root, 'data', 'tmp', 'import'))).toEqual([]);
  });

  it('fetches the pictures from the old server only when asked to, names those that did not come', async () => {
    const { id } = await createLocalMount();
    const preview = (await upload(id, fixture(), 'parent=&name=archive.zip')).json() as { token: string };
    const run = await post('/api/import/run', { token: preview.token, name: 'Mit Bildern', pictures: true });
    expect(run.json()).toMatchObject({ folder: 'Mit Bildern', notes: 60, files: 3 });
    const base = join(root, 'projekte', 'wiki', 'Mit Bildern');
    expect(readdirSync(join(base, 'assets')).sort()).toEqual(['Gipfelfoto.jpg', 'Logo.svg', 'PNG.png']);
    expect(readFileSync(join(base, 'Medien.md'), 'utf8')).toContain('![PNG](assets/PNG.png)');
    const report = readFileSync(join(base, 'Import-Bericht.md'), 'utf8');
    expect(report).toContain('### Notizen mit Bildern, die sich vom alten Server nicht holen ließen – sie bleiben Web-Links (1)\n\n- [Medien](Medien.md)');
    expect(report).not.toContain('Notizen mit Bildern auf dem alten Server');
  });

  it('an import is the person\'s change even when it writes longer than the watcher waits; a write that breaks off leaves nothing', async () => {
    const { id } = await createLocalMount();
    const token = ((await app.server.inject({ method: 'POST', url: '/api/tokens', ...json({ name: 'Feed', scopes: ['read'] }) })).json() as { token: string }).token;
    const feed = async (cursor = '') =>
      (await app.server.inject({ method: 'GET', url: `/api/v1/changes?source=${id}&own=true${cursor ? `&after=${cursor}` : ''}`, headers: { authorization: `Bearer ${token}` } })).json() as {
        cursor: string;
        changes: { path: string; via: string; by: string | null }[];
      };
    const { cursor } = await feed();
    const many = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`Viele/Ordner ${i % 12}/Notiz ${i}.md`, strToU8(`# Notiz ${i}\n`)]));
    const preview = (await upload(id, zipSync(many), 'parent=&name=viele.zip')).json() as { token: string };
    expect((await post('/api/import/run', { token: preview.token })).json()).toMatchObject({ folder: 'Viele', notes: 1200 });
    await new Promise((r) => setTimeout(r, 1500)); // the watcher's events of the import have arrived
    const after = await feed(cursor);
    expect(after.changes.length).toBe(1201);
    expect(after.changes.filter((c) => c.via !== 'app' || c.by !== 'Admin')).toEqual([]);

    // A file whose size the ZIP states wrongly is read only while writing: the new folder goes again, a clean message.
    const broken = zipSync({ 'W/a.md': strToU8('# A\n'), 'W/b.md': strToU8('# B\n'), 'W/z.png': [new Uint8Array(4000).fill(7), { level: 0 }] });
    const dv = new DataView(broken.buffer, broken.byteOffset);
    let cd = broken.length - 4;
    while (dv.getUint32(cd, true) !== 0x02014b50) cd--; // the last central directory entry: W/z.png
    dv.setUint32(cd + 24, 10, true);
    const bad = (await upload(id, broken, 'parent=&name=w.zip')).json() as { token: string };
    const res = await post('/api/import/run', { token: bad.token });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Der Import brach beim Schreiben ab (beschädigte Datei im ZIP?) – es wurde nichts übernommen' });
    expect(existsSync(join(root, 'projekte', 'wiki', 'W'))).toBe(false);
  });

  it('a report in English for English accounts; a Markdown folder keeps its structure and pictures', async () => {
    const { id } = await createLocalMount();
    const zip = zipSync({ 'Vereinswiki/Start.md': strToU8('# Start\n![](bilder/a.png) [[Seite]]\n'), 'Vereinswiki/sub/Seite.md': strToU8('# Seite\n'), 'Vereinswiki/bilder/a.png': new Uint8Array([137, 80, 78, 71]) });
    const preview = (await upload(id, zip, 'parent=&name=x.zip')).json() as { token: string; name: string; format: string };
    expect(preview).toMatchObject({ format: 'markdown', name: 'Vereinswiki' });
    const run = await app.server.inject({ method: 'POST', url: '/api/import/run', payload: JSON.stringify({ token: preview.token, name: 'Unser Wiki' }), headers: { 'content-type': 'application/json', cookie, 'x-kaveyl-wiki-lang': 'en' } });
    expect(run.json()).toMatchObject({ folder: 'Unser Wiki', notes: 2, files: 1 });
    const base = join(root, 'projekte', 'wiki', 'Unser Wiki');
    expect(readFileSync(join(base, 'Start.md'), 'utf8')).toContain('![](bilder/a.png) [Seite](sub/Seite.md)');
    expect(existsSync(join(base, 'bilder', 'a.png'))).toBe(true);
    const report = readFileSync(join(base, 'Import-Bericht.md'), 'utf8');
    expect(report).toContain('# Import report');
    expect(report).toContain('Imported from Markdown folder on ');
    expect(report).toContain('Everything came over – no notes.');
  });

  it('who may: write access, no guests, not into encrypted folders; no ZIP, too big and foreign tokens are refused', async () => {
    const { id } = await createLocalMount();
    const maria = await addUser('maria');
    const gast = await addUser('gast');
    app.db.prepare('UPDATE users SET is_guest = 1 WHERE id = ?').run(gast.id);
    await post(`/api/acl/${id}`, { target: 'mount', subject: 'user', subjectId: maria.id, level: 'read' });
    expect((await upload(id, fixture(), 'parent=', maria.cookie)).statusCode).toBe(403);
    // A rule left on a folder name (the folder itself is gone) applies to an import of that name too.
    await post(`/api/acl/${id}`, { target: 'mount', subject: 'user', subjectId: maria.id, level: 'write' });
    await post(`/api/acl/${id}`, { target: 'folder', path: 'Archiv', subject: 'user', subjectId: maria.id, level: 'read' });
    const toArchive = (await upload(id, fixture(), 'parent=&name=archive.zip', maria.cookie)).json() as { token: string };
    expect((await post('/api/import/run', { token: toArchive.token, name: 'Archiv' }, maria.cookie)).statusCode).toBe(403);
    expect(existsSync(join(root, 'projekte', 'wiki', 'Archiv'))).toBe(false);
    expect((await post('/api/import/run', { token: toArchive.token, name: 'Archiv neu' }, maria.cookie)).json()).toMatchObject({ folder: 'Archiv neu' });
    expect((await upload(id, fixture(), 'parent=', gast.cookie)).statusCode).toBe(403);
    expect((await upload(id, fixture(), 'parent=../aussen')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(id, 'kein zip', 'parent=')).json()).toEqual({ error: 'Die Datei ist kein lesbares ZIP-Archiv' });
    expect((await upload(id, zipSync({ 'a.png': new Uint8Array([1]) }), 'parent=')).statusCode).toBe(400);
    await post(`/api/encrypted/${id}`, {});
    await app.server.inject({ method: 'PUT', url: `/api/encrypted/${id}`, ...json({ folder: 'docs', encrypted: true }) });
    expect((await upload(id, fixture(), 'parent=docs')).statusCode).toBe(403);
    // Someone else's upload cannot be imported or cancelled.
    const own = (await upload(id, fixture(), 'parent=')).json() as { token: string };
    const admin2 = await addUser('zweite', { isAdmin: true });
    expect((await post('/api/import/run', { token: own.token }, admin2.cookie)).statusCode).toBe(400);
    const cancel = (c: string) => app.server.inject({ method: 'DELETE', url: `/api/import/${own.token}`, payload: '{}', headers: { 'content-type': 'application/json', cookie: c } });
    expect((await cancel(admin2.cookie)).statusCode).toBe(400);
    expect((await cancel(cookie)).json()).toEqual({ ok: true });
    const { IMPORT_LIMITS } = await import('./import/zip.js');
    const before = IMPORT_LIMITS.upload;
    IMPORT_LIMITS.upload = 1000;
    try {
      const big = await upload(id, fixture(), 'parent=');
      expect(big.statusCode).toBe(413);
      expect(big.json()).toEqual({ error: 'Die Datei ist größer als 500 MB' });
    } finally {
      IMPORT_LIMITS.upload = before;
    }
    expect(readdirSync(join(root, 'data', 'tmp', 'import'))).toEqual([]);
  });
});

describe('encrypted notes and folders (PLAN §3d)', () => {
  const ARMOR = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNjcnlwdCBhYmMgMTgK\n-----END AGE ENCRYPTED FILE-----\n';
  it('only accepts age blocks, creates new notes encrypted, keeps plaintext out', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    writeFileSync(join(wiki, 'offen.md'), '# Offen\n\nKlartext.\n');
    const { id } = await createLocalMount();
    const get = async (p: string) => (await app.server.inject({ method: 'GET', url: `/api/notes/${id}/${p}`, headers: { cookie } })).json() as { hash: string; raw: string };
    const put = async (p: string, body: Record<string, unknown>) => app.server.inject({ method: 'PUT', url: `/api/notes/${id}/${p}`, ...json({ baseHash: (await get(p)).hash, ...body }) });

    // A single note: encrypted body is accepted, plaintext afterwards only with allowPlain.
    const enc = `---\ntitle: Offen\nencrypted: age\n---\n${ARMOR}`;
    expect((await put('offen.md', { raw: enc })).statusCode).toBe(200);
    expect((await put('offen.md', { raw: '---\ntitle: Offen\nencrypted: age\n---\nKlartext!\n' })).statusCode).toBe(400);
    expect((await put('offen.md', { raw: '# Offen\n\nKlartext.\n' })).statusCode).toBe(403);
    expect((await put('offen.md', { doc: { type: 'doc', content: [] } })).statusCode).toBe(403);
    // The index knows the title, not the body.
    const hits = (await app.server.inject({ method: 'GET', url: '/api/search/full?q=YWdl', headers: { cookie } })).json() as { hits: unknown[] };
    expect(hits.hits).toHaveLength(0);
    expect((await put('offen.md', { raw: '# Offen\n\nWieder lesbar.\n', allowPlain: true })).statusCode).toBe(200);

    // A folder: marked in .kaveyl-wiki.yml; new notes start encrypted and empty; plain ones may not move in.
    expect((await app.server.inject({ method: 'PUT', url: `/api/encrypted/${id}`, ...json({ folder: 'docs', encrypted: true }) })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: `/api/encrypted/${id}`, headers: { cookie } })).json()).toEqual(['docs']);
    expect(readFileSync(join(wiki, 'docs', '.kaveyl-wiki.yml'), 'utf8')).toBe('encrypted: age\n');
    const created = (await app.server.inject({ method: 'POST', url: `/api/notes/${id}`, ...json({ parent: 'docs', title: 'Geheim' }) })).json() as { path: string };
    // No title in plain text (AD-048): only the file name says what it is.
    expect(created.path).toBe('docs/Geheim.md');
    expect(readFileSync(join(wiki, created.path), 'utf8')).toMatch(/^---\nencrypted: age\n(id: .+\n)?---\n$/);
    expect((await put('docs/home.md', { raw: '# Home\n\nneu\n' })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'POST', url: `/api/notes/${id}/move`, ...json({ from: 'offen.md', to: 'docs/offen.md' }) })).statusCode).toBe(403);

    // Removing an attachment file (only in assets/).
    mkdirSync(join(wiki, 'docs', 'assets'), { recursive: true });
    writeFileSync(join(wiki, 'docs', 'assets', 'bild.png'), 'x');
    writeFileSync(join(wiki, 'docs', 'assets', 'zwei.png'), 'x');
    expect((await app.server.inject({ method: 'DELETE', url: `/api/attachments/${id}/docs/home.md`, ...json({}) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/attachments/${id}/docs/assets/bild.png`, ...json({}) })).statusCode).toBe(200);
    expect(existsSync(join(wiki, 'docs', 'assets', 'bild.png'))).toBe(false);
    // The last file takes the then empty assets/ folder with it.
    expect(existsSync(join(wiki, 'docs', 'assets'))).toBe(true);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/attachments/${id}/docs/assets/zwei.png`, ...json({}) })).statusCode).toBe(200);
    expect(existsSync(join(wiki, 'docs', 'assets'))).toBe(false);
    await app.server.inject({ method: 'PUT', url: `/api/encrypted/${id}`, ...json({ folder: 'docs', encrypted: false }) });
    expect(existsSync(join(wiki, 'docs', '.kaveyl-wiki.yml'))).toBe(false);
  });
});

describe('Cloudflare Access (off by default)', () => {
  it('signs in a known user with a valid Access token once enabled', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await app.close();
    const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
    app = await buildApp(config, { logger: false, nightlyFsck: false, cloudflareJwks: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k' }] }) });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', kid: 'k' });
    const body = b64({ aud: ['a'.repeat(32)], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 300, email: 'maria@example.test' });
    const jwt = `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
    await app.server.inject({ method: 'POST', url: '/api/admin/users', ...json({ username: 'maria', email: 'Maria@example.test', password: userPw('maria') }) });
    const session = () => app.server.inject({ method: 'GET', url: '/api/session', headers: { 'cf-access-jwt-assertion': jwt } });
    // Off: the header is ignored.
    expect((await session()).json().user).toBeNull();
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/cloudflare', ...json({ enabled: true, teamDomain: 'x', aud: 'y' }) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/cloudflare', ...json({ enabled: true, teamDomain: 'https://team.cloudflareaccess.com', aud: 'a'.repeat(32) }) })).statusCode).toBe(200);
    const res = await session();
    expect(res.json().user.username).toBe('maria');
    expect(res.cookies.find((c) => c.name === 'kw_session')).toBeTruthy();
    // A forged token is not enough.
    expect((await app.server.inject({ method: 'GET', url: '/api/session', headers: { 'cf-access-jwt-assertion': `${head}.${body}.AAAA` } })).json().user).toBeNull();
    // „Abmelden“ sends the browser to Cloudflare's own sign-out – else the next request signs in again (review 21.10.).
    const cookie = res.cookies.find((c) => c.name === 'kw_session')!;
    const out = await app.server.inject({ method: 'POST', url: '/api/logout', payload: '{}', headers: { 'content-type': 'application/json', cookie: `kw_session=${cookie.value}`, 'cf-access-jwt-assertion': jwt } });
    expect(out.json()).toEqual({ ok: true, redirect: '/cdn-cgi/access/logout' });
    // Without the Access token (e.g. in the own network directly) a plain sign-out.
    const direct = (await session()).cookies.find((c) => c.name === 'kw_session')!;
    expect((await app.server.inject({ method: 'POST', url: '/api/logout', payload: '{}', headers: { 'content-type': 'application/json', cookie: `kw_session=${direct.value}` } })).json()).toEqual({ ok: true });
  });
});

describe('templates', () => {
  it('lists templates, creates notes from them with variables and a fresh id, saves notes as templates', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, '.kaveyl-wiki', 'templates'), { recursive: true });
    writeFileSync(join(wiki, '.kaveyl-wiki', 'templates', 'meeting.md'), '---\nid: ALT\ntags: meeting\n---\n# {{title}} am {{date}}\n\nVon {{user}}. {{unbekannt}}\n');
    const { id } = await createLocalMount();
    expect((await app.server.inject({ method: 'GET', url: `/api/templates/${id}`, headers: { cookie } })).json()).toEqual([{ name: 'meeting.md', title: 'meeting' }]);
    const res = await app.server.inject({ method: 'POST', url: `/api/notes/${id}`, ...json({ parent: 'docs', title: 'Kickoff', template: 'meeting.md' }) });
    expect(res.statusCode).toBe(200);
    const raw = readFileSync(join(wiki, 'docs', 'Kickoff.md'), 'utf8');
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(raw).toMatch(new RegExp(`^---\\nid: (?!ALT)\\w+\\ntags: meeting\\n---\\n# Kickoff am ${date}\\n\\nVon Admin\\. \\{\\{unbekannt\\}\\}\\n$`));
    expect((await app.server.inject({ method: 'POST', url: `/api/notes/${id}`, ...json({ parent: '', title: 'x', template: '../geheim.md' }) })).statusCode).toBe(400);
    const saved = await app.server.inject({ method: 'POST', url: `/api/templates/${id}`, ...json({ from: 'docs/Kickoff.md', title: 'Protokoll' }) });
    expect(saved.json()).toEqual({ name: 'Protokoll.md', title: 'Protokoll' });
    expect(readFileSync(join(wiki, '.kaveyl-wiki', 'templates', 'Protokoll.md'), 'utf8')).not.toContain('id:');
    // Templates are not notes: they never show up in the tree.
    const tree = (await app.server.inject({ method: 'GET', url: `/api/tree/${id}`, headers: { cookie } })).json() as { path: string }[];
    expect(tree.some((e) => e.path.includes('.kaveyl-wiki'))).toBe(false);
  });
});

describe('tags', () => {
  it('sets tags in the file style, lists all tags with counts, keeps the body', async () => {
    const wiki = join(root, 'projekte', 'wiki', 'docs');
    writeFileSync(join(wiki, 'liste.md'), '---\ntitle: L\ntags:\n  - alt\n---\n# L\n\nText bleibt.\n');
    writeFileSync(join(wiki, 'wikijs.md'), '---\ntags: pkm, wiki\n---\n# W\n');
    const { id } = await createLocalMount();
    const hash = async (p: string) => ((await app.server.inject({ method: 'GET', url: `/api/notes/${id}/${p}`, headers: { cookie } })).json() as { hash: string }).hash;
    const set = async (p: string, body: Record<string, unknown>) =>
      app.server.inject({ method: 'PUT', url: `/api/meta/${id}/${p}`, ...json({ ...body, baseHash: await hash(p) }) });
    expect((await set('docs/liste.md', { tags: ['alt', 'neu Tag'] })).statusCode).toBe(200);
    expect(readFileSync(join(wiki, 'liste.md'), 'utf8')).toBe('---\ntitle: L\ntags: [alt, neu Tag]\n---\n# L\n\nText bleibt.\n');
    await set('docs/wikijs.md', { tags: ['pkm', 'wiki', '#projekt'], icon: 'emoji:📘' });
    expect(readFileSync(join(wiki, 'wikijs.md'), 'utf8')).toBe('---\ntags: pkm, wiki, projekt\nicon: emoji:📘\n---\n# W\n');
    await set('docs/wikijs.md', { tags: [], icon: null, readonly: true });
    expect(readFileSync(join(wiki, 'wikijs.md'), 'utf8')).toBe('---\nreadonly: true\n---\n# W\n');
    await set('docs/wikijs.md', { readonly: false });
    expect(readFileSync(join(wiki, 'wikijs.md'), 'utf8')).toBe('# W\n'); // the last key gone: no empty block
    const stale = await app.server.inject({ method: 'PUT', url: `/api/meta/${id}/docs/liste.md`, ...json({ tags: ['x'], baseHash: 'alt' }) });
    expect(stale.statusCode).toBe(409);
    await expect
      .poll(async () => (await app.server.inject({ method: 'GET', url: '/api/tags', headers: { cookie } })).json(), { timeout: 5000 })
      .toEqual([
        { tag: 'alt', count: 1, color: null, mixed: false },
        { tag: 'neu Tag', count: 1, color: null, mixed: false },
      ]);
  });
});

describe('tag colors and renaming (AD-040)', () => {
  it('colors a tag in the .kaveyl-wiki.yml of its source, renames and merges tags in the notes, follows the rights', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    writeFileSync(join(wiki, '.kaveyl-wiki.yml'), '# eigene Einstellungen\norder:\n  - docs\n');
    writeFileSync(join(wiki, 'docs', 'a.md'), '---\ntags: Rechnung, büro\n---\n# A\n');
    writeFileSync(join(wiki, 'docs', 'b.md'), '---\ntags:\n  - rechnung\n  - belege\n---\n# B\n');
    const { id } = await createLocalMount();
    const get = async (url: string, c = cookie) => (await app.server.inject({ method: 'GET', url, headers: { cookie: c } })).json();
    await expect.poll(async () => ((await get('/api/tags')) as { tag: string }[]).length, { timeout: 5000 }).toBe(3);

    const color = (body: object, c = cookie) => app.server.inject({ method: 'PUT', url: '/api/tags/color', payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: c } });
    expect((await color({ tag: 'rechnung', color: '#ff0000' })).statusCode).toBe(400);
    expect((await color({ tag: '#Rechnung', color: 'red' })).json()).toEqual({ saved: ['Wiki'], skipped: [] });
    // Other keys and comments of the file stay.
    expect(readFileSync(join(wiki, '.kaveyl-wiki.yml'), 'utf8')).toBe('# eigene Einstellungen\norder:\n  - docs\ntagColors:\n  rechnung: red\n');
    expect(await get('/api/tag-colors')).toEqual({ [id]: { rechnung: 'red' } });
    expect((await get('/api/tags')) as unknown[]).toContainEqual({ tag: 'Rechnung', count: 2, color: 'red', mixed: false });

    // Read-only users see the colors but cannot change them.
    await addUser('maria');
    const users = (await get('/api/admin/users')) as { id: string; username: string }[];
    await app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json({ target: 'mount', subject: 'user', subjectId: users.find((u) => u.username === 'maria')!.id, level: 'read' }) });
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    expect(await get('/api/tag-colors', maria)).toEqual({ [id]: { rechnung: 'red' } });
    expect((await color({ tag: 'rechnung', color: 'blue' }, maria)).json()).toEqual({ saved: [], skipped: ['Wiki'] });
    const asMaria = await app.server.inject({ method: 'POST', url: '/api/tags/rename', payload: JSON.stringify({ from: 'rechnung', to: 'x' }), headers: { 'content-type': 'application/json', cookie: maria } });
    expect(asMaria.json()).toEqual({ notes: 0, skipped: 2, sources: [] });

    // Rename into an existing tag: merged; the file keeps its style; the color moves along.
    const renamed = await app.server.inject({ method: 'POST', url: '/api/tags/rename', ...json({ from: 'rechnung', to: 'Belege' }) });
    expect(renamed.json()).toEqual({ notes: 2, skipped: 0, sources: ['Wiki'] });
    expect(readFileSync(join(wiki, 'docs', 'a.md'), 'utf8')).toBe('---\ntags: Belege, büro\n---\n# A\n');
    expect(readFileSync(join(wiki, 'docs', 'b.md'), 'utf8')).toBe('---\ntags: [Belege]\n---\n# B\n');
    expect(await get('/api/tag-colors')).toEqual({ [id]: { belege: 'red' } });
    await expect.poll(async () => ((await get('/api/tags')) as { tag: string; count: number }[]).find((t) => t.tag.toLowerCase() === 'belege')?.count, { timeout: 5000 }).toBe(2);

    // No color left → the key goes; the rest of the file stays.
    expect((await color({ tag: 'belege', color: null })).json()).toEqual({ saved: ['Wiki'], skipped: [] });
    expect(readFileSync(join(wiki, '.kaveyl-wiki.yml'), 'utf8')).toBe('# eigene Einstellungen\norder:\n  - docs\n');
  });
});

describe('search page', () => {
  it('filters by tag, path, mount and exclusion', async () => {
    const wiki = join(root, 'projekte', 'wiki', 'docs');
    writeFileSync(join(wiki, 'a.md'), '---\ntags: [projekt, alt]\n---\n# Alpha\n\nGemeinsamer Begriff Zebra.\n');
    writeFileSync(join(wiki, 'b.md'), '---\ntags: projekt\n---\n# Beta\n\nGemeinsamer Begriff ohne Tier.\n');
    mkdirSync(join(wiki, 'sub'));
    writeFileSync(join(wiki, 'sub', 'c.md'), '# Gamma\n\nGemeinsamer Begriff Zebra im Unterordner.\n');
    await createLocalMount();
    const find = async (q: string) =>
      ((await app.server.inject({ method: 'GET', url: `/api/search/full?q=${encodeURIComponent(q)}`, headers: { cookie } })).json() as { hits: { path: string; snippet?: string }[] }).hits
        .map((h) => h.path)
        .sort();
    await expect.poll(() => find('Gemeinsamer'), { timeout: 5000 }).toEqual(['docs/a.md', 'docs/b.md', 'docs/sub/c.md']);
    expect(await find('Gemeinsamer -zebra')).toEqual(['docs/b.md']);
    expect(await find('"Begriff Zebra"')).toEqual(['docs/a.md', 'docs/sub/c.md']);
    expect(await find('tag:projekt')).toEqual(['docs/a.md', 'docs/b.md']);
    expect(await find('tag:projekt tag:alt')).toEqual(['docs/a.md']);
    expect(await find('zebra path:docs/sub')).toEqual(['docs/sub/c.md']);
    expect(await find('zebra in:wiki')).toEqual(['docs/a.md', 'docs/sub/c.md']);
    expect(await find('zebra in:gibtsnicht')).toEqual([]);
    expect(await find('seit:1d tag:projekt')).toEqual(['docs/a.md', 'docs/b.md']);
  });
});

describe('attachments', () => {
  it('serves images but never dotfiles or source files', async () => {
    const dir = join(root, 'projekte', 'wiki');
    writeFileSync(join(dir, 'docs', 'bild.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'config.ts'), 'export {}');
    const { id } = await createLocalMount();
    const img = await app.server.inject({ method: 'GET', url: `/api/files/${id}/docs/bild.png`, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    for (const p of ['.env', 'config.ts', 'docs/home.md']) {
      expect((await app.server.inject({ method: 'GET', url: `/api/files/${id}/${p}`, headers: { cookie } })).statusCode).toBe(404);
    }
    // An extension named like an Object property is no known type: a plain download.
    mkdirSync(join(dir, 'docs', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'assets', 'x.constructor'), 'x');
    const odd = await app.server.inject({ method: 'GET', url: `/api/files/${id}/docs/assets/x.constructor`, headers: { cookie } });
    expect(odd.statusCode).toBe(200);
    expect(odd.headers['content-type']).toBe('application/octet-stream');
    expect(odd.headers['content-disposition']).toMatch(/^attachment;/);
  });
});

describe('attachments', () => {
  const upload = (id: string, note: string, name: string, data: Buffer, extra: Record<string, string> = {}) =>
    app.server.inject({
      method: 'POST',
      url: `/api/attachments/${id}?note=${encodeURIComponent(note)}&name=${encodeURIComponent(name)}`,
      headers: { cookie, 'content-type': 'application/octet-stream', 'x-kaveyl-wiki-upload': '1', ...extra },
      payload: data,
    });

  it('replaces an attachment in place (edited drawing): only existing files in assets/', async () => {
    const { id } = await createLocalMount();
    const first = (await upload(id, 'docs/home.md', 'skizze.excalidraw.svg', Buffer.from('<svg>v1</svg>'))).json() as { path: string };
    expect(first.path).toBe('docs/assets/skizze.excalidraw.svg');
    const replace = (rel: string, body: string) =>
      app.server.inject({
        method: 'POST',
        url: `/api/attachments/${id}?${new URLSearchParams({ note: 'docs/home.md', name: 'x.svg', replace: rel })}`,
        payload: Buffer.from(body),
        headers: { 'content-type': 'application/octet-stream', 'x-kaveyl-wiki-upload': '1', cookie },
      });
    expect((await replace(first.path, '<svg>v2</svg>')).json()).toMatchObject({ path: 'docs/assets/skizze.excalidraw.svg', href: 'assets/skizze.excalidraw.svg' });
    expect(readFileSync(join(root, 'projekte/wiki/docs/assets/skizze.excalidraw.svg'), 'utf8')).toBe('<svg>v2</svg>');
    expect((await replace('docs/home.md', '# weg')).statusCode).toBe(400);
    expect((await replace('docs/assets/fehlt.svg', '<svg/>')).statusCode).toBe(400);
  });

  it('stores files in assets/ next to the note with clean, unique names', async () => {
    const { id } = await createLocalMount();
    const a = await upload(id, 'docs/home.md', 'Mein Angebot (v2).PDF', Buffer.from('%PDF-1.4 x'));
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ path: 'docs/assets/Mein-Angebot-v2.pdf', href: 'assets/Mein-Angebot-v2.pdf', image: false });
    const b = await upload(id, 'docs/home.md', 'Mein Angebot (v2).pdf', Buffer.from('%PDF-1.4 y'));
    expect(b.json()).toMatchObject({ path: 'docs/assets/Mein-Angebot-v2-2.pdf' });
    // A second drawing of the same name keeps its double extension (still a drawing).
    await upload(id, 'docs/home.md', 'zeichnung.excalidraw.svg', Buffer.from('<svg>1</svg>'));
    expect((await upload(id, 'docs/home.md', 'zeichnung.excalidraw.svg', Buffer.from('<svg>2</svg>'))).json()).toMatchObject({ path: 'docs/assets/zeichnung-2.excalidraw.svg' });
    const img = await upload(id, 'docs/home.md', 'Foto Übersicht.png', Buffer.from([0x89, 0x50]));
    expect(img.json()).toMatchObject({ href: `assets/${encodeURI('Foto-Übersicht.png')}`, image: true });
    expect(readFileSync(join(root, 'projekte', 'wiki', 'docs', 'assets', 'Mein-Angebot-v2.pdf'), 'utf8')).toBe('%PDF-1.4 x');

    // Linked from the note → listed; other files under assets/ are served as download only.
    writeFileSync(join(root, 'projekte', 'wiki', 'docs', 'home.md'), '# Home\n\n[Angebot](assets/Mein-Angebot-v2.pdf) ![](assets/Foto-%C3%9Cbersicht.png) [weg](assets/fehlt.zip)\n');
    const list = await app.server.inject({ method: 'GET', url: `/api/attachments/${id}/docs/home.md`, headers: { cookie } });
    expect(list.json()).toEqual([
      { path: 'docs/assets/Mein-Angebot-v2.pdf', name: 'Mein-Angebot-v2.pdf', size: 10, kind: 'pdf' },
      { path: 'docs/assets/Foto-Übersicht.png', name: 'Foto-Übersicht.png', size: 2, kind: 'image' },
      { path: 'docs/assets/fehlt.zip', name: 'fehlt.zip', size: null, kind: 'file' },
    ]);
    writeFileSync(join(root, 'projekte', 'wiki', 'docs', 'assets', 'daten.zip'), 'PK');
    const zip = await app.server.inject({ method: 'GET', url: `/api/files/${id}/docs/assets/daten.zip`, headers: { cookie } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/octet-stream');
    expect(zip.headers['content-disposition']).toContain('attachment');
    const pdf = await app.server.inject({ method: 'GET', url: `/api/files/${id}/docs/assets/Mein-Angebot-v2.pdf?download=1`, headers: { cookie } });
    expect(pdf.headers['content-disposition']).toContain("filename*=UTF-8''Mein-Angebot-v2.pdf");
  });

  it('rejects executables, Markdown, oversize files and uploads without the upload header', async () => {
    const { id } = await createLocalMount();
    expect((await upload(id, 'docs/home.md', 'setup.exe', Buffer.from('MZ'))).statusCode).toBe(400);
    expect((await upload(id, 'docs/home.md', 'notiz.md', Buffer.from('# x'))).statusCode).toBe(400);
    expect((await upload(id, 'docs/fehlt.md', 'a.pdf', Buffer.from('x'))).statusCode).toBe(400);
    const noHeader = await app.server.inject({
      method: 'POST',
      url: `/api/attachments/${id}?note=docs/home.md&name=a.pdf`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(noHeader.statusCode).toBe(415);
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/attachments', ...json({ maxMb: 1 }) })).json()).toMatchObject({ maxMb: 1, imageMaxPx: 2400 });
    // Scaling large images on upload (owner 2026-10-11): 0 = originals, else 800–8000 px; readable for every uploader.
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/attachments', ...json({ imageMaxPx: 500 }) })).statusCode).toBe(400);
    expect((await app.server.inject({ method: 'PUT', url: '/api/admin/attachments', ...json({ imageMaxPx: 0 }) })).json()).toMatchObject({ maxMb: 1, imageMaxPx: 0 });
    expect((await app.server.inject({ method: 'GET', url: '/api/attachment-settings', headers: { cookie } })).json()).toEqual({ maxMb: 1, imageMaxPx: 0 });
    await app.server.inject({ method: 'PUT', url: '/api/admin/attachments', ...json({ imageMaxPx: 2400 }) });
    const big = await upload(id, 'docs/home.md', 'gross.bin', Buffer.alloc(1024 * 1024 + 1));
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toContain('1 MB');
  });

  it('blocked file endings are a list the admin edits – prefilled with the executables (owner 25.10.)', async () => {
    const { id } = await createLocalMount();
    const settingsNow = (await app.server.inject({ method: 'GET', url: '/api/admin/attachments', headers: { cookie } })).json() as { blocked: string[]; blockedDefault: string[] };
    expect(settingsNow.blocked).toEqual(settingsNow.blockedDefault);
    expect(settingsNow.blocked).toContain('exe');
    expect((await upload(id, 'docs/home.md', 'setup.exe', Buffer.from('MZ'))).json().error).toContain('Einstellungen → Anhänge');
    // An IT team allows installers, blocks something else instead; written as people type it.
    const put = (blocked: unknown) => app.server.inject({ method: 'PUT', url: '/api/admin/attachments', ...json({ blocked }) });
    expect((await put('.BAT, ps1; *.zip md')).json()).toMatchObject({ blocked: ['bat', 'ps1', 'zip'] });
    expect((await upload(id, 'docs/home.md', 'setup.exe', Buffer.from('MZ'))).statusCode).toBe(200);
    expect((await upload(id, 'docs/home.md', 'paket.zip', Buffer.from('PK'))).statusCode).toBe(400);
    expect((await put(['ex e'])).statusCode).toBe(400);
    // An empty list blocks nothing.
    expect((await put([])).json()).toMatchObject({ blocked: [] });
    expect((await upload(id, 'docs/home.md', 'start.bat', Buffer.from('@echo'))).statusCode).toBe(200);
    await put(settingsNow.blockedDefault);
  });

  it('the default list also blocks scripts, packages and disk images (owner 26.10., sec-005); a saved list stays as it was', async () => {
    const { id } = await createLocalMount();
    const view = async () => (await app.server.inject({ method: 'GET', url: '/api/admin/attachments', headers: { cookie } })).json() as { blocked: string[]; blockedDefault: string[] };
    const added = ['js', 'jse', 'msix', 'appx', 'iso', 'img', 'chm', 'url', 'sh', 'command'];
    expect((await view()).blocked).toEqual(expect.arrayContaining(added));
    for (const name of ['Rechnung.js', 'Update.iso', 'Hilfe.chm', 'Link.url', 'install.sh', 'start.command']) expect((await upload(id, 'docs/home.md', name, Buffer.from('x'))).statusCode).toBe(400);
    // An instance whose admin saved the list before (here: the earlier default) keeps it; „Standardliste“ offers the new one.
    const earlier = (await view()).blocked.filter((e) => !added.includes(e));
    await app.server.inject({ method: 'PUT', url: '/api/admin/attachments', ...json({ blocked: earlier }) });
    const kept = await view();
    expect(kept.blocked).toEqual(earlier);
    expect(kept.blockedDefault).toEqual(expect.arrayContaining(added));
    expect((await upload(id, 'docs/home.md', 'Rechnung.js', Buffer.from('x'))).statusCode).toBe(200);
    await app.server.inject({ method: 'PUT', url: '/api/admin/attachments', ...json({ blocked: kept.blockedDefault }) });
  });

  it('reports attachments no note links to any more', async () => {
    const { id } = await createLocalMount();
    await upload(id, 'docs/home.md', 'verwaist.pdf', Buffer.from('x'));
    writeFileSync(join(root, 'projekte', 'wiki', 'docs', 'assets', 'genutzt.png'), 'x');
    writeFileSync(join(root, 'projekte', 'wiki', 'docs', 'assets', 'breit.png'), 'x');
    writeFileSync(join(root, 'projekte', 'wiki', 'docs', 'assets', 'fehlt-nicht.svg'), 'x');
    // A resized image is saved as <img width>: it counts as used, too (inside code it does not).
    writeFileSync(
      join(root, 'projekte', 'wiki', 'docs', 'home.md'),
      '# Home\n\n![](assets/genutzt.png)\n\n<img src="assets/breit.png" width="300">\n\n`<img src="assets/fehlt-nicht.svg">`\n',
    );
    // The external edit reaches the link index through the watcher.
    const orphans = async () => {
      const res = await app.server.inject({ method: 'POST', url: '/api/admin/fsck', ...json({}) });
      const issues = (res.json() as { mounts: { issues: { kind: string; path: string }[] }[] }).mounts[0]!.issues;
      return issues.filter((i) => i.kind === 'orphaned-attachment').map((i) => i.path);
    };
    await expect.poll(orphans, { timeout: 5000 }).toEqual(['docs/assets/fehlt-nicht.svg', 'docs/assets/verwaist.pdf']);
  });

  it('encrypted notes: only encrypted uploads, files listed from disk, shared files kept, fsck knows .age files', async () => {
    const { id } = await createLocalMount();
    const docs = join(root, 'projekte', 'wiki', 'docs');
    const AGE = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n';
    mkdirSync(join(docs, 'tresor', 'assets'), { recursive: true });
    writeFileSync(join(docs, 'tresor', '.kaveyl-wiki.yml'), 'encrypted: age\n');
    writeFileSync(join(docs, 'tresor', 'zu.md'), `---\nencrypted: age\nattachments:\n  - assets/b.png.age\n---\n${AGE}`);
    writeFileSync(join(docs, 'tresor', 'assets', 'b.png.age'), 'age-encryption.org/v1\n');
    writeFileSync(join(docs, 'tresor', 'offen.md'), '# Offen\n\nliegt im Klartext hier\n');
    // Plain bytes into an encrypted note are refused; an age file is taken.
    expect((await upload(id, 'docs/tresor/zu.md', 'klar.png', Buffer.from('png'))).statusCode).toBe(403);
    expect((await upload(id, 'docs/tresor/zu.md', 'c.png.age', Buffer.from('age-encryption.org/v1\n-> x\n'))).statusCode).toBe(200);
    // The folder as it is on disk.
    const listed = await app.server.inject({ method: 'GET', url: `/api/encrypted/${id}/notes?folder=docs/tresor`, headers: { cookie } });
    expect(listed.json()).toEqual([
      { path: 'docs/tresor/offen.md', encrypted: false, empty: false },
      { path: 'docs/tresor/zu.md', encrypted: true, empty: false },
    ]);
    // Consistency check: the listed .age file is in use; the plain note in the encrypted folder is reported.
    const issues = async () => {
      const res = await app.server.inject({ method: 'POST', url: '/api/admin/fsck', ...json({}) });
      return (res.json() as { mounts: { issues: { kind: string; path: string }[] }[] }).mounts[0]!.issues.map((i) => `${i.kind} ${i.path}`);
    };
    await expect.poll(issues, { timeout: 5000 }).toContain('plain-in-encrypted docs/tresor/offen.md');
    await expect.poll(async () => (await issues()).includes('orphaned-attachment docs/tresor/assets/b.png.age'), { timeout: 5000 }).toBe(false);
    // A file another note still links to stays when the note that replaced it asks to remove it.
    mkdirSync(join(docs, 'assets'), { recursive: true });
    writeFileSync(join(docs, 'assets', 'geteilt.png'), 'x');
    writeFileSync(join(docs, 'home.md'), '# Home\n\n![](assets/geteilt.png)\n');
    await expect.poll(async () => (await issues()).includes('orphaned-attachment docs/assets/geteilt.png'), { timeout: 5000 }).toBe(false);
    const del = (by: string) => app.server.inject({ method: 'DELETE', url: `/api/attachments/${id}/docs/assets/geteilt.png?unlessLinkedBy=${by}`, ...json({}) });
    const kept = await del('docs/andere.md');
    expect(kept.json()).toEqual({ ok: true, kept: true });
    expect(existsSync(join(docs, 'assets', 'geteilt.png'))).toBe(true);
    expect((await del('docs/home.md')).statusCode).toBe(200);
    expect(existsSync(join(docs, 'assets', 'geteilt.png'))).toBe(false);
  });
});

describe('webhook', () => {
  it('requires a valid HMAC signature', async () => {
    const secret = ((await app.server.inject({ method: 'GET', url: '/api/settings/webhook', headers: { cookie } })).json() as { secret: string }).secret;
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: 'https://example.com/x.git' } });
    const bad = await app.server.inject({ method: 'POST', url: '/api/webhooks/git', headers: { 'content-type': 'application/json', 'x-gitea-signature': 'abc' }, payload: body });
    expect(bad.statusCode).toBe(401);
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const ok = await app.server.inject({ method: 'POST', url: '/api/webhooks/git', headers: { 'content-type': 'application/json', 'x-gitea-signature': sig }, payload: body });
    expect(ok.json()).toEqual({ ok: true, mounts: 0 });
  });

  it('takes GitHub (sha256= signature, ping) and GitLab (token) too, and lists what arrived (AD-033)', async () => {
    const hook = async () => (await app.server.inject({ method: 'GET', url: '/api/settings/webhook', headers: { cookie } })).json() as { secret: string; url: string; recent: { action: string; message: string }[] };
    const { secret } = await hook();
    const post = (headers: Record<string, string>, payload: string) => app.server.inject({ method: 'POST', url: '/api/webhooks/git', headers: { 'content-type': 'application/json', ...headers }, payload });
    const gh = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: 'https://github.com/mara/wiki.git' } });
    const sig = `sha256=${createHmac('sha256', secret).update(gh).digest('hex')}`;
    expect((await post({ 'x-hub-signature-256': sig, 'x-github-event': 'ping' }, gh)).json()).toEqual({ ok: true, ping: true });
    expect((await post({ 'x-hub-signature-256': sig, 'x-github-event': 'push' }, gh)).json()).toEqual({ ok: true, mounts: 0 });
    const gl = JSON.stringify({ ref: 'refs/heads/main', project: { path_with_namespace: 'team/doku', git_http_url: 'https://gitlab.com/team/doku.git' } });
    expect((await post({ 'x-gitlab-token': 'falsch' }, gl)).statusCode).toBe(401);
    expect((await post({ 'x-gitlab-token': secret }, gl)).json()).toEqual({ ok: true, mounts: 0 });
    const { recent, url } = await hook();
    expect(url).toMatch(/\/api\/webhooks\/git$/);
    expect(recent.slice(0, 3).map((r) => [r.action, r.message])).toEqual([
      ['webhook-received', 'Webhook von GitLab: team/doku (main) → keine passende Quelle'],
      ['webhook-rejected', 'Webhook (GitLab) mit ungültiger Signatur abgelehnt'],
      ['webhook-received', 'Webhook von GitHub: mara/wiki (main) → keine passende Quelle'],
    ]);
  });

  it('a signature with non-ASCII characters is refused with 401 and logged as rejected, not a 500 (sec-003)', async () => {
    const post = (headers: Record<string, string>) => app.server.inject({ method: 'POST', url: '/api/webhooks/git', headers: { 'content-type': 'application/json', ...headers }, payload: '{}' });
    // Node hands header bytes 0x80–0xFF on as Latin-1 characters: 64 characters, but 128 bytes in UTF-8.
    expect((await post({ 'x-gitea-signature': 'é'.repeat(64) })).statusCode).toBe(401);
    expect((await post({ 'x-gitlab-token': 'é'.repeat(32) })).statusCode).toBe(401);
    const { recent } = (await app.server.inject({ method: 'GET', url: '/api/settings/webhook', headers: { cookie } })).json() as { recent: { action: string; message: string }[] };
    expect(recent.slice(0, 2).map((r) => [r.action, r.message])).toEqual([
      ['webhook-rejected', 'Webhook (GitLab) mit ungültiger Signatur abgelehnt'],
      ['webhook-rejected', 'Webhook (Gitea) mit ungültiger Signatur abgelehnt'],
    ]);
  });

  it('own webhook address: FQDN or IP with http(s), the path stays fixed; empty = the public address again (owner 25.10.)', async () => {
    const put = (base: string) => app.server.inject({ method: 'PUT', url: '/api/settings/webhook', payload: JSON.stringify({ base }), headers: { 'content-type': 'application/json', cookie } });
    expect((await put('http://192.168.1.20:8093/')).json()).toEqual({ url: 'http://192.168.1.20:8093/api/webhooks/git', base: 'http://192.168.1.20:8093', source: 'webhook', lan: true });
    expect((await put('https://wiki.example.org')).json()).toMatchObject({ url: 'https://wiki.example.org/api/webhooks/git', lan: false });
    for (const wrong of ['ftp://wiki.example.org', 'https://wiki.example.org/api/webhooks/git', 'wiki.example.org', 'https://user:pw@wiki.example.org', 'https://wiki.example.org/?x=1'])
      expect((await put(wrong)).statusCode, wrong).toBe(400);
    const back = (await put('')).json() as { base: string; source: string; url: string };
    expect(back.base).toBe('');
    expect(back.source).not.toBe('webhook');
    expect(back.url).toMatch(/\/api\/webhooks\/git$/);
  });

  it('remembers the addresses its hooks used: after a change of address its old hook is moved, another instance\'s stays (code-004)', async () => {
    const DEV = 'https://dev.example.org/api/webhooks/git';
    const PROD = 'https://prod.example.org/api/webhooks/git';
    // Fake Gitea (never a real one): the account holds Dev's hook (added by hand) and Prod's.
    const accountHooks: { id: number; config: { url: string } }[] = [
      { id: 1, config: { url: DEV } },
      { id: 2, config: { url: PROD } },
    ];
    const fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const send = (status: number, data?: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(data === undefined ? '' : JSON.stringify(data));
        if (req.url === '/api/v1/user') return send(200, { login: 'mara' });
        if (req.url === '/api/v1/user/hooks') return send(200, accountHooks);
        const one = /^\/api\/v1\/user\/hooks\/(\d+)$/.exec(req.url!);
        const i = one ? accountHooks.findIndex((h) => h.id === Number(one[1])) : -1;
        if (i < 0) return send(404, {});
        if (req.method === 'DELETE') return (accountHooks.splice(i, 1), send(204));
        accountHooks[i] = { id: accountHooks[i]!.id, ...(JSON.parse(body) as { config: { url: string } }) };
        send(200, accountHooks[i]);
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    try {
      const conn = await app.server.inject({ method: 'POST', url: '/api/connections', ...json({ kind: 'gitea', name: 'Gitea', baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, token: 'tok-1' }) });
      const id = (conn.json() as { id: string }).id;
      const setBase = (base: string) => app.server.inject({ method: 'PUT', url: '/api/settings/webhook', ...json({ base }) });
      type Status = { hooks: { at: string; current: boolean; foreign?: boolean }[]; plans: { account?: { action: string; from?: string }[]; remove: unknown[] } };
      const check = async () => (await app.server.inject({ method: 'GET', url: `/api/connections/${id}/webhook`, headers: { cookie } })).json() as Status;
      await setBase('https://dev.example.org');
      // The check finds Dev's hook at the current address and remembers it; Prod's is another instance's.
      expect((await check()).hooks).toEqual([
        { scope: 'account', name: 'mara', at: DEV, current: true, active: true },
        { scope: 'account', name: 'mara', at: PROD, current: false, active: true, foreign: true },
      ]);
      // A new address: the old Dev hook is still this instance's (moved), Prod's is not.
      await setBase('https://neu.example.org');
      const moved = await check();
      expect(moved.hooks.map((h) => `${h.at}${h.foreign ? ' foreign' : ''}`)).toEqual([DEV, `${PROD} foreign`]);
      expect(moved.plans.account).toEqual([{ scope: 'account', name: 'mara', action: 'move', from: DEV }]);
      const done = await app.server.inject({ method: 'POST', url: `/api/connections/${id}/webhook`, ...json({ way: 'account' }) });
      expect((done.json() as { changes: unknown }).changes).toEqual({ created: [], moved: ['mara'], removed: [] });
      expect(accountHooks.map((h) => h.config.url)).toEqual(['https://neu.example.org/api/webhooks/git', PROD]);
      const removed = await app.server.inject({ method: 'DELETE', url: `/api/connections/${id}/webhook`, ...json({}) });
      expect((removed.json() as { changes: unknown }).changes).toEqual({ created: [], moved: [], removed: ['mara'] });
      expect(accountHooks.map((h) => h.config.url)).toEqual([PROD]);
      expect(JSON.parse(String((app.db.prepare("SELECT value FROM settings WHERE key = 'webhook_known_urls'").get() as { value: string }).value))).toEqual([
        DEV,
        'https://neu.example.org/api/webhooks/git',
      ]);
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });
});

describe('REST API v1 and MCP (AD-023)', () => {
  const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
  const token = async (scopes: string[], c = cookie) =>
    ((await app.server.inject({ method: 'POST', url: '/api/tokens', payload: JSON.stringify({ name: scopes.join('+'), scopes }), headers: { 'content-type': 'application/json', cookie: c } })).json() as { token: string }).token;

  it('v1: sources, tree, search, read, write with baseHash, create, move, copy, backlinks, history; schema is public', async () => {
    const { id } = await createLocalMount();
    const t = await token(['read', 'write']);
    const h = { headers: bearer(t, { 'content-type': 'application/json' }) };
    const get = (url: string) => app.server.inject({ method: 'GET', url, headers: bearer(t) });
    expect((await app.server.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json()).toMatchObject({ openapi: '3.1.0', info: { version: '1' } });
    expect((await app.server.inject({ method: 'GET', url: '/api/v1/sources' })).statusCode).toBe(401);
    expect((await get('/api/v1/sources')).json()).toEqual([expect.objectContaining({ id, name: 'Wiki', access: 'write' })]);
    expect((await get(`/api/v1/tree/${id}`)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'docs/home.md', name: 'home', title: 'Home' })]));
    const hits = (await get('/api/v1/search?q=Outline')).json() as { path: string; snippet: string }[];
    expect(hits[0]).toMatchObject({ sourceId: id, path: 'docs/home.md', name: 'home' });
    expect(hits[0]!.snippet).toContain('«Outline»');
    const note = (await get(`/api/v1/notes/${id}/docs/home.md`)).json() as { hash: string; markdown: string };
    expect(note.markdown).toBe('# Home\n\nTrilium und Outline.\n');
    const put = (body: object) => app.server.inject({ method: 'PUT', url: `/api/v1/notes/${id}/docs/home.md`, payload: JSON.stringify(body), ...h });
    expect((await put({ markdown: '# Home\n\nNeu. [Plan](plan.md)\n', baseHash: note.hash })).json()).toMatchObject({ changed: true });
    expect((await put({ markdown: '# Alt\n', baseHash: note.hash })).statusCode).toBe(409);
    expect((await put({ markdown: '# Ohne\n' })).statusCode).toBe(400);
    const created = (await app.server.inject({ method: 'POST', url: `/api/v1/notes/${id}`, payload: JSON.stringify({ parent: 'docs', title: 'Plan', markdown: '# Plan\n\nInhalt.\n' }), ...h })).json() as { path: string };
    expect(created.path).toBe('docs/Plan.md');
    expect(readFileSync(join(root, 'projekte/wiki/docs/Plan.md'), 'utf8')).toContain('Inhalt.');
    expect((await get(`/api/v1/backlinks/${id}/docs/Plan.md`)).json()).toEqual([]); // link says plan.md (other case)
    const moved = (await app.server.inject({ method: 'POST', url: `/api/v1/move/${id}`, payload: JSON.stringify({ from: 'docs/Plan.md', to: 'docs/plan.md' }), ...h })).json() as { path: string };
    expect(moved.path).toBe('docs/plan.md');
    expect((await get(`/api/v1/backlinks/${id}/docs/plan.md`)).json()).toEqual([expect.objectContaining({ path: 'docs/home.md', name: 'home' })]);
    const copy = (await app.server.inject({ method: 'POST', url: `/api/v1/copy/${id}`, payload: JSON.stringify({ from: 'docs/plan.md', toParent: 'docs' }), ...h })).json() as { path: string };
    expect(copy.path).toBe('docs/plan (Kopie).md');
    expect((await get(`/api/v1/history/${id}/docs/home.md`)).json()).toMatchObject({ git: false });
    expect((await app.server.inject({ method: 'DELETE', url: `/api/v1/notes/${id}/docs/plan (Kopie).md`, headers: bearer(t) })).json()).toEqual({ ok: true });
    expect(existsSync(join(root, 'projekte/wiki/docs/plan (Kopie).md'))).toBe(false);
    // read-only token: no writes; changes are audited with the API marker.
    const r = await token(['read']);
    expect((await app.server.inject({ method: 'PUT', url: `/api/v1/notes/${id}/docs/home.md`, payload: JSON.stringify({ markdown: 'x', baseHash: 'y' }), headers: bearer(r, { 'content-type': 'application/json' }) })).statusCode).toBe(403);
    const log = JSON.stringify(app.db.prepare('SELECT message FROM activity').all());
    expect(log).toContain('API: Gespeichert: docs/home.md');
  });

  it('v1: missing or broken bodies are 400 (never 500), unknown notes 404 – also for backlinks and uploads', async () => {
    const { id } = await createLocalMount();
    const t = await token(['read', 'write']);
    const call = (method: 'POST' | 'PUT', url: string, payload?: string) =>
      app.server.inject({ method, url, headers: payload === undefined ? bearer(t) : bearer(t, { 'content-type': 'application/json' }), payload });
    for (const [method, url] of [
      ['POST', `/api/v1/notes/${id}`],
      ['PUT', `/api/v1/notes/${id}/docs/home.md`],
      ['POST', `/api/v1/move/${id}`],
      ['POST', `/api/v1/copy/${id}`],
      ['POST', `/api/v1/folders/${id}`],
      ['POST', `/api/v1/attachments/${id}`],
    ] as const) {
      for (const payload of [undefined, '{}', '[]', 'null', '{"x": ']) {
        const res = await call(method, url, payload);
        expect([method, url, payload, res.statusCode]).toEqual([method, url, payload, expect.toSatisfy((c: number) => c >= 400 && c < 500)]);
        expect(res.json()).toEqual({ error: expect.any(String) });
      }
    }
    expect(readFileSync(join(root, 'projekte/wiki/docs/home.md'), 'utf8')).toBe('# Home\n\nTrilium und Outline.\n');
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/backlinks/${id}/docs/gibt-es-nicht.md`, headers: bearer(t) })).statusCode).toBe(404);
    const up = await call('POST', `/api/v1/attachments/${id}`, JSON.stringify({ note: 'docs/gibt-es-nicht.md', name: 'x.svg', contentText: '<svg/>' }));
    expect(up.statusCode).toBe(404);
    expect(existsSync(join(root, 'projekte/wiki/docs/assets'))).toBe(false);
  });

  it('„Rechte“: every rule of every source, what each account may at the top and why, when it was last active – admins only', async () => {
    const { id } = await createLocalMount();
    const maria = await addUser('maria');
    const bob = await addUser('bob');
    const group = (await app.server.inject({ method: 'POST', url: '/api/admin/groups', ...json({ name: 'Team' }) })).json() as { id: string };
    await app.server.inject({ method: 'PATCH', url: `/api/admin/groups/${group.id}`, ...json({ members: [bob.id] }) });
    const rule = (body: object) => app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json(body) });
    await rule({ target: 'mount', subject: 'all', level: 'none' });
    await rule({ target: 'mount', subject: 'group', subjectId: group.id, level: 'write' });
    await rule({ target: 'note', path: 'docs/home.md', subject: 'user', subjectId: maria.id, level: 'read' });
    // A folder rule whose folder is gone (renamed outside): marked for cleaning up.
    await rule({ target: 'folder', path: 'alt', subject: 'user', subjectId: maria.id, level: 'read' });
    expect((await app.server.inject({ method: 'GET', url: '/api/admin/rights', headers: { cookie: maria.cookie } })).statusCode).toBe(403);
    const res = await app.server.inject({ method: 'GET', url: '/api/admin/rights', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const o = res.json() as {
      defaultLevel: string;
      mounts: { id: string; name: string }[];
      users: { id: string; name: string; isAdmin: boolean; lastSeenAt: string | null; groups: string[]; sources: Record<string, string> }[];
      rules: { id: string; target: string; path: string; subject: string; subjectId: string | null; level: string; orphan?: boolean }[];
    };
    expect(o.defaultLevel).toBe('write');
    expect(o.mounts).toEqual([{ id, name: 'Wiki' }]);
    const u = (name: string) => o.users.find((x) => x.name === name)!;
    expect(u('maria').sources[id]).toBe('none');
    expect(u('bob').sources[id]).toBe('write');
    expect(u('bob').groups).toEqual([group.id]);
    expect(u('Admin').sources[id]).toBe('admin');
    expect(u('maria').lastSeenAt).toBeTruthy();
    expect(o.rules.map((r) => [r.target, r.path, r.subject, r.level, !!r.orphan])).toEqual([
      ['mount', '', 'all', 'none', false],
      ['mount', '', 'group', 'write', false],
      ['note', 'docs/home.md', 'user', 'read', false],
      ['folder', 'alt', 'user', 'read', true],
    ]);
    // Why, for the grid: no own rule, and where the level would come from.
    const why = (name: string) => (o.users.find((x) => x.name === name) as unknown as { why: Record<string, object> }).why;
    expect(why('maria')[id]).toEqual({ own: null, inherited: 'none', via: 'all' });
    expect(why('bob')[id]).toEqual({ own: null, inherited: 'write', via: 'group', viaId: group.id });
    expect(why('Admin')).toEqual({});
    // An own rule beside the group's; a group that locks out wins over every other group.
    await rule({ target: 'mount', subject: 'user', subjectId: bob.id, level: 'read' });
    const lock = (await app.server.inject({ method: 'POST', url: '/api/admin/groups', ...json({ name: 'Gesperrt' }) })).json() as { id: string };
    const again = async () => (((await app.server.inject({ method: 'GET', url: '/api/admin/rights', headers: { cookie } })).json() as typeof o).users.find((x) => x.name === 'bob') as unknown) as { sources: Record<string, string>; why: Record<string, object> };
    expect((await again()).why[id]).toEqual({ own: 'read', inherited: 'write', via: 'group', viaId: group.id });
    expect((await again()).sources[id]).toBe('read');
    await rule({ target: 'mount', subject: 'group', subjectId: lock.id, level: 'none' });
    await app.server.inject({ method: 'PATCH', url: `/api/admin/groups/${lock.id}`, ...json({ members: [bob.id] }) });
    expect((await again()).why[id]).toEqual({ own: 'read', inherited: 'none', via: 'group', viaId: lock.id, groupLock: true });
    expect((await again()).sources[id]).toBe('none');
    // Taking a right away from here is the ordinary removal of the rule.
    const note = o.rules.find((r) => r.target === 'note')!;
    expect((await app.server.inject({ method: 'DELETE', url: `/api/acl/rule/${note.id}`, ...json({}) })).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'GET', url: `/api/notes/${id}/docs/home.md`, headers: { cookie: maria.cookie } })).statusCode).toBe(404);
  });

  it('v1 follows the ACL: hidden notes are 404, read-only notes refuse writes, search is filtered', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'geheim'), { recursive: true });
    writeFileSync(join(wiki, 'geheim', 'lohn.md'), '# Lohn\n\nZebrawort.\n');
    const { id } = await createLocalMount();
    await addUser('maria');
    const users = (await app.server.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    const mariaId = users.find((u) => u.username === 'maria')!.id;
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: userPw('maria') } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    const rule = (body: object) => app.server.inject({ method: 'POST', url: `/api/acl/${id}`, ...json(body) });
    await rule({ target: 'folder', path: 'geheim', subject: 'user', subjectId: mariaId, level: 'none' });
    await rule({ target: 'folder', path: 'docs', subject: 'user', subjectId: mariaId, level: 'read' });
    const t = await token(['read', 'write'], maria);
    const get = (url: string) => app.server.inject({ method: 'GET', url, headers: bearer(t) });
    expect((await get(`/api/v1/notes/${id}/geheim/lohn.md`)).statusCode).toBe(404);
    expect((await get('/api/v1/search?q=Zebrawort')).json()).toEqual([]);
    expect(((await get(`/api/v1/tree/${id}`)).json() as { path: string }[]).map((e) => e.path)).not.toContain('geheim/lohn.md');
    const note = (await get(`/api/v1/notes/${id}/docs/home.md`)).json() as { hash: string; access: string };
    expect(note.access).toBe('read');
    const put = await app.server.inject({ method: 'PUT', url: `/api/v1/notes/${id}/docs/home.md`, payload: JSON.stringify({ markdown: '# x\n', baseHash: note.hash }), headers: bearer(t, { 'content-type': 'application/json' }) });
    expect(put.statusCode).toBe(403);
    // The same over MCP: a token with „write“ never writes more than its person may (owner 21.10.).
    const m = await token(['read', 'write', 'mcp'], maria);
    const call = async (name: string, args: object) =>
      ((await app.server.inject({ method: 'POST', url: '/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), headers: bearer(m, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }) })).json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
    for (const [name, args] of [
      ['write_note', { source_id: id, path: 'docs/home.md', markdown: '# x\n', base_hash: note.hash }],
      ['create_note', { source_id: id, parent: 'docs', title: 'Neu' }],
      ['create_folder', { source_id: id, parent: 'docs', name: 'neu' }],
      ['move_note', { source_id: id, from: 'docs/home.md', to: 'docs/weg.md' }],
      ['copy_note', { source_id: id, from: 'docs/home.md', to_parent: 'docs' }],
      ['delete_note', { source_id: id, path: 'docs/home.md' }],
      ['upload_file', { source_id: id, note: 'docs/home.md', name: 'x.txt', content_text: 'x' }],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.content[0]!.text, name).toMatch(/Leserecht|Berechtigung|Schreib/);
    }
    expect(readFileSync(join(wiki, 'docs', 'home.md'), 'utf8')).not.toContain('# x');
  });

  it('MCP: needs a token with scope mcp; initialize, tools/list, tools/call; writing needs write; errors come back as tool errors', async () => {
    const { id } = await createLocalMount();
    const rpc = (t: string | null, body: unknown, extra: Record<string, string> = {}) =>
      app.server.inject({ method: 'POST', url: '/mcp', payload: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra } });
    const call = async (t: string, name: string, args: object) =>
      ((await rpc(t, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })).json() as { result: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } }).result;

    expect((await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).statusCode).toBe(401);
    expect((await app.server.inject({ method: 'POST', url: '/mcp', payload: '{}', headers: { 'content-type': 'application/json', cookie } })).statusCode).toBe(401);
    const plain = await token(['read', 'write']);
    expect((await rpc(plain, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).statusCode).toBe(403);
    const ro = await token(['read', 'mcp']);
    const init = (await rpc(ro, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
    expect(init).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kaveyl-wiki' } } });
    expect((await rpc(ro, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
    expect((await rpc(ro, { jsonrpc: '2.0', id: 1, method: 'x' }, { origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await app.server.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${ro}` } })).statusCode).toBe(405);
    const tools = ((await rpc(ro, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toEqual([
      'list_sources',
      'search',
      'list_tree',
      'read_note',
      'write_note',
      'create_note',
      'create_folder',
      'move_note',
      'copy_note',
      'delete_note',
      'upload_file',
      'list_changes',
      'list_attachments',
      'get_backlinks',
      'get_history',
      'read_version',
      'get_sync_status',
      'sync_source',
    ]);
    expect((await call(ro, 'list_sources', {})).structuredContent).toEqual({ items: [expect.objectContaining({ id, name: 'Wiki' })] });
    expect((await call(ro, 'search', { query: 'Trilium' })).content[0]!.text).toContain('docs/home.md');
    const note = (await call(ro, 'read_note', { source_id: id, path: 'docs/home.md' })).structuredContent as { hash: string; markdown: string };
    expect(note.markdown).toContain('Trilium');
    expect(note).toMatchObject({ editingNow: [] });
    // Someone else typing in the app shows up for the AI (team test 23.10.); the token's own person does not.
    const typist = await addUser('tippt', { displayName: 'Maria Muster' });
    for (const c of [cookie, typist.cookie]) {
      const beat = await app.server.inject({ method: 'POST', url: '/api/presence', payload: { mountId: id, path: 'docs/home.md', open: true, editing: true }, headers: { cookie: c } });
      expect(beat.statusCode).toBe(200);
    }
    expect((await call(ro, 'read_note', { source_id: id, path: 'docs/home.md' })).structuredContent).toMatchObject({ editingNow: ['Maria Muster'] });
    await app.server.inject({ method: 'POST', url: '/api/presence', payload: { mountId: id, path: 'docs/home.md', open: false }, headers: { cookie: typist.cookie } });
    expect((await call(ro, 'read_note', { source_id: id, path: 'docs/home.md' })).structuredContent).toMatchObject({ editingNow: [] });
    const denied = await call(ro, 'write_note', { source_id: id, path: 'docs/home.md', markdown: '# x\n', base_hash: note.hash });
    expect(denied).toMatchObject({ isError: true });
    expect(denied.content[0]!.text).toContain('Schreibrecht');
    const rw = await token(['read', 'write', 'mcp']);
    expect(await call(rw, 'write_note', { source_id: id, path: 'docs/home.md', markdown: '# Home\n\nVon Claude.\n', base_hash: note.hash })).not.toHaveProperty('isError');
    expect(readFileSync(join(root, 'projekte/wiki/docs/home.md'), 'utf8')).toBe('# Home\n\nVon Claude.\n');
    const conflict = await call(rw, 'write_note', { source_id: id, path: 'docs/home.md', markdown: '# Alt\n', base_hash: note.hash });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]!.text).toContain('Konflikt');
    expect((await call(rw, 'create_note', { source_id: id, parent: 'docs', title: 'Neu von MCP' })).structuredContent).toMatchObject({ path: 'docs/Neu von MCP.md' });
    // Copying (team test 23.10.: MCP could move but not copy): a taken name gets „(Kopie)“.
    expect((await call(rw, 'copy_note', { source_id: id, from: 'docs/Neu von MCP.md', to_parent: 'docs' })).structuredContent).toMatchObject({ path: 'docs/Neu von MCP (Kopie).md' });
    expect(readFileSync(join(root, 'projekte/wiki/docs/Neu von MCP (Kopie).md'), 'utf8')).toContain('# Neu von MCP');
    expect((await call(rw, 'read_note', { source_id: id, path: 'gibts/nicht.md' })).isError).toBe(true);
    // An internal error (here: a note as parent folder → EEXIST from the file system) names no server path – as REST v1
    // (audit sec2-003).
    const internal = await call(rw, 'create_note', { source_id: id, parent: 'docs/home.md', title: 'X' });
    expect(internal.isError).toBe(true);
    expect(internal.content[0]!.text).toBe('Interner Fehler');
    const unknown = (await rpc(rw, { jsonrpc: '2.0', id: 9, method: 'resources/list' })).json() as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
  });

  it('MCP: folders, deleting into the trash, search in one source, sync state and syncing; errors in the request language, content never translated', async () => {
    const { id } = await createLocalMount();
    const wiki = join(root, 'projekte', 'wiki');
    const rpc = (t: string, body: unknown, extra: Record<string, string> = {}) =>
      app.server.inject({ method: 'POST', url: '/mcp', payload: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${t}`, ...extra } });
    type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
    const call = async (t: string, name: string, args: object, extra: Record<string, string> = {}) =>
      ((await rpc(t, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, extra)).json() as { result: Result }).result;
    const rw = await token(['read', 'write', 'mcp']);
    const ro = await token(['read', 'mcp']);

    // Annotations: deleting is marked destructive, syncing talks to the remote.
    const listed = ((await rpc(ro, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as { result: { tools: { name: string; annotations: Record<string, boolean> }[] } }).result.tools;
    expect(listed.find((x) => x.name === 'delete_note')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed.find((x) => x.name === 'sync_source')!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(listed.find((x) => x.name === 'get_sync_status')!.annotations).toMatchObject({ readOnlyHint: true });

    // create_folder: a folder with its folder note, unique name; nested parents are created.
    const folder = (await call(rw, 'create_folder', { source_id: id, parent: 'docs', name: 'Projekte' })).structuredContent;
    expect(folder).toEqual({ sourceId: id, path: 'docs/Projekte', folderNote: 'docs/Projekte/index.md' });
    expect(existsSync(join(wiki, 'docs/Projekte/index.md'))).toBe(true);
    expect((await call(rw, 'create_folder', { source_id: id, parent: 'docs', name: 'Projekte' })).structuredContent).toMatchObject({ path: 'docs/Projekte 2' });
    expect((await call(rw, 'create_folder', { source_id: id, parent: 'docs/neu/tief', name: 'Ende' })).structuredContent).toMatchObject({ path: 'docs/neu/tief/Ende' });
    expect(existsSync(join(wiki, 'docs/neu/tief/Ende/index.md'))).toBe(true);
    expect((await call(rw, 'create_folder', { source_id: id, parent: 'docs', name: '  ' })).isError).toBe(true);
    expect((await call(ro, 'create_folder', { source_id: id, parent: 'docs', name: 'Nein' })).isError).toBe(true);
    const deep = await call(rw, 'create_note', { source_id: id, parent: 'docs/Projekte/Website/2026', title: 'Plan', markdown: '# Plan\n\nSiehe [Home](../../../home.md).\n' });
    expect(deep.structuredContent).toMatchObject({ path: 'docs/Projekte/Website/2026/Plan.md' });

    // search: only one source; in: with the id works too (ids are upper case).
    await createLocalMount();
    const hits = (q: object) => call(ro, 'search', q).then((r) => (r.structuredContent as { items: { sourceId: string }[] }).items);
    expect((await hits({ query: 'Trilium' })).length).toBe(2);
    expect((await hits({ query: 'Trilium', source_id: id })).map((h) => h.sourceId)).toEqual([id]);
    expect((await hits({ query: `Trilium in:${id}` })).map((h) => h.sourceId)).toEqual([id]);
    expect((await call(ro, 'search', { query: 'Trilium', source_id: 'gibt-es-nicht' })).isError).toBe(true);

    // delete_note: a note and a folder into the folder trash; the root and unknown paths are refused; read-only refused.
    expect((await call(ro, 'delete_note', { source_id: id, path: 'docs/Projekte/Website/2026/Plan.md' })).isError).toBe(true);
    expect((await call(rw, 'delete_note', { source_id: id, path: 'docs/Projekte/Website/2026/Plan.md' })).structuredContent).toEqual({ ok: true });
    expect(existsSync(join(wiki, 'docs/Projekte/Website/2026/Plan.md'))).toBe(false);
    expect((await call(rw, 'delete_note', { source_id: id, path: 'docs/Projekte 2' })).structuredContent).toEqual({ ok: true });
    expect(existsSync(join(wiki, 'docs/Projekte 2'))).toBe(false);
    expect((await call(rw, 'delete_note', { source_id: id, path: '' })).isError).toBe(true);
    expect((await call(rw, 'delete_note', { source_id: id, path: 'docs/gibt-es-nicht.md' })).isError).toBe(true);
    const trash = ((await app.server.inject({ method: 'GET', url: `/api/trash/${id}`, headers: { cookie } })).json() as { items: { path: string }[] }).items;
    expect(trash.map((x) => x.path).sort()).toEqual(['docs/Projekte 2', 'docs/Projekte/Website/2026/Plan.md']);
    expect(JSON.stringify(app.db.prepare('SELECT message FROM activity').all())).toContain('MCP: Gelöscht: docs/Projekte 2');

    // Sync state and syncing: a plain folder has nothing to fetch or push.
    const state = (await call(ro, 'get_sync_status', { source_id: id })).structuredContent as { items: Record<string, unknown>[] };
    expect(state.items).toEqual([expect.objectContaining({ id, name: 'Wiki', type: 'local', canSync: false, pendingEdits: 0 })]);
    expect(((await call(rw, 'get_sync_status', {})).structuredContent as { items: unknown[] }).items).toHaveLength(2);
    expect(((await call(rw, 'get_sync_status', { source_id: id })).structuredContent as { items: { canSync: boolean }[] }).items[0]!.canSync).toBe(true);
    expect((await call(ro, 'sync_source', { source_id: id })).isError).toBe(true);
    expect((await call(rw, 'sync_source', { source_id: id })).structuredContent).toMatchObject({ sourceId: id, result: null, status: { id, pendingEdits: 0 } });

    // Plaintext never goes into an encrypted folder, and a refused note is not left behind.
    mkdirSync(join(wiki, 'tresor'), { recursive: true });
    writeFileSync(join(wiki, 'tresor', '.kaveyl-wiki.yml'), 'encrypted: age\n');
    const plain = await call(rw, 'create_note', { source_id: id, parent: 'tresor', title: 'Geheim', markdown: '# Geheim\n\nKlartext\n' });
    expect(plain.isError).toBe(true);
    expect(plain.content[0]!.text).toContain('Klartext');
    expect(readdirSync(join(wiki, 'tresor'))).toEqual(['.kaveyl-wiki.yml']);

    // Errors follow the request language; note content and file names never get translated.
    const en = { 'accept-language': 'en-GB' };
    expect((await call(rw, 'read_note', { source_id: id, path: 'docs/nichts.md' }, en)).content[0]!.text).toBe('Not found (or no permission).');
    expect((await call(rw, 'read_note', { source_id: id, path: '../x.md' }, en)).content[0]!.text).toBe('Path outside the source (“..”)');
    expect((await call(rw, 'read_note', { source_id: id }, en)).content[0]!.text).toBe('Parameter “path” missing');
    expect((await call(ro, 'write_note', { source_id: id, path: 'docs/home.md', markdown: 'x', base_hash: 'y' }, en)).content[0]!.text).toContain('no write permission');
    expect((await call(rw, 'read_note', { source_id: id, path: 'docs/nichts.md' })).content[0]!.text).toBe('Nicht gefunden (oder keine Berechtigung).');
    // Without any language hint a script gets English (owner 2026-10-22); the unit tests set German as fallback.
    setFallbackLang('en');
    try {
      expect((await call(rw, 'read_note', { source_id: id, path: 'docs/nichts.md' })).content[0]!.text).toBe('Not found (or no permission).');
      expect((await call(rw, 'read_note', { source_id: id, path: 'docs/nichts.md' }, { 'accept-language': 'de-AT' })).content[0]!.text).toBe('Nicht gefunden (oder keine Berechtigung).');
    } finally {
      setFallbackLang('de');
    }
    const named = (await call(rw, 'create_note', { source_id: id, parent: 'docs', title: 'Nicht gefunden', markdown: 'Nicht gefunden' }, en)).structuredContent as { path: string };
    expect(named.path).toBe('docs/Nicht gefunden.md');
    const back = await call(rw, 'read_note', { source_id: id, path: named.path }, en);
    expect((back.structuredContent as { markdown: string; title: string }).markdown).toContain('Nicht gefunden');
    expect(back.content[0]!.text).toContain('"name": "Nicht gefunden"');
    const unknownTool = (await rpc(rw, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rm_rf' } }, en)).json() as { error: { message: string } };
    expect(unknownTool.error.message).toBe('Unknown tool: rm_rf');

    // Files: upload as text or base64 into assets/ next to the note, never overwriting; the link comes back ready to insert.
    const init = (await rpc(ro, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json() as { result: { instructions: string } };
    expect(init.result.instructions).toContain('[!WARNING]');
    expect(init.result.instructions).toContain('upload_file');
    expect(init.result.instructions).toContain('\n- Diagrams: a code block with the language mermaid');
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>';
    const svg = (await call(rw, 'upload_file', { source_id: id, note: 'docs/home.md', name: 'Ofen Brunhilde.svg', content_text: SVG })).structuredContent;
    // Names as in the app: spaces become dashes.
    expect(svg).toEqual({ sourceId: id, path: 'docs/assets/Ofen-Brunhilde.svg', href: 'assets/Ofen-Brunhilde.svg', name: 'Ofen-Brunhilde.svg', size: SVG.length, image: true, markdown: '![Ofen-Brunhilde](assets/Ofen-Brunhilde.svg)' });
    expect(readFileSync(join(wiki, 'docs/assets/Ofen-Brunhilde.svg'), 'utf8')).toBe(SVG);
    expect((await call(rw, 'upload_file', { source_id: id, note: 'docs/home.md', name: 'Ofen Brunhilde.svg', content_text: SVG })).structuredContent).toMatchObject({ name: 'Ofen-Brunhilde-2.svg' });
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const png = (await call(rw, 'upload_file', { source_id: id, note: 'docs/home.md', name: 'punkt.png', content_base64: `data:image/png;base64,${PNG}` })).structuredContent as { path: string; size: number };
    expect(readFileSync(join(wiki, png.path))).toEqual(Buffer.from(PNG, 'base64'));
    const pdf = (await call(rw, 'upload_file', { source_id: id, note: 'docs/home.md', name: 'preise.pdf', content_base64: Buffer.from('%PDF-1.4 test').toString('base64') })).structuredContent;
    expect(pdf).toMatchObject({ image: false, markdown: '[preise.pdf](assets/preise.pdf)' });
    const refused = async (args: object, t = rw) => (await call(t, 'upload_file', { source_id: id, note: 'docs/home.md', name: 'x.svg', ...args })).isError;
    expect(await refused({})).toBe(true);
    expect(await refused({ content_text: 'a', content_base64: 'YQ==' })).toBe(true);
    expect(await refused({ content_base64: 'kein base64!' })).toBe(true);
    expect(await refused({ content_text: '' })).toBe(true);
    expect(await refused({ name: 'tool.exe', content_base64: 'TVo=' })).toBe(true);
    expect(await refused({ name: 'neu.md', content_text: '# x' })).toBe(true);
    expect(await refused({ note: 'docs/fehlt.md', content_text: SVG })).toBe(true);
    expect(await refused({ content_text: SVG }, ro)).toBe(true);
    expect(await refused({ content_base64: 'A'.repeat(14_000_100) })).toBe(true);
    writeFileSync(join(wiki, 'tresor', 'geheim.md'), '---\nencrypted: age\n---\n-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n');
    expect((await call(rw, 'upload_file', { source_id: id, note: 'tresor/geheim.md', name: 'x.svg', content_text: SVG })).isError).toBe(true);
    expect(readdirSync(join(wiki, 'tresor'))).not.toContain('assets');

    // list_attachments: what the note links to, missing files with size null.
    const home = (await call(rw, 'read_note', { source_id: id, path: 'docs/home.md' })).structuredContent as { markdown: string; hash: string };
    await call(rw, 'write_note', { source_id: id, path: 'docs/home.md', markdown: `${home.markdown}\n![Ofen Brunhilde](assets/Ofen-Brunhilde.svg)\n\n[Preise](assets/preise.pdf) [weg](assets/fehlt.png)\n`, base_hash: home.hash });
    const files = ((await call(ro, 'list_attachments', { source_id: id, path: 'docs/home.md' })).structuredContent as { items: { path: string; size: number | null; kind: string }[] }).items;
    expect(files.map((f) => [f.path, f.kind, f.size === null ? null : f.size > 0])).toEqual([
      ['docs/assets/Ofen-Brunhilde.svg', 'image', true],
      ['docs/assets/preise.pdf', 'pdf', true],
      ['docs/assets/fehlt.png', 'image', null],
    ]);
    expect(JSON.stringify(app.db.prepare('SELECT message FROM activity').all())).toContain('MCP: Anhang: docs/assets/Ofen-Brunhilde.svg');

    // The same operations in REST v1.
    const v1 = await token(['read', 'write']);
    const post = (url: string, body: object) => app.server.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: bearer(v1, { 'content-type': 'application/json' }) });
    expect((await post(`/api/v1/folders/${id}`, { parent: '', name: 'REST-Ordner' })).json()).toEqual({ sourceId: id, path: 'REST-Ordner', folderNote: 'REST-Ordner/index.md' });
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/status?source=${id}`, headers: bearer(v1) })).json()).toEqual([expect.objectContaining({ id, canSync: true })]);
    expect((await post(`/api/v1/sync/${id}`, {})).json()).toMatchObject({ sourceId: id, result: null });
    expect(((await app.server.inject({ method: 'GET', url: `/api/v1/search?q=Trilium&source=${id}`, headers: bearer(v1) })).json() as unknown[]).length).toBe(1);
    expect((await post(`/api/v1/attachments/${id}`, { note: 'REST-Ordner/index.md', name: 'skizze.svg', contentText: SVG })).json()).toMatchObject({ path: 'REST-Ordner/assets/skizze.svg', markdown: '![skizze](assets/skizze.svg)' });
    expect((await app.server.inject({ method: 'GET', url: `/api/v1/attachments/${id}/docs/home.md`, headers: bearer(v1) })).json()).toHaveLength(3);
  });
});
