// The editor schema shared by the web editor and the server-side Markdown bridge.
// Anything Markdown can express that this schema cannot is carried through untouched
// as a `rawBlock` / `rawInline` node holding the original Markdown source.

import { Extension, Node, getSchema, type AnyExtension, type NodeViewRenderer } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import Code from '@tiptap/extension-code';
import { Details, DetailsSummary, DetailsContent } from '@tiptap/extension-details';

/** Paragraph alignment, written as `<div align="center">` around the paragraph (AD-019). */
export const ParagraphAlign = Extension.create({
  name: 'paragraphAlign',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          align: {
            default: null,
            parseHTML: (el: { getAttribute(name: string): string | null }) => el.getAttribute('data-align'),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.align ? { 'data-align': attrs.align, style: `text-align: ${String(attrs.align)}` } : {}),
          },
        },
      },
    ];
  },
});

export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { markdown: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-raw-block]' }];
  },
  renderHTML({ node }) {
    return ['div', { 'data-raw-block': '' }, ['pre', {}, node.attrs.markdown as string]];
  },
});

export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { markdown: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-raw-inline]' }];
  },
  renderHTML({ node }) {
    const md = node.attrs.markdown as string;
    // Dollar amounts kept raw so they never turn into math are shown as plain text.
    return ['span', { 'data-raw-inline': '', ...(md.startsWith('$') ? { 'data-plain': '' } : {}) }, md];
  },
});

/**
 * A soft line break of the source (a plain newline inside a paragraph). Kept as its own
 * node — never as "\n" inside text: ProseMirror turns newlines in text into hard breaks
 * whenever it re-reads the DOM (HardBreak is the schema's `linebreakReplacement`), which
 * would add a `\` to every such line in the file on the next save (HANDBOOK Stolperfallen).
 * Shown as a space, like CommonMark, Wiki.js, GitHub/Gitea and our HTML export (AD-036); a line
 * break that should show is a hard break (Shift+Enter).
 */
export const SoftBreak = Node.create({
  name: 'softBreak',
  group: 'inline',
  inline: true,
  selectable: false,
  parseHTML() {
    // Must win over HardBreak's plain `br` rule (priority 50); `br` = copied from older versions.
    return [
      { tag: 'span[data-soft-break]', priority: 60 },
      { tag: 'br[data-soft-break]', priority: 60 },
    ];
  },
  renderHTML() {
    // A leaf: ProseMirror makes it non-editable, so the caret steps over the space as one character.
    return ['span', { 'data-soft-break': '' }, ' '];
  },
  renderText() {
    return '\n';
  },
});

/** GitHub alert kinds (`> [!NOTE]` …), rendered by GitHub/Gitea as coloured callouts. */
export const CALLOUT_KINDS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** A GitHub alert: stored as a blockquote whose first line is `[!KIND]` (see from-mdast.ts). */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'NOTE',
        parseHTML: (el) => el.getAttribute('data-callout') ?? 'NOTE',
        renderHTML: (attrs) => ({ 'data-callout': attrs.kind as string }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, class: 'callout' }, 0];
  },
});

/** `$$ … $$` display math (KaTeX in the web app). Atom: edited as LaTeX source. */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-math-block]', getAttrs: (el) => ({ latex: (el as { textContent: string | null }).textContent ?? '' }) }];
  },
  renderHTML({ node }) {
    return ['div', { 'data-math-block': '' }, node.attrs.latex as string];
  },
});

/** `$ … $` inline math. */
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-math-inline]', getAttrs: (el) => ({ latex: (el as { textContent: string | null }).textContent ?? '' }) }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-math-inline': '' }, node.attrs.latex as string];
  },
});

/** File endings that are also top-level domains: a typed or pasted `Unterhaltung.md` or `notes.zip` is a file name, not a web address. */
const FILE_TLD = /\.(md|zip|mov|py|sh)$/i;

/** TipTap's rule for turning typed/pasted text into a link, plus: no bare host ending in a file ending (owner bug 25.10.). */
export function shouldAutoLink(url: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.includes('@'))) return true;
  const host = (url.includes('@') ? url.split('@').pop()! : url).split(/[/?#:]/)[0]!;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes('.')) return false;
  return /^www\./i.test(host) || !FILE_TLD.test(host);
}

export interface EditorExtensionOptions {
  /** Replaces StarterKit's code block (the web app passes a highlighting one with the same schema). */
  codeBlock?: AnyExtension;
  /** Replace the math nodes (the web app passes ones with a KaTeX node view, same schema). */
  mathBlock?: AnyExtension;
  mathInline?: AnyExtension;
  /** Screen reader name of a task list checkbox, from the task's text (the web app passes a translated one). */
  taskCheckboxLabel?: (text: string) => string;
}

export function editorExtensions(options: EditorExtensionOptions = {}): AnyExtension[] {
  return [
    // trailingNode off: it appends an empty paragraph to notes ending in a list/table/code,
    // which made merely opening a note look like an edit (HANDBOOK Stolperfallen).
    StarterKit.configure({
      underline: false,
      code: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, shouldAutoLink },
      ...(options.codeBlock ? { codeBlock: false } : {}),
    }),
    ...(options.codeBlock ? [options.codeBlock] : []),
    // Markdown allows `code` inside links/emphasis; TipTap's default code mark excludes all other marks.
    Code.extend({ excludes: '' }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true, ...(options.taskCheckboxLabel && { a11y: { checkboxLabel: (node: PMNode) => options.taskCheckboxLabel!(node.textContent) } }) }),
    Image.configure({ inline: true }),
    ParagraphAlign,
    Callout,
    options.mathBlock ?? MathBlock,
    options.mathInline ?? MathInline,
    // `<details open>` must survive a round trip, so `open` is part of the document — but
    // clicking the toggle only folds the view (persist: false), it never edits the file.
    Details.extend({
      addAttributes() {
        return {
          open: {
            default: false,
            parseHTML: (el: { hasAttribute(name: string): boolean }) => el.hasAttribute('open'),
            renderHTML: (attrs: Record<string, unknown>) => (attrs.open ? { open: '' } : {}),
          },
        };
      },
      // Tiptap's view forces the fold state to `attrs.open` on every update of the block, i.e. on
      // every keystroke inside it: a new (closed) block shut while its title was typed. The fold
      // state is view-only here — `open` only decides how a block starts.
      addNodeView() {
        const factory = this.parent?.();
        if (!factory) return null;
        const renderer: NodeViewRenderer = (props) => {
          const view = factory(props) as ReturnType<NodeViewRenderer> & { update?: unknown };
          return { ...view, update: (node: PMNode) => node.type === props.node.type };
        };
        return renderer;
      },
      // Enter in the title of a folded block: unfold it first, so the summary's Enter (Tiptap,
      // runs after this) goes into the content instead of jumping behind the block.
      // Extends Tiptap's own shortcuts (Backspace, Enter, arrows in the title) instead of replacing them.
      addKeyboardShortcuts() {
        const own = this.parent?.() ?? {};
        return {
          ...own,
          Enter: (props) => {
            const { $head } = props.editor.state.selection;
            if ($head.parent.type.name === 'detailsSummary') {
              // Structural DOM types: core is built without the DOM library (the server uses it too).
              type Folding = { classList: { contains(c: string): boolean }; querySelector(s: string): { click(): void } | null };
              const dom = props.editor.view.nodeDOM($head.before($head.depth - 1)) as unknown as Folding | null;
              if (dom && !dom.classList.contains('is-open')) dom.querySelector(':scope > button')?.click();
              // A new block brings an empty line: go there instead of adding another one in front of it —
              // otherwise that empty line stays last and „Enter on the empty last line leaves the block“ never fires.
              const first = $head.node($head.depth - 1).child(1)?.firstChild;
              if (first?.type.name === 'paragraph' && first.content.size === 0) return props.editor.chain().setTextSelection($head.after() + 2).scrollIntoView().run();
            }
            return own.Enter?.(props) ?? false;
          },
        };
      },
    }).configure({ persist: false }),
    DetailsSummary,
    DetailsContent,
    RawBlock,
    RawInline,
    SoftBreak,
  ];
}

let cached: Schema | undefined;

export function editorSchema(): Schema {
  cached ??= getSchema(editorExtensions());
  return cached;
}
