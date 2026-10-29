// Display name of a note or folder: the file name without `.md` (owner decision 2026-10-06 —
// tree, tabs, header and lists show file names, not the title from frontmatter/first heading).
// A folder note (`folder/index.md`) is shown under its folder's name.
export function noteName(path: string, folderNote = 'index.md'): string {
  const parts = path.split('/').filter(Boolean);
  const base = parts.at(-1) ?? path;
  if (parts.length > 1 && base.toLowerCase() === folderNote.toLowerCase()) return parts.at(-2)!;
  return base.replace(/\.md$/i, '');
}

/** Folder note and name of each source, as last loaded (`api.mounts`) – for names where only the source id is at hand. */
const folderNotes = new Map<string, string>();
const sourceNames = new Map<string, string>();
export function rememberFolderNotes(mounts: { id: string; name?: string; options: { folderNote: string } }[]): void {
  folderNotes.clear();
  sourceNames.clear();
  for (const m of mounts) {
    folderNotes.set(m.id, m.options.folderNote);
    if (m.name) sourceNames.set(m.id, m.name);
  }
}

/** „Pfad kopieren“: the full path with the source in front, as a person names it (owner 25.10.) – `Quelle/Ordner/Notiz.md`. */
export function fullPath(mountId: string, path: string): string {
  const source = sourceNames.get(mountId);
  if (!source) return path;
  return path ? `${source}/${path}` : source;
}

/** The folder note of a source (`index.md` unless it uses another, e.g. `home.md`). */
export const folderNoteOf = (mountId: string): string => folderNotes.get(mountId) ?? 'index.md';

/** `noteName` with the folder note of that source (a source may use `home.md` instead of `index.md`). */
export const noteNameIn = (mountId: string, path: string): string => noteName(path, folderNotes.get(mountId));
