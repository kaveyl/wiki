// The file watcher can fail (seen: „Unable to poll: Interrupted system call“); its subscription then
// delivers nothing more. The manager must subscribe again and compare the index, or outside changes
// (VS Code, git) stay invisible until a restart.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { openDb, type DB } from '../db/db.js';
import { EventBus } from '../events.js';
import { Indexer } from '../index/indexer.js';
import { SecretStore } from '../secrets.js';
import { MountManager } from './manager.js';
import { MountStore } from './model.js';
import { watcherPid } from './watchHost.js';

type Callback = (err: Error | null, events: { path: string; type: string }[]) => void;
const subscriptions: { cb: Callback; dead: boolean }[] = [];

// The real watcher (its host and process, AD-054), wrapped: a test can make a subscription fail and go silent.
vi.mock('./watchHost.js', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('./watchHost.js');
  const subscribe = async (dir: string, cb: Callback, opts: { ignore?: string[] }) => {
    const entry = { cb, dead: false };
    subscriptions.push(entry);
    return real.subscribe(dir, (err, events) => !entry.dead && cb(err, events), opts);
  };
  return { ...real, subscribe, default: { subscribe } };
});

const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;
let root: string;
let db: DB;
let manager: MountManager;
let indexer: Indexer;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-watch-recover-'));
  db = openDb(':memory:');
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0 };
  indexer = new Indexer(db, config.dataPath);
  manager = new MountManager(config, new MountStore(db), indexer, SecretStore.open(db, config.configPath), new EventBus(), silent);
});

afterEach(async () => {
  await manager.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it('subscribes again after a watcher error and picks up what changed meanwhile', async () => {
  const dir = join(root, 'projekte', 'n');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.md'), '# A\n');
  const mount = await manager.create({ name: 'N', type: 'local', source: dir });
  expect(subscriptions).toHaveLength(1);
  // The watcher fails and goes silent.
  subscriptions[0]!.dead = true;
  subscriptions[0]!.cb(new Error('Unable to poll: Interrupted system call'), []);
  writeFileSync(join(dir, 'neu.md'), '# Neu\n');
  await expect.poll(() => indexer.get(mount.id, 'neu.md')?.path ?? null, { timeout: 5000, interval: 100 }).toBe('neu.md');
  expect(subscriptions.length).toBe(2);
  // The new subscription works for later changes too.
  writeFileSync(join(dir, 'spaeter.md'), '# Später\n');
  await expect.poll(() => indexer.get(mount.id, 'spaeter.md')?.path ?? null, { timeout: 5000, interval: 100 }).toBe('spaeter.md');
}, 20_000);

it('one restart renews every subscription; a failure during the restart starts another one', async () => {
  const one = join(root, 'projekte', 'eins');
  const two = join(root, 'projekte', 'zwei');
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  const a = await manager.create({ name: 'Eins', type: 'local', source: one });
  const b = await manager.create({ name: 'Zwei', type: 'local', source: two });
  const before = subscriptions.length;
  // The comparison after the restart takes a while — long enough for the next failure to come in.
  const rebuild = indexer.rebuild.bind(indexer);
  let slow = true;
  vi.spyOn(indexer, 'rebuild').mockImplementation(async (m) => {
    if (slow) await new Promise((r) => setTimeout(r, 800));
    return rebuild(m);
  });
  // The watcher thread fails: every subscription goes silent (here only one reports it).
  for (const s of subscriptions) s.dead = true;
  subscriptions.at(-2)!.cb(new Error('Unable to poll: Interrupted system call'), []);
  // Both anew, once each …
  await expect.poll(() => subscriptions.length, { timeout: 5000, interval: 20 }).toBe(before + 2);
  // … and while the comparison still runs, the new thread fails as well.
  for (const s of subscriptions) s.dead = true;
  subscriptions.at(-1)!.cb(new Error('Unable to poll: Interrupted system call'), []);
  slow = false;
  await expect.poll(() => subscriptions.length, { timeout: 8000, interval: 50 }).toBe(before + 4);
  writeFileSync(join(one, 'a.md'), '# A\n');
  writeFileSync(join(two, 'b.md'), '# B\n');
  await expect.poll(() => [indexer.get(a.id, 'a.md')?.path ?? null, indexer.get(b.id, 'b.md')?.path ?? null], { timeout: 5000, interval: 100 }).toEqual(['a.md', 'b.md']);
}, 30_000);

it('runs in a process of its own: child processes of the server do not stop it, a killed watcher process comes back (AD-054)', async () => {
  const dir = join(root, 'projekte', 'p');
  mkdirSync(dir, { recursive: true });
  const mount = await manager.create({ name: 'P', type: 'local', source: dir });
  const pid = watcherPid();
  expect(pid).toBeTruthy();
  expect(pid).not.toBe(process.pid);
  // What stopped the watcher inside the server: the SIGCHLD of every finished git command.
  const run = promisify(execFile);
  for (let i = 0; i < 25; i++) await Promise.all(Array.from({ length: 8 }, () => run('git', ['--version'])));
  writeFileSync(join(dir, 'a.md'), '# A\n');
  await expect.poll(() => indexer.get(mount.id, 'a.md')?.path ?? null, { timeout: 5000, interval: 100 }).toBe('a.md');
  // The watcher process dies: the manager subscribes again, a new process watches.
  process.kill(pid!, 'SIGKILL');
  await expect.poll(() => watcherPid(), { timeout: 8000, interval: 100 }).not.toBe(pid);
  await expect.poll(() => watcherPid(), { timeout: 8000, interval: 100 }).not.toBeNull();
  writeFileSync(join(dir, 'b.md'), '# B\n');
  await expect.poll(() => indexer.get(mount.id, 'b.md')?.path ?? null, { timeout: 5000, interval: 100 }).toBe('b.md');
}, 30_000);
