// The Markdown source view of a note (CodeMirror). Loaded only when someone opens it (seo-002) – NoteView imports
// it through lazyPart, never statically (SourceEditor.test.ts).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { Redo2, Undo2, WrapText, FileCog } from 'lucide-react';
import { cx, useMediaQuery } from '../ui';
import type { NoteDocument } from '../api';
import { editorMaxWidth, usePrefs } from '../prefs';
import { Toc } from './Toc';
import { t } from '../i18n';
import { noteIdHint, sourceHeadings, type SourceHeading } from './sourceToc';

/** The card look of the redesign: the editor takes the colours of the palette (sheet, quiet gutter). */
const LOOK = EditorView.theme({
  '&.cm-editor': { backgroundColor: 'var(--bg)' },
  '&.cm-editor .cm-gutters': { backgroundColor: 'var(--bg-subtle)', borderRight: '1px solid var(--border-soft)', color: 'var(--fg-faint)' },
  '&.cm-editor .cm-content': { padding: '12px 0', lineHeight: '1.7' },
  '&.cm-editor .cm-line': { padding: '0 16px' },
  '&.cm-editor .cm-gutters .cm-gutterElement': { lineHeight: '1.7' },
  '&.cm-editor.cm-focused': { outline: 'none' },
});
/** Markdown in the colours of the palette: headings and front matter keys in the accent, no underlines. */
const MARKS = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, color: 'var(--accent)', fontWeight: '700', textDecoration: 'none' },
    { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--fg-faint)' },
    { tag: [tags.propertyName, tags.definition(tags.propertyName), tags.keyword], color: 'var(--accent)', fontWeight: '600' },
    { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'none' },
    { tag: tags.monospace, color: 'var(--accent)' },
    { tag: tags.quote, color: 'var(--fg-muted)' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.comment, color: 'var(--fg-faint)', fontStyle: 'italic' },
  ]),
);
/** Line wrapping can be switched off in the dock („Zeilenumbruch“); the choice stays in this browser. */
const WRAP_KEY = 'kaveyl-wiki.source-wrap';
const wrapStored = () => {
  try {
    return localStorage.getItem(WRAP_KEY) !== 'off';
  } catch {
    return true;
  }
};
const EXTENSIONS = [markdown({ base: markdownLanguage, codeLanguages: languages }), noteIdHint, LOOK, MARKS];
/**
 * Above this many characters the view shows plain text: CodeMirror's Markdown parser is quadratic inside one
 * paragraph and cannot be interrupted there (200 000 characters of `*a` block the tab ~5 s), and anyone who may
 * write could put such a note in front of every reader (security review 0.2.12).
 */
export const HIGHLIGHT_MAX = 100_000;
const PLAIN = [noteIdHint, LOOK];

export function SourceEditor({
  note,
  readonly,
  onChange,
  bind,
  scroller,
}: {
  note: NoteDocument;
  readonly: boolean;
  onChange: () => void;
  bind: (fn: () => { raw: string; key: string }) => void;
  /** The element that scrolls the view (for the table of contents). */
  scroller: HTMLElement | null;
}) {
  const value = useRef(note.raw);
  // Decided once per opened note, so typing across the limit does not switch the view under the cursor.
  const [plain] = useState(() => note.raw.length > HIGHLIGHT_MAX);
  useEffect(() => bind(() => ({ raw: value.current, key: value.current })), [bind]);
  const dark = document.documentElement.classList.contains('dark');
  const { editorWidth, showToc, toolbar } = usePrefs();
  const [view, setView] = useState<EditorView | null>(null);
  const [wrapping] = useState(() => new Compartment());
  const [wrap, setWrap] = useState(wrapStored);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const narrow = useMediaQuery('(max-width: 767px)');
  const extensions = useMemo(() => [...(plain ? PLAIN : EXTENSIONS), wrapping.of(wrapStored() ? EditorView.lineWrapping : [])], [plain, wrapping]);
  const toggleWrap = () => {
    const next = !wrap;
    setWrap(next);
    try {
      localStorage.setItem(WRAP_KEY, next ? 'on' : 'off');
    } catch {
      // private window: only for now
    }
    view?.dispatch({ effects: wrapping.reconfigure(next ? EditorView.lineWrapping : []) });
    view?.focus();
  };
  const run = (command: (v: EditorView) => boolean) => {
    if (!view) return;
    command(view);
    view.focus();
  };
  /** To the front matter (the lines between --- on top); without one, a new one with `tags:` is written there. */
  const frontmatter = () => {
    if (!view) return;
    const doc = view.state.doc;
    // A byte order mark in front of the file (some Windows editors) still counts as the start (diff check 0.2.15).
    const bom = doc.sliceString(0, 1) === '\uFEFF' ? 1 : 0;
    if (doc.lines > 1 && doc.line(1).text.slice(bom).trimEnd() === '---') {
      const at = doc.line(2).from;
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 24 }) });
    } else {
      view.dispatch({ changes: { from: bom, insert: '---\ntags: []\n---\n\n' }, selection: { anchor: bom + 11 }, effects: EditorView.scrollIntoView(0, { y: 'start' }) });
    }
    view.focus();
  };
  const [headings, setHeadings] = useState<SourceHeading[]>([]);
  // Line and column of the cursor, shown in the head of the card.
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const track = (v: EditorView) => {
    setHistory({ undo: undoDepth(v.state), redo: redoDepth(v.state) });
    const head = v.state.selection.main.head;
    const line = v.state.doc.lineAt(head);
    setCursor({ line: line.number, col: head - line.from + 1 });
  };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Headings follow typing and the parser (which finishes long documents in the background), a little delayed.
  const refresh = (v: EditorView, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHeadings(sourceHeadings(v.state)), delay);
  };
  const dock = !readonly && !narrow && (
    // The dock of the Markdown view (draft „Frontmatter · Zeilenumbruch · ↶ ↷“), where the editor's dock sits.
    <div className={cx('pointer-events-none sticky z-20 flex justify-center', toolbar === 'top' ? 'top-3 mb-3' : 'bottom-4 mt-6')} data-print="hide">
      <div role="toolbar" aria-label={t('Markdown-Werkzeuge')} className="pointer-events-auto flex h-12 items-center gap-0.5 rounded-full bg-raised px-2 shadow-dock">
        <DockButton onClick={frontmatter} title={t('Zum Frontmatter springen – fehlt es, wird eines mit „tags:“ angelegt')}>
          <FileCog /> {t('Frontmatter')}
        </DockButton>
        <DockButton onClick={toggleWrap} pressed={wrap} title={t('Lange Zeilen umbrechen oder seitlich scrollen')}>
          <WrapText /> {t('Zeilenumbruch')}
        </DockButton>
        <span className="mx-1 h-5 w-px bg-line-soft" aria-hidden />
        <DockButton label={t('Rückgängig (Strg+Z)')} disabled={!history.undo} onClick={() => run(undo)}>
          <Undo2 />
        </DockButton>
        <DockButton label={t('Wiederholen (Strg+Umschalt+Z)')} disabled={!history.redo} onClick={() => run(redo)}>
          <Redo2 />
        </DockButton>
      </div>
        </div>
  );
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="mx-auto px-4 py-6 md:px-8" style={{ maxWidth: editorWidth === 'normal' ? '820px' : editorMaxWidth(editorWidth) }}>
          {plain && <p className="mb-2 text-xs text-fg-muted">{t('Große Notiz: ohne Hervorhebung und Inhaltsverzeichnis, damit die Ansicht flüssig bleibt.')}</p>}
          {toolbar === 'top' && dock}
          <div className="overflow-hidden rounded-2xl border border-line bg-bg">
          <div className="flex h-9 items-center gap-2 border-b border-line-soft bg-accent-tint px-4 text-xs text-fg-muted">
            <span className="min-w-0 truncate font-medium text-fg">{note.path.split('/').pop()}</span>
            <span aria-hidden>·</span>
            <span>UTF-8 · Markdown</span>
            <span className="ml-auto tabular-nums">{t('Zeile {line}, Spalte {col}', { line: cursor.line, col: cursor.col })}</span>
          </div>
          <CodeMirror
            value={note.raw}
            theme={dark ? 'dark' : 'light'}
            editable={!readonly}
            basicSetup={{ foldGutter: false, highlightActiveLine: false }}
            extensions={extensions}
            onCreateEditor={(v) => {
              setView(v);
              track(v);
              if (!plain) refresh(v, 0);
            }}
            onUpdate={(u) => {
              if (u.selectionSet || u.docChanged) track(u.view);
              if (plain) return;
              // Positions follow every keystroke at once; the texts come with the delayed refresh.
              if (u.docChanged) setHeadings((list) => list.map((h) => ({ ...h, pos: u.changes.mapPos(h.pos) })));
              if (u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) refresh(u.view, 300);
            }}
            onChange={(v) => {
              value.current = v;
              onChange();
            }}
            className="text-code"
          />
          </div>
          {toolbar !== 'top' && dock}
        </div>
      </div>
      {view && showToc && headings.length >= 2 && (
        <aside className="sticky top-0 hidden w-60 shrink-0 self-start @4xl:block">
          <Toc
            headings={headings}
            scroller={scroller}
            topOf={(i) => view.documentTop + view.lineBlockAt(Math.min(headings[i]!.pos, view.state.doc.length)).top}
            scrollTo={(i) => {
              const pos = Math.min(headings[i]!.pos, view.state.doc.length);
              view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
            }}
          />
        </aside>
      )}
    </>
  );
}

/** A button of the Markdown dock: with `label` only an icon (the name is read out), else icon and word. */
function DockButton({ children, onClick, title, label, pressed, disabled }: { children: ReactNode; onClick: () => void; title?: string; label?: string; pressed?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={cx(
        'flex h-9 shrink-0 items-center gap-1.5 rounded-full text-[0.8125rem] font-medium disabled:opacity-40 [&>svg]:h-4 [&>svg]:w-4',
        label ? 'w-9 justify-center' : 'px-3',
        pressed ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
