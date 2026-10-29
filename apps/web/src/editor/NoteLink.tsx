// Note link autocomplete: type "[[" and a few letters, pick a note — inserted as a normal
// relative Markdown link (`[Titel](../ordner/notiz.md)`, AD-006), so it works everywhere.
import { Extension } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { FileText } from 'lucide-react';
import { formatLink } from '@kaveyl-wiki/core';
import { api, type SearchHit } from '../api';
import { cx } from '../ui';
import { popupRenderer, useActiveIntoView, type MenuHandle } from './SlashMenu';
import { noteNameIn } from '../names';
import { t } from '../i18n';

const NOTE_LINK_KEY = new PluginKey('noteLinkSuggestion');

export interface NoteLinkOptions {
  mountId: string;
  notePath: string;
  folderNote: string;
}

/** Link destination from `fromNote` to `target` in house style (relative, with `.md`). */
export function noteHref(fromNote: string, target: string, folderNote: string): string {
  return formatLink('x.md', fromNote, target, folderNote, null);
}

const NoteList = forwardRef<MenuHandle, SuggestionProps<SearchHit>>(function NoteList({ items, command, query }, ref) {
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
        if (item) command(item);
        return !!item;
      }
      return false;
    },
  }));
  if (!items.length)
    return (
      <div className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg-muted shadow-pop">
        {query ? t('Keine Notiz gefunden') : t('Titel der Notiz tippen …')}
      </div>
    );
  return (
    <div ref={listRef} className="max-h-80 w-80 overflow-y-auto rounded-lg border border-line bg-bg p-1 shadow-pop" role="listbox" aria-label={t('Notiz verlinken')}>
      {items.map((item, i) => (
        <button
          key={item.path}
          role="option"
          aria-selected={i === active}
          className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', i === active && 'bg-hover')}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            command(item);
          }}
        >
          <span className="shrink-0 text-fg-faint">{item.icon?.startsWith('emoji:') ? item.icon.slice(6) : <FileText className="h-4 w-4" />}</span>
          <span className="min-w-0">
            <span className="block truncate text-sm">{noteNameIn(item.mountId, item.path)}</span>
            <span className="block truncate text-xs text-fg-faint">{item.path}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

export const NoteLink = Extension.create<NoteLinkOptions>({
  name: 'noteLink',
  addOptions() {
    return { mountId: '', notePath: '', folderNote: 'index.md' };
  },
  addProseMirrorPlugins() {
    const { mountId, notePath, folderNote } = this.options;
    return [
      Suggestion<SearchHit>({
        editor: this.editor,
        char: '[[',
        allowSpaces: true,
        // Own plugin key: two Suggestion plugins must not share the default key.
        pluginKey: NOTE_LINK_KEY,
        items: async ({ query }) => {
          if (!query.trim()) return [];
          const res = await api.search(query, 12).catch(() => null);
          if (!res) return [];
          const seen = new Set<string>();
          return [...res.notes, ...res.content].filter((h) => h.kind === 'file' && h.mountId === mountId && h.path !== notePath && !seen.has(h.path) && seen.add(h.path)).slice(0, 8);
        },
        command: ({ editor, range, props }) => {
          const href = noteHref(notePath, props.path, folderNote);
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({ type: 'text', text: props.title, marks: [{ type: 'link', attrs: { href } }] })
            // Text typed next must not extend the link (the link mark is inclusive).
            .unsetMark('link')
            .run();
        },
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        render: () => popupRenderer(NoteList),
      }),
    ];
  },
});
