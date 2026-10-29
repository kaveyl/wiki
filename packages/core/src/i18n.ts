// Languages of the interface (AD-046). German is the source language: the German text is the key, every other
// language is a dictionary German → translation. A new language = one entry here + its dictionaries in web and server;
// pickers, browser detection, date formats and the completeness tests follow this list.

export interface Language {
  code: string;
  /** Name in the language itself (shown in pickers). */
  name: string;
  /** BCP 47 locale for dates, numbers and sorting. */
  locale: string;
}

export const LANGUAGES = [
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'en', name: 'English', locale: 'en-GB' },
] as const satisfies readonly Language[];

export type Lang = (typeof LANGUAGES)[number]['code'];
export type Dictionary = Readonly<Record<string, string>>;
export type Vars = Readonly<Record<string, string | number>>;

/** The language the code is written in – texts without a translation stay in it. */
export const SOURCE_LANG: Lang = 'de';
/** Shown when the browser asks for a language Kaveyl Wiki does not have. */
export const FALLBACK_LANG: Lang = 'en';

export const isLang = (x: unknown): x is Lang => LANGUAGES.some((l) => l.code === x);
export const localeOf = (lang: Lang): string => LANGUAGES.find((l) => l.code === lang)!.locale;

/** First supported language in a browser's list ("de-AT" → de, "en-US" → en), otherwise the fallback. */
export function matchLanguage(wanted: readonly string[]): Lang {
  for (const w of wanted) {
    const base = w.toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return FALLBACK_LANG;
}

/** Best language from an Accept-Language header (weights respected). */
export function langFromHeader(header: string | undefined): Lang | undefined {
  if (!header) return undefined;
  const items = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag!.trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((i) => i.tag && i.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of items) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return undefined;
}

/** Fills `{name}` placeholders; unknown ones stay as they are (texts may contain literal braces). */
export function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}

/** Placeholder names of a text, sorted – used to check that a translation keeps them all. */
export const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

/** Looks a German text up in a dictionary and fills the placeholders; without a translation the German text. */
/**
 * `Kontext::Text` tells apart words German writes alike (Benutzer = user / users): the dictionary translates the whole
 * key, German shows only the text after „::“.
 */
export function translate(dict: Dictionary | undefined, text: string, vars?: Vars): string {
  const hit = dict?.[text];
  if (hit !== undefined) return fill(hit, vars);
  const ctx = text.indexOf('::');
  return fill(ctx === -1 ? text : text.slice(ctx + 2), vars);
}

/**
 * Translator for messages that were already put together (e.g. a server error „Ordner „x“ fehlt“): every dictionary
 * key with placeholders becomes a pattern, the matched parts (never across a line break) go into the translation. Exact keys win; longer
 * patterns are tried first, so a specific message beats a general one. Returns undefined when nothing matches.
 */
export function messageTranslator(dict: Dictionary): (message: string) => string | undefined {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = Object.keys(dict)
    .filter((k) => /\{\w+\}/.test(k))
    .sort((a, b) => b.length - a.length)
    .map((key) => {
      const names: string[] = [];
      const source = key
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (!m) return escape(part);
          names.push(m[1]!);
          return '([^\\n]*?)';
        })
        .join('');
      return { re: new RegExp(`^${source}$`), names, to: dict[key]! };
    });
  return (message) => {
    if (message in dict) return dict[message];
    for (const p of patterns) {
      const m = p.re.exec(message);
      if (m) return fill(p.to, Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]!])));
    }
    return undefined;
  };
}
