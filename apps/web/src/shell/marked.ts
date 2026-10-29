// Several notes and folders marked in the sidebar tree (owner 28.10.), like in a file explorer: Ctrl/Cmd+click marks
// one, Shift+click a range, on touch „Auswählen“ shows boxes. Always within one source – the actions (send, share, move,
// export, delete) work per source. Kept apart from the open note („selected“ in the workspace store).
import { create } from 'zustand';
import type { AccessLevel } from '../api';

export interface MarkedItem {
  path: string;
  isDir: boolean;
  title: string;
  access?: AccessLevel;
  /** In an encrypted folder: never sent by mail. */
  encrypted?: boolean;
}

interface MarkedState {
  mountId: string | null;
  items: MarkedItem[];
  /** Where a Shift+click range starts. */
  anchor: string | null;
  /** Touch: a tap marks instead of opening (boxes before the rows). */
  picking: boolean;
  toggle(mountId: string, item: MarkedItem, alsoFirst?: MarkedItem | null): void;
  /** `from`: where to start without an anchor (the open row, as in Explorer). */
  range(mountId: string, rows: MarkedItem[], to: string, from?: string | null): void;
  pick(mountId: string, item: MarkedItem): void;
  clear(): void;
  /** A note or folder is gone (deleted, moved): no longer marked. */
  drop(mountId: string, path: string): void;
  /** The source's tree changed (sync, rename, rights): keep what still exists, with its current access. */
  sync(mountId: string, entries: { path: string; access?: AccessLevel }[] | null): void;
}

/** Toggles `item`; another source starts over. `alsoFirst` (the open row) joins when marking starts, as in Explorer. */
export function toggled(state: Pick<MarkedState, 'mountId' | 'items'>, mountId: string, item: MarkedItem, alsoFirst?: MarkedItem | null): MarkedItem[] {
  const base = state.mountId === mountId ? state.items : [];
  if (base.some((i) => i.path === item.path)) return base.filter((i) => i.path !== item.path);
  const first = !base.length && alsoFirst && alsoFirst.path !== item.path ? [alsoFirst] : [];
  return [...base, ...first, item];
}

/** Without what lies inside a marked folder – that goes along with the folder (move, delete). */
export function topmost(items: MarkedItem[]): MarkedItem[] {
  const dirs = items.filter((i) => i.isDir).map((i) => `${i.path}/`);
  return items.filter((i) => !dirs.some((d) => i.path.startsWith(d)));
}

/** The marks after a change of the tree: gone paths drop out, access is the current one. `null`: the source is gone. */
export function synced(items: MarkedItem[], entries: { path: string; access?: AccessLevel }[] | null): MarkedItem[] {
  if (!entries) return [];
  const now = new Map(entries.map((e) => [e.path, e.access]));
  return items.filter((i) => now.has(i.path)).map((i) => (now.get(i.path) === i.access ? i : { ...i, access: now.get(i.path) }));
}

/** The visible rows from the anchor to `to` (either direction); without an anchor just `to`. */
export function rangeOf(rows: MarkedItem[], anchor: string | null, to: string): MarkedItem[] {
  const j = rows.findIndex((r) => r.path === to);
  if (j < 0) return [];
  const i = anchor === null ? -1 : rows.findIndex((r) => r.path === anchor);
  if (i < 0) return [rows[j]!];
  return rows.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export const useMarked = create<MarkedState>((set, get) => ({
  mountId: null,
  items: [],
  anchor: null,
  picking: false,
  toggle: (mountId, item, alsoFirst) => {
    const items = toggled(get(), mountId, item, alsoFirst);
    set({ mountId: items.length ? mountId : null, items, anchor: item.path, picking: get().picking && items.length > 0 });
  },
  range: (mountId, rows, to, from) => {
    const s = get();
    const anchor = s.mountId === mountId && s.anchor ? s.anchor : (from ?? null);
    const items = rangeOf(rows, anchor, to);
    set({ mountId: items.length ? mountId : null, items, anchor: anchor ?? to });
  },
  pick: (mountId, item) => set({ mountId, items: [item], anchor: item.path, picking: true }),
  clear: () => set({ mountId: null, items: [], anchor: null, picking: false }),
  sync: (mountId, entries) => {
    const s = get();
    if (s.mountId !== mountId) return;
    const items = synced(s.items, entries);
    if (items.length === s.items.length && items.every((i, k) => i === s.items[k])) return;
    set({ items, mountId: items.length ? mountId : null, picking: s.picking && items.length > 0, anchor: items.length ? s.anchor : null });
  },
  drop: (mountId, path) => {
    const s = get();
    if (s.mountId !== mountId) return;
    const items = s.items.filter((i) => i.path !== path && !i.path.startsWith(`${path}/`));
    set({ items, mountId: items.length ? mountId : null, picking: s.picking && items.length > 0 });
  },
}));

/** A tree row's own data, for ranges over the visible rows (data-* attributes set by the row). */
export function rowItem(el: HTMLElement): MarkedItem | null {
  const d = el.dataset;
  if (d.path === undefined || d.title === undefined) return null;
  return { path: d.path, isDir: d.dir === '1', title: d.title, access: d.access as AccessLevel | undefined, encrypted: d.enc === '1' };
}

/** The visible rows of one source, in display order. */
export function visibleRows(mountId: string): MarkedItem[] {
  return [...document.querySelectorAll<HTMLElement>(`[role="treeitem"][data-mount-of="${CSS.escape(mountId)}"]`)].map(rowItem).filter((r): r is MarkedItem => !!r);
}
