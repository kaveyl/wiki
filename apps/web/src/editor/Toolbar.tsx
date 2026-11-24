// Visible formatting controls for the WYSIWYG editor: a toolbar above the note and a bubble
// menu on text selection — so it is obvious that notes are edited visually (Notion-like),
// not as Markdown source. Slash commands and shortcuts keep working in addition.
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEffect, useState, type ReactNode } from 'react';
import { EmojiButton } from './Emoji';
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link2,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code2,
  Minus,
  Table,
  Rows3,
  Columns3,
  Trash2,
  MessageSquareWarning,
  ChevronsDownUp,
  Paperclip,
  Paintbrush,
  AlignLeft,
  AlignCenter,
  AlignRight,
  PenTool,
  CircleHelp,
  ZoomIn,
  Heading1,
  Heading2,
  Heading3,
  Plus,
} from 'lucide-react';
import { openHelp } from '../help/help';
import { openLightbox } from './images';
import { CALLOUT_LABELS } from './callouts';
import { CALLOUT_KINDS, normalizeLinkInput } from '@kaveyl-wiki/core';
import * as DM from '@radix-ui/react-dropdown-menu';
import { DropdownContent, cx, promptDialog } from '../ui';
import { usePrefs } from '../prefs';
import { CODE_LANGUAGES, detectLanguage } from './highlight';
import { isDrawingSrc, openDrawing } from './Drawing';
import { t } from '../i18n';
import { scrollHint } from '../scrollHint';



/** Editors whose selection bubble stays hidden while the browser's context menu is open. */
const bubbleHidden = new WeakSet<Editor>();

/** Right-click outside links: the browser's menu (spell check) shows; the bubble steps aside until the next click or key. */
export function hideSelectionMenu(editor: Editor) {
  bubbleHidden.add(editor);
  editor.view.dispatch(editor.state.tr.setMeta('kaveyl-wiki-bubble', 'hide'));
  const back = () => {
    bubbleHidden.delete(editor);
    window.removeEventListener('mousedown', back, true);
    window.removeEventListener('keydown', back, true);
  };
  window.addEventListener('mousedown', back, true);
  window.addEventListener('keydown', back, true);
}

export async function promptLink(editor: Editor) {
  const current = editor.getAttributes('link').href as string | undefined;
  let href = (
    await promptDialog(current ? t('Link bearbeiten') : t('Link setzen'), {
      label: t('Link-Ziel'),
      value: current ?? '',
      placeholder: t('https://… oder ../seite.md'),
      hint: t('Web-Adresse (www.… reicht), E-Mail oder relativer Pfad zu einer Seite. Leer lassen entfernt den Link.'),
      mono: true,
      confirmLabel: t('Übernehmen'),
      help: 'links-und-verlinkt-von',
    })
  )?.trim();
  if (href === undefined) return;
  // www.… → https://…, name@domain → mailto:… (a bare address would count as a file next to the note).
  href = normalizeLinkInput(href);
  const chain = editor.chain().focus().extendMarkRange('link');
  if (!href) return void chain.unsetLink().run();
  if (editor.state.selection.empty && !current) {
    editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
  } else {
    chain.setLink({ href }).run();
  }
}

function useActive(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      language: (e.getAttributes('codeBlock').language as string | null) ?? '',
      // No language set: what the highlighting recognizes (shown, adopted with one click).
      detected: e.isActive('codeBlock') && !e.getAttributes('codeBlock').language ? detectLanguage(e.state.selection.$from.parent.textContent) : null,
      callout: e.isActive('callout') ? ((e.getAttributes('callout').kind as string) ?? 'NOTE') : null,
      details: e.isActive('details'),
      table: e.isActive('table'),
      block: e.isActive('heading', { level: 1 })
        ? 'h1'
        : e.isActive('heading', { level: 2 })
          ? 'h2'
          : e.isActive('heading', { level: 3 })
            ? 'h3'
            : e.isActive('heading')
              ? 'hx'
              : 'p',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
}

function Btn({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent [&>svg]:h-4 [&>svg]:w-4',
        active && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
      )}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />;

/**
 * Where the formatting tools sit (Einstellungen → Darstellung → Werkzeugleiste): `dock` floats at the bottom of the
 * note (two rows: the formatting row above can be folded with „Aa“), `top` is a floating bar above the note, `bar`
 * the full-width strip of narrow screens (phones keep it, the dock would clash with the on-screen keyboard).
 */
export type ToolbarPlace = 'dock' | 'top' | 'bar';

export function EditorToolbar({ editor, onAttach, extra, place = 'bar' }: { editor: Editor; onAttach?: () => void; extra?: ReactNode; place?: ToolbarPlace }) {
  const s = useActive(editor);
  const c = () => editor.chain().focus();
  const formatRow = usePrefs((p) => p.formatRow);
  const undoRedo = (
    <>
      <Btn label={t('Rückgängig (Strg+Z)')} disabled={!s.canUndo} onClick={() => c().undo().run()}>
        <Undo2 />
      </Btn>
      <Btn label={t('Wiederholen (Strg+Umschalt+Z)')} disabled={!s.canRedo} onClick={() => c().redo().run()}>
        <Redo2 />
      </Btn>
    </>
  );
  // In the top pill a quiet dropdown without a frame (draft „Überschrift 1 ⌄“); the narrow bar keeps the plain one.
  const blockSelect = (
    <select
      aria-label={t('Absatzformat')}
      className={cx(
        'h-7 shrink-0 text-xs text-fg',
        place === 'top'
          ? 'cursor-pointer appearance-none rounded-full bg-transparent bg-[length:12px] bg-[right_8px_center] bg-no-repeat pl-3 pr-7 font-medium hover:bg-hover [background-image:var(--select-chevron)]'
          : 'rounded-lg border border-line bg-bg px-1.5',
      )}
      value={s.block}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'p') c().setParagraph().run();
        else c().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run();
      }}
    >
      <option value="p">{t('Text')}</option>
      <option value="h1">{t('Überschrift 1')}</option>
      <option value="h2">{t('Überschrift 2')}</option>
      <option value="h3">{t('Überschrift 3')}</option>
      {s.block === 'hx' && <option value="hx">{t('Überschrift 4–6')}</option>}
    </select>
  );
  const headings = (
    <>
      {(
        [
          [1, t('Überschrift 1'), <Heading1 key="1" />],
          [2, t('Überschrift 2'), <Heading2 key="2" />],
          [3, t('Überschrift 3'), <Heading3 key="3" />],
        ] as const
      ).map(([level, label, icon]) => (
        <Btn key={level} label={label} active={s.block === `h${level}`} disabled={!editor.can().toggleHeading({ level })} onClick={() => c().toggleHeading({ level }).run()}>
          {icon}
        </Btn>
      ))}
    </>
  );
  const marks = (
    <>
      <Btn label={t('Fett (Strg+B)')} active={s.bold} onClick={() => c().toggleBold().run()}>
        <Bold />
      </Btn>
      <Btn label={t('Kursiv (Strg+I)')} active={s.italic} onClick={() => c().toggleItalic().run()}>
        <Italic />
      </Btn>
      <Btn label={t('Durchgestrichen')} active={s.strike} onClick={() => c().toggleStrike().run()}>
        <Strikethrough />
      </Btn>
      <Btn label={t('Inline-Code (Strg+E)')} active={s.code} onClick={() => c().toggleCode().run()}>
        <Code />
      </Btn>
      <Btn label={t('Link')} active={s.link} onClick={() => void promptLink(editor)}>
        <Link2 />
      </Btn>
      <FormatPainter editor={editor} />
      <EmojiButton editor={editor} />
    </>
  );
  const lists = (
    <>
      <Btn label={t('Aufzählung')} active={s.bullet} onClick={() => c().toggleBulletList().run()}>
        <List />
      </Btn>
      <Btn label={t('Nummerierte Liste')} active={s.ordered} onClick={() => c().toggleOrderedList().run()}>
        <ListOrdered />
      </Btn>
      <Btn label={t('Checkliste')} active={s.task} onClick={() => c().toggleTaskList().run()}>
        <ListChecks />
      </Btn>
    </>
  );
  const quote = (
    <Btn label={t('Zitat')} active={s.quote} onClick={() => c().toggleBlockquote().run()}>
      <Quote />
    </Btn>
  );
  const codeBlock = (
    <Btn label={t('Codeblock')} active={s.codeBlock} onClick={() => c().toggleCodeBlock().run()}>
      <Code2 />
    </Btn>
  );
  const callout = (
    <Btn label={t('Hinweis-Box (Callout)')} active={!!s.callout} onClick={() => (s.callout ? c().lift('callout').run() : c().wrapIn('callout', { kind: 'NOTE' }).run())}>
      <MessageSquareWarning />
    </Btn>
  );
  const details = (
    <Btn label={t('Aufklappbarer Block')} active={s.details} onClick={() => (s.details ? c().unsetDetails().run() : c().setDetails().run())}>
      <ChevronsDownUp />
    </Btn>
  );
  const attach = onAttach && (
    <Btn label={t('Datei oder Bild anhängen (auch per Ziehen oder Einfügen)')} onClick={onAttach}>
      <Paperclip />
    </Btn>
  );
  const rule = (
    <Btn label={t('Trennlinie')} onClick={() => c().setHorizontalRule().run()}>
      <Minus />
    </Btn>
  );
  const table = (
    <Btn label={t('Tabelle einfügen')} active={s.table} onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
      <Table />
    </Btn>
  );
  const help = (
    <Btn label={t('Hilfe zum Editor und Markdown-Spickzettel (F1: Handbuch)')} onClick={() => openHelp('bearbeiten')}>
      <CircleHelp />
    </Btn>
  );
  // Controls for what the cursor is in: code block, callout, table.
  const contextual = (
    <>
      {s.codeBlock && (
        <>
          <Sep />
          <select
            aria-label={t('Sprache des Codeblocks')}
            className="h-7 shrink-0 rounded-lg border border-line bg-bg px-1.5 text-xs text-fg"
            value={s.language}
            onChange={(e) => c().updateAttributes('codeBlock', { language: e.target.value || null }).run()}
          >
            <option value="">{s.detected ? t('Automatisch: {language}', { language: s.detected }) : t('Sprache: keine')}</option>
            {s.language && !CODE_LANGUAGES.includes(s.language) && <option value={s.language}>{s.language}</option>}
            {CODE_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          {s.detected && (
            <button
              type="button"
              className="h-7 shrink-0 rounded-lg px-1.5 text-xs text-accent hover:bg-hover"
              title={t('„{language}“ in die Datei schreiben – dann färben auch Gitea und VS Code', { language: s.detected })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => c().updateAttributes('codeBlock', { language: s.detected }).run()}
            >
              {t('übernehmen')}
            </button>
          )}
        </>
      )}
      {s.callout && (
        <>
          <Sep />
          <select
            aria-label={t('Art der Hinweis-Box')}
            className="h-7 shrink-0 rounded-lg border border-line bg-bg px-1.5 text-xs text-fg"
            value={s.callout}
            onChange={(e) => c().updateAttributes('callout', { kind: e.target.value }).run()}
          >
            {CALLOUT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(CALLOUT_LABELS[k])}
              </option>
            ))}
          </select>
        </>
      )}
      {s.table && (
        <>
          <Sep />
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => c().addRowBefore().run()} className="h-7 shrink-0 rounded-lg px-1.5 text-xs text-fg-muted hover:bg-hover" title={t('Zeile darüber einfügen')}>
            {t('+ Zeile oben')}
          </button>
          <Btn label={t('Zeile darunter einfügen')} onClick={() => c().addRowAfter().run()}>
            <Rows3 />
          </Btn>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => c().addColumnBefore().run()} className="h-7 shrink-0 rounded-lg px-1.5 text-xs text-fg-muted hover:bg-hover" title={t('Spalte links einfügen')}>
            {t('+ Spalte links')}
          </button>
          <Btn label={t('Spalte rechts einfügen')} onClick={() => c().addColumnAfter().run()}>
            <Columns3 />
          </Btn>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => c().deleteRow().run()} className="h-7 shrink-0 rounded-lg px-1.5 text-xs text-fg-muted hover:bg-hover">
            {t('− Zeile')}
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => c().deleteColumn().run()} className="h-7 shrink-0 rounded-lg px-1.5 text-xs text-fg-muted hover:bg-hover">
            {t('− Spalte')}
          </button>
          <Btn label={t('Tabelle löschen')} onClick={() => c().deleteTable().run()}>
            <Trash2 />
          </Btn>
        </>
      )}
    </>
  );

  if (place === 'dock') {
    const upper = formatRow || s.codeBlock || !!s.callout || s.table;
    return (
      <div
        className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex flex-col items-center gap-2 px-4"
        role="toolbar"
        aria-label={t('Formatierung')}
        data-print="hide"
        data-dock=""
      >
        {upper && (
          <div ref={scrollHint} className="scroll-hint no-scrollbar pointer-events-auto flex h-11 max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-raised px-2 shadow-dock">
            {formatRow && (
              <>
                {headings}
                <Sep />
                {marks}
              </>
            )}
            {contextual}
          </div>
        )}
        <div ref={scrollHint} className="scroll-hint no-scrollbar pointer-events-auto flex h-12 max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-raised px-2 shadow-dock">
          <InsertMenu editor={editor} active={s} />
          <button
            type="button"
            aria-label={t('Formatzeile ein-/ausblenden')}
            aria-pressed={formatRow}
            title={t('Formatzeile ein-/ausblenden')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => usePrefs.getState().set({ formatRow: !formatRow })}
            className={cx('flex h-8 shrink-0 items-center rounded-full px-2.5 text-[0.8125rem] font-semibold', formatRow ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg')}
          >
            Aa
          </button>
          <Sep />
          <Btn label={t('Checkliste')} active={s.task} onClick={() => c().toggleTaskList().run()}>
            <ListChecks />
          </Btn>
          <Btn label={t('Aufzählung')} active={s.bullet} onClick={() => c().toggleBulletList().run()}>
            <List />
          </Btn>
          {callout}
          {table}
          {attach}
          {extra && (
            <>
              <Sep />
              {extra}
            </>
          )}
          <Sep />
          {undoRedo}
        </div>
      </div>
    );
  }

  const row = (
    <>
      {undoRedo}
      <Sep />
      {blockSelect}
      <Sep />
      {marks}
      <Sep />
      {lists}
      <Sep />
      {quote}
      {codeBlock}
      {callout}
      {details}
      {attach}
      {rule}
      {table}
      {contextual}
      {extra}
    </>
  );
  if (place === 'top')
    return (
      <div className="flex shrink-0 justify-center px-6 pb-1 pt-3" data-print="hide">
        {/* Wraps instead of scrolling (QA 24.11.: at 120 % the last buttons were cut off with no visible way to reach them). */}
        <div className="flex min-h-11 max-w-full flex-wrap items-center justify-center gap-0.5 rounded-[22px] bg-raised px-2 py-1 shadow-dock" role="toolbar" aria-label={t('Formatierung')}>
          {row}
          <span className="shrink-0 whitespace-nowrap pl-2 pr-1 text-[0.6875rem] text-fg-faint">{t('„/“ für weitere Befehle')}</span>
          {help}
        </div>
      </div>
    );
  return (
    <div ref={scrollHint} className="scroll-hint flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-soft px-3" role="toolbar" aria-label={t('Formatierung')}>
      {row}
      <span className="ml-auto shrink-0 pl-3 text-[0.6875rem] text-fg-faint">{t('„/“ für weitere Befehle')}</span>
      {help}
    </div>
  );
}

/** „+“ in the dock: the blocks that do not have a button of their own there, the help and the hint on „/“. */
function InsertMenu({ editor, active: s }: { editor: Editor; active: ReturnType<typeof useActive> }) {
  const c = () => editor.chain().focus();
  const item = 'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] outline-none data-[highlighted]:bg-hover [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-fg-muted';
  const entries: [string, ReactNode, () => void, boolean?][] = [
    [t('Nummerierte Liste'), <ListOrdered key="o" />, () => c().toggleOrderedList().run(), s.ordered],
    [t('Zitat'), <Quote key="q" />, () => c().toggleBlockquote().run(), s.quote],
    [t('Codeblock'), <Code2 key="c" />, () => c().toggleCodeBlock().run(), s.codeBlock],
    [t('Aufklappbarer Block'), <ChevronsDownUp key="d" />, () => (s.details ? c().unsetDetails().run() : c().setDetails().run()), s.details],
    [t('Trennlinie'), <Minus key="m" />, () => c().setHorizontalRule().run()],
  ];
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>
        <button
          type="button"
          aria-label={t('Block einfügen')}
          title={t('Block einfügen')}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover [&>svg]:h-[18px] [&>svg]:w-[18px]"
        >
          <Plus />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DropdownContent side="top" align="start" sideOffset={10} minWidth={220} className="z-50" onCloseAutoFocus={(e) => e.preventDefault()}>
          {entries.map(([label, icon, run, on]) => (
            <DM.Item key={label} className={cx(item, on && 'text-accent')} onSelect={run}>
              {icon}
              <span className="flex-1">{label}</span>
            </DM.Item>
          ))}
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item className={item} onSelect={() => openHelp('bearbeiten')}>
            <CircleHelp />
            <span className="flex-1">{t('Editor-Hilfe')}</span>
          </DM.Item>
          <div className="px-2 pb-1 pt-1.5 text-[0.6875rem] text-fg-faint">{t('„/“ für weitere Befehle')}</div>
        </DropdownContent>
      </DM.Portal>
    </DM.Root>
  );
}

const PAINT_MARKS = ['bold', 'italic', 'strike', 'code', 'link'] as const;

/**
 * "Format übertragen" (Word/Notion): picks up the marks at the cursor/selection, then applies
 * exactly those to the next text selected with the mouse (Esc cancels).
 */
function FormatPainter({ editor }: { editor: Editor }) {
  const [armed, setArmed] = useState<{ type: string; attrs: Record<string, unknown> }[] | null>(null);
  useEffect(() => {
    if (!armed) return;
    const dom = editor.view.dom;
    const apply = () =>
      setTimeout(() => {
        const { empty } = editor.state.selection;
        if (empty) return;
        const chain = editor.chain().focus();
        for (const m of PAINT_MARKS) chain.unsetMark(m);
        for (const m of armed) chain.setMark(m.type, m.attrs);
        chain.run();
        setArmed(null);
      });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setArmed(null);
    // Selecting with the keyboard (Shift+arrows) applies when Shift is released.
    const onKeyUp = (e: KeyboardEvent) => e.key === 'Shift' && apply();
    dom.addEventListener('mouseup', apply);
    dom.addEventListener('keyup', onKeyUp);
    window.addEventListener('keydown', onKey);
    dom.classList.add('format-painter');
    return () => {
      dom.removeEventListener('mouseup', apply);
      dom.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('keydown', onKey);
      dom.classList.remove('format-painter');
    };
  }, [armed, editor]);
  const pick = () => {
    const { from, empty, $from } = editor.state.selection;
    const marks = empty ? (editor.state.storedMarks ?? $from.marks()) : (editor.state.doc.nodeAt(from)?.marks ?? []);
    setArmed(marks.filter((m) => (PAINT_MARKS as readonly string[]).includes(m.type.name)).map((m) => ({ type: m.type.name, attrs: m.attrs })));
  };
  return (
    <Btn label={armed ? t('Format übertragen: jetzt Zieltext markieren (Esc bricht ab)') : t('Format übertragen')} active={!!armed} onClick={() => (armed ? setArmed(null) : pick())}>
      <Paintbrush />
    </Btn>
  );
}

/** Small inline menu shown on text selection. */
export function SelectionMenu({ editor, extra }: { editor: Editor; extra?: ReactNode }) {
  const s = useActive(editor);
  const c = () => editor.chain().focus();
  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: e, state }) => e.isEditable && !bubbleHidden.has(e) && !state.selection.empty && !e.isActive('codeBlock') && !e.isActive('image')}
      className="flex items-center gap-0.5 rounded-lg border border-line bg-bg p-1 shadow-pop"
    >
      <Btn label={t('Fett')} active={s.bold} onClick={() => c().toggleBold().run()}>
        <Bold />
      </Btn>
      <Btn label={t('Kursiv')} active={s.italic} onClick={() => c().toggleItalic().run()}>
        <Italic />
      </Btn>
      <Btn label={t('Durchgestrichen')} active={s.strike} onClick={() => c().toggleStrike().run()}>
        <Strikethrough />
      </Btn>
      <Btn label={t('Inline-Code')} active={s.code} onClick={() => c().toggleCode().run()}>
        <Code />
      </Btn>
      <Btn label={t('Link')} active={s.link} onClick={() => void promptLink(editor)}>
        <Link2 />
      </Btn>
      <Sep />
      {/* The whole paragraph becomes a heading (owner 25.10.); again = text. Not where a heading may not stand (list item). */}
      {(
        [
          [1, t('Überschrift 1'), <Heading1 key="1" />],
          [2, t('Überschrift 2'), <Heading2 key="2" />],
          [3, t('Überschrift 3'), <Heading3 key="3" />],
        ] as const
      ).map(([level, label, icon]) => (
        <Btn key={level} label={label} active={s.block === `h${level}`} disabled={!editor.can().toggleHeading({ level })} onClick={() => c().toggleHeading({ level }).run()}>
          {icon}
        </Btn>
      ))}
      {extra}
    </BubbleMenu>
  );
}

/** The paragraph around the selected image, if it may carry an alignment (top level or in a collapsible block). */
function imageParagraph(editor: Editor): { pos: number; align: string | null } | null {
  const { $from } = editor.state.selection;
  const p = $from.parent;
  if (p.type.name !== 'paragraph' || $from.depth < 1) return null;
  const container = $from.node($from.depth - 1).type.name;
  if (container !== 'doc' && container !== 'detailsContent') return null;
  return { pos: $from.before(), align: (p.attrs.align as string | null) ?? null };
}

/** Presets relative to the image's own (natural) size, stored as pixels; "full" = column width. */
const IMAGE_SCALES = [25, 50, 75] as const;

/** Natural width of the selected image (rendered width while it has none, e.g. some SVGs). */
function naturalWidth(editor: Editor): number | null {
  const dom = editor.view.nodeDOM(editor.state.selection.from) as HTMLElement | null;
  const img = dom instanceof HTMLImageElement ? dom : (dom?.querySelector?.('img') ?? null);
  if (!img) return null;
  return img.naturalWidth || Math.round(img.getBoundingClientRect().width) || null;
}

/** Shown when an image is selected: alignment of its paragraph and the width. */
export function ImageMenu({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      width: e.isActive('image') ? ((e.getAttributes('image').width as string | null) ?? null) : null,
      paragraph: e.isActive('image') ? imageParagraph(e) : null,
      drawing: e.isActive('image') && isDrawingSrc(String(e.getAttributes('image').src ?? '')) ? String(e.getAttributes('image').src) : null,
    }),
  });
  // Replacing the image node drops its selection; select it again so the menu stays open.
  const setWidth = (width: string | null) => {
    const pos = editor.state.selection.from;
    editor.chain().focus().updateAttributes('image', { width, height: null }).setNodeSelection(pos).run();
  };
  const scaled = (pct: number) => {
    const n = naturalWidth(editor);
    return n ? String(Math.max(1, Math.round((n * pct) / 100))) : null;
  };
  const setAlign = (align: string) => {
    const p = imageParagraph(editor);
    if (!p) return;
    const node = editor.state.doc.nodeAt(p.pos);
    if (!node) return;
    // Keep the image selected (the menu stays open for the next click).
    const tr = editor.state.tr.setNodeMarkup(p.pos, undefined, { ...node.attrs, align: align === 'left' ? null : align });
    editor.view.dispatch(tr.setSelection(editor.state.selection.map(tr.doc, tr.mapping)));
    editor.commands.focus();
  };
  const align = s.paragraph?.align ?? 'left';
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="imageMenu"
      shouldShow={({ editor: e }) => e.isEditable && e.isActive('image')}
      className="flex items-center gap-0.5 rounded-lg border border-line bg-bg p-1 shadow-pop"
    >
      <Btn
        label={t('Groß anzeigen')}
        onClick={() => {
          const img = (editor.view.nodeDOM(editor.state.selection.from) as HTMLElement | null)?.querySelector('img');
          if (img?.src) openLightbox(img.currentSrc || img.src, img.alt);
        }}
      >
        <ZoomIn />
      </Btn>
      <span className="mx-1 h-5 w-px bg-line" />
      {s.drawing && (
        <>
          <button
            type="button"
            title={t('Zeichnung bearbeiten (oder Doppelklick)')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openDrawing(editor, s.drawing!)}
            className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-accent hover:bg-hover"
          >
            <PenTool className="h-3.5 w-3.5" /> {t('Zeichnung bearbeiten')}
          </button>
          <span className="mx-1 h-5 w-px bg-line" />
        </>
      )}
      {s.paragraph && (
        <>
          <Btn label={t('Links')} active={align === 'left'} onClick={() => setAlign('left')}>
            <AlignLeft />
          </Btn>
          <Btn label={t('Zentriert')} active={align === 'center'} onClick={() => setAlign('center')}>
            <AlignCenter />
          </Btn>
          <Btn label={t('Rechts')} active={align === 'right'} onClick={() => setAlign('right')}>
            <AlignRight />
          </Btn>
          <span className="mx-1 h-5 w-px bg-line" />
        </>
      )}
      {IMAGE_SCALES.map((pct) => {
        const active = !!s.width && s.width === scaled(pct);
        return (
          <button
            key={pct}
            type="button"
            aria-pressed={active}
            aria-label={t('{pct} % der Originalgröße', { pct })}
            title={t('{pct} % der Originalgröße', { pct })}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const w = scaled(pct);
              if (w) setWidth(w);
            }}
            className={cx('h-7 rounded px-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg', active && 'bg-active text-fg')}
          >
            {pct} %
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={!s.width}
        aria-label={t('Originalgröße')}
        title={t('Originalgröße (Markdown-Bild ohne Breite)')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setWidth(null)}
        className={cx('h-7 rounded px-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg', !s.width && 'bg-active text-fg')}
      >
        {t('Original')}
      </button>
      <button
        type="button"
        aria-pressed={s.width === '100%'}
        aria-label={t('Spaltenbreite')}
        title={t('So breit wie die Textspalte')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setWidth('100%')}
        className={cx('h-7 rounded px-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg', s.width === '100%' && 'bg-active text-fg')}
      >
        {t('Spaltenbreite')}
      </button>
      {s.width && s.width !== '100%' && <span className="px-1 text-[0.6875rem] tabular-nums text-fg-faint">{s.width.endsWith('%') ? s.width : `${s.width} px`}</span>}
    </BubbleMenu>
  );
}
