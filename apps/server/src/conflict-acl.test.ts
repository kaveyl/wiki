// Conflict view and resolution respect folder rights (AD-020, audit sec-001); admins are unchanged.
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
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-conflict-acl-'));
});
afterEach(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

it('only users who may read (view) and write (resolve) every conflicted file of the source get at it', async () => {
  const remote = join(root, 'remote.git');
  const ext = join(root, 'ext');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(root, ['clone', '-q', remote, ext]);
  mkdirSync(join(ext, 'geheim'), { recursive: true });
  mkdirSync(join(ext, 'team'), { recursive: true });
  writeFileSync(join(ext, 'home.md'), '# Home\n');
  writeFileSync(join(ext, 'geheim', 'plan.md'), '# Plan\n\nGEHEIM-BASIS\n');
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
  // Two sources share one clone: the whole repository and its folder "team".
  const whole = await app.manager.create({ name: 'Team', type: 'remote', source: remote, branch: 'main' });
  const sub = await app.manager.create({ name: 'Teamordner', type: 'remote', source: remote, branch: 'main', subpath: 'team' });
  const created = await inject({ method: 'POST', url: '/api/admin/users', payload: JSON.stringify({ email: 'eva@example.test', username: 'eva', password: 'Start-Passwort-0001' }), headers: h(admin) });
  const evaId = (created.json() as { id: string }).id;
  const eva = session(await inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Start-Passwort-0001' } }));
  await inject({ method: 'POST', url: '/api/account/password', payload: JSON.stringify({ current: 'Start-Passwort-0001', next: 'Eva-Passwort-0001-lang' }), headers: h(eva) });
  expect((await inject({ method: 'POST', url: `/api/acl/${whole.id}`, payload: JSON.stringify({ target: 'folder', path: 'geheim', subject: 'user', subjectId: evaId, level: 'none' }), headers: h(admin) })).statusCode).toBe(200);
  expect((await inject({ method: 'GET', url: `/api/notes/${whole.id}/geheim/plan.md`, headers: h(eva) })).statusCode).toBe(404);

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
  const view = (mountId: string, cookie: string) => inject({ method: 'GET', url: `/api/mounts/${mountId}/conflict`, headers: h(cookie) });
  const resolve = (mountId: string, cookie: string, path: string, content: string) =>
    inject({ method: 'POST', url: `/api/mounts/${mountId}/conflict/resolve`, payload: JSON.stringify({ resolutions: [{ path, content }] }), headers: h(cookie) });
  const onServer = (path: string) => git(root, ['--git-dir', remote, 'show', `main:${path}`]);

  // A conflict only in a folder Eva may write: she sees and resolves it, also through the subfolder source.
  await conflictOn('team/notiz.md', '# Notiz\n\nLokal\n', '# Notiz\n\nServer\n');
  const own = await view(sub.id, eva);
  expect(own.statusCode).toBe(200);
  expect((own.json() as { files: { path: string }[] }).files.map((f) => f.path)).toEqual(['team/notiz.md']);
  expect((await resolve(sub.id, eva, 'team/notiz.md', '# Notiz\n\nVon Eva\n')).statusCode).toBe(200);
  expect(await onServer('team/notiz.md')).toBe('# Notiz\n\nVon Eva\n');

  // A conflict in her closed folder: no content and no resolution – neither through the whole source nor the subfolder one.
  await conflictOn('geheim/plan.md', '# Plan\n\nGEHEIM-LOKAL\n', '# Plan\n\nGEHEIM-SERVER\n');
  for (const id of [whole.id, sub.id]) {
    const hidden = await view(id, eva);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.body).not.toContain('GEHEIM');
    expect((await resolve(id, eva, 'geheim/plan.md', '# Plan\n\nVON EVA\n')).statusCode).toBe(404);
  }
  expect(await onServer('geheim/plan.md')).toBe('# Plan\n\nGEHEIM-SERVER\n');

  // Admins unchanged.
  expect(JSON.stringify((await view(whole.id, admin)).json())).toContain('GEHEIM-SERVER');
  expect((await resolve(whole.id, admin, 'geheim/plan.md', '# Plan\n\nAdmin\n')).statusCode).toBe(200);
  expect(await onServer('geheim/plan.md')).toBe('# Plan\n\nAdmin\n');
}, 60_000);
