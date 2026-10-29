// Splits a Markdown file into its raw YAML frontmatter block and the body.
// The frontmatter is kept byte-exact; edits replace or append single lines
// (see updateFrontmatter) so foreign keys, order, comments and formatting survive.
// SEE-DOC: HANDBOOK.md#architektur-überblick, DECISION: AD-002

import { parseDocument } from 'yaml';

export interface SplitFile {
  /** Exact frontmatter text including both `---` fences and the trailing newline, or '' if none. */
  frontmatter: string;
  /** Everything after the frontmatter. */
  body: string;
}

const FENCE = /^---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

export function splitFrontmatter(raw: string): SplitFile {
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const text = raw.slice(bom.length);
  const open = FENCE.exec(text);
  if (!open) return { frontmatter: '', body: raw };
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { frontmatter: '', body: raw };
  const end = open[0].length + close.index + close[0].length;
  return { frontmatter: bom + text.slice(0, end), body: text.slice(end) };
}

/** Parsed frontmatter data as a plain object ({} when absent or invalid). */
export function readFrontmatter(frontmatter: string): Record<string, unknown> {
  const inner = frontmatterInner(frontmatter);
  if (inner === null) return {};
  try {
    const value: unknown = parseDocument(inner).toJS();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Values the app writes into frontmatter (ids, icons, flags; lists as YAML flow sequences). */
export type FrontmatterValue = string | number | boolean | string[] | undefined;

/**
 * Sets (or deletes, with `undefined`) top-level keys by editing lines, so every other byte
 * of the block — foreign keys, order, comments, quoting, spacing — stays exactly as it was.
 * A changed key keeps its line position; a new key is appended before the closing fence.
 * Returns a complete frontmatter block.
 */
export function updateFrontmatter(frontmatter: string, changes: Record<string, FrontmatterValue>): string {
  const bom = frontmatter.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = frontmatter.includes('\r\n') ? '\r\n' : '\n';
  const inner = frontmatterInner(frontmatter);
  let open = `---${eol}`;
  let close = `---${eol}`;
  if (inner !== null) {
    const text = frontmatter.slice(bom.length);
    open = FENCE.exec(text)![0];
    close = text.slice(open.length + inner.length);
  }
  const lines = inner ? inner.split(/(?<=\n)/) : [];
  for (const [key, value] of Object.entries(changes)) {
    const at = lines.findIndex((l) => keyOf(l) === key);
    // A block value (list/map/multi-line string) continues on indented or `- ` lines.
    let end = at + 1;
    if (at >= 0) while (end < lines.length && /^(?:[ \t]|-(?:[ \t]|\r?\n|$))/.test(lines[end]!)) end++;
    if (value === undefined) {
      if (at >= 0) lines.splice(at, end - at);
      continue;
    }
    const line = `${key}: ${scalar(value)}${eol}`;
    if (at >= 0) lines.splice(at, end - at, line);
    else {
      if (lines.length && !lines[lines.length - 1]!.endsWith('\n')) lines[lines.length - 1] += eol;
      lines.push(line);
    }
  }
  return `${bom}${open}${lines.join('')}${close}`;
}

/** Sets frontmatter keys in a whole file; creates a frontmatter block if there is none. */
export function setFrontmatterKeys(raw: string, changes: Record<string, FrontmatterValue>): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (!frontmatter) {
    if (Object.values(changes).every((v) => v === undefined)) return raw;
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
    const eol = /\r\n/.test(raw.slice(0, raw.indexOf('\n') + 1)) ? '\r\n' : '\n';
    const block = updateFrontmatter(`---${eol}---${eol}`, changes);
    return bom + block + body.slice(bom.length);
  }
  const next = updateFrontmatter(frontmatter, changes);
  // The last key removed (e.g. a tag added and taken away again): no empty `---`/`---` block stays behind.
  if (!frontmatterInner(next)?.trim() && frontmatterInner(frontmatter)?.trim()) return (frontmatter.startsWith('\uFEFF') ? '\uFEFF' : '') + body;
  return next + body;
}

function keyOf(line: string): string | null {
  const m = /^([A-Za-z_][\w.-]*|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]|\r?\n|$)/.exec(line);
  return m ? m[1]!.replace(/^["']|["']$/g, '') : null;
}

function scalar(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) return `[${value.map((v) => scalar(v)).join(', ')}]`;
  if (typeof value !== 'string') return String(value);
  // Plain if YAML reads it back as the same string, otherwise double-quoted (JSON is valid YAML).
  const plain = /^[^\s#:'"{}[\],&*!|>%@`-][^#\r\n]*$/.test(value) && !/:\s|\s$/.test(value);
  if (plain) {
    try {
      if (parseDocument(value).toJS() === value) return value;
    } catch {
      /* quote below */
    }
  }
  return JSON.stringify(value);
}

function frontmatterInner(frontmatter: string): string | null {
  if (!frontmatter) return null;
  const text = frontmatter.replace(/^﻿/, '');
  const open = FENCE.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  return close ? rest.slice(0, close.index) : null;
}
