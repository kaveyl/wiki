// Personal lists (favorites, recently opened): per user in the DB (/api/state/personal), never
// in Git — they are UI state, not content (docs/PLAN.md §2.7).
import { create } from 'zustand';
import { api } from './api';

export interface NoteRef {
  mountId: string;
  path: string;
  title: string;
  /** The entry stands for a folder: `path` is its folder note, or the folder itself if it has none. */
  dir?: boolean;
}

interface Personal {
  favorites: NoteRef[];
  recent: NoteRef[];
  loaded: boolean;
  load(): Promise<void>;
  isFavorite(mountId: string, path: string): boolean;
  toggleFavorite(ref: NoteRef): void;
  visit(ref: NoteRef): void;
  /** Keeps references valid after a move/rename or delete. */
  moved(mountId: string, from: string, to: string, toMountId?: string): void;
  removed(mountId: string, path: string): void;
}

const same = (a: { mountId: string; path: string }, mountId: string, path: string) => a.mountId === mountId && a.path === path;
let timer: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
/** Pause before the next attempt after a failed load (doubles up to a minute). */
let wait = 0;

/**
 * Entries that still lead somewhere (design-008): their source is mounted and, where the source's tree is already
 * loaded, the note or folder is in it. Without a loaded tree nothing is known – the entry stays.
 */
export function present(refs: NoteRef[], mountIds: string[], treeOf: (mountId: string) => { path: string }[] | undefined): NoteRef[] {
  return refs.filter((r) => {
    if (!mountIds.includes(r.mountId)) return false;
    const tree = treeOf(r.mountId);
    return !tree || tree.some((e) => e.path === r.path);
  });
}

/** Saved refs plus those added before loading finished (each once, local first). */
const merge = (local: NoteRef[], saved: NoteRef[]) => [...local, ...saved.filter((r) => !local.some((l) => same(l, r.mountId, r.path)))];

export const usePersonal = create<Personal>((set, get) => {
  /** Changed before the saved state arrived: merged into it on load, not written over it. */
  let early = false;
  const persist = () => {
    if (!get().loaded) {
      early = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { favorites, recent } = get();
      void api.putState('personal', { favorites, recent }).catch(() => undefined);
    }, 500);
  };
  const fetchSaved = async () => {
    clearTimeout(retry);
    let s: { favorites?: NoteRef[]; recent?: NoteRef[] } | null;
    try {
      s = await api.getState<{ favorites?: NoteRef[]; recent?: NoteRef[] }>('personal'); // null = never stored
    } catch {
      // Not "empty lists": stay unloaded (changes wait, nothing is written over the stored lists) and try again.
      wait = Math.min(60_000, wait ? wait * 2 : 2_000);
      retry = setTimeout(() => void fetchSaved(), wait);
      return;
    }
    wait = 0;
    const local = get();
    set({ favorites: merge(local.favorites, s?.favorites ?? []), recent: merge(local.recent, s?.recent ?? []).slice(0, 20), loaded: true });
    if (early) {
      early = false;
      persist();
    }
  };
  return {
    favorites: [],
    recent: [],
    loaded: false,
    async load() {
      // A fresh start (also after switching accounts): nothing of the previous user's lists.
      early = false;
      set({ favorites: [], recent: [], loaded: false });
      await fetchSaved();
    },
    isFavorite: (mountId, path) => get().favorites.some((f) => same(f, mountId, path)),
    toggleFavorite(ref) {
      const { favorites } = get();
      set({ favorites: favorites.some((f) => same(f, ref.mountId, ref.path)) ? favorites.filter((f) => !same(f, ref.mountId, ref.path)) : [...favorites, ref] });
      persist();
    },
    visit(ref) {
      const recent = [ref, ...get().recent.filter((r) => !same(r, ref.mountId, ref.path))].slice(0, 20);
      const favorites = get().favorites.map((f) => (same(f, ref.mountId, ref.path) ? { ...f, title: ref.title } : f));
      set({ recent, favorites });
      persist();
    },
    moved(mountId, from, to, toMountId) {
      const fix = (r: NoteRef): NoteRef =>
        r.mountId !== mountId ? r : r.path === from || r.path.startsWith(from + '/') ? { ...r, mountId: toMountId ?? mountId, path: to + r.path.slice(from.length) } : r;
      set({ favorites: get().favorites.map(fix), recent: get().recent.map(fix) });
      persist();
    },
    removed(mountId, path) {
      const keep = (r: NoteRef) => !(r.mountId === mountId && (r.path === path || r.path.startsWith(path + '/')));
      set({ favorites: get().favorites.filter(keep), recent: get().recent.filter(keep) });
      persist();
    },
  };
});
