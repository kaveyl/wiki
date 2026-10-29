// „Jetzt abgleichen“ and „Alle synchronisieren“ sync a source with waiting edits once, not twice (audit code-005).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { git } from './git/git.js';

const EXT = { GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' };
let root: string;
let app: App;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-sync-now-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

it('syncs a source with waiting edits once per click, in „Jetzt abgleichen“ and „Alle synchronisieren“', async () => {
  const remote = join(root, 'remote.git');
  const ext = join(root, 'ext');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(root, ['clone', '-q', remote, ext]);
  writeFileSync(join(ext, 'home.md'), '# Home\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'init'], { env: EXT });
  await git(ext, ['push', '-q', 'origin', 'main']);
  // Edits wait for the commit pause (60 s) – the click has to commit them.
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 60, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  const inject = app.server.inject.bind(app.server);
  const res = await inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123' } });
  const h = { 'content-type': 'application/json', cookie: `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}` };
  const mount = await app.manager.create({ name: 'Team', type: 'remote', source: remote, branch: 'main' });
  const syncs = vi.spyOn(app.manager, 'sync');
  const onServer = () => git(root, ['--git-dir', remote, 'show', 'main:home.md']);

  const edit = async (text: string) => {
    const note = (await inject({ method: 'GET', url: `/api/notes/${mount.id}/home.md`, headers: h })).json() as { hash: string };
    expect((await inject({ method: 'PUT', url: `/api/notes/${mount.id}/home.md`, payload: JSON.stringify({ raw: text, baseHash: note.hash }), headers: h })).statusCode).toBe(200);
  };

  await edit('# Home\n\nEins\n');
  syncs.mockClear();
  expect((await inject({ method: 'POST', url: `/api/mounts/${mount.id}/sync`, payload: '{}', headers: h })).statusCode).toBe(200);
  expect(syncs).toHaveBeenCalledTimes(1);
  expect(await onServer()).toBe('# Home\n\nEins\n');

  await edit('# Home\n\nZwei\n');
  syncs.mockClear();
  expect((await inject({ method: 'POST', url: '/api/sync-all', payload: '{}', headers: h })).statusCode).toBe(200);
  expect(syncs).toHaveBeenCalledTimes(1);
  expect(await onServer()).toBe('# Home\n\nZwei\n');

  // Nothing waiting: still one sync per click.
  syncs.mockClear();
  await inject({ method: 'POST', url: `/api/mounts/${mount.id}/sync`, payload: '{}', headers: h });
  await inject({ method: 'POST', url: '/api/sync-all', payload: '{}', headers: h });
  expect(syncs).toHaveBeenCalledTimes(2);
});
