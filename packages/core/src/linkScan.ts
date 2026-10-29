// Finds the local links, images and reference definitions of a whole note with their offsets in the text (for
// rewriting them in place). Apart from links.ts because it needs the Markdown parser.
// SEE-DOC: docs/PLAN.md §2.5, §2.5a, DECISION: AD-006

import type { Nodes } from 'mdast';
import { htmlImageSources, isExternal, isScriptUrl, decodeUriSafe, unwrapDestination, type LocalLink } from './links.js';
import { parseMarkdown } from './markdown/document.js';
import { splitFrontmatter } from './markdown/frontmatter.js';

/**
 * All non-external link, image and reference-definition destinations of a Markdown file,
 * with source offsets so they can be rewritten in place without touching anything else.
 * Images written as HTML (`<img src="…" width="…">`, what the editor saves for a resized image) count as images;
 * HTML inside code is no HTML and is left alone.
 */
export function extractLinks(raw: string): LocalLink[] {
  const { frontmatter, body } = splitFrontmatter(raw);
  const offset = frontmatter.length;
  const out: LocalLink[] = [];
  const visit = (node: Nodes) => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && node.position && !isExternal(node.url) && !node.url.startsWith('#')) {
      const from = node.position.start.offset!;
      const to = node.position.end.offset!;
      const label = node.type === 'link' ? node.children.at(-1)?.position?.end.offset : undefined;
      const found = locateDestination(body.slice(from, to), node.type, node.url, label === undefined ? undefined : label - from);
      if (found) out.push({ kind: node.type, raw: found.raw, href: node.url, start: offset + from + found.start, end: offset + from + found.start + found.raw.length });
    }
    if (node.type === 'html' && node.position) {
      const from = node.position.start.offset!;
      for (const img of htmlImageSources(body.slice(from, node.position.end.offset!))) {
        if (!img.raw || isExternal(img.raw) || img.raw.startsWith('#')) continue;
        const start = offset + from + img.index;
        out.push({ kind: 'image', raw: img.raw, href: img.raw, start, end: start + img.raw.length });
      }
    }
    if ('children' in node) for (const c of node.children) visit(c);
  };
  visit(parseMarkdown(body));
  return out;
}

/**
 * Links, pictures and reference definitions whose address would run code (`javascript:`, `vbscript:`, `data:` – also
 * written with entities, escapes or a title), with what replaces each: a link its text as written, a picture its
 * description, a definition nothing. Pictures as `data:image/…` are pictures. Read from the parsed note, so every way of
 * writing one counts (used for imports from other programs, whose pages are often clipped from the web).
 */
export function scriptLinks(raw: string): { start: number; end: number; text: string }[] {
  // Each way of writing such an address has these letters or an entity in it – most notes need no parsing.
  if (!/script|data|&/i.test(raw)) return [];
  const { frontmatter, body } = splitFrontmatter(raw);
  const offset = frontmatter.length;
  type Found = { start: number; end: number; text: string };
  const out: Found[] = [];
  const visit = (node: Nodes, into: Found[]) => {
    const at = node.position && { start: node.position.start.offset!, end: node.position.end.offset! };
    if (at && (node.type === 'link' || node.type === 'image' || node.type === 'definition') && isScriptUrl(node.url)) {
      if (node.type === 'definition') into.push({ ...at, text: '' });
      else if (node.type === 'image') {
        if (!/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(node.url)) into.push({ ...at, text: (node.alt ?? '').replace(/[[\]\\]/g, '\\$&') });
      } else {
        // The text as written – with what is inside it treated the same (a picture with a script address in it).
        const first = node.children[0]?.position?.start.offset;
        const last = node.children.at(-1)?.position?.end.offset;
        const inner: Found[] = [];
        for (const c of node.children) visit(c, inner);
        // An autolink `<javascript:…>` has nothing but its address.
        const text = first === undefined || last === undefined || body[at.start] === '<' ? '' : replaceRanges(body.slice(first, last), inner, first);
        into.push({ ...at, text });
      }
      return;
    }
    if ('children' in node) for (const c of node.children) visit(c, into);
  };
  visit(parseMarkdown(body), out);
  return out.map((f) => ({ ...f, start: offset + f.start, end: offset + f.end }));
}

/** `text` (starting at `base` in the whole) with the ranges replaced, from the back. */
function replaceRanges(text: string, ranges: { start: number; end: number; text: string }[], base = 0): string {
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) text = text.slice(0, r.start - base) + r.text + text.slice(r.end - base);
  return text;
}

/**
 * Finds the destination inside a link's source text (`[x](dest "t")` or `[r]: dest "t"`).
 * `labelEnd` = end of a link's last child (relative to `src`); the destination follows the label's closing `]`.
 */
function locateDestination(src: string, type: 'link' | 'image' | 'definition', url: string, labelEnd?: number): { raw: string; start: number } | null {
  let from: number;
  if (type === 'definition') from = src.indexOf(']:') + 2;
  else {
    // Forward from the label: `](` may also appear in the title or a `<…>` destination.
    const close = type === 'link' && labelEnd !== undefined ? labelEnd : labelClose(src, type === 'image' ? 2 : 1);
    if (src[close] !== ']' || src[close + 1] !== '(') return null; // autolink or reference — nothing to rewrite here
    from = close + 2;
  }
  const tail = src.slice(from);
  const lead = /^[ \t]*(?:\r?\n[ \t]*)?/.exec(tail)![0].length;
  const rest = tail.slice(lead);
  let raw: string;
  if (rest.startsWith('<')) {
    const close = rest.indexOf('>');
    if (close < 0) return null;
    raw = rest.slice(0, close + 1);
  } else {
    // Unbracketed destinations end at whitespace or the closing parenthesis (balanced).
    let depth = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      const ch = rest[i]!;
      if (ch === '\\') {
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '(') depth++;
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    raw = rest.slice(0, i);
  }
  if (!raw || (unwrapDestination(raw) !== url && decodeUriSafe(unwrapDestination(raw)) !== decodeUriSafe(url))) return null;
  return { raw, start: from + lead };
}

/**
 * Index of the `]` closing a label that starts at `i` (balanced brackets, `\\` escapes, code spans), -1 if none.
 * Linear in the label: the backtick runs are listed once by length, a closing run is then the next one of that length.
 */
function labelClose(src: string, i: number): number {
  let depth = 0;
  let runs: Map<number, { at: number[]; next: number }> | null = null;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') i++;
    else if (ch === '`') {
      runs ??= backtickRuns(src, i);
      let run = 1;
      while (src[i + run] === '`') run++;
      // Runs of this length before `i + run` are behind us for good: the search only moves forward.
      const same = runs.get(run)!;
      while (same.next < same.at.length && same.at[same.next]! < i + run) same.next++;
      const end = same.next < same.at.length ? same.at[same.next]! : -1;
      i = end >= 0 ? end + run - 1 : i + run - 1;
    } else if (ch === '[') depth++;
    else if (ch === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Start of every run of backticks from `from`, by run length. */
function backtickRuns(src: string, from: number): Map<number, { at: number[]; next: number }> {
  const runs = new Map<number, { at: number[]; next: number }>();
  for (let j = src.indexOf('`', from); j >= 0; j = src.indexOf('`', j)) {
    let n = 1;
    while (src[j + n] === '`') n++;
    const list = runs.get(n) ?? { at: [], next: 0 };
    list.at.push(j);
    runs.set(n, list);
    j += n;
  }
  return runs;
}
