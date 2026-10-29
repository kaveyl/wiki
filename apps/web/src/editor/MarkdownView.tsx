// Read-only rendering of Markdown with the note editor's own nodes (tables, highlighted code,
// math, callouts) — for AI answers and suggestions, so they read like a note instead of raw text,
// and for the in-app help (normal size, its own links, pictures open large).
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { editorExtensions, externalUrl, isExternal, isScriptUrl, loadMarkdown } from '@kaveyl-wiki/core';
import { codeBlockWithPreview, MathBlockView_, MathInlineView_, taskCheckboxLabel } from './Rich';
import { lowlight } from './highlight';
import { cx } from '../ui';
import { openLightbox } from './images';
import { withoutForeignImages } from './ownImages';

const codeBlock = codeBlockWithPreview({ lowlight, defaultLanguage: null });
// Only the app's own pictures load here; others become links (sec-003).
const docOf = (markdown: string) => withoutForeignImages(loadMarkdown(markdown).doc, window.location.origin);

function showLarge(target: HTMLElement): boolean {
  if (!(target instanceof HTMLImageElement) || !target.src) return false;
  openLightbox(target.currentSrc || target.src, target.alt);
  return true;
}

export function MarkdownView({
  markdown,
  className,
  label,
  editorRef,
  compact = true,
  onLink,
}: {
  markdown: string;
  className?: string;
  label?: string;
  editorRef?: MutableRefObject<Editor | null>;
  /** Chat size (AI answers); the help uses the size of a note. */
  compact?: boolean;
  /** Links that are not web links (e.g. `#anchor` in the help); true = handled. */
  onLink?: (href: string) => boolean;
}) {
  const extensions = useMemo(() => editorExtensions({ codeBlock, mathBlock: MathBlockView_, mathInline: MathInlineView_, taskCheckboxLabel }), []);
  // The editor is created once; the handler must still see the latest callback.
  const linkRef = useRef(onLink);
  linkRef.current = onLink;
  const editor = useEditor({
    extensions,
    content: docOf(markdown),
    editable: false,
    editorProps: {
      attributes: { class: compact ? 'prose-note prose-compact' : 'prose-note', ...(label ? { 'aria-label': label } : {}) },
      // Pictures and links act on every click: ProseMirror counts a quick second or third one as a double or triple
      // click, and `handleClick` never sees it – the browser then followed the link itself, into a new tab (the links
      // carry target=_blank), which in the help looked random (owner 21.10.).
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target as HTMLElement;
          // A picture (also inside a link) opens large.
          if (showLarge(target)) {
            event.preventDefault();
            return true;
          }
          const href = target.closest('a')?.getAttribute('href');
          if (!href) return false;
          event.preventDefault();
          // Web links open in a new tab; anything else goes to the caller – nothing navigates the app away.
          if (isExternal(href)) {
            if (!isScriptUrl(href)) window.open(externalUrl(href), '_blank', 'noopener,noreferrer');
          } else linkRef.current?.(href);
          return true;
        },
      },
    },
  });
  if (editorRef) editorRef.current = editor;
  // Streaming answers grow word by word.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setContent(docOf(markdown), { emitUpdate: false });
  }, [editor, markdown]);
  return <EditorContent editor={editor} className={cx('min-w-0', className)} />;
}
