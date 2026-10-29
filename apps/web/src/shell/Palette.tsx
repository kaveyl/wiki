// Command palette (Ctrl+K): jump to notes and run commands from one input; plus the search page
// with filters and operators (tag:, in:, path:, seit:, "Phrase", -Ausschluss). SEE-DOC: docs/PLAN.md §3b
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Search as SearchIcon, ListFilter, Terminal } from 'lucide-react';
import { api, type Mount, type SearchHit } from '../api';
import { fmtDate, t, tn } from '../i18n';
import { useWorkspace } from '../store';
import { Modal, cx } from '../ui';
import { EntryIcon } from './Tree';
import { highlight, useDebounced } from './Search';
import { noteNameIn } from '../names';
import { tagChipClass, useTagColors } from '../editor/tagStyle';

/** Search page / tag browser visibility, reachable from anywhere (tags in notes, palette, sidebar). */
export const useSearchPage = create<{ isOpen: boolean; q: string; tagsOpen: boolean; open(q?: string): void; close(): void; openTags(open?: boolean): void }>((set) => ({
  isOpen: false,
  q: '',
  tagsOpen: false,
  open: (q = '') => set({ isOpen: true, q, tagsOpen: false }),
  close: () => set({ isOpen: false, q: '' }),
  openTags: (open = true) => set({ tagsOpen: open }),
}));

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string[];
  run: () => void;
}

type Item = { kind: 'note'; hit: SearchHit } | { kind: 'command'; command: Command } | { kind: 'all' };

export function CommandPalette({
  open,
  onClose,
  commands,
  mounts,
  onSearchPage,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  mounts: Mount[];
  onSearchPage: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const query = useDebounced(q.trim(), 80);
  const commandMode = q.startsWith('>');
  const notes = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search(query, 8),
    enabled: open && !!query && !commandMode,
    placeholderData: (p) => p,
  });
  const openNote = useWorkspace((s) => s.openNote);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    // A menu that just closed may hand focus back to its trigger after we opened — take it back.
    const timer = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]);

  const items = useMemo((): Item[] => {
    const text = (commandMode ? q.slice(1) : q).trim().toLowerCase();
    const cmds = commands.filter((c) => !text || c.label.toLowerCase().includes(text) || c.keywords?.some((k) => k.startsWith(text)));
    if (commandMode) return cmds.map((command) => ({ kind: 'command', command }));
    const hits = query && notes.data ? [...notes.data.notes, ...notes.data.content].filter((h, i, a) => a.findIndex((x) => x.mountId === h.mountId && x.path === h.path) === i) : [];
    return [
      ...hits.slice(0, 8).map((hit): Item => ({ kind: 'note', hit })),
      ...(query ? [{ kind: 'all' } as Item] : []),
      ...cmds.slice(0, query ? 4 : 12).map((command): Item => ({ kind: 'command', command })),
    ];
  }, [q, query, commandMode, commands, notes.data]);

  useEffect(() => setActive(0), [items.length, query]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (item: Item, newTab = false) => {
    onClose();
    if (item.kind === 'note') openNote(item.hit.mountId, item.hit.path, item.hit.title, { newTab });
    else if (item.kind === 'all') onSearchPage(q.trim());
    else item.command.run();
  };
  const mountName = (id: string) => mounts.find((m) => m.id === id)?.name ?? '';

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl bg-bg shadow-pop" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{t('Befehlspalette')}</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <SearchIcon className="h-4 w-4 text-fg-faint" />
            <input
              ref={input}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(items.length - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter' && items[active]) {
                  e.preventDefault();
                  run(items[active], e.ctrlKey || e.metaKey);
                }
              }}
              placeholder={t('Notiz suchen oder Befehl … („>“ nur Befehle)')}
              aria-label={t('Befehlspalette')}
              className="h-12 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-fg-faint"
            />
          </div>
          <div ref={list} className="max-h-[60vh] overflow-y-auto p-1" role="listbox" aria-label={t('Ergebnisse')}>
            {!items.length && <div className="px-3 py-3 text-sm text-fg-muted">{notes.isFetching ? t('Suche …') : t('Nichts gefunden')}</div>}
            {items.map((item, i) => (
              <div
                key={item.kind === 'note' ? `n:${item.hit.mountId}:${item.hit.path}` : item.kind === 'all' ? 'all' : `c:${item.command.id}`}
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                className={cx('flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2', i === active && 'bg-hover')}
                onMouseEnter={() => setActive(i)}
                onClick={(e) => run(item, e.ctrlKey || e.metaKey)}
              >
                {item.kind === 'note' ? (
                  <>
                    <EntryIcon icon={item.hit.icon} isDir={false} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{noteNameIn(item.hit.mountId, item.hit.path)}</span>
                      <span className="block truncate text-[0.6875rem] text-fg-faint">
                        {mountName(item.hit.mountId)} / {item.hit.path}
                      </span>
                    </span>
                  </>
                ) : item.kind === 'all' ? (
                  <>
                    <ListFilter className="h-4 w-4 text-fg-faint" />
                    <span className="flex-1 text-sm">{t('Alle Ergebnisse für „{q}“ mit Filtern', { q: q.trim() })}</span>
                  </>
                ) : (
                  <>
                    <span className="flex h-4 w-4 items-center justify-center text-fg-faint [&>svg]:h-4 [&>svg]:w-4">{item.command.icon}</span>
                    <span className="flex-1 text-sm">{item.command.label}</span>
                    {item.command.hint && <span className="text-xs text-fg-faint">{item.command.hint}</span>}
                  </>
                )}
                {i === active && <CornerDownLeft className="h-3.5 w-3.5 text-fg-faint" />}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[0.6875rem] text-fg-faint">
            <span>{t('↑↓ wählen · Enter öffnen · Strg+Enter neuer Tab')}</span>
            <span className="ml-auto flex items-center gap-1">
              <Terminal className="h-3 w-3" /> {t('„>“ nur Befehle')}
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const SINCE_OPTIONS: [string, string][] = [
  ['', t('beliebig')],
  ['1d', t('letzter Tag')],
  ['7d', t('letzte Woche')],
  ['30d', t('letzter Monat')],
  ['365d', t('letztes Jahr')],
];

/** Rebuilds the query string from the free text plus the filter controls. */
function compose(text: string, f: { mount: string; tag: string; path: string; since: string }): string {
  const strip = text.replace(/(^|\s)-?(in|quelle|tag|tags|path|pfad|seit|since|geändert):("[^"]*"|\S+)/gi, ' ').replace(/\s+/g, ' ').trim();
  const q = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  return [strip, f.mount && `in:${q(f.mount)}`, f.tag && `tag:${q(f.tag)}`, f.path && `path:${q(f.path)}`, f.since && `seit:${f.since}`].filter(Boolean).join(' ');
}

function readFilters(text: string) {
  const get = (...ops: string[]) => new RegExp(`(?:^|\\s)(?:${ops.join('|')}):("([^"]*)"|\\S+)`, 'i').exec(text);
  const val = (m: RegExpExecArray | null) => (m ? (m[2] ?? m[1]!) : '');
  return { mount: val(get('in', 'quelle')), tag: val(get('tag', 'tags')), path: val(get('path', 'pfad')), since: val(get('seit', 'since', 'geändert')) };
}

export function SearchPage({ open, initial, onClose, mounts }: { open: boolean; initial: string; onClose: () => void; mounts: Mount[] }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (open) setText(initial);
  }, [open, initial]);
  const query = useDebounced(text.trim(), 150);
  const result = useQuery({ queryKey: ['search-full', query], queryFn: () => api.searchFull(query), enabled: open && !!query, placeholderData: (p) => p });
  const filters = readFilters(text);
  const setFilter = (k: keyof typeof filters, v: string) => setText(compose(text, { ...filters, [k]: v }));
  const openNote = useWorkspace((s) => s.openNote);
  const mountName = (id: string) => mounts.find((m) => m.id === id)?.name ?? '';
  const colorOf = useTagColors();
  const hits = query ? (result.data?.hits ?? []) : [];

  return (
    <Modal help="notizen-finden-und-lesen" open={open} onOpenChange={(o) => !o && onClose()} title={t('Suche')} wide>
      <div className="flex flex-col gap-3">
        <div className="flex h-10 items-center gap-2 rounded-md border border-line px-2 focus-within:border-accent">
          <SearchIcon className="h-4 w-4 text-fg-faint" />
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t('z. B. backup tag:projekt in:wikijs path:docs/ "genaue Phrase" -alt')} aria-label={t('Suchanfrage')} className="h-full flex-1 bg-transparent text-sm outline-none" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label={t('Quelle')} className="h-7 rounded border border-line bg-bg px-1.5" value={filters.mount} onChange={(e) => setFilter('mount', e.target.value)}>
            <option value="">{t('Alle Quellen')}</option>
            {mounts.map((m) => (
              <option key={m.id} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <input aria-label={t('Tag')} placeholder={t('Tag')} className="h-7 w-28 rounded border border-line bg-bg px-1.5" value={filters.tag} onChange={(e) => setFilter('tag', e.target.value.trim())} />
          <input aria-label={t('Ordner')} placeholder={t('Ordner (z. B. docs/)')} className="h-7 w-40 rounded border border-line bg-bg px-1.5" value={filters.path} onChange={(e) => setFilter('path', e.target.value.trim())} />
          <select aria-label={t('Geändert')} className="h-7 rounded border border-line bg-bg px-1.5" value={SINCE_OPTIONS.some(([v]) => v === filters.since) ? filters.since : ''} onChange={(e) => setFilter('since', e.target.value)}>
            {SINCE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {t('Geändert: {when}', { when: l })}
              </option>
            ))}
          </select>
          <span className="ml-auto text-fg-faint">{query ? (hits.length >= 100 ? t('{n}+ Treffer', { n: hits.length }) : tn(hits.length, '1 Treffer', '{n} Treffer')) : ''}</span>
        </div>
        <div className="max-h-[55vh] min-h-24 overflow-y-auto">
          {!query && (
            <div className="space-y-1 p-2 text-sm text-fg-muted">
              <p>{t('Suche in Titeln, Pfaden, Tags und Inhalten aller Quellen. Operatoren:')}</p>
              <ul className="list-disc pl-5 text-xs">
                <li>
                  <code>{t('tag:projekt')}</code> {t('– nur Notizen mit diesem Tag')} · <code>in:wikijs</code> {t('– nur diese Quelle')} · <code>path:docs/</code>{' '}
                  {t('– nur dieser Ordner')}
                </li>
                <li>
                  <code>{t('seit:7d')}</code> {t('(h/d/w/m/y oder Datum) – geändert seit')} · <code>{t('"genaue Phrase"')}</code> · <code>{t('-wort')}</code>{' '}
                  {t('– ausschließen')}
                </li>
              </ul>
            </div>
          )}
          {query && !hits.length && <p className="p-2 text-sm text-fg-muted">{result.isFetching ? t('Suche …') : t('Keine Treffer')}</p>}
          {hits.map((h) => (
            <button
              key={`${h.mountId}:${h.path}`}
              className="flex w-full gap-2 rounded-md px-2 py-2 text-left hover:bg-hover"
              onClick={(e) => {
                openNote(h.mountId, h.path, h.title, { newTab: e.ctrlKey || e.metaKey });
                if (!(e.ctrlKey || e.metaKey)) onClose();
              }}
              onAuxClick={(e) => e.button === 1 && openNote(h.mountId, h.path, h.title, { newTab: true, background: true })}
            >
              <span className="mt-0.5">
                <EntryIcon icon={h.icon} isDir={false} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm">{noteNameIn(h.mountId, h.path)}</span>
                  {h.tags.map((tag) => (
                    <span key={tag} className={cx('rounded px-1 text-[0.625rem]', tagChipClass(colorOf(h.mountId, tag)))}>
                      #{tag}
                    </span>
                  ))}
                  <span className="ml-auto shrink-0 text-[0.6875rem] text-fg-faint">{fmtDate(h.mtime)}</span>
                </span>
                <span className="block truncate text-[0.6875rem] text-fg-faint">
                  {mountName(h.mountId)} / {h.path}
                </span>
                {h.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-fg-muted">{highlight(h.snippet)}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
