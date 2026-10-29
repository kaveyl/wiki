// Helpers for the mount wizard: branch list, local folder browser
// and the selectable file tree (folders + Markdown files) of a source before mounting.
// SEE-DOC: docs/PLAN.md §2.1 (Mount-Assistent)

import { existsSync } from 'node:fs';
import { access, constants, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { git, type GitOptions } from '../git/git.js';
import { isIgnoredSegment, PathError, type MountOptions } from './model.js';
import { createRepo, hostFullName, listOwners, type HostOwner, type HostRepo, type NewHostRepo } from './hosts.js';

export interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  /** Number of Markdown files in this folder (recursive). */
  notes: number;
  children?: TreeNode[];
}

// Gitea helpers of the first version, now thin wrappers around the hoster APIs (AD-029).
export type GiteaRepo = HostRepo;
export type GiteaOwner = HostOwner;
export type NewGiteaRepo = NewHostRepo;
export { HostError as GiteaError } from './hosts.js';

const giteaAt = (baseUrl: string, token: string) => ({ kind: 'gitea' as const, base: baseUrl, token });

/** The token's own user plus the organisations it belongs to — where a new repo may live. */
export const listGiteaOwners = (baseUrl: string, token: string) => listOwners(giteaAt(baseUrl, token));
/** Creates a repository with an initial README on `main`, so it can be mounted right away. */
export const createGiteaRepo = (baseUrl: string, token: string, repo: NewGiteaRepo) => createRepo(giteaAt(baseUrl, token), repo);
/** `owner/repo` from a clone URL on the given Gitea (null if it points elsewhere). */
export const giteaFullName = (baseUrl: string, cloneUrl: string) => hostFullName('gitea', baseUrl, cloneUrl);

export async function listBranches(url: string, opts: GitOptions): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-ls-'));
  try {
    const out = await git(dir, ['ls-remote', '--heads', '--', url], opts);
    return out
      .split('\n')
      .map((l) => l.split('\t')[1]?.replace('refs/heads/', ''))
      .filter((b): b is string => !!b)
      .sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Folders inside the allowed local roots (only directories, no files). */
/**
 * Folders below a local root; `isRepo` for each and for the folder itself (decides whether commit
 * options make sense). At the top level only roots really mounted into the container, with
 * `writable` — Docker creates a missing host folder as root, which the app user cannot write.
 */
export async function browseLocal(
  roots: string[],
  path: string | null,
): Promise<{ path: string | null; isRepo: boolean; dirs: { name: string; path: string; isRepo: boolean; writable?: boolean }[] }> {
  const repo = async (dir: string) => insideRepo(dir, roots);
  if (!path) {
    // An unmounted /docs would keep notes in the container layer only: not offered.
    const present = (await Promise.all(roots.map(async (r) => ((await stat(r).catch(() => null))?.isDirectory() ? r : null)))).filter((r): r is string => !!r);
    return {
      path: null,
      isRepo: false,
      dirs: await Promise.all(
        present.map(async (r) => ({ name: r, path: r, isRepo: await repo(r), writable: await access(r, constants.W_OK).then(() => true, () => false) })),
      ),
    };
  }
  const abs = assertInRoots(roots, path);
  const items = await readdir(abs, { withFileTypes: true });
  const dirs = items.filter((i) => i.isDirectory() && !isIgnoredSegment(i.name)).sort((a, b) => a.name.localeCompare(b.name));
  return { path: abs, isRepo: await repo(abs), dirs: await Promise.all(dirs.map(async (d) => ({ name: d.name, path: join(abs, d.name), isRepo: await repo(join(abs, d.name)) }))) };
}

/**
 * A new folder for a local source, directly inside `parent` (a local root or a folder below one). The name is one
 * plain folder name: no path, nothing hidden, no control characters.
 */
export async function createLocalFolder(roots: string[], parent: string, name: string): Promise<string> {
  const clean = name.trim();
  if (!clean || clean.length > 120 || /[/\\\p{Cc}]/u.test(clean) || clean.startsWith('.')) throw new PathError('Ungültiger Ordnername');
  const target = assertInRoots(roots, join(assertInRoots(roots, parent), clean));
  try {
    await mkdir(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new PathError(`Den Ordner „${clean}“ gibt es dort schon`);
    if ((e as NodeJS.ErrnoException).code === 'EACCES') throw new PathError('Kaveyl Wiki darf in diesem Ordner nichts anlegen (Besitzer/Rechte des Ordners)');
    throw e;
  }
  return target;
}

export function assertInRoots(roots: string[], path: string): string {
  const abs = resolve(path);
  if (!roots.some((r) => abs === r || abs.startsWith(r + sep))) throw new PathError('Ordner liegt außerhalb der freigegebenen Wurzeln (LOCAL_ROOTS)');
  return abs;
}

/**
 * The folder or one above it — up to its local root, never beyond — is a Git work tree (`.git`
 * folder or file): commits work there too. Without roots only the folder itself counts.
 */
export function insideRepo(dir: string, roots: string[] = []): boolean {
  const root = roots.map((r) => resolve(r)).find((r) => resolve(dir) === r || resolve(dir).startsWith(r + sep));
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (!root || d === root || dirname(d) === d) return false;
  }
}

/** Folders and Markdown files below `dir`, pruned to branches that contain Markdown. */
export async function markdownTree(dir: string, maxEntries = 5000): Promise<TreeNode> {
  let budget = maxEntries;
  async function build(abs: string, rel: string, name: string): Promise<TreeNode> {
    const node: TreeNode = { name, path: rel, kind: 'dir', notes: 0, children: [] };
    const items = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (budget-- <= 0 || item.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (isIgnoredSegment(item.name)) continue;
        const child = await build(join(abs, item.name), childRel, item.name);
        if (child.notes > 0) {
          node.children!.push(child);
          node.notes += child.notes;
        }
      } else if (item.isFile() && item.name.toLowerCase().endsWith('.md')) {
        node.children!.push({ name: item.name, path: childRel, kind: 'file', notes: 1 });
        node.notes += 1;
      }
    }
    node.children!.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return node;
  }
  return build(dir, '', '');
}

/**
 * Turns a checkbox selection into include globs. Selecting a folder includes everything
 * below it; selecting the root includes everything.
 */
export function selectionToGlobs(selected: { path: string; kind: 'dir' | 'file' }[]): string[] {
  if (!selected.length || selected.some((s) => s.path === '')) return ['**'];
  const dirs = selected.filter((s) => s.kind === 'dir').map((s) => s.path);
  const covered = (p: string) => dirs.some((d) => p !== d && p.startsWith(d + '/'));
  return selected
    .filter((s) => !covered(s.path))
    .map((s) => (s.kind === 'dir' ? `${s.path}/**` : s.path))
    .sort();
}

/** Mount options from the client: commit pause limited to 5 s … 1 h. */
export function cleanOptions(o: Partial<MountOptions> | undefined): Partial<MountOptions> | undefined {
  if (!o) return o;
  const out = { ...o };
  if (out.commitIdleSec !== undefined) {
    const n = Number(out.commitIdleSec);
    if (!Number.isFinite(n)) delete out.commitIdleSec;
    else out.commitIdleSec = Math.min(3600, Math.max(5, Math.round(n)));
  }
  // null, '' or -1 = back to the general rule (Einstellungen → KI); options merge, so it is stored as -1.
  if (out.aiChatDays !== undefined) {
    const n = Number(out.aiChatDays);
    if (out.aiChatDays === null || (out.aiChatDays as unknown) === '' || n < 0) out.aiChatDays = -1;
    else if (!Number.isFinite(n)) delete out.aiChatDays;
    else out.aiChatDays = Math.min(3650, Math.round(n));
  }
  return out;
}

/** A source address as entered: a local folder inside the allowed roots, or an https Git URL without credentials. */
export function validateSource(type: 'remote' | 'local', source: string, roots: string[]): string {
  if (type === 'local') return assertInRoots(roots, source);
  if (!/^https?:\/\/[^\s]+$/i.test(source)) throw new PathError('Nur HTTPS-Git-URLs werden unterstützt');
  if (/^https?:\/\/[^/]*@/i.test(source)) throw new PathError('Zugangsdaten gehören nicht in die URL – bitte Token separat angeben');
  return source;
}
