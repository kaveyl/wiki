// Runtime of all mounts: prepares clones, keeps the index fresh (file watcher), runs the
// periodic sync of remote mounts and batches app edits into commits.
// SEE-DOC: docs/PLAN.md §2.1, §2.8

import type { ChangeFeed } from '../changes.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import watcher, { type Subscription } from './watchHost.js';
import type { Config } from '../config.js';
import type { EventBus } from '../events.js';
import { git, type GitOptions } from '../git/git.js';
import { conflictFiles, resolveConflict, type ConflictFile, type Resolution } from '../git/conflict.js';
import { APP_AUTHOR, commitPending, diffNameStatus, sync, type Author, type FileChange, type SyncResult } from '../git/sync.js';
import type { ActivityInput, ActivityLog } from '../activity.js';
import type { IndexChange, Indexer } from '../index/indexer.js';
import type { SecretStore } from '../secrets.js';
import type { ConnectionStore } from './connections.js';
import { cleanRelPath, contentRoot, isIgnoredSegment, PathError, repoDir, type Mount, type MountInput, type MountStore } from './model.js';
import { insideRepo, validateSource } from './sources.js';
import { isAgeBody, isEncryptedNote } from '../notes/encryption.js';
import { FOLDER_META, inEncryptedFolder } from '../notes/order.js';
import { assertVersionsPossible, HISTORY_BUNDLE, initVersions, VERSIONS_MARK } from './versions.js';

/** Longest time an app edit waits for its automatic commit while someone keeps typing. */
const MAX_COMMIT_WAIT_SEC = 600;

/** Secret id of the Gitea token from before connections (AD-029; now the first Gitea connection). */
export const GITEA_SECRET_ID = 'gitea';

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface MountStatus {
  /** App edits waiting for the batched commit. */
  pending: number;
  /** Working-copy state (null if the folder is not a git repository). */
  git: { branch: string | null; upstream: string | null; ahead: number; behind: number; uncommitted: number } | null;
}

interface RepoRuntime {
  dir: string;
  subscription?: Subscription;
  /** Serializes git operations on this working copy. */
  queue: Promise<unknown>;
  commitTimer?: NodeJS.Timeout;
  /** Who saved last in this batch (commits the rest), and every author's files (repository-relative), in order. */
  pendingAuthor?: Author;
  pendingBy: Map<string, { author: Author; paths: Set<string> }>;
  pendingPaths: Set<string>;
  /** Commit message for a batch that consists only of one kind of change (e.g. link repair). */
  pendingMessage?: string;
  /** When the oldest uncommitted app edit of this batch happened (caps the wait while typing). */
  pendingSince?: number;
  watchTimer?: NodeJS.Timeout;
  /** When the first not yet indexed watcher event came: the debounce waits at most a second from there. */
  watchSince?: number;
  /** Watcher flushes run one after the other: two index updates at once could lose a file. */
  watchFlush?: Promise<void>;
  watchPaths: Set<string>;
  /** Local folder with versions made by Kaveyl Wiki (AD-071) – asked once. */
  versions?: Promise<boolean>;
}

/** How long a file the app wrote is looked at again with every watcher batch. */
const RECENT_WRITE_MS = 10_000;

/** Paths in the output of `git status --porcelain -z` (a rename or copy names both). */
function porcelainPaths(out: string): string[] {
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(parts[++i]!);
  }
  return paths;
}

/** Commit message for files another program changed in a folder with versions (AD-071). */
const outsideMessage = (files: string[]) =>
  files.length === 1 ? `docs: ${files[0]} außerhalb von Kaveyl Wiki geändert` : `docs: ${files.length} Dateien außerhalb von Kaveyl Wiki geändert`;

/** „2 Notizen“, „1 Notiz und 1 Datei“: only Markdown files count as notes, pictures and other files are named apart. */
export const countText = (files: string[]) => {
  const notes = files.filter((f) => f.toLowerCase().endsWith('.md')).length;
  const other = files.length - notes;
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (!other) return part(notes, 'Notiz', 'Notizen');
  if (!notes) return part(other, 'Datei', 'Dateien');
  return `${part(notes, 'Notiz', 'Notizen')} und ${part(other, 'Datei', 'Dateien')}`;
};

export class MountManager {
  private readonly repos = new Map<string, RepoRuntime>();
  private readonly inflight = new Set<Promise<unknown>>();
  private syncTimer?: NodeJS.Timeout;
  private stopped = false;
  /** Watcher restart: scheduled (`waiting`), running (`running`); `rewatchAgain`: it failed again meanwhile. */
  private rewatching: 'waiting' | 'running' | null = null;
  private rewatchAgain = false;
  private renameHandler?: (mount: Mount, renamed: IndexChange['renamed']) => void;
  /** Last settled sync state per mount (not "syncing") — to log changes, not repetitions. */
  private readonly settled = new Map<string, { status: string; detail: string | null }>();

  constructor(
    private readonly config: Config,
    private readonly store: MountStore,
    private readonly indexer: Indexer,
    private readonly secrets: SecretStore,
    private readonly events: EventBus,
    private readonly log: Logger,
    private readonly activity?: ActivityLog,
    /** Access data of sources with a connection (AD-029); without it only the stored secret counts. */
    private readonly connections?: ConnectionStore,
  ) {}

  /** Every change the index sees, with the person behind it (AD-066); set by the app. */
  changes: ChangeFeed | null = null;
  /**
   * Files the app wrote a moment ago, per mount. The watcher folds „created“ (our atomic write) and „deleted“ (renamed
   * or removed outside right after) into nothing – such a file would stay in the tree. Each watcher batch looks at them
   * again (unchanged ones cost nothing).
   */
  private readonly recentWrites = new Map<string, Map<string, number>>();
  /** Folders the app is filling right now (an import), per source: no „change from outside“ there meanwhile. */
  private readonly writingIn = new Map<string, string[]>();

  /** Event log entry for a mount (AD-013); no-op in tests without a log. */
  private note(mount: Mount, e: Omit<ActivityInput, 'mount'>) {
    try {
      this.activity?.log({ ...e, mount: { id: mount.id, name: mount.name } });
    } catch (err) {
      this.log.warn({ err }, 'activity log failed');
    }
  }

  /** Repo-relative paths as mount-relative `detail.paths` for the log's read filter (sec-004); none if one lies outside. */
  private notePaths(mount: Mount, repoPaths: string[]): string[] | undefined {
    const prefix = mount.subpath ? `${mount.subpath}/` : '';
    return repoPaths.every((p) => p.startsWith(prefix)) ? repoPaths.map((p) => p.slice(prefix.length)) : undefined;
  }

  async start() {
    for (const mount of this.store.list()) {
      if (mount.paused) continue;
      await this.activate(mount).catch((e: unknown) => this.fail(mount, e));
    }
    if (this.config.syncIntervalSec > 0) {
      this.syncTimer = setInterval(() => this.track(() => this.syncAll()), this.config.syncIntervalSec * 1000);
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.syncTimer);
    for (const repo of this.repos.values()) {
      clearTimeout(repo.commitTimer);
      clearTimeout(repo.watchTimer);
      await repo.subscription?.unsubscribe();
    }
    // Flush pending commits so no app edit is left uncommitted on shutdown.
    await this.flush();
    this.repos.clear();
  }

  /** Resolves when all background work (batched commits, syncs, index updates) has finished. */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Runs pending batched commits immediately and waits for all background work. */
  async flush() {
    await this.idle();
    for (const repo of this.repos.values()) {
      if (!repo.pendingAuthor) continue;
      const mount = this.sharing(repo.dir)[0];
      if (mount) await this.commitNow(mount).catch((e: unknown) => this.fail(mount, e));
    }
    await this.idle();
  }

  private track(fn: () => Promise<unknown>) {
    if (this.stopped) return;
    const p = fn().finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Called when notes were renamed outside the app (watcher, pull) — e.g. to repair links. */
  onRenamed(fn: (mount: Mount, renamed: IndexChange['renamed']) => void) {
    this.renameHandler = fn;
  }

  list(): Mount[] {
    return this.store.list();
  }

  get(id: string): Mount | null {
    return this.store.get(id);
  }

  async create(input: MountInput, credential?: string): Promise<Mount> {
    const credentialId = credential ? this.secrets.put(credential) : input.credentialId;
    const mount = this.store.create({ ...input, credentialId: credentialId ?? null });
    try {
      await this.setAsideOrphanedClone(mount);
      await this.activate(mount);
    } catch (e) {
      this.fail(mount, e);
    }
    const fresh = this.store.get(mount.id)!;
    this.events.emit({ type: 'mount', mount: fresh });
    return fresh;
  }

  /**
   * A clone left behind by an earlier, removed mount of the same repository (e.g. a repository
   * deleted and created again under the same name) has a different history. Reusing it looks
   * like a force push and makes git report bogus renames, whose link repair then edits fresh
   * files. So a fresh mount gets a fresh clone; the old one is kept aside, never deleted.
   */
  private async setAsideOrphanedClone(mount: Mount) {
    if (mount.type !== 'remote') return;
    const dir = repoDir(mount, this.config.dataPath);
    if (this.store.list().some((m) => m.id !== mount.id && repoDir(m, this.config.dataPath) === dir)) return;
    if (!(await stat(dir).catch(() => null))) return;
    const aside = `${dir}.alt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(dir, aside);
    this.note(mount, { category: 'system', action: 'stale-clone', message: `Alter lokaler Clone von ${mount.name} beiseitegelegt (neu geklont): ${aside}` });
  }

  async update(id: string, patch: Partial<MountInput>): Promise<Mount> {
    const before = this.store.get(id);
    if (!before) throw new Error('mount not found');
    const mount = this.store.update(id, patch);
    const reindex =
      before.subpath !== mount.subpath ||
      JSON.stringify(before.include) !== JSON.stringify(mount.include) ||
      JSON.stringify(before.exclude) !== JSON.stringify(mount.exclude) ||
      before.paused !== mount.paused;
    if (mount.paused) this.indexer.clear(id);
    else if (reindex) await this.activate(mount);
    this.events.emit({ type: 'mount', mount });
    return mount;
  }

  /**
   * Versions for a local folder (AD-071): its own Git (history from a backup bundle if one lies in it) and automatic
   * commits from now on. A folder that already is or lies in a Git repository keeps it; only the commits are switched on.
   */
  async enableVersions(mount: Mount, author: Author): Promise<{ mount: Mount; restored: boolean }> {
    if (mount.type !== 'local') throw new PathError('Versionen lassen sich nur für lokale Ordner einschalten');
    const dir = repoDir(mount, this.config.dataPath);
    let restored = false;
    if (!insideRepo(dir, this.config.localRoots)) {
      await assertVersionsPossible(dir);
      const repo = this.runtime(dir);
      restored = (await this.serial(repo, () => initVersions(dir, author))).restored;
      repo.versions = undefined;
      this.note(mount, { category: 'system', action: 'versions-on', message: `Versionen eingeschaltet: ${mount.name}${restored ? ' (Verlauf aus der Sicherung)' : ''}` });
    }
    const updated = mount.options.autoCommit ? mount : await this.update(mount.id, { options: { ...mount.options, autoCommit: true } });
    return { mount: updated, restored };
  }

  /** Reads a source in again whose folder was missing at the start (e.g. its files came back from a backup). */
  async reactivate(mount: Mount) {
    await this.activate(mount);
    this.settled.delete(mount.id);
    this.events.emit({ type: 'mount', mount: this.store.get(mount.id) ?? mount });
  }

  /** Unmounts: removes config and index only. Files and repositories stay untouched. */
  async remove(id: string) {
    const mount = this.store.get(id);
    if (!mount) return;
    if (mount.options.autoCommit) await this.commitNow(mount).catch(() => undefined);
    this.indexer.clear(id);
    // Secrets of a connection belong to the connection (AD-029); only own tokens from before go.
    if (
      mount.credentialId &&
      !mount.connectionId &&
      mount.credentialId !== GITEA_SECRET_ID &&
      !this.store.list().some((m) => m.id !== id && m.credentialId === mount.credentialId)
    ) {
      this.secrets.delete(mount.credentialId);
    }
    this.store.delete(id);
    const dir = repoDir(mount, this.config.dataPath);
    if (!this.store.list().some((m) => repoDir(m, this.config.dataPath) === dir)) {
      const repo = this.repos.get(dir);
      clearTimeout(repo?.commitTimer);
      clearTimeout(repo?.watchTimer);
      await repo?.subscription?.unsubscribe();
      this.repos.delete(dir);
    }
    this.events.emit({ type: 'mount-removed', mountId: id });
  }

  /** Live status for the sync indicator: pending app edits and the git state of the working copy. */
  async status(mount: Mount): Promise<MountStatus> {
    const dir = repoDir(mount, this.config.dataPath);
    const repo = this.repos.get(dir);
    const pending = repo ? [...repo.pendingPaths].length : 0;
    let gitState: MountStatus['git'] = null;
    if (await stat(`${dir}/.git`).catch(() => null)) {
      try {
        const scope = mount.subpath ? ['--', mount.subpath] : [];
        const out = await git(dir, ['status', '--porcelain=v1', '-b', ...scope]);
        const [head = '', ...lines] = out.split('\n').filter(Boolean);
        const m = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
        const info = m?.[3] ?? '';
        gitState = {
          branch: m?.[1] ?? null,
          upstream: m?.[2] ?? null,
          ahead: Number(/ahead (\d+)/.exec(info)?.[1] ?? 0),
          behind: Number(/behind (\d+)/.exec(info)?.[1] ?? 0),
          uncommitted: lines.length,
        };
      } catch {
        gitState = null;
      }
    }
    return { pending, git: gitState };
  }

  gitOptions(mount: Mount): GitOptions {
    const connection = mount.connectionId ? this.connections?.get(mount.connectionId) : null;
    if (connection) {
      const authorization = this.connections!.gitAuthorization(connection);
      return authorization ? { authorization } : {};
    }
    const token = mount.credentialId ? this.secrets.get(mount.credentialId) : null;
    return token ? { authorization: `token ${token}` } : {};
  }

  /**
   * Called after the app changed files in a mount: updates the index immediately (the
   * watcher event that follows is then a no-op) and schedules a batched commit.
   */
  async touched(mount: Mount, paths: string[], author: Author, message?: string): Promise<IndexChange> {
    const recent = this.recentWrites.get(mount.id) ?? new Map<string, number>();
    const now = Date.now();
    for (const [p, at] of recent) if (now - at > RECENT_WRITE_MS) recent.delete(p);
    for (const p of paths) recent.set(p, now);
    this.recentWrites.set(mount.id, recent);
    const change = await this.indexer.update(mount, paths);
    this.events.emit({ type: 'tree', mountId: mount.id, change });
    this.changes?.record(mount.id, change, author);
    if (!mount.options.autoCommit) return change;
    this.schedule(mount, paths, author, message);
    return change;
  }

  /** Puts files (mount-relative) into the next commit batch of the mount's repository; the commit waits for a pause. */
  private schedule(mount: Mount, paths: string[], author: Author, message?: string) {
    const repo = this.runtime(repoDir(mount, this.config.dataPath));
    // A special message only fits when nothing else is waiting in the same batch; a plain edit of files already in it
    // keeps it (a note created and filled at once stays „angelegt“).
    message ??= author.message;
    const plainEditInBatch = message === undefined && paths.every((p) => repo.pendingPaths.has(p));
    repo.pendingMessage = repo.pendingPaths.size === 0 || repo.pendingMessage === message ? message : plainEditInBatch ? repo.pendingMessage : undefined;
    repo.pendingAuthor = author;
    repo.pendingSince ??= Date.now();
    for (const p of paths) repo.pendingPaths.add(p);
    // Several people in one batch: each gets their own commit (takeBatch) – not all under the last one's name.
    const key = `${author.name}\0${author.email}`;
    const by = repo.pendingBy.get(key) ?? { author, paths: new Set<string>() };
    repo.pendingBy.delete(key);
    repo.pendingBy.set(key, by);
    for (const p of paths) by.paths.add(mount.subpath ? `${mount.subpath}/${p}` : p);
    clearTimeout(repo.commitTimer);
    // Wait for a pause in editing; never longer than MAX_COMMIT_WAIT after the first edit.
    const idle = (this.config.commitDelaySec ?? mount.options.commitIdleSec) * 1000;
    const maxWait = (this.config.commitDelaySec ?? MAX_COMMIT_WAIT_SEC) * 1000;
    const delay = Math.max(0, Math.min(idle, repo.pendingSince + maxWait - Date.now()));
    repo.commitTimer = setTimeout(() => this.track(() => this.commitNow(mount).catch((e: unknown) => this.fail(mount, e))), delay);
  }

  /** Commits pending app edits now and (for remote mounts) syncs; the sync's result, undefined when nothing was waiting. */
  async commitNow(mount: Mount): Promise<SyncResult | null | undefined> {
    const repo = this.runtime(repoDir(mount, this.config.dataPath));
    const commit = this.takeBatch(mount, repo);
    if (!commit) return undefined;
    await this.serial(repo, commit);
    return mount.type === 'remote' ? this.sync(mount) : null;
  }

  /**
   * Commits pending app edits now, without the sync waiting on it: a remote mount syncs afterwards in the background.
   * For deletions with the git trash (owner 27.10.): the content goes into the history before the file goes, and the
   * deletion is in the trash at once – not only after the commit pause.
   */
  async commitPendingNow(mount: Mount): Promise<void> {
    const repo = this.runtime(repoDir(mount, this.config.dataPath));
    const commit = this.takeBatch(mount, repo);
    // Nothing waiting may still mean a batch the commit timer just took is running: wait for it in the queue,
    // else the file could go while that commit is still adding it.
    await this.serial(repo, commit ?? (async () => undefined));
    if (commit && mount.type === 'remote') this.track(() => this.sync(mount).catch((e: unknown) => this.fail(mount, e)));
  }

  /** Takes the pending batch of app edits; the returned job commits it (run it inside `serial`). Null when nothing waits. */
  private takeBatch(mount: Mount, repo: RepoRuntime): (() => Promise<void>) | null {
    clearTimeout(repo.commitTimer);
    const author = repo.pendingAuthor;
    const paths = [...repo.pendingPaths];
    const special = repo.pendingMessage;
    const others = [...repo.pendingBy.values()].slice(0, -1);
    const last = [...repo.pendingBy.values()].at(-1);
    repo.pendingAuthor = undefined;
    repo.pendingMessage = undefined;
    repo.pendingSince = undefined;
    repo.pendingPaths.clear();
    repo.pendingBy.clear();
    if (!author) return null;
    const strip = (f: string) => (mount.subpath && f.startsWith(`${mount.subpath}/`) ? f.slice(mount.subpath.length + 1) : f);
    // Changes from outside (AD-071) keep saying so, also when several came in one by one.
    const generic = (files: string[], who?: Author) =>
      who?.name === APP_AUTHOR.name && who.email === APP_AUTHOR.email
        ? outsideMessage(files.map(strip))
        : files.length === 1
          ? `docs: ${strip(files[0]!)} bearbeitet (Kaveyl Wiki)`
          : `docs: ${countText(files)} bearbeitet (Kaveyl Wiki)`;
    return async () => {
      // A local folder may be part of a bigger repository: its commit takes nothing from outside.
      const target = { dir: repo.dir, branch: mount.branch ?? 'main', git: this.gitOptions(mount), onlyDir: mount.type === 'local' };
      // Everyone but the last author first, only their files; a file several people edited goes with the last of them,
      // the others named as co-authors (the file holds all their changes). Co-authors belong to a whole commit, so files
      // with different co-authors get commits of their own – the versions of a note name only who edited it.
      const lastOf = (file: string) => (last?.paths.has(file) ? last : [...others].reverse().find((o) => o.paths.has(file)));
      const groups = (files: string[], owner: Author) => {
        const same = (x: Author) => x.name === owner.name && x.email === owner.email;
        const byCo = new Map<string, { files: string[]; co: Author[] }>();
        for (const f of files) {
          const co = [...others, ...(last ? [last] : [])].filter((o) => !same(o.author) && o.paths.has(f)).map((o) => o.author);
          const key = co.map((x) => `${x.name}\0${x.email}`).join('\n');
          const group = byCo.get(key) ?? byCo.set(key, { files: [], co }).get(key)!;
          group.files.push(f);
        }
        return [...byCo.values()];
      };
      for (const o of others) {
        const own = [...o.paths].filter((f) => lastOf(f) === o);
        for (const g of groups(own, o.author)) await commitPending(target, generic(g.files, o.author), o.author, g.files, g.co);
      }
      // The last author's commit takes everything still pending; files with other co-authors go before it.
      const mine = last ? groups([...last.paths], author) : [];
      const rest = mine.find((g) => !g.co.length) ?? mine.at(-1);
      for (const g of mine) if (g !== rest) await commitPending(target, generic(g.files, author), author, g.files, g.co);
      const message = others.length || mine.length > 1 ? generic(rest ? rest.files : paths, author) : (special ?? generic(paths, author));
      // In a folder with versions only the person's own files: what another program changed meanwhile becomes a
      // version of its own (flushWatch), not one under this name.
      const prefix = (f: string) => (mount.subpath ? `${mount.subpath}/${f}` : f);
      const only = (await this.keepsVersions(mount, repo)) ? (rest?.files ?? paths.map(prefix)) : undefined;
      const sha = await commitPending(target, message, author, only, rest?.co ?? []);
      // Remote mounts report the push instead; here only local folders with auto-commit.
      if (sha && mount.type === 'local') {
        this.note(mount, { category: 'sync', action: 'committed', actor: author.name, message: `Commit ${sha.slice(0, 7)}: ${message}`, detail: { commit: sha, files: paths.length, paths } });
        // The sync overview shows „nicht committet“ until it hears about it.
        const current = this.store.get(mount.id);
        if (current) this.events.emit({ type: 'mount', mount: current });
      }
    };
  }

  /** The three versions of every file that blocks the sync of a remote mount. */
  async conflict(mount: Mount): Promise<ConflictFile[]> {
    if (mount.type !== 'remote') return [];
    const repo = this.runtime(repoDir(mount, this.config.dataPath));
    return this.serial(repo, () => conflictFiles(repo.dir, `refs/remotes/origin/${mount.branch ?? 'main'}`, this.gitOptions(mount)));
  }

  /** Applies the user's conflict resolutions as a merge commit, then syncs (push). */
  async resolveConflict(mount: Mount, resolutions: Resolution[], author: Author): Promise<SyncResult | null> {
    if (mount.type !== 'remote') return null;
    if (mount.options.autoCommit) await this.commitNow(mount);
    const repo = this.runtime(repoDir(mount, this.config.dataPath));
    const opts = this.gitOptions(mount);
    const before = await this.serial(repo, async () => {
      const head = (await git(repo.dir, ['rev-parse', 'HEAD'], opts)).trim();
      await resolveConflict(repo.dir, `refs/remotes/origin/${mount.branch ?? 'main'}`, resolutions, author, opts);
      const refs = (await git(repo.dir, ['for-each-ref', '--format=%(refname)', 'refs/kaveyl-wiki/conflicts/'], opts)).split('\n').filter(Boolean);
      for (const ref of refs) await git(repo.dir, ['update-ref', '-d', ref], opts);
      return head;
    });
    this.note(mount, { category: 'sync', action: 'conflict-resolved', actor: author.name, message: `Konflikt aufgelöst: ${resolutions.map((r) => r.path).join(', ')}`, detail: { paths: this.notePaths(mount, resolutions.map((r) => r.path)) } });
    const changes = await this.serial(repo, () => diffNameStatus(repo.dir, before, 'HEAD', opts));
    for (const m of this.sharing(repo.dir)) await this.reindexRepoPaths(m, changes);
    return this.sync(mount);
  }

  /**
   * Tells open editors that the app changed these notes (saves from the editor, API and MCP, restore,
   * link repair). The saving editor recognizes its own write by the hash its save returns.
   */
  announce(mount: Mount, paths: string[]) {
    for (const p of paths) this.events.emit({ type: 'note', mountId: mount.id, path: p, hash: this.indexer.get(mount.id, p)?.hash ?? null });
  }

  /**
   * Writes of one file run one after the other: the read (hash check) and the write must not
   * interleave. Used for notes (NoteService) and `.kaveyl-wiki.yml` (order.ts). Never call `serial`
   * work that waits for this lock, and never take the same file's lock inside it. Keyed by the
   * absolute path: sources sharing a clone (e.g. one on a subfolder) write the same files.
   */
  private writing = new Map<string, Promise<unknown>>();
  locked<T>(mount: Mount, path: string, fn: () => Promise<T>): Promise<T> {
    const key = join(repoDir(mount, this.config.dataPath), ...mount.subpath.split('/'), ...cleanRelPath(path).split('/'));
    const run = (this.writing.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.writing.set(key, run);
    void run.finally(() => this.writing.get(key) === run && this.writing.delete(key)).catch(() => undefined);
    return run;
  }

  /** Fetches and integrates remote changes, pushes local commits (remote mounts only). */
  async sync(mount: Mount): Promise<SyncResult | null> {
    if (mount.type !== 'remote' || mount.paused) return null;
    const repo = this.runtime(repoDir(mount, this.config.dataPath));
    this.store.setSyncStatus(mount.id, 'syncing');
    try {
      // Pending edits block a rebase: then they get the batch commit now instead of after the pause.
      const result = await this.serial(repo, () =>
        sync({ dir: repo.dir, branch: mount.branch ?? 'main', git: this.gitOptions(mount), commitPending: async () => await this.takeBatch(mount, repo)?.() }),
      );
      const detail = result.status === 'conflict' ? JSON.stringify(result.conflict) : null;
      this.noteSync(mount, result);
      for (const m of this.sharing(repo.dir)) {
        this.store.setSyncStatus(m.id, result.status === 'conflict' ? 'conflict' : 'ok', detail);
        if (result.incoming.length) await this.reindexRepoPaths(m, result.incoming);
        this.events.emit({ type: 'mount', mount: this.store.get(m.id)! });
      }
      return result;
    } catch (e) {
      this.fail(mount, e);
      return null;
    }
  }

  /** „Jetzt abgleichen“: commits waiting edits and syncs once – a commit of a remote mount already syncs. */
  async syncNow(mount: Mount): Promise<SyncResult | null> {
    const committed = mount.options.autoCommit ? await this.commitNow(mount) : undefined;
    return committed !== undefined ? committed : this.sync(mount);
  }

  /** Syncs each clone once; `mounts` (default: all) with syncNow when `now` (a click), else plain sync (timer). */
  async syncAll(mounts: Mount[] = this.store.list(), now = false) {
    const seen = new Set<string>();
    for (const mount of mounts) {
      const dir = repoDir(mount, this.config.dataPath);
      if (mount.type !== 'remote' || mount.paused || seen.has(dir)) continue;
      seen.add(dir);
      // A failed commit still gets the sync (sync itself never throws).
      if (now) await this.syncNow(mount).catch(() => this.sync(mount));
      else await this.sync(mount);
    }
  }

  /** Remote mounts whose source matches a pushed repository (webhook). */
  findBySource(urls: string[], branch: string | null): Mount[] {
    const norm = (u: string) => u.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
    const wanted = new Set(urls.map(norm));
    return this.store.list().filter((m) => m.type === 'remote' && wanted.has(norm(m.source)) && (!branch || (m.branch ?? 'main') === branch));
  }

  private async activate(mount: Mount) {
    // A folder is checked again at every start, not only when it was added: a database from a backup (AD-075) could name
    // any folder of the container (sec-004 0.2.7).
    if (mount.type === 'local' && this.config.localRoots.length) validateSource('local', mount.source, this.config.localRoots);
    const dir = repoDir(mount, this.config.dataPath);
    if (mount.type === 'remote') await this.ensureClone(mount, dir);
    else {
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`Ordner nicht gefunden: ${dir}`);
      // A folder with versions unpacked from a backup on a new server (AD-071): its Git comes back from the bundle.
      if (mount.options.autoCommit && existsSync(join(dir, HISTORY_BUNDLE)) && !insideRepo(dir, this.config.localRoots)) {
        const { restored } = await this.serial(this.runtime(dir), () => initVersions(dir, APP_AUTHOR));
        if (restored) this.note(mount, { category: 'system', action: 'versions-on', message: `Versionen eingeschaltet: ${mount.name} (Verlauf aus der Sicherung übernommen)` });
      }
    }
    const change = await this.indexer.rebuild(mount);
    this.events.emit({ type: 'tree', mountId: mount.id, change });
    // What changed while the server was down (a pull elsewhere, an editor) – from outside.
    this.changes?.record(mount.id, change, null);
    await this.watch(dir);
    this.store.setSyncStatus(mount.id, 'ok');
  }

  async ensureClone(mount: Mount, dir = repoDir(mount, this.config.dataPath)) {
    if (await stat(`${dir}/.git`).catch(() => null)) return;
    await mkdir(dirname(dir), { recursive: true });
    const branchArgs = mount.branch ? ['-b', mount.branch] : [];
    await git(dirname(dir), ['clone', '-q', ...branchArgs, '--', mount.source, dir], this.gitOptions(mount));
  }

  private async watch(dir: string) {
    const repo = this.runtime(dir);
    if (repo.subscription) return;
    repo.subscription = await watcher.subscribe(
      dir,
      (err, events) => {
        if (err) {
          this.log.warn({ err, dir }, 'watcher error');
          // e.g. „Unable to poll: Interrupted system call“: the subscription delivers nothing after
          // that – outside changes would be missed until a restart. Start it again and compare.
          if (!this.rewatching)
            for (const m of this.sharing(dir))
              this.note(m, { category: 'error', level: 'warn', action: 'watcher', message: `Dateiüberwachung unterbrochen (${err.message}) – wird neu gestartet und abgeglichen` });
          // One failure reaches every subscription; only one while the restart is already running
          // (subscribing anew, comparing) is a second one.
          if (this.rewatching === 'running') this.rewatchAgain = true;
          this.rewatch();
          return;
        }
        for (const e of events) repo.watchPaths.add(e.path);
        clearTimeout(repo.watchTimer);
        // 300 ms of quiet bundle a burst – but at most 1 s after the first event: steady app saves
        // (someone typing) must not keep postponing outside changes for ever.
        repo.watchSince ??= Date.now();
        repo.watchTimer = setTimeout(
          () => {
            repo.watchSince = undefined;
            void this.track(() => {
              const run = (repo.watchFlush ?? Promise.resolve()).then(() => this.flushWatch(repo));
              repo.watchFlush = run.catch(() => undefined);
              return run;
            });
          },
          Math.max(0, Math.min(300, repo.watchSince + 1000 - Date.now())),
        );
      },
      { ignore: ['.git', '**/.git/**', '**/node_modules/**'] },
    );
  }

  /**
   * After a watcher error: every subscription ends, then all are made anew, then one full index
   * comparison of every source. The error comes from the watcher's one background thread and
   * reaches every subscription at once — one restart for all of them. A failure that comes while
   * the restart is still running (seen in tests: git child processes interrupt the poll again)
   * starts another one afterwards; before, it was dropped and outside changes stayed invisible.
   */
  private rewatch(delayMs = 1000) {
    if (this.rewatching || this.stopped) return;
    this.rewatching = 'waiting';
    setTimeout(
      () =>
        this.track(async () => {
          this.rewatching = 'running';
          try {
            const repos = [...this.repos.values()].filter((r) => r.subscription);
            for (const r of repos) {
              const old = r.subscription;
              r.subscription = undefined;
              await old?.unsubscribe().catch(() => undefined);
            }
            if (this.stopped) return;
            for (const r of repos) await this.watch(r.dir);
            for (const r of repos) {
              for (const mount of this.sharing(r.dir)) {
                const change = await this.indexer.rebuild(mount);
                if (!change.added.length && !change.updated.length && !change.removed.length && !change.renamed.length) continue;
                this.events.emit({ type: 'tree', mountId: mount.id, change });
                this.changes?.record(mount.id, change, null);
                for (const p of [...change.added, ...change.updated]) this.events.emit({ type: 'note', mountId: mount.id, path: p, hash: this.indexer.get(mount.id, p)?.hash ?? null });
                for (const p of change.removed) this.events.emit({ type: 'note', mountId: mount.id, path: p, hash: null });
                if (change.renamed.length) this.renameHandler?.(mount, change.renamed);
              }
            }
          } catch (e) {
            this.log.warn({ err: e }, 'watcher restart failed');
            this.rewatchAgain = true;
          } finally {
            this.rewatching = null;
            if (this.rewatchAgain && !this.stopped) {
              this.rewatchAgain = false;
              this.rewatch();
            }
          }
        }),
      delayMs,
    ).unref();
  }

  private async flushWatch(repo: RepoRuntime) {
    const paths = [...repo.watchPaths];
    repo.watchPaths.clear();
    for (const mount of this.sharing(repo.dir)) {
      try {
        // Throws for a subpath that turned into a link (AD-047) – only this source fails, not the others.
        const root = contentRoot(mount, this.config.dataPath);
        const rels = paths
          .filter((p) => p === root || p.startsWith(root + sep))
          .map((p) => relative(root, p).split(sep).join('/'))
          .filter((p) => !p.split('/').some((seg) => seg.startsWith('.kaveyl-wiki-tmp')))
          // An import writing there indexes and records its files itself at the end, under the person (whileWriting).
          .filter((p) => !this.isBeingWritten(mount, p));
        if (!rels.length) continue;
        const now = Date.now();
        const recent = [...(this.recentWrites.get(mount.id) ?? [])].filter(([, at]) => now - at <= RECENT_WRITE_MS).map(([p]) => p);
        // A folder with versions (AD-071): what another program changes there becomes a version too – files the app
        // wrote itself are already in a batch under the person's name.
        if (await this.keepsVersions(mount, repo)) {
          // A failing git (a refused setting, `.git` gone) costs the version, not the index update below.
          await this.commitOutside(mount, repo, root, rels).catch((e: unknown) => {
            this.log.warn({ err: e, mount: mount.id }, 'outside change not committed');
            this.note(mount, { category: 'error', level: 'warn', action: 'versions', message: `Änderung von außen nicht als Version übernommen: ${e instanceof Error ? e.message : String(e)}` });
          });
        }
        for (const p of recent) if (!rels.includes(p)) rels.push(p);
        const change = await this.indexer.update(mount, rels);
        if (change.added.length || change.updated.length || change.removed.length || change.renamed.length) {
          this.events.emit({ type: 'tree', mountId: mount.id, change });
          this.changes?.record(mount.id, change, null);
          for (const p of change.updated) this.events.emit({ type: 'note', mountId: mount.id, path: p, hash: this.indexer.get(mount.id, p)?.hash ?? null });
          for (const p of change.removed) this.events.emit({ type: 'note', mountId: mount.id, path: p, hash: null });
        }
        if (change.renamed.length) this.renameHandler?.(mount, change.renamed);
      } catch (e) {
        this.log.warn({ err: e, mount: mount.id }, 'index update failed');
        this.note(mount, { category: 'error', level: 'warn', action: 'index', message: `Index-Aktualisierung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  /**
   * While `work` writes many files below `folder` (an import, docs/PLAN-IMPORT.md), the watcher leaves them alone – no
   * index update, no „change from outside“, no version of its own; `work` ends with `touched()`, which indexes them once
   * and records them under the person's name.
   */
  async whileWriting<T>(mount: Mount, folder: string, work: () => Promise<T>): Promise<T> {
    const list = this.writingIn.get(mount.id) ?? [];
    this.writingIn.set(mount.id, list);
    list.push(folder);
    try {
      return await work();
    } finally {
      list.splice(list.indexOf(folder), 1);
    }
  }

  private isBeingWritten(mount: Mount, rel: string): boolean {
    return (this.writingIn.get(mount.id) ?? []).some((f) => rel === f || rel.startsWith(`${f}/`));
  }

  /** What another program changed among `rels` (mount-relative) goes into the next batch as „Kaveyl Wiki“ (AD-071). */
  private async commitOutside(mount: Mount, repo: RepoRuntime, root: string, rels: string[]) {
    const candidates = rels.filter((p) => !repo.pendingPaths.has(p) && !p.split('/').some(isIgnoredSegment));
    if (!candidates.length) return;
    // Only what git sees as changed (an app save already committed, a folder or an ignored file is none). Its paths are
    // relative to the repository's root – the source may be a folder below it.
    const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    const status = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...candidates], { env: { GIT_LITERAL_PATHSPECS: '1' } });
    const changed = [...new Set(porcelainPaths(status))]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .filter((p) => candidates.includes(p) && !p.split('/').some(isIgnoredSegment));
    // Plain text put into an encrypted folder from outside never goes into the history (AD-045) – it waits for „Verschlüsseln“.
    const plain = await this.plainInEncrypted(mount, changed);
    const outside = changed.filter((p) => !plain.includes(p));
    if (plain.length)
      this.note(mount, { category: 'sync', level: 'warn', action: 'plain-outside', message: `Unverschlüsselt in einem verschlüsselten Ordner abgelegt, nicht in die Versionen übernommen: ${plain.join(', ')}` });
    if (outside.length) this.schedule(mount, outside, APP_AUTHOR, outsideMessage(outside));
  }

  /** Files among `paths` that lie readable in an encrypted folder: a note without its age block, or any other file not `.age`. */
  private async plainInEncrypted(mount: Mount, paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const p of paths) {
      if (posix.basename(p) === FOLDER_META || !(await inEncryptedFolder(mount, this.config.dataPath, p))) continue;
      const raw = await readFile(join(contentRoot(mount, this.config.dataPath), ...p.split('/')), 'utf8').catch(() => null);
      if (raw === null) continue; // deleted
      if (p.endsWith('.md') ? !(isEncryptedNote(raw) && isAgeBody(raw)) : !p.endsWith('.age')) out.push(p);
    }
    return out;
  }

  /** A local folder whose Git Kaveyl Wiki made for versions (marked in its config) and whose commits are on. */
  private async keepsVersions(mount: Mount, repo: RepoRuntime): Promise<boolean> {
    if (mount.type !== 'local' || !mount.options.autoCommit) return false;
    // Not set = no versions (remembered); a failing git is asked again next time.
    repo.versions ??= git(repo.dir, ['config', '--get', VERSIONS_MARK], { okCodes: [1] }).then(
      (v) => v.trim() === 'true',
      () => {
        repo.versions = undefined;
        return false;
      },
    );
    return repo.versions;
  }

  /** Paths from git are repo-relative; translate to mount-relative and reindex (renames as hints). */
  private async reindexRepoPaths(mount: Mount, incoming: FileChange[]) {
    const prefix = mount.subpath ? mount.subpath + '/' : '';
    const rel = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : null);
    const rels = new Set<string>();
    const hints = new Map<string, string>();
    for (const c of incoming) {
      const to = rel(c.path);
      const from = c.from ? rel(c.from) : null;
      if (to !== null) rels.add(to);
      if (from !== null) rels.add(from);
      if (c.status === 'R' && to !== null && from !== null) hints.set(to, from);
    }
    if (!rels.size) return;
    const change = await this.indexer.update(mount, [...rels], hints);
    this.events.emit({ type: 'tree', mountId: mount.id, change });
    this.changes?.record(mount.id, change, null);
    for (const p of [...change.updated, ...change.added]) this.events.emit({ type: 'note', mountId: mount.id, path: p, hash: this.indexer.get(mount.id, p)?.hash ?? null });
    for (const p of change.removed) this.events.emit({ type: 'note', mountId: mount.id, path: p, hash: null });
    if (change.renamed.length) this.renameHandler?.(mount, change.renamed);
  }

  private sharing(dir: string): Mount[] {
    return this.store.list().filter((m) => !m.paused && repoDir(m, this.config.dataPath) === dir);
  }

  private runtime(dir: string): RepoRuntime {
    let repo = this.repos.get(dir);
    if (!repo) {
      repo = { dir, queue: Promise.resolve(), pendingPaths: new Set(), pendingBy: new Map(), watchPaths: new Set() };
      this.repos.set(dir, repo);
    }
    return repo;
  }

  private serial<T>(repo: RepoRuntime, fn: () => Promise<T>): Promise<T> {
    const run = repo.queue.then(fn, fn);
    repo.queue = run.catch(() => undefined);
    return run;
  }

  /** Logs what a sync changed; repeated states (conflict, up-to-date) are not logged again. */
  private noteSync(mount: Mount, r: SyncResult) {
    const before = this.settled.get(mount.id)?.status;
    this.settled.set(mount.id, { status: r.status === 'conflict' ? 'conflict' : 'ok', detail: null });
    if (r.status === 'conflict') {
      if (before !== 'conflict') {
        this.note(mount, { category: 'sync', level: 'warn', action: 'conflict', message: `Konflikt mit Änderungen auf dem Server: ${r.conflict?.files.join(', ') ?? ''}`, detail: { files: r.conflict?.files, paths: this.notePaths(mount, r.conflict?.files ?? []) } });
      }
      return;
    }
    if (before === 'error') this.note(mount, { category: 'sync', action: 'recovered', message: 'Wieder synchron' });
    if (r.remoteRewritten) this.note(mount, { category: 'sync', level: 'warn', action: 'force-push', message: 'Der Server-Branch wurde umgeschrieben (Force-Push); eigene Commits wurden neu aufgesetzt' });
    if (r.pushed || r.incoming.length) {
      const parts = [r.pushed ? `${r.pushed} Commit${r.pushed === 1 ? '' : 's'} gepusht` : '', r.incoming.length ? `${r.incoming.length} Datei${r.incoming.length === 1 ? '' : 'en'} vom Server geholt` : ''];
      this.note(mount, { category: 'sync', action: 'synced', message: parts.filter(Boolean).join(', '), detail: { pushed: r.pushed, incoming: r.incoming.slice(0, 50).map((c) => `${c.status} ${c.from ? `${c.from} → ` : ''}${c.path}`), paths: this.notePaths(mount, r.incoming.flatMap((c) => (c.from ? [c.from, c.path] : [c.path]))) } });
    }
  }

  private fail(mount: Mount, e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    this.log.error({ mount: mount.id, err: message }, 'mount error');
    if (this.stopped) return;
    // Same error again (e.g. server offline on every interval): log once, not every 5 minutes.
    const prev = this.settled.get(mount.id);
    if (prev?.status !== 'error' || prev.detail !== message) {
      this.note(mount, { category: 'error', action: 'sync-failed', message });
    }
    this.settled.set(mount.id, { status: 'error', detail: message });
    this.store.setSyncStatus(mount.id, 'error', message);
    this.events.emit({ type: 'mount', mount: this.store.get(mount.id) ?? mount });
  }
}
