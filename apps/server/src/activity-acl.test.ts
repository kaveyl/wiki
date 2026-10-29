// Event log and sync status name note paths only to users who may read them (AD-020, audit sec-004); admins are unchanged.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { git } from './git/git.js';

const EXT = { GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' };
let root: string;
let app: App;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-activity-acl-'));
});
afterEach(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

it('log entries, mount list and status hide paths of closed folders from normal users', async () => {
  const remote = join(root, 'remote.git');
  const ext = join(root, 'ext');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(root, ['clone', '-q', remote, ext]);
  mkdirSync(join(ext, 'geheim'), { recursive: true });
  mkdirSync(join(ext, 'team'), { recursive: true });
  writeFileSync(join(ext, 'home.md'), '# Home\n');
  writeFileSync(join(ext, 'geheim', 'plan.md'), '# Plan\n\nBasis\n');
  writeFileSync(join(ext, 'team', 'notiz.md'), '# Notiz\n\nBasis\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'init'], { env: EXT });
  await git(ext, ['push', '-q', 'origin', 'main']);
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  const inject = app.server.inject.bind(app.server);
  const session = (res: { cookies: { name: string; value: string }[] }) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
  const admin = session(await inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123' } }));
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
  const h = (cookie: string) => ({ 'content-type': 'application/json', cookie });
  const whole = await app.manager.create({ name: 'Team', type: 'remote', source: remote, branch: 'main' });
  const sub = await app.manager.create({ name: 'Teamordner', type: 'remote', source: remote, branch: 'main', subpath: 'team' });
  const created = await inject({ method: 'POST', url: '/api/admin/users', payload: JSON.stringify({ email: 'eva@example.test', username: 'eva', password: 'Start-Passwort-0001' }), headers: h(admin) });
  const evaId = (created.json() as { id: string }).id;
  const eva = session(await inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Start-Passwort-0001' } }));
  await inject({ method: 'POST', url: '/api/account/password', payload: JSON.stringify({ current: 'Start-Passwort-0001', next: 'Eva-Passwort-0001-lang' }), headers: h(eva) });
  expect((await inject({ method: 'POST', url: `/api/acl/${whole.id}`, payload: JSON.stringify({ target: 'folder', path: 'geheim', subject: 'user', subjectId: evaId, level: 'none' }), headers: h(admin) })).statusCode).toBe(200);

  /** The admin edits `path` in Kaveyl Wiki while someone else pushes another version of it → conflict. */
  const conflictOn = async (path: string, mine: string, theirs: string) => {
    const note = (await inject({ method: 'GET', url: `/api/notes/${whole.id}/${path}`, headers: h(admin) })).json() as { hash: string };
    expect((await inject({ method: 'PUT', url: `/api/notes/${whole.id}/${path}`, payload: JSON.stringify({ raw: mine, baseHash: note.hash }), headers: h(admin) })).statusCode).toBe(200);
    await git(ext, ['pull', '-q', '--rebase', 'origin', 'main'], { env: EXT });
    writeFileSync(join(ext, ...path.split('/')), theirs);
    await git(ext, ['commit', '-q', '-am', 'remote edit'], { env: EXT });
    await git(ext, ['push', '-q', 'origin', 'main']);
    await inject({ method: 'POST', url: `/api/mounts/${whole.id}/sync`, payload: '{}', headers: h(admin) });
  };
  const resolve = (path: string, content: string) =>
    inject({ method: 'POST', url: `/api/mounts/${whole.id}/conflict/resolve`, payload: JSON.stringify({ resolutions: [{ path, content }] }), headers: h(admin) });
  const activity = async (cookie: string) => (await inject({ method: 'GET', url: `/api/activity?mountId=${whole.id}`, headers: h(cookie) })).body;
  const views = async (cookie: string) => [
    await activity(cookie),
    (await inject({ method: 'GET', url: '/api/mounts', headers: h(cookie) })).body,
    (await inject({ method: 'GET', url: '/api/status', headers: h(cookie) })).body,
  ];

  // A conflict in a folder Eva may read: she sees it with its path, in the log and in the source status.
  await conflictOn('team/notiz.md', '# Notiz\n\nLokal\n', '# Notiz\n\nServer\n');
  for (const body of await views(eva)) expect(body).toContain('team/notiz.md');
  expect((await resolve('team/notiz.md', '# Notiz\n\nAdmin\n')).statusCode).toBe(200);

  // A conflict in her closed folder: no path anywhere – neither while it lasts nor after it was resolved. The
  // subfolder source shares the clone; its status names no file outside of it.
  await conflictOn('geheim/plan.md', '# Plan\n\nLokal\n', '# Plan\n\nServer\n');
  const mounts = (await inject({ method: 'GET', url: '/api/mounts', headers: h(eva) })).json() as { id: string; syncStatus: string }[];
  expect(mounts.find((m) => m.id === sub.id)?.syncStatus).toBe('conflict');
  for (const body of await views(eva)) expect(body).not.toContain('geheim');
  for (const body of await views(admin)) expect(body).toContain('geheim/plan.md');
  expect((await resolve('geheim/plan.md', '# Plan\n\nAdmin\n')).statusCode).toBe(200);
  // An external rename inside the closed folder, pulled by a sync.
  await git(ext, ['pull', '-q', '--rebase', 'origin', 'main'], { env: EXT });
  await git(ext, ['mv', 'geheim/plan.md', 'geheim/plan-neu.md'], { env: EXT });
  await git(ext, ['commit', '-q', '-m', 'rename'], { env: EXT });
  await git(ext, ['push', '-q', 'origin', 'main']);
  await inject({ method: 'POST', url: `/api/mounts/${whole.id}/sync`, payload: '{}', headers: h(admin) });

  const own = await activity(eva);
  expect(own).not.toContain('geheim');
  expect(own).toContain('Konflikt aufgelöst: team/notiz.md');
  const all = await activity(admin);
  expect(all).toContain('Konflikt mit Änderungen auf dem Server: geheim/plan.md');
  expect(all).toContain('Konflikt aufgelöst: geheim/plan.md');
  expect(all).toContain('geheim/plan-neu.md');
}, 60_000);

it('raw error texts (git, file system) reach only admins – others read a general text (sec-004)', async () => {
  const remote = join(root, 'remote.git');
  const ext = join(root, 'ext');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(root, ['clone', '-q', remote, ext]);
  writeFileSync(join(ext, 'home.md'), '# Home\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'init'], { env: EXT });
  await git(ext, ['push', '-q', 'origin', 'main']);
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  const inject = app.server.inject.bind(app.server);
  const session = (res: { cookies: { name: string; value: string }[] }) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
  const admin = session(await inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123' } }));
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
  const h = (cookie: string) => ({ 'content-type': 'application/json', cookie });
  const team = await app.manager.create({ name: 'Team', type: 'remote', source: remote, branch: 'main' });
  await inject({ method: 'POST', url: '/api/admin/users', payload: JSON.stringify({ email: 'eva@example.test', username: 'eva', password: 'Start-Passwort-0001' }), headers: h(admin) });
  const eva = session(await inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Start-Passwort-0001' } }));
  await inject({ method: 'POST', url: '/api/account/password', payload: JSON.stringify({ current: 'Start-Passwort-0001', next: 'Eva-Passwort-0001-lang' }), headers: h(eva) });

  // The remote is gone: git's error text names the command and the server path (the source address itself is no secret).
  const raw = 'does not appear to be a git repository';
  rmSync(remote, { recursive: true, force: true });
  await inject({ method: 'POST', url: `/api/mounts/${team.id}/sync`, payload: '{}', headers: h(admin) });
  const views = async (cookie: string) => [
    (await inject({ method: 'GET', url: `/api/activity?mountId=${team.id}`, headers: h(cookie) })).body,
    (await inject({ method: 'GET', url: '/api/activity', headers: h(cookie) })).body,
    (await inject({ method: 'GET', url: '/api/mounts', headers: h(cookie) })).body,
    (await inject({ method: 'GET', url: '/api/status', headers: h(cookie) })).body,
  ];
  const [log, , mounts] = await views(admin);
  expect(log).toContain(raw);
  expect(mounts).toContain(raw);
  for (const body of await views(eva)) expect(body).not.toContain(raw);
  const [own, , ownMounts] = await views(eva);
  expect(own).toContain('Abgleich fehlgeschlagen – Details sehen Administratoren im Protokoll');
  expect(ownMounts).toContain('Abgleich fehlgeschlagen – Details sehen Administratoren im Protokoll');

  // Housekeeping of the server names files and server paths: general entries only for admins, a source's with a
  // general text (sec2-004).
  const add = app.db.prepare('INSERT INTO activity (at, category, level, mount_id, mount_name, actor, action, message, detail_json) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)');
  add.run(new Date().toISOString(), 'system', 'warn', null, null, 'clone-prune', 'Verwaiste lokale Kopie /data/repos/.alt-x nicht gelöscht: EACCES');
  add.run(new Date().toISOString(), 'system', 'info', team.id, 'Team', 'stale-clone', 'Alter lokaler Clone von Team beiseitegelegt (neu geklont): /data/repos/.alt-y');
  const [adminLog, adminAll] = await views(admin);
  expect(adminLog).toContain('/data/repos/.alt-y');
  expect(adminAll).toContain('/data/repos/.alt-x');
  for (const body of await views(eva)) expect(body).not.toContain('/data/repos');
  expect((await views(eva))[0]).toContain('Alter lokaler Clone beiseitegelegt (neu geklont)');
}, 60_000);

it('the answer to „sync now“ names only files of the source the user may read (sec2-002)', async () => {
  const remote = join(root, 'remote.git');
  const ext = join(root, 'ext');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(root, ['clone', '-q', remote, ext]);
  mkdirSync(join(ext, 'geheim'), { recursive: true });
  mkdirSync(join(ext, 'team'), { recursive: true });
  writeFileSync(join(ext, 'home.md'), '# Home\n');
  writeFileSync(join(ext, 'geheim', 'plan.md'), '# Plan\n');
  writeFileSync(join(ext, 'team', 'notiz.md'), '# Notiz\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'init'], { env: EXT });
  await git(ext, ['push', '-q', 'origin', 'main']);
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  const inject = app.server.inject.bind(app.server);
  const session = (res: { cookies: { name: string; value: string }[] }) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
  const admin = session(await inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123' } }));
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
  const h = (cookie: string) => ({ 'content-type': 'application/json', cookie });
  const whole = await app.manager.create({ name: 'Team', type: 'remote', source: remote, branch: 'main' });
  const sub = await app.manager.create({ name: 'Teamordner', type: 'remote', source: remote, branch: 'main', subpath: 'team' });
  const created = await inject({ method: 'POST', url: '/api/admin/users', payload: JSON.stringify({ email: 'eva@example.test', username: 'eva', password: 'Start-Passwort-0001' }), headers: h(admin) });
  const evaId = (created.json() as { id: string }).id;
  app.db.prepare('UPDATE users SET must_change_password = 0').run();
  const eva = session(await inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Start-Passwort-0001' } }));
  // Eva may write the source, but the folder „geheim“ is closed to her.
  expect((await inject({ method: 'POST', url: `/api/acl/${whole.id}`, payload: JSON.stringify({ target: 'folder', path: 'geheim', subject: 'user', subjectId: evaId, level: 'none' }), headers: h(admin) })).statusCode).toBe(200);
  expect((await inject({ method: 'GET', url: `/api/notes/${whole.id}/geheim/plan.md`, headers: h(eva) })).statusCode).toBe(404);

  // Someone pushes a note into the closed folder and one into an open one.
  await git(ext, ['pull', '-q', '--rebase', 'origin', 'main'], { env: EXT });
  writeFileSync(join(ext, 'geheim', 'Uebernahme-Firma-X.md'), '# Vertraulich\n');
  writeFileSync(join(ext, 'team', 'neu.md'), '# Neu\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'geheim'], { env: EXT });
  await git(ext, ['push', '-q', 'origin', 'main']);

  const res = await inject({ method: 'POST', url: `/api/mounts/${whole.id}/sync`, payload: '{}', headers: h(eva) });
  expect(res.statusCode).toBe(200);
  expect(JSON.stringify(res.json())).not.toContain('Uebernahme');
  expect(JSON.stringify(res.json())).toContain('team/neu.md');

  // A subfolder source: nothing from outside the subfolder.
  expect((await inject({ method: 'POST', url: `/api/acl/${whole.id}`, payload: JSON.stringify({ target: 'mount', path: '', subject: 'user', subjectId: evaId, level: 'none' }), headers: h(admin) })).statusCode).toBe(200);
  await git(ext, ['pull', '-q', '--rebase', 'origin', 'main'], { env: EXT });
  writeFileSync(join(ext, 'Gehaltsliste-2027.md'), '# Gehalt\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'root'], { env: EXT });
  await git(ext, ['push', '-q', 'origin', 'main']);
  const res2 = await inject({ method: 'POST', url: `/api/mounts/${sub.id}/sync`, payload: '{}', headers: h(eva) });
  expect(res2.statusCode).toBe(200);
  expect(JSON.stringify(res2.json())).not.toContain('Gehaltsliste');
}, 60_000);
