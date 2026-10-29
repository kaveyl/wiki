// Slash commands: type "/" to insert headings, lists, tables, code, quotes, rules and links.
import { Extension, ReactRenderer, type Editor, type Range } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode, type RefAttributes } from 'react';
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code2,
  Table,
  Minus,
  Link2,
  FileSymlink,
  Paperclip,
  Workflow,
  Sigma,
  MessageSquareWarning,
  ChevronsDownUp,
  PenTool,
} from 'lucide-react';
import { CALLOUT_KINDS, normalizeLinkInput } from '@kaveyl-wiki/core';
import { cx, inputDialog, promptDialog } from '../ui';
import { CALLOUT_LABELS } from './callouts';
import { openDrawing } from './Drawing';
import { t } from '../i18n';

interface SlashItem {
  title: string;
  hint: string;
  keywords: string[];
  icon: ReactNode;
  run: (editor: Editor, range: Range) => void;
}

/** File chooser per editor, registered by the note view (the slash command has no other context). */
export const attachHandlers = new WeakMap<Editor, () => void>();

const chain = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);
/** LaTeX in a Kaveyl Wiki input window; null/empty = cancelled. */
export const askLatex = async (value: string) =>
  (await promptDialog(t('Formel (LaTeX)'), { label: t('LaTeX'), value, mono: true, hint: t('z. B. \\frac{a}{b}, x^2, \\sqrt{2} – Vorschau nach dem Einfügen.'), confirmLabel: t('Übernehmen'), help: 'bearbeiten' }))?.trim() ?? null;
type Content = Parameters<Editor['commands']['insertContentAt']>[1];
/**
 * For commands that ask first (link, formula): the „/…“ goes at once (which also closes the slash
 * menu), then the input window asks, then the result lands where the slash was – a plain
 * insertContent would land at the start of the note, the window took the focus. Cancelled = nothing.
 */
const askAtSlash = (editor: Editor, range: Range, ask: () => Promise<Content | null>) => {
  chain(editor, range).run();
  const at = range.from;
  void ask().then((content) => {
    if (content) editor.chain().focus().insertContentAt(Math.min(at, editor.state.doc.content.size), content).run();
    else editor.commands.focus();
  });
};

export const SLASH_ITEMS: SlashItem[] = [
  { title: t('Text'), hint: t('Normaler Absatz'), keywords: ['text', 'absatz', 'paragraph'], icon: <Type />, run: (e, r) => chain(e, r).setParagraph().run() },
  { title: t('Überschrift 1'), hint: t('Große Überschrift'), keywords: ['h1', 'heading', 'titel', 'title', 'überschrift'], icon: <Heading1 />, run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
  { title: t('Überschrift 2'), hint: t('Mittlere Überschrift'), keywords: ['h2', 'heading', 'überschrift'], icon: <Heading2 />, run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
  { title: t('Überschrift 3'), hint: t('Kleine Überschrift'), keywords: ['h3', 'heading', 'überschrift'], icon: <Heading3 />, run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
  { title: t('Aufzählung'), hint: t('Liste mit Punkten'), keywords: ['aufzählung', 'liste', 'bullet', 'list', 'ul'], icon: <List />, run: (e, r) => chain(e, r).toggleBulletList().run() },
  { title: t('Nummerierte Liste'), hint: t('Liste mit Nummern'), keywords: ['liste', 'ordered', 'ol', 'nummer', 'numbered', 'list'], icon: <ListOrdered />, run: (e, r) => chain(e, r).toggleOrderedList().run() },
  { title: t('Checkliste'), hint: t('Aufgaben zum Abhaken'), keywords: ['todo', 'task', 'aufgabe', 'check', 'checkliste'], icon: <ListChecks />, run: (e, r) => chain(e, r).toggleTaskList().run() },
  { title: t('Zitat'), hint: t('Hervorgehobenes Zitat'), keywords: ['quote', 'blockquote', 'zitat'], icon: <Quote />, run: (e, r) => chain(e, r).toggleBlockquote().run() },
  { title: t('Codeblock'), hint: t('Code mit Syntax'), keywords: ['code', 'pre', 'codeblock'], icon: <Code2 />, run: (e, r) => chain(e, r).toggleCodeBlock().run() },
  {
    title: t('Tabelle'),
    hint: t('3 × 3 mit Kopfzeile'),
    keywords: ['table', 'tabelle'],
    icon: <Table />,
    run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  ...CALLOUT_KINDS.map(
    (kind): SlashItem => ({
      title: t('Hinweis-Box: {kind}', { kind: t(CALLOUT_LABELS[kind]) }),
      hint: t('> [!{kind}] – wird auch in Gitea/GitHub farbig', { kind }),
      keywords: ['callout', 'hinweis', 'box', 'alert', CALLOUT_LABELS[kind].toLowerCase(), t(CALLOUT_LABELS[kind]).toLowerCase(), kind.toLowerCase()],
      icon: <MessageSquareWarning />,
      run: (e, r) => chain(e, r).wrapIn('callout', { kind }).run(),
    }),
  ),
  {
    title: t('Aufklappbarer Block'),
    hint: t('Überschrift mit einklappbarem Inhalt'),
    keywords: ['details', 'aufklappen', 'toggle', 'collapse', 'collapsible', 'einklappen'],
    icon: <ChevronsDownUp />,
    run: (e, r) => chain(e, r).setDetails().run(),
  },
  { title: t('Trennlinie'), hint: t('Horizontale Linie'), keywords: ['hr', 'divider', 'linie', 'trennlinie', 'line', 'rule'], icon: <Minus />, run: (e, r) => chain(e, r).setHorizontalRule().run() },
  {
    title: t('Notiz verlinken'),
    hint: t('Notiz suchen und verlinken (auch mit [[)'),
    keywords: ['notiz', 'note', 'link', 'verlinken', 'wiki', '[['],
    icon: <FileSymlink />,
    run: (e, r) => chain(e, r).insertContent('[[').run(),
  },
  {
    title: t('Datei oder Bild'),
    hint: t('Hochladen nach assets/ neben der Notiz'),
    keywords: ['bild', 'image', 'datei', 'file', 'anhang', 'attachment', 'upload', 'pdf'],
    icon: <Paperclip />,
    run: (e, r) => {
      chain(e, r).run();
      attachHandlers.get(e)?.();
    },
  },
  {
    title: t('Zeichnung (Excalidraw)'),
    hint: t('Skizze, Whiteboard – als SVG in assets/, später wieder bearbeitbar'),
    keywords: ['zeichnung', 'excalidraw', 'skizze', 'whiteboard', 'drawing', 'sketch', 'malen'],
    icon: <PenTool />,
    run: (e, r) => {
      chain(e, r).run();
      openDrawing(e, undefined, e.state.selection.from);
    },
  },
  {
    title: t('Diagramm (Mermaid)'),
    hint: t('Flussdiagramm, Sequenz, Gantt … als Text'),
    keywords: ['mermaid', 'diagramm', 'diagram', 'flow', 'chart', 'sequence'],
    icon: <Workflow />,
    run: (e, r) =>
      chain(e, r)
        .insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  A[Start] --> B{Prüfen}\n  B -->|ja| C[Fertig]\n  B -->|nein| A' }] })
        .run(),
  },
  {
    title: t('Formel (eigene Zeile)'),
    hint: t('LaTeX, z. B. \\frac{a}{b} – als $$ … $$'),
    keywords: ['formel', 'mathe', 'math', 'latex', 'katex', 'gleichung', 'formula', 'equation'],
    icon: <Sigma />,
    run: (e, r) =>
      askAtSlash(e, r, async () => {
        const latex = await askLatex('a^2 + b^2 = c^2');
        return latex ? { type: 'mathBlock', attrs: { latex } } : null;
      }),
  },
  {
    title: t('Formel im Text'),
    hint: t('LaTeX im Satz – als $ … $'),
    keywords: ['formel', 'mathe', 'math', 'latex', 'inline', 'formula', 'equation'],
    icon: <Sigma />,
    run: (e, r) =>
      askAtSlash(e, r, async () => {
        const latex = await askLatex('x^2');
        return latex ? { type: 'mathInline', attrs: { latex } } : null;
      }),
  },
  {
    title: t('Link'),
    hint: t('URL oder Pfad zu einer Notiz'),
    keywords: ['link', 'url', 'verweis'],
    icon: <Link2 />,
    run: (e, r) =>
      askAtSlash(e, r, async () => {
        const v = await inputDialog({
          title: t('Link einfügen'),
          confirmLabel: t('Einfügen'),
          help: 'links-und-verlinkt-von',
          fields: [
            { name: 'href', label: t('Link-Ziel'), placeholder: t('https://… oder ../notiz.md'), hint: t('Web-Adresse (www.… reicht), E-Mail oder relativer Pfad zu einer Notiz. Notizen per Suche: [[ tippen.'), required: true, mono: true },
            { name: 'text', label: t('Linktext'), placeholder: t('leer = das Link-Ziel') },
          ],
        });
        const href = v?.href?.trim() ? normalizeLinkInput(v.href) : '';
        if (!href) return null;
        const text = v?.text?.trim() || href;
        return [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }, { type: 'text', text: ' ' }];
      }),
  },
];

/** Every word of the query in the title or at the start of a keyword: „/heading 2“ finds „Überschrift 2“ in German, too. */
export function filterItems(query: string): SlashItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) => words.every((w) => i.title.toLowerCase().includes(w) || i.keywords.some((k) => k.startsWith(w))));
}

/** Keeps the keyboard-selected entry of a scrolling popup list visible (its direct children are the entries). */
export function useActiveIntoView<T extends HTMLElement>(active: number) {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return ref;
}

const SlashList = forwardRef<MenuHandle, SuggestionProps<SlashItem>>(function SlashList({ items, command }, ref) {
  const [active, setActive] = useState(0);
  const listRef = useActiveIntoView<HTMLDivElement>(active);
  useEffect(() => setActive(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (event.key === 'ArrowDown') {
        setActive((a) => (a + 1) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setActive((a) => (a - 1 + items.length) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[active];
        // Nothing matches („/etc/hosts“): Enter stays a normal line break.
        if (!item) return false;
        command(item);
        return true;
      }
      return false;
    },
  }));
  if (!items.length) return <div className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg-muted shadow-pop">{t('Kein Befehl gefunden')}</div>;
  return (
    <div ref={listRef} className="max-h-80 w-64 overflow-y-auto rounded-lg border border-line bg-bg p-1 shadow-pop">
      {items.map((item, i) => (
        <button
          key={item.title}
          className={cx('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left', i === active && 'bg-hover')}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            command(item);
          }}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-line bg-bg text-fg-muted [&>svg]:h-4 [&>svg]:w-4">{item.icon}</span>
          <span className="min-w-0">
            <span className="block text-sm">{item.title}</span>
            <span className="block truncate text-xs text-fg-faint">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

export interface MenuHandle {
  onKeyDown(props: SuggestionKeyDownProps): boolean;
}

/** Floating popup for a suggestion list (slash commands, note links), placed below or above the cursor. */
export function popupRenderer<T>(List: ComponentType<SuggestionProps<T> & RefAttributes<MenuHandle>>) {
  let renderer: ReactRenderer<MenuHandle, SuggestionProps<T>> | null = null;
  let popup: HTMLDivElement | null = null;
  // The note went out of sight (another tab in front): the popup goes with it instead of floating over the other note.
  let seen: IntersectionObserver | null = null;
  const place = (props: SuggestionProps<T>) => {
    const rect = props.clientRect?.();
    if (!rect || !popup) return;
    const below = rect.bottom + 6 + 330 < window.innerHeight;
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 330)}px`;
    popup.style.top = below ? `${rect.bottom + 6}px` : '';
    popup.style.bottom = below ? '' : `${window.innerHeight - rect.top + 6}px`;
  };
  return {
    onStart(props: SuggestionProps<T>) {
      renderer = new ReactRenderer(List, { props, editor: props.editor });
      popup = document.createElement('div');
      popup.style.position = 'fixed';
      popup.style.zIndex = '60';
      popup.appendChild(renderer.element);
      document.body.appendChild(popup);
      place(props);
      const own = popup;
      seen = new IntersectionObserver(([e]) => (own.style.display = e?.isIntersecting ? '' : 'none'));
      seen.observe(props.editor.view.dom);
    },
    onUpdate(props: SuggestionProps<T>) {
      renderer?.updateProps(props);
      place(props);
    },
    onKeyDown(props: SuggestionKeyDownProps) {
      if (props.event.key === 'Escape') {
        popup?.remove();
        return true;
      }
      return renderer?.ref?.onKeyDown(props) ?? false;
    },
    onExit() {
      seen?.disconnect();
      seen = null;
      popup?.remove();
      renderer?.destroy();
      popup = null;
      renderer = null;
    },
  };
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        // „/Überschrift 2“ keeps filtering; prose after a slash with no match closes the menu.
        allowSpaces: true,
        items: ({ query }) => filterItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        allow: ({ state, range }) => {
          if (state.doc.resolve(range.from).parent.type.spec.code) return false;
          const query = state.doc.textBetween(range.from + 1, range.to);
          return !/\s/.test(query) || (!/^\s/.test(query) && filterItems(query.trim()).length > 0);
        },
        render: () => popupRenderer(SlashList),
      }),
    ];
  },
});
