// Version history of a note (list, diff, restore) and the trash of a mount — both read
// from git by the server. Restoring writes the old content as a new change; nothing in
// the git history is ever rewritten. SEE-DOC: docs/PLAN.md §2.8
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePen, FileText, Folder, RotateCcw, Save, Trash2 } from 'lucide-react';
import { api, ApiError, errorText, type TrashItem } from '../api';
import { fmtDate, fmtDateTime, lang, t, tn } from '../i18n';
import { noteNameIn } from '../names';
import { useWorkspace } from '../store';
import { toast } from '../toast';
import { Button, IconButton, Modal, Spinner, confirmDialog, cx } from '../ui';
import { nameWith, SaveAsDialog, splitPath } from './SaveAs';

const when = (iso: string) => fmtDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' });
/** Date for a file name: never with „/“ (en-GB writes 14/10/2026), so other languages get 2026-10-14. */
const day = (iso: string) => {
  if (lang === 'de') return fmtDate(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function HistoryDialog({ mountId, path, onClose }: { mountId: string; path: string; onClose: () => void }) {
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ['history', mountId, path], queryFn: () => api.history(mountId, path) });
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<'change' | 'current'>('change');
  const [busy, setBusy] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const openNote = useWorkspace((s) => s.openNote);
  const revealInTree = useWorkspace((s) => s.revealInTree);
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const versions = history.data?.versions ?? [];
  const v = versions[selected];
  const prev = versions[selected + 1] ?? null;
  const diff = useQuery({
    queryKey: ['diff', mountId, path, v?.commit, mode],
    enabled: !!v,
    queryFn: () => (mode === 'change' ? api.diff(mountId, path, prev, v!) : api.diff(mountId, path, v!, null)),
  });

  const restore = async () => {
    if (!v) return;
    setBusy(true);
    try {
      const current = await api.note(mountId, path);
      await api.restoreVersion(mountId, { path, commit: v.commit, versionPath: v.path, baseHash: current.hash });
      await qc.invalidateQueries({ queryKey: ['note', mountId, path] });
      await qc.invalidateQueries({ queryKey: ['history', mountId, path] });
      toast({ kind: 'ok', title: t('Version wiederhergestellt'), text: t('Stand vom {date} ist jetzt die aktuelle Fassung.', { date: when(v.date) }) });
      onClose();
    } catch (e) {
      toast({
        kind: 'error',
        title: t('Wiederherstellen fehlgeschlagen'),
        text: e instanceof ApiError && e.status === 409 ? t('Die Notiz wurde inzwischen geändert – bitte erneut versuchen.') : errorText(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal help="versionen-und-papierkorb" open wide onOpenChange={(o) => !o && onClose()} title={t('Versionen')}>
      {history.isPending && <Spinner />}
      {history.data && !history.data.git && <p className="text-sm text-fg-muted">{t('Dieser Ordner ist kein Git-Repository – es gibt keine Versionen.')}</p>}
      {history.data?.git && versions.length === 0 && <p className="text-sm text-fg-muted">{t('Noch keine Version committet.')}</p>}
      {v && (
        <div className="grid min-h-[50vh] grid-cols-1 gap-3 md:grid-cols-[240px_minmax(0,1fr)]">
          <ul className="max-h-[60vh] overflow-y-auto rounded-lg border border-line" role="listbox" aria-label={t('Versionen')}>
            {versions.map((x, i) => (
              <li key={x.commit} role="option" aria-selected={i === selected}>
                <button className={cx('block w-full px-3 py-2 text-left hover:bg-hover', i === selected && 'bg-active')} onClick={() => setSelected(i)}>
                  <span className="block truncate text-sm">{x.subject}</span>
                  <span className="block truncate text-xs text-fg-faint">
                    {when(x.date)} · {x.coAuthors?.length ? t('{author} mit {others}', { author: x.author, others: x.coAuthors.join(', ') }) : x.author}
                  </span>
                  {x.path !== path && <span className="block truncate text-xs text-fg-faint">{t('als {path}', { path: x.path })}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs">
                {(
                  [
                    ['change', t('Änderungen dieser Version')],
                    ['current', t('Unterschied zur aktuellen Fassung')],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={cx('rounded-md px-2 py-1', mode === k ? 'bg-bg shadow-sm' : 'text-fg-muted')} onClick={() => setMode(k)}>
                    {label}
                  </button>
                ))}
              </div>
              <Button size="sm" className="ml-auto" disabled={busy} onClick={() => setSavingAs(true)}>
                <Save className="h-3.5 w-3.5" /> {t('Speichern als …')}
              </Button>
              <Button size="sm" variant="primary" disabled={busy || selected === 0} onClick={() => void restore()}>
                {busy ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />} {t('Diese Version wiederherstellen')}
              </Button>
            </div>
            <DiffView text={diff.data?.diff} loading={diff.isPending} empty={mode === 'current' ? t('Identisch mit der aktuellen Fassung.') : t('Keine inhaltliche Änderung.')} />
          </div>
        </div>
      )}
      {savingAs && v && (
        <SaveAsDialog
          help="versionen-und-papierkorb"
          kind="note"
          intro={t('Der Stand vom {date} wird eine neue Notiz – die aktuelle Fassung bleibt, wie sie ist. Bilder und Anhänge, auf die er verweist, kommen mit.', { date: when(v.date) })}
          start={{ mountId, folder: splitPath(path, 'note').folder }}
          name={nameWith(path, 'note', t('Version {date}', { date: day(v.date) }))}
          onBack={() => setSavingAs(false)}
          onClose={onClose}
          onSave={async (target) => {
            const r = await api.saveVersionAs(mountId, { commit: v.commit, versionPath: v.path, to: target.path, toMountId: target.mountId });
            await qc.invalidateQueries({ queryKey: ['tree', r.mountId] });
            const where = mounts.data?.find((m) => m.id === r.mountId)?.name ?? '';
            toast({ kind: r.warnings.length ? 'warn' : 'ok', title: t('Als neue Notiz gespeichert'), text: [`${where} / ${r.path}`, ...r.warnings].join('\n') });
            onClose();
            openNote(r.mountId, r.path, noteNameIn(r.mountId, r.path));
            revealInTree(r.mountId, r.path);
          }}
        />
      )}
    </Modal>
  );
}

export function DiffView({ text, loading, empty }: { text?: string; loading: boolean; empty: string }) {
  if (loading) return <Spinner />;
  if (!text) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <pre className="max-h-[56vh] overflow-auto rounded-lg border border-line bg-muted p-2 font-mono text-xs leading-5" aria-label={t('Unterschiede')}>
      {text.replace(/\n$/, '').split('\n').map((line, i) => (
        <div
          key={i}
          className={cx(
            'whitespace-pre-wrap break-words px-1',
            line.startsWith('+') && 'bg-[color-mix(in_srgb,var(--color-ok,#16a34a)_15%,transparent)]',
            line.startsWith('-') && 'bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)]',
            line.startsWith('@@') && 'text-fg-faint',
            line.startsWith('\\') && 'text-fg-faint',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

export function TrashDialog({ mountId: initial, onClose }: { mountId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const openNote = useWorkspace((s) => s.openNote);
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const [mountId, setMountId] = useState(initial);
  const trash = useQuery({ queryKey: ['trash', mountId], queryFn: () => api.trash(mountId) });
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  /** „Speichern als“: the entry (and the one file, if only one). */
  const [renaming, setRenaming] = useState<{ item: TrashItem; paths?: string[]; taken: boolean } | null>(null);
  const data = trash.data;
  const folderMode = data?.mode === 'folder';

  const act = async (key: string, fn: () => Promise<void>, failTitle: string) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast({ kind: 'error', title: failTitle, text: e instanceof ApiError && e.status === 409 ? t('An dieser Stelle liegt inzwischen eine andere Datei.') : errorText(e) });
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ['trash', mountId] });
    }
  };
  const restored = async (paths: string[], into = mountId, warnings: string[] = []) => {
    await qc.invalidateQueries({ queryKey: ['tree', into] });
    if (paths.length === 1) openNote(into, paths[0]!, noteNameIn(into, paths[0]!));
    const where = into !== mountId ? `${mounts.data?.find((m) => m.id === into)?.name ?? ''} / ` : '';
    toast({ kind: warnings.length ? 'warn' : 'ok', title: t('Wiederhergestellt'), text: [...paths.map((p) => where + p), ...warnings].join('\n') });
  };
  const restore = async (item: TrashItem, paths?: string[]) => {
    setBusy(item.id + (paths?.[0] ?? ''));
    try {
      await restored((await api.restoreFromTrash(mountId, item.id, paths)).paths);
    } catch (e) {
      // Something is in the way: offer another name instead of an error (nothing is overwritten).
      if (e instanceof ApiError && e.status === 409) setRenaming({ item, paths, taken: true });
      else toast({ kind: 'error', title: t('Wiederherstellen fehlgeschlagen'), text: errorText(e) });
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ['trash', mountId] });
    }
  };
  const purge = async (item: TrashItem, label: string) => {
    if (!(await confirmDialog(t('„{name}“ endgültig löschen? Das lässt sich nicht rückgängig machen.', { name: label }), { confirmLabel: t('Löschen'), danger: true }))) return;
    await act(item.id + ':purge', async () => void (await api.purgeFromTrash(mountId, item.id)), t('Löschen fehlgeschlagen'));
  };
  const empty = () =>
    act(
      'empty',
      async () => {
        await api.emptyTrash(mountId);
        setConfirmEmpty(false);
        toast({ kind: 'ok', title: t('Papierkorb geleert') });
      },
      t('Leeren fehlgeschlagen'),
    );
  const toggle = (id: string) => setOpen((o) => new Set(o.has(id) ? [...o].filter((x) => x !== id) : [...o, id]));

  return (
    <Modal help="versionen-und-papierkorb" open wide onOpenChange={(o) => !o && onClose()} title={t('Papierkorb')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          aria-label={t('Quelle')}
          className="h-8 rounded-md border border-line bg-bg px-2 text-sm"
          value={mountId}
          onChange={(e) => {
            setMountId(e.target.value);
            setConfirmEmpty(false);
          }}
        >
          {(mounts.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <p className="min-w-0 flex-1 text-xs text-fg-muted">
          {data &&
            (folderMode
              ? t('Gelöschte Notizen liegen im Ordner .kaveyl-wiki/trash dieser Quelle.')
              : t('Gelöschte Notizen aus der Git-Historie dieser Quelle; Leeren blendet sie nur aus, in der Historie bleiben sie.'))}{' '}
          {data &&
            (data.days
              ? folderMode
                ? tn(data.days, 'Einträge älter als {n} Tag werden automatisch endgültig gelöscht.', 'Einträge älter als {n} Tage werden automatisch endgültig gelöscht.')
                : tn(data.days, 'Einträge älter als {n} Tag werden automatisch ausgeblendet.', 'Einträge älter als {n} Tage werden automatisch ausgeblendet.')
              : t('Einträge bleiben, bis der Papierkorb geleert wird.'))}
        </p>
      </div>
      {trash.isPending && <Spinner />}
      {data?.items.length === 0 && <p className="text-sm text-fg-muted">{t('Der Papierkorb ist leer.')}</p>}
      {!!data?.items.length && (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Gelöschte Einträge')}>
          {data.items.map((d) => {
            const many = d.files.length > 1;
            const expanded = open.has(d.id);
            const label = d.isDir ? tn(d.files.length, '{path} ({n} Notiz)', '{path} ({n} Notizen)', { path: d.path || t('Oberste Ebene') }) : d.path;
            return (
              <li key={d.id} className="px-3 py-2">
                {/* narrow screens: name on its own line (wrapped, not cut), buttons below */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded', many ? 'hover:bg-hover' : 'pointer-events-none')}
                    aria-label={expanded ? t('Notizen ausblenden') : t('Notizen zeigen')}
                    aria-expanded={many ? expanded : undefined}
                    onClick={() => many && toggle(d.id)}
                  >
                    {d.isDir ? <Folder className="h-4 w-4 text-fg-faint" /> : <FileText className="h-4 w-4 text-fg-faint" />}
                  </button>
                  <span className="min-w-0 grow basis-[calc(100%-2.5rem)] sm:basis-0">
                    <button className={cx('block max-w-full break-words text-left text-sm', many && 'hover:underline')} onClick={() => many && toggle(d.id)}>
                      {label}
                    </button>
                    <span className="block break-words text-xs text-fg-faint">
                      {t('gelöscht {date} · {author}', { date: when(d.date), author: d.author })}
                      {d.subject ? ` · ${d.subject}` : ''}
                    </span>
                  </span>
                  <Button size="sm" disabled={busy !== null} onClick={() => void restore(d)}>
                    {busy === d.id ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />} {many ? t('Alle wiederherstellen') : t('Wiederherstellen')}
                  </Button>
                  <IconButton label={t('Speichern als …')} disabled={busy !== null} onClick={() => setRenaming({ item: d, taken: false })}>
                    <FilePen className="h-3.5 w-3.5" />
                  </IconButton>
                  {d.source === 'folder' && (
                    <IconButton label={t('Endgültig löschen')} disabled={busy !== null} onClick={() => void purge(d, label)}>
                      {busy === d.id + ':purge' ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5 text-danger" />}
                    </IconButton>
                  )}
                </div>
                {many && expanded && (
                  <ul className="ml-8 mt-1 space-y-0.5">
                    {d.files.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-xs">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                        <span className="min-w-0 flex-1 truncate">{f}</span>
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void restore(d, [f])}>
                          {busy === d.id + f ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />} {t('Wiederherstellen')}
                        </Button>
                        <IconButton label={t('{name} speichern als …', { name: f })} disabled={busy !== null} onClick={() => setRenaming({ item: d, paths: [f], taken: false })}>
                          <FilePen className="h-3.5 w-3.5" />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data?.canEmpty && !!data.items.length && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {confirmEmpty ? (
            <>
              <span className="text-xs text-fg-muted">{folderMode ? t('Alle Einträge endgültig löschen?') : t('Alle Einträge ausblenden?')}</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmEmpty(false)}>
                {t('Abbrechen')}
              </Button>
              <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void empty()}>
                {busy === 'empty' && <Spinner className="h-3.5 w-3.5" />} {t('Ja, leeren')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmEmpty(true)}>
              <Trash2 className="h-3.5 w-3.5" /> {t('Papierkorb leeren')}
            </Button>
          )}
        </div>
      )}
      {renaming && (
        <TrashSaveAs
          mountId={mountId}
          {...renaming}
          onClose={() => setRenaming(null)}
          onDone={async (r) => {
            setRenaming(null);
            await qc.invalidateQueries({ queryKey: ['trash', mountId] });
            await restored(r.paths, r.mountId, r.warnings);
          }}
        />
      )}
    </Modal>
  );
}

/** „file (wiederhergestellt).md“ next to the old place; a folder entry: „Ordner (wiederhergestellt)“. */
export function restoreSuggestion(item: TrashItem, paths?: string[]): string {
  const one = paths?.length === 1 ? paths[0]! : !item.isDir && item.files.length === 1 ? item.files[0]! : null;
  if (one) {
    const dot = one.lastIndexOf('.');
    const slash = one.lastIndexOf('/');
    return dot > slash + 1 ? t('{name} (wiederhergestellt)', { name: one.slice(0, dot) }) + one.slice(dot) : t('{name} (wiederhergestellt)', { name: one });
  }
  return item.path ? t('{name} (wiederhergestellt)', { name: item.path }) : t('Wiederhergestellt');
}

/** „Speichern als“ for a trash entry: a note under a new name, a folder entry as a new folder — in any source. */
function TrashSaveAs({
  mountId,
  item,
  paths,
  taken,
  onClose,
  onDone,
}: {
  mountId: string;
  item: TrashItem;
  paths?: string[];
  taken: boolean;
  onClose: () => void;
  onDone: (r: { paths: string[]; mountId: string; warnings: string[] }) => void | Promise<void>;
}) {
  const kind = !paths && item.isDir ? 'folder' : 'note';
  const suggestion = splitPath(restoreSuggestion(item, paths), kind);
  const what = paths?.length === 1 ? paths[0]! : item.path || t('Oberste Ebene');
  return (
    <SaveAsDialog
      help="versionen-und-papierkorb"
      kind={kind}
      intro={
        <>
          {taken ? `${t('Am alten Platz von „{what}“ liegt inzwischen eine andere Datei.', { what })} ` : ''}
          {kind === 'folder'
            ? t('Der Ordner kommt mit allen Notizen darin unter dem neuen Namen zurück; die Unterordner bleiben erhalten.')
            : t('Die Notiz kommt unter dem neuen Namen zurück. Nichts Bestehendes wird überschrieben.')}
        </>
      }
      start={{ mountId, folder: suggestion.folder }}
      name={suggestion.name}
      submitLabel={t('Wiederherstellen')}
      onBack={onClose}
      onClose={onClose}
      onSave={async (target) => onDone(await api.restoreFromTrash(mountId, item.id, paths, target.path, target.mountId))}
    />
  );
}
