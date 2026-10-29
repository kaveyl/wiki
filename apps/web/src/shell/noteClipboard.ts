// Copy / cut / paste of notes and folders in the tree (also across sources). Lives only in the
// browser tab; pasting a cut entry moves it (same API as drag & drop), a copied one is
// duplicated on the server (`POST /api/notes/:mountId/copy`, „name (Kopie)“ on clashes).
import type { QueryClient } from '@tanstack/react-query';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { create } from 'zustand';
import { api, ApiError, errorText, type Mount } from '../api';
import { t } from '../i18n';
import { noteNameIn } from '../names';
import { useWorkspace } from '../store';
import { toast } from '../toast';

export interface ClipItem {
  mode: 'copy' | 'cut';
  mountId: string;
  path: string;
  isDir: boolean;
}

export const useNoteClipboard = create<{ item: ClipItem | null; set(item: ClipItem | null): void }>((set) => ({
  item: null,
  set: (item) => set({ item }),
}));

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function clip(mode: ClipItem['mode'], mountId: string, path: string, isDir: boolean) {
  useNoteClipboard.getState().set({ mode, mountId, path, isDir });
  toast({ kind: 'ok', title: mode === 'copy' ? t('Kopiert') : t('Ausgeschnitten'), text: t('{name} – mit „Einfügen“ (Strg+V) auf einem Ordner oder einer Quelle ablegen', { name: noteNameIn(mountId, path) }) });
}

/** Whether the clipboard entry can be pasted into `parent` of `mount` (not a folder into itself). */
export function canPaste(item: ClipItem | null, mount: Mount, parent: string): item is ClipItem {
  if (!item) return false;
  if (item.mountId !== mount.id) return true;
  if (item.isDir && (parent === item.path || parent.startsWith(item.path + '/'))) return false;
  return !(item.mode === 'cut' && parentOf(item.path) === parent);
}

export async function pasteInto(qc: QueryClient, mount: Mount, parent: string) {
  const item = useNoteClipboard.getState().item;
  if (!canPaste(item, mount, parent)) return;
  const name = item.path.split('/').pop()!;
  const where = parent || mount.name;
  // Show the result in the tree – unless the user has picked something else in the meantime (slow server).
  const before = useWorkspace.getState().selected;
  const idle = () => useWorkspace.getState().selected === before;
  try {
    if (item.mode === 'copy') {
      const res = await api.copyNote(item.mountId, item.path, parent, item.mountId !== mount.id ? mount.id : undefined);
      if (res.warnings.length) toast({ kind: 'warn', title: t('Eingefügt in {where}, mit Hinweisen', { where }), text: res.warnings.join('\n') });
      else toast({ kind: 'ok', title: t('Eingefügt: {name}', { name: noteNameIn(mount.id, res.path) }), text: t('in {where}', { where }) });
      if (idle()) useWorkspace.getState().revealInTree(res.mountId, res.path);
    } else {
      const to = parent ? `${parent}/${name}` : name;
      const res = await api.moveNote(item.mountId, item.path, to, item.mountId !== mount.id ? mount.id : undefined);
      const show = idle(); // before moved(), which renames a selected moved note
      useWorkspace.getState().moved(item.mountId, item.path, res.path, res.mountId);
      useNoteClipboard.getState().set(null);
      if (res.warnings.length) toast({ kind: 'warn', title: t('Verschoben nach {where}, mit Hinweisen', { where }), text: res.warnings.join('\n') });
      else toast({ kind: 'ok', title: t('Verschoben nach {where}', { where }) });
      if (show) useWorkspace.getState().revealInTree(res.mountId, res.path);
    }
  } catch (e) {
    toast({
      kind: 'error',
      title: item.mode === 'copy' ? t('Einfügen nicht möglich') : t('Verschieben nicht möglich'),
      text: e instanceof ApiError && e.status === 409 ? t('Am Ziel gibt es schon einen Eintrag mit diesem Namen.') : errorText(e),
    });
  } finally {
    for (const id of new Set([item.mountId, mount.id])) {
      void qc.invalidateQueries({ queryKey: ['tree', id] });
      void qc.invalidateQueries({ queryKey: ['order', id] });
    }
  }
}

/** Strg+C / Strg+X / Strg+V on the selected tree entry (the sidebar has focus). */
export function treeClipboardKeys(e: KeyboardEvent | ReactKeyboardEvent, qc: QueryClient) {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (!['c', 'x', 'v'].includes(key)) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, [contenteditable="true"]')) return;
  const selected = useWorkspace.getState().selected;
  if (!selected) return;
  const at = selected.indexOf(':');
  const mountId = selected.slice(0, at);
  const mount = (qc.getQueryData<Mount[]>(['mounts']) ?? []).find((m) => m.id === mountId);
  if (!mount) return;
  let path = selected.slice(at + 1);
  // A folder opened through its folder note is selected as that note: act on the folder.
  if (path.endsWith(`/${mount.options.folderNote}`)) path = parentOf(path);
  const isDir = !!path && !/\.md$/i.test(path);
  e.preventDefault();
  if (key === 'v') return void pasteInto(qc, mount, isDir || !path ? path : parentOf(path));
  if (path) clip(key === 'c' ? 'copy' : 'cut', mountId, path, isDir);
}
