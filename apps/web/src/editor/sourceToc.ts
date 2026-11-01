// Helpers for the Markdown source view (CodeMirror): the headings for the table of contents and the hint on the
// note's `id:` line. Only SourceEditor imports this module (it pulls in CodeMirror, SourceEditor.test.ts).
import { syntaxTree } from '@codemirror/language';
import { type EditorState, RangeSetBuilder, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { splitFrontmatter } from '@kaveyl-wiki/core';
import { t } from '../i18n';

export interface SourceHeading {
  level: number;
  text: string;
  /** Start of the heading in the document. */
  pos: number;
}

/** How far into the note a frontmatter block is looked for (a longer one counts as none – keeps typing cheap). */
const FRONTMATTER_MAX = 65_536;

/** End of a leading frontmatter block, 0 when there is none – the same rule as everywhere else (core, BOM included). */
export function frontmatterEnd(doc: Text): number {
  return splitFrontmatter(doc.sliceString(0, Math.min(doc.length, FRONTMATTER_MAX))).frontmatter.length;
}

/** Characters of a heading that are looked at, and entries in the list at most. */
const MAX_HEADING = 300;
export const MAX_ENTRIES = 1000;

/**
 * The readable text of a heading: without markers and the most common inline syntax, as the editor shows it. `raw` is
 * the heading's source; for a Setext heading (`setext`) its last line is the underline.
 */
export function headingText(raw: string, setext: boolean): string {
  // The underline goes first; then the text is bounded before any pattern runs – a heading of megabytes would
  // otherwise make the lazy patterns quadratic (security review 0.2.12, sec-001). The list shows one line anyway.
  let s = setext ? raw.slice(0, Math.max(0, raw.lastIndexOf('\n'))) : raw;
  s = s.slice(0, MAX_HEADING);
  s = setext ? s.replace(/\n/g, ' ') : s.replace(/^ {0,3}#{1,6}(?=\s|$)/, '').replace(/\s+#+\s*$/, '');
  s = s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

const LEVEL = /^(?:ATXHeading([1-6])|SetextHeading([12]))$/;

/**
 * Headings as the Markdown parser sees them, counted like the visual editor does (Toc.tsx): at the top level and in
 * quotes – not in lists, code blocks or the frontmatter. By default only what the view has parsed so far: forcing the
 * whole document here could block the tab on pathological input (the parser is not interruptible inside one block,
 * security review 0.2.12); the list grows as the background parse goes on.
 */
export function sourceHeadings(state: EditorState, tree: ReturnType<typeof syntaxTree> = syntaxTree(state)): SourceHeading[] {
  const skip = frontmatterEnd(state.doc);
  const out: SourceHeading[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === 'Document' || node.name === 'Blockquote') return out.length < MAX_ENTRIES;
      const m = LEVEL.exec(node.name);
      if (m && node.from >= skip && out.length < MAX_ENTRIES) {
        // Only the start of a long heading is read. A Setext heading: its text without the underline line, and an empty
        // line standing in for that underline.
        const end = m[2] ? state.doc.lineAt(node.to).from - 1 : node.to;
        const raw = state.doc.sliceString(node.from, Math.min(end, node.from + MAX_HEADING));
        const text = headingText(m[2] ? `${raw}\n` : raw, !!m[2]);
        if (text) out.push({ level: Number(m[1] ?? m[2]), text, pos: node.from });
      }
      return false;
    },
  });
  return out;
}

class IdHint extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-note-id-hint';
    span.textContent = t('← Kennung der Notiz – nicht ändern oder löschen');
    span.title = t('Daran erkennt Kaveyl Wiki die Notiz wieder, auch wenn sie außerhalb umbenannt oder verschoben wird. Rechte und KI-Freigaben, die direkt auf dieser Notiz liegen, hängen daran.');
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/** The frontmatter line `id: …` of the note (its line object), or null. */
export function idLine(doc: Text) {
  const end = frontmatterEnd(doc);
  for (let n = 2; end && n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.from >= end) break;
    if (/^id:\s*\S/.test(line.text)) return line;
  }
  return null;
}

function idDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const line = idLine(state.doc);
  if (line) {
    builder.add(line.from, line.from, Decoration.line({ class: 'cm-note-id' }));
    builder.add(line.to, line.to, Decoration.widget({ widget: new IdHint(), side: 1 }));
  }
  return builder.finish();
}

/** Dims the `id:` line of the frontmatter and says what it is for (Owner 30.10.: „Problem, wenn man die löscht?“). */
export const noteIdHint = [
  StateField.define<DecorationSet>({
    create: idDecorations,
    update: (deco, tr) => (tr.docChanged ? idDecorations(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  }),
  EditorView.baseTheme({
    '.cm-note-id': { opacity: '0.55' },
    '.cm-note-id-hint': { marginLeft: '1em', fontSize: '0.85em', fontStyle: 'italic', opacity: '0.9', cursor: 'help' },
  }),
];
