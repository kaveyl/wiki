// Colour schemes (AD-082): theme.ts, the first-paint script in index.html and styles.css name the same schemes and
// colours, and a palette of 0.2.16 or older moves silently to its successor.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => {
  const data = new Map<string, string>([
    ['kaveyl-wiki.palette-light', 'plum'],
    ['kaveyl-wiki.palette-dark', 'oled'],
  ]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  return data;
});

import { BAR, DARK_PALETTES, LEGACY_PALETTES, LIGHT_PALETTES, LOOK } from './theme';

const css = readFileSync(resolve(import.meta.dirname, 'styles.css'), 'utf8');
const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');

function block(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*[\]()]/g, (c) => '\\' + c);
  const m = css.match(new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}'));
  if (!m?.[1]) throw new Error(`no block ${selector}`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1] ?? '', (x[2] ?? '').trim()]));
}
const root = block(':root');
const dark = { ...root, ...block('.dark') };
const tokens = (p: string): Record<string, string> =>
  p === LIGHT_PALETTES[0] ? root : p === DARK_PALETTES[0] ? dark : (LIGHT_PALETTES as readonly string[]).includes(p) ? { ...root, ...block(`:root[data-palette='${p}']`) } : { ...dark, ...block(`.dark[data-palette='${p}']`) };

/** Runs the inline script of index.html with the given storage and system scheme; returns what it set. */
function firstPaint(store: Record<string, string>, systemDark = false) {
  // The first inline script of our own index.html (plain string search – it is a fixed file, not HTML to filter).
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  const meta = { content: '' };
  const document = {
    documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) }, setAttribute: (k: string, v: string) => (attrs[k] = v) },
    querySelector: () => meta,
  };
  const localStorage = { getItem: (k: string) => store[k] ?? null };
  const matchMedia = () => ({ matches: systemDark });
  new Function('localStorage', 'matchMedia', 'document', script)(localStorage, matchMedia, document);
  return { dark: classes.has('dark'), palette: attrs['data-palette'] ?? null, bar: meta.content };
}

describe('colour schemes', () => {
  it('ten schemes in the order of Kaveyl Notes, Lavendel and Klassisch first', () => {
    expect(LIGHT_PALETTES).toEqual(['lavender', 'sand', 'sage', 'fjord', 'heather']);
    expect(DARK_PALETTES).toEqual(['classic', 'sand-dark', 'moss', 'graphite', 'black']);
  });

  for (const p of [...LIGHT_PALETTES, ...DARK_PALETTES]) {
    it(`${p}: swatch and bar colour match styles.css`, () => {
      const t = tokens(p);
      expect(LOOK[p]).toEqual({ bg: t['card'], accent: t['accent'] });
      expect(BAR[p]).toBe(t['bg']);
    });
    it(`${p}: index.html paints the same scheme and bar colour before the app loads`, () => {
      const isDark = (DARK_PALETTES as readonly string[]).includes(p);
      const got = firstPaint({ 'kaveyl-wiki.theme': isDark ? 'dark' : 'light', [isDark ? 'kaveyl-wiki.palette-dark' : 'kaveyl-wiki.palette-light']: p });
      expect(got).toEqual({ dark: isDark, palette: p === 'lavender' || p === 'classic' ? null : p, bar: BAR[p] });
    });
  }

  it('a stored palette of 0.2.16 moves to its successor, also before the first paint', () => {
    expect(stored.get('kaveyl-wiki.palette-light')).toBe('heather');
    expect(stored.get('kaveyl-wiki.palette-dark')).toBe('black');
    for (const [old, now] of Object.entries(LEGACY_PALETTES)) {
      const isDark = (DARK_PALETTES as readonly string[]).includes(now);
      const got = firstPaint({ 'kaveyl-wiki.theme': isDark ? 'dark' : 'light', [isDark ? 'kaveyl-wiki.palette-dark' : 'kaveyl-wiki.palette-light']: old });
      expect(got.palette ?? (isDark ? 'classic' : 'lavender'), old).toBe(now);
    }
    expect(LEGACY_PALETTES).toEqual({ plum: 'heather', amethyst: 'lavender', slate: 'lavender', oled: 'black', indigo: 'classic' });
  });

  it('unknown, foreign-mode or prototype names fall back to the standard', () => {
    for (const bad of ['toString', '__proto__', 'nope', 'classic']) {
      expect(firstPaint({ 'kaveyl-wiki.theme': 'light', 'kaveyl-wiki.palette-light': bad })).toEqual({ dark: false, palette: null, bar: BAR.lavender });
    }
    expect(firstPaint({ 'kaveyl-wiki.palette-dark': 'moss' }, true)).toEqual({ dark: true, palette: 'moss', bar: BAR.moss });
    // A light scheme in the dark slot (sand instead of sand-dark) would beat .dark in the CSS – it must not get through.
    for (const light of LIGHT_PALETTES) {
      expect(firstPaint({ 'kaveyl-wiki.theme': 'dark', 'kaveyl-wiki.palette-dark': light }), light).toEqual({ dark: true, palette: null, bar: BAR.classic });
    }
    for (const dark of DARK_PALETTES) {
      expect(firstPaint({ 'kaveyl-wiki.theme': 'light', 'kaveyl-wiki.palette-light': dark }), dark).toEqual({ dark: false, palette: null, bar: BAR.lavender });
    }
  });
});
