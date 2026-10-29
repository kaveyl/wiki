// Text helpers for the import converters: changes only outside code (fenced blocks, also in list items, and `inline
// code`), so an example of `[[link]]` or `:::info` syntax inside code stays as written; and the pieces several
// converters share (links between export paths, callout kinds, `:::` boxes), so a fix is made in one place.
import { posix } from 'node:path';
import type { Draft } from './types.js';

/**
 * Which lines are fenced code (the fences included) – the one fence scanner of all converters. A fence may open inside
 * a list item (`- ```js`, Logseq writes every block so); ```x``` on one line is no fence; it closes with a fence of
 * the same kind, at least as long, with nothing after it.
 */
export function codeLines(lines: readonly string[]): boolean[] {
  const code: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      code.push(true);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
    } else if (m && !(m[1]![0] === '`' && line.slice(m[0].length).includes('`'))) {
      code.push(true);
      fence = m[1]!;
    } else code.push(false);
  }
  return code;
}

/** Applies `fn` to the parts of a Markdown text outside fenced code blocks; `inline` also skips `code spans`. */
export function outsideCode(text: string, fn: (part: string) => string, inline = true): string {
  const lines = text.split(/(?<=\n)/);
  const code = codeLines(lines);
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const part = buf.join('');
    out.push(inline ? outsideInlineCode(part, fn) : fn(part));
    buf = [];
  };
  lines.forEach((line, i) => {
    if (!code[i]) return buf.push(line);
    flush();
    out.push(line);
  });
  flush();
  return out.join('');
}

function outsideInlineCode(text: string, fn: (part: string) => string): string {
  let out = '';
  let last = 0;
  // A code span never runs over a blank line (an unmatched backtick is plain text).
  for (const m of text.matchAll(/(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?[^`]\1(?!`)/g)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** A line of Markdown as plain words (links → their text, no emphasis marks). */
export const plainText = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~=#>]+/g, '').trim();

/** A name from the first line of a note without a title: its first words, at most about 60 characters. */
export function firstWords(line: string): string | null {
  const words = plainText(line);
  return words.length > 60 ? `${words.slice(0, 60).replace(/\s+\S*$/, '')} …` : words || null;
}

/** A relative link from one export path to another, each segment encoded; to the folder of the note itself its name. */
export function relHref(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from || 'x'), to) || posix.basename(to);
  return rel.split('/').map(encodeURIComponent).join('/');
}

/**
 * Links (and pictures) whose address matches `href` (a pattern without anchors, e.g. `#root\/[^\s)>]*`) → their text.
 * The text may hold escaped brackets. Not strictly linear for every input (long runs of `[a](#…` without a space), but
 * it only runs in the import's own process with its time limit (audit 0.2.7 sec-005).
 */
export function linksToText(part: string, href: RegExp): string {
  let re = linkPatterns.get(href);
  // Only an unescaped `[` starts a link: otherwise each `\[` of a long run would be a start that reads to the line end
  // (quadratic, audit 0.2.7 sec-005).
  if (!re) linkPatterns.set(href, (re = new RegExp(`(?<!\\\\)(!?)\\[((?:\\\\.|[^[\\]\\\\\\n])*)\\]\\(\\s*<?(?:${href.source})>?\\s*\\)`, 'g')));
  return part.replace(re, (_all, _bang: string, text: string) => text);
}
const linkPatterns = new WeakMap<RegExp, RegExp>();

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** `==mark==` → bold (Kaveyl Wiki has no highlight); `===` and an escaped `\==` stay. */
export const marksToBold = (part: string) => part.replace(/(?<![=\\])==(?=\S)([^=\n]+?)(?<=\S)==(?!=)/g, '**$1**');

/** The one space Outline writes (and Trilium's `<figure>` leaves) before a picture – not a list item's indent. */
export const trimPictureIndent = (part: string) => part.replace(/^ (!\[)/gm, '$1');

/** Callout and box types of the programs (with their aliases) → Kaveyl Wiki's five kinds. */
export const CALLOUT_KINDS: Readonly<Record<string, string>> = {
  note: 'NOTE',
  info: 'NOTE',
  todo: 'NOTE',
  abstract: 'NOTE',
  summary: 'NOTE',
  tldr: 'NOTE',
  question: 'NOTE',
  help: 'NOTE',
  faq: 'NOTE',
  example: 'NOTE',
  quote: 'NOTE',
  cite: 'NOTE',
  tip: 'TIP',
  hint: 'TIP',
  success: 'TIP',
  check: 'TIP',
  done: 'TIP',
  important: 'IMPORTANT',
  warning: 'WARNING',
  caution: 'WARNING',
  attention: 'WARNING',
  failure: 'CAUTION',
  fail: 'CAUTION',
  missing: 'CAUTION',
  danger: 'CAUTION',
  error: 'CAUTION',
  bug: 'CAUTION',
};

/** A warning of the draft for the notes (or, `asItems`, plain names) in `list` – none when the list is empty. */
export function warn(draft: Draft, text: string, list: string[], asItems = false): void {
  if (list.length) draft.warnings.push(asItems ? { text, items: [...new Set(list)] } : { text, notes: [...new Set(list)] });
}

/**
 * `:::kind` … `:::` boxes outside code (HedgeDoc, Outline) → callouts; `:::spoiler Titel` → `<details>`. `kinds` are
 * the box types the program has; `line` changes each other line outside code (the program's own syntax), boxes
 * nested in a box are converted the same way.
 */
export function convertContainers(raw: string, kinds: readonly string[], line: (text: string) => string | null = (text) => text): string {
  const opener = new RegExp(`^:::\\s*(${kinds.join('|')})\\b\\s*(.*)$`);
  const lines = raw.split('\n');
  // Which lines are code – a box may hold a code block, its `:::` lines never are code.
  const code = codeLines(lines);
  // The next closing `:::` after each line, found in one pass from the end (a search per box would be quadratic).
  const nextClose: number[] = new Array<number>(lines.length);
  for (let i = lines.length - 1, next = -1; i >= 0; i--) {
    nextClose[i] = next;
    if (!code[i] && /^:::\s*$/.test(lines[i]!)) next = i;
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) {
      out.push(lines[i]!);
      continue;
    }
    const open = opener.exec(lines[i]!);
    const close = open ? nextClose[i]! : -1;
    if (open && close > i) {
      const inner = convertContainers(lines.slice(i + 1, close).join('\n'), kinds, line).split('\n');
      if (open[1] === 'spoiler') out.push('<details>', `<summary>${escapeHtml(open[2]!.trim() || 'Details')}</summary>`, '', ...inner, '', '</details>');
      else out.push(`> [!${CALLOUT_KINDS[open[1]!] ?? 'NOTE'}]`, ...inner.map((l) => (l.trim() ? `> ${l}` : '>')));
      i = close;
      continue;
    }
    const changed = line(lines[i]!);
    if (changed !== null) out.push(changed);
  }
  return out.join('\n');
}
