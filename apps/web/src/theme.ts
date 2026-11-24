// Theme: system (default) / light / dark. Stored per browser; follows OS changes live. One shared store, so the
// header switch, Einstellungen → Darstellung and the sign-in pages always show the same state (also across tabs).
// On top of that one colour palette for light and one for dark (Einstellungen → Darstellung → Farbthema), also per
// browser: `data-palette` on <html> names the palette of the scheme in effect (none = the standard one), styles.css
// holds the colours. index.html applies both before the first paint.
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'kaveyl-wiki.theme';

/** Light palettes; the first is the standard. */
export const LIGHT_PALETTES = ['lavender', 'amethyst', 'plum', 'slate'] as const;
/** Dark palettes; the first is the standard. */
export const DARK_PALETTES = ['classic', 'indigo', 'oled'] as const;
export type LightPalette = (typeof LIGHT_PALETTES)[number];
export type DarkPalette = (typeof DARK_PALETTES)[number];
const LIGHT_KEY = 'kaveyl-wiki.palette-light';
const DARK_KEY = 'kaveyl-wiki.palette-dark';

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function readPalette<P extends string>(key: string, all: readonly P[]): P {
  try {
    const p = localStorage.getItem(key);
    return all.includes(p as P) ? (p as P) : all[0]!;
  } catch {
    return all[0]!;
  }
}

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/**
 * Status and navigation bar of the installed app (Android) in the page colour, not the accent – values = --bg of
 * each palette in styles.css (index.html holds the same table for the first paint).
 */
export const BAR: Record<LightPalette | DarkPalette, string> = {
  lavender: '#ffffff',
  amethyst: '#ffffff',
  plum: '#ffffff',
  slate: '#ffffff',
  classic: '#1e1e23',
  indigo: '#1b1932',
  oled: '#141418',
};

interface Looks {
  theme: Theme;
  light: LightPalette;
  dark: DarkPalette;
}

function apply({ theme, light, dark: darkPalette }: Looks) {
  const dark = theme === 'dark' || (theme === 'system' && !!darkQuery?.matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  const palette = dark ? darkPalette : light;
  if (palette === LIGHT_PALETTES[0] || palette === DARK_PALETTES[0]) root.removeAttribute('data-palette');
  else root.setAttribute('data-palette', palette);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', BAR[palette]);
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice just is not remembered */
  }
}

const useThemeStore = create<Looks & { set(t: Theme): void; setLight(p: LightPalette): void; setDark(p: DarkPalette): void }>((set, get) => ({
  theme: read(),
  light: readPalette(LIGHT_KEY, LIGHT_PALETTES),
  dark: readPalette(DARK_KEY, DARK_PALETTES),
  set(t) {
    store(KEY, t);
    set({ theme: t });
    apply(get());
  },
  setLight(p) {
    store(LIGHT_KEY, p);
    set({ light: p });
    apply(get());
  },
  setDark(p) {
    store(DARK_KEY, p);
    set({ dark: p });
    apply(get());
  },
}));

if (typeof document !== 'undefined') {
  apply(useThemeStore.getState());
  darkQuery?.addEventListener('change', () => useThemeStore.getState().theme === 'system' && apply(useThemeStore.getState()));
  // Another tab changed it.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== LIGHT_KEY && e.key !== DARK_KEY) return;
    const looks = { theme: read(), light: readPalette(LIGHT_KEY, LIGHT_PALETTES), dark: readPalette(DARK_KEY, DARK_PALETTES) };
    useThemeStore.setState(looks);
    apply(looks);
  });
}

/** Order of the header switch: light → dark → system → light. */
export const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };

export function useTheme(): [Theme, (t: Theme) => void] {
  return [useThemeStore((s) => s.theme), useThemeStore.getState().set];
}

/** The chosen palettes for light and dark and their setters (Einstellungen → Darstellung). */
export function usePalettes() {
  const light = useThemeStore((s) => s.light);
  const dark = useThemeStore((s) => s.dark);
  const { setLight, setDark } = useThemeStore.getState();
  return { light, dark, setLight, setDark };
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
