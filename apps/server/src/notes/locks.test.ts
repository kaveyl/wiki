// Concurrent writes to one file must not lose a state: every read-modify-write of a note or a
// `.kaveyl-wiki.yml` goes through the same per-file lock. The races are made deterministic by
// pausing one writer between its read and its write (gated fs calls).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { openDb, type DB } from '../db/db.js';
import { EventBus } from '../events.js';
import { git } from '../git/git.js';
import { Indexer } from '../index/indexer.js';
import { MountManager } from '../mounts/manager.js';
import { MountStore, type Mount } from '../mounts/model.js';
import { SecretStore } from '../secrets.js';
import { renameInOrder, setFolderEncrypted, writeOrder, writeTagColors } from './order.js';
import { ConflictError, NoteService } from './service.js';

type Hook = (op: 'lstat' | 'readFile', path: string) => Promise<void> | void;
const gate = vi.hoisted(() => ({ hook: null as Hook | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const call = fs as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const lstat = async (...a: unknown[]) => {
    await gate.hook?.('lstat', String(a[0]));
    return call.lstat!(...a);
  };
  const readFile = async (...a: unknown[]) => {
    // Paused after the read, also when it failed (a missing `.kaveyl-wiki.yml` is read as empty).
    const r = await call.readFile!(...a).then((v) => ({ v }), (e: unknown) => ({ e }));
    await gate.hook?.('readFile', String(a[0]));
    if ('e' in r) throw r.e;
    return r.v;
  };
  return { ...fs, default: { ...fs, lstat, readFile }, lstat, readFile };
});

/** Pauses the `nth` matching fs call until `release()`; `reached` resolves when it is hit. */
function pauseAt(op: 'lstat' | 'readFile', suffix: string, nth: number) {
  let count = 0;
  let hit!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (hit = r));
  const open = new Promise<void>((r) => (release = r));
  gate.hook = async (o, p) => {
    if (o !== op || !p.endsWith(suffix) || ++count !== nth) return;
    gate.hook = null;
    hit();
    await open;
  };
  return { reached, release };
}

const USER = { name: 'Anna', email: 'anna@example.test' };
const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
let dir: string;
let db: DB;
let config: Config;
let manager: MountManager;
let notes: NoteService;
let indexer: Indexer;
let mount: Mount;
const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');
const sha1 = async (s: string) => (await import('node:crypto')).createHash('sha1').update(s).digest('hex');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-locks-'));
  dir = join(root, 'wiki');
  mkdirSync(join(dir, 'geheim'), { recursive: true });
  writeFileSync(join(dir, 'a.md'), '# A\n\n[B](b.md)\n');
  writeFileSync(join(dir, 'b.md'), '# B\n');
  writeFileSync(join(dir, 'geheim/x.md'), '# X\n');
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init'], { env: { GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' } });
  config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), syncIntervalSec: 0, commitDelaySec: 0 };
  db = openDb(':memory:');
  indexer = new Indexer(db, config.dataPath);
  manager = new MountManager(config, new MountStore(db), indexer, SecretStore.open(db, config.configPath), new EventBus(), silent);
  notes = new NoteService(manager, config.dataPath, indexer);
  mount = await manager.create({ name: 'Wiki', type: 'local', source: dir });
});

afterEach(async () => {
  gate.hook = null;
  await manager.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A save that started while `writer` was between read and write: it may fail with a conflict, but must never be lost. */
async function raceWithSave(writer: () => Promise<unknown>, pause: { reached: Promise<void>; release: () => void }, rel: string, text: string) {
  const base = await sha1(read(rel));
  const first = writer();
  await pause.reached;
  const save = notes.saveRaw(mount, rel, text, base, USER);
  await Promise.race([save.catch(() => undefined), sleep(300)]);
  pause.release();
  const [w, s] = await Promise.allSettled([first, save]);
  expect(w.status).toBe('fulfilled');
  if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(ConflictError);
  const lost = s.status === 'fulfilled' && read(rel) !== text;
  expect(lost).toBe(false);
}

describe('per-file lock', () => {
  it('link repair does not overwrite a save made while it was working on the same note', async () => {
    renameSync(join(dir, 'b.md'), join(dir, 'c.md'));
    await sleep(500); // let the watcher settle
    // 1st lstat of a.md = repair reads it, 2nd = repair is about to write it.
    const pause = pauseAt('lstat', '/wiki/a.md', 2);
    await raceWithSave(() => notes.repairLinks(mount, [{ from: 'b.md', to: 'c.md' }], USER), pause, 'a.md', '# A\n\nneu getippt\n');
  });

  it('restoring a version does not overwrite a save made in the meantime', async () => {
    const [v] = (await notes.history(mount, 'a.md')).versions;
    writeFileSync(join(dir, 'a.md'), '# A\n\nzweite Fassung\n');
    await sleep(500); // let the watcher settle
    const base = await sha1(read('a.md'));
    const pause = pauseAt('lstat', '/wiki/a.md', 2);
    await raceWithSave(() => notes.restoreVersion(mount, 'a.md', v!.commit, v!.path, base, USER), pause, 'a.md', '# A\n\ndritte Fassung\n');
  });

  it('folder order and the encryption mark in one .kaveyl-wiki.yml do not overwrite each other', async () => {
    const pause = pauseAt('readFile', '/wiki/geheim/.kaveyl-wiki.yml', 1);
    const order = writeOrder(manager, config.dataPath, mount, 'geheim', ['x.md'], USER);
    await pause.reached;
    const enc = setFolderEncrypted(manager, config.dataPath, mount, 'geheim', true, USER);
    await Promise.race([enc, sleep(300)]);
    pause.release();
    await Promise.all([order, enc]);
    expect(read('geheim/.kaveyl-wiki.yml')).toContain('encrypted: age');
    expect(read('geheim/.kaveyl-wiki.yml')).toContain('x.md');
  });

  it('root order and tag colors in one .kaveyl-wiki.yml do not overwrite each other', async () => {
    const pause = pauseAt('readFile', '/wiki/.kaveyl-wiki.yml', 1);
    const order = writeOrder(manager, config.dataPath, mount, '', ['b.md', 'a.md'], USER);
    await pause.reached;
    const colors = writeTagColors(manager, config.dataPath, mount, { projekt: 'red' }, USER, 'test');
    await Promise.race([colors, sleep(300)]);
    pause.release();
    await Promise.all([order, colors]);
    expect(read('.kaveyl-wiki.yml')).toContain('projekt: red');
    expect(read('.kaveyl-wiki.yml')).toContain('b.md');
  });

  it('two sources on one folder share the lock of a file they both write', async () => {
    // A second source on a subfolder of the same repository: its root `.kaveyl-wiki.yml` is the first one's `geheim/.kaveyl-wiki.yml`.
    const sub = await manager.create({ name: 'Geheim', type: 'local', source: dir, subpath: 'geheim' });
    const pause = pauseAt('readFile', '/wiki/geheim/.kaveyl-wiki.yml', 1);
    const order = writeOrder(manager, config.dataPath, mount, 'geheim', ['x.md'], USER);
    await pause.reached;
    const colors = writeTagColors(manager, config.dataPath, sub, { projekt: 'red' }, USER, 'test');
    await Promise.race([colors, sleep(300)]);
    pause.release();
    await Promise.all([order, colors]);
    expect(read('geheim/.kaveyl-wiki.yml')).toContain('projekt: red');
    expect(read('geheim/.kaveyl-wiki.yml')).toContain('x.md');
  });

  it('a rename keeps a reorder made while it waited for the order file', async () => {
    writeFileSync(join(dir, '.kaveyl-wiki.yml'), 'order:\n  - a.md\n  - b.md\n  - geheim\n');
    const pause = pauseAt('readFile', '/wiki/.kaveyl-wiki.yml', 1);
    const order = writeOrder(manager, config.dataPath, mount, '', ['geheim', 'a.md', 'b.md'], USER);
    await pause.reached;
    const rename = renameInOrder(manager, config.dataPath, mount, 'b.md', 'c.md', USER);
    await Promise.race([rename, sleep(300)]);
    pause.release();
    await Promise.all([order, rename]);
    expect(read('.kaveyl-wiki.yml')).toBe('order:\n  - geheim\n  - a.md\n  - c.md\n');
  });
});
