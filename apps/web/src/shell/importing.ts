// „Importieren → Markdown-Dateien …“ on a folder or source (owner 28.10.): .md files from the computer become notes there,
// each under its own name – never over an existing note (the server picks „Name 2“). Imports from other products
// (whole exports with pictures) come later.
import type { QueryClient } from '@tanstack/react-query';
import { api, errorText } from '../api';
import { t, tn } from '../i18n';
import { toast } from '../toast';
import { useWorkspace } from '../store';

const MAX_BYTES = 5 * 1024 * 1024;

/** Asks for the files (several at once) and imports them into `parent` of the source. */
export function importMarkdown(qc: QueryClient, mountId: string, parent: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,text/markdown';
  input.multiple = true;
  input.onchange = () => void importFiles(qc, mountId, parent, [...(input.files ?? [])]);
  input.click();
}

export async function importFiles(qc: QueryClient, mountId: string, parent: string, files: File[]) {
  const done: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    try {
      if (!/\.(md|markdown)$/i.test(f.name)) throw new Error(t('Nur Markdown-Dateien (.md) lassen sich importieren'));
      if (f.size > MAX_BYTES) throw new Error(t('Die Datei ist zu groß (höchstens 5 MB)'));
      done.push((await api.importNote(mountId, parent, f.name, await f.text())).path);
    } catch (e) {
      failed.push(`${f.name}: ${errorText(e)}`);
    }
  }
  await qc.invalidateQueries({ queryKey: ['tree', mountId] });
  if (done.length === 1) useWorkspace.getState().revealInTree(mountId, done[0]!);
  if (done.length) toast({ kind: 'ok', title: tn(done.length, '{n} Notiz importiert', '{n} Notizen importiert'), text: done.join('\n') });
  if (failed.length) toast({ kind: 'error', title: tn(failed.length, '{n} Datei nicht importiert', '{n} Dateien nicht importiert'), text: failed.join('\n') });
}
