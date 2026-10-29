// Resolving sync conflicts of remote mounts (docs/PLAN.md §2.8, Konflikt-UI).
// When a rebase conflicts, sync() aborts it: local commits stay on the branch, the remote
// state is in refs/remotes/<remote>/<branch>. Here we compute the three versions per
// conflicted file without touching the working tree (`git merge-tree`), and resolve by a
// merge commit that carries the user's choice — nothing is overwritten silently.
// After a force-push (AD-048) the old upstream history must not come back: the base is the
// previous server state (refs/kaveyl-wiki/synced/<branch>) and the resolution is one commit on
// top of the new server state that carries only the own changes.

import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { PathError, throughSymlink } from '../mounts/model.js';
import { git, GitError, gitOk, type GitOptions } from './git.js';
import type { Author } from './sync.js';

export interface ConflictFile {
  /** Repository-relative path. */
  path: string;
  /** Common ancestor, local (mine) and remote (theirs) content; null = file absent there. */
  base: string | null;
  mine: string | null;
  theirs: string | null;
  /** Git's merge of both with conflict markers (null if one side deleted the file). */
  merged: string | null;
}

export interface Resolution {
  path: string;
  /** New content, or null to delete the file. */
  content: string | null;
}

export class StaleConflictError extends Error {}

/** Files that conflict between HEAD and the remote branch (empty if they merge cleanly). */
export async function conflictFiles(dir: string, remoteRef: string, opts: GitOptions = {}): Promise<ConflictFile[]> {
  const rewritten = await rewrittenBase(dir, remoteRef, opts);
  const { tree, paths } = await mergeTree(dir, remoteRef, rewritten, opts);
  if (!paths.size) return [];
  const base = rewritten ?? (await git(dir, ['merge-base', 'HEAD', remoteRef], opts)).trim();
  const show = async (rev: string, path: string) => {
    try {
      return await git(dir, ['show', `${rev}:${path}`], opts);
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  };
  const files: ConflictFile[] = [];
  for (const path of [...paths].sort()) {
    const [b, mine, theirs] = await Promise.all([show(base, path), show('HEAD', path), show(remoteRef, path)]);
    files.push({ path, base: b, mine, theirs, merged: mine !== null && theirs !== null ? await show(tree, path) : null });
  }
  return files;
}

/**
 * Merges the remote branch into HEAD and applies the user's resolutions for the conflicted
 * files. Throws StaleConflictError (and leaves the repository unchanged) when the set of
 * conflicting files differs from what the user resolved — e.g. new remote changes arrived.
 */
export async function resolveConflict(dir: string, remoteRef: string, resolutions: Resolution[], author: Author, opts: GitOptions = {}): Promise<string> {
  const env = { ...opts.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: 'Kaveyl Wiki', GIT_COMMITTER_EMAIL: 'kaveyl-wiki@localhost' };
  const o: GitOptions = { ...opts, env };
  const rewritten = await rewrittenBase(dir, remoteRef, o);
  if (rewritten) return resolveOnto(dir, remoteRef, rewritten, resolutions, o);
  await git(dir, ['merge', '--no-ff', '--no-commit', '--no-edit', remoteRef], { ...o, okCodes: [1] });
  try {
    const unmerged = new Set((await git(dir, ['diff', '--name-only', '-z', '--diff-filter=U'], o)).split('\0').filter(Boolean));
    checkResolutions(unmerged, resolutions);
    for (const r of resolutions) {
      const abs = workPath(dir, r.path);
      if (r.content === null) {
        await rm(abs, { force: true });
        await git(dir, ['rm', '-q', '--cached', '--ignore-unmatch', '--', r.path], o);
      } else {
        await mkdir(dirname(abs), { recursive: true });
        // The merge may have left the other side's symlink here: replace it, never write through it (AD-047).
        const st = await lstat(abs).catch(() => null);
        if (st && !st.isFile()) await rm(abs);
        await writeFile(abs, r.content);
        await git(dir, ['add', '--', r.path], o);
      }
    }
    const files = resolutions.map((r) => r.path).join(', ');
    await git(dir, ['commit', '-q', '--no-verify', '-m', `merge: Konflikt aufgelöst (${files}) (Kaveyl Wiki)`], o);
  } catch (e) {
    await git(dir, ['merge', '--abort'], o).catch(() => undefined);
    throw e;
  }
  return (await git(dir, ['rev-parse', 'HEAD'], o)).trim();
}

/** Working-tree path of a conflicted file; refused when a folder on the way is a symbolic link (AD-047). */
function workPath(dir: string, rel: string): string {
  const parent = posix.dirname(rel);
  if (parent !== '.' && throughSymlink(dir, parent)) throw new PathError('Pfad nicht erlaubt (symbolischer Link)');
  return join(dir, ...rel.split('/'));
}

function checkResolutions(unmerged: Set<string>, resolutions: Resolution[]) {
  const resolved = new Set(resolutions.map((r) => r.path));
  if ([...unmerged].some((p) => !resolved.has(p))) throw new StaleConflictError('Neue Konflikte seit dem Laden – bitte neu laden');
  // Only the conflicted files may be written: anything else would bypass the note routes (ACL, filters).
  if (!unmerged.size || [...resolved].some((p) => !unmerged.has(p))) throw new StaleConflictError('Keine passenden Konflikte (mehr) – bitte neu laden');
}

/**
 * The server state HEAD was built on when the remote branch has been rewritten since
 * (force-push, see sync.ts: refs/kaveyl-wiki/synced/<branch>), else null.
 */
async function rewrittenBase(dir: string, remoteRef: string, opts: GitOptions): Promise<string | null> {
  const branch = remoteRef.match(/^refs\/remotes\/[^/]+\/(.+)$/)?.[1];
  if (!branch) return null;
  const synced = (await git(dir, ['rev-parse', '--verify', '-q', `refs/kaveyl-wiki/synced/${branch}`], { ...opts, okCodes: [1] })).trim();
  if (!synced) return null;
  const ancestor = (a: string, b: string) => gitOk(dir, ['merge-base', '--is-ancestor', a, b], opts);
  return (await ancestor(synced, 'HEAD')) && !(await ancestor(synced, remoteRef)) ? synced : null;
}

/** Three-way merge of HEAD and the remote branch in memory; with `base`, against that state instead of the common ancestor. */
async function mergeTree(dir: string, remoteRef: string, base: string | null, opts: GitOptions): Promise<{ tree: string; paths: Set<string> }> {
  let ours = 'HEAD';
  let theirs = remoteRef;
  if (base) {
    // git 2.39 (image) has no `merge-tree --merge-base`: throwaway commits on a root with the base tree.
    // Fixed dates keep their hashes stable: git names a renamed side (file vs. symlink) `<path>~<commit>`.
    const fixed = '@0 +0000';
    const o: GitOptions = { ...opts, env: { ...opts.env, GIT_AUTHOR_NAME: 'Kaveyl Wiki', GIT_AUTHOR_EMAIL: 'kaveyl-wiki@localhost', GIT_COMMITTER_NAME: 'Kaveyl Wiki', GIT_COMMITTER_EMAIL: 'kaveyl-wiki@localhost', GIT_AUTHOR_DATE: fixed, GIT_COMMITTER_DATE: fixed } };
    const commit = async (rev: string, parent?: string) =>
      (await git(dir, ['commit-tree', `${rev}^{tree}`, ...(parent ? ['-p', parent] : []), '-m', 'Kaveyl Wiki: Hilfscommit'], o)).trim();
    const root = await commit(base);
    [ours, theirs] = [await commit('HEAD', root), await commit(remoteRef, root)];
  }
  const out = await git(dir, ['merge-tree', '--write-tree', '-z', ours, theirs], { ...opts, okCodes: [1] });
  const [tree = '', ...rest] = out.split('\0');
  const paths = new Set<string>();
  // Conflicted file info entries: "<mode> <object> <stage>\t<path>", ended by an empty entry.
  for (const entry of rest) {
    if (!entry) break;
    const tab = entry.indexOf('\t');
    if (tab > 0 && /^\d+ [0-9a-f]+ \d$/.test(entry.slice(0, tab))) paths.add(entry.slice(tab + 1));
  }
  return { tree: tree.trim(), paths };
}

/**
 * Force-push case: the own commits since `base` become one commit on top of the remote branch
 * (their changes merged against `base`, conflicted files as resolved) — like `rebase --onto`,
 * without a single commit of the old upstream history. Throws StaleConflictError like resolveConflict.
 */
async function resolveOnto(dir: string, remoteRef: string, base: string, resolutions: Resolution[], o: GitOptions): Promise<string> {
  const { tree, paths } = await mergeTree(dir, remoteRef, base, o);
  checkResolutions(paths, resolutions);
  const scratch = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-resolve-'));
  try {
    // Build the tree in a separate index; the working tree is only touched by the final reset.
    const io: GitOptions = { ...o, env: { ...o.env, GIT_INDEX_FILE: join(scratch, 'index') } };
    await git(dir, ['read-tree', tree], io);
    for (const [i, r] of resolutions.entries()) {
      if (r.content === null) {
        await git(dir, ['update-index', '--force-remove', '--', r.path], io);
        continue;
      }
      const file = join(scratch, `blob-${i}`);
      await writeFile(file, r.content);
      const blob = (await git(dir, ['hash-object', '-w', '--', file], io)).trim();
      // Keep only a file mode (executable or not); never a symlink (120000) or submodule (160000).
      const merged = (await git(dir, ['ls-tree', '--format=%(objectmode)', tree, '--', r.path], io)).trim();
      const mode = merged === '100755' ? merged : '100644';
      await git(dir, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${r.path}`], io);
    }
    const result = (await git(dir, ['write-tree'], io)).trim();
    const own = (await git(dir, ['log', '--reverse', '--format=- %s (%an)', `${base}..HEAD`], o)).trim();
    const files = resolutions.map((r) => r.path).join(', ');
    const message = `docs: Konflikt nach Force-Push aufgelöst (${files}) (Kaveyl Wiki)\n\nEigene Änderungen, neu aufgesetzt auf den neuen Server-Stand:\n${own}`;
    const commit = (await git(dir, ['commit-tree', result, '-p', remoteRef, '-m', message], o)).trim();
    // --keep: refuses (and changes nothing) if uncommitted edits would be overwritten.
    await git(dir, ['reset', '-q', '--keep', commit], o);
    return commit;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
