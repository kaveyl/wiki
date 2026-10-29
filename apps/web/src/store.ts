// Workspace UI state: tabs, expanded tree nodes, selection and "reveal in tree".
// Persisted per user on the server (/api/state/workspace), so tabs follow you across devices.
import { create } from 'zustand';
import { usePersonal } from './personal';

export interface Tab {
  id: string;
  mountId: string;
  path: string;
  title: string;
  /** Pinned tabs stay on the left and are never replaced by opening another note. */
  pinned?: boolean;
}

export const nodeKey = (mountId: string, path: string) => `${mountId}:${path}`;

interface Workspace {
  tabs: Tab[];
  activeId: string | null;
  expanded: Record<string, true>;
  selected: string | null;
  /** Incremented on every openNote (also for the note already open): the phone drawer closes. */
  opened: number;
  /** Incremented on every reveal so the tree scrolls even when the target is unchanged. */
  reveal: { key: string; nonce: number } | null;
  sidebarWidth: number;
  /** Tab shown in the right half next to the active tab (split view), or null. */
  splitId: string | null;
  /** Tree focus ("hoisting"): only this folder of one source is shown in the sidebar. */
  hoist: { mountId: string; path: string } | null;
  loaded: boolean;

  hydrate(state: Partial<Pick<Workspace, 'tabs' | 'activeId' | 'expanded' | 'sidebarWidth' | 'splitId' | 'hoist'>> | null): void;
  /** Opens a note in the right (or left) half next to the current one, reusing its tab if open. */
  openSplit(mountId: string, path: string, title: string, side?: 'left' | 'right'): void;
  closeSplit(): void;
  setHoist(hoist: { mountId: string; path: string } | null): void;
  openNote(mountId: string, path: string, title: string, opts?: { newTab?: boolean; background?: boolean }): void;
  activate(id: string): void;
  closeTab(id: string): void;
  /** Closes every unpinned tab except `keepId`. */
  closeOthers(keepId: string): void;
  setPinned(id: string, pinned: boolean): void;
  retitle(mountId: string, path: string, title: string): void;
  /** Re-points open tabs after a move; `toMountId` when the note went to another mount. */
  moved(mountId: string, from: string, to: string, toMountId?: string): void;
  removed(mountId: string, path: string): void;
  toggle(key: string, open?: boolean): void;
  /** Opens all given tree nodes at once. */
  expandMany(keys: string[]): void;
  /** Closes every tree node whose key matches. */
  collapseWhere(match: (key: string) => boolean): void;
  select(key: string | null): void;
  revealInTree(mountId: string, path: string): void;
  setSidebarWidth(w: number): void;
}

const newId = () => Math.random().toString(36).slice(2, 10);
const pinnedCount = (tabs: Tab[]) => tabs.filter((t) => t.pinned).length;
const under = (path: string, root: string) => path === root || path.startsWith(root + '/');

export const useWorkspace = create<Workspace>((set, get) => ({
  tabs: [],
  activeId: null,
  expanded: {},
  selected: null,
  reveal: null,
  opened: 0,
  sidebarWidth: 280,
  splitId: null,
  hoist: null,
  loaded: false,

  hydrate(state) {
    set({
      tabs: state?.tabs ?? [],
      activeId: state?.activeId ?? state?.tabs?.[0]?.id ?? null,
      expanded: state?.expanded ?? {},
      sidebarWidth: state?.sidebarWidth ?? 280,
      splitId: state?.tabs?.some((t) => t.id === state.splitId) ? (state.splitId ?? null) : null,
      hoist: state?.hoist ?? null,
      loaded: true,
    });
  },

  openNote(mountId, path, title, opts = {}) {
    set({ opened: get().opened + 1 });
    const { tabs, activeId } = get();
    const existing = tabs.find((t) => t.mountId === mountId && t.path === path);
    if (existing && !opts.newTab) {
      set({ activeId: existing.id, selected: nodeKey(mountId, path) });
      return;
    }
    const tab: Tab = { id: newId(), mountId, path, title };
    const idx = tabs.findIndex((t) => t.id === activeId);
    if (opts.newTab || idx < 0 || tabs[idx]?.pinned) {
      const next = [...tabs];
      // New tabs go after the active one, but never between pinned tabs.
      next.splice(Math.max(idx + 1, pinnedCount(tabs)), 0, tab);
      set({ tabs: next, activeId: opts.background ? (activeId ?? tab.id) : tab.id });
    } else {
      set({ tabs: tabs.map((t, i) => (i === idx ? { ...tab, id: t.id } : t)) });
    }
    if (!opts.background) set({ selected: nodeKey(mountId, path) });
  },

  openSplit(mountId, path, title, side = 'right') {
    const { tabs, activeId, splitId } = get();
    const recent = usePersonal.getState().recent;
    let next = tabs;
    const tabFor = (m: string, p: string, t: string) => {
      const found = next.find((x) => x.mountId === m && x.path === p);
      if (found) return found;
      const tab: Tab = { id: newId(), mountId: m, path: p, title: t };
      next = [...next, tab];
      return tab;
    };
    const target = tabFor(mountId, path, title);
    // The other half: the active note — or, when the target already is the active note (it was
    // just opened with a click), the current right half, the last visited note or another tab.
    let other: Tab | undefined = activeId !== target.id ? next.find((t) => t.id === activeId) : undefined;
    if (!other && splitId && splitId !== target.id) other = next.find((t) => t.id === splitId);
    if (!other) {
      const prev = recent.find((r) => !(r.mountId === mountId && r.path === path) && !r.dir);
      other = prev ? tabFor(prev.mountId, prev.path, prev.title) : next.find((t) => t.id !== target.id);
    }
    if (!other) {
      set({ tabs: next, activeId: target.id, splitId: null });
      return;
    }
    const [left, right] = side === 'right' ? [other, target] : [target, other];
    set({ tabs: next, activeId: left.id, splitId: right.id, selected: nodeKey(left.mountId, left.path) });
  },

  closeSplit() {
    set({ splitId: null });
  },

  setHoist(hoist) {
    set({ hoist });
    if (hoist) get().toggle(nodeKey(hoist.mountId, ''), true);
  },

  activate(id) {
    const tab = get().tabs.find((t) => t.id === id);
    // Activating the right-hand note swaps the two halves.
    const splitId = get().splitId === id ? get().activeId : get().splitId;
    set({ activeId: id, splitId, selected: tab ? nodeKey(tab.mountId, tab.path) : get().selected });
  },

  closeTab(id) {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    const splitId = get().splitId === id ? null : get().splitId;
    let nextActive = activeId === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : activeId;
    if (nextActive === splitId) nextActive = next.find((t) => t.id !== splitId)?.id ?? nextActive;
    set({ tabs: next, activeId: nextActive, splitId: nextActive === splitId ? null : splitId });
  },

  closeOthers(keepId) {
    for (const t of get().tabs) if (t.id !== keepId && !t.pinned) get().closeTab(t.id);
  },

  setPinned(id, pinned) {
    const tabs = get().tabs.map((t) => (t.id === id ? { ...t, pinned: pinned || undefined } : t));
    // Pinned first, otherwise the order stays (stable sort).
    set({ tabs: tabs.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)) });
  },

  retitle(mountId, path, title) {
    set({ tabs: get().tabs.map((t) => (t.mountId === mountId && t.path === path && t.title !== title ? { ...t, title } : t)) });
  },

  moved(mountId, from, to, toMountId = mountId) {
    usePersonal.getState().moved(mountId, from, to, toMountId);
    set({
      tabs: get().tabs.map((t) => (t.mountId === mountId && under(t.path, from) ? { ...t, mountId: toMountId, path: to + t.path.slice(from.length) } : t)),
    });
  },

  removed(mountId, path) {
    usePersonal.getState().removed(mountId, path);
    const { tabs, activeId } = get();
    const next = tabs.filter((t) => !(t.mountId === mountId && under(t.path, path)));
    set({ tabs: next, activeId: next.some((t) => t.id === activeId) ? activeId : (next[0]?.id ?? null) });
  },

  toggle(key, open) {
    const expanded = { ...get().expanded };
    if (open ?? !expanded[key]) expanded[key] = true;
    else delete expanded[key];
    set({ expanded });
  },

  expandMany(keys) {
    const expanded = { ...get().expanded };
    for (const k of keys) expanded[k] = true;
    set({ expanded });
  },

  collapseWhere(match) {
    set({ expanded: Object.fromEntries(Object.entries(get().expanded).filter(([k]) => !match(k))) as Record<string, true> });
  },

  select(key) {
    set({ selected: key });
  },

  revealInTree(mountId, path) {
    const expanded = { ...get().expanded, [nodeKey(mountId, '')]: true as const };
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) expanded[nodeKey(mountId, parts.slice(0, i).join('/'))] = true;
    const key = nodeKey(mountId, path);
    set({ expanded, selected: key, reveal: { key, nonce: (get().reveal?.nonce ?? 0) + 1 } });
  },

  setSidebarWidth(w) {
    set({ sidebarWidth: Math.max(200, Math.min(560, w)) });
  },
}));

/** Debounced persistence of the workspace to the server. */
export function persistWorkspace(save: (state: unknown) => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return useWorkspace.subscribe((s, prev) => {
    if (!s.loaded) return;
    if (
      s.tabs === prev.tabs &&
      s.activeId === prev.activeId &&
      s.expanded === prev.expanded &&
      s.sidebarWidth === prev.sidebarWidth &&
      s.splitId === prev.splitId &&
      s.hoist === prev.hoist
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(
      () => void save({ tabs: s.tabs, activeId: s.activeId, expanded: s.expanded, sidebarWidth: s.sidebarWidth, splitId: s.splitId, hoist: s.hoist }).catch(() => undefined),
      600,
    );
  });
}

export type SavedWorkspace = NonNullable<Parameters<ReturnType<typeof useWorkspace.getState>['hydrate']>[0]>;

/**
 * The stored workspace plus what was opened before it arrived (code-001b): stored tabs first, new ones after
 * (pinned tabs stay left); the tab the user looks at stays active, the stored layout (width) is restored.
 */
function withLocal(saved: SavedWorkspace | null): SavedWorkspace | null {
  const local = useWorkspace.getState();
  if (!local.tabs.length && !Object.keys(local.expanded).length && !local.hoist) return saved;
  const savedTabs = saved?.tabs ?? [];
  const sameNote = (a: Tab) => (b: Tab) => a.mountId === b.mountId && a.path === b.path;
  const all = [...savedTabs, ...local.tabs.filter((t) => !savedTabs.some(sameNote(t)))];
  const idOf = (id: string | null) => {
    const tab = local.tabs.find((t) => t.id === id);
    return tab ? (savedTabs.find(sameNote(tab))?.id ?? tab.id) : null;
  };
  return {
    ...saved,
    tabs: [...all.filter((t) => t.pinned), ...all.filter((t) => !t.pinned)],
    activeId: idOf(local.activeId) ?? saved?.activeId ?? null,
    expanded: { ...saved?.expanded, ...local.expanded },
    splitId: idOf(local.splitId) ?? saved?.splitId ?? null,
    hoist: local.hoist ?? saved?.hoist ?? null,
  };
}

/**
 * Restores the stored workspace, then keeps it saved. Only a stored null starts empty: after a failed load
 * nothing is written (the empty workspace would replace the stored tabs) and loading is retried (2 s, doubling
 * up to a minute). `ready` runs once after the first attempt, also after a failure. Returns the stop function.
 */
export function restoreWorkspace(load: () => Promise<SavedWorkspace | null>, save: (state: unknown) => Promise<unknown>, ready: () => void) {
  let stopped = false;
  let off: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let wait = 0;
  let first = true;
  // A fresh start (also after switching accounts): nothing of the previous user's workspace.
  useWorkspace.setState({ tabs: [], activeId: null, expanded: {}, splitId: null, hoist: null, loaded: false });
  const attempt = async () => {
    let state: SavedWorkspace | null;
    try {
      state = await load(); // null = never stored
    } catch {
      if (stopped) return;
      wait = Math.min(60_000, wait ? wait * 2 : 2_000);
      retry = setTimeout(() => void attempt(), wait);
      if (first) {
        first = false;
        ready();
      }
      return;
    }
    if (stopped) return;
    useWorkspace.getState().hydrate(withLocal(state));
    if (first) {
      first = false;
      ready();
    }
    off = persistWorkspace(save);
  };
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(retry);
    off?.();
  };
}
