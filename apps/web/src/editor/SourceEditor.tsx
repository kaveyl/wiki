// The Markdown source view of a note (CodeMirror). Loaded only when someone opens it (seo-002) – NoteView imports
// it through lazyPart, never statically (SourceEditor.test.ts).
import { useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { NoteDocument } from '../api';
import { editorMaxWidth, usePrefs } from '../prefs';
import { Toc } from './Toc';
import { t } from '../i18n';
import { noteIdHint, sourceHeadings, type SourceHeading } from './sourceToc';

const EXTENSIONS = [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping, noteIdHint];
/**
 * Above this many characters the view shows plain text: CodeMirror's Markdown parser is quadratic inside one
 * paragraph and cannot be interrupted there (200 000 characters of `*a` block the tab ~5 s), and anyone who may
 * write could put such a note in front of every reader (security review 0.2.12).
 */
export const HIGHLIGHT_MAX = 100_000;
const PLAIN = [EditorView.lineWrapping, noteIdHint];

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
  const { editorWidth, showToc } = usePrefs();
  const [view, setView] = useState<EditorView | null>(null);
  const [headings, setHeadings] = useState<SourceHeading[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Headings follow typing and the parser (which finishes long documents in the background), a little delayed.
  const refresh = (v: EditorView, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHeadings(sourceHeadings(v.state)), delay);
  };
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="mx-auto px-4 py-6" style={{ maxWidth: editorWidth === 'normal' ? '960px' : editorMaxWidth(editorWidth) }}>
          {plain && <p className="mb-2 text-xs text-fg-muted">{t('Große Notiz: ohne Hervorhebung und Inhaltsverzeichnis, damit die Ansicht flüssig bleibt.')}</p>}
          <CodeMirror
            value={note.raw}
            theme={dark ? 'dark' : 'light'}
            editable={!readonly}
            basicSetup={{ foldGutter: false, highlightActiveLine: false }}
            extensions={plain ? PLAIN : EXTENSIONS}
            onCreateEditor={(v) => {
              setView(v);
              if (!plain) refresh(v, 0);
            }}
            onUpdate={(u) => {
              if (plain) return;
              // Positions follow every keystroke at once; the texts come with the delayed refresh.
              if (u.docChanged) setHeadings((list) => list.map((h) => ({ ...h, pos: u.changes.mapPos(h.pos) })));
              if (u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) refresh(u.view, 300);
            }}
            onChange={(v) => {
              value.current = v;
              onChange();
            }}
            className="overflow-hidden rounded-lg border border-line text-code"
          />
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
