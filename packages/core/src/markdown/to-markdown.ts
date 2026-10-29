// ProseMirror JSON → mdast → Markdown text.
// Only used for blocks that were actually changed in the editor; unchanged blocks are
// copied byte-for-byte from the original file (see document.ts).

import type { BlockContent, ListItem, PhrasingContent, RootContent, TableCell, TableRow } from 'mdast';
import { toMarkdown, type Options } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { mathToMarkdown } from 'mdast-util-math';
import type { PMMark, PMNode } from './from-mdast.js';

// House style for newly written Markdown (HANDBOOK.md#konventionen-dieses-projekts).
const OPTIONS: Options = {
  // No column padding: an edited table row should not re-align (and re-diff) the whole table.
  extensions: [gfmToMarkdown({ tablePipeAlign: false }), mathToMarkdown()],
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  listItemIndent: 'one',
  resourceLink: false,
};

export function blockToMarkdown(node: PMNode): string {
  const md = toMarkdown({ type: 'root', children: [blockToMdast(node)] }, OPTIONS);
  return md.replace(/\n+$/, '');
}

function blockToMdast(node: PMNode): RootContent {
  const content = node.content ?? [];
  switch (node.type) {
    case 'paragraph': {
      const align = node.attrs?.align;
      if (align === 'center' || align === 'right' || align === 'left') {
        // GitHub/Gitea style: Markdown inside a block-level <div align> (blank lines around it).
        const inner = blockToMarkdown({ ...node, attrs: { ...node.attrs, align: null } });
        return { type: 'html', value: `<div align="${align}">\n\n${inner}\n\n</div>` };
      }
      return { type: 'paragraph', children: trimEdges(inlineToMdast(content)) };
    }
    case 'heading':
      return { type: 'heading', depth: clampDepth(node.attrs?.level), children: trimEdges(inlineToMdast(content)) };
    case 'horizontalRule':
      return { type: 'thematicBreak' };
    case 'blockquote':
      return { type: 'blockquote', children: content.map(blockToMdast) as BlockContent[] };
    case 'codeBlock':
      return {
        type: 'code',
        lang: (node.attrs?.language as string | null | undefined) ?? null,
        value: content.map((c) => c.text ?? '').join(''),
      };
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return {
        type: 'list',
        ordered: node.type === 'orderedList',
        start: node.type === 'orderedList' ? ((node.attrs?.start as number | undefined) ?? 1) : null,
        spread: false,
        children: content.map(
          (item): ListItem => ({
            type: 'listItem',
            // Several blocks in one item need blank lines, or following paragraphs merge lazily.
            spread: (item.content?.length ?? 0) > 1,
            checked: item.type === 'taskItem' ? item.attrs?.checked === true : null,
            children: (item.content ?? []).map(blockToMdast) as BlockContent[],
          }),
        ),
      };
    case 'table': {
      const rows = content;
      const align = (rows[0]?.content ?? []).map((cell) => (cell.attrs?.align as 'left' | 'right' | 'center' | null) ?? null);
      return {
        type: 'table',
        align,
        children: rows.map(
          (row): TableRow => ({
            type: 'tableRow',
            children: (row.content ?? []).map(
              (cell): TableCell => ({
                type: 'tableCell',
                // GFM cells hold one line of inline content: line breaks and further blocks become `<br>` (as on GitHub).
                // Empty blocks (Enter at the end of a cell) leave nothing behind.
                children: (cell.content ?? []).filter((block) => block.content?.length).flatMap((block, i) => [
                  ...(i > 0 ? [{ type: 'html', value: CELL_BREAK } as PhrasingContent] : []),
                  ...inlineToMdast((block.content ?? []).map((n) => (n.type === 'hardBreak' ? { ...n, type: 'rawInline', attrs: { markdown: CELL_BREAK } } : n))),
                ]),
              }),
            ),
          }),
        ),
      };
    }
    case 'callout': {
      // `[!KIND]` must stay literal (no `\[` escaping), hence an html node on its own line.
      const marker = { type: 'html', value: `[!${String(node.attrs?.kind ?? 'NOTE').toUpperCase()}]` } as PhrasingContent;
      // Empty paragraphs (editor artefacts) would otherwise end up as `&#xA;` / stray `>` lines.
      const blocks = (content.map(blockToMdast) as BlockContent[]).filter((b) => b.type !== 'paragraph' || b.children.length > 0);
      const first = blocks[0];
      if (first?.type === 'paragraph') {
        first.children = [marker, { type: 'text', value: '\n' }, ...first.children];
        return { type: 'blockquote', children: blocks };
      }
      return { type: 'blockquote', children: [{ type: 'paragraph', children: [marker] }, ...blocks] };
    }
    case 'details': {
      const summary = (content[0]?.content ?? []).map((t) => t.text ?? '').join('');
      const inner = (content[1]?.content ?? []).filter((b) => !(b.type === 'paragraph' && !b.content?.length)).map(blockToMarkdown);
      const open = node.attrs?.open ? ' open' : '';
      return { type: 'html', value: [`<details${open}>\n<summary>${escapeHtml(summary)}</summary>`, ...inner, '</details>'].join('\n\n') };
    }
    case 'mathBlock':
      return { type: 'math', value: String(node.attrs?.latex ?? '') } as RootContent;
    case 'rawBlock':
      return { type: 'html', value: String(node.attrs?.markdown ?? '') };
    default:
      throw new Error(`blockToMdast: unknown node type ${node.type}`);
  }
}

const CELL_BREAK = '<br>';

// Marks are applied outermost-first in this order, so `[**x**](u)` stays a link around bold.
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'] as const;

function inlineToMdast(nodes: PMNode[], depth = 0): PhrasingContent[] {
  if (depth === 0) nodes = softBreaksToText(nodes);
  const markType = MARK_ORDER[depth];
  if (markType === undefined) return nodes.map(leafToMdast);

  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < nodes.length) {
    const mark = findMark(nodes[i]!, markType);
    if (!mark) {
      // Keep runs without this mark together so deeper marks can still group across them.
      let j = i + 1;
      while (j < nodes.length && !findMark(nodes[j]!, markType)) j++;
      out.push(...inlineToMdast(nodes.slice(i, j), depth + 1));
      i = j;
      continue;
    }
    const key = JSON.stringify(mark.attrs ?? {});
    let j = i + 1;
    while (j < nodes.length) {
      const next = findMark(nodes[j]!, markType);
      if (!next || JSON.stringify(next.attrs ?? {}) !== key) break;
      j++;
    }
    const group = nodes.slice(i, j);
    if (markType === 'bold' || markType === 'italic' || markType === 'strike') {
      const { lead, inner, trail } = edgeSpaces(group);
      if (lead) out.push({ type: 'text', value: lead });
      if (inner.length) out.push(wrap(markType, mark, inner, depth));
      if (trail) out.push({ type: 'text', value: trail });
    } else out.push(wrap(markType, mark, group, depth));
    i = j;
  }
  return out;
}

/**
 * `**E-Mail **Text` cannot close in Markdown – the serializer would write `**E-Mail&#x20;**&#x54;ext`. Spaces at the
 * edges of bold, italic or strikethrough go outside the mark instead: `**E-Mail** Text` (owner find 25.10.).
 */
function edgeSpaces(group: PMNode[]): { lead: string; inner: PMNode[]; trail: string } {
  const inner = group.map((n) => ({ ...n }));
  let lead = '';
  let trail = '';
  while (inner[0]?.type === 'text') {
    const m = /^\s+/.exec(inner[0].text ?? '');
    if (!m) break;
    lead += m[0];
    inner[0].text = inner[0].text!.slice(m[0].length);
    if (inner[0].text) break;
    inner.shift();
  }
  while (inner.at(-1)?.type === 'text') {
    const last = inner.at(-1)!;
    const m = /\s+$/.exec(last.text ?? '');
    if (!m) break;
    trail = m[0] + trail;
    last.text = last.text!.slice(0, -m[0].length);
    if (last.text) break;
    inner.pop();
  }
  return { lead, inner, trail };
}

function wrap(markType: (typeof MARK_ORDER)[number], mark: PMMark, group: PMNode[], depth: number): PhrasingContent {
  switch (markType) {
    case 'code':
      return { type: 'inlineCode', value: group.map((n) => n.text ?? '').join('') };
    case 'link':
      return {
        type: 'link',
        url: String(mark.attrs?.href ?? ''),
        title: (mark.attrs?.title as string | null | undefined) ?? null,
        children: inlineToMdast(group, depth + 1),
      };
    case 'bold':
      return { type: 'strong', children: inlineToMdast(group, depth + 1) };
    case 'italic':
      return { type: 'emphasis', children: inlineToMdast(group, depth + 1) };
    case 'strike':
      return { type: 'delete', children: inlineToMdast(group, depth + 1) };
  }
}

/** Soft breaks are written as the newline they came from, merged into the surrounding text. */
function softBreaksToText(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    const node: PMNode = n.type === 'softBreak' ? { type: 'text', text: '\n', ...(n.marks ? { marks: n.marks } : {}) } : n;
    const prev = out[out.length - 1];
    if (prev?.type === 'text' && node.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (node.text ?? '') };
    } else out.push(node);
  }
  return out;
}

function leafToMdast(node: PMNode): PhrasingContent {
  switch (node.type) {
    case 'text':
      return { type: 'text', value: node.text ?? '' };
    case 'hardBreak':
      return { type: 'break' };
    case 'image':
      // A size needs HTML; without one the image stays plain Markdown.
      if (node.attrs?.width || node.attrs?.height) return { type: 'html', value: imgTag(node.attrs) };
      return {
        type: 'image',
        url: String(node.attrs?.src ?? ''),
        alt: (node.attrs?.alt as string | null | undefined) ?? null,
        title: (node.attrs?.title as string | null | undefined) ?? null,
      };
    case 'mathInline':
      return { type: 'inlineMath', value: String(node.attrs?.latex ?? '') } as PhrasingContent;
    case 'rawInline':
      return { type: 'html', value: String(node.attrs?.markdown ?? '') };
    default:
      throw new Error(`leafToMdast: unknown inline type ${node.type}`);
  }
}

/**
 * Spaces at the start/end of a paragraph have no meaning in Markdown, but mdast-util-to-markdown
 * would write them as `&#x20;` — e.g. when autosave catches "Hallo " mid-typing.
 */
function trimEdges(children: PhrasingContent[]): PhrasingContent[] {
  const edge = (nodes: PhrasingContent[], end: boolean): void => {
    const node = nodes[end ? nodes.length - 1 : 0];
    if (!node) return;
    if (node.type === 'text') {
      node.value = end ? node.value.replace(/[ \t]+$/, '') : node.value.replace(/^[ \t]+/, '');
      if (!node.value) {
        nodes.splice(end ? nodes.length - 1 : 0, 1);
        edge(nodes, end);
      }
    } else if ('children' in node && node.type !== 'link') {
      edge(node.children as PhrasingContent[], end);
    }
  };
  edge(children, true);
  edge(children, false);
  return children;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function imgTag(attrs: Record<string, unknown>): string {
  const attr = (name: string) => {
    const v = attrs[name];
    return v === null || v === undefined || v === '' ? '' : ` ${name}="${escapeHtml(String(v)).replace(/"/g, '&quot;')}"`;
  };
  return `<img${attr('src')}${attr('alt')}${attr('title')}${attr('width')}${attr('height')}>`;
}

function findMark(node: PMNode, type: string): PMMark | undefined {
  return node.marks?.find((m) => m.type === type);
}

function clampDepth(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof level === 'number' ? Math.round(level) : 1;
  return Math.min(6, Math.max(1, n)) as 1 | 2 | 3 | 4 | 5 | 6;
}
