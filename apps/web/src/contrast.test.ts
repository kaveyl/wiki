// Colour tokens in styles.css keep the WCAG 2.2 minimum contrast (1.4.3 text, 1.4.11 controls).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, 'styles.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*]/g, (c) => '\\' + c);
  const m = css.match(new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}'));
  if (!m?.[1]) throw new Error(`no block ${selector}`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1] ?? '', (x[2] ?? '').trim()]));
}

const root = block(':root');
const dark = { ...root, ...block('.dark') };
const schemes = {
  light: root,
  dark,
  'auth light': { ...root, ...block('.auth') },
  'auth dark': { ...dark, ...block('.auth'), ...block('.dark .auth') },
};

function luminance(hex: string | undefined): number {
  const m = hex?.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const lin = (h: string | undefined) => {
    const v = parseInt(h ?? '', 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}

function contrast(a: string | undefined, b: string | undefined): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `rgba(r, g, b, a)` laid over an opaque #rrggbb (accent-soft and other overlays). The alpha as shipped:
 *  the build writes it as #rrggbbaa, i.e. in steps of 1/255 (rgba(…, 0.06) → 0f = 0.0588). */
function over(top: string | undefined, base: string | undefined): string {
  const m = top?.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  if (!m) return top ?? '';
  const a = Math.round(Number(m[4]) * 255) / 255;
  const b = (base ?? '').slice(1).match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
  return '#' + [m[1], m[2], m[3]].map((v, i) => Math.round(Number(v) * a + (b[i] ?? 0) * (1 - a)).toString(16).padStart(2, '0')).join('');
}

describe('colour tokens (styles.css)', () => {
  // Page and sidebar in the app; on the sign-in pages faint text only appears inside inputs (bg).
  const textBgs: Record<keyof typeof schemes, string[]> = {
    light: ['bg', 'bg-subtle'],
    dark: ['bg', 'bg-subtle'],
    'auth light': ['bg'],
    'auth dark': ['bg'],
  };
  for (const [name, tokens] of Object.entries(schemes) as [keyof typeof schemes, Record<string, string>][]) {
    for (const fg of ['fg', 'fg-muted', 'fg-faint']) {
      for (const bg of textBgs[name]) {
        it(`${name}: text --${fg} on --${bg} reaches 4.5:1 (design-002)`, () => {
          expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  // Fields and default buttons show their shape only through the border (WCAG 1.4.11: 3:1 against
  // the surroundings). Plain separators keep the faint --border.
  const controlBgs: Record<keyof typeof schemes, string[]> = {
    light: ['bg', 'bg-subtle'],
    dark: ['bg', 'bg-subtle'],
    'auth light': ['bg', 'auth-card'],
    'auth dark': ['bg', 'auth-card'],
  };
  for (const [name, tokens] of Object.entries(schemes) as [keyof typeof schemes, Record<string, string>][]) {
    for (const bg of controlBgs[name]) {
      it(`${name}: control border --border-control on --${bg} reaches 3:1 (design-003)`, () => {
        expect(contrast(tokens['border-control'], tokens[bg])).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('inputs, selects and textareas draw border-line with --border-control; default buttons use border-line-control (design-003)', () => {
    expect(css).toMatch(/input,\s*select,\s*textarea\s*\{\s*--border:\s*var\(--border-control\);/);
    const ui = readFileSync(resolve(import.meta.dirname, 'ui.tsx'), 'utf8');
    expect(ui).toMatch(/variant === 'default' && '[^']*\bborder-line-control\b/);
  });

  // A field with an error (aria-invalid from Field/AuthField) is red itself, also in focus (design-012).
  it('invalid inputs, selects and textareas draw border and focus ring in --danger (design-012)', () => {
    const rule = css.match(/:is\(input,\s*select,\s*textarea\)\[aria-invalid='true'\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/--border:\s*var\(--danger\);/);
    expect(rule).toMatch(/--accent:\s*var\(--danger\);/);
    expect(rule).toMatch(/--accent-soft:\s*color-mix\(in srgb, var\(--danger\)/);
    // The input classes reach the field's border and ring only through these tokens.
    const ui = readFileSync(resolve(import.meta.dirname, 'ui.tsx'), 'utf8');
    const auth = readFileSync(resolve(import.meta.dirname, 'auth/AuthPages.tsx'), 'utf8');
    for (const cls of [ui.match(/const INPUT_BOX =\s*'([^']*)'/)?.[1], auth.match(/const inputCls =\s*'([^']*)'/)?.[1]]) {
      expect(cls).toMatch(/\bborder-line\b(?!-).*\bfocus:border-accent\b.*\bfocus:ring-accent-soft\b/);
    }
  });
  for (const [name, tokens] of Object.entries(schemes) as [keyof typeof schemes, Record<string, string>][]) {
    for (const bg of controlBgs[name]) {
      it(`${name}: invalid field border --danger on --${bg} reaches 3:1 (design-012)`, () => {
        expect(contrast(tokens['danger'], tokens[bg])).toBeGreaterThanOrEqual(3);
      });
    }
  }

  // Sign-in pages: the chosen language (DE | EN) is 12 px text on accent-soft over the card (rest-d4).
  it('sign-in language switch: the active entry reaches 4.5:1 in both schemes (rest-d4)', () => {
    const toggles = readFileSync(resolve(import.meta.dirname, 'Toggles.tsx'), 'utf8');
    const cls = toggles.match(/l\.code === lang \? 'bg-accent-soft ([^']*)'/)?.[1] ?? '';
    const token = cls.match(/\btext-\[var\(--([\w-]+)\)\]/)?.[1] ?? cls.match(/\btext-([\w-]+)/)?.[1];
    for (const name of ['auth light', 'auth dark'] as const) {
      const tokens = schemes[name];
      expect(contrast(tokens[token ?? ''], over(tokens['accent-soft'], tokens['auth-card'])), `${name}: --${token}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Raw <button>s outside Button (pickers, selectable tiles, the tree checkbox) need the same 3:1 border (rest-d3).
  it('raw <button> elements with a border use border-line-control, not the faint border-line (rest-d3)', () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.tsx') ? [join(d, e.name)] : []));
    const faint = walk(import.meta.dirname).flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(/<button\b/g)].flatMap((m) => {
        const tag = src.slice(m.index, m.index + 600);
        const cls = tag.match(/className=(\{cx\([^]*?\)\}|"[^"]*")/)?.[1] ?? '';
        const end = tag.indexOf('</button>');
        if (end >= 0 && tag.indexOf(cls) > end) return [];
        return /\bborder\b/.test(cls) && /\bborder-line\b(?!-)/.test(cls) ? [`${relative(import.meta.dirname, f)}:${src.slice(0, m.index).split('\n').length}`] : [];
      });
    });
    expect(faint).toEqual([]);
  });

  // Selectable tiles (colour scheme, editor width, language): under the pointer the inactive tile gets
  // bg-hover, which takes --border-control below 3:1 – the hover border must keep 3:1 (rest-e4).
  it('inactive selectable tiles keep a 3:1 border under the pointer (rest-e4)', () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.tsx') ? [join(d, e.name)] : []));
    const colour = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*var\(--([\w-]+)\)/g)].map((x) => [x[1] ?? '', x[2] ?? '']));
    const tiles = walk(import.meta.dirname).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\? 'border-accent bg-accent-soft' : '([^']*)'/g)].map((m) => ({ at: relative(import.meta.dirname, f), cls: m[1] ?? '' })),
    );
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    const weak = tiles.flatMap(({ at, cls }) => {
      // Only tiles that are controls themselves (border-line-control); radio cards keep the faint border.
      if (!/\bborder-line-control\b/.test(cls) || !/\bhover:bg-hover\b/.test(cls)) return [];
      const token = colour[cls.match(/\bhover:border-([\w-]+)/)?.[1] ?? cls.match(/(?:^|\s)border-([\w-]+)/)?.[1] ?? ''];
      return (['light', 'dark'] as const).flatMap((name) =>
        ['bg', 'bg-subtle'].flatMap((bg) => {
          const tokens = schemes[name];
          const ratio = contrast(tokens[token ?? ''], over(tokens['bg-hover'], tokens[bg]));
          return ratio >= 3 ? [] : [`${at} ${name} on --${bg}: ${ratio.toFixed(2)}`];
        }),
      );
    });
    expect(weak).toEqual([]);
  });

  // Hover and selection rows (tree, lists, menu entries, search hits): grey helper text there switches from
  // --fg-faint to --fg-muted, which keeps 4.5:1 on the hover/active tint over page and sidebar (AD-048).
  const rowBgs: Record<keyof typeof schemes, string[]> = {
    light: ['bg', 'bg-subtle'],
    dark: ['bg', 'bg-subtle'],
    'auth light': ['bg', 'auth-card'],
    'auth dark': ['bg', 'auth-card'],
  };
  for (const [name, tokens] of Object.entries(schemes) as [keyof typeof schemes, Record<string, string>][]) {
    for (const surface of ['bg-hover', 'bg-active']) {
      for (const bg of rowBgs[name]) {
        it(`${name}: text --fg-muted on --${surface} over --${bg} reaches 4.5:1 (AD-048)`, () => {
          expect(contrast(tokens['fg-muted'], over(tokens[surface], tokens[bg]))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  const tsx = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsx(join(d, e.name)) : e.name.endsWith('.tsx') ? [join(d, e.name)] : []));

  it('every class that lays bg-hover/bg-active under text switches --fg-faint to --fg-muted (AD-048)', () => {
    const used = new Set(
      tsx(import.meta.dirname).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/(?<=["'`\s])(?:[^\s"'`]*:)?bg-(?:hover|active)(?=["'`\s])/g)].map((m) => m[0])),
    );
    expect(used.size).toBeGreaterThanOrEqual(4);
    const selectors = [...css.matchAll(/([^{}]+)\{\s*--fg-faint:\s*var\(--fg-muted\);\s*\}/g)].map((m) => m[1] ?? '').join(',');
    const missing = [...used].filter((cls) => !selectors.includes(`[class~='${cls}']`));
    expect(missing).toEqual([]);
  });

  // Buttons and pickers with a control border: under the pointer the hover tint takes --border-control
  // below 3:1, so the border gets stronger there (AD-048, like the tiles of rest-e4).
  it('bordered controls keep a 3:1 border under the pointer (AD-048)', () => {
    const colour = Object.fromEntries([...css.matchAll(/--color-([\w-]+):\s*var\(--([\w-]+)\)/g)].map((x) => [x[1] ?? '', x[2] ?? '']));
    const controls = tsx(import.meta.dirname).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/'[^'\n]*'|"[^"\n]*"/g)]
        .map((m) => ` ${m[0].slice(1, -1)} `)
        .filter((cls) => / border-line-control /.test(cls) && / hover:bg-(?:hover|active) /.test(cls))
        .map((cls) => ({ at: relative(import.meta.dirname, f), cls })),
    );
    expect(controls.length).toBeGreaterThanOrEqual(7);
    const weak = controls.flatMap(({ at, cls }) => {
      const surface = / hover:bg-active /.test(cls) ? 'bg-active' : 'bg-hover';
      const token = colour[cls.match(/ hover:border-([\w-]+) /)?.[1] ?? 'line-control'];
      return (['light', 'dark'] as const).flatMap((name) =>
        ['bg', 'bg-subtle'].flatMap((bg) => {
          const tokens = schemes[name];
          const ratio = contrast(tokens[token ?? ''], over(tokens[surface], tokens[bg]));
          return ratio >= 3 ? [] : [`${at} "${cls.trim()}" ${name} on --${bg}: ${ratio.toFixed(2)}`];
        }),
      );
    });
    expect(weak).toEqual([]);
  });
});
