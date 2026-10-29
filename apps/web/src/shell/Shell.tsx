// Workspace layout: sidebar (search, mount trees) + tab bar + note view.
import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Settings, LogOut, Plus, X, FileText, PanelLeftClose, PanelLeft, FilePlus, RefreshCw, Sun, Moon, Monitor, ListTree, Maximize2, ListFilter, LocateFixed, History, FolderPlus, Hash, Star, Columns2, Pin, PinOff, ChevronsUpDown, ChevronsDownUp, Sparkles, Trash2, Printer, FileDown, CircleHelp, CircleUserRound, Languages, UserRoundCog, ArrowUpCircle, ShieldAlert } from 'lucide-react';
import * as DM from '@radix-ui/react-dropdown-menu';
import { api, ApiError, type Entry, type Mount, type User } from '../api';
import { useServerEvents } from '../events';
import { Logo } from '../auth/AuthPages';
import { PRODUCT_SHORT } from '../logo';
import { MountWizard } from '../mounts/MountWizard';
import { nodeKey, restoreWorkspace, useWorkspace, type SavedWorkspace, type Tab } from '../store';
import { usePrefs } from '../prefs';
import { Button, ConfirmHost, InputHost, ContextContent, ContextItem, ContextMenu, ContextTrigger, DropdownContent, IconButton, Modal, PartLoading, confirmDialog, cx, glueEllipsis, useMediaQuery } from '../ui';
import { countUnsaved, discardUnsaved, useUnsaved } from '../unsaved';
import { ActionDialogs } from './actions';
import { PassphraseHost } from '../editor/Passphrase';
import { DrawingDialog } from '../editor/Drawing';
import { downloadExport, printNote } from '../editor/exporting';
import { isSealed } from '../editor/sealed';
import { SearchBox, type SearchHandle } from './Search';
import { CommandPalette, SearchPage, useSearchPage, type Command } from './Palette';
import { TagBrowser } from '../editor/Tags';
import { PersonalSections } from './Personal';
import { AiRulesSection } from './AiRules';
import { usePersonal } from '../personal';
import { useActions } from './actions';
import { useTheme } from '../theme';
import { toast } from '../toast';
import { Welcome } from './Welcome';
import { UpdateBadge, useUpdateMenuEntry } from './Updates';
import { ThemeToggle, askLanguage, reopenAfterLanguageSwitch } from '../Toggles';
import { LANGUAGES, lang, t, tn } from '../i18n';
import { openSettings, useSettingsNav } from './settingsNav';
import { HelpDialog } from '../help/HelpDialog';
import { helpAnchorInFront, helpTarget, openHelp, useHelp } from '../help/help';
import { MountTree, SourcesTree, expandAllIn } from './Tree';
import { treeClipboardKeys } from './noteClipboard';
import { useAi, useAiAvailable } from '../ai/aiStore';
import { SyncStatus } from './SyncStatus';
import { Toaster } from '../toast';
import { noteName, noteNameIn } from '../names';
import { scrollHint } from '../scrollHint';
import { PartBoundary, lazyPart } from '../lazyPart';
import { dropPrefetchedNotes, prefetchNote } from '../notePrefetch';

/** Settings (all pages, admin areas included) load on first open, not with the workspace (seo-001). */
type SettingsProps = Parameters<typeof import('./Settings').SettingsBody>[0];
const loadSettings = () => import('./Settings');
// A tab opened before an update asks for a file the new build no longer has: say so instead of a blank page.
const SettingsBody = lazyPart<SettingsProps>(() => loadSettings().then((m) => m.SettingsBody), SettingsUnavailable);

function SettingsUnavailable({ open, onClose }: Pick<SettingsProps, 'open' | 'onClose'>) {
  useEffect(() => {
    if (!open) return;
    toast({ kind: 'error', title: t('Die Einstellungen konnten nicht geladen werden. Bitte die Seite neu laden.') });
    onClose();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * The editor and the AI dialogs come with the first note or the first question, not with the workspace: the
 * sidebar shows before their libraries (ProseMirror, highlighting, Markdown) have loaded.
 */
const loadNoteView = () => import('../editor/NoteView');
const NoteView = lazyPart(() => loadNoteView().then((m) => m.NoteView));
const AiAskDialog = lazyPart(() => import('../ai/AiAssist').then((m) => m.AiAskDialog), AiUnavailable);
const AiSuggestionDialog = lazyPart(() => import('../ai/AiAssist').then((m) => m.AiSuggestionDialog), AiUnavailable);

/** A tab opened before an update asks for files the new build no longer has. */
function AiUnavailable() {
  useEffect(() => {
    toast({ kind: 'error', title: t('Dieser Teil der App konnte nicht geladen werden. Bitte die Seite neu laden.') });
    useAi.getState().close();
  }, []);
  return null;
}

const NOTE_LOADING = <PartLoading big className="h-full" />;

/** While the AI dialogs load, a click on „KI fragen“ already opens the dialog frame (design-010). */
function AiLoading() {
  const ask = useAi((s) => !!s.ask);
  const close = useAi((s) => s.close);
  if (!ask) return null;
  return (
    <Modal help="frag-die-wissensbasis" open onOpenChange={(o) => !o && close()} title={t('Frag die Wissensbasis')} wide="xl">
      <PartLoading big className="min-h-40" />
    </Modal>
  );
}

const decodeSafe = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** A file dropped where nothing takes it (e.g. on a locked note) is refused instead of the browser opening it in place of the app. */
function keepDroppedFilesIn() {
  const withFiles = (e: DragEvent) => !e.defaultPrevented && !!e.dataTransfer?.types.includes('Files');
  const over = (e: DragEvent) => {
    if (!withFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'none';
  };
  const drop = (e: DragEvent) => withFiles(e) && e.preventDefault();
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
  };
}

export function Shell({ user }: { user: User }) {
  useServerEvents();
  const qc = useQueryClient();
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const { tabs, activeId, loaded, sidebarWidth } = useWorkspace();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mounted from the first open on and then kept (remembers its page like before).
  const [settingsUsed, setSettingsUsed] = useState(false);
  if (settingsOpen && !settingsUsed) setSettingsUsed(true);
  // The AI dialogs likewise: loaded on first open, then kept (they remember chat and scope).
  const aiAskOpen = useAi((s) => !!s.ask);
  const aiSuggestionOpen = useAi((s) => !!s.suggestion);
  const [aiUsed, setAiUsed] = useState(false);
  if ((aiAskOpen || aiSuggestionOpen) && !aiUsed) setAiUsed(true);
  // Settings opened at a page from elsewhere (source menu → Backup).
  const settingsRequest = useSettingsNav((s) => s.request?.n);
  const settingsHelp = useSettingsNav((s) => s.help);
  const settingsWide = useSettingsNav((s) => s.wide);
  useEffect(() => {
    if (settingsRequest) setSettingsOpen(true);
  }, [settingsRequest]);
  useEffect(reopenAfterLanguageSwitch, []);
  useEffect(keepDroppedFilesIn, []);
  const [wizard, setWizard] = useState<{ open: boolean; edit: Mount | null }>({ open: false, edit: null });
  // Phones (< 768 px): the sidebar is a drawer over the content, closed unless opened (Phase 7).
  const mobile = useMediaQuery('(max-width: 767px)');
  const signOut = async () => {
    // Signing out drops what the editors have not saved yet: only after asking (code-012).
    const unsaved = countUnsaved(useUnsaved.getState().notes);
    if (unsaved) {
      const text = tn(unsaved, '{n} Notiz ist noch nicht gespeichert. Abmelden und die Änderungen verwerfen?', '{n} Notizen sind noch nicht gespeichert. Abmelden und die Änderungen verwerfen?');
      if (!(await confirmDialog(text, { confirmLabel: t('Verwerfen'), cancelLabel: t('Weiter bearbeiten'), danger: true }))) return;
      // Before the request: the session may be reported gone (live connection) before its answer.
      discardUnsaved();
    }
    const { redirect } = await api.logout().catch((e: unknown) => {
      useUnsaved.setState({ discarded: false });
      throw e;
    });
    // Signed in through an auth proxy: sign out there too, or the next request signs in again (AD-049).
    if (redirect) return window.location.assign(redirect);
    await qc.invalidateQueries({ queryKey: ['session'] });
  };
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const opened = useWorkspace((s) => s.opened);
  useEffect(() => {
    if (mobile) setCollapsed(true);
  }, [mobile, opened]);
  const search = useRef<SearchHandle>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchPage = useSearchPage();
  const [, setTheme] = useTheme();

  // Restore workspace (tabs etc.) from the server, then open a note from the URL if given.
  // The note shown first and the editor code are asked for side by side, not one after the other (seo-001).
  useEffect(() => {
    void usePrefs.getState().load();
    void usePersonal.getState().load();
    const m = /^\/n\/([^/]+)\/(.+)$/.exec(location.pathname);
    // A broken escape in the address (/n/x/%E0) opens the workspace without a note, never the error page.
    const path = m ? decodeSafe(m[2]!) : null;
    const fromUrl = m && path !== null ? { mountId: m[1]!, path } : null;
    // /t/<source>/<folder>: a shared folder or source (mail link), shown in the tree.
    const shown = /^\/t\/([^/]+)\/?(.*)$/.exec(location.pathname);
    const inTree = shown ? { mountId: shown[1]!, path: decodeSafe(shown[2]!) ?? '' } : null;
    if (fromUrl) {
      prefetchNote(fromUrl.mountId, fromUrl.path);
      void loadNoteView().catch(() => undefined);
    }
    let stopped = false;
    let settingsTimer: ReturnType<typeof setTimeout> | undefined;
    // A failed load is retried without saving meanwhile (code-001b); the note in the URL opens either way.
    const stop = restoreWorkspace(
      () => api.getState<SavedWorkspace>('workspace'),
      (s) => api.putState('workspace', s),
      () => {
        if (fromUrl) useWorkspace.getState().openNote(fromUrl.mountId, fromUrl.path, fromUrl.path.split('/').pop()!.replace(/\.md$/i, ''));
        if (inTree) {
          // Shown and open: what was shared is inside the folder.
          useWorkspace.getState().revealInTree(inTree.mountId, inTree.path);
          useWorkspace.getState().expandMany([nodeKey(inTree.mountId, inTree.path)]);
        }
        const { tabs, activeId, splitId } = useWorkspace.getState();
        for (const tab of tabs) if (tab.id === activeId || tab.id === splitId) prefetchNote(tab.mountId, tab.path);
        // Settings are fetched once the workspace is idle, so the first open is (almost always) instant – after the
        // editor code when a note shows, not in the middle of its download.
        const editor = tabs.length ? loadNoteView().catch(() => undefined) : Promise.resolve();
        void editor.then(() => {
          if (!stopped) settingsTimer = setTimeout(() => void loadSettings().catch(() => undefined), 2000);
        });
      },
    );
    return () => {
      stopped = true;
      clearTimeout(settingsTimer);
      stop();
      dropPrefetchedNotes();
    };
  }, []);

  // Keep the URL in sync with the active tab (shareable/bookmarkable links).
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const splitId = useWorkspace((s) => s.splitId);
  const hoist = useWorkspace((s) => s.hoist);
  const split = splitId && splitId !== activeId ? (tabs.find((tab) => tab.id === splitId) ?? null) : null;
  useEffect(() => {
    if (!loaded) return;
    const url = active ? `/n/${active.mountId}/${active.path.split('/').map(encodeURIComponent).join('/')}` : '/';
    if (location.pathname !== url) history.replaceState(null, '', url);
    document.title = active ? `${noteNameIn(active.mountId, active.path)} · ${PRODUCT_SHORT}` : PRODUCT_SHORT;
  }, [active, loaded]);
  // "Zuletzt geöffnet": recorded by NoteView once the active tab's note has loaded (design-008).

  // A help link opened in a new tab (`?hilfe=…`, see helpHref): the help at that spot, then the address as it was.
  useEffect(() => {
    const url = new URL(location.href);
    const spot = url.searchParams.get('hilfe');
    if (spot === null) return;
    const target = helpTarget(`?hilfe=${encodeURIComponent(spot).replace(/^api%3A/, 'api:')}`, 'handbuch')!;
    url.searchParams.delete('hilfe');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    openHelp(target.anchor || null, target.doc);
  }, []);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // F1: help — for the setting or dialog in front, the manual otherwise.
        e.preventDefault();
        if (!useHelp.getState().open) openHelp(helpAnchorInFront());
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setCollapsed(false);
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const mountList = (mounts.data ?? []).filter((m) => !m.paused);
  // A source visibly open: the toggle next to the search closes everything. Keys of folders inside a
  // closed source or of removed sources stay in `expanded` but show nothing, so they do not count.
  const anyOpen = useWorkspace((s) => mountList.some((m) => !!s.expanded[nodeKey(m.id, '')]));
  const mountById = new Map(mountList.map((m) => [m.id, m]));
  const openAction = useActions((s) => s.open);
  const prefs = usePrefs();
  const aiAvailable = useAiAvailable();
  const activeMount = active ? mountById.get(active.mountId) : mountList[0];
  /** Trash of the source in focus: hoisted, else the open note's, else the first. */
  const openTrash = () => {
    const m = (hoist && mountById.get(hoist.mountId)) || activeMount || mountList[0];
    if (m) openAction({ kind: 'trash', mountId: m.id });
  };
  const commands: Command[] = [
    // Not for a read-only source (checklist 20.10.); missing rights below the root the server answers itself.
    ...(activeMount && !activeMount.options.readonly
      ? [
          {
            id: 'new-note',
            label: t('Neue Notiz'),
            hint: activeMount.name,
            icon: <FilePlus />,
            keywords: ['neu', 'notiz', 'anlegen', 'new', 'note', 'create'],
            run: () => openAction({ kind: 'create', mountId: activeMount.id, parent: active && active.mountId === activeMount.id ? active.path.split('/').slice(0, -1).join('/') : '', type: 'file' }),
          },
          {
            id: 'new-folder',
            label: t('Neuer Ordner'),
            hint: activeMount.name,
            icon: <FolderPlus />,
            keywords: ['neu', 'ordner', 'folder', 'new', 'create'],
            run: () => openAction({ kind: 'create', mountId: activeMount.id, parent: active && active.mountId === activeMount.id ? active.path.split('/').slice(0, -1).join('/') : '', type: 'dir' }),
          },
        ]
      : []),
    ...(active
      ? [
          { id: 'reveal', label: t('Aktuelle Notiz im Baum anzeigen'), icon: <LocateFixed />, keywords: ['baum', 'tree', 'zeigen', 'show', 'reveal'], run: () => useWorkspace.getState().revealInTree(active.mountId, active.path) },
          {
            id: 'favorite',
            label: usePersonal.getState().isFavorite(active.mountId, active.path) ? t('Aus Favoriten entfernen') : t('Zu Favoriten hinzufügen'),
            icon: <Star />,
            keywords: ['favorit', 'stern', 'merken', 'favourite', 'favorite', 'star'],
            run: () => usePersonal.getState().toggleFavorite({ mountId: active.mountId, path: active.path, title: active.title }),
          },
          ...(split
            ? [{ id: 'close-split', label: t('Geteilte Ansicht schließen'), icon: <Columns2 />, keywords: ['split', 'geteilt', 'schließen', 'close'], run: () => useWorkspace.getState().closeSplit() }]
            : []),
          { id: 'history', label: t('Versionen der aktuellen Notiz'), icon: <History />, keywords: ['versionen', 'historie', 'history', 'versions'], run: () => openAction({ kind: 'history', mountId: active.mountId, path: active.path }) },
        ]
      : []),
    ...(hoist ? [{ id: 'unhoist', label: t('Fokus aufheben (alle Quellen zeigen)'), icon: <X />, keywords: ['fokus', 'hoist', 'alle', 'focus', 'all'], run: () => useWorkspace.getState().setHoist(null) }] : []),
    { id: 'expand-all', label: t('Alles aufklappen'), icon: <ChevronsUpDown />, keywords: ['aufklappen', 'expand', 'baum', 'tree'], run: () => expandEverything(qc, mountList) },
    { id: 'collapse-all', label: t('Alles zuklappen'), icon: <ChevronsDownUp />, keywords: ['zuklappen', 'collapse', 'baum', 'tree'], run: collapseEverything },
    ...(aiAvailable
      ? [
          {
            id: 'ai-ask',
            label: t('KI fragen …'),
            icon: <Sparkles />,
            keywords: ['ki', 'ai', 'frage', 'wissensbasis', 'assistent', 'ask', 'question', 'knowledge', 'assistant'],
            run: () => useAi.getState().openAsk(active ? { kind: 'note', mountId: active.mountId, path: active.path } : { kind: 'all' }),
          },
        ]
      : []),
    { id: 'tags', label: t('Tags durchsuchen'), icon: <Hash />, keywords: ['tags', 'schlagworte', '#', 'browse'], run: () => searchPage.openTags() },
    { id: 'search-page', label: t('Suche mit Filtern'), icon: <ListFilter />, keywords: ['suche', 'filter', 'tag', 'search'], run: () => searchPage.open() },
    {
      id: 'sync',
      label: t('Alle Quellen synchronisieren'),
      icon: <RefreshCw />,
      keywords: ['sync', 'pull', 'push', 'abgleichen'],
      run: () => void api.syncAll().then(() => toast({ kind: 'ok', title: t('Synchronisation angestoßen') })),
    },
    ...(active
      ? [
          { id: 'print', label: t('Notiz drucken / als PDF'), icon: <Printer />, keywords: ['drucken', 'print', 'pdf'], run: () => printNote(active.mountId, active.path, isSealed(active.mountId, active.path)) },
          { id: 'export', label: t('Notiz exportieren: HTML-Datei'), icon: <FileDown />, keywords: ['export', 'html', 'herunterladen', 'download'], run: () => downloadExport(active.mountId, active.path) },
          { id: 'export-md', label: t('Notiz exportieren: Markdown'), icon: <FileDown />, keywords: ['export', 'markdown', 'md', 'zip', 'herunterladen', 'download'], run: () => downloadExport(active.mountId, active.path, 'md') },
        ]
      : []),
    { id: 'trash', label: t('Papierkorb'), icon: <Trash2 />, keywords: ['papierkorb', 'gelöscht', 'wiederherstellen', 'trash', 'deleted', 'restore'], run: () => openTrash() },
    { id: 'settings', label: t('Einstellungen'), icon: <Settings />, keywords: ['einstellungen', 'settings', 'optionen', 'options', 'preferences'], run: () => setSettingsOpen(true) },
    { id: 'help', label: t('Hilfe / Handbuch'), icon: <CircleHelp />, keywords: ['hilfe', 'help', 'handbuch', 'anleitung', 'f1', 'manual', 'guide'], run: () => openHelp() },
    { id: 'help-markdown', label: t('Hilfe: Markdown-Spickzettel'), icon: <CircleHelp />, keywords: ['markdown', 'syntax', 'spickzettel', 'formatierung', 'cheat sheet', 'formatting'], run: () => openHelp('markdown-spickzettel') },
    { id: 'help-keys', label: t('Hilfe: Tastenkürzel'), icon: <CircleHelp />, keywords: ['tastenkürzel', 'shortcuts', 'tasten', 'keyboard', 'keys'], run: () => openHelp('tastenkürzel') },
    ...(user.isAdmin ? [{ id: 'add-mount', label: t('Quelle einbinden'), icon: <Plus />, keywords: ['quelle', 'repo', 'ordner', 'mount', 'source', 'add', 'folder'], run: () => setWizard({ open: true, edit: null }) }] : []),
    { id: 'theme-light', label: t('Darstellung: Hell'), icon: <Sun />, keywords: ['hell', 'light', 'theme', 'appearance'], run: () => setTheme('light') },
    { id: 'theme-dark', label: t('Darstellung: Dunkel'), icon: <Moon />, keywords: ['dunkel', 'dark', 'theme', 'appearance'], run: () => setTheme('dark') },
    { id: 'theme-system', label: t('Darstellung: wie System'), icon: <Monitor />, keywords: ['system', 'theme', 'appearance'], run: () => setTheme('system') },
    // Every language under its own name, so it is found whatever the interface currently speaks.
    ...LANGUAGES.filter((l) => l.code !== lang).map((l) => ({
      id: `lang-${l.code}`,
      label: t('Sprache: {name}', { name: l.name }),
      icon: <Languages />,
      keywords: ['sprache', 'language', 'langue', l.name.toLowerCase(), l.code],
      run: () => void askLanguage(l.code),
    })),
    { id: 'sidebar', label: collapsed ? t('Seitenleiste einblenden') : t('Seitenleiste ausblenden'), icon: <PanelLeft />, keywords: ['seitenleiste', 'sidebar'], run: () => setCollapsed((c) => !c) },
    { id: 'toc', label: prefs.showToc ? t('Inhaltsverzeichnis ausblenden') : t('Inhaltsverzeichnis einblenden'), icon: <ListTree />, keywords: ['inhalt', 'toc', 'contents'], run: () => prefs.set({ showToc: !prefs.showToc }) },
    { id: 'width', label: prefs.editorWidth === 'full' ? t('Normale Breite') : t('Volle Breite'), icon: <Maximize2 />, keywords: ['breite', 'width', 'voll', 'full'], run: () => prefs.set({ editorWidth: prefs.editorWidth === 'full' ? 'normal' : 'full' }) },
  ];

  return (
    <div className="flex h-full overflow-hidden">
      {!collapsed && mobile && <div className="fixed inset-0 z-30 bg-black/30" aria-hidden="true" onClick={() => setCollapsed(true)} />}
      {!collapsed && (
        <aside
          className={cx('flex shrink-0 flex-col border-r border-line bg-subtle', mobile && 'fixed inset-y-0 left-0 z-40 w-[min(88vw,340px)] shadow-pop')}
          style={mobile ? undefined : { width: sidebarWidth }}
          aria-label={t('Seitenleiste')}
        >
          <div className="flex h-11 items-center gap-2 px-3">
            <Logo />
            <span className="text-sm font-semibold">{PRODUCT_SHORT}</span>
            <span className="flex-1">
              <SyncStatus isAdmin={user.isAdmin} />
            </span>
            {aiAvailable && (
              <IconButton label={t('KI fragen')} onClick={() => useAi.getState().openAsk({ kind: 'all' })}>
                <Sparkles className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton label={t('Tags')} onClick={() => searchPage.openTags()}>
              <Hash className="h-4 w-4" />
            </IconButton>
            <IconButton label={t('Seitenleiste ausblenden')} onClick={() => setCollapsed(true)}>
              <PanelLeftClose className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="flex items-center gap-0.5 px-3 pb-2">
            <div className="min-w-0 flex-1">
              <SearchBox ref={search} mounts={mountList} onSearchPage={(q) => searchPage.open(q)} />
            </div>
            {/* One toggle like at every source: something open → close everything, else open everything. */}
            <IconButton label={anyOpen ? t('Alles zuklappen') : t('Alles aufklappen')} onClick={() => (anyOpen ? collapseEverything() : expandEverything(qc, mountList))}>
              {anyOpen ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
            </IconButton>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-4 [scrollbar-gutter:stable]">
            <PersonalSections mounts={mountList} />
            {user.isAdmin && <AiRulesSection mounts={mountList} />}
            <nav aria-label={t('Quellen')} tabIndex={-1} className="outline-none" onKeyDown={(e) => treeClipboardKeys(e, qc)}>
              <SourcesTree>
                {mountList.filter((m) => !hoist || !mountById.has(hoist.mountId) || m.id === hoist.mountId).map((m) => (
                  <MountTree
                    key={m.id}
                    mount={m}
                    onEditMount={(mount) => setWizard({ open: true, edit: mount })}
                    mountIds={mountList.map((x) => x.id)}
                    canReorder={user.isAdmin && !hoist}
                  />
                ))}
              </SourcesTree>
              {mounts.data && mountList.length === 0 && (
                <div className="mx-1 mt-4 rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-fg-muted">
                  {/* Users and guests see the same words as their welcome page: a source exists, it is just not shared yet. */}
                  <p className="mb-1 text-fg">{user.isAdmin ? t('Noch keine Quelle eingebunden.') : t('Auf eine Freigabe warten')}</p>
                  <p className={cx('text-xs', user.isAdmin && 'mb-4')}>
                    {user.isAdmin
                      ? t('Ein Repository oder ein Ordner mit Markdown-Dateien.')
                      : user.isGuest
                        ? t('Noch ist nichts mit dir geteilt. Sobald dir jemand eine Notiz freigibt, steht sie links im Baum – du bekommst dazu eine E-Mail.')
                        : t('Dir ist noch keine Quelle freigegeben. Ein Administrator gibt dir Quellen oder Ordner frei – danach erscheinen sie links im Baum.')}
                  </p>
                  {user.isAdmin && (
                    <Button size="sm" variant="primary" onClick={() => setWizard({ open: true, edit: null })}>
                      <Plus className="h-3.5 w-3.5" /> {t('Quelle einbinden')}
                    </Button>
                  )}
                </div>
              )}
              {mounts.isError && !mounts.data && (
                <div role="alert" className="mx-1 mt-4 rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-fg-muted">
                  <p className="mb-1 text-fg">{t('Die Quellen konnten nicht geladen werden.')}</p>
                  <p className="mb-4 text-xs">{mounts.error instanceof ApiError ? mounts.error.message : t('Server nicht erreichbar')}</p>
                  <Button size="sm" disabled={mounts.isFetching} onClick={() => void mounts.refetch()}>
                    <RefreshCw className="h-3.5 w-3.5" /> {t('Erneut versuchen')}
                  </Button>
                </div>
              )}
            </nav>
          </div>
          {mountList.length > 0 && (
            <div className="flex h-9 items-center border-t border-line pr-2">
              {user.isAdmin ? (
                <button className="flex h-full flex-1 items-center gap-2 px-4 text-sm text-fg-muted hover:bg-hover hover:text-fg" onClick={() => setWizard({ open: true, edit: null })}>
                  <Plus className="h-4 w-4" /> {t('Quelle einbinden')}
                </button>
              ) : (
                <span className="flex-1" />
              )}
              <IconButton label={t('Papierkorb')} onClick={openTrash}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          )}
        </aside>
      )}
      {!collapsed && !mobile && <Resizer />}
      <main className="flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={tabs}
          activeId={activeId}
          collapsed={collapsed}
          onExpand={() => setCollapsed(false)}
          folderNote={(id) => mountById.get(id)?.options.folderNote}
          appButtons={<AppButtons user={user} compact={mobile} onSettings={() => setSettingsOpen(true)} onSignOut={() => void signOut()} />}
        />
        <div className="relative min-h-0 flex-1">
          {tabs.map((tab) => {
            const mount = mountById.get(tab.mountId);
            const isActive = tab.id === activeId;
            const isSplit = !!split && tab.id === split.id;
            // Split view: active note left, split note right; all others stay mounted but hidden.
            const style = split ? (isActive ? { right: '50%' } : isSplit ? { left: '50%' } : undefined) : undefined;
            return (
              <div key={tab.id} className={cx('absolute inset-0', !isActive && !isSplit && 'hidden', isSplit && 'border-l border-line')} style={style}>
                {mount ? <PartBoundary note={`${mount.id}:${tab.path}`}><Suspense fallback={NOTE_LOADING}><NoteView mount={mount} path={tab.path} isActive={isActive || isSplit} onCloseSplit={isSplit ? () => useWorkspace.getState().closeSplit() : undefined} onCloseTab={() => useWorkspace.getState().closeTab(tab.id)} onSearch={() => setPaletteOpen(true)} /></Suspense></PartBoundary> : mounts.data && <div className="p-10 text-center text-fg-muted">{t('Die Quelle dieser Notiz ist nicht (mehr) eingebunden.')}</div>}
              </div>
            );
          })}
          {!active &&
            mounts.data &&
            (prefs.hideWelcome && mounts.data.length > 0 ? (
              <EmptyState onSearch={() => setPaletteOpen(true)} />
            ) : (
              <Welcome user={user} hasMounts={mounts.data.length > 0} onAddMount={() => setWizard({ open: true, edit: null })} onSearch={() => setPaletteOpen(true)} />
            ))}
        </div>
      </main>
      <ActionDialogs />
      {aiUsed && (
        <Suspense fallback={<AiLoading />}>
          <AiSuggestionDialog />
          <AiAskDialog />
        </Suspense>
      )}
      <PassphraseHost />
      <DrawingDialog />
      <Toaster />
      <ConfirmHost />
      <InputHost />
      <HelpDialog />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} mounts={mountList} onSearchPage={(q) => searchPage.open(q)} />
      <SearchPage open={searchPage.isOpen} initial={searchPage.q} onClose={searchPage.close} mounts={mountList} />
      <Modal open={searchPage.tagsOpen} onOpenChange={(o) => searchPage.openTags(o)} title={t('Tags')} wide>
        <TagBrowser onPick={(tag) => searchPage.open(`tag:${/\s/.test(tag) ? `"${tag}"` : tag}`)} />
      </Modal>
      {settingsUsed && (
        // One dialog from the first click on (focus returns to the button); only its pages load on first open.
        <Modal
          open={settingsOpen}
          onOpenChange={(o) => {
            if (o) return;
            setSettingsOpen(false);
            useSettingsNav.setState({ request: null, wide: false });
          }}
          title={t('Einstellungen')}
          help={settingsHelp ?? undefined}
          wide={settingsWide ? 'full' : true}
        >
          <Suspense fallback={<PartLoading big className="min-h-40" />}>
            <SettingsBody
              open={settingsOpen}
              isAdmin={user.isAdmin}
              onClose={() => {
                setSettingsOpen(false);
                useSettingsNav.setState({ request: null, wide: false });
              }}
              // The wizard opens on top of the settings: closing it (Zurück, Esc, ×) goes back there.
              onAddMount={() => setWizard({ open: true, edit: null })}
              onEditMount={(m) => setWizard({ open: true, edit: m })}
            />
          </Suspense>
        </Modal>
      )}
      <MountWizard
        open={wizard.open}
        edit={wizard.edit}
        onClose={() => setWizard({ open: false, edit: null })}
        onBack={settingsOpen ? () => setWizard({ open: false, edit: null }) : undefined}
      />
    </div>
  );
}

function Resizer() {
  const width = useWorkspace((s) => s.sidebarWidth);
  const setWidth = useWorkspace((s) => s.setSidebarWidth);
  // Pointer events cover mouse, finger and pen (touch never sends mousedown); capture keeps the drag
  // on the handle even when the finger leaves it. `touch-none` stops the browser from scrolling instead.
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => setWidth(ev.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    setWidth(width + step);
  };
  // The visible line stays 4 px; the invisible strip around it is wide enough for a finger.
  return (
    <div
      className="relative z-10 w-1 shrink-0 cursor-col-resize touch-none hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
      onPointerDown={onDown}
      onKeyDown={onKey}
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Breite der Seitenleiste')}
      aria-valuenow={width}
      aria-valuemin={200}
      aria-valuemax={560}
    >
      <div className="absolute inset-y-0 -left-2 -right-2" aria-hidden="true" />
    </div>
  );
}

function TabBar({
  tabs,
  activeId,
  collapsed,
  onExpand,
  folderNote,
  appButtons,
}: {
  tabs: Tab[];
  activeId: string | null;
  collapsed: boolean;
  onExpand: () => void;
  folderNote: (mountId: string) => string | undefined;
  appButtons: ReactNode;
}) {
  const { activate, closeTab, closeOthers, setPinned, openSplit, closeSplit } = useWorkspace.getState();
  const splitId = useWorkspace((s) => s.splitId);
  // Many tabs scroll sideways: fade the edge where more follow, and keep the active tab in view.
  const bar = useRef<HTMLDivElement | null>(null);
  const barRef = useCallback((el: HTMLDivElement | null) => {
    bar.current = el;
    return scrollHint(el);
  }, []);
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>(':scope > [data-active-tab]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);
  return (
    <div className="flex h-9 shrink-0 items-end border-b border-line bg-subtle pl-1" data-print="hide">
      <div ref={barRef} className="scroll-hint flex min-w-0 flex-1 items-end gap-0.5 self-stretch overflow-x-auto">
      {collapsed && (
        <IconButton label={t('Seitenleiste einblenden')} className="mb-1.5 mr-1" onClick={onExpand}>
          <PanelLeft className="h-4 w-4" />
        </IconButton>
      )}
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextTrigger asChild>
            <div
              className={cx(
                'group flex h-8 shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-[0.8125rem]',
                tab.pinned ? 'max-w-[160px]' : 'max-w-[220px]',
                tab.id === activeId ? 'border-line bg-bg text-fg' : tab.id === splitId ? 'border-line bg-bg text-fg-muted' : 'border-transparent text-fg-muted hover:bg-hover',
              )}
              onClick={() => activate(tab.id)}
              onAuxClick={(e) => e.button === 1 && !tab.pinned && closeTab(tab.id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              title={tab.id === splitId ? t('{path} (rechts)', { path: tab.path }) : tab.pinned ? t('{path} (angeheftet)', { path: tab.path }) : tab.path}
              data-tab={tab.path}
              data-active-tab={tab.id === activeId ? '' : undefined}
              data-pinned={tab.pinned ? '' : undefined}
            >
              {tab.id === splitId ? <Columns2 className="h-3.5 w-3.5 shrink-0 text-fg-faint" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-fg-faint" />}
              <span className="truncate">{noteName(tab.path, folderNote(tab.mountId))}</span>
              {tab.pinned ? (
                <button
                  className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinned(tab.id, false);
                  }}
                  aria-label={t('Tab lösen')}
                  title={t('Angeheftet – klicken zum Lösen')}
                >
                  <Pin className="h-3 w-3" />
                </button>
              ) : (
                <button
                  className={cx('-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-active', tab.id === activeId ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-70 [@media(hover:none)]:opacity-70')}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label={t('Tab schließen')}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </ContextTrigger>
          <ContextContent>
            {tab.id !== activeId && tab.id !== splitId && (
              <>
                <ContextItem icon={<Columns2 />} onSelect={() => openSplit(tab.mountId, tab.path, tab.title)}>
                  {t('Rechts daneben anzeigen')}
                </ContextItem>
                <ContextItem icon={<PanelLeft />} onSelect={() => openSplit(tab.mountId, tab.path, tab.title, 'left')}>
                  {t('Links daneben anzeigen')}
                </ContextItem>
              </>
            )}
            {tab.id === splitId && (
              <ContextItem icon={<X />} onSelect={closeSplit}>
                {t('Geteilte Ansicht schließen')}
              </ContextItem>
            )}
            <ContextItem icon={tab.pinned ? <PinOff /> : <Pin />} onSelect={() => setPinned(tab.id, !tab.pinned)}>
              {tab.pinned ? t('Tab lösen') : t('Tab anheften')}
            </ContextItem>
            <ContextItem icon={<X />} onSelect={() => closeTab(tab.id)}>
              {t('Tab schließen')}
            </ContextItem>
            <ContextItem icon={<X />} onSelect={() => closeOthers(tab.id)}>
              {t('Andere Tabs schließen')}
            </ContextItem>
          </ContextContent>
        </ContextMenu>
      ))}
      </div>
      {/* Always visible, also with the sidebar closed and on phones: help, settings, account – and the colour scheme. */}
      <div className="flex shrink-0 items-center gap-0.5 self-stretch border-l border-line px-1.5">{appButtons}</div>
      <div className="flex shrink-0 items-center self-stretch border-l border-line px-1.5">
        <ThemeToggle className="h-7 w-7" />
      </div>
    </div>
  );
}

/**
 * Help, settings and the account menu at the top right (owner 21.10.: the sidebar header was full). `compact` (phones):
 * only the account menu, with help and settings in it – the tabs keep their room.
 */
function AppButtons({ user, compact, onSettings, onSignOut }: { user: User; compact: boolean; onSettings: () => void; onSignOut: () => void }) {
  const item = 'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover [&>svg]:h-4 [&>svg]:w-4';
  const update = useUpdateMenuEntry(compact && user.isAdmin);
  return (
    <>
      {!compact && (
        <>
          <UpdateBadge isAdmin={user.isAdmin} />
          <IconButton label={t('Hilfe (F1)')} className="h-7 w-7" onClick={() => openHelp()}>
            <CircleHelp className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('Einstellungen')} className="h-7 w-7" onClick={onSettings}>
            <Settings className="h-4 w-4" />
          </IconButton>
        </>
      )}
      <DM.Root modal={false}>
        <DM.Trigger asChild>
          <IconButton label={t('Konto ({name})', { name: user.displayName })} className="h-7 w-7">
            <CircleUserRound className="h-4 w-4" />
          </IconButton>
        </DM.Trigger>
        <DM.Portal>
          <DropdownContent align="end" sideOffset={4} minWidth={220} className="z-50">
            <div className="px-2 pb-1.5 pt-1">
              <div className="truncate font-medium">{user.displayName}</div>
              <div className="truncate text-xs text-fg-muted">{user.email}</div>
            </div>
            <DM.Separator className="my-1 h-px bg-line" />
            {update && (
              <>
                <DM.Item className={cx(item, update.security ? 'text-danger' : 'text-accent')} onSelect={() => window.open(update.url, '_blank', 'noreferrer')}>
                  {update.security ? <ShieldAlert /> : <ArrowUpCircle />} {update.label}
                </DM.Item>
                <DM.Item className={cx(item, 'text-fg-muted')} onSelect={update.dismiss}>
                  <X /> {t('Hinweis ausblenden')}
                </DM.Item>
                <DM.Separator className="my-1 h-px bg-line" />
              </>
            )}
            {compact && (
              <>
                <DM.Item className={cx(item, 'text-fg')} onSelect={() => openHelp()}>
                  <CircleHelp className="text-fg-muted" /> {t('Hilfe / Handbuch')}
                </DM.Item>
                <DM.Item className={cx(item, 'text-fg')} onSelect={onSettings}>
                  <Settings className="text-fg-muted" /> {t('Einstellungen')}
                </DM.Item>
              </>
            )}
            <DM.Item className={cx(item, 'text-fg')} onSelect={() => openSettings('account')}>
              <UserRoundCog className="text-fg-muted" /> {glueEllipsis(t('Mein Konto …'))}
            </DM.Item>
            <DM.Separator className="my-1 h-px bg-line" />
            <DM.Item className={cx(item, 'text-danger')} onSelect={onSignOut}>
              <LogOut /> {t('Abmelden')}
            </DM.Item>
          </DropdownContent>
        </DM.Portal>
      </DM.Root>
    </>
  );
}

function EmptyState({ onSearch }: { onSearch: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-fg-muted">
      <Logo />
      <p className="text-sm">{t('Wähle links eine Notiz oder suche danach.')}</p>
      <Button size="sm" onClick={onSearch}>
        {t('Suchen')} <kbd className="ml-1 rounded border border-line px-1 text-[0.625rem]">{t('Strg K')}</kbd>
      </Button>
      <Button size="sm" variant="ghost" onClick={() => usePrefs.getState().set({ hideWelcome: false })}>
        {t('Willkommensseite anzeigen')}
      </Button>
    </div>
  );
}

/** Sidebar sections above the sources (Personal.tsx, AiRules.tsx). */
const SECTIONS = ['favorites', 'recent', 'ai-rules'];

/** Opens Favoriten/Zuletzt/KI-Freigaben and every folder of every source. */
function expandEverything(qc: QueryClient, mounts: Mount[]) {
  const prefs = usePrefs.getState();
  prefs.set({ collapsedSections: prefs.collapsedSections.filter((id) => !SECTIONS.includes(id)) });
  for (const m of mounts) expandAllIn(m.id, qc.getQueryData<Entry[]>(['tree', m.id]) ?? []);
}

/** Closes Favoriten/Zuletzt/KI-Freigaben and every source. */
function collapseEverything() {
  const prefs = usePrefs.getState();
  prefs.set({ collapsedSections: [...new Set([...prefs.collapsedSections, ...SECTIONS])] });
  useWorkspace.getState().collapseWhere(() => true);
}


