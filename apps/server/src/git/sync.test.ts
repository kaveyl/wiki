// Spike B (offline part): sync scenarios against throwaway bare repositories.
// "app" is the kaveyl-wiki-managed clone, "ext" plays an external editor (VS Code, Mac, agent).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, GitTimeoutError } from './git.js';
import { conflictFiles, resolveConflict } from './conflict.js';
import { commitPending, sync, type SyncTarget } from './sync.js';

const USER = { name: 'Test User', email: 'user@example.test' };
const EXT_ENV = {
  GIT_AUTHOR_NAME: 'External',
  GIT_AUTHOR_EMAIL: 'ext@example.test',
  GIT_COMMITTER_NAME: 'External',
  GIT_COMMITTER_EMAIL: 'ext@example.test',
};

let root: string;
let app: SyncTarget;
let ext: string;

function write(dir: string, path: string, content: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

async function extCommit(message: string, files: Record<string, string>, push: 'push' | 'force' | 'none' = 'push') {
  for (const [path, content] of Object.entries(files)) write(ext, path, content);
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', message], { env: EXT_ENV });
  if (push !== 'none') await git(ext, ['push', '-q', ...(push === 'force' ? ['--force'] : []), 'origin', 'HEAD:main']);
}

async function appCommit(message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) write(app.dir, path, content);
  return commitPending(app, message, USER);
}

const PARAS = Array.from({ length: 12 }, (_, i) => `Absatz ${i + 1}.`).join('\n\n') + '\n';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-sync-'));
  const remote = join(root, 'remote.git');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  ext = join(root, 'ext');
  await git(root, ['clone', '-q', remote, ext]);
  await git(ext, ['checkout', '-q', '-b', 'main']);
  await extCommit('init', { 'notes/a.md': PARAS, 'notes/b.md': '# B\n' });
  const appDir = join(root, 'app');
  await git(root, ['clone', '-q', '-b', 'main', remote, appDir]);
  app = { dir: appDir, branch: 'main' };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sync', () => {
  it('reports up-to-date when nothing changed', async () => {
    expect(await sync(app)).toMatchObject({ status: 'up-to-date', pushed: 0 });
  });

  it('pushes local commits with the user as author and the bot as committer', async () => {
    await appCommit('edit b', { 'notes/b.md': '# B\n\nNeu\n' });
    expect(await sync(app)).toMatchObject({ status: 'synced', pushed: 1, incoming: [] });
    await git(ext, ['pull', '-q']);
    expect(read(ext, 'notes/b.md')).toBe('# B\n\nNeu\n');
    const who = (await git(ext, ['log', '-1', '--format=%an <%ae>|%cn'])).trim();
    expect(who).toBe('Test User <user@example.test>|Kaveyl Wiki');
  });

  it('does not repeat the sync after a push that ran out of time (server not answering)', async () => {
    await appCommit('edit b', { 'notes/b.md': '# B\n\nNeu\n' });
    const calls = join(root, 'push-calls');
    // A receiving side that never answers (hooks never run, AD-071): the push command itself hangs.
    await git(app.dir, ['config', 'remote.origin.receivepack', `sh -c "echo push >> '${calls}'; sleep 30"`]);
    const err = await sync({ ...app, git: { timeoutMs: 1000 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitTimeoutError);
    expect(read(root, 'push-calls')).toBe('push\n');
  }, 15_000);

  it('fast-forwards external changes and lists them', async () => {
    await extCommit('ext edit', { 'notes/b.md': '# B extern\n', 'notes/c.md': 'neu\n' });
    const result = await sync(app);
    expect(result).toMatchObject({ status: 'synced', pushed: 0 });
    expect(result.incoming).toEqual([
      { status: 'M', path: 'notes/b.md' },
      { status: 'A', path: 'notes/c.md' },
    ]);
    expect(read(app.dir, 'notes/c.md')).toBe('neu\n');
  });

  it('rebases local work onto external work in other files', async () => {
    await extCommit('ext', { 'notes/b.md': '# B extern\n' });
    await appCommit('app', { 'notes/new.md': 'app\n' });
    expect(await sync(app)).toMatchObject({ status: 'synced', pushed: 1 });
    await git(ext, ['pull', '-q']);
    expect(read(ext, 'notes/new.md')).toBe('app\n');
    expect(read(app.dir, 'notes/b.md')).toBe('# B extern\n');
  });

  it('merges non-overlapping edits in the same file', async () => {
    await extCommit('ext', { 'notes/a.md': PARAS.replace('Absatz 1.', 'Absatz 1 (extern).') });
    await appCommit('app', { 'notes/a.md': PARAS.replace('Absatz 12.', 'Absatz 12 (app).') });
    expect(await sync(app)).toMatchObject({ status: 'synced', pushed: 1 });
    const merged = read(app.dir, 'notes/a.md');
    expect(merged).toContain('Absatz 1 (extern).');
    expect(merged).toContain('Absatz 12 (app).');
  });

  it('stops on a real conflict without losing local work', async () => {
    await extCommit('ext', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 EXTERN.') });
    const local = await appCommit('app', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 APP.') });
    const result = await sync(app);
    expect(result.status).toBe('conflict');
    expect(result.conflict?.files).toEqual(['notes/a.md']);
    // Local commit is still checked out and pinned; no rebase left half-done.
    expect((await git(app.dir, ['rev-parse', 'HEAD'])).trim()).toBe(local);
    expect((await git(app.dir, ['rev-parse', result.conflict!.ref])).trim()).toBe(local);
    expect(existsSync(join(app.dir, '.git', 'rebase-merge'))).toBe(false);
    expect(read(app.dir, 'notes/a.md')).toContain('Absatz 5 APP.');
    expect(await git(app.dir, ['status', '--porcelain'])).toBe('');
    // Nothing was pushed over the external change.
    await git(ext, ['fetch', '-q']);
    expect(await git(ext, ['show', 'origin/main:notes/a.md'])).toContain('Absatz 5 EXTERN.');
  });

  it('does not take a dirty working tree for a conflict', async () => {
    await extCommit('ext', { 'notes/b.md': '# B extern\n' });
    await appCommit('app', { 'notes/new.md': 'app\n' });
    write(app.dir, 'notes/a.md', PARAS + '\nNoch nicht committet.\n');
    // Without a way to commit, the rebase cannot start: an error, not a conflict.
    await expect(sync(app)).rejects.toThrow();
    expect(await git(app.dir, ['for-each-ref', 'refs/kaveyl-wiki/conflicts/'])).toBe('');
    expect(read(app.dir, 'notes/a.md')).toContain('Noch nicht committet.');
    // With it, the pending edit is committed first and goes along.
    const result = await sync({ ...app, commitPending: () => commitPending(app, 'offen', USER) });
    expect(result).toMatchObject({ status: 'synced', pushed: 2 });
    await git(ext, ['pull', '-q']);
    expect(read(ext, 'notes/a.md')).toContain('Noch nicht committet.');
  });

  it('still stops on a real conflict that comes from a pending edit', async () => {
    await extCommit('ext', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 EXTERN.') });
    await appCommit('app', { 'notes/new.md': 'app\n' });
    write(app.dir, 'notes/a.md', PARAS.replace('Absatz 5.', 'Absatz 5 APP.'));
    const result = await sync({ ...app, commitPending: () => commitPending(app, 'offen', USER) });
    expect(result.status).toBe('conflict');
    expect(result.conflict?.files).toEqual(['notes/a.md']);
    const head = (await git(app.dir, ['rev-parse', 'HEAD'])).trim();
    expect((await git(app.dir, ['rev-parse', result.conflict!.ref])).trim()).toBe(head);
    expect(read(app.dir, 'notes/a.md')).toContain('Absatz 5 APP.');
    expect(await git(app.dir, ['status', '--porcelain'])).toBe('');
  });

  it('detects external renames', async () => {
    mkdirSync(join(ext, 'archiv'));
    await git(ext, ['mv', 'notes/a.md', 'archiv/a-umbenannt.md']);
    await git(ext, ['commit', '-q', '-m', 'rename'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'HEAD:main']);
    const result = await sync(app);
    expect(result.incoming).toEqual([{ status: 'R', path: 'archiv/a-umbenannt.md', from: 'notes/a.md' }]);
  });

  it('follows a force-push without resurrecting removed commits', async () => {
    await extCommit('wird verworfen', { 'notes/secret.md': 'versehentlich\n' });
    await sync(app);
    expect(existsSync(join(app.dir, 'notes/secret.md'))).toBe(true);

    // Upstream drops the last commit and force-pushes; meanwhile the app made a local edit.
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    await extCommit('ersatz', { 'notes/b.md': '# B neu\n' }, 'force');
    await appCommit('app lokal', { 'notes/app.md': 'lokal\n' });

    const result = await sync(app);
    expect(result).toMatchObject({ status: 'synced', remoteRewritten: true, pushed: 1 });
    expect(existsSync(join(app.dir, 'notes/secret.md'))).toBe(false);
    expect(read(app.dir, 'notes/app.md')).toBe('lokal\n');
    await git(ext, ['pull', '-q']);
    expect(existsSync(join(ext, 'notes/secret.md'))).toBe(false);
    expect(read(ext, 'notes/app.md')).toBe('lokal\n');
  });

  it('still follows a force-push when the sync that fetched it was aborted', async () => {
    await extCommit('wird verworfen', { 'notes/secret.md': 'versehentlich\n' });
    await sync(app);
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    await extCommit('ersatz', { 'notes/b.md': '# B neu\n' }, 'force');
    await appCommit('app lokal', { 'notes/app.md': 'lokal\n' });
    write(app.dir, 'notes/a.md', PARAS + '\nNoch nicht committet.\n');
    // Fetches the rewritten branch, then stops (pending edit, no way to commit it).
    await expect(sync(app)).rejects.toThrow();

    const result = await sync({ ...app, commitPending: () => commitPending(app, 'offen', USER) });
    expect(result).toMatchObject({ status: 'synced', remoteRewritten: true, pushed: 2 });
    expect(existsSync(join(app.dir, 'notes/secret.md'))).toBe(false);
    expect(read(app.dir, 'notes/app.md')).toBe('lokal\n');
    expect(read(app.dir, 'notes/a.md')).toContain('Noch nicht committet.');
    await git(ext, ['pull', '-q']);
    expect(existsSync(join(ext, 'notes/secret.md'))).toBe(false);
    expect(read(ext, 'notes/app.md')).toBe('lokal\n');
  });

  it('keeps treating a force-push conflict as one after a retry, and syncs once it is resolved', async () => {
    await extCommit('wird verworfen', { 'notes/secret.md': 'versehentlich\n' });
    await sync(app);
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    await extCommit('ersatz', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 EXTERN.') }, 'force');
    await appCommit('app', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 APP.') });
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: true });
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: true, conflict: { files: ['notes/a.md'] } });

    await resolveConflict(app.dir, 'refs/remotes/origin/main', [{ path: 'notes/a.md', content: 'gelöst\n' }], USER);
    expect(await sync(app)).toMatchObject({ status: 'synced', remoteRewritten: false });
    expect(await sync(app)).toMatchObject({ status: 'up-to-date' });
    await git(ext, ['pull', '-q']);
    expect(read(ext, 'notes/a.md')).toBe('gelöst\n');
  });

  it('resolves a force-push conflict on the new server state without bringing back what was removed (AD-048)', async () => {
    await extCommit('wird verworfen', { 'notes/geheim.md': 'geheim\n' });
    await sync(app);
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    await extCommit('ersatz', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 EXTERN.') }, 'force');
    await appCommit('app neu', { 'notes/app.md': 'lokal\n' });
    await appCommit('app konflikt', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 APP.') });
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: true, conflict: { files: ['notes/a.md'] } });

    // Base is the previous server state the own commits were made on, not an older common ancestor.
    const [file, ...more] = await conflictFiles(app.dir, 'refs/remotes/origin/main');
    expect(more).toEqual([]);
    expect(file).toMatchObject({ path: 'notes/a.md', base: PARAS, mine: PARAS.replace('Absatz 5.', 'Absatz 5 APP.'), theirs: PARAS.replace('Absatz 5.', 'Absatz 5 EXTERN.') });
    expect(file!.merged).toContain('<<<<<<<');
    await expect(resolveConflict(app.dir, 'refs/remotes/origin/main', [], USER)).rejects.toThrow(/Neue Konflikte/);

    const merged = PARAS.replace('Absatz 5.', 'Absatz 5 APP und EXTERN.');
    await resolveConflict(app.dir, 'refs/remotes/origin/main', [{ path: 'notes/a.md', content: merged }], USER);
    expect(await sync(app)).toMatchObject({ status: 'synced', remoteRewritten: false, pushed: 1 });
    expect(await sync(app)).toMatchObject({ status: 'up-to-date' });

    // Own work is there, the removed commit neither in the files nor in the history — locally and on the server.
    expect(read(app.dir, 'notes/a.md')).toBe(merged);
    expect(read(app.dir, 'notes/app.md')).toBe('lokal\n');
    expect(existsSync(join(app.dir, 'notes/geheim.md'))).toBe(false);
    expect(await git(app.dir, ['log', '-p', 'HEAD'])).not.toContain('geheim');
    expect((await git(app.dir, ['rev-list', '--merges', 'HEAD'])).trim()).toBe('');
    expect(await git(app.dir, ['status', '--porcelain'])).toBe('');
    await git(ext, ['pull', '-q']);
    expect(read(ext, 'notes/a.md')).toBe(merged);
    expect(read(ext, 'notes/app.md')).toBe('lokal\n');
    expect(existsSync(join(ext, 'notes/geheim.md'))).toBe(false);
    expect(await git(join(root, 'remote.git'), ['log', '-p', 'main'])).not.toContain('geheim');
    // The resolution names the own commits it carries and the person who resolved it.
    const last = await git(ext, ['log', '-1', '--format=%an|%s|%b']);
    expect(last).toMatch(/^Test User\|.*Force-Push.*notes\/a\.md/);
    expect(last).toContain('app neu');
    expect(last).toContain('app konflikt');
  });

  it('writes a force-push resolution as a regular file even where the merged tree has a symlink', async () => {
    await extCommit('wird verworfen', { 'notes/geheim.md': 'geheim\n' });
    await sync(app);
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    // Both sides turn the note into a symlink (different targets): a conflict whose merged entry is a symlink.
    rmSync(join(ext, 'notes/a.md'));
    symlinkSync('/etc/hostname', join(ext, 'notes/a.md'));
    await extCommit('symlink', {}, 'force');
    rmSync(join(app.dir, 'notes/a.md'));
    symlinkSync('b.md', join(app.dir, 'notes/a.md'));
    await commitPending(app, 'app', USER);
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: true, conflict: { files: ['notes/a.md'] } });
    await resolveConflict(app.dir, 'refs/remotes/origin/main', [{ path: 'notes/a.md', content: 'gelöst\n' }], USER);
    expect((await git(app.dir, ['ls-tree', '--format=%(objectmode)', 'HEAD', '--', 'notes/a.md'])).trim()).toBe('100644');
    expect(lstatSync(join(app.dir, 'notes/a.md')).isSymbolicLink()).toBe(false);
    expect(read(app.dir, 'notes/a.md')).toBe('gelöst\n');
  });

  it('lists the same conflict paths over time when a force-push turns a note into a symlink', async () => {
    await extCommit('wird verworfen', { 'notes/geheim.md': 'geheim\n' });
    await sync(app);
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    rmSync(join(ext, 'notes/a.md'));
    symlinkSync('b.md', join(ext, 'notes/a.md'));
    await extCommit('symlink', {}, 'force');
    await appCommit('app', { 'notes/a.md': 'app\n' });
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: true });
    // Git renames one side of a file/symlink conflict after its commit: that name must not change between loading and resolving.
    const paths = (await conflictFiles(app.dir, 'refs/remotes/origin/main')).map((f) => f.path);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await conflictFiles(app.dir, 'refs/remotes/origin/main')).map((f) => f.path)).toEqual(paths);
    const resolutions = paths.map((path) => ({ path, content: path === 'notes/a.md' ? 'gelöst\n' : null }));
    await resolveConflict(app.dir, 'refs/remotes/origin/main', resolutions, USER);
    expect(read(app.dir, 'notes/a.md')).toBe('gelöst\n');
    expect((await git(app.dir, ['ls-files', 'notes'])).trim().split('\n')).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('remembers the previous server state for the resolution when a force-push conflict stops the sync', async () => {
    await extCommit('wird verworfen', { 'notes/geheim.md': 'geheim\n' });
    await sync(app);
    // A clone that never recorded it (synced before refs/kaveyl-wiki/synced existed).
    await git(app.dir, ['update-ref', '-d', 'refs/kaveyl-wiki/synced/main']);
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    await extCommit('ersatz', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 EXTERN.') }, 'force');
    await appCommit('app', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 APP.') });
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: true });
    await resolveConflict(app.dir, 'refs/remotes/origin/main', [{ path: 'notes/a.md', content: 'gelöst\n' }], USER);
    expect(await sync(app)).toMatchObject({ status: 'synced', pushed: 1 });
    expect(existsSync(join(app.dir, 'notes/geheim.md'))).toBe(false);
    expect(await git(join(root, 'remote.git'), ['log', '-p', 'main'])).not.toContain('geheim');
  });

  it('keeps the merge commit for an ordinary conflict', async () => {
    await extCommit('ext', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 EXTERN.') });
    await appCommit('app', { 'notes/a.md': PARAS.replace('Absatz 5.', 'Absatz 5 APP.') });
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: false });
    await resolveConflict(app.dir, 'refs/remotes/origin/main', [{ path: 'notes/a.md', content: 'gelöst\n' }], USER);
    expect((await git(app.dir, ['log', '-1', '--format=%P %s'])).trim()).toMatch(/^\w+ \w+ merge: Konflikt aufgelöst \(notes\/a\.md\) \(Kaveyl Wiki\)$/);
    expect(await sync(app)).toMatchObject({ status: 'synced', pushed: 2 });
  });

  it('resolves an ordinary conflict against a symlink without writing through it', async () => {
    writeFileSync(join(root, 'outside.txt'), 'draußen\n');
    rmSync(join(ext, 'notes/a.md'));
    symlinkSync('../../outside.txt', join(ext, 'notes/a.md'));
    await extCommit('symlink', {});
    await appCommit('app', { 'notes/a.md': 'app\n' });
    expect(await sync(app)).toMatchObject({ status: 'conflict', remoteRewritten: false });
    const paths = (await conflictFiles(app.dir, 'refs/remotes/origin/main')).map((f) => f.path);
    expect(paths).toContain('notes/a.md');
    await resolveConflict(app.dir, 'refs/remotes/origin/main', paths.map((path) => ({ path, content: path === 'notes/a.md' ? 'gelöst\n' : null })), USER);
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('draußen\n');
    expect(lstatSync(join(app.dir, 'notes/a.md')).isFile()).toBe(true);
    expect(read(app.dir, 'notes/a.md')).toBe('gelöst\n');
    expect((await git(app.dir, ['ls-tree', '--format=%(objectmode)', 'HEAD', '--', 'notes/a.md'])).trim()).toBe('100644');
  });

  it('follows a force-push that only removed commits', async () => {
    await extCommit('wird verworfen', { 'notes/secret.md': 'x\n' });
    await sync(app);
    await git(ext, ['reset', '-q', '--hard', 'HEAD~1']);
    await git(ext, ['push', '-q', '--force', 'origin', 'HEAD:main']);
    const result = await sync(app);
    expect(result).toMatchObject({ status: 'synced', remoteRewritten: true, pushed: 0 });
    expect(existsSync(join(app.dir, 'notes/secret.md'))).toBe(false);
  });
});

describe('co-author trailers (sec-004)', () => {
  it('a line break or <…> in a name cannot add made-up co-authors', async () => {
    write(app.dir, 'notes/a.md', PARAS + '\nZusammen.\n');
    const eve = { name: 'Eve\nCo-authored-by: Chefin Admin <chefin@firma.example>', email: 'eve@users.kaveyl-wiki.invalid' };
    const tab = { name: 'Max\r\t<max@x.example> Muster', email: 'max@users.kaveyl-wiki.invalid' };
    expect(await commitPending(app, 'zusammen', USER, undefined, [eve, tab])).not.toBeNull();
    const trailers = (await git(app.dir, ['log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly,separator=%x1f)'])).trim().split('\x1f');
    expect(trailers).toEqual(['Eve Co-authored-by: Chefin Admin chefin@firma.example <eve@users.kaveyl-wiki.invalid>', 'Max max@x.example Muster <max@users.kaveyl-wiki.invalid>']);
  });
});
