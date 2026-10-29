// Interface language (AD-046). The German text is the key: t('Quelle einbinden') gives the translation of the chosen
// language, or the German text when there is none. The language is fixed for the page's lifetime – switching it
// reloads the page – so t() is a plain function and needs no hook. Languages: LANGUAGES in @kaveyl-wiki/core.
import { LANGUAGES, isLang, localeOf, matchLanguage, translate, type Dictionary, type Lang, type Vars } from '@kaveyl-wiki/core';
import { DICTIONARIES } from './dictionaries';

export { LANGUAGES, isLang, type Lang };

const KEY = 'kaveyl-wiki.lang';
/** Set when someone picked the language before signing in: that choice then goes into the account. */
const CHOSEN = 'kaveyl-wiki.lang.chosen';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* private mode: follow the browser */
  }
  if (typeof navigator === 'undefined') return matchLanguage([]);
  return matchLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** Language of this page view. */
export const lang: Lang = initial();
/** BCP 47 locale for dates, numbers and sorting. */
export const locale = localeOf(lang);

let dict: Dictionary | undefined;
const rules = new Intl.PluralRules(locale);

/** Translates a German text; `{name}` placeholders are filled from vars. */
export function t(text: string, vars?: Vars): string {
  return translate(dict, text, vars);
}

if (typeof document !== 'undefined') document.documentElement.lang = lang;

/**
 * Loads the dictionary of this page's language (none for German). The app's modules translate texts as they load
 * (menus, labels), so main.tsx starts the app only after this. Without the file (e.g. an old tab after an update)
 * the page stays German instead of staying blank.
 */
export async function loadLanguage(): Promise<void> {
  dict = await DICTIONARIES[lang]?.().catch(() => undefined);
  if (!dict || typeof document === 'undefined') return;
  // Callout labels come from CSS (styles.css, var(--callout-…) with the German text as fallback).
  const callouts: [string, string][] = [
    ['note', 'ℹ︎  Hinweis'],
    ['tip', '💡 Tipp'],
    ['important', '❗ Wichtig'],
    ['warning', '⚠︎  Warnung'],
    ['caution', '⛔ Vorsicht'],
  ];
  for (const [k, de] of callouts) document.documentElement.style.setProperty(`--callout-${k}`, JSON.stringify(t(de)));
}

/** Count-dependent text: tn(n, '{n} Notiz', '{n} Notizen') – {n} is filled in. */
export function tn(n: number, one: string, other: string, vars?: Vars): string {
  return t(rules.select(n) === 'one' ? one : other, { n, ...vars });
}

/** Remembers the language in this browser; false when the browser keeps nothing (private mode). */
export function rememberLang(l: Lang, chosen = false): boolean {
  try {
    localStorage.setItem(KEY, l);
    if (chosen) localStorage.setItem(CHOSEN, '1');
    return localStorage.getItem(KEY) === l;
  } catch {
    return false;
  }
}

/** Whether the language was picked on a sign-in page since the last sign-in (and forgets it). */
export function takeChosenLang(): boolean {
  try {
    const chosen = localStorage.getItem(CHOSEN) === '1';
    localStorage.removeItem(CHOSEN);
    return chosen;
  } catch {
    return false;
  }
}

/** Switches the language: remembers it, lets the caller store it in the account, then reloads the page. */
export function switchLanguage(l: Lang, persist?: () => Promise<unknown>) {
  // Without an account to store it in (sign-in pages), the choice is carried into the account at the next sign-in.
  rememberLang(l, !persist);
  void Promise.resolve()
    .then(() => persist?.())
    .catch(() => undefined)
    .finally(() => location.reload());
}

type DateIn = Date | string | number;

export const fmtDate = (d: DateIn, o?: Intl.DateTimeFormatOptions) => new Date(d).toLocaleDateString(locale, o);
export const fmtDateTime = (d: DateIn, o?: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString(locale, o);
export const fmtNumber = (n: number, o?: Intl.NumberFormatOptions) => n.toLocaleString(locale, o);

/** File size: "512 B", "2 KB", "1,5 MB" / "1.5 MB", "2 GB" (KB whole, MB and GB with at most one decimal). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${fmtNumber(n)} B`;
  if (n < 1024 ** 2) return `${fmtNumber(Math.round(n / 1024))} KB`;
  const [v, unit] = n < 1024 ** 3 ? [n / 1024 ** 2, 'MB'] : [n / 1024 ** 3, 'GB'];
  return `${fmtNumber(v, { maximumFractionDigits: 1 })} ${unit}`;
}

/** "gerade eben", "vor 5 Min.", "vor 3 Std.", else date and time. */
export function fmtAgo(d: DateIn): string {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return t('gerade eben');
  if (s < 3600) return t('vor {n} Min.', { n: Math.round(s / 60) });
  if (s < 86400) return t('vor {n} Std.', { n: Math.round(s / 3600) });
  return fmtDateTime(d);
}

/** Sorting of names in the interface's language (numbers in names sort numerically). */
export const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
