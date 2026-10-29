// Manual order of a folder's children: `order:` in the folder's `.kaveyl-wiki.yml` (PLAN.md §2.4).
// Names are file/folder names (`notiz.md`, `ordner`); unlisted entries follow alphabetically.
import { readFile, rm } from 'node:fs/promises';
import { posix } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import type { Author } from '../git/sync.js';
import { walk } from '../index/indexer.js';
import type { MountManager } from '../mounts/manager.js';
import { absPath, cleanRelPath, contentRoot, PathError, type Mount } from '../mounts/model.js';
import { atomicWrite, ForbiddenError } from './service.js';
import { isTagColor, tagKey, type TagColor } from '@kaveyl-wiki/core';
import { FOLDER_META } from './meta.js';

export { FOLDER_META };

/** Folder path ('' = root) → ordered child names. */
export async function readOrders(mount: Mount, dataPath: string): Promise<Record<string, string[]>> {
  const files: string[] = [];
  await walk(contentRoot(mount, dataPath), '', (f) => posix.basename(f) === FOLDER_META && files.push(f));
  const out: Record<string, string[]> = {};
  for (const f of files) {
    try {
      const order = parseDocument(await readFile(absPath(mount, dataPath, f), 'utf8')).toJS()?.order;
      if (Array.isArray(order)) out[posix.dirname(f) === '.' ? '' : posix.dirname(f)] = order.map(String);
    } catch {
      /* unreadable metadata: default order */
    }
  }
  return out;
}

/** Writes `order:` of one folder, keeping every other key and comment of the file. An empty
 *  order removes the key (alphabetical again) and the file, if nothing else is left in it.
 *  `hidden` (child path → true for entries the writer cannot see): those cannot be placed, and
 *  keep their place behind the entry they followed in the stored order (AD-020). */
export async function writeOrder(
  manager: MountManager,
  dataPath: string,
  mount: Mount,
  folder: string,
  order: string[],
  author: Author,
  message?: string,
  hidden?: (path: string) => boolean,
): Promise<void> {
  if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  if (order.some(badName)) throw new PathError('Ungültiger Name in der Reihenfolge');
  const dir = cleanRelPath(folder);
  await changeOrder(manager, dataPath, mount, dir, author, message, (before) =>
    hidden ? keepHidden(order, before ?? [], (n) => hidden(dir ? `${dir}/${n}` : n)) : order,
  );
}

const badName = (n: string) => typeof n !== 'string' || !n || n.includes('/') || n === '.' || n === '..';

/** Read-modify-write of `order:` under the file's lock; `change` gets the stored order (null when none)
 *  and returns the new one, or null to leave the file as it is. */
async function changeOrder(
  manager: MountManager,
  dataPath: string,
  mount: Mount,
  dir: string,
  author: Author,
  message: string | undefined,
  change: (before: string[] | null) => string[] | null,
): Promise<void> {
  const rel = dir ? `${dir}/${FOLDER_META}` : FOLDER_META;
  const abs = absPath(mount, dataPath, rel);
  // Same lock as note saves: order, encryption mark and tag colors share this file.
  await manager.locked(mount, rel, async () => {
    const current = await readFile(abs, 'utf8').catch(() => '');
    const doc = parseDocument(current);
    if (doc.errors.length) throw new PathError(`${rel} ist kein gültiges YAML`);
    const before = doc.toJS()?.order;
    const order = change(Array.isArray(before) ? before.map(String) : null);
    if (!order) return;
    if (order.length) doc.set('order', [...new Set(order)]);
    else doc.delete('order');
    const next = doc.toString();
    if (next === current) return;
    const empty = doc.contents == null || (isMap(doc.contents) && doc.contents.items.length === 0);
    if (!order.length && empty) await rm(abs, { force: true });
    else await atomicWrite(abs, next);
    await manager.touched(mount, [rel], author, message ?? `Reihenfolge in ${dir || 'Wurzel'} geändert`);
  });
}

/** `next` without hidden names, with the hidden names of `before` each right behind the entry it followed there
 *  (at the start when none); those whose predecessor is gone move to the end, in their old order. */
function keepHidden(next: string[], before: string[], hidden: (name: string) => boolean): string[] {
  const after = new Map<string | null, string[]>();
  let prev: string | null = null;
  for (const n of before) {
    if (!hidden(n)) {
      prev = n;
      continue;
    }
    if (!after.has(prev)) after.set(prev, []);
    after.get(prev)!.push(n);
  }
  const out = [...(after.get(null) ?? [])];
  after.delete(null);
  for (const n of next.filter((x) => !hidden(x))) {
    out.push(n, ...(after.get(n) ?? []));
    after.delete(n);
  }
  for (const rest of after.values()) out.push(...rest);
  return out;
}

/** Keeps a renamed child at its place in the folder's manual order (same folder only). */
export async function renameInOrder(manager: MountManager, dataPath: string, mount: Mount, from: string, to: string, author: Author): Promise<void> {
  const parent = posix.dirname(from) === '.' ? '' : posix.dirname(from);
  if ((posix.dirname(to) === '.' ? '' : posix.dirname(to)) !== parent) return;
  if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  // Read and write in one lock, so a reorder in between is not overwritten with the old order.
  await changeOrder(manager, dataPath, mount, cleanRelPath(parent), author, undefined, (order) => {
    const i = order?.indexOf(posix.basename(from)) ?? -1;
    if (!order || i < 0) return null;
    order[i] = posix.basename(to);
    if (order.some(badName)) throw new PathError('Ungültiger Name in der Reihenfolge');
    return order;
  });
}

// ── Encrypted folders (PLAN.md §3d): `encrypted: age` in the folder's `.kaveyl-wiki.yml` ─────────

/** Folders marked as encrypted (their notes are encrypted in the browser, new ones start encrypted). */
export async function readEncryptedFolders(mount: Mount, dataPath: string): Promise<string[]> {
  const files: string[] = [];
  await walk(contentRoot(mount, dataPath), '', (f) => posix.basename(f) === FOLDER_META && files.push(f));
  const out: string[] = [];
  for (const f of files) {
    try {
      if (parseDocument(await readFile(absPath(mount, dataPath, f), 'utf8')).toJS()?.encrypted === 'age') out.push(posix.dirname(f) === '.' ? '' : posix.dirname(f));
    } catch {
      /* unreadable metadata: not encrypted */
    }
  }
  return out.sort();
}

/** Marks a folder as encrypted (or not), keeping every other key of its `.kaveyl-wiki.yml`. */
export async function setFolderEncrypted(manager: MountManager, dataPath: string, mount: Mount, folder: string, encrypted: boolean, author: Author): Promise<void> {
  if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  const dir = cleanRelPath(folder);
  if (!dir) throw new PathError('Nur Ordner lassen sich verschlüsseln');
  const rel = `${dir}/${FOLDER_META}`;
  const abs = absPath(mount, dataPath, rel);
  await manager.locked(mount, rel, async () => {
    const current = await readFile(abs, 'utf8').catch(() => '');
    const doc = parseDocument(current);
    if (doc.errors.length) throw new PathError(`${rel} ist kein gültiges YAML`);
    if (encrypted) doc.set('encrypted', 'age');
    else doc.delete('encrypted');
    const next = doc.toString();
    if (next === current) return;
    const empty = doc.contents == null || (isMap(doc.contents) && doc.contents.items.length === 0);
    if (!encrypted && empty) await rm(abs, { force: true });
    else await atomicWrite(abs, next);
    await manager.touched(mount, [rel], author, encrypted ? `Ordner ${dir} verschlüsselt` : `Verschlüsselung von ${dir} aufgehoben`);
  });
}

/** Whether a note path lies in an encrypted folder — reads only the ancestors' `.kaveyl-wiki.yml` (cheap enough per save). */
export async function inEncryptedFolder(mount: Mount, dataPath: string, rel: string): Promise<boolean> {
  const parts = cleanRelPath(rel).split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join('/');
    const text = await readFile(absPath(mount, dataPath, `${dir}/${FOLDER_META}`), 'utf8').catch(() => null);
    if (text === null) continue;
    try {
      if (parseDocument(text).toJS()?.encrypted === 'age') return true;
    } catch {
      /* unreadable: ignore */
    }
  }
  return false;
}

// ── Tag colors (AD-040): `tagColors:` in the source's root `.kaveyl-wiki.yml` ───────────────────

/** Tag (lower-case) → palette color of a source; unknown colors and keys are left out. */
export async function readTagColors(mount: Mount, dataPath: string): Promise<Record<string, TagColor>> {
  try {
    const map = parseDocument(await readFile(absPath(mount, dataPath, FOLDER_META), 'utf8')).toJS()?.tagColors;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    return Object.fromEntries(Object.entries(map as Record<string, unknown>).filter(([k, v]) => k && isTagColor(v)).map(([k, v]) => [tagKey(k), v as TagColor]));
  } catch {
    return {};
  }
}

/**
 * Changes tag colors of a source (`null` removes one), keeping every other key and comment of
 * the root `.kaveyl-wiki.yml`. Returns whether anything changed (then it is committed with `message`).
 */
export async function writeTagColors(
  manager: MountManager,
  dataPath: string,
  mount: Mount,
  changes: Record<string, TagColor | null>,
  author: Author,
  message: string,
): Promise<boolean> {
  if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  const abs = absPath(mount, dataPath, FOLDER_META);
  return manager.locked(mount, FOLDER_META, async () => {
    const current = await readFile(abs, 'utf8').catch(() => '');
    const doc = parseDocument(current);
    if (doc.errors.length) throw new PathError(`${FOLDER_META} ist kein gültiges YAML`);
    for (const [tag, color] of Object.entries(changes)) {
      const key = tagKey(tag);
      if (!key) continue;
      if (color) doc.setIn(['tagColors', key], color);
      else if (doc.hasIn(['tagColors', key])) doc.deleteIn(['tagColors', key]);
    }
    const map = doc.get('tagColors');
    if (isMap(map) && map.items.length === 0) doc.delete('tagColors');
    const next = doc.toString();
    if (next === current || (!current && next.trim() === '{}')) return false;
    const empty = doc.contents == null || (isMap(doc.contents) && doc.contents.items.length === 0);
    if (empty) await rm(abs, { force: true });
    else await atomicWrite(abs, next);
    await manager.touched(mount, [FOLDER_META], author, message);
    return true;
  });
}
