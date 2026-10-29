// After deleting from the tree (design-009): the count for the question, and the trash entry
// that brings the deleted note or folder back („Wiederherstellen“ in the toast).
import type { Entry, TrashItem } from '../api';

/**
 * Notes in folder `dir` at any depth, from the loaded tree; null while it is not loaded. With `folderNote`
 * the folder pages are left out: in the tree they are the folders themselves, not notes in them (owner 27.10.).
 */
export function notesBelow(entries: Entry[] | undefined, dir: string, folderNote?: string): number | null {
  if (!entries) return null;
  const isFolderNote = (p: string) => folderNote !== undefined && p.includes('/') && p.slice(p.lastIndexOf('/') + 1).toLowerCase() === folderNote.toLowerCase();
  return entries.filter((e) => e.kind === 'file' && e.path.startsWith(`${dir}/`) && !isFolderNote(e.path)).length;
}

/**
 * The newest trash entry (the list is newest first) holding the deleted note or folder; `paths`
 * only when the entry holds more (one commit with other deletions), so nothing else comes back.
 */
export function trashEntryFor(items: TrashItem[], path: string, isDir: boolean): { id: string; paths?: string[] } | null {
  const mine = (f: string) => (isDir ? f.startsWith(`${path}/`) : f === path);
  const item = items.find((i) => i.files.some(mine));
  if (!item) return null;
  const files = item.files.filter(mine);
  return files.length === item.files.length ? { id: item.id } : { id: item.id, paths: files };
}
