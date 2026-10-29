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

function Row({ item, mountName, icon }: { item: NoteRef; mountName: string; icon?: string | null }) {
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
          className={cx('flex min-h-7 w-full cursor-default items-center gap-1.5 rounded-md pl-6 pr-1 text-left text-tree hover:bg-hover', FOCUS_RING)}
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
          <EntryIcon icon={icon !== undefined ? icon : treeIcon} isDir={!!dir} />
          {/* Same folder structures recur across repos: name the source, like the KI-Freigaben list. */}
          <span className="flex-1 truncate">
            <span>{noteNameIn(mountId, path)}</span>
            {mountName && <span className="text-fg-faint"> ({mountName})</span>}
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

export function Section({ id, title, icon, children, extra }: { id: string; title: string; icon: ReactNode; children: ReactNode; extra?: ReactNode }) {
  const collapsed = usePrefs((p) => p.collapsedSections.includes(id));
  const set = usePrefs((p) => p.set);
  const toggle = () => {
    const cur = usePrefs.getState().collapsedSections;
    set({ collapsedSections: collapsed ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  return (
    <div className="mb-1">
      <div className="group flex min-h-7 cursor-default items-center gap-1 rounded-md px-1 text-tree font-semibold text-fg-muted hover:bg-hover" onClick={toggle}>
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

export function PersonalSections({ mounts }: { mounts: Mount[] }) {
  const { favorites, recent } = usePersonal();
  const [mode, setMode] = useState<'opened' | 'changed'>('opened');
  const pick = (m: 'opened' | 'changed') => {
    setMode(m);
    unfoldSection('recent');
  };
  const changed = useQuery({ queryKey: ['recent-changes'], queryFn: () => api.recent(5), enabled: mode === 'changed', refetchInterval: 30_000 });
  const name = (id: string) => mounts.find((m) => m.id === id)?.name ?? '';
  // Hide entries whose note is gone, judged by the trees the sidebar already loaded (no request of its own).
  const trees = useQueries({ queries: mounts.map((m) => ({ queryKey: ['tree', m.id], queryFn: () => api.tree(m.id), enabled: false })) });
  const treeOf = (id: string) => trees[mounts.findIndex((m) => m.id === id)]?.data;
  const ids = mounts.map((m) => m.id);
  const shownFavorites = present(favorites, ids, treeOf);
  const shownRecent = present(recent, ids, treeOf);
  const unread = (useWatches().data?.unread ?? []).filter((u) => u.kind !== 'deleted' && ids.includes(u.mountId));
  return (
    <>
      {unread.length > 0 && (
        // „Beobachten“ (AD-066): what changed in what one follows; opening a note reads it.
        <Section id="new-for-you" title={t('Neu für dich')} icon={<Bell className="h-3.5 w-3.5" />} extra={<span className="rounded-full bg-accent px-1.5 text-[0.6875rem] text-accent-fg">{unread.length}</span>}>
          <NewForYou mounts={mounts} />
        </Section>
      )}
      {shownFavorites.length > 0 && (
        <Section id="favorites" title={t('Favoriten')} icon={<Star className="h-3.5 w-3.5" />}>
          {shownFavorites.map((f) => (
            <Row key={`${f.mountId}:${f.path}`} item={f} mountName={name(f.mountId)} />
          ))}
        </Section>
      )}
      {shownRecent.length > 0 && (
        <Section
          id="recent"
          title={t('Zuletzt')}
          icon={<Clock className="h-3.5 w-3.5" />}
          extra={
            <span className="flex text-[0.6875rem] font-normal" onClick={(e) => e.stopPropagation()}>
              {(['opened', 'changed'] as const).map((m) => (
                // On touch the filters fill the 28 px header row (design-013); the desktop look stays.
                <button key={m} aria-pressed={mode === m} className={cx('rounded px-1.5 [@media(hover:none)]:min-h-7', mode === m ? 'bg-active text-fg' : 'text-fg-faint hover:text-fg')} onClick={() => pick(m)}>
                  {m === 'opened' ? t('geöffnet') : t('geändert')}
                </button>
              ))}
            </span>
          }
        >
          {mode === 'opened'
            ? shownRecent.slice(0, 5).map((r) => <Row key={`${r.mountId}:${r.path}`} item={r} mountName={name(r.mountId)} />)
            : (changed.data ?? []).map((r) => <Row key={`${r.mountId}:${r.path}`} item={r} mountName={name(r.mountId)} icon={r.icon} />)}
        </Section>
      )}
    </>
  );
}
