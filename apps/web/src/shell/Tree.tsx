// Sidebar tree: one root per mount, folders derived from notes. A folder's folder note
// (e.g. index.md) is not listed separately — clicking the folder opens it (Trilium style).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as DM from '@radix-ui/react-dropdown-menu';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileArchive,
  FileText,
  Plus,
  FolderPlus,
  Pencil,
  Trash2,
  ExternalLink,
  Eye,
  Copy,
  RefreshCw,
  GitBranch,
  FolderGit2,
  HardDrive,
  Library,
  AlertTriangle,
  Settings2,
  Star,
  Smile,
  Columns2,
  Focus,
  X,
  ShieldCheck,
  Lock,
  LockOpen,
  ArrowUp,
  ArrowDown,
  ArrowDownAZ,
  PanelLeft,
  Files,
  Scissors,
  ClipboardPaste,
  ChevronsUpDown,
  ChevronsDownUp,
  Sparkles,
  FilePlus,
  ArrowUpDown,
  FileDown,
  Send,
  Archive,
  History,
  ListChecks,
  Mail,
  Upload,
} from 'lucide-react';
import { api, ApiError, errorText, type AiRule, type Entry, type Mount } from '../api';
import { collator, t } from '../i18n';
import { toast } from '../toast';
import { AiMark, useAiRules } from '../ai/rules';
import { nodeKey, useWorkspace } from '../store';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextSub, ContextTrigger, DropdownContent, IconButton, Spinner, cx } from '../ui';
import { useActions } from './actions';
import { MarkedBar, MarkedMenuItems } from './Marked';
import { rowItem, useMarked, visibleRows, type MarkedItem } from './marked';
import { importMarkdown } from './importing';
import { IconGlyph } from '../editor/icons';
import { usePersonal } from '../personal';
import { copyWithToast } from '../clipboard';
import { fullPath, noteName, noteNameIn } from '../names';
import { canPaste, clip, pasteInto, useNoteClipboard } from './noteClipboard';
import { downloadExport } from '../editor/exporting';
import { openSettings } from './settingsNav';
import { TREE_KEYS, isMenuKey, openContextMenu, rove, treeItems, treeMove, treeRow } from './treeKeys';
import { WatchMark, unreadIn, useWatches, watchOf } from './Watch';

// ── Drag & drop: move into folders (also into other sources) and manual order ───────────

interface DragSource {
  mountId: string;
  path: string;
  parent: string;
  name: string;
  isDir: boolean;
}
type Zone = 'before' | 'after' | 'into';
let dragging: DragSource | null = null;

/** Where a drop lands, from the pointer position within the row (the React target, not the native one). */
function zoneOf(row: HTMLElement, clientY: number, isDir: boolean): Zone {
  const r = row.getBoundingClientRect();
  const y = (clientY - r.top) / r.height;
  if (isDir) return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
  return y < 0.5 ? 'before' : 'after';
}

function canDrop(src: DragSource, mount: Mount, target: { path: string; parent: string; access?: Entry['access'] } | null, zone: Zone): boolean {
  if (mount.options.readonly) return false;
  // Only read access where it would land (AD-020); the server checks exactly.
  if (target ? target.access === 'read' : mount.access === 'read' || mount.access === 'none') return false;
  const destParent = zone === 'into' ? (target?.path ?? '') : (target?.parent ?? '');
  if (src.mountId === mount.id) {
    if (target && target.path === src.path) return false;
    // Never into itself or its own subfolders.
    if (src.isDir && (destParent === src.path || destParent.startsWith(src.path + '/'))) return false;
  } else if (src.isDir) return false;
  return true;
}

async function dropOn(qc: QueryClient, mount: Mount, target: { path: string; parent: string; name: string } | null, zone: Zone, siblings: Entry[]) {
  const src = dragging;
  dragging = null;
  if (!src || !canDrop(src, mount, target, zone)) return;
  const destParent = zone === 'into' ? (target?.path ?? '') : (target?.parent ?? '');
  let name = src.name;
  try {
    if (src.mountId !== mount.id || src.parent !== destParent) {
      const to = destParent ? `${destParent}/${src.name}` : src.name;
      const res = await api.moveNote(src.mountId, src.path, to, src.mountId !== mount.id ? mount.id : undefined);
      useWorkspace.getState().moved(src.mountId, src.path, res.path, res.mountId);
      name = res.path.split('/').pop()!;
      if (res.warnings.length) toast({ kind: 'warn', title: t('Verschoben, mit Hinweisen'), text: res.warnings.join('\n') });
      else toast({ kind: 'ok', title: t('Verschoben nach {where}', { where: destParent || t('oberste Ebene') }) });
    }
    if (zone !== 'into' && target) {
      const names = siblings.map((e) => e.name).filter((n) => n !== src.name && n !== name);
      const at = names.indexOf(target.name);
      names.splice(zone === 'before' ? at : at + 1, 0, name);
      await api.saveOrder(mount.id, destParent, names);
    }
  } catch (e) {
    toast({
      kind: 'error',
      title: t('Verschieben nicht möglich'),
      text: e instanceof ApiError && e.status === 409 ? t('Am Ziel gibt es schon einen Eintrag mit diesem Namen.') : errorText(e),
    });
  } finally {
    for (const id of new Set([src.mountId, mount.id])) {
      void qc.invalidateQueries({ queryKey: ['tree', id] });
      void qc.invalidateQueries({ queryKey: ['order', id] });
    }
  }
}

/** Moves an entry one place up (-1) or down (+1) among its siblings, as shown in the tree. */
async function shiftInOrder(qc: QueryClient, mount: Mount, parent: string, siblings: Entry[], name: string, delta: -1 | 1) {
  const names = siblings.map((e) => e.name);
  const i = names.indexOf(name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= names.length) return;
  [names[i], names[j]] = [names[j]!, names[i]!];
  await saveOrder(qc, mount, parent, names);
}

async function saveOrder(qc: QueryClient, mount: Mount, folder: string, names: string[]) {
  try {
    await api.saveOrder(mount.id, folder, names);
  } catch (e) {
    toast({ kind: 'error', title: t('Reihenfolge nicht gespeichert'), text: errorText(e) });
  } finally {
    void qc.invalidateQueries({ queryKey: ['order', mount.id] });
  }
}

/** Encrypts a folder (all its notes, one passphrase) or removes that again — in the browser. The code comes with the first use. */
async function cryptFolder(qc: QueryClient, mount: Mount, folder: string, on: boolean) {
  try {
    const { encryptFolder, decryptFolder } = await import('../editor/Encryption');
    const done = await (on ? encryptFolder : decryptFolder)(mount.id, folder, () => undefined);
    if (done) toast({ kind: 'ok', title: on ? t('Ordner „{folder}“ verschlüsselt', { folder }) : t('Verschlüsselung von „{folder}“ aufgehoben', { folder }) });
  } catch (e) {
    toast({ kind: 'error', title: on ? t('Verschlüsseln abgebrochen') : t('Entschlüsseln abgebrochen'), text: errorText(e) });
  } finally {
    void qc.invalidateQueries({ queryKey: ['encrypted', mount.id] });
    void qc.invalidateQueries({ queryKey: ['tree', mount.id] });
    void qc.invalidateQueries({ queryKey: ['note', mount.id] });
    void qc.invalidateQueries({ queryKey: ['plain-left', mount.id] });
  }
}

/** Plain notes still lying in an encrypted folder (interrupted run, copied in from outside). */
async function plainLeftIn(mountId: string, folder: string): Promise<number> {
  return (await api.encryptedNotes(mountId, folder)).filter((n) => !n.encrypted).length;
}

/** Only when an encrypted folder still holds plain notes (interrupted run, copied in from outside). */
function FinishEncryption({ qc, mount, folder }: { qc: QueryClient; mount: Mount; folder: string }) {
  const left = useQuery({ queryKey: ['plain-left', mount.id, folder], queryFn: () => plainLeftIn(mount.id, folder), staleTime: 5_000 });
  if (!left.data) return null;
  return (
    <ContextItem icon={<Lock />} onSelect={() => void cryptFolder(qc, mount, folder, true)}>
      {t('Ordner fertig verschlüsseln ({n} offen) …', { n: left.data })}
    </ContextItem>
  );
}

// ── Order of the sources themselves (admin only: the same for everyone) ────────────────
let draggingMount: string | null = null;

async function reorderMounts(qc: QueryClient, ids: string[]) {
  try {
    qc.setQueryData(['mounts'], await api.reorderMounts(ids));
  } catch (e) {
    toast({ kind: 'error', title: t('Reihenfolge nicht gespeichert'), text: errorText(e) });
  }
}

/** `ids` without `id`, then `id` inserted before/after `target` (or shifted by one place). */
function moveId(ids: string[], id: string, target: string | -1 | 1, zone: 'before' | 'after' = 'before'): string[] {
  const i = ids.indexOf(id);
  if (typeof target === 'number') {
    const j = i + target;
    if (i < 0 || j < 0 || j >= ids.length) return ids;
    const next = [...ids];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  }
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(target);
  rest.splice(zone === 'before' ? at : at + 1, 0, id);
  return rest;
}

const useIsAdmin = () => !!useQuery({ queryKey: ['session'], queryFn: api.session }).data?.user?.isAdmin;

/** Opens every folder of a source (below `under`), including the source itself. */
export function expandAllIn(mountId: string, entries: Entry[], under = '') {
  const inside = (p: string) => !under || p === under || p.startsWith(under + '/');
  useWorkspace.getState().expandMany([nodeKey(mountId, ''), ...entries.filter((e) => e.kind === 'dir' && inside(e.path)).map((e) => nodeKey(mountId, e.path))]);
}

/** Closes every folder of a source below `under` (the source / `under` itself stays open). */
export function collapseAllIn(mountId: string, under = '') {
  const prefix = nodeKey(mountId, under ? `${under}/` : '');
  const self = nodeKey(mountId, under);
  useWorkspace.getState().collapseWhere((k) => k.startsWith(prefix) && k !== self && k !== nodeKey(mountId, ''));
}

/**
 * Actions of a source or folder row, shown on hover: open/close everything below and a "+"
 * menu for a new note or folder. Every source and every folder shows the same toolbar, only
 * "+" depends on write access. Touch screens have no hover: there they show on the row in
 * focus (`touch`).
 */
function RowActions({
  allOpen,
  toggleLabels,
  onToggleAll,
  onNew,
  touch,
}: {
  allOpen: boolean;
  /** [open everything, close everything]. */
  toggleLabels: [string, string];
  onToggleAll: () => void;
  onNew: ((type: 'file' | 'dir') => void) | null;
  touch: boolean;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <span className={cx('items-center group-hover:flex', menu ? 'flex' : 'hidden', touch && '[@media(hover:none)]:flex')} onClick={(e) => e.stopPropagation()}>
      <IconButton label={allOpen ? toggleLabels[1] : toggleLabels[0]} onClick={onToggleAll}>
        {allOpen ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
      </IconButton>
      {onNew && (
        <DM.Root open={menu} onOpenChange={setMenu}>
          <DM.Trigger asChild>
            <IconButton label={t('Neu …')}>
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
          </DM.Trigger>
          <DM.Portal>
            <DropdownContent align="start" minWidth={170} className="z-50">
              {(
                [
                  ['file', t('Neue Notiz'), <FilePlus key="f" />],
                  ['dir', t('Neuer Ordner'), <FolderPlus key="d" />],
                ] as const
              ).map(([type, label, icon]) => (
                <DM.Item
                  key={type}
                  onSelect={() => onNew(type)}
                  className="flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-fg outline-none data-[highlighted]:bg-hover"
                >
                  <span className="flex h-4 w-4 items-center justify-center text-fg-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
                  {label}
                </DM.Item>
              ))}
            </DropdownContent>
          </DM.Portal>
        </DM.Root>
      )}
    </span>
  );
}

/** Keyboard focus inside the row, so the scroll container cannot clip it. */
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/**
 * All sources as one tree for the keyboard (WAI-ARIA „Tree View“): Tab reaches it as one stop,
 * arrows move and open/close, Enter acts like a click, Shift+F10 opens the row's context menu.
 */
export function SourcesTree({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const tree = ref.current!;
    // Rows come and go (open/close, sync), the selection moves: keep one row tabbable.
    const sync = () => rove(tree, last.current);
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
    return () => mo.disconnect();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    // Only keys from the tree itself: Esc in an open menu (its portal bubbles here in React) closes just the menu.
    if (e.key === 'Escape' && e.currentTarget.contains(el) && useMarked.getState().items.length) {
      e.preventDefault();
      return useMarked.getState().clear();
    }
    // Only on the row itself – its buttons keep their keys; Ctrl+C/X/V go on to the sidebar.
    if (el.getAttribute('role') !== 'treeitem' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isMenuKey(e)) {
      e.preventDefault();
      return openContextMenu(el);
    }
    if (e.shiftKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      return el.click();
    }
    if (!TREE_KEYS.includes(e.key)) return;
    e.preventDefault();
    const rows = treeItems(e.currentTarget);
    const move = treeMove(rows.map(treeRow), rows.indexOf(el), e.key);
    if (!move) return;
    if ('focus' in move) rows[move.focus]!.focus();
    else useWorkspace.getState().toggle(el.dataset.node ?? nodeKey(el.dataset.mount!, ''), move.expand);
  };
  return (
    <div
      ref={ref}
      role="tree"
      aria-label={t('Quellen')}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target.getAttribute('role') !== 'treeitem') return;
        last.current = e.target;
        rove(e.currentTarget, e.target);
      }}
    >
      <MarkedBar />
      {children}
    </div>
  );
}

export function MountTree({ mount, onEditMount, mountIds, canReorder }: { mount: Mount; onEditMount: (m: Mount) => void; mountIds: string[]; canReorder: boolean }) {
  const tree = useQuery({ queryKey: ['tree', mount.id], queryFn: () => api.tree(mount.id), enabled: !mount.paused });
  // Marks follow the tree: renamed, deleted, synced away or no longer allowed (audit 28.10. code-002).
  useEffect(() => {
    if (tree.data) useMarked.getState().sync(mount.id, tree.data);
  }, [mount.id, tree.data]);
  const expanded = useWorkspace((s) => !!s.expanded[nodeKey(mount.id, '')]);
  const toggle = useWorkspace((s) => s.toggle);
  const openAction = useActions((s) => s.open);
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ['order', mount.id], queryFn: () => api.order(mount.id), enabled: !mount.paused });
  const encrypted = useQuery({ queryKey: ['encrypted', mount.id], queryFn: () => api.encryptedFolders(mount.id), enabled: !mount.paused, staleTime: 30_000 });
  const isAdmin = useIsAdmin();
  const aiRules = useAiRules(isAdmin);
  const [rootDrop, setRootDrop] = useState(false);
  const [mountDrop, setMountDrop] = useState<'before' | 'after' | null>(null);
  const mountIndex = mountIds.indexOf(mount.id);
  const rootWritable = !mount.options.readonly && (mount.access === undefined || mount.access === 'write' || mount.access === 'admin');

  const children = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of tree.data ?? []) {
      if (e.kind === 'file' && e.parent && e.name === mount.options.folderNote) continue;
      const list = map.get(e.parent) ?? [];
      list.push(e);
      map.set(e.parent, list);
    }
    // Manual order from `.kaveyl-wiki.yml` first; the rest folders first, then by the name the
    // user sees (file name, AD-022), locale-aware.
    const label = (e: Entry) => (e.kind === 'dir' ? e.name : noteName(e.path, mount.options.folderNote));
    for (const [parent, list] of map) {
      const order = orders.data?.[parent] ?? [];
      const rank = (e: Entry) => {
        const i = order.indexOf(e.name);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      list.sort((a, b) => rank(a) - rank(b) || (a.kind === b.kind ? collator.compare(label(a), label(b)) : a.kind === 'dir' ? -1 : 1));
    }
    const notes = (tree.data ?? []).filter((e) => e.kind === 'file' && e.name === mount.options.folderNote);
    const folderNotes = new Set(notes.map((e) => e.parent));
    const folderIcons = new Map(notes.filter((e) => e.icon).map((e) => [e.parent, e.icon!]));
    const ordered = new Set(Object.entries(orders.data ?? {}).filter(([, o]) => o.length > 0).map(([f]) => f));
    // Own AI rules here (✦), by `target:path`; orphaned note rules point nowhere.
    const ai = new Map((aiRules.data ?? []).filter((r) => r.mountId === mount.id && !r.orphan).map((r) => [`${r.target}:${r.path}`, r]));
    return { map, folderNotes, folderIcons, ordered, encrypted: new Set(encrypted.data ?? []), all: tree.data ?? [], ai };
  }, [tree.data, orders.data, encrypted.data, aiRules.data, mount.id, mount.options.folderNote]);

  // Hoisting: a folder of this source is the root of the tree for now.
  const hoist = useWorkspace((s) => (s.hoist?.mountId === mount.id ? s.hoist.path : null));
  const root = hoist ?? '';

  const sync = async () => {
    await api.syncMount(mount.id).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['mounts'] });
  };

  const status = mount.syncStatus;
  const clipItem = useNoteClipboard((c) => c.item);
  // Is any folder of this source open (below the root / the hoisted folder)?
  const watchData = useWatches().data;
  const anyOpen = useWorkspace((s) => {
    const prefix = nodeKey(mount.id, root ? `${root}/` : '');
    return Object.keys(s.expanded).some((k) => k.startsWith(prefix) && k !== nodeKey(mount.id, root) && k !== nodeKey(mount.id, ''));
  });
  return (
    <div className="mb-1">
      <ContextMenu>
        <ContextTrigger asChild>
          <div
            className={cx('group flex min-h-7 cursor-default items-center gap-1 rounded-md px-1 text-tree font-semibold text-fg-muted hover:bg-hover', FOCUS_RING, rootDrop && 'bg-accent-soft')}
            role="treeitem"
            aria-level={1}
            aria-expanded={expanded}
            tabIndex={-1}
            data-mount={mount.id}
            data-drop={mountDrop ?? undefined}
            onClick={() => toggle(nodeKey(mount.id, ''))}
            draggable={canReorder}
            onDragStart={(e) => {
              draggingMount = mount.id;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', mount.name);
            }}
            onDragEnd={() => (draggingMount = null)}
            onDragOver={(e) => {
              if (draggingMount) {
                if (draggingMount === mount.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                return setMountDrop(zoneOf(e.currentTarget, e.clientY, false) as 'before' | 'after');
              }
              if (!dragging || !canDrop(dragging, mount, null, 'into')) return;
              e.preventDefault();
              setRootDrop(true);
            }}
            onDragLeave={() => {
              setRootDrop(false);
              setMountDrop(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setRootDrop(false);
              setMountDrop(null);
              if (draggingMount) {
                const src = draggingMount;
                draggingMount = null;
                if (src !== mount.id) void reorderMounts(qc, moveId(mountIds, src, mount.id, zoneOf(e.currentTarget, e.clientY, false) as 'before' | 'after'));
                return;
              }
              void dropOn(qc, mount, null, 'into', children.map.get('') ?? []);
            }}
          >
            <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
            <MountIcon mount={mount} />
            <span data-mount-name className="min-w-0 truncate" title={mountKind(mount)}>
              {mount.name}
            </span>
            <MountKind mount={mount} />
            <WatchMark unread={unreadIn(watchData, mount.id, '', true)} watched={!!watchOf(watchData, mount.id, '')} />
            <span className="flex-1" />
            <RowActions
              allOpen={anyOpen}
              toggleLabels={[t('Alle Ordner aufklappen'), t('Alle Ordner zuklappen')]}
              onToggleAll={() => (anyOpen ? collapseAllIn(mount.id, root) : expandAllIn(mount.id, tree.data ?? [], root))}
              onNew={rootWritable ? (type) => openAction({ kind: 'create', mountId: mount.id, parent: '', type }) : null}
              touch
            />
            {status === 'syncing' && <Spinner className="h-3 w-3" />}
            {(status === 'conflict' || status === 'error') && (
              <span title={mount.syncDetail ?? status}>
                <AlertTriangle className={cx('h-3.5 w-3.5', status === 'error' ? 'text-danger' : 'text-warn')} />
              </span>
            )}
            {children.ai.has('mount:') && (
              <AiMark
                rule={children.ai.get('mount:')!}
                scope={{ kind: 'source', mountId: mount.id }}
                onEdit={isAdmin ? () => openAction({ kind: 'ai-rule', mountId: mount.id, target: 'mount', path: '', title: mount.name }) : undefined}
              />
            )}
          </div>
        </ContextTrigger>
        <ContextContent>
          {rootWritable && (
            <>
              <ContextItem icon={<Plus />} onSelect={() => openAction({ kind: 'create', mountId: mount.id, parent: '', type: 'file' })}>
                {t('Neue Notiz')}
              </ContextItem>
              <ContextItem icon={<FolderPlus />} onSelect={() => openAction({ kind: 'create', mountId: mount.id, parent: '', type: 'dir' })}>
                {t('Neuer Ordner')}
              </ContextItem>
              {canPaste(clipItem, mount, root) && (
                <ContextItem icon={<ClipboardPaste />} onSelect={() => void pasteInto(qc, mount, root)} shortcut={t('Strg+V')}>
                  {t('Einfügen „{name}“', { name: noteNameIn(clipItem.mountId, clipItem.path) })}
                </ContextItem>
              )}
              <ContextSub icon={<Upload />} label={t('Importieren')}>
                <ContextItem icon={<FileText />} onSelect={() => importMarkdown(qc, mount.id, root)}>
                  {t('Markdown-Dateien …')}
                </ContextItem>
                <ContextItem icon={<FileArchive />} onSelect={() => openAction({ kind: 'import', mountId: mount.id, parent: root, where: mount.name })}>
                  {t('Aus anderem Programm …')}
                </ContextItem>
              </ContextSub>
              <ContextSeparator />
            </>
          )}
          <ContextItem icon={<Eye />} onSelect={() => openAction({ kind: 'watch', mountId: mount.id, path: '', isDir: true, title: mount.name })}>
            {watchOf(watchData, mount.id, '') ? t('Beobachten ändern …') : t('Quelle beobachten …')}
          </ContextItem>
          {mount.access === 'admin' && (
            <ContextItem icon={<ShieldCheck />} onSelect={() => openAction({ kind: 'acl', mountId: mount.id, target: 'mount', path: '', title: mount.name })}>
              {t('Berechtigungen …')}
            </ContextItem>
          )}
          {mount.access === 'admin' && (
            <ContextSub icon={<Send />} label={t('Teilen')}>
              <ContextItem icon={<Send />} onSelect={() => openAction({ kind: 'share', mountId: mount.id, target: 'mount', path: '', title: mount.name })}>
                {t('Zugriff per E-Mail geben …')}
              </ContextItem>
            </ContextSub>
          )}
          {isAdmin && (
            <ContextItem icon={<Sparkles />} onSelect={() => openAction({ kind: 'ai-rule', mountId: mount.id, target: 'mount', path: '', title: mount.name })}>
              {t('KI-Freigabe …')}
            </ContextItem>
          )}
          {(canReorder || (rootWritable && children.ordered.has(''))) && (
            // Drag and drop does the same; this is for touch screens and the keyboard.
            <ContextSub icon={<ArrowUpDown />} label={t('Anordnen')}>
              {canReorder && mountIndex > 0 && (
                <ContextItem icon={<ArrowUp />} onSelect={() => void reorderMounts(qc, moveId(mountIds, mount.id, -1))}>
                  {t('Quelle nach oben')}
                </ContextItem>
              )}
              {canReorder && mountIndex >= 0 && mountIndex < mountIds.length - 1 && (
                <ContextItem icon={<ArrowDown />} onSelect={() => void reorderMounts(qc, moveId(mountIds, mount.id, 1))}>
                  {t('Quelle nach unten')}
                </ContextItem>
              )}
              {rootWritable && children.ordered.has('') && (
                <ContextItem icon={<ArrowDownAZ />} onSelect={() => void saveOrder(qc, mount, '', [])}>
                  {t('Oberste Ebene alphabetisch sortieren')}
                </ContextItem>
              )}
            </ContextSub>
          )}
          {(mount.access === 'admin' || isAdmin || canReorder || (rootWritable && children.ordered.has(''))) && <ContextSeparator />}
          {mount.type === 'remote' && (mount.access === undefined || mount.access === 'write' || mount.access === 'admin') && (
            <ContextItem icon={<RefreshCw />} onSelect={() => void sync()}>
              {t('Jetzt synchronisieren')}
            </ContextItem>
          )}
          <ContextSub icon={<FileDown />} label={t('Exportieren')}>
            <ContextItem onSelect={() => downloadExport(mount.id, root)}>{t('HTML (ZIP)')}</ContextItem>
            <ContextItem onSelect={() => downloadExport(mount.id, root, 'md')}>{t('Markdown (ZIP)')}</ContextItem>
          </ContextSub>
          <ContextItem icon={<Trash2 />} onSelect={() => openAction({ kind: 'trash', mountId: mount.id })}>
            {t('Papierkorb')}
          </ContextItem>
          {isAdmin && (
            <ContextSub icon={<Archive />} label={t('Backup')}>
              <ContextItem onSelect={() => void backupNow(mount)}>{t('Jetzt sichern')}</ContextItem>
              <ContextItem onSelect={() => openSettings('backup-files', { mountId: mount.id })}>{t('Sicherungen und Wiederherstellen …')}</ContextItem>
              <ContextItem onSelect={() => openSettings('backup-plans', { mountId: mount.id })}>{t('Zeitpläne …')}</ContextItem>
            </ContextSub>
          )}
          {isAdmin && (
            <ContextItem icon={<Settings2 />} onSelect={() => onEditMount(mount)}>
              {t('Quelle bearbeiten …')}
            </ContextItem>
          )}
          {isAdmin && mount.hostedRepo && (
            <>
              <ContextSeparator />
              <ContextItem icon={<Trash2 />} danger onSelect={() => openAction({ kind: 'delete-repo', fullName: mount.hostedRepo!.fullName, connectionId: mount.hostedRepo!.connectionId })}>
                {t('Repository löschen …')}
              </ContextItem>
            </>
          )}
        </ContextContent>
      </ContextMenu>
      {expanded && (
        <div>
          {tree.isPending && <div className="px-7 py-1 text-xs text-fg-faint">{t('Lädt …')}</div>}
          {tree.data && tree.data.length === 0 && <div className="px-7 py-1 text-xs text-fg-faint">{t('Keine Notizen')}</div>}
          {hoist !== null && (
            <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-xs text-fg">
              <Focus className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate" title={hoist}>
                {t('Fokus: {path}', { path: hoist })}
              </span>
              <button className="rounded px-1 hover:bg-active" onClick={() => useWorkspace.getState().setHoist(null)} aria-label={t('Fokus aufheben')}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {(children.map.get(root) ?? []).map((e) => (
            <Node key={e.path} mount={mount} entry={e} depth={1} index={children} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ChildIndex {
  map: Map<string, Entry[]>;
  folderNotes: Set<string>;
  folderIcons: Map<string, string>;
  /** Folders with a manual order (`order:` in their `.kaveyl-wiki.yml`). */
  ordered: Set<string>;
  /** Encrypted folders (PLAN §3d) and all entries (to encrypt a whole folder). */
  encrypted: Set<string>;
  all: Entry[];
  /** Own AI rules (admins), by `target:path`. */
  ai: Map<string, AiRule>;
}

function Node({ mount, entry, depth, index }: { mount: Mount; entry: Entry; depth: number; index: ChildIndex }) {
  const key = nodeKey(mount.id, entry.path);
  const isDir = entry.kind === 'dir';
  const expanded = useWorkspace((s) => !!s.expanded[key]);
  const selected = useWorkspace((s) => s.selected === key);
  const watchData = useWatches().data;
  const reveal = useWorkspace((s) => (s.reveal?.key === key ? s.reveal.nonce : 0));
  const { toggle, openNote, select } = useWorkspace.getState();
  const openAction = useActions((s) => s.open);
  const marked = useMarked((s) => s.mountId === mount.id && s.items.some((i) => i.path === entry.path));
  const many = useMarked((s) => s.mountId === mount.id && s.items.length > 1);
  const picking = useMarked((s) => s.picking && s.mountId === mount.id);
  const session = useQuery({ queryKey: ['session'], queryFn: api.session }).data;
  const folderNote = isDir && index.folderNotes.has(entry.path) ? `${entry.path}/${mount.options.folderNote}` : null;
  const notePath = isDir ? folderNote : entry.path;
  // With another folder note (e.g. home.md) an index.md is a normal note named „index“ (checklist 20.10.).
  const title = isDir ? entry.name : noteName(entry.path, mount.options.folderNote);
  // A folder shows the icon of its folder note.
  const icon = isDir ? (index.folderIcons.get(entry.path) ?? entry.icon) : entry.icon;

  useEffect(() => {
    if (reveal) document.querySelector(`[data-node="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [reveal, key]);

  const open = (newTab: boolean) => {
    if (notePath) openNote(mount.id, notePath, title, { newTab });
    else select(key);
  };
  const item = (): MarkedItem => ({ path: entry.path, isDir, title, access: entry.access, encrypted: inEncrypted });
  const onClick = (e: MouseEvent) => {
    // Marking as in a file explorer (owner 28.10.): Ctrl/Cmd+click one, Shift+click a range, a tap while „Auswählen“ is on.
    const m = useMarked.getState();
    // The open note joins when marking starts (Explorer) – an open folder does not, it would take its content along.
    const openRow = () => {
      const open = useWorkspace.getState().selected;
      const row = open?.startsWith(`${mount.id}:`) ? document.querySelector<HTMLElement>(`[role="treeitem"][data-node="${CSS.escape(open)}"]`) : null;
      const it = row ? rowItem(row) : null;
      return it && !it.isDir ? it : null;
    };
    if (e.shiftKey) return m.range(mount.id, visibleRows(mount.id), entry.path, openRow()?.path);
    if (e.ctrlKey || e.metaKey || (m.picking && m.mountId === mount.id)) return m.toggle(mount.id, item(), openRow());
    if (m.items.length) m.clear();
    if (isDir) toggle(key, folderNote ? true : undefined);
    open(false);
  };
  const onAuxClick = (e: MouseEvent) => {
    if (e.button === 1 && notePath) {
      e.preventDefault();
      openNote(mount.id, notePath, title, { newTab: true, background: true });
    }
  };
  const parentForNew = isDir ? entry.path : entry.parent;
  // Read-only source or only read access here (AD-020).
  const ro = mount.options.readonly || entry.access === 'read';
  const inEncrypted = [...index.encrypted].some((f) => entry.path === f || entry.path.startsWith(f + '/'));
  const qc = useQueryClient();
  const [drop, setDrop] = useState<Zone | null>(null);
  const siblings = index.map.get(entry.parent) ?? [];
  const siblingIndex = siblings.findIndex((e) => e.path === entry.path);
  const clipItem = useNoteClipboard((c) => c.item);
  const isAdmin = useIsAdmin();
  const cut = clipItem?.mode === 'cut' && clipItem.mountId === mount.id && clipItem.path === entry.path;
  // A rule on the folder itself or on its folder note (hidden in the tree).
  const aiRule = isDir
    ? (index.ai.get(`folder:${entry.path}`) ?? index.ai.get(`note:${entry.path}/${mount.options.folderNote}`))
    : index.ai.get(`note:${entry.path}`);
  const hasSubdirs = isDir && (index.map.get(entry.path) ?? []).some((e) => e.kind === 'dir');
  const anyOpenBelow = useWorkspace((s) => {
    if (!hasSubdirs) return false;
    const prefix = nodeKey(mount.id, `${entry.path}/`);
    return Object.keys(s.expanded).some((k) => k.startsWith(prefix));
  });
  // Without subfolders (e.g. only images below) the toggle simply opens/closes the folder.
  const allOpen = expanded && (!hasSubdirs || anyOpenBelow);
  /** Opens the folder with everything below, or closes it all (also Alt+click on the arrow). */
  const toggleAll = (close: boolean) => {
    if (close) {
      collapseAllIn(mount.id, entry.path);
      toggle(key, false);
    } else expandAllIn(mount.id, index.all, entry.path);
  };

  return (
    <>
      <ContextMenu>
        <ContextTrigger asChild>
          <div
            data-node={key}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={isDir ? expanded : undefined}
            aria-selected={selected}
            data-mount-of={mount.id}
            data-path={entry.path}
            data-dir={isDir ? '1' : '0'}
            data-title={title}
            data-access={entry.access}
            data-enc={inEncrypted ? '1' : undefined}
            data-marked={marked ? '1' : undefined}
            tabIndex={-1}
            className={cx(
              'group flex min-h-7 cursor-default select-none items-center gap-1 rounded-md pr-1 text-tree',
              FOCUS_RING,
              marked ? 'bg-accent-soft text-fg ring-1 ring-inset ring-accent/40' : selected ? 'bg-active text-fg' : 'text-fg hover:bg-hover',
              cut && 'opacity-50',
            )}
            style={{ paddingLeft: depth * 14 }}
            draggable={!ro}
            onDragStart={(e) => {
              dragging = { mountId: mount.id, path: entry.path, parent: entry.parent, name: entry.name, isDir };
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', entry.path);
            }}
            onDragEnd={() => (dragging = null)}
            onDragOver={(e) => {
              if (!dragging) return;
              const zone = zoneOf(e.currentTarget, e.clientY, isDir);
              if (!canDrop(dragging, mount, entry, zone)) return setDrop(null);
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDrop(zone);
            }}
            onDragLeave={() => setDrop(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDrop(null);
              // From the drop position itself: the state of the last dragover may not be rendered yet.
              const zone = zoneOf(e.currentTarget, e.clientY, isDir);
              if (dragging && canDrop(dragging, mount, entry, zone)) void dropOn(qc, mount, entry, zone, index.map.get(entry.parent) ?? []);
            }}
            data-drop={drop ?? undefined}
            onClick={onClick}
            onAuxClick={onAuxClick}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          >
            {isDir ? (
              <span
                className="flex h-4 w-4 items-center justify-center rounded hover:bg-active"
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.altKey) toggleAll(expanded);
                  else toggle(key);
                }}
              >
                <ChevronRight className={cx('h-3.5 w-3.5 text-fg-faint transition-transform', expanded && 'rotate-90')} />
              </span>
            ) : (
              <span className="w-4" />
            )}
            {picking && <input type="checkbox" readOnly checked={marked} tabIndex={-1} aria-hidden="true" className="pointer-events-none mr-0.5" />}
            <EntryIcon icon={icon} isDir={isDir} open={expanded} />
            <span className="flex-1 truncate">{title}</span>
            <WatchMark unread={unreadIn(watchData, mount.id, entry.path, isDir)} watched={!!watchOf(watchData, mount.id, entry.path)} />
            {isDir && (
              <RowActions
                allOpen={allOpen}
                toggleLabels={[t('Alles darunter aufklappen'), t('Alles darunter zuklappen')]}
                onToggleAll={() => toggleAll(allOpen)}
                onNew={ro ? null : (type) => openAction({ kind: 'create', mountId: mount.id, parent: entry.path, type })}
                touch={selected}
              />
            )}
            {isDir && index.encrypted.has(entry.path) && <Lock className="mx-0.5 h-3 w-3 shrink-0 text-fg-faint" aria-label={t('verschlüsselt')} />}
            {aiRule && (
              <AiMark
                rule={aiRule}
                scope={isDir ? { kind: 'folder', mountId: mount.id, path: entry.path } : { kind: 'note', mountId: mount.id, path: entry.path }}
                onEdit={isAdmin ? () => openAction({ kind: 'ai-rule', mountId: mount.id, target: isDir ? 'folder' : 'note', path: entry.path, title }) : undefined}
              />
            )}
          </div>
        </ContextTrigger>
        <ContextContent>
          {marked && many ? (
            <MarkedMenuItems mount={mount} />
          ) : (
          <>
          {notePath && (
            <ContextItem icon={<ExternalLink />} onSelect={() => openNote(mount.id, notePath, title, { newTab: true })} shortcut={t('Mittelklick')}>
              {t('In neuem Tab öffnen')}
            </ContextItem>
          )}
          {notePath && (
            <ContextItem icon={<Columns2 />} onSelect={() => useWorkspace.getState().openSplit(mount.id, notePath, title)}>
              {t('Rechts daneben öffnen')}
            </ContextItem>
          )}
          {notePath && (
            <ContextItem icon={<PanelLeft />} onSelect={() => useWorkspace.getState().openSplit(mount.id, notePath, title, 'left')}>
              {t('Links daneben öffnen')}
            </ContextItem>
          )}
          {isDir && (
            <ContextItem icon={<Focus />} onSelect={() => useWorkspace.getState().setHoist({ mountId: mount.id, path: entry.path })}>
              {t('Nur diesen Ordner zeigen (Fokus)')}
            </ContextItem>
          )}
          {!ro && (
            <>
              <ContextItem icon={<Plus />} onSelect={() => openAction({ kind: 'create', mountId: mount.id, parent: parentForNew, type: 'file' })}>
                {isDir ? t('Neue Notiz hier') : t('Neue Notiz daneben')}
              </ContextItem>
              <ContextItem icon={<FolderPlus />} onSelect={() => openAction({ kind: 'create', mountId: mount.id, parent: parentForNew, type: 'dir' })}>
                {isDir ? t('Neuer Ordner hier') : t('Neuer Ordner daneben')}
              </ContextItem>
              <ContextSeparator />
              <ContextItem icon={<Pencil />} onSelect={() => openAction({ kind: 'rename', mountId: mount.id, path: entry.path, isDir })}>
                {t('Umbenennen / verschieben')}
              </ContextItem>
            </>
          )}
          <ContextItem icon={<Files />} onSelect={() => clip('copy', mount.id, entry.path, isDir)} shortcut={t('Strg+C')}>
            {t('Kopieren')}
          </ContextItem>
          {!ro && (
            <ContextItem icon={<Scissors />} onSelect={() => clip('cut', mount.id, entry.path, isDir)} shortcut={t('Strg+X')}>
              {t('Ausschneiden')}
            </ContextItem>
          )}
          {!ro && canPaste(clipItem, mount, parentForNew) && (
            <ContextItem icon={<ClipboardPaste />} onSelect={() => void pasteInto(qc, mount, parentForNew)} shortcut={t('Strg+V')}>
              {isDir ? t('Einfügen „{name}“', { name: noteNameIn(clipItem.mountId, clipItem.path) }) : t('Einfügen „{name}“ daneben', { name: noteNameIn(clipItem.mountId, clipItem.path) })}
            </ContextItem>
          )}
          <ContextItem icon={<Copy />} onSelect={() => void copyWithToast(fullPath(mount.id, entry.path))}>
            {t('Pfad kopieren')}
          </ContextItem>
          <ContextItem icon={<ListChecks />} onSelect={() => useMarked.getState().pick(mount.id, item())} shortcut={t('Strg+Klick')}>
            {t('Auswählen')}
          </ContextItem>
          {isDir && !ro && (
            <ContextSub icon={<Upload />} label={t('Importieren')}>
              <ContextItem
                icon={<FileText />}
                disabled={inEncrypted}
                title={inEncrypted ? t('In einen verschlüsselten Ordner lässt sich nichts importieren') : undefined}
                onSelect={() => importMarkdown(qc, mount.id, entry.path)}
              >
                {t('Markdown-Dateien …')}
              </ContextItem>
              <ContextItem
                icon={<FileArchive />}
                disabled={inEncrypted}
                title={inEncrypted ? t('In einen verschlüsselten Ordner lässt sich nichts importieren') : undefined}
                onSelect={() => openAction({ kind: 'import', mountId: mount.id, parent: entry.path, where: `${mount.name} / ${entry.path}` })}
              >
                {t('Aus anderem Programm …')}
              </ContextItem>
            </ContextSub>
          )}
          {!inEncrypted && (
            <ContextSub icon={<FileDown />} label={t('Exportieren')}>
              <ContextItem onSelect={() => downloadExport(mount.id, entry.path)}>{isDir ? t('HTML (ZIP)') : t('HTML-Datei')}</ContextItem>
              <ContextItem onSelect={() => downloadExport(mount.id, entry.path, 'md')}>{isDir ? t('Markdown (ZIP)') : t('Markdown')}</ContextItem>
            </ContextSub>
          )}
          {isAdmin && (
            <ContextItem icon={<History />} onSelect={() => openSettings('backup-files', { mountId: mount.id, path: entry.path })}>
              {t('Aus Backup wiederherstellen …')}
            </ContextItem>
          )}
          {!ro && (siblings.length > 1 || (isDir && index.ordered.has(entry.path))) && (
            // Drag and drop does the same; this is for touch screens and the keyboard.
            <ContextSub icon={<ArrowUpDown />} label={t('Anordnen')}>
              {siblingIndex > 0 && (
                <ContextItem icon={<ArrowUp />} onSelect={() => void shiftInOrder(qc, mount, entry.parent, siblings, entry.name, -1)}>
                  {t('Nach oben')}
                </ContextItem>
              )}
              {siblingIndex < siblings.length - 1 && (
                <ContextItem icon={<ArrowDown />} onSelect={() => void shiftInOrder(qc, mount, entry.parent, siblings, entry.name, 1)}>
                  {t('Nach unten')}
                </ContextItem>
              )}
              {isDir && index.ordered.has(entry.path) && (
                <ContextItem icon={<ArrowDownAZ />} onSelect={() => void saveOrder(qc, mount, entry.path, [])}>
                  {t('Inhalt alphabetisch sortieren')}
                </ContextItem>
              )}
            </ContextSub>
          )}
          <ContextItem icon={<Star />} onSelect={() => usePersonal.getState().toggleFavorite({ mountId: mount.id, path: notePath ?? entry.path, title, dir: isDir || undefined })}>
            {usePersonal.getState().isFavorite(mount.id, notePath ?? entry.path) ? t('Aus Favoriten entfernen') : t('Zu Favoriten')}
          </ContextItem>
          <ContextItem icon={<Eye />} onSelect={() => openAction({ kind: 'watch', mountId: mount.id, path: entry.path, isDir, title })}>
            {watchOf(watchData, mount.id, entry.path) ? t('Beobachten ändern …') : t('Beobachten …')}
          </ContextItem>
          {notePath && (
            <>
              {!ro && (
                <ContextItem icon={<Smile />} onSelect={() => openAction({ kind: 'icon', mountId: mount.id, path: notePath, icon })}>
                  {t('Icon ändern …')}
                </ContextItem>
              )}
            </>
          )}
          {isDir && !ro && !inEncrypted && (
            <ContextItem icon={<Lock />} onSelect={() => void cryptFolder(qc, mount, entry.path, true)}>
              {t('Ordner verschlüsseln …')}
            </ContextItem>
          )}
          {isDir && !ro && index.encrypted.has(entry.path) && <FinishEncryption qc={qc} mount={mount} folder={entry.path} />}
          {isDir && !ro && index.encrypted.has(entry.path) && (
            <ContextItem icon={<LockOpen />} onSelect={() => void cryptFolder(qc, mount, entry.path, false)}>
              {t('Verschlüsselung aufheben …')}
            </ContextItem>
          )}
          {entry.access === 'admin' && (
            <ContextItem icon={<ShieldCheck />} onSelect={() => openAction({ kind: 'acl', mountId: mount.id, target: isDir ? 'folder' : 'note', path: entry.path, title })}>
              {t('Berechtigungen …')}
            </ContextItem>
          )}
          {!session?.user?.isGuest && (entry.access === 'admin' || !isDir) && (
            // Owner 28.10.: „Per Mail versenden“ (the note as a file, for anyone) next to giving access by e-mail.
            <ContextSub icon={<Send />} label={t('Teilen')}>
              {!isDir && (
                <ContextItem
                  icon={<Mail />}
                  disabled={!session?.mail || inEncrypted}
                  title={!session?.mail ? t('E-Mail-Versand ist nicht eingerichtet') : inEncrypted ? t('Verschlüsselte Notizen lassen sich nicht per Mail versenden') : undefined}
                  onSelect={() => openAction({ kind: 'mail-notes', mountId: mount.id, notes: [{ path: entry.path, title }] })}
                >
                  {t('Per Mail versenden …')}
                </ContextItem>
              )}
              {entry.access === 'admin' && (
                <ContextItem icon={<Send />} onSelect={() => openAction({ kind: 'share', mountId: mount.id, target: isDir ? 'folder' : 'note', path: entry.path, title })}>
                  {t('Zugriff per E-Mail geben …')}
                </ContextItem>
              )}
            </ContextSub>
          )}
          {isAdmin && (
            <ContextItem icon={<Sparkles />} onSelect={() => openAction({ kind: 'ai-rule', mountId: mount.id, target: isDir ? 'folder' : 'note', path: entry.path, title })}>
              {t('KI-Freigabe …')}
            </ContextItem>
          )}
          {!ro && (
            <>
              <ContextSeparator />
              <ContextItem icon={<Trash2 />} danger onSelect={() => openAction({ kind: 'delete', mountId: mount.id, path: entry.path, isDir, title })}>
                {t('Löschen')}
              </ContextItem>
            </>
          )}
          </>
          )}
        </ContextContent>
      </ContextMenu>
      {isDir && expanded && (index.map.get(entry.path) ?? []).map((c) => <Node key={c.path} mount={mount} entry={c} depth={depth + 1} index={index} />)}
    </>
  );
}

/** Tooltip on a source: what it is, also when it has an icon of its own. */
export const mountKind = (m: Mount) =>
  m.type === 'remote'
    ? t('Git-Repository (wird synchronisiert): {source}', { source: m.source })
    : m.git
      ? t('Lokaler Ordner in einem Git-Repository (Kaveyl Wiki gleicht nicht ab): {source}', { source: m.source })
      : t('Lokaler Ordner (ohne Git, nichts zu synchronisieren): {source}', { source: m.source });

/** Fixed symbol right of a source name: repository or local folder — whatever icon the source has. */
export function MountKind({ mount }: { mount: Mount }) {
  const [Icon, label] = mount.type === 'remote' ? [GitBranch, t('Repository')] : mount.git ? [FolderGit2, t('Lokaler Ordner mit Git')] : [HardDrive, t('Lokaler Ordner')];
  return (
    <span role="img" aria-label={label} title={mountKind(mount)} className="ml-1.5 flex shrink-0 text-fg-muted">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * Icon of a source: its own (emoji or picker value), else a neutral one — the kind shows in
 * MountKind. The default also stands in for an unknown Lucide name. Tree and settings use it.
 */
export function MountIcon({ mount }: { mount: Mount }) {
  // Neutral without an own icon: the kind is always shown by MountKind right of the name (AD-032).
  const fallback = <Library className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  if (mount.icon) return /^(lucide|emoji|custom):/.test(mount.icon) ? <IconGlyph icon={mount.icon} className="h-3.5 w-3.5" fallback={fallback} /> : <span className="w-4 text-center">{mount.icon}</span>;
  return fallback;
}

export function EntryIcon({ icon, isDir, open }: { icon: string | null; isDir: boolean; open?: boolean }) {
  // Frontmatter `icon:` (see editor/icons.tsx), otherwise folder/file.
  if (icon) return <IconGlyph icon={icon} />;
  if (isDir) return open ? <FolderOpen className="h-4 w-4 shrink-0 text-fg-faint" /> : <Folder className="h-4 w-4 shrink-0 text-fg-faint" />;
  return <FileText className="h-4 w-4 shrink-0 text-fg-faint" />;
}

/** Source menu → Backup → „Jetzt sichern“: every active plan that includes the source (AD-038). */
async function backupNow(mount: Mount) {
  try {
    const r = await api.backupSource(mount.id);
    toast({
      kind: 'ok',
      title: t('Sicherung gestartet'),
      text: t('„{name}“ wird gesichert ({plans}) – nur diese Quelle, ohne die Kaveyl-Wiki-Datenbank. Fortschritt unter Einstellungen → Backup → Sicherungen.', { name: mount.name, plans: r.plans.join(', ') }),
    });
  } catch (e) {
    toast({ kind: 'warn', title: t('Keine Sicherung'), text: errorText(e) });
  }
}
