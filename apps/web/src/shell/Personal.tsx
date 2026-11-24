// Sidebar sections above the sources: favorites and "recent" (opened by me / changed by anyone).
import { NewForYou, useWatches } from './Watch';
import { useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Bell, ChevronRight, Star, StarOff, Clock, ExternalLink, Columns2, LocateFixed, PanelLeft } from 'lucide-react';
import { api, type Mount } from '../api';
import { t } from '../i18n';
import { present, usePersonal, type NoteRef } from '../personal';
import { nodeKey, useWorkspace } from '../store';
import { usePrefs } from '../prefs';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger, cx } from '../ui';
import { EntryIcon } from './Tree';
import { noteNameIn } from '../names';
import { isMenuKey, openContextMenu } from './treeKeys';

const FOCUS_RING = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/**
 * Own icon of a note or folder, read from the sidebar tree already loaded for its source (no request of its own) –
 * favorites and „geöffnet“ only remember mount and path, „geändert“ gets the icon from the server.
 */
function useTreeIcon(mountId: string, path: string, skip: boolean): string | null {
  const tree = useQuery({ queryKey: ['tree', mountId], queryFn: () => api.tree(mountId), enabled: false });
  if (skip) return null;
  return tree.data?.find((e) => e.path === path)?.icon ?? null;
}

function Row({ item, mountName, icon, chip }: { item: NoteRef; mountName: string; icon?: string | null; chip?: boolean }) {
  const treeIcon = useTreeIcon(item.mountId, item.path, icon !== undefined);
  const openNote = useWorkspace((s) => s.openNote);
  const favorite = usePersonal((s) => s.isFavorite(item.mountId, item.path));
  const { mountId, path, title, dir } = item;
  // A folder without a folder note has nothing to open: show it unfolded in the tree instead.
  const plainFolder = dir && !path.endsWith('.md');
  const open = (newTab: boolean, background = false) => {
    if (!plainFolder) return openNote(mountId, path, title, { newTab, background });
    useWorkspace.getState().revealInTree(mountId, path);
    useWorkspace.getState().toggle(nodeKey(mountId, path), true);
  };
  return (
    <ContextMenu>
      <ContextTrigger asChild>
        <button
          type="button"
          className={cx(
            chip
              ? 'flex h-6 max-w-full shrink-0 cursor-default items-center gap-1 rounded-full bg-bg pl-1.5 pr-2.5 text-[0.75rem] font-medium text-fg shadow-[0_1px_2px_rgba(30,24,72,0.08)] hover:bg-hover dark:bg-subtle'
              : 'flex min-h-[25px] w-full cursor-default items-center gap-1.5 rounded-lg pl-2 pr-1 text-left text-tree hover:bg-hover',
            FOCUS_RING,
          )}
          title={`${mountName} / ${path}`}
          onClick={(e) => open(e.ctrlKey || e.metaKey)}
          onAuxClick={(e) => e.button === 1 && open(true, true)}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onKeyDown={(e) => {
            if (!isMenuKey(e)) return;
            e.preventDefault();
            openContextMenu(e.currentTarget);
          }}
        >
          {chip ? <Star className="h-3 w-3 shrink-0 fill-current text-warn" aria-hidden /> : <EntryIcon icon={icon !== undefined ? icon : treeIcon} isDir={!!dir} />}
          {/* Same folder structures recur across repos: name the source, like the KI-Freigaben list. */}
          <span className="flex-1 truncate">
            <span>{noteNameIn(mountId, path)}</span>
            {mountName && !chip && <span className="text-fg-faint"> ({mountName})</span>}
          </span>
        </button>
      </ContextTrigger>
      <ContextContent>
        {!plainFolder && (
          <>
            <ContextItem icon={<ExternalLink />} onSelect={() => openNote(mountId, path, title, { newTab: true })} shortcut={t('Strg+Klick')}>
              {t('In neuem Tab öffnen')}
            </ContextItem>
            <ContextItem icon={<Columns2 />} onSelect={() => useWorkspace.getState().openSplit(mountId, path, title)}>
              {t('Rechts daneben öffnen')}
            </ContextItem>
            <ContextItem icon={<PanelLeft />} onSelect={() => useWorkspace.getState().openSplit(mountId, path, title, 'left')}>
              {t('Links daneben öffnen')}
            </ContextItem>
          </>
        )}
        <ContextItem icon={<LocateFixed />} onSelect={() => useWorkspace.getState().revealInTree(mountId, path)}>
          {t('Im Baum anzeigen')}
        </ContextItem>
        <ContextSeparator />
        <ContextItem icon={favorite ? <StarOff /> : <Star />} onSelect={() => usePersonal.getState().toggleFavorite({ mountId, path, title, dir })}>
          {favorite ? t('Aus Favoriten entfernen') : t('Zu Favoriten')}
        </ContextItem>
      </ContextContent>
    </ContextMenu>
  );
}

/** Picking a filter in a section header („geöffnet“, „Cloud“ …) also unfolds a collapsed section. */
export function unfoldSection(id: string) {
  const { collapsedSections, set } = usePrefs.getState();
  if (collapsedSections.includes(id)) set({ collapsedSections: collapsedSections.filter((x) => x !== id) });
}

/** `fixed`: the section fills a view of its own (sidebar switch „Zuletzt“, „KI-Freigaben“) – always open, a plain heading. */
export function Section({ id, title, icon, children, extra, fixed }: { id: string; title: string; icon: ReactNode; children: ReactNode; extra?: ReactNode; fixed?: boolean }) {
  const folded = usePrefs((p) => p.collapsedSections.includes(id));
  const collapsed = folded && !fixed;
  const set = usePrefs((p) => p.set);
  const toggle = () => {
    const cur = usePrefs.getState().collapsedSections;
    set({ collapsedSections: collapsed ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  if (fixed)
    return (
      <section className="mb-1" aria-label={title}>
        <div className="flex min-h-7 items-center gap-1.5 px-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-faint">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {extra}
        </div>
        {children}
      </section>
    );
  return (
    <div className="mb-1">
      <div className="group flex min-h-7 cursor-default items-center gap-1 rounded-lg px-1 text-tree font-semibold text-fg-muted hover:bg-hover" onClick={toggle}>
        {/* The click reaches the row's handler; the title stays outside (filters sit next to it). */}
        <button type="button" aria-label={title} aria-expanded={!collapsed} className={cx('flex items-center gap-1 self-stretch rounded', FOCUS_RING)}>
          <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
          {icon}
        </button>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {extra}
      </div>
      {!collapsed && children}
    </div>
  );
}

/** Favorites as small chips under the search: one click away without pushing the tree down (redesign 23.11.). */
export function FavoriteChips({ mounts }: { mounts: Mount[] }) {
  const { favorites } = usePersonal();
  const trees = useQueries({ queries: mounts.map((m) => ({ queryKey: ['tree', m.id], queryFn: () => api.tree(m.id), enabled: false })) });
  const treeOf = (id: string) => trees[mounts.findIndex((m) => m.id === id)]?.data;
  const shown = present(favorites, mounts.map((m) => m.id), treeOf);
  const name = (id: string) => mounts.find((m) => m.id === id)?.name ?? '';
  if (!shown.length) return null;
  // Two rows at most; more favorites scroll inside the strip.
  return (
    <div role="list" aria-label={t('Favoriten')} className="-mx-0.5 flex max-h-[3.5rem] flex-wrap gap-1 overflow-y-auto px-0.5 pb-0.5">
      {shown.map((f) => (
        <div role="listitem" key={`${f.mountId}:${f.path}`} className="min-w-0 max-w-full">
          <Row item={f} mountName={name(f.mountId)} chip />
        </div>
      ))}
    </div>
  );
}

/** „Neu für dich“ (AD-066): what changed in what one follows; opening a note reads it. Only when there is something. */
export function NewForYouSection({ mounts }: { mounts: Mount[] }) {
  const ids = mounts.map((m) => m.id);
  const unread = (useWatches().data?.unread ?? []).filter((u) => u.kind !== 'deleted' && ids.includes(u.mountId));
  if (!unread.length) return null;
  return (
    <Section id="new-for-you" title={t('Neu für dich')} icon={<Bell className="h-3.5 w-3.5" />} extra={<span className="rounded-full bg-accent px-1.5 text-[0.6875rem] text-accent-fg">{unread.length}</span>}>
      <NewForYou mounts={mounts} />
    </Section>
  );
}

/** The view „Zuletzt“ of the sidebar: opened by me / changed by anyone. */
export function RecentSection({ mounts }: { mounts: Mount[] }) {
  const { recent } = usePersonal();
  const [mode, setMode] = useState<'opened' | 'changed'>('opened');
  const changed = useQuery({ queryKey: ['recent-changes'], queryFn: () => api.recent(15), enabled: mode === 'changed', refetchInterval: 30_000 });
  const name = (id: string) => mounts.find((m) => m.id === id)?.name ?? '';
  // Hide entries whose note is gone, judged by the trees the sidebar already loaded (no request of its own).
  const trees = useQueries({ queries: mounts.map((m) => ({ queryKey: ['tree', m.id], queryFn: () => api.tree(m.id), enabled: false })) });
  const treeOf = (id: string) => trees[mounts.findIndex((m) => m.id === id)]?.data;
  const shownRecent = present(recent, mounts.map((m) => m.id), treeOf);
  const rows = mode === 'opened' ? shownRecent.slice(0, 15) : (changed.data ?? []);
  return (
    <Section
      id="recent"
      fixed
      title={t('Zuletzt')}
      icon={<Clock className="h-3.5 w-3.5" />}
      extra={
        <span className="flex text-[0.6875rem] font-normal normal-case tracking-normal">
          {(['opened', 'changed'] as const).map((m) => (
            // On touch the filters fill the 28 px header row (design-013); the desktop look stays.
            <button key={m} aria-pressed={mode === m} className={cx('rounded-full px-2 [@media(hover:none)]:min-h-7', mode === m ? 'bg-accent-soft font-medium text-accent' : 'text-fg-faint hover:text-fg')} onClick={() => setMode(m)}>
              {m === 'opened' ? t('geöffnet') : t('geändert')}
            </button>
          ))}
        </span>
      }
    >
      {mode === 'opened'
        ? rows.map((r) => <Row key={`${r.mountId}:${r.path}`} item={r} mountName={name(r.mountId)} />)
        : (changed.data ?? []).map((r) => <Row key={`${r.mountId}:${r.path}`} item={r} mountName={name(r.mountId)} icon={r.icon} />)}
      {mode === 'opened' && rows.length === 0 && <p className="px-2 py-1 text-xs text-fg-faint">{t('Noch nichts geöffnet.')}</p>}
      {mode === 'changed' && changed.data?.length === 0 && <p className="px-2 py-1 text-xs text-fg-faint">{t('Noch nichts geändert.')}</p>}
    </Section>
  );
}
