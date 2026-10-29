// A note in a tab: WYSIWYG editor (TipTap) or Markdown source (CodeMirror), autosave with
// optimistic concurrency (baseHash), live reload on external changes and a conflict banner.
// SEE-DOC: docs/PLAN.md §2.8, §2.9
import { Suspense, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import { Placeholder } from '@tiptap/extensions';
import Image from '@tiptap/extension-image';
import { codeBlockWithPreview, MathBlockView_, MathInlineView_, taskCheckboxLabel } from './Rich';
import { diffLines, diffText, editorExtensions, loadMarkdown, merge3, parseTags, saveMarkdown, splitFrontmatter, type PMNode } from '@kaveyl-wiki/core';
import { Lock, LockOpen, FileCode2, PenLine, AlertTriangle, MoreHorizontal, LocateFixed, Pencil, Trash2, Check, CloudUpload, ListTree, Maximize2, Minimize2, History, Star, X, LayoutTemplate, Users, ShieldCheck, Send, Sparkles, Printer, FileDown, ChevronRight, Download } from 'lucide-react';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { usePersonal } from '../personal';
import { EntryIcon } from '../shell/Tree';
import { IconPicker } from './IconPicker';
import { api, ApiError, errorText, type Mount, type NoteDocument } from '../api';
import { useMarkRead } from '../shell/Watch';
import { captureCaret, restoreCaret, type Caret } from './caret';
import { onNoteEvent, onPresence, type PresenceUser } from '../events';
import { takeNote } from '../notePrefetch';
import { useWorkspace } from '../store';
import { useActions } from '../shell/actions';
import { Button, DropdownContent, DropdownSubContent, Modal, PartLoading, PopoverContent, Spinner, confirmDialog, cx, keepSubOpen, promptDialog } from '../ui';
import { DiffView } from '../shell/history';
import { SaveAsDialog, splitPath } from '../shell/SaveAs';
import { externalUrl, isExternal, isScriptUrl, noteCandidates, resolveHref } from '@kaveyl-wiki/core';
import { LinkMenu, type LinkMenuAt } from './LinkMenu';
import { Backlinks } from './Backlinks';
import { AttachmentList, chooseFiles, openFile, uploadFiles } from './Attachments';
import { attachHandlers, SlashCommand } from './SlashMenu';
import { drawingContexts, drawingVersions, isDrawingSrc, openDrawing } from './Drawing';
import { downloadExport, printNote } from './exporting';
import { NoteLink, noteHref } from './NoteLink';
import { BrokenLinks, localHrefs, setBrokenLinks } from './BrokenLinks';
import { TagBar } from './Tags';
import { LinkPreview } from './LinkPreview';
import { EmojiSuggestion } from './Emoji';
import { EditorToolbar, hideSelectionMenu, ImageMenu, SelectionMenu } from './Toolbar';
import { Toc, useHeadings } from './Toc';
import { editorMaxWidth, usePrefs } from '../prefs';
import { toast } from '../toast';
import { MARKDOWN_MIME } from '../clipboard';
import { lowlight } from './highlight';
import { saveFailure, type SaveFailure } from './saveError';
import { WorkspaceUser, mayWriteAs, setUnsaved, useUnsaved } from '../unsaved';
import { decryptNote, decryptedFileUrl, EncryptedBadge, EncryptedGate, encryptIntoFolder, encryptNote } from './Encryption';
import { encryptedFolderOf, isEncrypted, keepAlive, lockAll, trackSave } from './crypto';
import { openLightbox } from './images';
import { AiMenuButton, runAiAction } from '../ai/AiAssist';
import { useAi, useAiAvailable } from '../ai/aiStore';
import { takeFocusRequest } from './focusRequest';
import { noteName, noteNameIn } from '../names';
import { t, tn } from '../i18n';
import { lazyPart } from '../lazyPart';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

// Markdown source view (CodeMirror): loaded only when it is opened (seo-002).
const SourceEditor = lazyPart(() => import('./SourceEditor').then((m) => m.SourceEditor));

// Highlighting is a view-only decoration: same `codeBlock` schema as on the server.
const highlightedCodeBlock = codeBlockWithPreview({ lowlight, defaultLanguage: null });
interface Snapshot {
  doc?: PMNode;
  raw?: string;
  key: string;
}
interface Conflict {
  kind: 'save' | 'external' | 'deleted';
  currentHash?: string | null;
}

export function NoteView({
  mount,
  path,
  isActive,
  onCloseSplit,
  onCloseTab,
  onSearch,
}: {
  mount: Mount;
  path: string;
  isActive: boolean;
  onCloseSplit?: () => void;
  onCloseTab?: () => void;
  onSearch?: () => void;
}) {
  const note = useQuery({
    queryKey: ['note', mount.id, path],
    // Asked for by the shell while this code still loaded, if so (seo-001).
    queryFn: () => takeNote(mount.id, path),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const [mode, setMode] = useState<'rich' | 'source'>('rich');
  const [version, setVersion] = useState(0);
  // „Trotzdem bearbeiten“ holds for this view, also across reloads, until nobody else has edited for a minute
  // (`quietSince`: since when; a reload elsewhere drops the other person only for a moment).
  const editAnyway = useRef(false);
  const quietSince = useRef(0);
  // Cursor and scroll position across a reload that someone else's change caused.
  const caret = useRef<Caret | null>(null);
  // Last own keystroke: one still counts as „bearbeitet gerade“ when the editor reloads for someone else's change.
  const lastEdit = useRef(0);
  const qc = useQueryClient();
  const retitle = useWorkspace((s) => s.retitle);
  const encFolders = useQuery({ queryKey: ['encrypted', mount.id], queryFn: () => api.encryptedFolders(mount.id), staleTime: 30_000 });

  useEffect(() => {
    if (note.data) retitle(mount.id, path, note.data.title);
  }, [note.data, mount.id, path, retitle]);
  // „Beobachten“: an opened note is read – its dot goes.
  useMarkRead(mount.id, path, isActive && !!note.data);
  // "Zuletzt geöffnet": the active tab's note, only once it has loaded – a missing note or an error is not "opened" (design-008).
  // The right half of a split view is not the active tab.
  const personalLoaded = usePersonal((s) => s.loaded);
  const loadedTitle = note.data?.title;
  const visits = isActive && !onCloseSplit;
  useEffect(() => {
    if (loadedTitle !== undefined && visits && personalLoaded) usePersonal.getState().visit({ mountId: mount.id, path, title: loadedTitle });
  }, [loadedTitle, visits, personalLoaded, mount.id, path]);

  const reload = useCallback(async () => {
    const before = qc.getQueryData<NoteDocument>(['note', mount.id, path])?.hash;
    await qc.invalidateQueries({ queryKey: ['note', mount.id, path] });
    await qc.refetchQueries({ queryKey: ['note', mount.id, path] });
    // New content already builds a new editor (its hash is in the key); only an unchanged file needs the new version –
    // building it twice would lose a keystroke typed in between (team test 23.10.).
    if (qc.getQueryData<NoteDocument>(['note', mount.id, path])?.hash === before) setVersion((v) => v + 1);
  }, [qc, mount.id, path]);

  if (note.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <Spinner />
      </div>
    );
  }
  if (note.isError) {
    const e = note.error;
    // Not found also stands for "no access" (AD-020): offer search and trash; any other failure may pass – try again.
    const missing = e instanceof ApiError && e.status === 404;
    return (
      <div className="mx-auto max-w-xl p-10 text-center">
        <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-warn" />
        <p className="font-medium">{missing ? t('Diese Notiz existiert nicht (mehr).') : t('Notiz konnte nicht geladen werden.')}</p>
        <p className="mt-1 text-sm text-fg-muted">{e instanceof ApiError && !missing ? e.message : path}</p>
        {missing && <p className="mt-2 text-sm text-fg-muted">{t('Vielleicht wurde sie verschoben oder gelöscht.')}</p>}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {missing ? (
            <>
              {onSearch && (
                <Button size="sm" variant="primary" onClick={onSearch}>
                  {t('Suchen')}
                </Button>
              )}
              <Button size="sm" onClick={() => useActions.getState().open({ kind: 'trash', mountId: mount.id })}>
                {t('Papierkorb')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={note.isFetching} onClick={() => void note.refetch()}>
              {t('Erneut versuchen')}
            </Button>
          )}
          {onCloseTab && (
            <Button size="sm" variant="ghost" onClick={onCloseTab}>
              {t('Tab schließen')}
            </Button>
          )}
        </div>
      </div>
    );
  }
  // No document from the server: too large or too nested for its parser (sec-006) – only the Markdown source, never an
  // empty rich editor (its save would empty the note).
  const loaded = (n: NoteDocument, seal?: (plainRaw: string) => Promise<string>) => (
    <Loaded
      key={`${version}:${mode}:${n.hash}`}
      mount={mount}
      note={n}
      mode={n.doc ? mode : 'source'}
      isActive={isActive}
      onCloseSplit={onCloseSplit}
      seal={seal}
      encryptedFolder={encryptedFolderOf(encFolders.data ?? [], path)}
      editAnyway={editAnyway}
      quietSince={quietSince}
      caret={caret}
      lastEdit={lastEdit}
      onMode={async (m) => {
        await reload();
        setMode(m);
      }}
      onReload={reload}
    />
  );
  // Encrypted (PLAN §3d): unlock first; the editor then works on the plaintext and saves sealed.
  if (isEncrypted(note.data.frontmatter)) {
    return (
      <EncryptedGate note={note.data} scope={encryptedFolderOf(encFolders.data ?? [], path) ?? path} onLocked={() => void reload()}>
        {(plain, seal) => loaded(plain, seal)}
      </EncryptedGate>
    );
  }
  return loaded(note.data);
}

function Loaded({
  mount,
  note,
  mode,
  isActive,
  onMode,
  onReload,
  onCloseSplit,
  seal,
  encryptedFolder,
  editAnyway,
  quietSince,
  caret,
  lastEdit,
}: {
  mount: Mount;
  note: NoteDocument;
  mode: 'rich' | 'source';
  isActive: boolean;
  onCloseSplit?: () => void;
  onMode: (m: 'rich' | 'source') => Promise<void>;
  onReload: () => Promise<void>;
  /** Encrypted note: `note` holds the plaintext, this turns plain file text into the sealed file. */
  seal?: (plainRaw: string) => Promise<string>;
  /** The encrypted folder the note lies in, if any. */
  encryptedFolder: string | null;
  /** Answered „Trotzdem bearbeiten“ while someone else is editing (soft lock). */
  editAnyway: React.MutableRefObject<boolean>;
  quietSince: React.MutableRefObject<number>;
  caret: React.MutableRefObject<Caret | null>;
  lastEdit: React.MutableRefObject<number>;
}) {
  const inEncryptedFolder = encryptedFolder !== null;
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [fmReadonly, setFmReadonly] = useState(note.frontmatter?.readonly === true);
  const [icon, setIcon] = useState<string | null>(typeof note.frontmatter?.icon === 'string' ? note.frontmatter.icon : null);
  // Only read access (AD-020) works like a read-only source: no unlocking.
  const readonly = (fmReadonly && !unlocked) || mount.options.readonly || note.access === 'read';
  // `savedKey` is the serialized content of the last saved (or loaded) state; "dirty" means the
  // editor content differs from it. Comparing content (not counting update events) keeps
  // editor-internal normalizations on load from looking like user edits.
  const s = useRef({
    hash: note.hash,
    savedKey: null as string | null,
    dirty: false,
    saving: false,
    failures: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    /** Something was saved since the last "leave" — only then is a commit worth triggering. */
    savedSinceLeave: false,
    /** Closed after its changes were discarded (signing out, another account): nothing more is sent. */
    dropped: false,
    /** Own writes (save, tags) in flight, and the newest change announced meanwhile – maybe our own. */
    writing: 0,
    heard: null as string | null,
  });
  const snapshot = useRef<() => Snapshot | null>(() => null);
  // The file as last loaded or saved here: the common start for „Zusammenführen“ (plain notes only).
  const baseRaw = useRef<string | null>(seal ? null : note.raw);
  // Encrypted notes are spliced in the browser (the server never sees the plaintext).
  const plainSource = useRef(seal ? loadMarkdown(note.raw).source : null);
  // Encrypted: a tag/icon write until the browser's frontmatter has taken it over – a save waits for it (else it undoes it).
  const metaDone = useRef<Promise<void>>(Promise.resolve());
  const qc = useQueryClient();
  const conflictRef = useRef<Conflict | null>(null);
  conflictRef.current = conflict;
  // The account this editor was opened with: its changes are saved only under that account's session (code-012).
  const owner = useContext(WorkspaceUser);
  const asUser = owner ?? undefined;
  const mayWrite = useCallback(
    () =>
      mayWriteAs(
        owner,
        qc.getQueryData<Awaited<ReturnType<typeof api.session>>>(['session'])?.user?.id ?? null,
        async () => (await qc.fetchQuery({ queryKey: ['session'], queryFn: api.session, staleTime: 0 })).user?.id ?? null,
      ),
    [owner, qc],
  );

  // Someone else changed the note (another person, the API, MCP, VS Code, git pull): take it over when
  // nothing of one's own is waiting, otherwise the conflict banner decides.
  const foreign = useCallback(
    (hash: string) => {
      const st = s.current;
      if (hash === st.hash) return;
      if (st.writing) {
        st.heard = hash;
        return;
      }
      if (st.dirty) {
        caretAtConflict.current = captureCaret(rootRef.current);
        return setConflict({ kind: 'external', currentHash: hash });
      }
      // Taken over in place: whoever reads or has the cursor in the note keeps their spot.
      caret.current = captureCaret(rootRef.current);
      void onReload();
    },
    [onReload, caret],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  // Where the cursor was when the conflict notice came: „Zusammenführen“ puts it back there.
  const caretAtConflict = useRef<Caret | null>(null);
  useLayoutEffect(() => {
    const c = caret.current;
    if (!c) return;
    let tries = 0;
    let frame = 0;
    // The person clicks or types before it is restored: theirs wins, the old spot is dropped.
    const root = rootRef.current;
    const mine = () => {
      cancelAnimationFrame(frame);
      if (caret.current === c) caret.current = null;
    };
    root?.addEventListener('pointerdown', mine, { capture: true, once: true });
    root?.addEventListener('keydown', mine, { capture: true, once: true });
    const unhook = () => {
      root?.removeEventListener('pointerdown', mine, { capture: true });
      root?.removeEventListener('keydown', mine, { capture: true });
    };
    // At once when the editor is already there (no frame without focus), else on the next frames.
    if (restoreCaret(rootRef.current, c)) {
      unhook();
      caret.current = null;
      return;
    }
    // Not there yet: try on the next frames (the editor builds its content a moment later).
    const step = () => {
      if (caret.current !== c) return unhook();
      if (restoreCaret(rootRef.current, c) || ++tries > 30) {
        unhook();
        caret.current = null;
      } else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      unhook();
    };
  }, [caret]);
  /** After an own write: an announcement heard meanwhile that is not this write's hash came from someone else. */
  const settle = useCallback(() => {
    const st = s.current;
    if (st.writing || st.heard === null) return;
    const hash = st.heard;
    st.heard = null;
    if (!conflictRef.current) foreign(hash);
  }, [foreign]);

  const save = useCallback(
    async (opts: { force?: boolean } = {}) => {
      const st = s.current;
      clearTimeout(st.timer);
      if (st.saving || st.dropped) return;
      const snap = snapshot.current();
      if (!snap || (snap.key === st.savedKey && !opts.force)) return;
      st.saving = true;
      st.writing++;
      setSaveState('saving');
      try {
        // Checked before sending (also when retrying or closing); the server checks the account named, too.
        const may = await mayWrite();
        if (may === 'signedOut') throw new ApiError(401, '', {});
        if (may === 'other') throw new ApiError(403, '', { code: 'other-user' });
        let res: { hash: string; changed: boolean };
        if (seal) {
          // Tracked: locking waits for it before reloading the note (else the reload shows the old text).
          res = await trackSave(
            (async () => {
              await metaDone.current;
              const plainRaw = snap.raw ?? saveMarkdown(plainSource.current!, snap.doc!);
              const r = await api.saveRaw(mount.id, note.path, await seal(plainRaw), st.hash, { asUser });
              plainSource.current = loadMarkdown(plainRaw).source;
              return r;
            })(),
          );
        } else {
          res =
            snap.raw !== undefined
              ? await api.saveRaw(mount.id, note.path, snap.raw, st.hash, { asUser })
              : await api.saveDoc(mount.id, note.path, snap.doc!, st.hash, asUser);
        }
        st.hash = res.hash;
        st.savedKey = snap.key;
        if (baseRaw.current !== null) baseRaw.current = snap.raw ?? saveMarkdown(loadMarkdown(baseRaw.current).source, snap.doc!);
        if (res.changed) {
          st.savedSinceLeave = true;
          void qc.invalidateQueries({ queryKey: ['attachments', mount.id, note.path] });
        }
        st.failures = 0;
        st.dirty = snapshot.current()?.key !== st.savedKey;
        setSaveState(st.dirty ? 'dirty' : 'saved');
        setConflict(null);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          caretAtConflict.current = captureCaret(rootRef.current);
          setConflict({ kind: 'save', currentHash: (e.body.currentHash as string | null) ?? null });
          setSaveState('dirty');
        } else {
          const f = saveFailure(e);
          // Gone: the banner offers the way out (save as new note); retrying cannot help.
          if (f.kind === 'gone') setConflict((conflictRef.current = { kind: 'deleted' }));
          // Signed out or another account: the app shows whose session it is now (the known one may be out of date) –
          // not only once the live connection reports the end of the session; it may be silent.
          if (f.kind === 'otherUser' || f.kind === 'signedOut') void qc.invalidateQueries({ queryKey: ['session'] });
          setFailure(f);
          setSaveState('error');
          st.failures++;
        }
      } finally {
        st.saving = false;
        st.writing--;
        settle();
        // Retry pending edits; after failures back off (2s, 4s … max 60s) instead of hammering the server.
        const delay = st.failures ? Math.min(60_000, 1000 * 2 ** st.failures) : 700;
        if (st.dirty && !conflictRef.current && !st.dropped) st.timer = setTimeout(() => void save(), delay);
      }
    },
    [mount.id, note.path, qc, seal, mayWrite, asUser, settle],
  );

  const crypt = async (action: 'encrypt' | 'decrypt') => {
    await save();
    try {
      if (await (action === 'encrypt' ? encryptNote(mount.id, note.path) : decryptNote(mount.id, note.path))) {
        toast({ kind: 'ok', title: action === 'encrypt' ? t('Notiz verschlüsselt') : t('Verschlüsselung entfernt') });
        void qc.invalidateQueries({ queryKey: ['attachments', mount.id, note.path] });
        await onReload();
      }
    } catch (e) {
      toast({ kind: 'error', title: action === 'encrypt' ? t('Nicht verschlüsselt') : t('Nicht entschlüsselt'), text: errorText(e) });
    }
  };

  // A plain note in an encrypted folder (interrupted „Ordner verschlüsseln“, copied in from outside): the server
  // refuses to save it in plain text – encrypt it with the folder's passphrase, including unsaved edits.
  const sealIntoFolder = async () => {
    try {
      const snap = snapshot.current();
      const content = snap?.raw ?? (snap?.doc ? saveMarkdown(loadMarkdown(note.raw).source, snap.doc) : undefined);
      if (await encryptIntoFolder(mount.id, encryptedFolder!, note.path, content)) {
        s.current.dirty = false;
        toast({ kind: 'ok', title: t('Notiz verschlüsselt') });
        await onReload();
      }
    } catch (e) {
      toast({ kind: 'error', title: t('Nicht verschlüsselt'), text: errorText(e) });
    }
  };

  const presence = usePresence(mount, note.path, isActive, lastEdit);
  // Soft lock: the first change while someone else is editing asks once; nothing is saved or announced before the answer.
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  const othersEditing = presence.some((u) => u.editing);
  useEffect(() => {
    if (!othersEditing) quietSince.current ||= Date.now();
    else {
      if (quietSince.current && Date.now() - quietSince.current > 60_000) editAnyway.current = false;
      quietSince.current = 0;
    }
  }, [othersEditing, editAnyway, quietSince]);
  const asking = useRef(false);
  const changed = useCallback(() => {
    const st = s.current;
    const snap = snapshot.current();
    if (!snap || st.dropped) return;
    // Typing in an encrypted note keeps it unlocked (auto-lock counts minutes without use).
    if (seal) keepAlive();
    if (st.savedKey === null) st.savedKey = snap.key;
    const dirty = snap.key !== st.savedKey;
    const editors = presenceRef.current.filter((u) => u.editing);
    if (dirty && !st.dirty && !editAnyway.current && editors.length) {
      clearTimeout(st.timer);
      if (asking.current) return;
      asking.current = true;
      const names = editors.map((u) => u.name).join(', ');
      void confirmDialog(
        tn(
          editors.length,
          '{names} bearbeitet diese Notiz gerade. Wenn ihr beide ändert, bekommt, wer später speichert, einen Hinweis: Änderungen an verschiedenen Stellen lassen sich zusammenführen. Habt ihr dieselbe Stelle geändert, muss eine der beiden Fassungen gewählt werden – was nur in der anderen steht, fehlt dann in der Notiz.',
          '{names} bearbeiten diese Notiz gerade. Wenn ihr gleichzeitig ändert, bekommt, wer später speichert, einen Hinweis: Änderungen an verschiedenen Stellen lassen sich zusammenführen. Habt ihr dieselbe Stelle geändert, muss eine der Fassungen gewählt werden – was nur in den anderen steht, fehlt dann in der Notiz.',
          { names },
        ),
        { confirmLabel: t('Trotzdem bearbeiten') },
      ).then((ok) => {
        asking.current = false;
        if (ok) {
          editAnyway.current = true;
          changedRef.current();
          return;
        }
        // Cancelled: the typed change is dropped, the note shows the saved text again.
        st.dropped = true;
        clearTimeout(st.timer);
        void onReload();
      });
      return;
    }
    st.dirty = dirty;
    if (st.dirty) {
      // First keystroke after a pause: tell the others right away ("bearbeitet gerade").
      const pause = Date.now() - lastEdit.current > 25_000;
      lastEdit.current = Date.now();
      if (pause) window.dispatchEvent(new Event(`kaveyl-wiki-edit:${mount.id}:${note.path}`));
    }
    clearTimeout(st.timer);
    if (!st.dirty) {
      if (!st.saving && !conflictRef.current) setSaveState('saved');
      return;
    }
    if (!st.failures) setSaveState('dirty');
    if (!conflictRef.current) st.timer = setTimeout(() => void save(), st.failures ? Math.min(60_000, 1000 * 2 ** st.failures) : 700);
  }, [save, seal, mount.id, note.path, editAnyway, onReload, lastEdit]);
  const changedRef = useRef(changed);
  changedRef.current = changed;

  const bind = useCallback((fn: () => Snapshot | null) => {
    snapshot.current = fn;
    // Baseline = what the editor shows right after loading, including its normalizations.
    s.current.savedKey = fn()?.key ?? null;
  }, []);

  // Leaving the note (tab switch, close, browser tab hidden) or Ctrl+S: save, then commit
  // (+ push) right away instead of waiting for the pause timer. Saving itself stays instant.
  const leave = useCallback(async () => {
    await save();
    if (!s.current.savedSinceLeave || !mount.options.autoCommit || s.current.dropped) return;
    // Also the commit when closing: not under another account's session (code-012).
    if ((await mayWrite()) !== 'ok') return;
    s.current.savedSinceLeave = false;
    await api.commitNow(mount.id, asUser);
  }, [save, mount.id, mount.options.autoCommit, mayWrite, asUser]);
  useEffect(() => {
    if (!isActive) void leave();
  }, [isActive, leave]);
  useEffect(() => {
    if (!isActive) return;
    const onHide = () => document.visibilityState === 'hidden' && void leave();
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save({ force: s.current.dirty }).then(leave);
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('keydown', onKey);
    };
  }, [isActive, leave, save]);
  // Closed after a deliberate discard: send nothing more (runs before the closing save below – effects in order).
  useEffect(
    () => () => {
      if (!useUnsaved.getState().discarded) return;
      s.current.dropped = true;
      clearTimeout(s.current.timer);
    },
    [],
  );
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      // Discarded on purpose (signing out): no second question from the browser.
      if (s.current.dirty && !useUnsaved.getState().discarded) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      void leave();
    };
  }, [leave]);
  // Unsaved changes keep the workspace open when the session ends (code-012); „Jetzt speichern“ there saves through here.
  const editorId = useId();
  const saveNow = useRef(() => save({ force: s.current.dirty }));
  saveNow.current = () => save({ force: s.current.dirty });
  // Read only when the user copies the text out (another account signed in meanwhile).
  const textNow = useRef<() => string>(() => '');
  textNow.current = () => mineRaw();
  useEffect(() => {
    setUnsaved(editorId, saveState === 'saved' ? null : `${mount.id}:${note.path}`, () => saveNow.current(), () => textNow.current());
  }, [editorId, saveState, mount.id, note.path]);
  useEffect(() => () => setUnsaved(editorId, null), [editorId]);

  // External changes (VS Code, git pull, other tab).
  useEffect(
    () =>
      onNoteEvent((e) => {
        if (e.mountId !== mount.id || e.path !== note.path) return;
        if (e.hash === null) return setConflict({ kind: 'deleted' });
        foreign(e.hash);
      }),
    [mount.id, note.path, foreign],
  );

  // Tags (and later icons) live in the frontmatter: written by a separate call that keeps the
  // editor's base hash in step, so the next autosave does not see its own change as a conflict.
  const [tags, setTags] = useState(() => parseTags(note.frontmatter?.tags));
  const saveMeta = async (changes: { tags?: string[]; icon?: string | null; readonly?: boolean }) => {
    await save();
    s.current.writing++;
    let done = () => {};
    metaDone.current = new Promise((resolve) => (done = resolve));
    try {
      const res = await api.saveMeta(mount.id, note.path, changes, s.current.hash);
      s.current.hash = res.hash;
      if (res.changed) s.current.savedSinceLeave = true;
      // The frontmatter changed on the server: the start for merging is that file.
      if (res.changed && baseRaw.current !== null) {
        const fresh = await api.note(mount.id, note.path);
        baseRaw.current = fresh.hash === res.hash ? fresh.raw : null;
      }
      // Encrypted: the next save writes the frontmatter from the browser's copy – take over the server's change.
      if (seal && res.changed && plainSource.current) {
        const fresh = await api.note(mount.id, note.path);
        if (fresh.hash === res.hash) plainSource.current = { ...plainSource.current, frontmatter: splitFrontmatter(fresh.raw).frontmatter };
      }
      if (changes.tags) setTags(changes.tags);
      if (changes.icon !== undefined) setIcon(changes.icon);
      if (changes.readonly !== undefined) {
        setFmReadonly(changes.readonly);
        setUnlocked(false);
      }
      void qc.invalidateQueries({ queryKey: ['tags'] });
      void qc.invalidateQueries({ queryKey: ['tree', mount.id] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict({ kind: 'external', currentHash: (e.body.currentHash as string | null) ?? null });
      else toast({ kind: 'error', title: t('Tags nicht gespeichert'), text: errorText(e) });
    } finally {
      done();
      s.current.writing--;
      settle();
    }
  };

  // Both changed the note: bring the changes together when they are at different places (merge3), save that on
  // top of the other version and show it – nothing of either side is lost. Same place: choose a version as before.
  const mergeBoth = async () => {
    const base = baseRaw.current;
    if (base === null) return;
    try {
      if ((await mayWrite()) !== 'ok') throw new ApiError(403, '', { code: 'other-user' });
      const theirs = await api.note(mount.id, note.path);
      const snap = snapshot.current();
      const mine = snap?.raw ?? (snap?.doc ? saveMarkdown(loadMarkdown(base).source, snap.doc) : base);
      const merged = merge3(base, mine, theirs.raw);
      if (merged === null) {
        toast({ kind: 'warn', title: t('Nicht zusammengeführt'), text: t('Ihr habt dieselbe Stelle geändert. Sieh dir die Unterschiede an und wähle eine Fassung.') });
        return;
      }
      const st = s.current;
      clearTimeout(st.timer);
      st.writing++;
      try {
        st.hash = (await api.saveRaw(mount.id, note.path, merged, theirs.hash, { asUser })).hash;
        st.savedSinceLeave = true;
      } finally {
        st.writing--;
      }
      // The editor is built anew with the merged text; this one sends nothing more.
      st.dropped = true;
      conflictRef.current = null;
      setConflict(null);
      const now = captureCaret(rootRef.current);
      caret.current = now?.focused ? now : (caretAtConflict.current ?? now);
      toast({ kind: 'ok', title: t('Zusammengeführt'), text: t('Deine Änderungen und die der anderen Seite sind beide in der Notiz.') });
      await onReload();
    } catch (e) {
      toast({ kind: 'error', title: t('Nicht zusammengeführt'), text: errorText(e) });
    }
  };

  const keepMine = async () => {
    const current = await api.note(mount.id, note.path);
    s.current.hash = current.hash;
    conflictRef.current = null;
    setConflict(null);
    await save({ force: true });
  };

  // Conflict banner: nothing of one's own is lost without asking – look at the differences first,
  // confirm before loading the other version, save one's own text as a new note when the file is gone.
  // Encrypted notes: not offered (the other version is sealed, a new note would hold plaintext).
  const plainNote = !seal && !inEncryptedFolder;
  const [diff, setDiff] = useState<string | null>(null);
  const [savingAs, setSavingAs] = useState(false);
  const openNote = useWorkspace((w) => w.openNote);
  const revealInTree = useWorkspace((w) => w.revealInTree);
  const mineRaw = () => {
    const snap = snapshot.current();
    return snap?.raw ?? (snap?.doc ? saveMarkdown(loadMarkdown(note.raw).source, snap.doc) : note.raw);
  };
  const showDiff = async () => {
    try {
      const theirs = await api.note(mount.id, note.path);
      setDiff(diffText(diffLines(theirs.raw, mineRaw())));
    } catch (e) {
      toast({ kind: 'error', title: t('Unterschiede nicht geladen'), text: errorText(e) });
    }
  };
  const loadTheirs = async () => {
    const ok = await confirmDialog(t('Deine ungespeicherten Änderungen an dieser Notiz gehen dabei verloren. Fremde Version trotzdem laden?'), {
      confirmLabel: t('Verwerfen und laden'),
      danger: true,
    });
    if (ok) await onReload();
  };

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <NoteHeader
        mount={mount}
        note={note}
        mode={mode}
        saveState={saveState}
        saveFailure={failure}
        readonly={readonly}
        lockable={fmReadonly && !mount.options.readonly && note.access !== 'read'}
        unlocked={unlocked}
        onToggleLock={() => setUnlocked((u) => !u)}
        icon={icon}
        onIcon={(i) => void saveMeta({ icon: i })}
        onToggleReadonly={() => void saveMeta({ readonly: !fmReadonly })}
        fmReadonly={fmReadonly}
        onCloseSplit={onCloseSplit}
        presence={presence}
        onMode={async (m) => {
          await save();
          await onMode(m);
        }}
        onSaveNow={() => void save({ force: s.current.dirty })}
        encrypted={!!seal}
        onCrypt={inEncryptedFolder ? undefined : (a) => void crypt(a)}
      />
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--warn)_12%,var(--bg))] px-4 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-warn" />
          <span className="flex-1">
            {conflict.kind === 'deleted'
              ? plainNote
                ? t('Diese Notiz wurde außerhalb gelöscht oder verschoben. Deine Fassung kannst du als neue Notiz sichern.')
                : t('Diese Notiz wurde außerhalb gelöscht oder verschoben.')
              : t('Die Notiz wurde außerhalb geändert, während du sie bearbeitet hast.')}
          </span>
          {conflict.kind === 'deleted' ? (
            plainNote && (
              <Button size="sm" variant="primary" onClick={() => setSavingAs(true)}>
                {t('Als neue Notiz speichern …')}
              </Button>
            )
          ) : (
            <>
              {plainNote && baseRaw.current !== null && (
                <Button size="sm" variant="primary" onClick={() => void mergeBoth()}>
                  {t('Zusammenführen')}
                </Button>
              )}
              {plainNote && (
                <Button size="sm" variant="ghost" onClick={() => void showDiff()}>
                  {t('Unterschiede ansehen')}
                </Button>
              )}
              <Button size="sm" onClick={() => void loadTheirs()}>
                {t('Fremde Version laden')}
              </Button>
              <Button size="sm" variant={plainNote && baseRaw.current !== null ? 'default' : 'primary'} onClick={() => void keepMine()}>
                {t('Meine Version speichern')}
              </Button>
            </>
          )}
        </div>
      )}
      {diff !== null && (
        <Modal help="konflikte-auflösen" open wide onOpenChange={(o) => !o && setDiff(null)} title={t('Unterschiede zur fremden Version')}>
          <div className="space-y-2 text-sm">
            <p className="text-xs text-fg-muted">{t('Rot mit „-“: steht nur in der fremden Version. Grün mit „+“: steht nur in deiner Fassung.')}</p>
            <DiffView text={diff} loading={false} empty={t('Beide Fassungen sind gleich.')} />
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setDiff(null)}>
                {t('Schließen')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {savingAs && (
        <SaveAsDialog
          help="konflikte-auflösen"
          kind="note"
          intro={t('Deine Fassung wird eine neue Notiz. Bilder und Anhänge, auf die sie verweist, kommen mit.')}
          start={{ mountId: mount.id, folder: splitPath(note.path, 'note').folder }}
          name={splitPath(note.path, 'note').name}
          onClose={() => setSavingAs(false)}
          onSave={async (target) => {
            const r = await api.saveNoteAs(mount.id, { from: note.path, raw: mineRaw(), to: target.path, toMountId: target.mountId });
            // Saved elsewhere: nothing left to save here (the file is gone).
            clearTimeout(s.current.timer);
            s.current.savedKey = snapshot.current()?.key ?? null;
            s.current.dirty = false;
            await qc.invalidateQueries({ queryKey: ['tree', r.mountId] });
            toast({ kind: r.warnings.length ? 'warn' : 'ok', title: t('Als neue Notiz gespeichert'), text: [r.path, ...r.warnings].join('\n') });
            setSavingAs(false);
            openNote(r.mountId, r.path, noteNameIn(r.mountId, r.path));
            revealInTree(r.mountId, r.path);
          }}
        />
      )}
      {inEncryptedFolder && !seal && !readonly && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--warn)_12%,var(--bg))] px-4 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-warn" />
          <span className="flex-1">{t('Diese Notiz liegt unverschlüsselt im verschlüsselten Ordner „{folder}“ und lässt sich so nicht speichern.', { folder: encryptedFolder ?? '' })}</span>
          <Button size="sm" variant="primary" onClick={() => void sealIntoFolder()}>
            {t('Jetzt verschlüsseln')}
          </Button>
        </div>
      )}
      {!note.doc && (
        <p className="flex items-start gap-2 border-b border-line bg-muted/40 px-4 py-1.5 text-xs text-fg-muted" role="note">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warn" />
          {t('Diese Notiz ist zu groß (über 256 KB) oder zu verschachtelt für den Editor und erscheint als Markdown-Quelltext. Ihre Links auf andere Notizen zählen nicht für Rückverweise und die Link-Prüfung.')}
        </p>
      )}
      {mode === 'rich' && note.doc ? (
        <RichEditor mount={mount} note={note} readonly={readonly} encrypted={!!seal} onChange={changed} bind={bind} header={<TagBar mountId={mount.id} tags={tags} readonly={readonly} onChange={(next) => saveMeta({ tags: next })} />} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Suspense fallback={<PartLoading className="p-10" text={t('Markdown-Ansicht wird geladen …')} />}>
            <SourceEditor note={note} readonly={readonly} onChange={changed} bind={bind} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function RichEditor({
  mount,
  note,
  readonly,
  encrypted,
  onChange,
  bind,
  header,
}: {
  mount: Mount;
  note: NoteDocument;
  readonly: boolean;
  /** Decrypted in this browser only: its links are never sent to the server for the link check. */
  encrypted: boolean;
  onChange: () => void;
  bind: (fn: () => Snapshot | null) => void;
  header?: ReactNode;
}) {
  const openNote = useWorkspace((s) => s.openNote);
  const qc = useQueryClient();
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  // Set below (the link menu's state comes after the editor); a click on a broken link opens it.
  const openLinkMenu = useRef<(at: LinkMenuAt) => void>(() => {});
  const extensions = useMemo(
    () => [
      ...editorExtensions({ codeBlock: highlightedCodeBlock, mathBlock: MathBlockView_, mathInline: MathInlineView_, taskCheckboxLabel }).map((ext) => (ext.name === 'image' ? noteImage(mount.id, note.path) : ext)),
      // Only empty paragraphs get the hint — not an empty code block, heading or math block.
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'paragraph' ? t('Schreibe etwas oder tippe „/“ für Befehle …') : '') }),
      SlashCommand,
      NoteLink.configure({ mountId: mount.id, notePath: note.path, folderNote: mount.options.folderNote }),
      EmojiSuggestion,
      BrokenLinks,
    ],
    [mount.id, note.path, mount.options.folderNote],
  );

  /** A click on a link in the note: follow it, or the link menu for one that leads nowhere. */
  const clickLink = (view: EditorView, event: MouseEvent): boolean => {
    const a = (event.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href) return false;
    event.preventDefault();
    // Middle button: `handleMiddle` (aux click) opens it – once, not here as well.
    if (event.button === 1) return true;
    // Leads nowhere: the link menu says so and offers to create the note or fix the link.
    // The click may land on the link itself (its icon) or on the marked text inside it.
    if (a?.querySelector('[data-broken-link]') && !(event.ctrlKey || event.metaKey)) {
      const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
      openLinkMenu.current({ x: event.clientX, y: event.clientY + 8, href, pos, broken: true });
      return true;
    }
    followLink(href, mount, note.path, openNote, event.ctrlKey || event.metaKey);
    return true;
  };

  const editor = useEditor(
    {
      extensions,
      content: note.doc,
      editable: !readonly,
      onUpdate: onChange,
      editorProps: {
        attributes: { class: 'prose-note', spellcheck: 'true' },
        handleClick: (view, _pos, event) => clickLink(view, event),
        // A read-only note: a quick second or third click counts as a double or triple click, `handleClick` never sees
        // it, and the browser followed the link itself – into a new tab (target=_blank). Editable text keeps the
        // browser's word and line selection.
        handleDOMEvents: {
          click: (view, event) => !view.editable && event.detail > 1 && clickLink(view, event),
        },
        // Files dropped or pasted into the note become attachments (docs/PLAN.md §2.6).
        handleDrop: (view, event, _slice, moved) => {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (moved || !files.length || !editorRef.current || !view.editable) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void uploadFiles(editorRef.current, qc, mount, note.path, files, pos);
          return true;
        },
        handlePaste: (view, event) => {
          // Copied from an AI answer (or elsewhere in Kaveyl Wiki): the Markdown itself, nothing lost.
          const md = event.clipboardData?.getData(MARKDOWN_MIME);
          if (md && view.editable && editorRef.current) {
            event.preventDefault();
            editorRef.current.chain().focus().insertContent(loadMarkdown(md).doc.content ?? []).run();
            return true;
          }
          const files = [...(event.clipboardData?.files ?? [])];
          if (!files.length || !editorRef.current || !view.editable) return false;
          event.preventDefault();
          void uploadFiles(editorRef.current, qc, mount, note.path, files);
          return true;
        },
      },
    },
    [extensions],
  );
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    bind(() => {
      const doc = editor.getJSON() as PMNode;
      return { doc, key: JSON.stringify(doc) };
    });
  }, [editor, bind]);
  useEffect(() => {
    editor?.setEditable(!readonly);
  }, [editor, readonly]);

  // Links that lead nowhere: asked again shortly after the links change and whenever the tree of this
  // source changes (its query key starts with ['tree', mountId], so tree invalidations refetch it).
  const [hrefs, setHrefs] = useState<string[]>([]);
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => setHrefs((cur) => {
      const next = localHrefs(editor.state.doc).sort();
      return next.join('\n') === cur.join('\n') ? cur : next;
    });
    read();
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 600);
    };
    editor.on('update', onUpdate);
    return () => {
      clearTimeout(timer);
      editor.off('update', onUpdate);
    };
  }, [editor]);
  const linkCheck = useQuery({
    queryKey: ['tree', mount.id, 'link-check', note.path, hrefs],
    queryFn: () => api.linkCheck(mount.id, note.path, hrefs),
    enabled: hrefs.length > 0 && !encrypted,
  });
  useEffect(() => {
    if (editor) setBrokenLinks(editor, hrefs.length ? (linkCheck.data?.broken ?? []) : []);
  }, [editor, hrefs, linkCheck.data]);
  // The AI header actions work on the editor the user worked in last.
  useEffect(() => {
    if (!editor) return;
    const mark = () => useAi.getState().setCurrent({ editor, mountId: mount.id, path: note.path });
    if (!useAi.getState().current || useAi.getState().current!.editor.isDestroyed) mark();
    editor.on('focus', mark);
    return () => {
      editor.off('focus', mark);
      // `current` is a store field, not a ref (the rule takes any `.current` for one).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (useAi.getState().current?.editor === editor) useAi.getState().setCurrent(null);
    };
  }, [editor, mount.id, note.path]);
  const [editorDom, setEditorDom] = useState<HTMLElement | null>(null);
  const [linkMenu, setLinkMenu] = useState<LinkMenuAt | null>(null);
  openLinkMenu.current = setLinkMenu;
  /** „Notiz anlegen“ for a link that leads nowhere: created where it points, then opened in a new tab. */
  const createLinkTarget = async (at: LinkMenuAt) => {
    const target = resolveHref(at.href, note.path);
    const want = target && noteCandidates(target.path, mount.options.folderNote)[0];
    if (!want || !editor) return;
    const slash = want.lastIndexOf('/');
    try {
      const { path } = await api.createNote(mount.id, slash > 0 ? want.slice(0, slash) : '', noteName(want, mount.options.folderNote), 'file');
      // The file name may differ from the link (characters not allowed in names): then the link follows the note.
      if (path !== want) {
        editor.chain().setTextSelection(at.pos).extendMarkRange('link').updateAttributes('link', { href: noteHref(note.path, path, mount.options.folderNote) }).run();
      }
      void qc.invalidateQueries({ queryKey: ['tree', mount.id] });
      void openInternal(mount, path, openNote, true);
    } catch (e) {
      toast({ kind: 'error', title: t('Notiz nicht angelegt'), text: errorText(e) });
    }
  };
  useEffect(() => {
    if (editor) setEditorDom(editor.view.dom);
  }, [editor]);
  if (editor) attachHandlers.set(editor, () => chooseFiles(editor, qc, mount, note.path));
  if (editor) drawingContexts.set(editor, { mountId: mount.id, notePath: note.path });

  useEffect(() => {
    if (!editor || readonly || !takeFocusRequest(mount.id, note.path)) return;
    editor.commands.focus('end');
  }, [editor, readonly, mount.id, note.path]);
  const { editorWidth, showToc } = usePrefs();
  const headings = useHeadings(editor);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  return (
    <>
      {editor && !readonly && (
        <EditorToolbar editor={editor} onAttach={() => chooseFiles(editor, qc, mount, note.path)} extra={encrypted ? undefined : <AiMenuButton editor={editor} mountId={mount.id} path={note.path} className="ml-1" />} />
      )}
      <div ref={setScroller} className="@container flex min-h-0 flex-1 overflow-y-auto">
        <div className="min-w-0 flex-1">
          <div
            className="mx-auto px-6 pb-[40vh] pt-8 sm:px-12"
            style={{ maxWidth: editorMaxWidth(editorWidth) }}
            onAuxClick={(e) => e.button === 1 && editor && handleMiddle(e, mount, note.path, openNote)}
            onContextMenu={(e) => {
              if (!editor || !editorDom?.contains(e.target as Node)) return;
              const a = (e.target as HTMLElement).closest('a');
              const href = a?.getAttribute('href');
              if (!href) {
                // Elsewhere the browser's menu stays (spell check); the selection bubble steps aside.
                hideSelectionMenu(editor);
                return;
              }
              e.preventDefault();
              const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? editor.state.selection.from;
              // Collapsed selection: no formatting bubble next to the link menu.
              editor.commands.setTextSelection(pos);
              setLinkMenu({ x: e.clientX, y: e.clientY, href, pos, broken: !!a?.querySelector('[data-broken-link]') });
            }}
            onMouseDown={(e) => {
              // A click into the empty space around/below the text puts the cursor at its end.
              if (e.target !== e.currentTarget || e.button !== 0 || !editor?.isEditable) return;
              e.preventDefault();
              editor.commands.focus('end');
            }}
          >
            {header}
            <EditorContent editor={editor} />
            <LinkPreview container={editorDom} mount={mount} notePath={note.path} />
            {editor && linkMenu && (
              <LinkMenu
                at={linkMenu}
                editor={editor}
                isNote={isNoteLink(linkMenu.href, note.path)}
                onOpen={(href, newTab) => followLink(href, mount, note.path, openNote, newTab)}
                onCreate={linkMenu.broken && !readonly ? () => void createLinkTarget(linkMenu) : undefined}
                onClose={() => setLinkMenu(null)}
              />
            )}
            {editor && !readonly && <SelectionMenu editor={editor} extra={encrypted ? undefined : <AiMenuButton editor={editor} mountId={mount.id} path={note.path} />} />}
            {editor && !readonly && <ImageMenu editor={editor} />}
            <AttachmentList mount={mount} path={note.path} />
            <Backlinks mount={mount} path={note.path} />
          </div>
        </div>
        {editor && showToc && headings.length >= 2 && (
          <aside className="sticky top-0 hidden w-60 shrink-0 self-start @4xl:block">
            <Toc editor={editor} headings={headings} scroller={scroller} />
          </aside>
        )}
      </div>
    </>
  );
}

/** A link to something that is not a note (attachment, image …). */
function isFileLink(path: string): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return !!ext && ext !== 'md';
}

/** Opens what a link in a note points at: web page (new browser tab), file (preview/download) or note. */
function followLink(href: string, mount: Mount, notePath: string, openNote: OpenNote, newTab: boolean) {
  if (isExternal(href)) {
    if (!isScriptUrl(href)) window.open(externalUrl(href), '_blank', 'noopener,noreferrer');
    return;
  }
  const target = resolveHref(href, notePath);
  if (!target) return;
  if (isFileLink(target.path)) openFile(mount, target.path);
  else void openInternal(mount, target.path, openNote, newTab);
}

const isNoteLink = (href: string, notePath: string) => {
  if (isExternal(href)) return false;
  const target = resolveHref(href, notePath);
  return !!target && !isFileLink(target.path);
};

function handleMiddle(e: React.MouseEvent, mount: Mount, notePath: string, openNote: OpenNote) {
  const href = (e.target as HTMLElement).closest('a')?.getAttribute('href');
  if (!href) return;
  e.preventDefault();
  if (isExternal(href)) return void (isScriptUrl(href) || window.open(externalUrl(href), '_blank', 'noopener,noreferrer'));
  const target = resolveHref(href, notePath);
  if (target) void openInternal(mount, target.path, openNote, true);
}

type OpenNote = ReturnType<typeof useWorkspace.getState>['openNote'];

async function openInternal(mount: Mount, path: string, openNote: OpenNote, newTab: boolean) {
  for (const candidate of noteCandidates(path, mount.options.folderNote)) {
    try {
      const n = await api.note(mount.id, candidate);
      openNote(mount.id, candidate, n.title, { newTab });
      return;
    } catch {
      /* try next candidate */
    }
  }
  // Not found: open anyway so the user sees a clear "does not exist" page.
  openNote(mount.id, noteCandidates(path, mount.options.folderNote)[0]!, path.split('/').pop() ?? path, { newTab });
}

/** CSS width for the `width` attribute: "400" → 400px, "50%" stays. */
const cssSize = (v: unknown) => (v === null || v === undefined || v === '' ? '' : /^\d+(\.\d+)?$/.test(String(v)) ? `${String(v)}px` : String(v));

/**
 * Image extension whose rendering resolves relative sources to the file API (the stored src
 * stays untouched), with a handle in the corner to drag the width (AD-019).
 */
/**
 * Images get their address only when they come near the visible part of the note (one screen ahead): the browser's own
 * `loading="lazy"` looks ~3000 px ahead in Chromium and loads whole runs of images at once. Without a scroll area or
 * IntersectionObserver they load at once; printing loads everything still waiting.
 */
const waitingImages = new Map<Element, { load: () => void; io?: IntersectionObserver }>();
const nearObservers = new WeakMap<Element, IntersectionObserver>();
function loadWhenNear(el: HTMLElement, load: () => void) {
  waitingImages.set(el, { load });
  // The node view is attached to the note only after this call: its scroll area is known on the next frame.
  requestAnimationFrame(() => {
    const waiting = waitingImages.get(el);
    if (!waiting || waiting.io) return;
    const root = el.closest('.overflow-y-auto');
    if (!root || typeof IntersectionObserver === 'undefined') return loadNow(el);
    let io = nearObservers.get(root);
    if (!io) {
      io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && loadNow(e.target)), { root, rootMargin: '100% 0px' });
      nearObservers.set(root, io);
    }
    waiting.io = io;
    io.observe(el);
  });
}
function forgetWaiting(el: Element) {
  waitingImages.get(el)?.io?.unobserve(el);
  waitingImages.delete(el);
}
function loadNow(el: Element) {
  const waiting = waitingImages.get(el);
  forgetWaiting(el);
  waiting?.load();
}
if (typeof window !== 'undefined') window.addEventListener('beforeprint', () => [...waitingImages.keys()].forEach(loadNow));

function noteImage(mountId: string, notePath: string) {
  return Image.extend({
    addNodeView() {
      return ({ node, getPos, editor }) => {
        // The wrapper carries the width (px or %), the image fills it.
        const wrap = document.createElement('span');
        wrap.className = 'note-image';
        const img = document.createElement('img');
        // Large images: loaded when scrolled near (`loadWhenNear`), decoded off the main thread.
        img.decoding = 'async';
        // Until it has loaded, an image holds some room: at 0 px, images right after each other would all be „near“ and load at once.
        const settled = () => wrap.classList.remove('is-pending');
        img.addEventListener('load', settled);
        img.addEventListener('error', settled);
        const handle = document.createElement('span');
        handle.className = 'note-image-handle';
        handle.setAttribute('aria-hidden', 'true');
        // Full-size view: the magnifier (hover, or the selected image on touch), or a click when reading.
        const zoom = document.createElement('button');
        zoom.type = 'button';
        zoom.className = 'note-image-zoom';
        zoom.setAttribute('aria-label', t('Bild groß anzeigen'));
        zoom.title = t('Bild groß anzeigen');
        zoom.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>';
        const showLarge = () => img.src && openLightbox(img.currentSrc || img.src, img.alt);
        zoom.addEventListener('mousedown', (e) => e.preventDefault());
        zoom.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showLarge();
        });
        img.addEventListener('click', () => {
          if (!editor.isEditable) showLarge();
        });
        wrap.append(img, zoom, handle);
        let attrs = node.attrs;
        let near = false;
        const update = (a: Record<string, unknown>) => {
          attrs = a;
          if (near) showSrc(a);
          else {
            wrap.classList.add('is-pending');
            loadWhenNear(wrap, () => {
              near = true;
              showSrc(attrs);
            });
          }
          img.alt = String(a.alt ?? '');
          img.title = a.title ? String(a.title) : '';
          wrap.style.width = cssSize(a.width);
          img.style.height = cssSize(a.height);
          wrap.classList.toggle('has-width', !!a.width);
        };
        const showSrc = (a: Record<string, unknown>) => {
          const src = String(a.src ?? '');
          const target = isExternal(src) || src.startsWith('data:') ? null : resolveHref(src, notePath);
          if (target?.path.endsWith('.age')) {
            // Encrypted attachment: decrypted in the browser with the note's passphrase.
            img.removeAttribute('src');
            void decryptedFileUrl(mountId, notePath, target.path).then((url) => url && attrs.src === a.src && (img.src = url));
          } else if (target) {
            // An edited drawing: its new version, not the cached one.
            const v = drawingVersions.get(`${mountId}:${target.path}`);
            img.src = api.fileUrl(mountId, target.path) + (v ? `?v=${v}` : '');
          } else img.src = src;
          wrap.classList.toggle('is-pending', !img.getAttribute('src') || !img.complete);
        };
        update(node.attrs);
        // Excalidraw drawings open for editing with a double click.
        wrap.addEventListener('dblclick', (e) => {
          if (!editor.isEditable || !isDrawingSrc(String(attrs.src ?? ''))) return;
          e.preventDefault();
          openDrawing(editor as Editor, String(attrs.src));
        });
        handle.addEventListener('pointerdown', (e) => {
          if (!editor.isEditable) return;
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const startW = wrap.getBoundingClientRect().width;
          const max = (wrap.closest('.ProseMirror') as HTMLElement | null)?.clientWidth ?? 2000;
          const move = (ev: PointerEvent) => {
            wrap.style.width = `${Math.round(Math.max(32, Math.min(max, startW + ev.clientX - startX)))}px`;
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            const pos = getPos();
            const width = String(Math.round(wrap.getBoundingClientRect().width));
            if (typeof pos === 'number' && width !== String(attrs.width)) editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...attrs, width, height: null }));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });
        return {
          dom: wrap,
          update: (next) => {
            if (next.type.name !== 'image') return false;
            update(next.attrs);
            return true;
          },
          selectNode: () => wrap.classList.add('ProseMirror-selectednode'),
          deselectNode: () => wrap.classList.remove('ProseMirror-selectednode'),
          ignoreMutation: () => true,
          destroy: () => forgetWaiting(wrap),
        };
      };
    },
  }).configure({ inline: true });
}

function NoteHeader({
  mount,
  note,
  mode,
  saveState,
  saveFailure,
  readonly,
  lockable,
  unlocked,
  onToggleLock,
  onMode,
  onSaveNow,
  icon,
  onIcon,
  fmReadonly,
  onToggleReadonly,
  onCloseSplit,
  presence,
  encrypted,
  onCrypt,
}: {
  mount: Mount;
  note: NoteDocument;
  mode: 'rich' | 'source';
  saveState: SaveState;
  saveFailure: SaveFailure | null;
  readonly: boolean;
  lockable: boolean;
  unlocked: boolean;
  onToggleLock: () => void;
  onMode: (m: 'rich' | 'source') => Promise<void>;
  onSaveNow: () => void;
  icon: string | null;
  onIcon: (icon: string | null) => void;
  fmReadonly: boolean;
  onToggleReadonly: () => void;
  onCloseSplit?: () => void;
  presence: PresenceUser[];
  encrypted: boolean;
  /** Encrypt / remove encryption of this note (not offered inside an encrypted folder). */
  onCrypt?: (action: 'encrypt' | 'decrypt') => void;
}) {
  const { revealInTree } = useWorkspace.getState();
  const openAction = useActions((s) => s.open);
  const session = useQuery({ queryKey: ['session'], queryFn: api.session }).data;
  // Source / folders / file name without `.md`; a folder note ends at its folder.
  const parts = note.path.split('/');
  const isFolderNote = parts.length > 1 && parts.at(-1)!.toLowerCase() === mount.options.folderNote.toLowerCase();
  const crumbs = [mount.name, ...parts.slice(0, -1), ...(isFolderNote ? [] : [parts.at(-1)!.replace(/\.md$/i, '')])];
  const favorite = usePersonal((p) => p.favorites.some((f) => f.mountId === mount.id && f.path === note.path));
  const [iconOpen, setIconOpen] = useState(false);
  // Read-only source or only read access (AD-020): no changing actions.
  const canWrite = !mount.options.readonly && note.access !== 'read';
  // Dialogs name the note by its file name, like tree, tabs and header (AD-022).
  const displayName = noteName(note.path, mount.options.folderNote);
  const aiAvailable = useAiAvailable();
  // Where the editor shows its „KI“ button (formatting bar), the AI entries live there only.
  const aiInToolbar = mode === 'rich' && !readonly;
  const aiEditor = () => {
    const c = useAi.getState().current;
    return c && c.mountId === mount.id && c.path === note.path && !c.editor.isDestroyed ? c.editor : null;
  };
  // The texts "Editor"/"Markdown" only where the note name still fits next to them (design-014): otherwise their
  // room came out of the name, which then showed less in a wider window. Tried before paint, so nothing flickers.
  const headerRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const fitLabels = useCallback(() => {
    const hdr = headerRef.current;
    const name = nameRef.current;
    if (!hdr || !name) return;
    delete hdr.dataset.labels;
    if (name.scrollWidth > name.clientWidth) hdr.dataset.labels = 'off';
  }, []);
  // Every render: name, save state and badges change the room, not only the width of the pane.
  useLayoutEffect(fitLabels);
  useLayoutEffect(() => {
    const hdr = headerRef.current;
    if (!hdr || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fitLabels);
    ro.observe(hdr);
    return () => ro.disconnect();
  }, [fitLabels]);
  return (
    <div ref={headerRef} className="@container flex h-10 shrink-0 items-center gap-1 border-b border-line px-2 text-sm sm:gap-2 sm:px-3" data-print="hide">
      <Popover.Root open={iconOpen} onOpenChange={setIconOpen}>
        <Popover.Trigger asChild disabled={!canWrite}>
          <button className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-hover" aria-label={t('Icon der Notiz')} title={canWrite ? t('Icon ändern') : undefined}>
            <EntryIcon icon={icon} isDir={false} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <PopoverContent align="start" sideOffset={4} className="z-50 p-3">
            <IconPicker
              value={icon}
              onPick={(i) => {
                setIconOpen(false);
                onIcon(i);
              }}
            />
          </PopoverContent>
        </Popover.Portal>
      </Popover.Root>
      {/* Narrow panes drop crumbs from the left (all but the note below @lg, all but its folder below @3xl);
          tapping opens the full path – no hover needed. Name stays generic: e2e matches button names as substrings.
          The note name keeps at least "… / " + about five characters; the buttons give way first, not below 24 px.
          On touch the path button is 32 px high (design-013) – still inside the 40 px bar. */}
      <div className="flex min-w-[calc(1.75rem+5ch)] flex-1 items-center">
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="flex min-w-0 max-w-full items-center gap-1 rounded text-left text-fg-muted hover:bg-hover [@media(hover:none)]:min-h-8"
              title={`${mount.name} / ${note.path}`}
              aria-label={t('Pfad der Notiz')}
            >
              {/* "…" via CSS, so the text of the crumbs stays the bare path */}
              <span aria-hidden className={cx("shrink-0 text-fg-faint before:content-['…']", crumbs.length > 2 ? '@3xl:hidden' : '@lg:hidden')} />
              {crumbs.map((c, i) => (
                <span
                  key={i}
                  className={cx(
                    'min-w-0 items-center gap-1',
                    // Shrinking is weighted by factor × width: with this factor the folders give way
                    // completely (down to nothing) before the note name loses even a fraction of a pixel.
                    i === crumbs.length - 1 ? 'flex' : i === crumbs.length - 2 ? 'hidden shrink-[1000000] @lg:flex' : 'hidden shrink-[1000000] @3xl:flex',
                  )}
                >
                  {i > 0 && <span className="text-fg-faint">/</span>}
                  <span ref={i === crumbs.length - 1 ? nameRef : undefined} className={cx('truncate', i === crumbs.length - 1 && 'text-fg')}>
                    {c}
                  </span>
                </span>
              ))}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <PopoverContent align="start" sideOffset={4} aria-label={t('Pfad der Notiz')} className="z-50 p-2 text-sm">
              <ol>
                {crumbs.map((c, i) => (
                  <li key={i} className={cx('break-words py-0.5', i === crumbs.length - 1 ? 'text-fg' : 'text-fg-muted')} style={{ paddingLeft: `${Math.min(i, 6) * 0.75}rem` }}>
                    {c}
                  </li>
                ))}
              </ol>
            </PopoverContent>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {encrypted && <EncryptedBadge />}
      <PresenceChip users={presence} />
      <SaveIndicator state={saveState} failure={saveFailure} onRetry={onSaveNow} />
      <button
        className={cx('flex h-7 w-7 min-w-6 items-center justify-center rounded hover:bg-hover', favorite ? 'text-warn' : 'text-fg-faint')}
        aria-label={favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten')}
        aria-pressed={favorite}
        title={favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten')}
        onClick={() => usePersonal.getState().toggleFavorite({ mountId: mount.id, path: note.path, title: note.title })}
      >
        <Star className={cx('h-4 w-4', favorite && 'fill-current')} />
      </button>
      {readonly && !lockable && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-muted">{t('Schreibgeschützt')}</span>}
      {lockable && (
        <Button size="sm" variant="ghost" onClick={onToggleLock} title={unlocked ? t('Wieder sperren') : t('Notiz ist als schreibgeschützt markiert – zum Bearbeiten entsperren')}>
          {unlocked ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          {unlocked ? t('Entsperrt') : t('Nur lesen')}
        </Button>
      )}
      <div className="flex rounded-md border border-line p-0.5">
        <button
          className={cx('flex h-6 items-center gap-1 rounded px-1.5 text-xs disabled:opacity-50 @md:px-2', mode === 'rich' ? 'bg-active text-fg' : 'text-fg-muted hover:text-fg')}
          aria-pressed={mode === 'rich'}
          disabled={!note.doc}
          onClick={() => mode !== 'rich' && void onMode('rich')}
          title={note.doc ? t('Visueller Editor') : t('Zu groß oder zu verschachtelt für den Editor – nur als Markdown-Quelltext')}
        >
          <PenLine className="h-3.5 w-3.5" /> <span className="hidden @3xl:inline [[data-labels=off]_&]:hidden">{t('Editor')}</span>
        </button>
        <button
          className={cx('flex h-6 items-center gap-1 rounded px-1.5 text-xs @md:px-2', mode === 'source' ? 'bg-active text-fg' : 'text-fg-muted hover:text-fg')}
          aria-pressed={mode === 'source'}
          onClick={() => mode !== 'source' && void onMode('source')}
          title={t('Markdown-Quelltext')}
        >
          <FileCode2 className="h-3.5 w-3.5" /> <span className="hidden @3xl:inline [[data-labels=off]_&]:hidden">{t('Markdown')}</span>
        </button>
      </div>
      <ViewToggles mode={mode} onDownload={encrypted ? undefined : () => downloadExport(mount.id, note.path, 'md')} />
      <DM.Root>
        <DM.Trigger asChild>
          <button className="flex h-7 w-7 min-w-6 items-center justify-center rounded text-fg-muted hover:bg-hover" aria-label={t('Weitere Aktionen')}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DropdownContent align="end" className="z-50">
            {[
              { icon: <LocateFixed />, label: t('Im Baum anzeigen'), run: () => revealInTree(mount.id, note.path) },
              { icon: <History />, label: t('Versionen'), run: () => openAction({ kind: 'history', mountId: mount.id, path: note.path }) },
              { icon: <Printer />, label: t('Drucken / als PDF …'), run: () => printNote(mount.id, note.path, encrypted) },
              ...(encrypted
                ? []
                : [
                    {
                      icon: <FileDown />,
                      label: t('Exportieren'),
                      run: () => {},
                      sub: [
                        { label: t('HTML-Datei'), run: () => downloadExport(mount.id, note.path) },
                        { label: t('Markdown'), run: () => downloadExport(mount.id, note.path, 'md') },
                      ],
                    },
                  ]),
              ...(aiAvailable && !encrypted && !aiInToolbar
                ? [
                    { icon: <Sparkles />, label: t('KI fragen …'), run: () => useAi.getState().openAsk({ kind: 'note', mountId: mount.id, path: note.path }) },
                    { icon: <Sparkles />, label: t('KI: Zusammenfassen'), run: () => void runAiAction(aiEditor(), mount.id, note.path, 'summarize') },
                    ...(canWrite ? [{ icon: <Sparkles />, label: t('KI: Weiterschreiben'), run: () => void runAiAction(aiEditor(), mount.id, note.path, 'continue') }] : []),
                  ]
                : []),
              ...(!canWrite
                ? []
                : [{ icon: fmReadonly ? <LockOpen /> : <Lock />, label: fmReadonly ? t('Schreibschutz aufheben') : t('Schreibschutz setzen'), run: onToggleReadonly }]),
              ...(!canWrite
                ? []
                : [
                    {
                      icon: <LayoutTemplate />,
                      label: t('Als Vorlage speichern'),
                      run: async () => {
                        const name = (
                          await promptDialog(t('Als Vorlage speichern'), { label: t('Name der Vorlage'), value: displayName, required: true, confirmLabel: t('Speichern'), help: 'vorlagen' })
                        )?.trim();
                        if (!name) return;
                        void api
                          .saveTemplate(mount.id, note.path, name)
                          .then((tpl) => toast({ kind: 'ok', title: t('Vorlage „{title}“ gespeichert', { title: tpl.title }), text: `.kaveyl-wiki/templates/${tpl.name}` }))
                          .catch((e: unknown) => toast({ kind: 'error', title: t('Vorlage nicht gespeichert'), text: errorText(e) }));
                      },
                    },
                  ]),
              ...(encrypted ? [{ icon: <Lock />, label: t('Jetzt sperren'), run: lockAll }] : []),
              ...(canWrite && onCrypt
                ? [encrypted ? { icon: <LockOpen />, label: t('Verschlüsselung entfernen …'), run: () => onCrypt('decrypt') } : { icon: <Lock />, label: t('Verschlüsseln …'), run: () => onCrypt('encrypt') }]
                : []),
              ...(note.access === 'admin'
                ? [{ icon: <ShieldCheck />, label: t('Berechtigungen …'), run: () => openAction({ kind: 'acl', mountId: mount.id, target: 'note', path: note.path, title: displayName }) }]
                : []),
              // „Teilen“ (owner 28.10.): the note as a file by mail (anyone who reads it), access by e-mail („verwalten“).
              ...(session?.user?.isGuest
                ? []
                : [
                    {
                      icon: <Send />,
                      label: t('Teilen'),
                      run: () => {},
                      sub: [
                        {
                          label: t('Per Mail versenden …'),
                          disabled: !session?.mail || encrypted,
                          title: !session?.mail ? t('E-Mail-Versand ist nicht eingerichtet') : encrypted ? t('Verschlüsselte Notizen lassen sich nicht per Mail versenden') : undefined,
                          run: () => openAction({ kind: 'mail-notes', mountId: mount.id, notes: [{ path: note.path, title: displayName }] }),
                        },
                        ...(note.access === 'admin'
                          ? [{ label: t('Zugriff per E-Mail geben …'), run: () => openAction({ kind: 'share', mountId: mount.id, target: 'note', path: note.path, title: displayName }) }]
                          : []),
                      ],
                    },
                  ]),
              ...(!canWrite
                ? []
                : [
                    { icon: <Pencil />, label: t('Umbenennen / verschieben'), run: () => openAction({ kind: 'rename', mountId: mount.id, path: note.path, isDir: false }) },
                    { icon: <Trash2 />, label: t('Löschen'), danger: true, run: () => openAction({ kind: 'delete', mountId: mount.id, path: note.path, isDir: false, title: displayName }) },
                  ]),
            ].map((item: { icon: ReactNode; label: string; run: () => void; danger?: boolean; sub?: { label: string; run: () => void; disabled?: boolean; title?: string }[] }) =>
              item.sub ? (
                // A submenu (opens on hover, tap or arrow key), like „Exportieren“ in the tree's context menu.
                <DM.Sub key={item.label}>
                  <DM.SubTrigger className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover [&>svg]:h-4 [&>svg]:w-4">
                    {item.icon}
                    <span className="flex-1">{item.label}</span>
                    <ChevronRight className="!h-3.5 !w-3.5 text-fg-faint" />
                  </DM.SubTrigger>
                  <DM.Portal>
                    <DropdownSubContent minWidth={180} className="z-50" onFocusOutside={keepSubOpen}>
                      {item.sub.map((s) => (
                        <DM.Item
                          key={s.label}
                          onSelect={s.run}
                          disabled={s.disabled}
                          title={s.title}
                          className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover"
                        >
                          {s.label}
                        </DM.Item>
                      ))}
                    </DropdownSubContent>
                  </DM.Portal>
                </DM.Sub>
              ) : (
                <DM.Item
                  key={item.label}
                  onSelect={item.run}
                  className={cx('flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover [&>svg]:h-4 [&>svg]:w-4', item.danger && 'text-danger')}
                >
                  {item.icon}
                  {item.label}
                </DM.Item>
              ),
            )}
          </DropdownContent>
        </DM.Portal>
      </DM.Root>
      {onCloseSplit && (
        <button className="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-hover" aria-label={t('Geteilte Ansicht schließen')} title={t('Geteilte Ansicht schließen')} onClick={onCloseSplit}>
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** `onDownload`: the note as .md (with its pictures and files as ZIP, owner 28.10.) – not for encrypted notes. */
function ViewToggles({ mode, onDownload }: { mode: 'rich' | 'source'; onDownload?: () => void }) {
  const { editorWidth, showToc, set } = usePrefs();
  const full = editorWidth === 'full';
  return (
    <div className="flex items-center">
      {mode === 'rich' && (
        <button
          className={cx('flex h-7 w-7 items-center justify-center rounded hover:bg-hover', showToc ? 'text-fg' : 'text-fg-faint')}
          aria-label={t('Inhaltsverzeichnis ein-/ausblenden')}
          aria-pressed={showToc}
          title={t('Inhaltsverzeichnis ein-/ausblenden')}
          onClick={() => set({ showToc: !showToc })}
        >
          <ListTree className="h-4 w-4" />
        </button>
      )}
      {onDownload && (
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
          aria-label={t('Herunterladen')}
          title={t('Als Markdown herunterladen (.md – mit Bildern oder Dateien als ZIP)')}
          onClick={onDownload}
        >
          <Download className="h-4 w-4" />
        </button>
      )}
      <button
        className="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
        aria-label={full ? t('Normale Breite') : t('Volle Breite')}
        title={full ? t('Normale Breite (Breite in Einstellungen → Darstellung)') : t('Volle Breite')}
        onClick={() => set({ editorWidth: full ? 'normal' : 'full' })}
      >
        {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * Presence of other users on this note ("Maria bearbeitet gerade"): heartbeat every 20 s while the
 * note is visible, "typing" for 30 s after the last change, "left" when the view goes away.
 */
function usePresence(mount: Mount, path: string, isActive: boolean, lastEdit: React.MutableRefObject<number>): PresenceUser[] {
  const me = useQuery({ queryKey: ['session'], queryFn: api.session, staleTime: Infinity }).data?.user?.id;
  const [users, setUsers] = useState<PresenceUser[]>([]);
  useEffect(() => {
    if (!isActive) return;
    let alive = true;
    const beat = () =>
      void api
        .presence(mount.id, path, true, Date.now() - lastEdit.current < 30_000)
        .then((u) => alive && setUsers(u))
        .catch(() => undefined);
    beat();
    const timer = setInterval(beat, 20_000);
    const onEdit = () => beat();
    window.addEventListener(`kaveyl-wiki-edit:${mount.id}:${path}`, onEdit);
    const off = onPresence((e) => e.mountId === mount.id && e.path === path && setUsers(e.users));
    // Closing the browser tab: a normal request would be cancelled, a beacon still arrives.
    const onHide = () => navigator.sendBeacon?.('/api/presence', new Blob([JSON.stringify({ mountId: mount.id, path, open: false })], { type: 'application/json' }));
    window.addEventListener('pagehide', onHide);
    return () => {
      alive = false;
      clearInterval(timer);
      off();
      window.removeEventListener(`kaveyl-wiki-edit:${mount.id}:${path}`, onEdit);
      window.removeEventListener('pagehide', onHide);
      void api.presence(mount.id, path, false, false).catch(() => undefined);
    };
  }, [mount.id, path, isActive, lastEdit]);
  return users.filter((u) => u.id !== me);
}

function PresenceChip({ users }: { users: PresenceUser[] }) {
  if (!users.length) return null;
  const editing = users.filter((u) => u.editing);
  const names = (list: PresenceUser[]) => list.map((u) => u.name).join(', ');
  const text = editing.length
    ? tn(editing.length, '{names} bearbeitet gerade', '{names} bearbeiten gerade', { names: names(editing) })
    : tn(users.length, '{names} hat die Notiz offen', '{names} haben die Notiz offen', { names: names(users) });
  return (
    <span className={cx('flex max-w-[40%] items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs', editing.length ? 'bg-[color-mix(in_srgb,var(--warn)_15%,var(--bg))] text-warn' : 'bg-muted text-fg-muted')} title={text} role="status">
      <Users className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

function SaveIndicator({ state, failure, onRetry }: { state: SaveState; failure: SaveFailure | null; onRetry: () => void }) {
  // One live region for every state, so screen readers hear the change; on narrow widths the word stays for them.
  return (
    <span role="status" aria-live="polite" className="flex items-center">
      {state === 'saving' ? (
        <span className="flex items-center gap-1 text-xs text-fg-faint"><Spinner className="h-3 w-3" /> <span className="sr-only @2xl:not-sr-only">{t('Speichert …')}</span></span>
      ) : state === 'dirty' ? (
        <span className="flex items-center gap-1 text-xs text-fg-faint"><CloudUpload className="h-3.5 w-3.5" /> <span className="sr-only @2xl:not-sr-only">{t('Ungespeichert')}</span></span>
      ) : state === 'error' ? (
        // Cause and way out (design-003): the label names the cause, the popover says what to do.
        // On touch 32 px high like path and "+ Tag" (design-013/-011); the negative margins keep the row height.
        <Popover.Root>
          <Popover.Trigger className="flex items-center gap-1 text-xs text-danger [@media(hover:none)]:-my-1.5 [@media(hover:none)]:min-h-8">
            <AlertTriangle className="h-3.5 w-3.5" /> {failure?.label ?? t('Nicht gespeichert')}
          </Popover.Trigger>
          <span className="sr-only">{failure?.detail}</span>
          <Popover.Portal>
            <PopoverContent align="end" sideOffset={4} aria-label={t('Nicht gespeichert')} className="z-50 max-w-xs p-3 text-sm">
              <p>{failure?.detail}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {failure?.kind === 'signedOut' && (
                  <a className="inline-flex h-7 items-center rounded-md bg-accent px-2 text-xs font-medium text-accent-fg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent" href="/" target="_blank" rel="noopener">
                    {t('In neuem Tab anmelden')}
                  </a>
                )}
                {failure?.kind !== 'gone' && (
                  <Button size="sm" variant={failure?.kind === 'signedOut' ? 'ghost' : 'primary'} onClick={onRetry}>
                    {t('Jetzt erneut versuchen')}
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <span className="flex items-center gap-1 text-xs text-fg-faint"><Check className="h-3.5 w-3.5" /> <span className="sr-only @2xl:not-sr-only">{t('Gespeichert')}</span></span>
      )}
    </span>
  );
}

