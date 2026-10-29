// Theme: system (default) / light / dark. Stored per browser; follows OS changes live. One shared store, so the
// header switch, Einstellungen → Darstellung and the sign-in pages always show the same state (also across tabs).
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'kaveyl-wiki.theme';

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && !!darkQuery?.matches);
  document.documentElement.classList.toggle('dark', dark);
}

const useThemeStore = create<{ theme: Theme; set(t: Theme): void }>((set) => ({
  theme: read(),
  set(t) {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode: theme just is not remembered */
    }
    apply(t);
    set({ theme: t });
  },
}));

if (typeof document !== 'undefined') {
  apply(useThemeStore.getState().theme);
  darkQuery?.addEventListener('change', () => useThemeStore.getState().theme === 'system' && apply('system'));
  // Another tab changed it.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const t = read();
    apply(t);
    useThemeStore.setState({ theme: t });
  });
}

/** Order of the header switch: light → dark → system → light. */
export const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };

export function useTheme(): [Theme, (t: Theme) => void] {
  return [useThemeStore((s) => s.theme), useThemeStore.getState().set];
}

const onSystemChange = (cb: () => void) => {
  darkQuery?.addEventListener('change', cb);
  return () => darkQuery?.removeEventListener('change', cb);
};

/** Whether dark is in effect right now (the switch, or the system when set to „System“) — live. */
export function useDark(): boolean {
  const theme = useThemeStore((s) => s.theme);
  const system = useSyncExternalStore(onSystemChange, () => !!darkQuery?.matches, () => false);
  return theme === 'dark' || (theme === 'system' && system);
}
