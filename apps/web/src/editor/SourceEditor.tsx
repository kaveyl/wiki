// The Markdown source view of a note (CodeMirror). Loaded only when someone opens it (seo-002) – NoteView imports
// it through lazyPart, never statically (SourceEditor.test.ts).
import { useEffect, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import type { NoteDocument } from '../api';
import { editorMaxWidth, usePrefs } from '../prefs';

export function SourceEditor({ note, readonly, onChange, bind }: { note: NoteDocument; readonly: boolean; onChange: () => void; bind: (fn: () => { raw: string; key: string }) => void }) {
  const value = useRef(note.raw);
  useEffect(() => bind(() => ({ raw: value.current, key: value.current })), [bind]);
  const dark = document.documentElement.classList.contains('dark');
  const editorWidth = usePrefs((p) => p.editorWidth);
  return (
    <div className="mx-auto px-4 py-6" style={{ maxWidth: editorWidth === 'normal' ? '960px' : editorMaxWidth(editorWidth) }}>
      <CodeMirror
        value={note.raw}
        theme={dark ? 'dark' : 'light'}
        editable={!readonly}
        basicSetup={{ foldGutter: false, highlightActiveLine: false }}
        extensions={[markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping]}
        onChange={(v) => {
          value.current = v;
          onChange();
        }}
        className="overflow-hidden rounded-lg border border-line text-code"
      />
    </div>
  );
}
