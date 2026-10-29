// Note metadata derived from a Markdown file: id, display title, icon, read-only flag, tags
// and a plain-text body for the search index. Foreign frontmatter (Wiki.js `title`/`tags`)
// is respected but never modified. SEE-DOC: docs/PLAN.md §2.3, §2.5a

import { readFrontmatter, splitFrontmatter } from './frontmatter.js';

export interface NoteMeta {
  id: string | null;
  title: string;
  icon: string | null;
  readonly: boolean;
  tags: string[];
  /** Body without frontmatter, lightly stripped of Markdown syntax (for full-text search). */
  text: string;
  frontmatter: Record<string, unknown>;
}

export function noteMeta(raw: string, fileName: string): NoteMeta {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = readFrontmatter(frontmatter);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    id: str(fm.id),
    title: str(fm.title) ?? firstHeading(body) ?? fileName.replace(/\.md$/i, ''),
    icon: str(fm.icon),
    readonly: fm.readonly === true,
    tags: parseTags(fm.tags),
    // Encrypted notes (`encrypted: age`): the body is an age block — nothing to index.
    text: fm.encrypted === 'age' ? '' : plainText(body),
    frontmatter: fm,
  };
}

/** Wiki.js stores tags as a comma-separated string; others use YAML lists. */
export function parseTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

// Everything below runs in one pass per line and without nested or overlapping quantifiers: the note body comes from
// anyone who may write (also by git push), and the index and the browser read it in their main thread. The earlier
// regular expressions took cubic (heading) or quadratic (comments, blank lines, links) time – CodeQL
// js/polynomial-redos; 4 KB of spaces in a heading held the server for seconds, 64 KB for hours.

export function firstHeading(body: string): string | null {
  let fence: string | null = null;
  for (const line of body.split(/\r\n?|\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const title = atxHeading(line);
    if (title) return stripInline(title);
  }
  return null;
}

/** Text of a level-1 heading line (`# Title #`), or null. Closing hashes go only after a space (CommonMark). */
function atxHeading(line: string): string | null {
  const open = /^\s{0,3}#\s+/.exec(line);
  if (!open) return null;
  let text = line.slice(open[0].length).trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0) text = '';
  else if (end < text.length && /\s/.test(text[end - 1]!)) text = text.slice(0, end);
  text = text.trim();
  return text || null;
}

/** `![text](url)` → text, then `[text](url)` → text; emphasis markers out. */
function stripInline(s: string): string {
  return unlink(unlink(s, true), false)
    .replace(/[*_`~]+/g, '')
    .trim();
}

/**
 * Replaces `[text](url)` (with `image`: `![text](url)`) by its text: the text holds no `]`, the address no `)`. The next
 * `]` and `)` are looked up once and reused until passed, so a text full of `[` or `](` stays one pass.
 */
function unlink(s: string, image: boolean): string {
  let out = '';
  let from = 0;
  let close = -2;
  let paren = -2;
  for (let i = 0; i < s.length; i++) {
    const open = image ? (s[i] === '!' && s[i + 1] === '[' ? i + 1 : -1) : s[i] === '[' ? i : -1;
    if (open < 0) continue;
    if (close !== -1 && close <= open) close = s.indexOf(']', open + 1);
    if (close === -1) break;
    if (s[close + 1] !== '(') continue;
    if (paren !== -1 && paren <= close + 1) paren = s.indexOf(')', close + 2);
    if (paren === -1) break;
    out += s.slice(from, i) + s.slice(open + 1, close);
    from = paren + 1;
    i = paren;
  }
  return out + s.slice(from);
}

/** Body without HTML comments; an unclosed comment runs to the end (as before). */
function withoutComments(body: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = body.indexOf('<!--', from);
    if (start < 0) return out + body.slice(from);
    const end = body.indexOf('-->', start + 4);
    if (end < 0) return out + body.slice(from);
    out += body.slice(from, start) + ' ';
    from = end + 3;
  }
}

function plainText(body: string): string {
  const lines = withoutComments(body)
    .split(/\r\n?|\n/)
    .map((line) => {
      // Same order as before: markers first, then a table separator or rule line is dropped (also inside a quote).
      const rest = line
        .replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/, '')
        .replace(/^[ \t]{0,3}>[ \t]?/, '')
        .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/, '')
        .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '');
      return /^[-:| \t]*$/.test(rest) ? '' : rest;
    });
  return stripInline(lines.join('\n').replace(/\|/g, ' '));
}
