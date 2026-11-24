// Theme: system (default) / light / dark. Stored per browser; follows OS changes live. One shared store, so the
// header switch, Einstellungen → Darstellung and the sign-in pages always show the same state (also across tabs).
// On top of that one colour scheme for light and one for dark (Einstellungen → Darstellung → Helles/Dunkles
// Farbschema, values from Kaveyl Notes, AD-082), also per browser: `data-palette` on <html> names the palette of the scheme in effect (none = the standard one), styles.css
// holds the colours. index.html applies both before the first paint.
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'kaveyl-wiki.theme';

/** Light colour schemes in the order of Kaveyl Notes; the first is the standard (AD-082). */
export const LIGHT_PALETTES = ['lavender', 'sand', 'sage', 'fjord', 'heather'] as const;
/** Dark colour schemes; each stands under its light partner (lavender ↔ classic, sand ↔ sand-dark …). */
export const DARK_PALETTES = ['classic', 'sand-dark', 'moss', 'graphite', 'black'] as const;
export type LightPalette = (typeof LIGHT_PALETTES)[number];
export type DarkPalette = (typeof DARK_PALETTES)[number];
const LIGHT_KEY = 'kaveyl-wiki.palette-light';
const DARK_KEY = 'kaveyl-wiki.palette-dark';
/** Palettes up to 0.2.16 and where a stored choice moves to (index.html holds the same table). */
export const LEGACY_PALETTES: Record<string, LightPalette | DarkPalette> = {
  plum: 'heather',
  amethyst: 'lavender',
  slate: 'lavender',
  oled: 'black',
  indigo: 'classic',
};

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
    const stored = localStorage.getItem(key);
    const p = stored !== null && Object.hasOwn(LEGACY_PALETTES, stored) ? LEGACY_PALETTES[stored] : stored;
    if (!all.includes(p as P)) return all[0]!;
    // A palette of an older version moves silently to its successor.
    if (p !== stored) localStorage.setItem(key, p as P);
    return p as P;
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
  sand: '#ffffff',
  sage: '#fbfcf9',
  fjord: '#fbfcfd',
  heather: '#fdfbfd',
  classic: '#1e1e23',
  'sand-dark': '#1d1a15',
  moss: '#182019',
  graphite: '#1f2023',
  black: '#0d0d0d',
};

/**
 * The swatch of each scheme (Einstellungen → Darstellung): ground of the sidebar (--card) and accent, as in styles.css
 * (theme.test.ts checks that they match).
 */
export const LOOK: Record<LightPalette | DarkPalette, { bg: string; accent: string }> = {
  lavender: { bg: '#f5f3fb', accent: '#5b46e5' },
  sand: { bg: '#faf8f3', accent: '#8a620a' },
  sage: { bg: '#f4f6f1', accent: '#3d6b3f' },
  fjord: { bg: '#f2f5f8', accent: '#1f6a8a' },
  heather: { bg: '#f7f3f8', accent: '#7a3b78' },
  classic: { bg: '#17171b', accent: '#9b8cff' },
  'sand-dark': { bg: '#15130f', accent: '#e2b65c' },
  moss: { bg: '#111712', accent: '#9bd09a' },
  graphite: { bg: '#17181a', accent: '#7fd1c7' },
  black: { bg: '#000000', accent: '#d7a6d4' },
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
