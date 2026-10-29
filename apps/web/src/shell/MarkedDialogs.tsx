// Dialogs for several marked notes and folders (owner 28.10.): move them into one folder, delete them into the trash.
// No import of actions.tsx (it shows these dialogs – no import cycle).
import { useState, type FormEvent } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../api';
import { t, tn } from '../i18n';
import { toast } from '../toast';
import { useWorkspace } from '../store';
import { Button, FormError, Modal, Spinner } from '../ui';
import { topmost, useMarked, type MarkedItem } from './marked';
import { FolderPicker, type FolderTarget } from './SaveAs';

/** One after the other; what fails is named and stays for another try, the rest goes on. */
async function each(items: MarkedItem[], fn: (i: MarkedItem) => Promise<void>): Promise<{ failed: MarkedItem[]; errors: string[] }> {
  const failed: MarkedItem[] = [];
  const errors: string[] = [];
  for (const i of items) {
    try {
      await fn(i);
    } catch (e) {
      failed.push(i);
      errors.push(`${i.title}: ${errorText(e)}`);
    }
  }
  return { failed, errors };
}

const nameOf = (path: string) => path.split('/').pop()!;

/** Several notes and folders into one folder (same source or another writable one, like „Umbenennen / verschieben“). */
export function MoveManyDialog({ mountId, items: marked, onClose }: { mountId: string; items: MarkedItem[]; onClose: () => void }) {
  const qc = useQueryClient();
  // What lies in a marked folder moves with it (audit 28.10. code-001); after a partial failure only the rest (code-007).
  const [items, setItems] = useState(() => topmost(marked));
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const targets = (mounts.data ?? []).filter((m) => m.id === mountId || (!m.paused && !m.options.readonly));
  const trees = useQueries({ queries: targets.map((m) => ({ queryKey: ['tree', m.id], queryFn: () => api.tree(m.id) })) });
  const [dest, setDest] = useState<FolderTarget>({ mountId, folder: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moved = useWorkspace((s) => s.moved);
  const inMarked = (p: string) => items.some((i) => i.isDir && (p === i.path || p.startsWith(`${i.path}/`)));
  const groups = targets.map((m, i) => ({
    mount: m,
    // Never into one of the moved folders.
    folders: (trees[i]?.data ?? []).filter((e) => e.kind === 'dir' && !(m.id === mountId && inMarked(e.path))),
  }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const other = dest.mountId !== mountId;
    const warnings: string[] = [];
    const { failed, errors } = await each(items, async (i) => {
      const to = dest.folder ? `${dest.folder}/${nameOf(i.path)}` : nameOf(i.path);
      if (!other && to === i.path) return;
      const res = await api.moveNote(mountId, i.path, to, other ? dest.mountId : undefined);
      moved(mountId, i.path, res.path, res.mountId);
      useMarked.getState().drop(mountId, i.path);
      warnings.push(...res.warnings);
    });
    await Promise.all([qc.invalidateQueries({ queryKey: ['tree', mountId] }), qc.invalidateQueries({ queryKey: ['tree', dest.mountId] }), qc.invalidateQueries({ queryKey: ['status'] })]);
    setBusy(false);
    if (warnings.length) toast({ kind: 'warn', title: t('Verschoben, mit Hinweisen'), text: warnings.join('\n') });
    if (failed.length) {
      setItems(failed);
      return setError(errors.join('\n'));
    }
    toast({ kind: 'ok', title: tn(items.length, '{n} Eintrag verschoben', '{n} Einträge verschoben') });
    onClose();
  };
  return (
    <Modal help="mehrere-markieren" open onOpenChange={(o) => !o && onClose()} title={tn(items.length, '{n} Eintrag verschieben', '{n} Einträge verschieben')}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <p className="text-xs text-fg-muted">{items.map((i) => `„${i.title}“`).join(', ')}</p>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-fg-muted">{t('Ziel')}</span>
          <FolderPicker groups={groups} value={dest} onChange={setDest} loading={mounts.isLoading || trees.some((q) => q.isLoading)} />
          <span className="block text-xs text-fg-faint">
            {dest.mountId === mountId
              ? t('Links auf die Notizen werden automatisch angepasst. Gibt es den Namen im Ziel schon, bleibt dieser Eintrag, wo er ist.')
              : t('In eine andere Quelle: Die Notizen werden dort angelegt und hier gelöscht, verlinkte Bilder werden mitkopiert. Links aus dieser Quelle lassen sich nicht über Repo-Grenzen anpassen.')}
          </span>
        </div>
        <FormError className="whitespace-pre-line">{error}</FormError>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('Abbrechen')}
          </Button>
          <Button variant="primary" disabled={busy}>
            {busy && <Spinner />} {t('Verschieben')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Several notes and folders into the trash of their source, after one question. */
export function DeleteManyDialog({ mountId, items: marked, onClose, onTrash }: { mountId: string; items: MarkedItem[]; onClose: () => void; onTrash: () => void }) {
  const qc = useQueryClient();
  const [items, setItems] = useState(() => topmost(marked));
  const removed = useWorkspace((s) => s.removed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    const { failed, errors } = await each(items, async (i) => {
      await api.deleteNote(mountId, i.path);
      removed(mountId, i.path);
      useMarked.getState().drop(mountId, i.path);
    });
    await qc.invalidateQueries({ queryKey: ['tree', mountId] });
    void qc.invalidateQueries({ queryKey: ['trash', mountId] });
    setBusy(false);
    if (failed.length) {
      setItems(failed);
      return setError(errors.join('\n'));
    }
    toast({
      kind: 'ok',
      title: tn(items.length, '{n} Eintrag ist im Papierkorb', '{n} Einträge sind im Papierkorb'),
      action: { label: t('Papierkorb öffnen'), run: onTrash },
    });
    onClose();
  };
  return (
    <Modal help="mehrere-markieren" open onOpenChange={(o) => !o && onClose()} title={tn(items.length, '{n} Eintrag löschen', '{n} Einträge löschen')}>
      <p className="text-sm">{tn(items.length, 'Diesen Eintrag wirklich löschen?', 'Diese {n} Einträge wirklich löschen?')}</p>
      <p className="mt-1 text-xs text-fg-muted">{items.map((i) => `„${i.title}“`).join(', ')}</p>
      <p className="mt-2 text-xs text-fg-muted">
        {items.some((i) => i.isDir) ? `${t('Es werden nur Markdown-Notizen gelöscht; andere Dateien (Code, Bilder) im Ordner bleiben erhalten.')} ` : ''}
        {t('Gelöschtes landet im Papierkorb der Quelle und lässt sich dort wiederherstellen.')}
      </p>
      <FormError className="mt-2 whitespace-pre-line">{error}</FormError>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('Abbrechen')}
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void run()}>
          {busy && <Spinner />} {t('Löschen')}
        </Button>
      </div>
    </Modal>
  );
}
