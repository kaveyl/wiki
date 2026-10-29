// Server side of the interface languages (AD-046). The code keeps writing German; what reaches a person is
// translated on the way out: error messages and message fields of API answers (onSend hook in app.ts), mails and
// notifications in the recipient's language. Without a matching dictionary entry the German text goes out.
import type { FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { FALLBACK_LANG, isLang, langFromHeader, messageTranslator, translate, type Dictionary, type Lang, type Vars } from '@kaveyl-wiki/core';
import en from './en.js';

/** One dictionary per language besides German. A new language: a file like ./en.ts and one line here. */
export const DICTIONARIES: Partial<Record<Lang, Dictionary>> = { en };

const translators = new Map<Lang, (m: string) => string | undefined>();

let fallback: Lang = FALLBACK_LANG;
/**
 * Language where nothing says which one (owner 2026-10-22: English): scripts and API calls without Accept-Language,
 * mails and notifications to accounts that never chose a language.
 */
export const fallbackLang = (): Lang => fallback;
/** Tests: their expectations are written against the German texts. */
export function setFallbackLang(l: Lang) {
  fallback = l;
}

/** Language of a request: the interface sends X-Kaveyl-Wiki-Lang; scripts get the fallback unless they ask (Accept-Language). */
export function requestLang(req: FastifyRequest): Lang {
  const h = req.headers['x-kaveyl-wiki-lang'];
  if (isLang(h)) return h;
  return langFromHeader(req.headers['accept-language']) ?? fallback;
}

/** A German text with placeholders, in a language. */
export function tr(lang: Lang, text: string, vars?: Vars): string {
  return translate(DICTIONARIES[lang], text, vars);
}

/** A finished German message (e.g. an error with a name in it), in a language – or unchanged. */
export function translateMessage(lang: Lang, message: string): string {
  const dict = DICTIONARIES[lang];
  if (!dict || !message) return message;
  let t = translators.get(lang);
  if (!t) translators.set(lang, (t = messageTranslator(dict)));
  return t(message) ?? message;
}

/** A text of several lines (e.g. „• finding“ lists) translated line by line, keeping bullets and indentation. */
export function translateLines(lang: Lang, text: string): string {
  if (!DICTIONARIES[lang]) return text;
  const whole = translateMessage(lang, text);
  if (whole !== text || !text.includes('\n')) return whole;
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:[•\-*]|\d+\.)?\s*)(.*)$/.exec(line)!;
      return m[2] ? m[1] + translateMessage(lang, m[2]) : line;
    })
    .join('\n');
}

/** Fields of API answers that carry messages for people (never note content: raw, body, title …). */
const MESSAGE_FIELDS = new Set(['error', 'message', 'detail', 'reason', 'hint', 'warning', 'warnings', 'summary', 'problem', 'problems', 'label', 'text']);

/** Translates the message fields of a JSON value in place (also inside lists and nested objects). */
export function translateFields(lang: Lang, value: unknown, depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (v && typeof v === 'object') translateFields(lang, v, depth + 1);
    }
    return value;
  }
  const o = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && MESSAGE_FIELDS.has(k)) o[k] = translateLines(lang, v);
    else if (Array.isArray(v) && MESSAGE_FIELDS.has(k) && v.every((x) => typeof x === 'string')) o[k] = v.map((x) => translateLines(lang, x as string));
    else if (v && typeof v === 'object') translateFields(lang, v, depth + 1);
  }
  return value;
}

/**
 * Answers whose fields carry content, not messages – backup file text, AI output, notes, search hits: translated only
 * when they are errors (status ≥ 400).
 */
export const CONTENT_ROUTES = /^\/api\/(notes?|search|tree|backup\/files\/[^/]+\/entry|ai\/(transform|ask|chats|proposals|memory)|history|versions?|trash|export|attachments|templates)(\/|\?|$)/;

/** Language of an account: its interface preference if it chose one, else the language its interface last showed. */
export function userLang(db: Database.Database, userId: string): Lang | undefined {
  const read = (key: string) => {
    const row = db.prepare('SELECT value_json FROM user_state WHERE user_id = ? AND key = ?').get(userId, key) as { value_json: string } | undefined;
    try {
      return row ? (JSON.parse(row.value_json) as unknown) : undefined;
    } catch {
      return undefined;
    }
  };
  const chosen = (read('prefs') as { language?: unknown } | null | undefined)?.language;
  if (isLang(chosen)) return chosen;
  const seen = read('uiLang');
  return isLang(seen) ? seen : undefined;
}

const lastSeen = new Map<string, Lang>();
/** Remembers the language the browser app shows an account (automatic = the browser's) – mails then speak it too. */
export function rememberUiLang(db: Database.Database, userId: string, lang: Lang) {
  if (lastSeen.get(userId) === lang) return;
  lastSeen.set(userId, lang);
  db.prepare("INSERT INTO user_state (user_id, key, value_json) VALUES (?, 'uiLang', ?) ON CONFLICT DO UPDATE SET value_json = excluded.value_json").run(userId, JSON.stringify(lang));
}
