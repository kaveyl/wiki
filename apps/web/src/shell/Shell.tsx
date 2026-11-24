// Workspace layout: sidebar (search, mount trees) + tab bar + note view.
import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Settings, LogOut, Plus, X, ChevronDown, FileText, PanelLeftClose, PanelLeft, FilePlus, RefreshCw, Sun, Moon, Monitor, ListTree, Maximize2, ListFilter, LocateFixed, History, FolderPlus, Hash, Star, Columns2, Pin, PinOff, ChevronsUpDown, ChevronsDownUp, Sparkles, Trash2, Printer, FileDown, CircleHelp, Languages, UserRoundCog, ArrowUpCircle, ShieldAlert } from 'lucide-react';
import * as DM from '@radix-ui/react-dropdown-menu';
import { api, ApiError, type Entry, type Mount, type User } from '../api';
import { useServerEvents } from '../events';
import { Logo } from '../auth/AuthPages';
import { PRODUCT_SHORT } from '../logo';
import { MountWizard } from '../mounts/MountWizard';
import { nodeKey, restoreWorkspace, useWorkspace, type SavedWorkspace, type Tab } from '../store';
import { usePrefs, type SidebarView } from '../prefs';
import { Button, ConfirmHost, InputHost, ContextContent, ContextItem, ContextMenu, ContextTrigger, DropdownContent, IconButton, Modal, PartLoading, confirmDialog, cx, glueEllipsis, useMediaQuery, useTabs } from '../ui';
import { countUnsaved, discardUnsaved, useUnsaved } from '../unsaved';
import { ActionDialogs } from './actions';
import { PassphraseHost } from '../editor/Passphrase';
import { DrawingDialog } from '../editor/Drawing';
import { downloadExport, printNote } from '../editor/exporting';
import { isSealed } from '../editor/sealed';
import { SearchBox, type SearchHandle } from './Search';
import { CommandPalette, SearchPage, useSearchPage, type Command } from './Palette';
import { TagBrowser } from '../editor/Tags';
import { FavoriteChips, NewForYouSection, RecentSection } from './Personal';
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
import { SyncStatus, syncAllWithMessage } from './SyncStatus';
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
      // Signed out (or another account next): no pending write of these lists goes out any more (sec-g05).
      usePersonal.getState().stop();
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
      run: () => {
        toast({ kind: 'ok', title: t('Alle Quellen werden synchronisiert …') });
        void syncAllWithMessage().then(() => qc.invalidateQueries({ queryKey: ['mounts'] }));
      },
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

  // „Neue Notiz“ at the top of the sidebar: in the source of the open note (its folder), else the first writable source.
  const newNote = commands.find((c) => c.id === 'new-note');
  const view = prefs.sidebarView === 'ai' && !user.isAdmin ? 'tree' : prefs.sidebarView;
  const views: [SidebarView, string][] = [
    ['tree', t('Baum')],
    ['recent', t('Zuletzt')],
    ...(user.isAdmin ? [['ai', t('KI-Freigaben')] as [SidebarView, string]] : []),
  ];
  // „Im Baum anzeigen“ from anywhere (menu, palette, AI shares): the sidebar shows the tree again.
  const revealed = useWorkspace((s) => s.reveal?.nonce ?? 0);
  useEffect(() => {
    if (revealed && usePrefs.getState().sidebarView !== 'tree') usePrefs.getState().set({ sidebarView: 'tree' });
  }, [revealed]);
  const viewTabs = useTabs(
    views.map(([v]) => v),
    view,
    (v) => prefs.set({ sidebarView: v }),
  );

  return (
    <div className="flex h-full overflow-hidden bg-canvas md:p-2.5">
      {!collapsed && mobile && <div className="fixed inset-0 z-30 bg-[var(--scrim)]" aria-hidden="true" onClick={() => setCollapsed(true)} />}
      {!collapsed && (
        // One rounded card over the full height like the note beside it (owner comparison with Kaveyl Notes, 24.11.):
        // head and foot stay, only the tree scrolls – inside the card, so its corners never turn square.
        <aside
          className={cx(
            'flex shrink-0 flex-col overflow-hidden bg-bg shadow-sheet dark:bg-subtle',
            mobile ? 'fixed inset-y-0 left-0 z-40 w-[min(88vw,340px)] rounded-r-[24px] shadow-pop' : 'rounded-[24px]',
          )}
          style={mobile ? undefined : { width: sidebarWidth }}
          aria-label={t('Seitenleiste')}
        >
          <div className="flex shrink-0 flex-col gap-2.5 px-3 pb-2 pt-3">
          <div className="flex h-8 items-center gap-2 pl-0.5">
            <Logo className="h-[25px] w-[25px] shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[0.95rem] tracking-tight">
              <span className="font-semibold">{PRODUCT_SHORT}</span> <span className="font-normal text-fg-muted">Wiki</span>
            </span>
            {aiAvailable && (
              <IconButton label={t('KI fragen')} className="h-7 w-7 rounded-lg bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent" onClick={() => useAi.getState().openAsk({ kind: 'all' })}>
                <Sparkles className="h-4 w-4" />
              </IconButton>
            )}
            <IconButton label={t('Tags')} className="h-7 w-7 rounded-lg" onClick={() => searchPage.openTags()}>
              <Hash className="h-4 w-4" />
            </IconButton>
            {mobile && (
              <IconButton label={t('Seitenleiste ausblenden')} className="h-7 w-7 rounded-lg" onClick={() => setCollapsed(true)}>
                <PanelLeftClose className="h-4 w-4" />
              </IconButton>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {newNote && (
              <button
                type="button"
                className="flex h-[35px] w-full items-center justify-center gap-1.5 rounded-full bg-accent-cta text-sm font-semibold text-on-cta shadow-[0_6px_16px_-8px_var(--accent-cta)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                title={t('Neue Notiz in „{where}“', { where: newNote.hint ?? '' })}
                onClick={newNote.run}
              >
                <Plus className="h-4 w-4" /> {t('Neue Notiz')}
              </button>
            )}
            <SearchBox ref={search} mounts={mountList} onSearchPage={(q) => searchPage.open(q)} />
          </div>
          <FavoriteChips mounts={mountList} />
          {mountList.length > 0 && (
            <div {...viewTabs.list} aria-label={t('Ansicht der Seitenleiste')} className="flex rounded-xl bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] p-0.5">
              {views.map(([v, label]) => (
                <button
                  key={v}
                  {...viewTabs.tab(v)}
                  className={cx(
                    'h-[25px] min-w-0 flex-1 truncate rounded-[10px] px-1.5 text-[0.75rem] font-medium',
                    view === v ? 'bg-bg text-accent shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          </div>
          <div {...viewTabs.panel} className="min-h-0 flex-1 overflow-y-auto pb-2 pl-2 pr-0.5 [scrollbar-gutter:stable]">
            <NewForYouSection mounts={mountList} />
            {view === 'recent' && <RecentSection mounts={mountList} />}
            {view === 'ai' && <AiRulesSection mounts={mountList} />}
            <nav aria-label={t('Quellen')} tabIndex={-1} className={cx('outline-none', view !== 'tree' && 'hidden')} onKeyDown={(e) => treeClipboardKeys(e, qc)}>
              {mountList.length > 0 && (
                <div>
                  <div className="flex h-7 items-center gap-1 pl-2 pr-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-faint">
                    <span className="flex-1">{t('Quellen')}</span>
                    {/* One toggle like at every source: something open → close everything, else open everything. */}
                    <button
                      type="button"
                      className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.6875rem] font-medium normal-case tracking-normal text-fg-muted hover:bg-hover hover:text-fg"
                      onClick={() => (anyOpen ? collapseEverything() : expandEverything(qc, mountList))}
                    >
                      {anyOpen ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
                      {anyOpen ? t('Alles zuklappen') : t('Alles aufklappen')}
                    </button>
                  </div>
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
                </div>
              )}
              {mounts.data && mountList.length === 0 && (
                <div className="mx-1 mt-4 rounded-2xl border border-dashed border-line px-4 py-5 text-center text-sm text-fg-muted">
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
                <div role="alert" className="mx-1 mt-4 rounded-2xl border border-dashed border-line px-4 py-5 text-center text-sm text-fg-muted">
                  <p className="mb-1 text-fg">{t('Die Quellen konnten nicht geladen werden.')}</p>
                  <p className="mb-4 text-xs">{mounts.error instanceof ApiError ? mounts.error.message : t('Server nicht erreichbar')}</p>
                  <Button size="sm" disabled={mounts.isFetching} onClick={() => void mounts.refetch()}>
                    <RefreshCw className="h-3.5 w-3.5" /> {t('Erneut versuchen')}
                  </Button>
                </div>
              )}
            </nav>
          </div>
          <div className="shrink-0 border-t border-line px-2 pb-1.5 pt-1">
            {mountList.length > 0 && (
              <div className="flex h-8 items-center">
                {user.isAdmin ? (
                  <button className="flex h-full flex-1 items-center gap-2 rounded-lg px-2 text-[0.8125rem] text-fg-muted hover:bg-hover hover:text-fg" onClick={() => setWizard({ open: true, edit: null })}>
                    <Plus className="h-4 w-4" /> {t('Quelle einbinden')}
                  </button>
                ) : (
                  <span className="flex-1" />
                )}
                <IconButton label={t('Papierkorb')} className="h-7 w-7 rounded-lg" onClick={openTrash}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            )}
            <div className="flex h-8 items-center gap-0.5">
              <span className="min-w-0 flex-1">
                <SyncStatus isAdmin={user.isAdmin} labelled />
              </span>
              <IconButton label={t('Einstellungen')} className="h-7 w-7 rounded-lg" onClick={() => setSettingsOpen(true)}>
                <Settings className="h-4 w-4" />
              </IconButton>
              <ThemeToggle className="h-7 w-7 rounded-lg" />
              {!mobile && (
                <IconButton label={t('Seitenleiste ausblenden')} className="h-7 w-7 rounded-lg" onClick={() => setCollapsed(true)}>
                  <PanelLeftClose className="h-4 w-4" />
                </IconButton>
              )}
            </div>
          </div>
        </aside>
      )}
      {!collapsed && !mobile && <Resizer />}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg md:rounded-[24px] md:pb-2.5 md:shadow-sheet">
        <TabBar
          tabs={tabs}
          activeId={activeId}
          collapsed={collapsed}
          onExpand={() => setCollapsed(false)}
          folderNote={(id) => mountById.get(id)?.options.folderNote}
          appButtons={<AppButtons user={user} compact={mobile} withSettings={collapsed} onSettings={() => setSettingsOpen(true)} onSignOut={() => void signOut()} />}
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
      <Modal open={searchPage.tagsOpen} onOpenChange={(o) => searchPage.openTags(o)} title={t('Tags verwalten')} wide="lg">
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
          bare
          help={settingsHelp ?? undefined}
          wide={settingsWide ? 'full' : 'lg'}
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
    // By the distance moved, not the pointer position: the sidebar does not start at the window's edge (frame).
    const from = e.clientX;
    const was = width;
    const move = (ev: globalThis.PointerEvent) => setWidth(was + ev.clientX - from);
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
  // A 12 px gutter between sidebar and sheet with a small pill in the middle; the strip is wide enough for a finger.
  return (
    <div
      className="group relative z-10 flex w-3 shrink-0 cursor-col-resize touch-none items-center justify-center focus-visible:outline-none"
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
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" aria-hidden="true" />
      <span className="h-11 w-1.5 rounded-full bg-[var(--scrollbar)] transition-colors group-hover:bg-accent group-active:bg-accent group-focus-visible:bg-accent" aria-hidden="true" />
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
  // Many tabs first get narrower (down to a minimum), then scroll sideways without a visible scroll bar (it
  // took the room of the tab text – owner 15.11.): the mouse wheel scrolls sideways, the edge where more follow
  // fades, the active tab stays in view, and „All tabs“ lists every open tab.
  const bar = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const barRef = useCallback((el: HTMLDivElement | null) => {
    bar.current = el;
    if (!el) return;
    const stopHint = scrollHint(el);
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(check);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stopHint?.();
      ro?.disconnect();
      mo?.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, []);
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>(':scope > [data-active-tab]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);
  return (
    <div className="flex h-[42px] shrink-0 items-end bg-bg pl-1.5 md:bg-subtle" data-print="hide">
      <div ref={barRef} className="scroll-hint no-scrollbar flex min-w-0 flex-1 items-end gap-0.5 self-stretch overflow-x-auto">
      {collapsed && (
        <IconButton label={t('Seitenleiste einblenden')} className="mb-2 mr-1 h-7 w-7 rounded-lg" onClick={onExpand}>
          <PanelLeft className="h-4 w-4" />
        </IconButton>
      )}
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextTrigger asChild>
            <div
              className={cx(
                'group flex h-[34px] shrink cursor-default items-center gap-1.5 rounded-t-[10px] px-3 text-[0.8125rem]',
                tab.pinned ? 'max-w-[160px]' : 'max-w-[220px]',
                // Narrowest: still a few letters of the name next to icon and close button (Dev check 16.11.).
                tab.id === activeId ? 'min-w-44' : 'min-w-32',
                tab.id === activeId ? 'bg-bg font-medium text-fg md:bg-bg' : tab.id === splitId ? 'bg-bg text-fg-muted' : 'text-fg-muted hover:bg-hover hover:text-fg',
              )}
              onClick={() => activate(tab.id)}
              onAuxClick={(e) => e.button === 1 && !tab.pinned && closeTab(tab.id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              title={tab.id === splitId ? t('{path} (rechts)', { path: tab.path }) : tab.pinned ? t('{path} (angeheftet)', { path: tab.path }) : tab.path}
              data-tab={tab.path}
              data-active-tab={tab.id === activeId ? '' : undefined}
              data-pinned={tab.pinned ? '' : undefined}
            >
              {tab.id === activeId ? (
                <span className="mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
              ) : tab.id === splitId ? (
                <Columns2 className="h-3.5 w-3.5 shrink-0 text-icon-faint" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 text-icon-faint" />
              )}
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
      {overflow && <AllTabs tabs={tabs} activeId={activeId} folderNote={folderNote} />}
      {/* Always visible, also with the sidebar closed and on phones: help and account; settings and the colour scheme
          here only while the sidebar (whose foot holds them) is closed. */}
      <div className="flex shrink-0 items-center gap-1 self-stretch px-2">
        {appButtons}
        {collapsed && <ThemeToggle className="h-7 w-7 rounded-lg" />}
      </div>
    </div>
  );
}

/** „All tabs (n)“: shown when the tabs do not fit; jump to any open tab or close it without hunting in the bar. */
function AllTabs({ tabs, activeId, folderNote }: { tabs: Tab[]; activeId: string | null; folderNote: (mountId: string) => string | undefined }) {
  const { activate, closeTab } = useWorkspace.getState();
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>
        <button
          className="mb-0.5 ml-0.5 flex h-7 shrink-0 items-center gap-0.5 self-end rounded px-1.5 text-[0.75rem] text-fg-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover"
          aria-label={t('Alle Tabs ({n})', { n: tabs.length })}
          title={t('Alle Tabs ({n})', { n: tabs.length })}
        >
          {tabs.length}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DropdownContent align="end" sideOffset={4} minWidth={240} className="max-h-[70vh] max-w-[min(26rem,calc(100vw-1rem))] overflow-y-auto">
          {tabs.map((tab) => (
            <DM.Item
              key={tab.id}
              className="group flex cursor-default select-none items-center gap-2 rounded-md py-1 pl-2 pr-1 outline-none data-[highlighted]:bg-hover"
              onSelect={() => activate(tab.id)}
              title={tab.path}
              data-all-tabs-item={tab.path}
            >
              <FileText className={cx('h-4 w-4 shrink-0', tab.id === activeId ? 'text-accent' : 'text-fg-faint')} />
              <span className={cx('min-w-0 flex-1 truncate', tab.id === activeId && 'font-medium')}>{noteName(tab.path, folderNote(tab.mountId))}</span>
              {tab.pinned ? (
                <Pin className="mx-1.5 h-3 w-3 shrink-0 text-fg-faint" aria-label={t('Angeheftet')} />
              ) : (
                <button
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
                  onClick={(e) => {
                    // Close only this tab – the list stays open for the next one.
                    e.stopPropagation();
                    e.preventDefault();
                    closeTab(tab.id);
                  }}
                  aria-label={t('Tab schließen')}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </DM.Item>
          ))}
        </DropdownContent>
      </DM.Portal>
    </DM.Root>
  );
}

/**
 * Help, settings and the account menu at the top right (owner 21.10.: the sidebar header was full). `compact` (phones):
 * only the account menu, with help and settings in it – the tabs keep their room.
 */
function AppButtons({ user, compact, withSettings, onSettings, onSignOut }: { user: User; compact: boolean; withSettings: boolean; onSettings: () => void; onSignOut: () => void }) {
  const item = 'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover [&>svg]:h-4 [&>svg]:w-4';
  const update = useUpdateMenuEntry(compact && user.isAdmin);
  return (
    <>
      {!compact && (
        <>
          <UpdateBadge isAdmin={user.isAdmin} />
          <IconButton label={t('Hilfe (F1)')} className="h-7 w-7 rounded-lg" onClick={() => openHelp()}>
            <CircleHelp className="h-4 w-4" />
          </IconButton>
          {/* With the sidebar open, settings sit in its foot. */}
          {withSettings && (
            <IconButton label={t('Einstellungen')} className="h-7 w-7 rounded-lg" onClick={onSettings}>
              <Settings className="h-4 w-4" />
            </IconButton>
          )}
        </>
      )}
      <DM.Root modal={false}>
        <DM.Trigger asChild>
          <button
            type="button"
            aria-label={t('Konto ({name})', { name: user.displayName })}
            title={t('Konto ({name})', { name: user.displayName })}
            className={cx('flex h-7 items-center gap-1.5 rounded-full text-[0.8125rem] font-medium text-fg hover:bg-hover data-[state=open]:bg-hover', compact ? 'w-7 justify-center' : 'border border-line-soft bg-bg py-0.5 pl-0.5 pr-2.5')}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[0.6875rem] font-semibold uppercase text-accent" aria-hidden>
              {initial(user.displayName)}
            </span>
            {!compact && <span className="max-w-[9rem] truncate">{user.displayName}</span>}
          </button>
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

/** First letter of a name for the account chip (a person's initial, not a picture). */
const initial = (name: string) => [...name.trim()][0] ?? '?';

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


