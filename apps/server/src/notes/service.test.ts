import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { openDb, type DB } from '../db/db.js';
import { EventBus, type AppEvent } from '../events.js';
import { git } from '../git/git.js';
import { fileBytesAt } from '../git/history.js';
import { Indexer } from '../index/indexer.js';
import { MountManager } from '../mounts/manager.js';
import { MountStore, PathError, repoDir, type Mount } from '../mounts/model.js';
import { SecretStore } from '../secrets.js';
import { ActivityLog } from '../activity.js';
import { ConflictError, ForbiddenError, NotFoundError, NoteService, fileNameFor, localReferences } from './service.js';

const USER = { name: 'Anna', email: 'anna@example.test' };
const silent = { info() {}, warn() {}, error() {} };
const EXT_ENV = { GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' };

let root: string;
let db: DB;
let config: Config;
let events: AppEvent[];
let manager: MountManager;
let notes: NoteService;
let indexer: Indexer;

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-notes-'));
  config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), syncIntervalSec: 0, commitDelaySec: 0 };
  db = openDb(':memory:');
  const bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
  indexer = new Indexer(db, config.dataPath);
  manager = new MountManager(config, new MountStore(db), indexer, SecretStore.open(db, config.configPath), bus, silent);
  notes = new NoteService(manager, config.dataPath, indexer);
});

afterEach(async () => {
  await manager.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function remoteFixture(): Promise<{ remote: string; ext: string; mount: Mount }> {
  const remote = join(root, 'remote.git');
  const ext = join(root, 'ext');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(root, ['clone', '-q', remote, ext]);
  await git(ext, ['checkout', '-q', '-b', 'main']);
  mkdirSync(join(ext, 'docs'));
  writeFileSync(join(ext, 'docs/home.md'), '---\ntitle: Home\n---\n\n# Willkommen\n\n* alt\n* stil\n\nAbsatz eins.\n');
  writeFileSync(join(ext, 'README.md'), '# Repo\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'init'], { env: EXT_ENV });
  await git(ext, ['push', '-q', 'origin', 'main']);
  const mount = await manager.create({ name: 'Docs', type: 'remote', source: remote, branch: 'main', subpath: 'docs' });
  return { remote, ext, mount };
}

describe('re-created repository', () => {
  it('gets a fresh clone instead of the stale one of a removed mount (no bogus renames, no link repair)', async () => {
    const { remote, ext, mount } = await remoteFixture();
    // Old history: the note lived elsewhere (like a rename done in an earlier life of the repo).
    await git(ext, ['mv', 'docs/home.md', 'docs/start.md']);
    await git(ext, ['commit', '-q', '-m', 'mv'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    await manager.sync(mount);
    await manager.remove(mount.id);
    // Repository deleted and created again under the same name, with a new history.
    rmSync(remote, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
    await git(root, ['clone', '-q', remote, ext]);
    await git(ext, ['checkout', '-q', '-b', 'main']);
    mkdirSync(join(ext, 'docs/sub'), { recursive: true });
    const md = '# Neu\n\nZurück zur [Start](../start.md).\n';
    writeFileSync(join(ext, 'docs/sub/home.md'), md);
    writeFileSync(join(ext, 'docs/start.md'), '---\ntitle: Home\n---\n\n# Willkommen\n\n* alt\n* stil\n\nAbsatz eins.\n');
    await git(ext, ['add', '-A']);
    await git(ext, ['commit', '-q', '-m', 'neu'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    const seen = events.length;
    const again = await manager.create({ name: 'Docs', type: 'remote', source: remote, branch: 'main', subpath: 'docs' });
    expect(again.syncStatus).toBe('ok');
    const note = await notes.read(again, 'sub/home.md');
    expect(note.raw).toBe(md);
    expect(events.slice(seen).some((e) => e.type === 'tree' && (e as { change?: { renamed: unknown[] } }).change?.renamed.length)).toBe(false);
    const aside = readdirSync(join(config.dataPath, 'repos')).filter((n) => n.includes('.alt-'));
    expect(aside).toHaveLength(1);
  });
});

describe('NoteService with a remote mount', () => {
  it('clones, indexes the subpath and reads notes', async () => {
    const { mount } = await remoteFixture();
    expect(mount.syncStatus).toBe('ok');
    expect(indexer.all(mount.id).map((e) => e.path)).toEqual(['home.md']);
    const note = await notes.read(mount, 'home.md', { doc: true });
    expect(note.title).toBe('Home');
    expect(note.doc!.content?.[0]).toMatchObject({ type: 'heading' });
    // Only the app's editor needs the document.
    expect((await notes.read(mount, 'home.md')).doc).toBeNull();
  });

  it('saves a minimal diff, commits with the user as author and pushes', async () => {
    const { ext, mount } = await remoteFixture();
    const note = await notes.read(mount, 'home.md', { doc: true });
    const doc = structuredClone(note.doc!);
    const para = doc.content!.find((n) => n.type === 'paragraph')!;
    para.content![0]!.text = 'Absatz eins, bearbeitet.';
    const saved = await notes.saveDoc(mount, 'home.md', doc, note.hash, USER);
    expect(saved.changed).toBe(true);
    await manager.flush();
    await git(ext, ['pull', '-q', 'origin', 'main']);
    // Frontmatter and the untouched `*` list keep their bytes; only the paragraph changed.
    expect(readFileSync(join(ext, 'docs/home.md'), 'utf8')).toBe('---\ntitle: Home\n---\n\n# Willkommen\n\n* alt\n* stil\n\nAbsatz eins, bearbeitet.\n');
    expect((await git(ext, ['log', '-1', '--format=%an'])).trim()).toBe('Anna');
  });

  it('reports pending edits and git state', async () => {
    const { mount } = await remoteFixture();
    expect(await manager.status(mount)).toEqual({ pending: 0, git: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, uncommitted: 0 } });
    const cfg = { ...config, commitDelaySec: 3600 };
    const slow = new MountManager(cfg, new MountStore(db), indexer, SecretStore.open(db, config.configPath), new EventBus(), silent);
    const slowNotes = new NoteService(slow, config.dataPath, indexer);
    const note = await slowNotes.read(mount, 'home.md');
    await slowNotes.saveRaw(mount, 'home.md', note.raw + '\nMehr.\n', note.hash, USER);
    expect(await slow.status(mount)).toMatchObject({ pending: 1, git: { uncommitted: 1, ahead: 0 } });
    await slow.flush();
    expect(await slow.status(mount)).toMatchObject({ pending: 0, git: { uncommitted: 0, ahead: 0 } });
    await slow.stop();
  });

  it('waits for the mount\'s commit pause unless told to commit now', async () => {
    const { ext, mount } = await remoteFixture();
    const prod = new MountManager({ ...config, commitDelaySec: null }, new MountStore(db), indexer, SecretStore.open(db, config.configPath), new EventBus(), silent);
    const prodNotes = new NoteService(prod, config.dataPath, indexer);
    const m = await prod.update(mount.id, { options: { commitIdleSec: 3600 } });
    const note = await prodNotes.read(m, 'home.md');
    await prodNotes.saveRaw(m, 'home.md', note.raw + '\nNoch ein Satz.\n', note.hash, USER);
    await new Promise((r) => setTimeout(r, 300));
    expect((await prod.status(m)).pending).toBe(1);
    await prod.commitNow(m); // what "leaving the note" / Ctrl+S triggers
    await git(ext, ['pull', '-q', 'origin', 'main']);
    expect(readFileSync(join(ext, 'docs/home.md'), 'utf8')).toContain('Noch ein Satz.');
    expect((await prod.status(m)).pending).toBe(0);
    await prod.stop();
  });

  it('commits pending edits before a rebase instead of reporting a conflict that is none', async () => {
    const { ext, mount } = await remoteFixture();
    const prod = new MountManager({ ...config, commitDelaySec: null }, new MountStore(db), indexer, SecretStore.open(db, config.configPath), new EventBus(), silent);
    const prodNotes = new NoteService(prod, config.dataPath, indexer);
    const m = await prod.update(mount.id, { options: { commitIdleSec: 3600 } });
    // A local commit that was not pushed yet (e. g. after a failed push) …
    const dir = repoDir(m, config.dataPath);
    writeFileSync(join(dir, 'docs/lokal.md'), '# Lokal\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'lokal'], { env: EXT_ENV });
    // … new commits on the server …
    writeFileSync(join(ext, 'docs/fremd.md'), '# Fremd\n');
    await git(ext, ['add', '-A']);
    await git(ext, ['commit', '-q', '-m', 'fremd'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    // … and an edit still waiting for its commit pause.
    const note = await prodNotes.read(m, 'home.md');
    await prodNotes.saveRaw(m, 'home.md', note.raw + '\nNoch offen.\n', note.hash, USER);
    const result = await prod.sync(m); // what the interval and the webhook call
    expect(result?.status).toBe('synced');
    expect(prod.get(m.id)!.syncStatus).toBe('ok');
    await git(ext, ['pull', '-q', 'origin', 'main']);
    expect(readFileSync(join(ext, 'docs/home.md'), 'utf8')).toContain('Noch offen.');
    expect(existsSync(join(ext, 'docs/lokal.md'))).toBe(true);
    expect((await git(ext, ['log', '-1', '--format=%an'])).trim()).toBe('Anna');
    expect((await prod.status(m)).pending).toBe(0);
    await prod.stop();
  });

  it('logs what a sync changed, not repeated no-ops or repeated errors', async () => {
    const { ext, mount } = await remoteFixture();
    const activity = new ActivityLog(db);
    const logged = new MountManager(config, new MountStore(db), indexer, SecretStore.open(db, config.configPath), new EventBus(), silent, activity);
    await logged.sync(mount); // up to date → nothing
    writeFileSync(join(ext, 'docs/neu.md'), '# Neu\n');
    await git(ext, ['add', '-A']);
    await git(ext, ['commit', '-qm', 'neu'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    await logged.sync(mount);
    await logged.sync(mount);
    // An unreachable remote fails on every interval but is logged once.
    const broken = new MountStore(db).update(mount.id, { branch: 'gibts-nicht' });
    await logged.sync(broken);
    await logged.sync(broken);
    expect(activity.list().map((e) => `${e.category}:${e.action}:${e.message}`)).toEqual([
      expect.stringMatching(/^error:sync-failed:/),
      'sync:synced:1 Datei vom Server geholt',
    ]);
    await logged.stop();
  });

  it('rejects a save based on a stale hash', async () => {
    const { mount } = await remoteFixture();
    const note = await notes.read(mount, 'home.md');
    await notes.saveRaw(mount, 'home.md', note.raw + '\nZweiter Tab.\n', note.hash, USER);
    await expect(notes.saveRaw(mount, 'home.md', note.raw + '\nErster Tab.\n', note.hash, USER)).rejects.toBeInstanceOf(ConflictError);
    // Two saves at the same moment on the same version: one wins, the other gets the conflict.
    const now = await notes.read(mount, 'home.md');
    const both = await Promise.allSettled([1, 2].map((n) => notes.saveRaw(mount, 'home.md', `${now.raw}\nGleichzeitig ${n}.\n`, now.hash, USER)));
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('pulls external changes on sync', async () => {
    const { ext, mount } = await remoteFixture();
    writeFileSync(join(ext, 'docs/neu.md'), '# Von extern\n');
    await git(ext, ['add', '-A']);
    await git(ext, ['commit', '-q', '-m', 'extern'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    const result = await manager.sync(mount);
    expect(result?.incoming).toEqual([{ status: 'A', path: 'docs/neu.md' }]);
    expect(indexer.get(mount.id, 'neu.md')?.title).toBe('Von extern');
  });

  it('shows the three versions of a conflict and resolves it with a merge commit', async () => {
    const { ext, mount } = await remoteFixture();
    const note = await notes.read(mount, 'home.md');
    await notes.saveRaw(mount, 'home.md', note.raw.replace('Absatz eins.', 'Absatz eins, meine Fassung.'), note.hash, USER);
    writeFileSync(join(ext, 'docs/home.md'), note.raw.replace('Absatz eins.', 'Absatz eins, fremde Fassung.'));
    await git(ext, ['commit', '-qam', 'fremd'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    await manager.flush();
    expect(manager.get(mount.id)!.syncStatus).toBe('conflict');
    // Repeated syncs keep a single safety ref.
    await manager.sync(mount);
    const dir = repoDir(mount, config.dataPath);
    expect((await git(dir, ['for-each-ref', 'refs/kaveyl-wiki/conflicts/'])).trim().split('\n')).toHaveLength(1);

    const [file, ...more] = await manager.conflict(mount);
    expect(more).toEqual([]);
    expect(file!.path).toBe('docs/home.md');
    expect(file!.base).toContain('Absatz eins.');
    expect(file!.mine).toContain('meine Fassung');
    expect(file!.theirs).toContain('fremde Fassung');
    expect(file!.merged).toMatch(/<<<<<<<[\s\S]*meine Fassung[\s\S]*=======[\s\S]*fremde Fassung[\s\S]*>>>>>>>/);

    const merged = note.raw.replace('Absatz eins.', 'Absatz eins, beide Fassungen.');
    await expect(manager.resolveConflict(mount, [], USER)).rejects.toThrow(/Neue Konflikte/);
    // Nothing but the conflicted files: another file in the repository stays untouched.
    await expect(manager.resolveConflict(mount, [{ path: 'docs/home.md', content: merged }, { path: '.gitea/workflows/x.yml', content: 'on: push' }], USER)).rejects.toThrow(/Keine passenden Konflikte/);
    expect(existsSync(join(dir, '.gitea/workflows/x.yml'))).toBe(false);
    const result = await manager.resolveConflict(mount, [{ path: 'docs/home.md', content: merged }], USER);
    expect(result?.status).toBe('synced');
    expect(manager.get(mount.id)!.syncStatus).toBe('ok');
    expect((await git(dir, ['for-each-ref', 'refs/kaveyl-wiki/conflicts/'])).trim()).toBe('');
    await git(ext, ['pull', '-q', 'origin', 'main']);
    expect(readFileSync(join(ext, 'docs/home.md'), 'utf8')).toBe(merged);
    expect((await git(ext, ['log', '-1', '--format=%an %s'])).trim()).toBe('Anna merge: Konflikt aufgelöst (docs/home.md) (Kaveyl Wiki)');
    expect((await notes.read(mount, 'home.md')).raw).toBe(merged);
  });

  it('keeps the identity of notes renamed upstream and repairs links in a fix(links) commit', async () => {
    const { ext, mount } = await remoteFixture();
    writeFileSync(join(ext, 'docs/index.md'), '# Index\n\n[Start](home.md)\n');
    await git(ext, ['add', '-A']);
    await git(ext, ['commit', '-q', '-m', 'index'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    await manager.sync(mount);
    const id = indexer.get(mount.id, 'home.md')!.noteId;
    manager.onRenamed((m, renamed) => void notes.repairLinks(m, renamed, USER, [], { message: 'fix(links): test' }));
    await git(ext, ['mv', 'docs/home.md', 'docs/start.md']);
    await git(ext, ['commit', '-q', '-m', 'umbenannt'], { env: EXT_ENV });
    await git(ext, ['push', '-q', 'origin', 'main']);
    await manager.sync(mount);
    expect(indexer.get(mount.id, 'start.md')!.noteId).toBe(id);
    await until(() => readFileSync(join(repoDir(mount, config.dataPath), 'docs/index.md'), 'utf8').includes('start.md'));
    await manager.flush();
    await git(ext, ['pull', '-q', 'origin', 'main']);
    expect(readFileSync(join(ext, 'docs/index.md'), 'utf8')).toBe('# Index\n\n[Start](start.md)\n');
    expect((await git(ext, ['log', '-1', '--format=%s'])).trim()).toBe('fix(links): test');
  });
});

describe('commit message of a batch', () => {
  it('a note created and filled right away (API, MCP, typing at once) is committed as „angelegt“', async () => {
    const { mount } = await remoteFixture();
    config.commitDelaySec = 60;
    const path = await notes.create(mount, '', 'Neu', 'file', USER);
    const { hash } = await notes.read(mount, path);
    await notes.saveRaw(mount, path, '# Neu\n\nGleich mit Text.\n', hash, USER);
    await manager.flush();
    expect((await git(repoDir(mount, config.dataPath), ['log', '-1', '--format=%s'])).trim()).toBe(`docs: ${path} angelegt (Kaveyl Wiki)`);
    // Another file in the same batch: the general message again.
    await notes.saveRaw(mount, 'home.md', '# Willkommen\n', (await notes.read(mount, 'home.md')).hash, USER);
    await notes.saveRaw(mount, path, '# Neu\n', (await notes.read(mount, path)).hash, USER);
    await manager.flush();
    expect((await git(repoDir(mount, config.dataPath), ['log', '-1', '--format=%s'])).trim()).toBe('docs: 2 Notizen bearbeitet (Kaveyl Wiki)');
  });

  it('several people in one batch: each their own commit; a note both edited names the other as co-author', async () => {
    const { mount } = await remoteFixture();
    config.commitDelaySec = 60;
    const MARIA = { name: 'Maria', email: 'maria@example.test' };
    const TOM = { name: 'Tom', email: 'tom@example.test' };
    const a = await notes.create(mount, '', 'Von Maria', 'file', MARIA);
    const b = await notes.create(mount, '', 'Von Tom', 'file', TOM);
    await manager.flush();
    await notes.saveRaw(mount, a, '# Von Maria\n\nMaria schreibt.\n', (await notes.read(mount, a)).hash, MARIA);
    await notes.saveRaw(mount, 'home.md', '# Willkommen\n\nMaria.\n', (await notes.read(mount, 'home.md')).hash, MARIA);
    await notes.saveRaw(mount, b, '# Von Tom\n\nTom schreibt.\n', (await notes.read(mount, b)).hash, TOM);
    // A new object per request, as from the session.
    await notes.saveRaw(mount, 'home.md', '# Willkommen\n\nMaria. Tom.\n', (await notes.read(mount, 'home.md')).hash, { ...TOM });
    await manager.flush();
    const dir = repoDir(mount, config.dataPath);
    const commit = async (rev: string) => {
      const [head, ...files] = (await git(dir, ['show', '--format=%an|%s|%(trailers:key=Co-authored-by,valueonly,separator=;)', '--name-only', rev])).trim().split('\n');
      return { head, files: files.filter(Boolean).sort() };
    };
    const inRepo = (p: string) => (mount.subpath ? `${mount.subpath}/${p}` : p);
    expect(await commit('HEAD~2')).toEqual({ head: `Maria|docs: ${a} bearbeitet (Kaveyl Wiki)|`, files: [inRepo(a)] });
    // Tom's files: the shared one with Maria as co-author, his own one without – co-authors belong to a whole commit.
    expect(await commit('HEAD~1')).toEqual({ head: `Tom|docs: ${inRepo('home.md').slice(mount.subpath ? mount.subpath.length + 1 : 0)} bearbeitet (Kaveyl Wiki)|Maria <maria@example.test>`, files: [inRepo('home.md')] });
    expect(await commit('HEAD')).toEqual({ head: `Tom|docs: ${b} bearbeitet (Kaveyl Wiki)|`, files: [inRepo(b)] });
    // The history names both for the shared note, only Tom for his own.
    expect((await notes.history(mount, 'home.md')).versions[0]).toMatchObject({ author: 'Tom', coAuthors: ['Maria'] });
    const own = (await notes.history(mount, b)).versions[0]!;
    expect([own.author, own.coAuthors ?? []]).toEqual(['Tom', []]);
  });
});

describe('NoteService with a local mount', () => {
  let mount: Mount;
  let dir: string;

  beforeEach(async () => {
    dir = join(root, 'local');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Lokal\n');
    writeFileSync(join(dir, 'src', 'code.ts'), 'export {}\n');
    writeFileSync(join(dir, 'src', 'NOTES.md'), '# Notizen im Code\n');
    mount = await manager.create({ name: 'Lokal', type: 'local', source: dir });
  });

  it('creates notes and folders with readable file names', async () => {
    expect(await notes.create(mount, '', 'Mein Plan: v2', 'file', USER)).toBe('Mein Plan - v2.md');
    expect(await notes.create(mount, '', 'Mein Plan: v2', 'file', USER)).toBe('Mein Plan - v2 2.md');
    expect(await notes.create(mount, 'src', 'Ideen', 'dir', USER)).toBe('src/Ideen');
    expect(readFileSync(join(dir, 'src/Ideen/index.md'), 'utf8')).toMatch(/^---\nid: ([0-9A-Z]{26})\n---\n# Ideen\n$/);
    // The frontmatter id is the note's identity.
    const fmId = /id: (\w+)/.exec(readFileSync(join(dir, 'src/Ideen/index.md'), 'utf8'))![1];
    expect(indexer.get(mount.id, 'src/Ideen/index.md')?.noteId).toBe(fmId);
    const plain = await manager.update(mount.id, { options: { writeMetadata: false } });
    expect(readFileSync(join(dir, await notes.create(plain, '', 'Ohne', 'file', USER)), 'utf8')).toBe('# Ohne\n');
    expect(indexer.get(mount.id, 'src/Ideen')?.kind).toBe('dir');
  });

  it('moves notes and deletes folders without touching code files', async () => {
    expect(await notes.move(mount, 'src/NOTES.md', 'archiv/NOTES.md', USER)).toBe('archiv/NOTES.md');
    expect(indexer.get(mount.id, 'archiv/NOTES.md')).not.toBeNull();
    await notes.create(mount, 'src', 'Temp', 'file', USER);
    await notes.delete(mount, 'src', USER);
    expect(existsSync(join(dir, 'src/code.ts'))).toBe(true);
    expect(existsSync(join(dir, 'src/Temp.md'))).toBe(false);
    expect(indexer.get(mount.id, 'src')).toBeNull();
  });

  it('does not commit in local mounts by default', async () => {
    await git(dir, ['init', '-q']);
    await notes.create(mount, '', 'Neu', 'file', USER);
    await manager.commitNow(mount);
    expect(await git(dir, ['status', '--porcelain'])).toContain('Neu.md');
  });

  it('an editor still saving to a just-moved note lands at its new place – only with rights there and the same content', async () => {
    const before = await notes.read(mount, 'README.md');
    await notes.move(mount, 'README.md', 'Archiv/LIESMICH.md', USER);
    const all = () => true;
    // The API and MCP stay strict: the old path is gone.
    await expect(notes.saveRaw(mount, 'README.md', '# Neu\n', before.hash, USER)).rejects.toBeInstanceOf(NotFoundError);
    await expect(notes.saveRaw(mount, 'README.md', '# Neu\n', before.hash, USER, { followMove: () => false })).rejects.toBeInstanceOf(NotFoundError);
    const res = await notes.saveRaw(mount, 'README.md', '# Neu\n', before.hash, USER, { followMove: all });
    expect(res.path).toBe('Archiv/LIESMICH.md');
    expect((await notes.read(mount, 'Archiv/LIESMICH.md')).raw).toBe('# Neu\n');
    // Changed meanwhile (the old hash): a conflict as always, nothing overwritten.
    await expect(notes.saveRaw(mount, 'README.md', '# Alt\n', before.hash, USER, { followMove: all })).rejects.toBeInstanceOf(ConflictError);
  });

  it('announces own saves to open editors, with the new hash; an unchanged save stays quiet', async () => {
    const before = await notes.read(mount, 'README.md');
    events.length = 0;
    const res = await notes.saveRaw(mount, 'README.md', '# Von Maria\n', before.hash, USER);
    expect(events).toContainEqual({ type: 'note', mountId: mount.id, path: 'README.md', hash: res.hash });
    events.length = 0;
    await notes.saveRaw(mount, 'README.md', '# Von Maria\n', res.hash, USER);
    expect(events.filter((e) => e.type === 'note')).toEqual([]);
  });

  it('tells open editors at once when a note is deleted', async () => {
    events.length = 0;
    await notes.delete(mount, 'README.md', USER);
    expect(events).toContainEqual({ type: 'note', mountId: mount.id, path: 'README.md', hash: null });
  });

  it('picks up external edits through the watcher', async () => {
    writeFileSync(join(dir, 'README.md'), '# Extern geändert\n');
    await until(() => indexer.get(mount.id, 'README.md')?.title === 'Extern geändert');
    expect(events.some((e) => e.type === 'note' && e.path === 'README.md')).toBe(true);
  });

  it('refuses writes to read-only mounts and non-UTF-8 files', async () => {
    writeFileSync(join(dir, 'latin1.md'), Buffer.from([0x23, 0x20, 0xe4, 0x0a]));
    await expect(notes.read(mount, 'latin1.md')).rejects.toBeInstanceOf(ForbiddenError);
    const ro = await manager.update(mount.id, { options: { readonly: true } });
    await expect(notes.create(ro, '', 'x', 'file', USER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('link repair after renames', () => {
  let mount: Mount;
  let dir: string;
  const write = (rel: string, content: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');

  beforeEach(async () => {
    dir = join(root, 'wiki');
    write('docs/home.md', '# Home\n');
    write('docs/plan/roadmap.md', '# Roadmap\n\n[Home](../home.md) ![Bild](../bilder/a.png) [Ziel](ziel.md#teil)\n');
    write('docs/plan/ziel.md', '# Ziel\n');
    write('docs/plan/index.md', '# Plan\n');
    write('docs/bilder/a.png', 'png');
    write('start.md',
      '---\ntitle: Start\n---\n# Start\n\n* [Roadmap](docs/plan/roadmap.md "Titel")\n* [Wiki.js](/docs/plan/roadmap)\n* [Ordner](docs/plan/)\n' +
      '* [kaputt](gibts/nicht.md) [extern](https://x.test/docs/plan/roadmap.md)\n\n[ref]: <docs/plan/roadmap.md>\n');
    mount = await manager.create({ name: 'Wiki', type: 'local', source: dir });
  });

  it('rewrites incoming links in their own style and the moved note\'s relative links', async () => {
    expect(await notes.move(mount, 'docs/plan/roadmap.md', 'archiv/2026/Roadmap alt.md', USER)).toBe('archiv/2026/Roadmap alt.md');
    expect(read('start.md')).toBe(
      '---\ntitle: Start\n---\n# Start\n\n* [Roadmap](archiv/2026/Roadmap%20alt.md "Titel")\n* [Wiki.js](/archiv/2026/Roadmap%20alt)\n* [Ordner](docs/plan/)\n' +
        '* [kaputt](gibts/nicht.md) [extern](https://x.test/docs/plan/roadmap.md)\n\n[ref]: <archiv/2026/Roadmap alt.md>\n',
    );
    expect(read('archiv/2026/Roadmap alt.md')).toBe('# Roadmap\n\n[Home](../../docs/home.md) ![Bild](../../docs/bilder/a.png) [Ziel](../../docs/plan/ziel.md#teil)\n');
    expect(indexer.backlinks(mount, 'archiv/2026/Roadmap alt.md').map((b) => b.path)).toEqual(['start.md']);
  });

  it('moves a folder: links inside stay, links from outside follow, folder links too', async () => {
    await notes.move(mount, 'docs/plan', 'projekte/plan', USER);
    expect(read('projekte/plan/roadmap.md')).toBe('# Roadmap\n\n[Home](../../docs/home.md) ![Bild](../../docs/bilder/a.png) [Ziel](ziel.md#teil)\n');
    expect(read('start.md')).toContain('* [Roadmap](projekte/plan/roadmap.md "Titel")\n* [Wiki.js](/projekte/plan/roadmap)\n* [Ordner](projekte/plan/)\n');
    expect(read('start.md')).toContain('[ref]: <projekte/plan/roadmap.md>');
  });

  it('repairs renames made outside the app (dry run first), and leaves links that still work', async () => {
    const renamed: { from: string; to: string }[] = [];
    manager.onRenamed((_m, r) => renamed.push(...r));
    renameSync(join(dir, 'docs/plan/ziel.md'), join(dir, 'docs/ziel-neu.md'));
    await until(() => renamed.length > 0);
    expect(renamed).toEqual([{ from: 'docs/plan/ziel.md', to: 'docs/ziel-neu.md' }]);
    const dry = await notes.repairLinks(mount, renamed, USER, [], { dryRun: true });
    expect(dry).toEqual({ files: ['docs/plan/roadmap.md'], links: 1 });
    expect(read('docs/plan/roadmap.md')).toContain('[Ziel](ziel.md#teil)');
    await notes.repairLinks(mount, renamed, USER);
    expect(read('docs/plan/roadmap.md')).toContain('[Ziel](../ziel-neu.md#teil)');
    // Second run: nothing left to do.
    expect(await notes.repairLinks(mount, renamed, USER, [], { dryRun: true })).toEqual({ files: [], links: 0 });
  });
});

describe('history and trash', () => {
  let mount: Mount;
  let dir: string;
  const commit = async (msg: string) => {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', msg], { env: EXT_ENV });
  };

  beforeEach(async () => {
    dir = join(root, 'repo');
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    await git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'wiki/a.md'), '# A\n\neins\n');
    writeFileSync(join(dir, 'wiki/weg.md'), '# Weg\n\nwird gelöscht\n');
    mkdirSync(join(dir, 'wiki/sonderfälle'));
    writeFileSync(join(dir, 'wiki/sonderfälle/größe prüfen.md'), '# Größe\n');
    await commit('erste');
    writeFileSync(join(dir, 'wiki/a.md'), '# A\n\nzwei\n');
    await commit('zweite');
    await git(dir, ['mv', 'wiki/a.md', 'wiki/b.md']);
    await commit('umbenannt');
    // The mount is a sub-folder of the repository.
    mount = await manager.create({ name: 'Wiki', type: 'local', source: join(dir, 'wiki') });
  });

  it('lists versions across renames, shows diffs and restores as a new change', async () => {
    const { git: isGit, versions } = await notes.history(mount, 'b.md');
    expect(isGit).toBe(true);
    expect(versions.map((v) => [v.subject, v.path, v.author])).toEqual([
      ['umbenannt', 'b.md', 'Ext'],
      ['zweite', 'a.md', 'Ext'],
      ['erste', 'a.md', 'Ext'],
    ]);
    const [, second, first] = versions;
    expect(await notes.version(mount, first!.commit, first!.path)).toBe('# A\n\neins\n');
    expect(await notes.diff(mount, 'b.md', first!, second!)).toBe('@@ -1,3 +1,3 @@\n # A\n \n-eins\n+zwei\n');
    expect(await notes.diff(mount, 'b.md', second!, null)).toBe('');

    const note = await notes.read(mount, 'b.md');
    await expect(notes.restoreVersion(mount, 'b.md', first!.commit, first!.path, 'veraltet', USER)).rejects.toBeInstanceOf(ConflictError);
    await notes.restoreVersion(mount, 'b.md', first!.commit, first!.path, note.hash, USER);
    expect(readFileSync(join(dir, 'wiki/b.md'), 'utf8')).toBe('# A\n\neins\n');
    // Not a rewrite: the history is unchanged, the restore is a normal (uncommitted) edit.
    expect((await notes.history(mount, 'b.md')).versions).toHaveLength(3);
    await expect(notes.version(mount, 'zzz', 'a.md')).rejects.toBeInstanceOf(PathError);
    // Only notes: no dotfiles or other files from the history.
    for (const p of ['.env', 'skript.sh']) await expect(notes.version(mount, first!.commit, p)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a copy (or a new note with nearly the same text) starts its own history – none of the original’s versions', async () => {
    writeFileSync(join(dir, 'wiki/kopie.md'), '# A\n\nzwei\n');
    await commit('kopiert');
    expect((await notes.history(mount, 'kopie.md')).versions.map((v) => [v.subject, v.path])).toEqual([['kopiert', 'kopie.md']]);
    // The original keeps all of its own.
    expect((await notes.history(mount, 'b.md')).versions).toHaveLength(3);
  });

  it('lists deleted notes (one entry per commit) and brings them back', async () => {
    rmSync(join(dir, 'wiki/weg.md'));
    rmSync(join(dir, 'wiki/sonderfälle/größe prüfen.md'));
    await commit('gelöscht');
    const trash = await notes.trash(mount);
    // Umlauts/spaces in paths must not be hidden by git's path quoting.
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ source: 'git', path: '', isDir: true, subject: 'gelöscht', files: ['sonderfälle/größe prüfen.md', 'weg.md'] });
    expect((await notes.restoreFromTrash(mount, trash[0]!.id, ['sonderfälle/größe prüfen.md'], USER)).paths).toEqual(['sonderfälle/größe prüfen.md']);
    expect((await notes.history(mount, 'sonderfälle/größe prüfen.md')).versions.map((v) => v.path)).toEqual(['sonderfälle/größe prüfen.md']);
    // What exists again is no longer in the entry; the rest comes back with "all".
    expect((await notes.trash(mount))[0]!.files).toEqual(['weg.md']);
    expect((await notes.restoreFromTrash(mount, trash[0]!.id, undefined, USER)).paths).toEqual(['weg.md']);
    expect(readFileSync(join(dir, 'wiki/weg.md'), 'utf8')).toBe('# Weg\n\nwird gelöscht\n');
    expect(await notes.trash(mount)).toEqual([]);
    expect(indexer.get(mount.id, 'weg.md')).not.toBeNull();
    // Hidden entries (emptied / older than the retention) stay in the history.
    rmSync(join(dir, 'wiki/weg.md'));
    await commit('nochmal');
    expect(await notes.trash(mount)).toHaveLength(1);
    expect(await notes.trash(mount, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('keeps notes deleted in the app in the folder trash without auto-commit', async () => {
    expect(await notes.trashMode(mount)).toBe('folder');
    await notes.delete(mount, 'sonderfälle', USER);
    expect(existsSync(join(dir, 'wiki/sonderfälle'))).toBe(false);
    expect(indexer.get(mount.id, 'sonderfälle/größe prüfen.md')).toBeNull();
    // Git never sees the trash, the tree never shows it.
    expect(await git(dir, ['status', '--porcelain'])).not.toContain('.kaveyl-wiki');
    const [item] = await notes.trash(mount);
    expect(item).toMatchObject({ source: 'folder', path: 'sonderfälle', isDir: true, files: ['sonderfälle/größe prüfen.md'], author: 'Anna' });
    expect((await notes.restoreFromTrash(mount, item!.id, undefined, USER)).paths).toEqual(['sonderfälle/größe prüfen.md']);
    expect(readFileSync(join(dir, 'wiki/sonderfälle/größe prüfen.md'), 'utf8')).toBe('# Größe\n');
    expect(indexer.get(mount.id, 'sonderfälle/größe prüfen.md')).not.toBeNull();
    expect(await notes.trash(mount)).toEqual([]);

    await notes.delete(mount, 'b.md', USER);
    await notes.delete(mount, 'weg.md', USER);
    const items = await notes.trash(mount);
    expect(items.map((t) => t.path).sort()).toEqual(['b.md', 'weg.md']);
    await notes.purgeFromTrash(mount, items.find((t) => t.path === 'b.md')!.id);
    expect((await notes.trash(mount)).map((t) => t.path)).toEqual(['weg.md']);
    expect(await notes.purgeTrash(mount, new Date(Date.now() - 60_000))).toBe(0);
    expect(await notes.purgeTrash(mount, null)).toBe(1);
    expect(await notes.trash(mount)).toEqual([]);

    // An empty folder (e.g. left behind by a move) is removed without a trash entry.
    mkdirSync(join(dir, 'wiki/leer/innen'), { recursive: true });
    await notes.delete(mount, 'leer', USER);
    expect(existsSync(join(dir, 'wiki/leer'))).toBe(false);
    expect(await notes.trash(mount)).toEqual([]);
  });

  it('deletes for good into the git history with auto-commit', async () => {
    const auto = await manager.update(mount.id, { options: { autoCommit: true } });
    expect(await notes.trashMode(auto)).toBe('git');
    // Work outside the mounted folder (same repository) is not swept into Kaveyl Wiki's commit.
    writeFileSync(join(dir, 'fremd.txt'), 'nicht von Kaveyl Wiki\n');
    await notes.delete(auto, 'weg.md', USER);
    await manager.commitNow(auto);
    expect(existsSync(join(dir, 'wiki/.kaveyl-wiki'))).toBe(false);
    expect((await git(dir, ['status', '--porcelain'])).trim()).toBe('?? fremd.txt');
    expect((await notes.trash(auto)).map((t) => [t.source, t.path])).toEqual([['git', 'weg.md']]);
  });

  it('a note deleted with auto-commit is in the trash at once – even one created moments before (owner 27.10.)', async () => {
    const auto = await manager.update(mount.id, { options: { autoCommit: true } });
    // Created and deleted within the commit pause: never committed before, its content must still come back.
    const neu = await notes.create(auto, '', 'Gleich weg', 'file', USER, undefined, 'wichtiger Text');
    await notes.delete(auto, neu, USER);
    const ordner = await notes.create(auto, '', 'test', 'dir', USER);
    await notes.delete(auto, ordner, USER);
    const items = await notes.trash(auto);
    // The folder holds only its folder note, so its entry is that note (one file per commit is a note entry).
    expect(items.map((t) => [t.source, t.path, t.isDir])).toEqual([['git', 'test/index.md', false], ['git', 'Gleich weg.md', false]]);
    expect((await notes.restoreFromTrash(auto, items[1]!.id, undefined, USER)).paths).toEqual(['Gleich weg.md']);
    expect(readFileSync(join(dir, 'wiki/Gleich weg.md'), 'utf8')).toContain('wichtiger Text');
    // Nothing else waits uncommitted from the deletions.
    expect((await git(dir, ['status', '--porcelain', '--', 'wiki/test'])).trim()).toBe('');
  });

  it('does not wait for a long commit pause before the trash shows a deletion', async () => {
    const slow = new MountManager({ ...config, commitDelaySec: 3600 }, new MountStore(db), indexer, SecretStore.open(db, config.configPath), new EventBus(), silent);
    const slowNotes = new NoteService(slow, config.dataPath, indexer);
    const auto = await slow.update(mount.id, { options: { autoCommit: true } });
    const neu = await slowNotes.create(auto, '', 'Entwurf', 'file', USER, undefined, 'erst eben geschrieben');
    expect((await slow.status(auto)).pending).toBe(1);
    await slowNotes.delete(auto, neu, USER);
    expect((await slow.status(auto)).pending).toBe(0);
    const [item] = await slowNotes.trash(auto);
    expect(item).toMatchObject({ source: 'git', path: 'Entwurf.md', author: 'Anna' });
    await slowNotes.restoreFromTrash(auto, item!.id, undefined, USER);
    expect(readFileSync(join(dir, 'wiki/Entwurf.md'), 'utf8')).toContain('erst eben geschrieben');
    await slow.stop();
  });

  it('restores under another name instead of overwriting (folder and git trash)', async () => {
    // Folder trash: a note with an id comes back next to its successor, with a fresh id.
    writeFileSync(join(dir, 'wiki/weg.md'), '---\nid: 01ALT\n---\n# Weg\n');
    await notes.delete(mount, 'weg.md', USER);
    writeFileSync(join(dir, 'wiki/weg.md'), '---\nid: 01NEU\n---\n# Neu\n');
    const [item] = await notes.trash(mount);
    await expect(notes.restoreFromTrash(mount, item!.id, undefined, USER)).rejects.toBeInstanceOf(ConflictError);
    // Target taken → conflict as well, nothing moved.
    await expect(notes.restoreFromTrash(mount, item!.id, undefined, USER, 'b')).rejects.toBeInstanceOf(ConflictError);
    expect((await notes.restoreFromTrash(mount, item!.id, undefined, USER, 'weg (wiederhergestellt)')).paths).toEqual(['weg (wiederhergestellt).md']);
    const back = readFileSync(join(dir, 'wiki/weg (wiederhergestellt).md'), 'utf8');
    expect(back).toContain('# Weg');
    expect(back).not.toContain('01ALT');
    expect(back).toMatch(/^---\nid: \S+\n---/);
    expect(readFileSync(join(dir, 'wiki/weg.md'), 'utf8')).toContain('01NEU');
    expect(await notes.trash(mount)).toEqual([]);
    // A folder entry goes to a new folder, keeping the layout below it.
    await notes.delete(mount, 'sonderfälle', USER);
    mkdirSync(join(dir, 'wiki/sonderfälle'));
    writeFileSync(join(dir, 'wiki/sonderfälle/größe prüfen.md'), '# Neu\n');
    const [dirItem] = await notes.trash(mount);
    expect((await notes.restoreFromTrash(mount, dirItem!.id, undefined, USER, 'archiv/sonderfälle alt')).paths).toEqual(['archiv/sonderfälle alt/größe prüfen.md']);
    expect(readFileSync(join(dir, 'wiki/archiv/sonderfälle alt/größe prüfen.md'), 'utf8')).toBe('# Größe\n');
    // Names outside the source are refused.
    await notes.delete(mount, 'b.md', USER);
    const [bItem] = await notes.trash(mount);
    await expect(notes.restoreFromTrash(mount, bItem!.id, undefined, USER, '../draußen')).rejects.toThrow();
    await expect(notes.restoreFromTrash(mount, bItem!.id, undefined, USER, '   ')).rejects.toBeInstanceOf(PathError);

    // Git trash: same, from the history.
    rmSync(join(dir, 'wiki/b.md'), { force: true });
    await notes.purgeTrash(mount, null);
    writeFileSync(join(dir, 'wiki/c.md'), '# C alt\n');
    await commit('c');
    rmSync(join(dir, 'wiki/c.md'));
    await commit('c weg');
    // (A note that exists again is not listed in the git trash at all.)
    const gitItem = (await notes.trash(mount)).find((t) => t.files.includes('c.md'))!;
    writeFileSync(join(dir, 'wiki/c alt.md'), 'belegt\n');
    await expect(notes.restoreFromTrash(mount, gitItem.id, ['c.md'], USER, 'c alt.md')).rejects.toBeInstanceOf(ConflictError);
    rmSync(join(dir, 'wiki/c alt.md'));
    expect((await notes.restoreFromTrash(mount, gitItem.id, ['c.md'], USER, 'c alt.md')).paths).toEqual(['c alt.md']);
    expect(readFileSync(join(dir, 'wiki/c alt.md'), 'utf8')).toBe('# C alt\n');
    expect(existsSync(join(dir, 'wiki/c.md'))).toBe(false);
  });

  it('reports no history for folders without git', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'x.md'), '# X\n');
    const m = await manager.create({ name: 'Plain', type: 'local', source: plain });
    expect(await notes.history(m, 'x.md')).toEqual({ git: false, versions: [] });
    expect(await notes.trash(m)).toEqual([]);
    await notes.delete(m, 'x.md', USER);
    expect((await notes.trash(m)).map((t) => [t.source, t.path])).toEqual([['folder', 'x.md']]);
  });
});

describe('moving between mounts', () => {
  let a: Mount;
  let b: Mount;
  let dirA: string;
  let dirB: string;
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  beforeEach(async () => {
    dirA = join(root, 'a');
    dirB = join(root, 'b');
    write(join(dirA, 'plan/kickoff.md'), '# Kickoff\n\n![Bild](assets/foto.png) [Logo](../logo.svg) [Web](https://x.test/a.png) [Notiz](details.md)\n');
    write(join(dirA, 'plan/assets/foto.png'), Buffer.from([1, 2, 3]));
    write(join(dirA, 'logo.svg'), '<svg/>');
    write(join(dirA, 'plan/details.md'), '# Details\n\n![](assets/foto.png)\n');
    write(join(dirA, 'plan/code.ts'), 'export {}\n');
    write(join(dirB, 'README.md'), '# B\n');
    a = await manager.create({ name: 'A', type: 'local', source: dirA });
    b = await manager.create({ name: 'B', type: 'local', source: dirB });
  });

  it('finds local references only', async () => {
    expect(
      (await localReferences('---\nx: 1\n---\n![a](img/a%20b.png) [b](../c.pdf "t") [w](http://x) [g](www.google.de) [h](#top) [r]\n\n[r]: ./d.png\n\n<img src="img/breit.png" width="300">\n', 'sub/n.md')).sort(),
    ).toEqual(['c.pdf', 'sub/d.png', 'sub/img/a b.png', 'sub/img/breit.png']);
  });

  it('moves a note with its images; images stay in the source, outside refs only warn', async () => {
    const r = await notes.moveAcross(a, b, 'plan/kickoff.md', 'meetings/Kickoff.md', USER);
    expect(r.path).toBe('meetings/Kickoff.md');
    expect(r.warnings).toEqual(['„logo.svg“ liegt außerhalb des verschobenen Bereichs und wurde nicht mitkopiert']);
    expect(readFileSync(join(dirB, 'meetings/Kickoff.md'), 'utf8')).toContain('![Bild](assets/foto.png)');
    expect(readFileSync(join(dirB, 'meetings/assets/foto.png'))).toEqual(Buffer.from([1, 2, 3]));
    expect(existsSync(join(dirA, 'plan/kickoff.md'))).toBe(false);
    expect(existsSync(join(dirA, 'plan/assets/foto.png'))).toBe(true);
    expect(existsSync(join(dirB, 'meetings/details.md'))).toBe(false);
    expect(indexer.get(b.id, 'meetings/Kickoff.md')).not.toBeNull();
    expect(indexer.get(a.id, 'plan/kickoff.md')).toBeNull();
  });

  it('moves a note with a resized image (<img width>) and takes the image along', async () => {
    write(join(dirA, 'plan/breit.md'), '# Breit\n\n<img src="assets/foto.png" width="300">\n');
    const r = await notes.moveAcross(a, b, 'plan/breit.md', 'neu/Breit.md', USER);
    expect(r.warnings).toEqual([]);
    expect(readFileSync(join(dirB, 'neu/Breit.md'), 'utf8')).toContain('<img src="assets/foto.png" width="300">');
    expect(readFileSync(join(dirB, 'neu/assets/foto.png'))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('moves a folder: notes and referenced files go, code stays', async () => {
    const r = await notes.moveAcross(a, b, 'plan', 'projekt', USER);
    expect(r.path).toBe('projekt');
    for (const f of ['projekt/kickoff.md', 'projekt/details.md', 'projekt/assets/foto.png']) expect(existsSync(join(dirB, f))).toBe(true);
    expect(existsSync(join(dirB, 'projekt/code.ts'))).toBe(false);
    expect(existsSync(join(dirA, 'plan/code.ts'))).toBe(true);
    expect(existsSync(join(dirA, 'plan/kickoff.md'))).toBe(false);
    expect(indexer.get(b.id, 'projekt/details.md')).not.toBeNull();
    // Its image went along – no leftover assets/ folder in the source (team test 23.10.).
    expect(existsSync(join(dirA, 'plan/assets'))).toBe(false);
  });

  it('moves a folder: an image a note outside still links to stays in the source as well', async () => {
    write(join(dirA, 'andere.md'), '# Andere\n\n![](plan/assets/foto.png)\n');
    await indexer.rebuild(a);
    await notes.moveAcross(a, b, 'plan', 'projekt', USER);
    expect(existsSync(join(dirB, 'projekt/assets/foto.png'))).toBe(true);
    expect(existsSync(join(dirA, 'plan/assets/foto.png'))).toBe(true);
  });

  it('changes nothing when the target exists, is filtered out or read-only', async () => {
    write(join(dirB, 'Kickoff.md'), '# Schon da\n');
    await expect(notes.moveAcross(a, b, 'plan/kickoff.md', 'Kickoff.md', USER)).rejects.toBeInstanceOf(ConflictError);
    const filtered = await manager.update(b.id, { include: ['docs/**'] });
    await expect(notes.moveAcross(a, filtered, 'plan/kickoff.md', 'neu/k.md', USER)).rejects.toBeInstanceOf(ForbiddenError);
    const ro = await manager.update(b.id, { include: ['**'], options: { readonly: true } });
    await expect(notes.moveAcross(a, ro, 'plan/kickoff.md', 'k.md', USER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(existsSync(join(dirA, 'plan/kickoff.md'))).toBe(true);
    expect(existsSync(join(dirB, 'neu'))).toBe(false);
    expect(existsSync(join(dirB, 'assets'))).toBe(false);
  });

  it('commits and pushes the arrival in a remote target', async () => {
    const { remote } = await remoteFixture();
    const target = manager.list().find((m) => m.type === 'remote')!;
    await notes.moveAcross(a, target, 'plan/kickoff.md', 'kickoff.md', USER);
    await manager.flush();
    const files = await git(remote, ['ls-tree', '-r', '--name-only', 'main']);
    expect(files).toContain('docs/kickoff.md');
    expect(files).toContain('docs/assets/foto.png');
  });
});

describe('copying', () => {
  let a: Mount;
  let b: Mount;
  let dirA: string;
  let dirB: string;
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  const read = (path: string) => readFileSync(path, 'utf8');

  beforeEach(async () => {
    dirA = join(root, 'a');
    dirB = join(root, 'b');
    write(join(dirA, 'plan/kickoff.md'), '---\nid: 01AAAAAAAAAAAAAAAAAAAAAAAA\n---\n# Kickoff\n\n![Bild](assets/foto.png) [Notiz](details.md) [Oben](../start.md)\n');
    write(join(dirA, 'plan/assets/foto.png'), Buffer.from([1, 2, 3]));
    write(join(dirA, 'plan/details.md'), '# Details\n\n[Kickoff](kickoff.md)\n');
    write(join(dirA, 'plan/.kaveyl-wiki.yml'), 'order:\n  - details.md\n');
    write(join(dirA, 'plan/geheim/x.md'), '# X\n');
    write(join(dirA, 'start.md'), '# Start\n\n[Kickoff](plan/kickoff.md)\n');
    write(join(dirB, 'README.md'), '# B\n');
    a = await manager.create({ name: 'A', type: 'local', source: dirA });
    b = await manager.create({ name: 'B', type: 'local', source: dirB });
  });

  it('copies a note next to itself as „(Kopie)“ with a fresh id; links still work', async () => {
    const r = await notes.copy(a, a, 'plan/kickoff.md', 'plan', USER);
    expect(r.path).toBe('plan/kickoff (Kopie).md');
    const copy = read(join(dirA, r.path));
    expect(copy).toContain('[Notiz](details.md)');
    expect(copy).not.toContain('01AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(copy).toMatch(/^---\nid: \w{26}\n---\n# Kickoff/);
    expect((await notes.copy(a, a, 'plan/kickoff.md', 'plan', USER)).path).toBe('plan/kickoff (Kopie 2).md');
    expect(read(join(dirA, 'start.md'))).toContain('[Kickoff](plan/kickoff.md)'); // originals untouched
  });

  it('copies a note into another folder: relative links are rewritten, images come along', async () => {
    const r = await notes.copy(a, a, 'plan/kickoff.md', '', USER);
    expect(r.path).toBe('kickoff.md');
    const copy = read(join(dirA, 'kickoff.md'));
    expect(copy).toContain('![Bild](assets/foto.png)');
    expect(copy).toContain('[Notiz](plan/details.md)');
    expect(copy).toContain('[Oben](start.md)');
    expect(readFileSync(join(dirA, 'assets/foto.png'))).toEqual(Buffer.from([1, 2, 3]));
    expect(read(join(dirA, 'plan/details.md'))).toContain('[Kickoff](kickoff.md)');
  });

  it('copies a folder with its notes, settings, images and attachments – not other files; links inside point at the copies', async () => {
    // Owner 2026-10-16: code, configuration and other dotfiles lying in the folder stay behind.
    mkdirSync(join(dirA, 'plan/skripte'), { recursive: true });
    writeFileSync(join(dirA, 'plan/skripte/deploy.sh'), 'echo hi\n');
    writeFileSync(join(dirA, 'plan/.env'), 'X=1\n');
    writeFileSync(join(dirA, 'plan/daten.json'), '{}\n');
    const r = await notes.copy(a, a, 'plan', '', USER);
    expect(r.path).toBe('plan (Kopie)');
    for (const f of ['kickoff.md', 'details.md', 'assets/foto.png', '.kaveyl-wiki.yml', 'geheim/x.md']) expect(existsSync(join(dirA, 'plan (Kopie)', f))).toBe(true);
    for (const f of ['skripte/deploy.sh', '.env', 'daten.json']) expect(existsSync(join(dirA, 'plan (Kopie)', f))).toBe(false);
    expect(r.warnings).toEqual(['3 andere Datei(en) wurden nicht mitkopiert – nur Notizen, Bilder und Anhänge']);
    for (const f of ['skripte/deploy.sh', '.env', 'daten.json']) rmSync(join(dirA, 'plan', f));
    expect(read(join(dirA, 'plan (Kopie)/details.md'))).toContain('[Kickoff](kickoff.md)');
    expect(read(join(dirA, 'plan (Kopie)/kickoff.md'))).toContain('[Oben](../start.md)');
  });

  it('skips notes the user may not read and says so', async () => {
    const r = await notes.copy(a, b, 'plan', 'neu', USER, (rel) => !rel.startsWith('plan/geheim/'));
    expect(r.path).toBe('neu/plan');
    expect(existsSync(join(dirB, 'neu/plan/geheim/x.md'))).toBe(false);
    expect(existsSync(join(dirB, 'neu/plan/kickoff.md'))).toBe(true);
    expect(r.warnings).toEqual(['1 Notiz(en) ohne Leserecht wurden nicht mitkopiert']);
    expect(indexer.get(b.id, 'neu/plan/kickoff.md')).not.toBeNull();
  });

  it('refuses a read-only target and plain notes into an encrypted folder', async () => {
    const ro = await manager.update(b.id, { options: { readonly: true } });
    await expect(notes.copy(a, ro, 'plan/kickoff.md', '', USER)).rejects.toBeInstanceOf(ForbiddenError);
    write(join(dirA, 'tresor/.kaveyl-wiki.yml'), 'encrypted: age\n');
    await expect(notes.copy(a, a, 'plan/kickoff.md', 'tresor', USER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(existsSync(join(dirA, 'tresor/kickoff.md'))).toBe(false);
  });
});

describe('saving as (AD-039)', () => {
  let a: Mount;
  let b: Mount;
  let dirA: string;
  let dirB: string;
  let first: string;
  const v1 = '---\nid: 01AAAAAAAAAAAAAAAAAAAAAAAA\n---\n# Kickoff\n\n![Bild](assets/foto.png) [Notiz](details.md) [Oben](../start.md)\n';
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  const commit = async (msg: string) => {
    await git(dirA, ['add', '-A']);
    await git(dirA, ['commit', '-q', '-m', msg], { env: EXT_ENV });
  };

  beforeEach(async () => {
    dirA = join(root, 'a');
    dirB = join(root, 'b');
    write(join(dirA, 'plan/kickoff.md'), v1);
    write(join(dirA, 'plan/assets/foto.png'), Buffer.from([1, 2, 255]));
    write(join(dirA, 'plan/details.md'), '# Details\n');
    write(join(dirA, 'start.md'), '# Start\n');
    await git(dirA, ['init', '-q', '-b', 'main']);
    await commit('erste');
    first = (await git(dirA, ['rev-parse', 'HEAD'])).trim();
    // Later the image is gone and the note says something else.
    write(join(dirA, 'plan/kickoff.md'), '# Kickoff\n\nneu\n');
    rmSync(join(dirA, 'plan/assets'), { recursive: true });
    await commit('zweite');
    write(join(dirB, 'README.md'), '# B\n');
    a = await manager.create({ name: 'A', type: 'local', source: dirA });
    b = await manager.create({ name: 'B', type: 'local', source: dirB });
  });

  const fromGit = (ref: string) => fileBytesAt(dirA, first, ref);

  it('saves an old version into another folder: links rewritten, the deleted image comes back from git', async () => {
    const raw = await notes.version(a, first, 'plan/kickoff.md');
    const r = await notes.saveNoteAs(a, 'plan/kickoff.md', raw, a, 'archiv/kickoff alt', USER, 'docs: test', fromGit);
    expect(r).toEqual({ path: 'archiv/kickoff alt.md', warnings: [] });
    const saved = readFileSync(join(dirA, r.path), 'utf8');
    expect(saved).toContain('![Bild](assets/foto.png)');
    expect(saved).toContain('[Notiz](../plan/details.md)');
    expect(saved).toContain('[Oben](../start.md)');
    expect(saved).not.toContain('01AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(readFileSync(join(dirA, 'archiv/assets/foto.png'))).toEqual(Buffer.from([1, 2, 255]));
    expect(readFileSync(join(dirA, 'plan/kickoff.md'), 'utf8')).toBe('# Kickoff\n\nneu\n'); // original untouched
    expect(indexer.get(a.id, r.path)).not.toBeNull();
    // Never overwrites.
    await expect(notes.saveNoteAs(a, 'plan/kickoff.md', raw, a, 'archiv/kickoff alt.md', USER, 'x', fromGit)).rejects.toBeInstanceOf(ConflictError);
  });

  it('saves next to the original: the image is restored at its old place', async () => {
    const raw = await notes.version(a, first, 'plan/kickoff.md');
    const r = await notes.saveNoteAs(a, 'plan/kickoff.md', raw, a, 'plan/kickoff (alt)', USER, 'x', fromGit);
    expect(r.path).toBe('plan/kickoff (alt).md');
    expect(readFileSync(join(dirA, 'plan/kickoff (alt).md'), 'utf8')).toContain('[Notiz](details.md)');
    expect(readFileSync(join(dirA, 'plan/assets/foto.png'))).toEqual(Buffer.from([1, 2, 255]));
  });

  it('saves into another source; files it cannot bring are named', async () => {
    const raw = await notes.version(a, first, 'plan/kickoff.md');
    const r = await notes.saveNoteAs(a, 'plan/kickoff.md', raw, b, 'kickoff', USER, 'x');
    expect(r.path).toBe('kickoff.md');
    expect(r.warnings).toEqual(['„plan/assets/foto.png“ gibt es nicht mehr und wurde nicht mitkopiert']);
    expect(readFileSync(join(dirB, 'kickoff.md'), 'utf8')).toContain('# Kickoff');
    const r2 = await notes.saveNoteAs(a, 'plan/kickoff.md', raw, b, 'zwei/kickoff', USER, 'x', fromGit);
    expect(r2.warnings).toEqual([]);
    expect(readFileSync(join(dirB, 'zwei/assets/foto.png'))).toEqual(Buffer.from([1, 2, 255]));
  });

  it('refuses hidden names, read-only sources and plain notes into an encrypted folder', async () => {
    await expect(notes.saveNoteAs(a, 'plan/kickoff.md', v1, a, '.versteckt', USER, 'x')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(notes.saveNoteAs(a, 'plan/kickoff.md', v1, a, '  ', USER, 'x')).rejects.toBeInstanceOf(PathError);
    await expect(notes.saveNoteAs(a, 'plan/kickoff.md', v1, a, '../draußen', USER, 'x')).rejects.toThrow();
    write(join(dirA, 'tresor/.kaveyl-wiki.yml'), 'encrypted: age\n');
    await expect(notes.saveNoteAs(a, 'plan/kickoff.md', v1, a, 'tresor/k', USER, 'x')).rejects.toBeInstanceOf(ForbiddenError);
    const ro = await manager.update(b.id, { options: { readonly: true } });
    await expect(notes.saveNoteAs(a, 'plan/kickoff.md', v1, ro, 'k', USER, 'x')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('restores from the trash into another source', async () => {
    await notes.delete(a, 'plan/details.md', USER);
    const [item] = await notes.trash(a);
    expect(item!.source).toBe('folder');
    const r = await notes.restoreFromTrash(a, item!.id, undefined, USER, 'aus A/details', b);
    expect(r.paths).toEqual(['aus A/details.md']);
    expect(readFileSync(join(dirB, 'aus A/details.md'), 'utf8')).toBe('# Details\n');
    expect(await notes.trash(a)).toEqual([]);
    expect(existsSync(join(dirA, 'plan/details.md'))).toBe(false);
  });
});

describe('fileNameFor', () => {
  it('keeps names readable and safe', () => {
    expect(fileNameFor('  Ä/B\\C?  ')).toBe('Ä - B - C');
    expect(fileNameFor('..')).toBe('Neue Notiz');
  });
});

describe('encrypted notes (AD-021)', () => {
  let mount: Mount;
  let dir: string;
  const AGE = '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCg==\n-----END AGE ENCRYPTED FILE-----\n';
  /** An encrypted note as the browser writes it: the files it links to listed in the plain frontmatter. */
  const sealed = (files: string[] = []) => `---\ntitle: Geheim\nencrypted: age\n${files.length ? `attachments:\n${files.map((f) => `  - ${f}\n`).join('')}` : ''}---\n${AGE}`;
  const commit = async (msg: string) => {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', msg], { env: EXT_ENV });
  };

  beforeEach(async () => {
    dir = join(root, 'enc');
    mkdirSync(join(dir, 'a/assets'), { recursive: true });
    await git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'a/geheim.md'), '# Geheim\n\nKlartext von früher.\n');
    await commit('klartext');
    writeFileSync(join(dir, 'a/assets/bild.png.age'), 'age-encryption.org/v1\n-> scrypt\n');
    writeFileSync(join(dir, 'a/geheim.md'), sealed(['assets/bild.png.age']));
    await commit('verschlüsselt');
    mount = await manager.create({ name: 'Enc', type: 'local', source: dir });
  });

  it('never restores a plain version into an encrypted note or folder', async () => {
    const { versions } = await notes.history(mount, 'a/geheim.md');
    const plain = versions.find((v) => v.subject === 'klartext')!;
    const note = await notes.read(mount, 'a/geheim.md');
    await expect(notes.restoreVersion(mount, 'a/geheim.md', plain.commit, plain.path, note.hash, USER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(readFileSync(join(dir, 'a/geheim.md'), 'utf8')).toContain('encrypted: age');
    // Folder trash: a plain note deleted before the folder was encrypted stays out of it.
    writeFileSync(join(dir, 'a/alt.md'), '# Alt\n\nKlartext.\n');
    await notes.delete(mount, 'a/alt.md', USER);
    writeFileSync(join(dir, 'a/.kaveyl-wiki.yml'), 'encrypted: age\n');
    const [item] = await notes.trash(mount);
    await expect(notes.restoreFromTrash(mount, item!.id, undefined, USER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(existsSync(join(dir, 'a/alt.md'))).toBe(false);
  });

  it('knows the files of an encrypted note: index, moving and copying bring them along', async () => {
    expect(await localReferences(sealed(['assets/bild.png.age']), 'a/geheim.md')).toEqual(['a/assets/bild.png.age']);
    expect(indexer.allLinks(mount.id).filter((l) => l.src === 'a/geheim.md').map((l) => l.target)).toEqual(['a/assets/bild.png.age']);
    await notes.move(mount, 'a/geheim.md', 'b/geheim.md', USER);
    expect(existsSync(join(dir, 'b/assets/bild.png.age'))).toBe(true);
    // The old copy stays: other notes may link to it.
    expect(existsSync(join(dir, 'a/assets/bild.png.age'))).toBe(true);
    expect(readFileSync(join(dir, 'b/geheim.md'), 'utf8')).toBe(sealed(['assets/bild.png.age']));
  });

  it('moves an encrypted folder to another source with its mark and files', async () => {
    writeFileSync(join(dir, 'a/.kaveyl-wiki.yml'), 'encrypted: age\n');
    const otherDir = join(root, 'enc2');
    mkdirSync(otherDir, { recursive: true });
    const other = await manager.create({ name: 'Enc2', type: 'local', source: otherDir });
    await notes.moveAcross(mount, other, 'a', 'a', USER);
    expect(readFileSync(join(otherDir, 'a/.kaveyl-wiki.yml'), 'utf8')).toBe('encrypted: age\n');
    expect(existsSync(join(otherDir, 'a/assets/bild.png.age'))).toBe(true);
    expect(readFileSync(join(otherDir, 'a/geheim.md'), 'utf8')).toContain('encrypted: age');
    expect(existsSync(join(dir, 'a/geheim.md'))).toBe(false);
    expect(existsSync(join(dir, 'a/.kaveyl-wiki.yml'))).toBe(false);
  });
});
