// Note actions shared by tree, search and editor: create, rename/move, delete — each with
// a small dialog. Opened through the `useActions` store so any component can trigger them.
import { WatchDialog } from './Watch';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { create } from 'zustand';
import { IconPicker } from '../editor/IconPicker';
import { focusWhenOpened } from '../editor/focusRequest';
import { AclDialog } from './Access';
import { ImportDialog } from './ImportDialog';
import { MailNotesDialog, ShareDialog, type ShareMore } from './Share';
import { DeleteManyDialog, MoveManyDialog } from './MarkedDialogs';
import type { MarkedItem } from './marked';
import { AiRuleDialog } from '../ai/AiRuleDialog';
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText, type AclTarget, type AiSource, type Entry } from '../api';
import { t, tn } from '../i18n';
import { afterMenus } from '../afterMenus';
import { toast } from '../toast';
import { HistoryDialog, TrashDialog } from './history';
import { ConflictDialog } from './conflict';
import { ActivityDialog } from './Activity';
import { RepoDeleteDialog } from './RepoTrash';
import { nodeKey, useWorkspace } from '../store';
import { folderNoteOf, noteNameIn } from '../names';
import { Button, Field, Input, Modal, Spinner, fillNodes, FormError } from '../ui';
import { FolderPicker, type FolderTarget } from './SaveAs';
import { notesBelow, trashEntryFor } from './deleted';
import { rowAfterRemoval, treeItems, treeRow } from './treeKeys';

type Action =
  | { kind: 'create'; mountId: string; parent: string; type: 'file' | 'dir' }
  | { kind: 'rename'; mountId: string; path: string; isDir: boolean }
  | { kind: 'delete'; mountId: string; path: string; isDir: boolean; title: string }
  | { kind: 'history'; mountId: string; path: string }
  | { kind: 'trash'; mountId: string }
  | { kind: 'conflict'; mountId: string }
  | { kind: 'activity'; mountId: string; isAdmin: boolean }
  | { kind: 'delete-repo'; fullName: string; connectionId: string }
  | { kind: 'icon'; mountId: string; path: string; icon: string | null }
  | { kind: 'acl'; mountId: string; target: AclTarget; path: string; title: string }
  | { kind: 'ai-rule'; mountId: string; target: AclTarget; path: string; title: string }
  | { kind: 'share'; mountId: string; target: AclTarget; path: string; title: string; more?: ShareMore[] }
  | { kind: 'mail-notes'; mountId: string; notes: { path: string; title: string }[] }
  | { kind: 'import'; mountId: string; parent: string; where: string }
  | { kind: 'move-many'; mountId: string; items: MarkedItem[] }
  | { kind: 'delete-many'; mountId: string; items: MarkedItem[] }
  | { kind: 'watch'; mountId: string; path: string; isDir: boolean; title: string }
  | { kind: 'save-answer'; markdown: string; title: string; sources: AiSource[]; mountId?: string; folder?: string; onSaved?: () => void };

export const useActions = create<{ action: Action | null; open(a: Action): void; close(): void }>((set) => ({
  action: null,
  open: (action) => afterMenus(() => set({ action })),
  close: () => set({ action: null }),
}));

export function ActionDialogs() {
  const { action, close } = useActions();
  if (!action) return null;
  if (action.kind === 'create') return <CreateDialog action={action} onClose={close} />;
  if (action.kind === 'rename') return <RenameDialog action={action} onClose={close} />;
  if (action.kind === 'history') return <HistoryDialog mountId={action.mountId} path={action.path} onClose={close} />;
  if (action.kind === 'trash') return <TrashDialog mountId={action.mountId} onClose={close} />;
  if (action.kind === 'conflict') return <ConflictDialog mountId={action.mountId} onClose={close} />;
  if (action.kind === 'delete-repo') return <RepoDeleteDialog fullName={action.fullName} connectionId={action.connectionId} onClose={close} />;
  if (action.kind === 'icon') return <IconDialog action={action} onClose={close} />;
  if (action.kind === 'acl') return <AclDialog mountId={action.mountId} target={action.target} path={action.path} title={action.title} onClose={close} />;
  if (action.kind === 'watch') return <WatchDialog mountId={action.mountId} path={action.path} isDir={action.isDir} title={action.title} onClose={close} />;
  if (action.kind === 'share') return <ShareDialog mountId={action.mountId} target={action.target} path={action.path} title={action.title} more={action.more} onClose={close} />;
  if (action.kind === 'mail-notes') return <MailNotesDialog mountId={action.mountId} notes={action.notes} onClose={close} />;
  if (action.kind === 'import') return <ImportDialog mountId={action.mountId} parent={action.parent} where={action.where} onClose={close} />;
  if (action.kind === 'move-many') return <MoveManyDialog mountId={action.mountId} items={action.items} onClose={close} />;
  if (action.kind === 'delete-many') {
    const { mountId } = action;
    return <DeleteManyDialog mountId={mountId} items={action.items} onClose={close} onTrash={() => useActions.getState().open({ kind: 'trash', mountId })} />;
  }
  if (action.kind === 'ai-rule') return <AiRuleDialog mountId={action.mountId} target={action.target} path={action.path} title={action.title} onClose={close} />;
  if (action.kind === 'activity') return <ActivityDialog mountId={action.mountId} isAdmin={action.isAdmin} onClose={close} />;
  if (action.kind === 'save-answer') return <SaveAnswerDialog action={action} onClose={close} />;
  return <DeleteDialog action={action} onClose={close} />;
}

/** Icon from the tree: changes the note's frontmatter (an open editor reloads or shows the banner). */
function IconDialog({ action, onClose }: { action: Extract<Action, { kind: 'icon' }>; onClose: () => void }) {
  const qc = useQueryClient();
  const { busy, error, run } = useRun(onClose);
  return (
    <Modal help="notizen-finden-und-lesen" open onOpenChange={(o) => !o && onClose()} title={t('Icon wählen')}>
      <IconPicker
        value={action.icon}
        onPick={(icon) =>
          void run(async () => {
            const note = await api.note(action.mountId, action.path);
            await api.saveMeta(action.mountId, action.path, { icon }, note.hash);
            await qc.invalidateQueries({ queryKey: ['tree', action.mountId] });
          })
        }
      />
      {busy && <Spinner />}
      <FormError className="mt-2">{error}</FormError>
    </Modal>
  );
}

function useRun(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t('Ziel existiert bereits') : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function CreateDialog({ action, onClose }: { action: Extract<Action, { kind: 'create' }>; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState('');
  const missingId = useId();
  const templates = useQuery({ queryKey: ['templates', action.mountId], queryFn: () => api.templates(action.mountId) });
  const qc = useQueryClient();
  const openNote = useWorkspace((s) => s.openNote);
  const revealInTree = useWorkspace((s) => s.revealInTree);
  const { busy, error, run } = useRun(onClose);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { path } = await api.createNote(action.mountId, action.parent, title.trim(), action.type, template || undefined);
      await qc.invalidateQueries({ queryKey: ['tree', action.mountId] });
      const notePath = action.type === 'dir' ? `${path}/index.md` : path;
      focusWhenOpened(action.mountId, notePath);
      openNote(action.mountId, notePath, title.trim());
      revealInTree(action.mountId, path);
    });
  };
  return (
    <Modal help="anlegen-umbenennen-verschieben-löschen" open onOpenChange={(o) => !o && onClose()} title={action.type === 'dir' ? t('Neuer Ordner') : t('Neue Notiz')} trackInput>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('Titel')} hint={action.parent ? t('in {folder}/', { folder: action.parent }) : t('auf oberster Ebene')}>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={action.type === 'dir' ? t('Ordnername') : t('Titel der Notiz')} />
        </Field>
        {!!templates.data?.length && (
          <Field label={t('Vorlage')} hint={t('Vorlagen liegen in .kaveyl-wiki/templates/ der Quelle')}>
            <select className="h-9 w-full rounded-md border border-line bg-bg px-2 text-sm" value={template} onChange={(e) => setTemplate(e.target.value)} aria-label={t('Vorlage')}>
              <option value="">{t('Leer (nur Überschrift)')}</option>
              {templates.data.map((tpl) => (
                <option key={tpl.name} value={tpl.name}>
                  {tpl.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <FormError>{error}</FormError>
        <div className="flex items-center justify-end gap-2">
          {/* Not a silent grey button: say what is missing. */}
          {!title.trim() && (
            <span id={missingId} className="mr-auto text-xs text-fg-muted">
              {t('Es fehlt noch: {list}', { list: t('Titel') })}
            </span>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('Abbrechen')}
          </Button>
          <Button variant="primary" disabled={busy || !title.trim()} aria-describedby={!title.trim() ? missingId : undefined}>
            {busy && <Spinner />} {t('Anlegen')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Link from a note in `folder` to `path` (both relative to the same source). */
function relLink(folder: string, path: string): string {
  const from = folder ? folder.split('/') : [];
  const to = path.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].map(encodeURIComponent).join('/');
}

/**
 * An AI answer as a new note: title and target folder, the answer below the heading and its
 * sources as links at the end (so „[1]“ keeps meaning something). Written by the user, not the AI.
 */
function SaveAnswerDialog({ action, onClose }: { action: Extract<Action, { kind: 'save-answer' }>; onClose: () => void }) {
  const [title, setTitle] = useState(action.title.replace(/[?!.:]+$/, '').slice(0, 100));
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const targets = (mounts.data ?? []).filter((m) => !m.paused && !m.options.readonly && (m.access === undefined || m.access === 'write' || m.access === 'admin'));
  const trees = useQueries({ queries: targets.map((m) => ({ queryKey: ['tree', m.id], queryFn: () => api.tree(m.id) })) });
  const [dest, setDest] = useState<FolderTarget | null>(null);
  const current = dest ?? (targets.find((m) => m.id === action.mountId) ? { mountId: action.mountId!, folder: action.folder ?? '' } : targets[0] ? { mountId: targets[0].id, folder: '' } : null);
  const qc = useQueryClient();
  const openNote = useWorkspace((s) => s.openNote);
  const revealInTree = useWorkspace((s) => s.revealInTree);
  const { busy, error, run } = useRun(onClose);
  const groups = targets.map((m, i) => ({ mount: m, folders: (trees[i]?.data ?? []).filter((e) => e.kind === 'dir') }));
  const mountName = (id: string) => mounts.data?.find((m) => m.id === id)?.name ?? id;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!current || !title.trim()) return;
    const cited = action.sources.filter((src) => action.markdown.includes(`[${src.n}]`));
    const list = cited.map((src) => `${src.n}. ${src.mountId === current.mountId ? `[${noteNameIn(src.mountId, src.path)}](${relLink(current.folder, src.path)})` : `${noteNameIn(src.mountId, src.path)} (${mountName(src.mountId)} / ${src.path})`}`);
    const body = list.length ? `${action.markdown.trim()}\n\n**Quellen:**\n\n${list.join('\n')}` : action.markdown.trim();
    void run(async () => {
      const { path } = await api.createNote(current.mountId, current.folder, title.trim(), 'file', undefined, body);
      await qc.invalidateQueries({ queryKey: ['tree', current.mountId] });
      action.onSaved?.();
      openNote(current.mountId, path, title.trim());
      revealInTree(current.mountId, path);
      toast({ kind: 'ok', title: t('Als Notiz gespeichert'), text: `${mountName(current.mountId)} / ${path}` });
    });
  };
  return (
    <Modal help="frag-die-wissensbasis" open onOpenChange={(o) => !o && onClose()} title={t('Antwort als Notiz speichern')} trackInput>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('Titel')}>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-fg-muted">{t('Ordner')}</span>
          {current ? (
            <FolderPicker groups={groups} value={current} onChange={setDest} loading={mounts.isLoading || trees.some((q) => q.isLoading)} />
          ) : (
            <p className="text-sm text-fg-muted">{mounts.isLoading ? t('Lädt …') : t('Keine Quelle, in die du schreiben darfst.')}</p>
          )}
          <span className="block text-xs text-fg-faint">{t('Die Antwort steht unter der Überschrift, ihre Quellen als Links am Ende. Gespeichert wird in deinem Namen.')}</span>
        </div>
        <FormError>{error}</FormError>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('Abbrechen')}
          </Button>
          <Button variant="primary" disabled={busy || !current || !title.trim()}>
            {busy && <Spinner />} {t('Speichern')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Folder and shown name of a path (notes without `.md`). */
function splitPath(path: string, isDir: boolean) {
  const i = path.lastIndexOf('/');
  const base = path.slice(i + 1);
  return { folder: i < 0 ? '' : path.slice(0, i), name: isDir ? base : base.replace(/\.md$/i, '') };
}

function RenameDialog({ action, onClose }: { action: Extract<Action, { kind: 'rename' }>; onClose: () => void }) {
  const [name, setName] = useState(() => splitPath(action.path, action.isDir).name);
  const [dest, setDest] = useState<FolderTarget>(() => ({ mountId: action.mountId, folder: splitPath(action.path, action.isDir).folder }));
  const qc = useQueryClient();
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  // Possible targets: the current mount plus every other writable, active mount.
  const targets = (mounts.data ?? []).filter((m) => m.id === action.mountId || (!m.paused && !m.options.readonly));
  const trees = useQueries({
    queries: targets.map((m) => ({ queryKey: ['tree', m.id], queryFn: () => api.tree(m.id) })),
  });
  const moved = useWorkspace((s) => s.moved);
  const revealInTree = useWorkspace((s) => s.revealInTree);
  const { busy, error, run } = useRun(onClose);
  useEffect(() => {
    const { folder, name } = splitPath(action.path, action.isDir);
    setDest({ mountId: action.mountId, folder });
    setName(name);
  }, [action.mountId, action.path, action.isDir]);
  const cleanName = name.trim();
  const badName = cleanName.includes('/') || cleanName === '.' || cleanName === '..';
  const otherMount = dest.mountId !== action.mountId;
  const target = (() => {
    if (!cleanName) return '';
    const base = action.isDir || /\.md$/i.test(cleanName) ? cleanName : `${cleanName}.md`;
    return dest.folder ? `${dest.folder}/${base}` : base;
  })();
  const unchanged = !otherMount && target === action.path;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target || badName || unchanged) return;
    void run(async () => {
      const res = await api.moveNote(action.mountId, action.path, target, otherMount ? dest.mountId : undefined);
      moved(action.mountId, action.path, res.path, res.mountId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tree', action.mountId] }),
        qc.invalidateQueries({ queryKey: ['tree', res.mountId] }),
        qc.invalidateQueries({ queryKey: ['status'] }),
      ]);
      revealInTree(res.mountId, res.path);
      if (res.warnings.length) toast({ kind: 'warn', title: t('Verschoben, mit Hinweisen'), text: res.warnings.join('\n') });
    });
  };
  const groups = targets.map((m, i) => ({
    mount: m,
    // A folder cannot move into itself or one of its own subfolders.
    folders: (trees[i]?.data ?? []).filter(
      (e) => e.kind === 'dir' && !(action.isDir && m.id === action.mountId && (e.path === action.path || e.path.startsWith(`${action.path}/`))),
    ),
  }));
  const mountName = (id: string) => mounts.data?.find((m) => m.id === id)?.name ?? '';
  return (
    <Modal help="anlegen-umbenennen-verschieben-löschen" open onOpenChange={(o) => !o && onClose()} title={action.isDir ? t('Ordner umbenennen / verschieben') : t('Notiz umbenennen / verschieben')} trackInput>
      <form onSubmit={submit} className="space-y-3">
        <Field
          label={action.isDir ? t('Ordnername') : t('Dateiname')}
          hint={action.isDir ? undefined : t('ohne .md')}
          error={badName && t('Der Name darf keinen „/“ enthalten – den Ordner bitte unter „Ziel“ wählen.')}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-fg-muted">{t('Ziel')}</span>
          <FolderPicker groups={groups} value={dest} onChange={setDest} loading={mounts.isLoading || trees.some((q) => q.isLoading)} />
          {!otherMount && <span className="block text-xs text-fg-faint">
              {action.isDir ? t('Links auf die Notizen werden automatisch angepasst.') : t('Links auf diese Notiz werden automatisch angepasst.')}
            </span>}
        </div>
        {otherMount && (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-muted">
            {fillNodes(
              action.isDir
                ? t(
                    'Die Notizen werden nach {to} kopiert und in {from} gelöscht. Die Git-Historie bleibt in {source}. Verlinkte Bilder und Dateien werden mitkopiert, die Originale bleiben. Links aus {source} auf diese Notizen lassen sich nicht über Repo-Grenzen anpassen.',
                    { source: mountName(action.mountId) },
                  )
                : t(
                    'Die Notiz wird nach {to} kopiert und in {from} gelöscht. Die Git-Historie bleibt in {source}. Verlinkte Bilder und Dateien werden mitkopiert, die Originale bleiben. Links aus {source} auf diese Notiz lassen sich nicht über Repo-Grenzen anpassen.',
                    { source: mountName(action.mountId) },
                  ),
              { to: <b>{mountName(dest.mountId)}</b>, from: <b>{mountName(action.mountId)}</b> },
            )}
          </p>
        )}
        <FormError>{error}</FormError>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('Abbrechen')}
          </Button>
          <Button variant="primary" disabled={busy || !target || badName || unchanged}>
            {busy && <Spinner />} {otherMount ? t('Verschieben') : t('Übernehmen')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ action, onClose }: { action: Extract<Action, { kind: 'delete' }>; onClose: () => void }) {
  const qc = useQueryClient();
  const removed = useWorkspace((s) => s.removed);
  const { busy, error, run } = useRun(onClose);
  /** The tree row that gets the focus once the deleted one is gone. */
  const next = useRef<HTMLElement | null>(null);
  const tree = qc.getQueryData<Entry[]>(['tree', action.mountId]);
  // The question counts the notes in it; whether anything goes to the trash depends on every file (folder pages too).
  const count = action.isDir ? notesBelow(tree, action.path, folderNoteOf(action.mountId)) : null;
  const files = action.isDir ? notesBelow(tree, action.path) : null;
  const question = !action.isDir || count === 0
    ? t('{title} wirklich löschen?')
    : count === null
      ? t('{title} und alle Notizen darin wirklich löschen?')
      : tn(count, '{title} und {n} Notiz darin wirklich löschen?', '{title} und alle {n} Notizen darin wirklich löschen?');
  return (
    <Modal help="anlegen-umbenennen-verschieben-löschen" open onOpenChange={(o) => !o && onClose()} title={action.isDir ? t('Ordner löschen') : t('Notiz löschen')} returnFocus={() => next.current}>
      <p className="text-sm">{fillNodes(question, { title: <strong>{action.title}</strong> })}</p>
      <p className="mt-2 text-xs text-fg-muted">
        {action.isDir ? `${t('Es werden nur Markdown-Notizen gelöscht; andere Dateien (Code, Bilder) im Ordner bleiben erhalten.')} ` : ''}
        {t('Gelöschtes landet im Papierkorb der Quelle und lässt sich dort wiederherstellen.')}
      </p>
      <FormError className="mt-2">{error}</FormError>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('Abbrechen')}
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const neighbour = treeNeighbour(action.mountId, action.path);
              await api.deleteNote(action.mountId, action.path);
              next.current = neighbour;
              removed(action.mountId, action.path);
              await qc.invalidateQueries({ queryKey: ['tree', action.mountId] });
              void qc.invalidateQueries({ queryKey: ['trash', action.mountId] });
              // An empty folder leaves nothing in the trash (the server just removes it).
              if (files === 0) toast({ kind: 'ok', title: t('„{name}“ gelöscht', { name: action.title }) });
              else
                toast({
                  kind: 'ok',
                  title: t('„{name}“ ist im Papierkorb', { name: action.title }),
                  action: { label: t('Wiederherstellen'), run: () => void restoreDeleted(qc, action) },
                });
            })
          }
        >
          {busy && <Spinner />} {t('Löschen')}
        </Button>
      </div>
    </Modal>
  );
}

/** The row after the deleted one in the sidebar tree (next, else previous, else the source head). */
function treeNeighbour(mountId: string, path: string): HTMLElement | null {
  const row = [...document.querySelectorAll<HTMLElement>('[role="treeitem"][data-node]')].find((r) => r.dataset.node === nodeKey(mountId, path));
  const tree = row?.closest<HTMLElement>('[role="tree"]');
  if (!row || !tree) return null;
  const rows = treeItems(tree);
  const j = rowAfterRemoval(rows.map(treeRow), rows.indexOf(row));
  return j === null ? null : rows[j]!;
}

/** „Wiederherstellen“ in the toast: the same restore as in the trash; when that cannot be done here, the trash opens. */
async function restoreDeleted(qc: QueryClient, action: Extract<Action, { kind: 'delete' }>) {
  try {
    const entry = trashEntryFor((await api.trash(action.mountId)).items, action.path, action.isDir);
    if (!entry) return useActions.getState().open({ kind: 'trash', mountId: action.mountId });
    const res = await api.restoreFromTrash(action.mountId, entry.id, entry.paths);
    await qc.invalidateQueries({ queryKey: ['tree', action.mountId] });
    toast({ kind: 'ok', title: t('Wiederhergestellt'), text: res.paths.join('\n') });
  } catch (e) {
    // Something took the place meanwhile: the trash offers another name (nothing is overwritten).
    if (e instanceof ApiError && e.status === 409) return useActions.getState().open({ kind: 'trash', mountId: action.mountId });
    toast({ kind: 'error', title: t('Wiederherstellen fehlgeschlagen'), text: errorText(e) });
  } finally {
    void qc.invalidateQueries({ queryKey: ['trash', action.mountId] });
  }
}

