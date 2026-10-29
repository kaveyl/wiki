// mdast (remark) → ProseMirror JSON.
// Block-level constructs the editor schema cannot represent faithfully throw
// `Unsupported`; the caller then keeps the whole top-level block as a rawBlock.
// Unsupported inline constructs become rawInline nodes holding their source text.

import type { Nodes, PhrasingContent, RootContent, List, Table, Blockquote, Paragraph } from 'mdast';
import { CALLOUT_KINDS } from './schema.js';

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

export class Unsupported extends Error {}

export function blockToPM(node: RootContent, src: string): PMNode {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', content: inlineToPM(node.children, src) };
    case 'heading':
      return { type: 'heading', attrs: { level: node.depth }, content: inlineToPM(node.children, src) };
    case 'thematicBreak':
      return { type: 'horizontalRule' };
    case 'blockquote':
      if (node.children.length === 0) throw new Unsupported('empty blockquote');
      return calloutToPM(node, src) ?? { type: 'blockquote', content: node.children.map((c) => blockToPM(c, src)) };
    case 'code':
      if (node.meta) throw new Unsupported('code meta');
      return {
        type: 'codeBlock',
        attrs: { language: node.lang ?? null },
        content: node.value ? [{ type: 'text', text: node.value }] : [],
      };
    case 'list':
      return listToPM(node, src);
    case 'table':
      return tableToPM(node, src);
    case 'math':
      // Only the plain `$$` fence; anything with meta stays raw.
      if (node.meta) throw new Unsupported('math meta');
      return { type: 'mathBlock', attrs: { latex: node.value } };
    case 'html': {
      // A line with only `<img …>` tags (e.g. with a width), or `<p align="center"><img …></p>`.
      const block = ALIGN_BLOCK_RE.exec(node.value);
      const images = block ? imagesOf(block[3]!) : IMG_ONLY_RE.test(node.value) ? imagesOf(node.value) : null;
      if (!images) throw new Unsupported('html');
      return { type: 'paragraph', ...(block ? { attrs: { align: block[2]!.toLowerCase() } } : {}), content: images };
    }
    default:
      throw new Unsupported(node.type);
  }
}

const CALLOUT_RE = new RegExp(`^\\[!(${CALLOUT_KINDS.join('|')})\\][ \\t]*(?:\\n|$)`, 'i');

/** `> [!NOTE]` on the first line of a blockquote → callout (GitHub alert syntax). */
function calloutToPM(node: Blockquote, src: string): PMNode | null {
  const first = node.children[0];
  if (first?.type !== 'paragraph') return null;
  const lead = first.children[0];
  if (lead?.type !== 'text') return null;
  const m = CALLOUT_RE.exec(lead.value);
  if (!m) return null;
  const rest = lead.value.slice(m[0].length);
  const firstChildren = [...(rest ? [{ ...lead, value: rest }] : []), ...first.children.slice(1)] as PhrasingContent[];
  const blocks = [
    ...(firstChildren.length ? [blockToPM({ ...first, children: firstChildren } as Paragraph, src)] : []),
    ...node.children.slice(1).map((c) => blockToPM(c, src)),
  ];
  if (!blocks.length) throw new Unsupported('empty callout');
  return { type: 'callout', attrs: { kind: m[1]!.toUpperCase() }, content: blocks };
}

/** A run of sibling blocks that forms one editor node; `node: null` means "keep the source as raw". */
export interface BlockSpan {
  start: number;
  end: number;
  node: PMNode | null;
}

const ALIGN_OPEN_RE = /^<div\s+align=["']?(left|center|right)["']?\s*>\s*$/i;
const ALIGN_CLOSE_RE = /^<\/div>\s*$/i;
/** One HTML block holding only an aligned wrapper with images: `<p align="center"><img …></p>`. */
const ALIGN_BLOCK_RE = /^<(p|div)\s+align=["']?(left|center|right)["']?\s*>\s*((?:<img\b[^>]*>\s*)+)<\/\1>\s*$/i;
const IMG_ONLY_RE = /^\s*(?:<img\b[^>]*>\s*)+$/i;
const IMG_ATTRS = new Set(['src', 'alt', 'title', 'width', 'height']);

/**
 * `<img …>` with only the attributes the editor knows (src, alt, title, width, height) →
 * image attrs; anything else (style, class, align …) returns null and stays raw.
 */
export function parseImgTag(tag: string): Record<string, string | null> | null {
  const m = /^<img\b([^>]*?)\/?>$/i.exec(tag.trim());
  if (!m) return null;
  const attrs: Record<string, string | null> = { src: null, alt: null, title: null, width: null, height: null };
  const re = /\s*([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let rest = m[1]!;
  re.lastIndex = 0;
  let a: RegExpExecArray | null;
  let consumed = 0;
  while (consumed < rest.length && (a = re.exec(rest))) {
    if (!a[0]) break;
    consumed = re.lastIndex;
    const name = a[1]!.toLowerCase();
    if (!IMG_ATTRS.has(name) || attrs[name] !== null) return null;
    attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
  }
  rest = rest.slice(consumed);
  if (rest.trim() || !attrs.src) return null;
  return attrs;
}

/** The `<img>` tags of an HTML snippet as image nodes, or null if one is not plain. */
function imagesOf(html: string): PMNode[] | null {
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  const images = tags.map(parseImgTag);
  return images.length && images.every((i) => i) ? images.map((attrs) => ({ type: 'image', attrs: attrs! })) : null;
}

const DETAILS_OPEN_RE = /^<details(\s+open(?:=(?:""|''|"open"|'open'))?)?\s*>\s*<summary>([^<]*)<\/summary>\s*$/i;
const DETAILS_CLOSE_RE = /^<\/details>\s*$/i;
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/**
 * Converts sibling blocks to editor nodes. `<details>` … `</details>` spans several sibling
 * blocks in Markdown (HTML lines around normal Markdown), so they are grouped into one span.
 */
export function blocksToPM(children: RootContent[], src: string): BlockSpan[] {
  const out: BlockSpan[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const start = child.position!.start.offset!;
    // `<div align="center">`, blank line, one paragraph (or image line), blank line, `</div>`.
    const inner = children[i + 1];
    const close = children[i + 2];
    if (child.type === 'html' && ALIGN_OPEN_RE.test(child.value) && close?.type === 'html' && ALIGN_CLOSE_RE.test(close.value)) {
      const align = ALIGN_OPEN_RE.exec(child.value)![1]!.toLowerCase();
      const content = inner?.type === 'paragraph' ? inlineToPM(inner.children, src) : inner?.type === 'html' && IMG_ONLY_RE.test(inner.value) ? imagesOf(inner.value) : null;
      if (content) {
        out.push({ start, end: close.position!.end.offset!, node: { type: 'paragraph', attrs: { align }, content } });
        i += 2;
        continue;
      }
    }
    if (child.type === 'html' && /^<details[\s>]/i.test(child.value)) {
      let depth = 0;
      let j = i;
      for (; j < children.length; j++) {
        const c = children[j]!;
        if (c.type !== 'html') continue;
        depth += count(c.value, /<details[\s>]/gi) - count(c.value, /<\/details>/gi);
        if (depth <= 0) break;
      }
      if (j > i && j < children.length) {
        out.push({ start, end: children[j]!.position!.end.offset!, node: detailsToPM(children.slice(i, j + 1), src) });
        i = j;
        continue;
      }
    }
    let node: PMNode | null;
    try {
      node = blockToPM(child, src);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      node = null;
    }
    out.push({ start, end: child.position!.end.offset!, node });
  }
  return out;
}

function detailsToPM(group: RootContent[], src: string): PMNode | null {
  const open = group[0]!;
  const close = group[group.length - 1]!;
  if (open.type !== 'html' || close.type !== 'html') return null;
  const m = DETAILS_OPEN_RE.exec(open.value);
  if (!m || !DETAILS_CLOSE_RE.test(close.value)) return null;
  const inner = blocksToPM(group.slice(1, -1), src).map(
    (b): PMNode => b.node ?? { type: 'rawBlock', attrs: { markdown: src.slice(b.start, b.end) } },
  );
  const summary = decodeEntities(m[2]!.trim());
  return {
    type: 'details',
    attrs: { open: m[1] !== undefined },
    content: [
      { type: 'detailsSummary', content: summary ? [{ type: 'text', text: summary }] : [] },
      { type: 'detailsContent', content: inner.length ? inner : [{ type: 'paragraph', content: [] }] },
    ],
  };
}

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e]!);
}

function listToPM(list: List, src: string): PMNode {
  const checked = list.children.map((item) => item.checked);
  const isTask = checked.every((c) => typeof c === 'boolean');
  if (!isTask && checked.some((c) => typeof c === 'boolean')) throw new Unsupported('mixed task list');

  const items = list.children.map((item): PMNode => {
    const blocks = item.children.map((c) => blockToPM(c, src));
    if (blocks.length === 0) blocks.push({ type: 'paragraph', content: [] });
    if (blocks[0]?.type !== 'paragraph') throw new Unsupported('list item not starting with paragraph');
    return isTask
      ? { type: 'taskItem', attrs: { checked: item.checked === true }, content: blocks }
      : { type: 'listItem', content: blocks };
  });

  if (isTask) {
    if (list.ordered) throw new Unsupported('ordered task list');
    return { type: 'taskList', content: items };
  }
  if (list.ordered) return { type: 'orderedList', attrs: { start: list.start ?? 1 }, content: items };
  return { type: 'bulletList', content: items };
}

function tableToPM(table: Table, src: string): PMNode {
  const align = table.align ?? [];
  const columns = table.children[0]?.children.length ?? 0;
  return {
    type: 'table',
    content: table.children.map((row, r) => ({
      type: 'tableRow',
      // GFM semantics: every row has exactly as many cells as the header row.
      content: Array.from({ length: columns }, (_, c) => ({
        type: r === 0 ? 'tableHeader' : 'tableCell',
        attrs: { align: align[c] ?? null },
        // `<br>` is how a cell holds a line break (to-markdown writes it so): a real break in the editor.
        content: [{ type: 'paragraph', content: inlineToPM(row.children[c]?.children ?? [], src).map(cellBreak) }],
      })),
    })),
  };
}

function cellBreak(n: PMNode): PMNode {
  if (n.type !== 'rawInline' || !/^<br\s*\/?>$/i.test(String(n.attrs?.markdown))) return n;
  return n.marks ? { type: 'hardBreak', marks: n.marks } : { type: 'hardBreak' };
}

export function inlineToPM(nodes: PhrasingContent[], src: string, marks: PMMark[] = []): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        // Soft line breaks become their own node (see SoftBreak in schema.ts).
        node.value.split('\n').forEach((part, i) => {
          if (i) out.push(withMarks({ type: 'softBreak' }, marks));
          if (part) pushText(out, part, marks);
        });
        break;
      case 'strong':
        out.push(...inlineToPM(node.children, src, [...marks, { type: 'bold' }]));
        break;
      case 'emphasis':
        out.push(...inlineToPM(node.children, src, [...marks, { type: 'italic' }]));
        break;
      case 'delete':
        out.push(...inlineToPM(node.children, src, [...marks, { type: 'strike' }]));
        break;
      case 'inlineCode':
        // CommonMark renders line endings inside code spans as spaces.
        pushText(out, node.value.replace(/\r?\n/g, ' '), [...marks, { type: 'code' }]);
        break;
      case 'link':
        out.push(
          ...inlineToPM(node.children, src, [
            ...marks,
            { type: 'link', attrs: { href: node.url, title: node.title ?? null } },
          ]),
        );
        break;
      case 'break':
        out.push(withMarks({ type: 'hardBreak' }, marks));
        break;
      case 'image':
        out.push(withMarks({ type: 'image', attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null } }, marks));
        break;
      case 'html': {
        const attrs = parseImgTag(node.value);
        out.push(withMarks(attrs ? { type: 'image', attrs } : { type: 'rawInline', attrs: { markdown: sourceOf(node, src) } }, marks));
        break;
      }
      case 'inlineMath': {
        // "$5 und $10" is money, not math: like GitHub, no space right inside the dollars.
        const source = sourceOf(node, src);
        if (/^\$+\s|\s\$+$/.test(source) || !node.value.trim()) out.push(withMarks({ type: 'rawInline', attrs: { markdown: source } }, marks));
        else out.push(withMarks({ type: 'mathInline', attrs: { latex: node.value } }, marks));
        break;
      }
      default:
        out.push(withMarks({ type: 'rawInline', attrs: { markdown: sourceOf(node, src) } }, marks));
    }
  }
  return mergeText(out);
}

function pushText(out: PMNode[], text: string, marks: PMMark[]) {
  if (text) out.push(withMarks({ type: 'text', text }, marks));
}

function withMarks(node: PMNode, marks: PMMark[]): PMNode {
  return marks.length ? { ...node, marks } : node;
}

function mergeText(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev?.type === 'text' && node.type === 'text' && sameMarks(prev.marks, node.marks)) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (node.text ?? '') };
    } else {
      out.push(node);
    }
  }
  return out;
}

function sameMarks(a: PMMark[] = [], b: PMMark[] = []): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sourceOf(node: Nodes, src: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Unsupported(`no position for ${node.type}`);
  return src.slice(start, end);
}
