// Every text the interface passes to t()/tn() has a translation in every language of LANGUAGES, with the same
// placeholders; areas agree on shared texts; no dictionary entry is left over (AD-046).
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LANGUAGES, PASSWORD_RULES, SOURCE_LANG, TAG_COLOR_NAMES, placeholders } from '@kaveyl-wiki/core';
import { DICTIONARIES } from './dictionaries';
import { AREAS } from './en';

const SRC = resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return p === join(SRC, 'i18n') ? [] : sources(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

// Without comments (they quote t('…') as examples); only whole-line comments, a `//` inside a string stays.
const code = [...sources(SRC), join(SRC, 'i18n/index.ts')]
  .map((f) => readFileSync(f, 'utf8').replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, ''))
  .join('\n');
const STR = `'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)"|\`((?:[^\`\\\\$]|\\\\.)*)\``;
const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
const lit = (m: RegExpMatchArray, i: number) => unescape(m[i] ?? m[i + 1] ?? m[i + 2] ?? '');

/** Texts handed to t() and tn() as literals. */
const used = new Set<string>([
  ...[...code.matchAll(new RegExp(`\\bt\\(\\s*(?:${STR})`, 'g'))].map((m) => lit(m, 1)),
  ...[...code.matchAll(new RegExp(`\\btn\\([^,]+,\\s*(?:${STR})\\s*,\\s*(?:${STR})`, 'g'))].flatMap((m) => [lit(m, 1), lit(m, 4)]),
  // Shown through t(variable): names from @kaveyl-wiki/core.
  ...Object.values(TAG_COLOR_NAMES),
  ...PASSWORD_RULES.map((r) => r.label),
]);
/** A dictionary entry must appear in the code as a quoted text somewhere (also when passed on via a variable). */
const quoted = (k: string) =>
  [`'${k.replace(/['\\]/g, '\\$&')}'`, `"${k.replace(/["\\]/g, '\\$&')}"`, `\`${k}\``].some((q) => code.includes(q));

describe('interface languages', () => {
  it('finds the texts of the interface', () => {
    expect(used.size).toBeGreaterThan(10);
  });

  for (const l of LANGUAGES.filter((x) => x.code !== SOURCE_LANG)) {
    it(`${l.name}: every text is translated, with the same placeholders`, async () => {
      const dict = await DICTIONARIES[l.code]?.();
      expect(dict, `apps/web/src/i18n/dictionaries.ts has no dictionary for ${l.code}`).toBeDefined();
      expect([...used].filter((k) => !(k in dict!))).toEqual([]);
      const wrong = Object.entries(dict!).filter(([de, tr]) => placeholders(de).join() !== placeholders(tr).join());
      expect(wrong).toEqual([]);
      expect(Object.entries(dict!).filter(([, tr]) => !tr.trim())).toEqual([]);
    });

    it(`${l.name}: no left-over entries`, async () => {
      expect(Object.keys(await DICTIONARIES[l.code]!()).filter((k) => !used.has(k) && !quoted(k))).toEqual([]);
    });
  }

  it('areas agree on texts they share', () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const [area, dict] of Object.entries(AREAS))
      for (const [de, en] of Object.entries(dict)) {
        const before = seen.get(de);
        if (before !== undefined && before !== en) clash.push(`${area}: ${de}`);
        seen.set(de, en);
      }
    expect(clash).toEqual([]);
  });

  it('dates and numbers follow the interface language, not the browser (fmtDate, fmtDateTime, fmtNumber)', () => {
    expect(code.match(/\.toLocale(?:Date|Time)?String\(\s*\)/g) ?? []).toEqual([]);
  });
});

describe('fmtBytes', () => {
  // The language is fixed per page view, so each one is loaded afresh with the browser set to it.
  async function inLanguage(language: string) {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')!;
    Object.defineProperty(globalThis, 'navigator', { value: { language, languages: [language] }, configurable: true });
    vi.resetModules();
    try {
      return (await import('./index')).fmtBytes;
    } finally {
      Object.defineProperty(globalThis, 'navigator', before);
    }
  }

  it('German: comma, B/KB/MB/GB', async () => {
    const fmt = await inLanguage('de-DE');
    expect([512, 2048, 1.5 * 1024 ** 2, 2 * 1024 ** 3, 2.25 * 1024 ** 3].map(fmt)).toEqual(['512 B', '2 KB', '1,5 MB', '2 GB', '2,3 GB']);
  });

  it('English: point', async () => {
    const fmt = await inLanguage('en-GB');
    expect([512, 2048, 1.5 * 1024 ** 2, 2.25 * 1024 ** 3].map(fmt)).toEqual(['512 B', '2 KB', '1.5 MB', '2.3 GB']);
  });
});
