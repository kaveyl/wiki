// Table of contents to the right of the note: headings from the editor document, click to
// jump, the heading currently in view is highlighted. SEE-DOC: docs/PLAN.md §3a
import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { cx } from '../ui';
import { t } from '../i18n';

interface Heading {
  level: number;
  text: string;
  pos: number;
}

function collect(editor: Editor): Heading[] {
  const out: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) out.push({ level: node.attrs.level as number, text, pos });
      return false;
    }
    return node.type.name === 'doc' || node.type.name === 'blockquote';
  });
  return out;
}

export function useHeadings(editor: Editor | null): Heading[] {
  const [headings, setHeadings] = useState<Heading[]>([]);
  useEffect(() => {
    if (!editor) return;
    const update = () => setHeadings(collect(editor));
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);
  return headings;
}

export function Toc({ editor, headings, scroller }: { editor: Editor; headings: Heading[]; scroller: HTMLElement | null }) {
  const [active, setActive] = useState(0);
  const pinnedUntil = useRef(0);
  const minLevel = Math.min(...headings.map((h) => h.level));

  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => {
      // After a click the clicked entry stays active while the smooth scroll runs.
      if (Date.now() < pinnedUntil.current) return;
      // At the end of the document the last headings can never reach the top: mark the last one.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) return setActive(headings.length - 1);
      const top = scroller.getBoundingClientRect().top + 90;
      let current = 0;
      headings.forEach((h, i) => {
        const dom = editor.view.nodeDOM(h.pos);
        if (dom instanceof HTMLElement && dom.getBoundingClientRect().top <= top) current = i;
      });
      setActive(current);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller, headings, editor]);

  const jump = (h: Heading, i: number) => {
    setActive(i);
    pinnedUntil.current = Date.now() + 900;
    const dom = editor.view.nodeDOM(h.pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav aria-label={t('Inhaltsverzeichnis')} className="max-h-[calc(100vh-7rem)] overflow-y-auto py-8 pr-4 text-[0.8125rem]">
      <div className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-faint">{t('Inhalt')}</div>
      <ul className="space-y-0.5 border-l border-line">
        {headings.map((h, i) => (
          <li key={`${h.pos}`}>
            <button
              className={cx(
                '-ml-px block w-full truncate border-l-2 py-1 pr-2 text-left leading-snug',
                i === active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
              )}
              style={{ paddingLeft: 10 + (h.level - minLevel) * 12 }}
              onClick={() => jump(h, i)}
              title={h.text}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
