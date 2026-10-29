// Sync cycle for `remote` mounts (app-owned clones): fetch → fast-forward or rebase
// local commits (pending edits are committed first via `commitPending`) → push. Conflicts are never resolved silently:
// the rebase is aborted, local work stays on the branch and is additionally pinned
// under refs/kaveyl-wiki/conflicts/<timestamp> for the conflict UI. The upstream state the branch
// was last brought onto is kept in refs/kaveyl-wiki/synced/<branch>, so a force-push fetched by an
// aborted sync is still recognized by the next one.
// SEE-DOC: docs/PLAN.md §2.8, DECISION: AD-003

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, gitOk, GitError, GitTimeoutError, type GitOptions } from './git.js';

export interface Author {
  name: string;
  email: string;
  /** Commit message for this change instead of the generic one (e.g. `ai(...)`, AD-026). */
  message?: string;
  /** The account behind it and the way in – for the change feed (AD-066), not written into Git. */
  userId?: string;
  via?: 'app' | 'api' | 'mcp';
}

export interface SyncTarget {
  dir: string;
  branch: string;
  remote?: string;
  git?: GitOptions;
  /** Identity used as committer (and for rebased commits). */
  committer?: Author;
  /** Commit only changes below `dir` (a local folder inside a bigger repository), not the whole working tree. */
  onlyDir?: boolean;
  /** Commits pending edits; called when a rebase is due and the working tree is not clean (a rebase refuses to start then). */
  commitPending?: () => Promise<unknown>;
}

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;
  /** Previous path for renames/copies. */
  from?: string;
}

export interface SyncResult {
  status: 'up-to-date' | 'synced' | 'conflict';
  /** Remote changes now present in the working tree (renames detected via -M). */
  incoming: FileChange[];
  /** Number of local commits pushed. */
  pushed: number;
  /** The remote branch was rewritten (force-push) since the last fetch. */
  remoteRewritten: boolean;
  conflict?: { files: string[]; ref: string };
}

/** The app itself as commit author (merges, link repairs). */
export const APP_AUTHOR: Author = { name: 'Kaveyl Wiki', email: 'kaveyl-wiki@localhost' };
const BOT = APP_AUTHOR;

function identityEnv(author: Author, committer: Author): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
}

/** Commits all pending changes in the working tree (or below `dir`). Returns the new commit or null if clean. */
/**
 * Commits what is waiting – everything (in a local folder: below it), or with `paths` (relative to `t.dir`) only
 * those files. `coAuthors` (others who edited the same files in this batch) become `Co-authored-by` trailers.
 */
export async function commitPending(t: SyncTarget, message: string, author: Author, paths?: string[], coAuthors: Author[] = []): Promise<string | null> {
  let scope = t.onlyDir ? ['--', '.'] : [];
  // File names are names, never patterns: a file called `*` must not take other files along (sec-005).
  t = { ...t, git: { ...t.git, env: { ...t.git?.env, GIT_LITERAL_PATHSPECS: '1' } } };
  // One line: a line break in a file name must not make up trailers such as `Co-authored-by` (sec-005).
  message = message.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  if (paths) {
    // Only files that really changed: a pathspec that matches nothing (created and deleted again) makes git fail.
    const changed = await Promise.all(paths.map(async (p) => ((await git(t.dir, ['status', '--porcelain', '-z', '--', p], t.git)) ? p : null)));
    scope = ['--', ...changed.filter((p): p is string => p !== null)];
    if (scope.length === 1) return null;
  }
  const status = await git(t.dir, ['status', '--porcelain', '-z', ...scope], t.git);
  if (!status) return null;
  await git(t.dir, ['add', '-A', ...scope], t.git);
  const committer = t.committer ?? BOT;
  // A line break or „<…>“ in a name would make up further co-authors (sec-004) – also for names stored before.
  const plain = (s: string) => s.replace(/[\s\p{Cc}<>]*[\p{Cc}\p{Zl}\p{Zp}<>][\s\p{Cc}<>]*/gu, ' ').trim();
  const trailers = coAuthors.length ? '\n\n' + coAuthors.map((a) => `Co-authored-by: ${plain(a.name)} <${a.email}>`).join('\n') : '';
  await git(t.dir, ['commit', '-q', '--no-verify', '-m', message + trailers, ...scope], {
    ...t.git,
    env: { ...t.git?.env, ...identityEnv(author, committer) },
  });
  return (await git(t.dir, ['rev-parse', 'HEAD'], t.git)).trim();
}

export async function sync(t: SyncTarget, attempt = 0): Promise<SyncResult> {
  const remote = t.remote ?? 'origin';
  const remoteRef = `refs/remotes/${remote}/${t.branch}`;
  const committer = t.committer ?? BOT;
  const opts: GitOptions = { ...t.git, env: { ...t.git?.env, ...identityEnv(committer, committer) } };

  const syncedRef = `refs/kaveyl-wiki/synced/${t.branch}`;
  const synced = await revParse(t.dir, syncedRef, opts);
  const prev = await revParse(t.dir, remoteRef, opts);
  await git(t.dir, ['fetch', '-q', remote, `+refs/heads/${t.branch}:${remoteRef}`], opts);
  const after = await revParse(t.dir, remoteRef, opts);
  if (!after) throw new Error(`remote branch ${remote}/${t.branch} not found`);
  // The upstream state HEAD is based on: normally the remote ref before this fetch. A sync that
  // fetched but stopped before bringing HEAD onto it (conflict, error) left that ref ahead of
  // HEAD — then the state of the last completed sync is the one to compare with.
  let before = prev;
  if (prev && synced && !(await isAncestor(t.dir, prev, 'HEAD', opts)) && (await isAncestor(t.dir, synced, 'HEAD', opts))) before = synced;
  const markSynced = async () => {
    if (synced !== after) await git(t.dir, ['update-ref', syncedRef, after], opts);
  };

  const remoteRewritten = !!before && before !== after && !(await isAncestor(t.dir, before, after, opts));
  let head = (await git(t.dir, ['rev-parse', 'HEAD'], opts)).trim();
  // After a force-push only commits made on top of the previously known remote state are
  // ours to replay; everything else was deliberately removed upstream.
  const upstreamBase = remoteRewritten ? before! : after;
  const base = remoteRewritten ? before! : (await git(t.dir, ['merge-base', 'HEAD', after], opts)).trim();
  const ahead = await count(t.dir, `${upstreamBase}..HEAD`, opts);
  const behind = head === after ? 0 : await count(t.dir, `HEAD..${after}`, opts);

  if (!remoteRewritten && behind === 0 && ahead === 0) {
    await markSynced();
    return { status: 'up-to-date', incoming: [], pushed: 0, remoteRewritten };
  }

  const incoming = behind > 0 || remoteRewritten ? await diffNameStatus(t.dir, base, after, opts) : [];

  if (behind > 0 || remoteRewritten) {
    if (ahead === 0) {
      await git(t.dir, ['reset', '-q', '--keep', after], opts);
    } else {
      if (t.commitPending && (await git(t.dir, ['status', '--porcelain', '-uno'], opts))) {
        await t.commitPending();
        head = (await git(t.dir, ['rev-parse', 'HEAD'], opts)).trim();
      }
      const rebaseArgs = remoteRewritten ? ['rebase', '-q', '--onto', after, before!] : ['rebase', '-q', after];
      try {
        await git(t.dir, rebaseArgs, opts);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        // Only a rebase that stopped is a conflict; one that never started (dirty tree) is an error.
        if (!(await rebasing(t.dir, opts))) throw e;
        const files = (await git(t.dir, ['diff', '--name-only', '-z', '--diff-filter=U'], opts)).split('\0').filter(Boolean);
        await gitOk(t.dir, ['rebase', '--abort'], opts);
        // One safety ref per local state — repeated sync attempts must not pile up refs.
        const existing = (await git(t.dir, ['for-each-ref', '--points-at', head, '--format=%(refname)', 'refs/kaveyl-wiki/conflicts/'], opts)).trim().split('\n')[0];
        const ref = existing || `refs/kaveyl-wiki/conflicts/${new Date().toISOString().replace(/[:.]/g, '-')}`;
        if (!existing) await git(t.dir, ['update-ref', ref, head], opts);
        // The conflict resolution needs the server state the own commits were made on (AD-048).
        if (remoteRewritten && synced !== before) await git(t.dir, ['update-ref', syncedRef, before!], opts);
        return { status: 'conflict', incoming: [], pushed: 0, remoteRewritten, conflict: { files, ref } };
      }
    }
  }
  await markSynced(); // HEAD is now based on `after`

  let pushed = 0;
  const toPush = await count(t.dir, `${after}..HEAD`, opts);
  if (toPush > 0) {
    try {
      await git(t.dir, ['push', '-q', remote, `HEAD:refs/heads/${t.branch}`], opts);
      pushed = toPush;
    } catch (e) {
      // Someone pushed in between: fetch and replay once more. Not after a timeout: the server is not answering.
      if (e instanceof GitError && !(e instanceof GitTimeoutError) && attempt < 2) {
        const retry = await sync(t, attempt + 1);
        return { ...retry, incoming: [...incoming, ...retry.incoming], remoteRewritten: remoteRewritten || retry.remoteRewritten };
      }
      throw e;
    }
  }

  return { status: 'synced', incoming, pushed, remoteRewritten };
}

async function revParse(dir: string, ref: string, opts: GitOptions): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--verify', '-q', ref], opts)).trim() || null;
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

async function rebasing(dir: string, opts: GitOptions): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    if (existsSync(resolve(dir, (await git(dir, ['rev-parse', '--git-path', name], opts)).trim()))) return true;
  }
  return false;
}

function isAncestor(dir: string, a: string, b: string, opts: GitOptions): Promise<boolean> {
  return gitOk(dir, ['merge-base', '--is-ancestor', a, b], opts);
}

async function count(dir: string, range: string, opts: GitOptions): Promise<number> {
  return Number((await git(dir, ['rev-list', '--count', range], opts)).trim());
}

export async function diffNameStatus(dir: string, from: string, to: string, opts: GitOptions = {}): Promise<FileChange[]> {
  const out = await git(dir, ['diff', '--name-status', '-M', '-z', from, to], opts);
  const parts = out.split('\0').filter((p) => p !== '');
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]![0] as FileChange['status'];
    if (status === 'R' || status === 'C') {
      const fromPath = parts[i++]!;
      changes.push({ status, path: parts[i++]!, from: fromPath });
    } else {
      changes.push({ status, path: parts[i++]! });
    }
  }
  return changes;
}
