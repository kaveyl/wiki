// Load a Markdown file into an editor document and save it back with a minimal diff.
//
// Load: frontmatter is split off byte-exact; the body is parsed with remark and every
// top-level block becomes exactly one top-level editor node (or a rawBlock fallback).
// Save: top-level blocks whose editor JSON is unchanged are copied verbatim from the
// original text (including the whitespace between them); only changed or new blocks are
// re-serialized. An unchanged document returns the original bytes.
// SEE-DOC: HANDBOOK.md#bekannte-besonderheiten--stolperfallen

import type { Root } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { blocksToPM, type PMNode } from './from-mdast.js';
import { blockToMarkdown } from './to-markdown.js';
import { splitFrontmatter } from './frontmatter.js';
import { editorSchema } from './schema.js';

export interface SourceBlock {
  /** Original Markdown of this block (LF line endings). */
  md: string;
  /** Canonical JSON of the editor node, used to detect whether the block changed. */
  key: string;
}

export interface SourceMap {
  raw: string;
  frontmatter: string;
  eol: '\n' | '\r\n';
  leading: string;
  blocks: SourceBlock[];
  /** seps[i] is the original text between blocks[i] and blocks[i + 1]. */
  seps: string[];
  trailing: string;
}

export interface LoadedMarkdown {
  doc: PMNode;
  source: SourceMap;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function parseMarkdown(body: string): Root {
  return parser.parse(body);
}

export function loadMarkdown(raw: string): LoadedMarkdown {
  const { frontmatter, body: rawBody } = splitFrontmatter(raw);
  const eol = rawBody.includes('\r\n') && !/(^|[^\r])\n/.test(rawBody) ? '\r\n' : '\n';
  const body = rawBody.replace(/\r\n/g, '\n');
  const tree = parseMarkdown(body);

  const nodes: PMNode[] = [];
  const blocks: SourceBlock[] = [];
  const seps: string[] = [];
  let leading = body;
  let cursor = 0;

  blocksToPM(tree.children, body).forEach((span, i) => {
    const { start, end } = span;
    if (i === 0) leading = body.slice(0, start);
    else seps.push(body.slice(cursor, start));
    const md = body.slice(start, end);
    const node = toEditorNode(span.node, md);
    nodes.push(node);
    blocks.push({ md, key: canonicalKey(node) });
    cursor = end;
  });

  const trailing = blocks.length ? body.slice(cursor) : '';
  if (!blocks.length) leading = body;

  return {
    doc: { type: 'doc', content: nodes },
    source: { raw, frontmatter, eol, leading, blocks, seps, trailing },
  };
}

export interface SaveOptions {
  /** Skip the "unchanged document" shortcut (used by tests to exercise the splicer). */
  forceSplice?: boolean;
  /** Replacement frontmatter block (complete, including fences). */
  frontmatter?: string;
}

export function saveMarkdown(source: SourceMap, doc: PMNode, options: SaveOptions = {}): string {
  // Empty paragraphs cannot exist in Markdown (they vanish on the next load); dropping them
  // keeps editor artefacts (e.g. a trailing empty line) from producing blank-line diffs.
  const next = (doc.content ?? []).filter((node) => !isEmptyParagraph(node)).map((node) => ({ node, key: canonicalKey(node) }));
  const frontmatter = options.frontmatter ?? source.frontmatter;
  const unchanged =
    frontmatter === source.frontmatter &&
    next.length === source.blocks.length &&
    next.every((b, i) => b.key === source.blocks[i]!.key);
  if (unchanged && !options.forceSplice) return source.raw;

  const match = lcsMatch(
    source.blocks.map((b) => b.key),
    next.map((b) => b.key),
  );
  // Edited blocks take over the position of the original block they replace, so they
  // inherit its surrounding whitespace (e.g. a heading followed by a single newline).
  const slot = pairReplacements(match, source.blocks.length);

  let body = '';
  next.forEach((block, j) => {
    const i = match[j];
    if (j > 0) {
      const prev = slot[j - 1];
      const cur = slot[j];
      body += cur !== undefined && prev !== undefined && cur === prev + 1 ? source.seps[prev]! : '\n\n';
    }
    body += i !== undefined ? source.blocks[i]!.md : blockToMarkdown(block.node);
  });

  if (next.length) {
    body = source.leading + body + (source.blocks.length ? source.trailing : '\n');
  } else {
    body = '';
  }
  if (source.eol === '\r\n') body = body.replace(/\n/g, '\r\n');
  return frontmatter + body;
}

function toEditorNode(node: PMNode | null, md: string): PMNode {
  try {
    if (!node) throw new Error('unsupported');
    editorSchema().nodeFromJSON(node).check();
    return node;
  } catch {
    return { type: 'rawBlock', attrs: { markdown: md } };
  }
}

function isEmptyParagraph(node: PMNode): boolean {
  return node.type === 'paragraph' && !(node.content ?? []).some((c) => c.type !== 'text' || (c.text ?? '').trim() !== '');
}

/** Canonical JSON via the schema, so default attrs and mark order never cause false "changed". */
export function canonicalKey(node: PMNode): string {
  try {
    return JSON.stringify(editorSchema().nodeFromJSON(node).toJSON());
  } catch {
    return JSON.stringify(node);
  }
}

/**
 * Extends an LCS match with positional replacements: within each gap between matched
 * blocks, unmatched new blocks are paired in order with unmatched original blocks.
 */
function pairReplacements(match: (number | undefined)[], originalCount: number): (number | undefined)[] {
  const slot = [...match];
  let j = 0;
  let prevOrig = -1;
  while (j <= match.length) {
    const gapStart = j;
    while (j < match.length && match[j] === undefined) j++;
    const nextOrig = j < match.length ? match[j]! : originalCount;
    for (let k = 0; gapStart + k < j && prevOrig + 1 + k < nextOrig; k++) slot[gapStart + k] = prevOrig + 1 + k;
    if (j < match.length) prevOrig = match[j]!;
    j++;
  }
  return slot;
}

/** For each element of `b`, the index of the matched element in `a` (longest common subsequence). */
function lcsMatch(a: string[], b: string[]): (number | undefined)[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const match: (number | undefined)[] = new Array(m).fill(undefined);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      match[j] = i;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return match;
}

