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
  /** The workspace closes (signing out): pending writes and retries end here. */
  stop(): void;
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

/**
 * Three-way merge before writing: only what this tab changed since it last read (`base`) goes onto what is stored now.
 * Another tab open with older lists must not write them over newer ones (a favorite added there would vanish).
 */
export function rebase(base: NoteRef[], local: NoteRef[], stored: NoteRef[]): NoteRef[] {
  const has = (list: NoteRef[], r: NoteRef) => list.some((x) => same(x, r.mountId, r.path));
  return [...local.filter((l) => !has(base, l) || has(stored, l)), ...stored.filter((s) => !has(local, s) && !has(base, s))];
}

export const usePersonal = create<Personal>((set, get) => {
  /** Changed before the saved state arrived: merged into it on load, not written over it. */
  let early = false;
  /** The lists as last read from or written to the server: what this tab changed is the difference to them. */
  let base: { favorites: NoteRef[]; recent: NoteRef[] } = { favorites: [], recent: [] };
  /** Counts sign-ins (load): a write or retry of the previous account never reaches the next one (code check G1). */
  let session = 0;
  /** Failed writes in a row: retried a few times with a growing pause, not for ever. */
  let failures = 0;
  const write = async () => {
    const mine = session;
    let stored: { favorites?: NoteRef[]; recent?: NoteRef[] } | null = null;
    try {
      stored = await api.getState<{ favorites?: NoteRef[]; recent?: NoteRef[] }>('personal');
    } catch {
      // Not readable: write this tab's lists as they are (as before) rather than lose its change.
    }
    if (mine !== session) return;
    const now = get();
    const favorites = stored ? rebase(base.favorites, now.favorites, stored.favorites ?? []) : now.favorites;
    const recent = (stored ? rebase(base.recent, now.recent, stored.recent ?? []) : now.recent).slice(0, 20);
    set({ favorites, recent });
    await api.putState('personal', { favorites, recent });
    // Only what reached the server is the new base: after a failed write, this tab's additions are still „its own“
    // and go out with the next attempt instead of being taken for removed elsewhere (diff check 0.2.15).
    base = { favorites, recent };
  };
  /** One write at a time: two overlapping ones would each rebase on a base the other one changes. */
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    if (!get().loaded) {
      early = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      writing = writing
        .then(write)
        .then(() => void (failures = 0))
        .catch((e: unknown) => {
          // Signed out or refused (4xx): retrying cannot help. Otherwise a few more tries (5 s, 10 s … up to a minute);
          // the next change starts over.
          const status = (e as { status?: number }).status ?? 0;
          if ((status >= 400 && status < 500) || ++failures > 5) return void (failures = 0);
          clearTimeout(timer);
          timer = setTimeout(persist, Math.min(60_000, 5_000 * 2 ** (failures - 1)));
        });
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
    base = { favorites: s?.favorites ?? [], recent: s?.recent ?? [] };
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
      session++;
      failures = 0;
      clearTimeout(timer);
      set({ favorites: [], recent: [], loaded: false });
      await fetchSaved();
    },
    stop() {
      session++;
      failures = 0;
      clearTimeout(timer);
      clearTimeout(retry);
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
