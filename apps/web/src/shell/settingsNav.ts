// Opening the settings at a given page from elsewhere (e.g. the source menu → Backup), with an
// optional source and path the page starts with. Kept apart from Settings.tsx (no import cycle).
import { create } from 'zustand';

export interface SettingsRequest {
  page: string;
  mountId?: string;
  path?: string;
  /** Counts up, so the same request twice opens the page again. */
  n: number;
}

/** `help`: the help anchor of the page shown – the dialog's title bar (Shell) puts its „?“ there. */
/** `wide`: the open page needs room (grids like „Rechte“, owner 28.10.) – the dialog grows to almost the full width. */
export const useSettingsNav = create<{ request: SettingsRequest | null; help: string | null; wide: boolean }>(() => ({ request: null, help: null, wide: false }));

export function openSettings(page: string, opts: { mountId?: string; path?: string } = {}) {
  useSettingsNav.setState((s) => ({ request: { page, ...opts, n: (s.request?.n ?? 0) + 1 } }));
}

