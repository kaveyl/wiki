// Trash of deleted notes (AD-025). Two kinds of entries, shown as one list:
// - folder trash: Kaveyl Wiki moves what it deletes into `.kaveyl-wiki/trash/<id>/` inside the source
//   (sources without auto-commit); restoring moves it back, emptying deletes it for good;
// - git trash: in sources with auto-commit the git history holds deleted notes; one entry per
//   deleting commit. "Emptying" only hides entries (a date mark) — history is never rewritten.
// SEE-DOC: DECISIONS.md AD-025

import { randomBytes } from 'node:crypto';
import { copyFile, constants as fsc, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { DeletedNote } from '../git/history.js';
import { noLinkPath } from '../mounts/model.js';
import { META_DIR } from './meta.js';

export const TRASH_DIR = `${META_DIR}/trash`;

export interface TrashItem {
  /** `folder:<id>` or `git:<commit>`. */
  id: string;
  source: 'folder' | 'git';
  /** What was deleted: the note, the folder, or (git, several notes) their common folder. */
  path: string;
  isDir: boolean;
  /** Deleted notes, relative to the source root. */
  files: string[];
  date: string;
  author: string;
  /** Commit message (git entries). */
  subject: string | null;
}

interface Meta {
  path: string;
  isDir: boolean;
  files: string[];
  date: string;
  author: string;
}

const ID = /^[0-9]{13}-[0-9a-f]{8}$/;
// Never through a link (AD-047): the app folder, the trash, an entry or a file in it could point anywhere.
const trashRoot = (root: string) => noLinkPath(root, TRASH_DIR);
const itemDir = (root: string, id: string) => {
  if (!ID.test(id)) throw new Error('invalid trash id');
  return noLinkPath(root, `${TRASH_DIR}/${id}`);
};
const filePath = (dir: string, rel: string) => noLinkPath(dir, `files/${rel}`);
const trashIds = (root: string) =>
  Promise.resolve()
    .then(() => readdir(trashRoot(root)))
    .then(
      (ids) => ids.filter((x) => ID.test(x)),
      () => [] as string[],
    );

/** Moves `files` (paths relative to `root`) into a new trash entry; returns its id. */
export async function moveToTrash(root: string, path: string, isDir: boolean, files: string[], author: string, now = new Date()): Promise<string> {
  const base = trashRoot(root);
  await mkdir(base, { recursive: true });
  // Git must never pick the trash up (sources in a repository without auto-commit).
  await writeFile(join(base, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
  const id = `${now.getTime()}-${randomBytes(4).toString('hex')}`;
  const dir = join(base, id);
  const moved: string[] = [];
  for (const f of files) {
    const to = filePath(dir, f);
    await mkdir(dirname(to), { recursive: true });
    await rename(join(root, ...f.split('/')), to);
    moved.push(f);
  }
  const meta: Meta = { path, isDir, files: moved, date: now.toISOString(), author };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return id;
}

/** Entries of the folder trash, newest first. Broken entries (no readable meta) are skipped. */
export async function folderItems(root: string): Promise<TrashItem[]> {
  const out: TrashItem[] = [];
  for (const id of await trashIds(root)) {
    const meta = await readMeta(root, id);
    if (meta && meta.files.length) out.push({ id: `folder:${id}`, source: 'folder', ...meta, subject: null });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

async function readMeta(root: string, id: string): Promise<Meta | null> {
  try {
    const m = JSON.parse(await readFile(noLinkPath(itemDir(root, id), 'meta.json'), 'utf8')) as Meta;
    return Array.isArray(m.files) && typeof m.path === 'string' ? m : null;
  } catch {
    return null;
  }
}

/**
 * Moves files of a folder-trash entry back (all, or only `only`), to their old place or to
 * `target(file)` („unter anderem Namen“). Nothing is moved when any target exists already:
 * returns those in `conflicts` instead. `restored` holds the paths the files have now.
 */
/** Content of one file of a folder-trash entry (checked before restoring), or null. */
export async function folderTrashFile(root: string, id: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath(itemDir(root, id), rel));
  } catch {
    return null;
  }
}

export async function restoreFromFolder(
  root: string,
  id: string,
  only?: string[],
  target: (file: string) => string = (f) => f,
  /** Content folder the files go to (another source: „Speichern als“ there). */
  into: string = root,
): Promise<{ restored: string[]; conflicts: string[] }> {
  const meta = await readMeta(root, id);
  if (!meta) return { restored: [], conflicts: [] };
  const dir = itemDir(root, id);
  const files = only ? meta.files.filter((f) => only.includes(f)) : meta.files;
  const from = new Map(files.map((f) => [f, filePath(dir, f)])); // all checked before anything moves
  const conflicts: string[] = [];
  for (const f of files) if (await lstat(join(into, ...target(f).split('/'))).catch(() => null)) conflicts.push(target(f));
  if (conflicts.length) return { restored: [], conflicts };
  for (const f of files) {
    const to = join(into, ...target(f).split('/'));
    await mkdir(dirname(to), { recursive: true });
    // Sources are separate mounts in the container: rename fails across them (EXDEV).
    await rename(from.get(f)!, to).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EXDEV') throw e;
      await copyFile(from.get(f)!, to, fsc.COPYFILE_EXCL);
      await rm(from.get(f)!);
    });
  }
  const rest = meta.files.filter((f) => !files.includes(f));
  if (rest.length) await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, files: rest }, null, 2) + '\n');
  else await rm(dir, { recursive: true, force: true });
  return { restored: files.map(target), conflicts: [] };
}

/**
 * Where „unter anderem Namen wiederherstellen“ puts the files of an entry. A whole folder entry
 * (`asFolder`): `as` is the new folder; each file keeps its place below it. A single note: `as`
 * is its new path (the old extension is added when `as` has none).
 */
export function restoreTargets(itemPath: string, files: string[], as: string, asFolder: boolean): (file: string) => string {
  const dest = as.trim().replace(/^\/+|\/+$/g, '');
  if (!dest) throw new Error('empty target');
  if (!asFolder && files.length === 1) {
    const one = posix.extname(dest) ? dest : `${dest}${posix.extname(files[0]!)}`;
    return () => one;
  }
  return (f) => (itemPath && f.startsWith(`${itemPath}/`) ? `${dest}${f.slice(itemPath.length)}` : `${dest}/${f}`);
}

/** Deletes one folder-trash entry for good. */
export async function purgeFolderItem(root: string, id: string): Promise<boolean> {
  const dir = itemDir(root, id);
  if (!(await lstat(dir).catch(() => null))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Deletes folder-trash entries deleted before `cutoff` (all with `null`); returns how many. */
export async function purgeFolderTrash(root: string, cutoff: Date | null): Promise<number> {
  let n = 0;
  for (const item of await folderItems(root)) {
    if (cutoff && new Date(item.date) >= cutoff) continue;
    if (await purgeFolderItem(root, item.id.slice('folder:'.length))) n++;
  }
  // Entries without meta (an interrupted delete) go with "empty", never with the nightly run.
  if (!cutoff) {
    // rm removes a link itself, never what it points to.
    for (const id of await trashIds(root)) {
      await rm(join(trashRoot(root), id), { recursive: true, force: true });
    }
  }
  return n;
}

/** Git-deleted notes as entries: one per commit, several notes shown as their common folder. */
export function gitItems(deleted: DeletedNote[]): TrashItem[] {
  const byCommit = new Map<string, DeletedNote[]>();
  for (const d of deleted) byCommit.set(d.commit, [...(byCommit.get(d.commit) ?? []), d]);
  return [...byCommit.values()].map((group) => {
    const first = group[0]!;
    const files = group.map((d) => d.path).sort();
    return {
      id: `git:${first.commit}`,
      source: 'git' as const,
      path: files.length === 1 ? files[0]! : commonFolder(files),
      isDir: files.length > 1,
      files,
      date: first.date,
      author: first.author,
      subject: first.subject,
    };
  });
}

function commonFolder(files: string[]): string {
  let parts = posix.dirname(files[0]!).split('/');
  for (const f of files.slice(1)) {
    const other = posix.dirname(f).split('/');
    let i = 0;
    while (i < parts.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/') === '.' ? '' : parts.join('/');
}
