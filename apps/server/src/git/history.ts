// Version history and trash of notes, read straight from git (no own storage).
// Commands run inside the mount's content folder, so local mounts that are a sub-folder of
// a repository work as well; git prints repo-relative paths, mapped back via the prefix.
// Restoring never rewrites history: it writes the old content as a new change.
// SEE-DOC: docs/PLAN.md §2.8 (Versionshistorie, Papierkorb)

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathError } from '../mounts/model.js';
import { git, gitBuffer, GitError, gitOk } from './git.js';

export interface Version {
  commit: string;
  date: string;
  author: string;
  /** Others who edited it in the same commit (`Co-authored-by`, e.g. several people in one batch). */
  coAuthors?: string[];
  subject: string;
  /** Mount-relative path of the note in this version (differs before a rename). */
  path: string;
}

export interface DeletedNote {
  path: string;
  commit: string;
  date: string;
  author: string;
  subject: string;
}

const SEP = '\x1f';
/** Paths with umlauts etc. come out as UTF-8 instead of "\303\244"-quoted (found in the live test). */
const RAW_PATHS = ['-c', 'core.quotePath=false'];
const MARK = '\x1e';

/** Repo-relative prefix of the content folder (e.g. `docs/`), or null when not in a git repository. */
export async function repoPrefix(dir: string): Promise<string | null> {
  if (!(await gitOk(dir, ['rev-parse', '--is-inside-work-tree']))) return null;
  try {
    await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch (e) {
    if (e instanceof GitError) return null; // repository without commits
    throw e;
  }
  return (await git(dir, [...RAW_PATHS, 'rev-parse', '--show-prefix'])).trim();
}

/** Versions of one note, newest first, following renames. */
export async function fileHistory(dir: string, path: string, limit = 200): Promise<Version[]> {
  const prefix = await repoPrefix(dir);
  if (prefix === null) return [];
  const out = await git(dir, [
    ...RAW_PATHS,
    'log',
    '--follow',
    `-n${limit}`,
    '--name-status',
    '-M',
    `--format=${MARK}%H${SEP}%aI${SEP}%an${SEP}%(trailers:key=Co-authored-by,valueonly,separator=%x1d)${SEP}%s`,
    '--',
    path,
  ]);
  const versions: Version[] = [];
  for (const block of out.split(MARK).slice(1)) {
    const [head = '', ...rest] = block.split('\n');
    const [commit = '', date = '', author = '', co = '', subject = ''] = head.split(SEP);
    const coAuthors = co ? [...new Set(co.split('\x1d').map((c) => c.replace(/\s*<[^>]*>\s*$/, '').trim()))].filter((c) => c && c !== author) : [];
    const change = rest.find((l) => l.trim());
    // A deletion is not a version one could look at (the file does not exist there).
    if (change?.startsWith('D')) continue;
    // name-status: "M\tpath", "R087\told\tnew" — the version's path is the last column.
    const repoPath = change?.split('\t').pop() ?? prefix + path;
    versions.push({ commit, date, author, ...(coAuthors.length ? { coAuthors } : {}), subject, path: repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath });
    // „C“ = git took a new file for a copy of another one (a copied note, or one with nearly the same text): its history
    // starts here – what came before belongs to the other note and other people.
    if (change?.startsWith('C')) break;
  }
  return versions;
}

/**
 * Content of a note in a commit (mount-relative path), or null if it did not exist there.
 * `before` reads the state just before the commit (e.g. the content a deletion removed).
 */
export async function fileAt(dir: string, commit: string, path: string, before = false): Promise<string | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new PathError('Ungültige Commit-ID');
  try {
    return await git(dir, ['show', `${commit}${before ? '^' : ''}:./${path}`]);
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

/** Like fileAt(), as bytes (any file, e.g. an image a note linked to). */
export async function fileBytesAt(dir: string, commit: string, path: string, before = false): Promise<Buffer | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new PathError('Ungültige Commit-ID');
  try {
    return await gitBuffer(dir, ['show', `${commit}${before ? '^' : ''}:./${path}`]);
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

/** Unified diff between two texts (hunks only, no file headers); '' when equal. */
export async function textDiff(before: string, after: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-diff-'));
  try {
    await writeFile(join(tmp, 'a'), before);
    await writeFile(join(tmp, 'b'), after);
    const out = await git(tmp, ['diff', '--no-index', '--no-color', '--unified=3', 'a', 'b'], { okCodes: [1] });
    const start = out.indexOf('\n@@');
    return start < 0 ? '' : out.slice(start + 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Markdown files deleted in the history of the content folder that do not exist again. */
export async function deletedNotes(dir: string, exists: (path: string) => boolean, limit = 200): Promise<DeletedNote[]> {
  const prefix = await repoPrefix(dir);
  if (prefix === null) return [];
  const out = await git(dir, [...RAW_PATHS, 'log', '--diff-filter=D', '--name-only', '-M', `--format=${MARK}%H${SEP}%aI${SEP}%an${SEP}%s`, '--', '.']);
  const seen = new Set<string>();
  const result: DeletedNote[] = [];
  for (const block of out.split(MARK).slice(1)) {
    const [head = '', ...files] = block.split('\n');
    const [commit = '', date = '', author = '', subject = ''] = head.split(SEP);
    for (const f of files.map((l) => l.trim()).filter(Boolean)) {
      if (!f.startsWith(prefix) || !/\.md$/i.test(f)) continue;
      const path = f.slice(prefix.length);
      if (seen.has(path) || exists(path)) continue;
      seen.add(path);
      result.push({ path, commit, date, author, subject });
      if (result.length >= limit) return result;
    }
  }
  return result;
}
