// Instant search in the sidebar: results while typing, grouped into folders, notes (title
// matches) and content (snippets). Left click/Enter opens in the current tab, middle click or
// Ctrl/Cmd(+Enter) in a new tab, right click shows more actions incl. "Im Baum anzeigen".
// SEE-DOC: docs/PLAN.md §3b
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon, ExternalLink, LocateFixed, Copy, CornerDownLeft, Columns2, PanelLeft } from 'lucide-react';
import { api, type Mount, type SearchHit } from '../api';
import { t } from '../i18n';
import { useWorkspace } from '../store';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger, cx } from '../ui';
import { EntryIcon } from './Tree';
import { copyWithToast } from '../clipboard';
import { fullPath, noteNameIn } from '../names';

export interface SearchHandle {
  focus(): void;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

export const SearchBox = forwardRef<SearchHandle, { mounts: Mount[]; onSearchPage?: (q: string) => void }>(function SearchBox({ mounts, onSearchPage }, ref) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const query = useDebounced(q.trim(), 100);
  const { openNote, revealInTree } = useWorkspace.getState();
  useImperativeHandle(ref, () => ({ focus: () => input.current?.select() }));

  const result = useQuery({ queryKey: ['search', query], queryFn: () => api.search(query), enabled: query.length > 0, placeholderData: (p) => p });
  const groups = useMemo(() => {
    const r = result.data;
    if (!r || !query) return [];
    return [
      { label: t('Ordner'), hits: r.folders },
      { label: t('Notizen'), hits: r.notes },
      { label: t('Inhalt'), hits: r.content },
    ].filter((g) => g.hits.length);
  }, [result.data, query]);
  const flat = groups.flatMap((g) => g.hits);
  const mountName = (id: string) => mounts.find((m) => m.id === id)?.name ?? '';
  const folderNote = (id: string) => mounts.find((m) => m.id === id)?.options.folderNote ?? 'index.md';

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('[role="menu"]')) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const go = (hit: SearchHit, mode: 'current' | 'new' | 'background') => {
    if (hit.kind === 'dir') {
      revealInTree(hit.mountId, hit.path);
      // A folder with a folder note opens it; otherwise revealing is all we can do.
      const notePath = `${hit.path}/${folderNote(hit.mountId)}`;
      void api
        .note(hit.mountId, notePath)
        .then(() => openNote(hit.mountId, notePath, hit.title, { newTab: mode !== 'current', background: mode === 'background' }))
        .catch(() => undefined);
    } else {
      openNote(hit.mountId, hit.path, hit.title, { newTab: mode !== 'current', background: mode === 'background' });
    }
    if (mode !== 'background') setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && flat[active]) {
      e.preventDefault();
      go(flat[active], e.ctrlKey || e.metaKey ? 'new' : 'current');
    } else if (e.key === 'Escape') {
      setOpen(false);
      input.current?.blur();
    }
  };

  let index = -1;
  return (
    <div ref={box} className="relative">
      <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft">
        <SearchIcon className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => q && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('Suchen …')}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
          aria-label={t('Notizen durchsuchen')}
        />
        <kbd className="hidden rounded border border-line px-1 text-[0.625rem] text-fg-faint sm:block" title={t('Strg+K öffnet die Befehlspalette')}>
          {t('Strg P')}
        </kbd>
      </div>
      {open && query && (
        <div className="absolute left-0 top-9 z-30 w-[min(460px,calc(100vw-24px))] overflow-hidden rounded-lg border border-line bg-bg shadow-pop">
          <div className="max-h-[70vh] overflow-y-auto py-1">
            {groups.length === 0 && <div className="px-3 py-3 text-sm text-fg-muted">{result.isFetching ? t('Suche …') : t('Keine Treffer')}</div>}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-faint">{g.label}</div>
                {g.hits.map((hit) => {
                  index++;
                  const i = index;
                  return (
                    <ResultRow
                      key={`${g.label}:${hit.mountId}:${hit.path}`}
                      hit={hit}
                      active={i === active}
                      crumb={`${mountName(hit.mountId)}${hit.path.includes('/') ? ' / ' + hit.path.slice(0, hit.path.lastIndexOf('/')).replaceAll('/', ' / ') : ''}`}
                      onHover={() => setActive(i)}
                      onOpen={(mode) => go(hit, mode)}
                      onReveal={() => {
                        revealInTree(hit.mountId, hit.path);
                        setOpen(false);
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {/* Each hint wraps as a whole; mouse hints only where there is a mouse (touch: long press opens the menu). */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line px-3 py-1.5 text-[0.6875rem] text-fg-faint">
            <span className="flex items-center gap-1 whitespace-nowrap">
              <CornerDownLeft className="h-3 w-3" /> {t('öffnen')}
            </span>
            <span className="whitespace-nowrap [@media(hover:none)]:hidden">{t('Strg+Enter / Mittelklick: neuer Tab')}</span>
            <span className="whitespace-nowrap [@media(hover:none)]:hidden">{t('Rechtsklick: mehr')}</span>
            <span className="hidden whitespace-nowrap [@media(hover:none)]:inline">{t('Lange drücken: mehr')}</span>
            {onSearchPage && (
              <button
                className="ml-auto whitespace-nowrap text-accent hover:underline"
                onClick={() => {
                  setOpen(false);
                  onSearchPage(q.trim());
                }}
              >
                {t('Alle Ergebnisse …')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

function ResultRow({
  hit,
  active,
  crumb,
  onHover,
  onOpen,
  onReveal,
}: {
  hit: SearchHit;
  active: boolean;
  crumb: string;
  onHover: () => void;
  onOpen: (mode: 'current' | 'new' | 'background') => void;
  onReveal: () => void;
}) {
  const onClick = (e: MouseEvent) => onOpen(e.ctrlKey || e.metaKey ? 'new' : 'current');
  const onAux = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      onOpen('background');
    }
  };
  return (
    <ContextMenu>
      <ContextTrigger asChild>
        <div
          className={cx('mx-1 flex cursor-default gap-2 rounded-md px-2 py-1.5', active && 'bg-hover')}
          onMouseEnter={onHover}
          onClick={onClick}
          onAuxClick={onAux}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        >
          <span className="mt-0.5">
            <EntryIcon icon={hit.icon} isDir={hit.kind === 'dir'} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{noteNameIn(hit.mountId, hit.path)}</div>
            <div className="truncate text-[0.6875rem] text-fg-faint">{crumb}</div>
            {hit.snippet && <div className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{highlight(hit.snippet)}</div>}
          </div>
        </div>
      </ContextTrigger>
      <ContextContent>
        <ContextItem icon={<CornerDownLeft />} onSelect={() => onOpen('current')} shortcut={t('Klick')}>
          {t('Öffnen')}
        </ContextItem>
        <ContextItem icon={<ExternalLink />} onSelect={() => onOpen('new')} shortcut={t('Mittelklick')}>
          {t('In neuem Tab öffnen')}
        </ContextItem>
        {hit.kind === 'file' && (
          <ContextItem icon={<Columns2 />} onSelect={() => useWorkspace.getState().openSplit(hit.mountId, hit.path, hit.title)}>
            {t('Rechts daneben öffnen')}
          </ContextItem>
        )}
        {hit.kind === 'file' && (
          <ContextItem icon={<PanelLeft />} onSelect={() => useWorkspace.getState().openSplit(hit.mountId, hit.path, hit.title, 'left')}>
            {t('Links daneben öffnen')}
          </ContextItem>
        )}
        <ContextItem icon={<LocateFixed />} onSelect={onReveal}>
          {t('Im Baum anzeigen')}
        </ContextItem>
        <ContextSeparator />
        <ContextItem icon={<Copy />} onSelect={() => void copyWithToast(fullPath(hit.mountId, hit.path))}>
          {t('Pfad kopieren')}
        </ContextItem>
      </ContextContent>
    </ContextMenu>
  );
}

/** Renders FTS snippet markers (\u0001 … \u0002) as <mark>. */
export function highlight(snippet: string): ReactNode[] {
  return snippet.split('\u0001').flatMap((part, i) => {
    if (i === 0) return [part];
    const [hit, rest] = part.split('\u0002');
    return [
      <mark key={i} className="hit">
        {hit}
      </mark>,
      rest ?? '',
    ];
  });
}
