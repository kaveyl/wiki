// HTML export (PLAN Phase 6, AD-027): a note as one self-contained HTML file (images inlined),
// a folder or source as a ZIP with one HTML file per note, links between them rewritten to
// `.html`, referenced images/files copied, and an index page. Raw HTML from the Markdown is
// shown as text, never executed. Encrypted notes are left out (their body never leaves the
// browser in plain text). The same HTML serves as the print view.
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { isScriptUrl, parseMarkdown, readFrontmatter, resolveHref, splitFrontmatter } from '@kaveyl-wiki/core';
import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';
import { zipSync, strToU8 } from 'fflate';
import type { Root, RootContent, Link, Image, Definition, Html, Code } from 'mdast';
import { fileReferences } from '../markdown/fileRefs.js';
import { markdown } from '../markdown/pool.js';

/** Math nodes from remark-math (not part of the base mdast types). */
type MathLike = { type: 'math' | 'inlineMath'; value: string };
import { absPath, type Mount } from '../mounts/model.js';
import { isEncryptedNote } from './encryption.js';
import { isServable } from './attachments.js';
import { noteName } from '../api/ops.js';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' };
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const CSS = `
:root { color-scheme: light; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --soft: #f6f8fa; --accent: #4f46e5; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: #fff; }
main { max-width: 820px; margin: 0 auto; padding: 40px 24px 80px; }
nav.crumbs { font-size: 13px; color: var(--muted); margin-bottom: 24px; }
nav.crumbs a { color: var(--muted); }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 2em; margin-top: 0; } h2 { font-size: 1.5em; border-bottom: 1px solid var(--line); padding-bottom: .2em; }
a { color: var(--accent); }
img { max-width: 100%; height: auto; }
pre { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
:not(pre) > code { background: var(--soft); padding: .1em .35em; border-radius: 4px; }
blockquote { margin: 1em 0; padding: .4em 1em; border-left: 4px solid var(--line); color: var(--muted); background: var(--soft); border-radius: 0 6px 6px 0; }
table { border-collapse: collapse; margin: 1em 0; } th, td { border: 1px solid var(--line); padding: 6px 10px; } th { background: var(--soft); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
ul.contains-task-list { list-style: none; padding-left: 1.2em; }
.raw-html { color: var(--muted); }
footer { margin-top: 48px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 8px; }
ul.index { list-style: none; padding-left: 0; } ul.index ul { list-style: none; padding-left: 1.2em; } ul.index li { margin: .2em 0; }
@media print {
  body { font-size: 11pt; } main { max-width: none; padding: 0; }
  nav.crumbs, footer { display: none; }
  a { color: inherit; text-decoration: underline; }
  pre, blockquote, table, img { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
  @page { margin: 18mm 16mm; }
}
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function page(title: string, body: string, crumbs = ''): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Kaveyl Wiki">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${crumbs}<article>
${body}
</article>
<footer>Exportiert aus Kaveyl Wiki am ${new Date().toLocaleString('de-DE')}</footer>
</main>
</body>
</html>
`;
}

type Rewrite = { href(href: string): string | null; src(src: string): string | null };

/** The same files /api/files serves: images/PDF or attachments in `assets/`, never dotfiles or encrypted ones. */
const exportable = (p: string) => isServable(p) && !p.endsWith('.age');

/** The parsed body of a note, from the Markdown worker (sec-006); null: too large or too nested for the parser. */
export const treeOf = (raw: string): Promise<Root | null> => markdown.tree(splitFrontmatter(raw.replace(/\r\n/g, '\n')).body);

/**
 * Markdown (with frontmatter) → HTML body; links and image sources go through `rewrite`. `parsed`: the tree from
 * `treeOf` (left out: parsed here, tests); null → the text as it is, in a <pre>.
 */
export function markdownToHtml(raw: string, rewrite: Rewrite, parsed?: Root | null): { title: string; html: string } {
  const { frontmatter, body } = splitFrontmatter(raw.replace(/\r\n/g, '\n'));
  const fm = readFrontmatter(frontmatter);
  if (parsed === null) return { title: typeof fm.title === 'string' ? fm.title : '', html: `<pre class="unparsed">${esc(body)}</pre>` };
  const tree = parsed ?? (parseMarkdown(body) as Root);
  const visit = (nodes: RootContent[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.type === 'link' || n.type === 'definition') {
        const next = rewrite.href((n as Link | Definition).url);
        if (next !== null) (n as Link | Definition).url = next;
        // Same rule as the app: targets that would run code are never kept (the text stays).
        if (isScriptUrl((n as Link | Definition).url)) (n as Link | Definition).url = '';
      } else if (n.type === 'image') {
        const next = rewrite.src((n as Image).url);
        if (next !== null) (n as Image).url = next;
        if (isScriptUrl((n as Image).url) && !/^data:image\//i.test((n as Image).url)) (n as Image).url = '';
      } else if (n.type === 'html') {
        // Raw HTML stays visible as text, it is never executed in an export.
        nodes[i] = { type: 'inlineCode', value: (n as Html).value, data: { hProperties: { className: ['raw-html'] } } } as RootContent;
      } else if ((n.type as string) === 'inlineMath') {
        nodes[i] = { type: 'inlineCode', value: `$${(n as unknown as MathLike).value}$` } as RootContent;
      } else if ((n.type as string) === 'math') {
        nodes[i] = { type: 'code', lang: 'latex', value: (n as unknown as MathLike).value } as Code;
      }
      const kids = (n as { children?: RootContent[] }).children;
      if (kids) visit(kids);
    }
  };
  visit(tree.children);
  const first = tree.children.find((c) => c.type === 'heading' && c.depth === 1) as { children: { value?: string }[] } | undefined;
  const title = (typeof fm.title === 'string' && fm.title) || first?.children.map((c) => c.value ?? '').join('') || '';
  return { title, html: toHtml(toHast(tree)) };
}

export interface ExportDeps {
  dataPath: string;
  /** Reads a note's raw text (null = not readable / missing). */
  readNote(mount: Mount, path: string): Promise<string | null>;
  /** Whether the user may read this path (ACL). */
  canRead(path: string): boolean;
}

/** One note as a self-contained HTML document (images inlined as data URLs). */
export async function exportNote(mount: Mount, path: string, d: ExportDeps): Promise<{ name: string; html: string }> {
  const raw = (await d.readNote(mount, path)) ?? '';
  const name = noteName(path, mount.options.folderNote);
  if (isEncryptedNote(raw)) return { name, html: page(name, `<h1>${esc(name)}</h1><p>Diese Notiz ist verschlüsselt und wird nicht exportiert.</p>`) };
  const inline = new Map<string, string>();
  // Images first (async), then the synchronous conversion uses the prepared data URLs – their sources from the tree.
  const tree = await treeOf(raw);
  const refs: string[] = [];
  const images = (n: { type: string; url?: string; children?: unknown[] }) => {
    if (n.type === 'image' && n.url) refs.push(n.url);
    for (const c of (n.children ?? []) as (typeof n)[]) images(c);
  };
  if (tree) images(tree);
  for (const src of new Set(refs)) {
    const target = /^[a-z]+:/i.test(src) ? null : resolveHref(src, path);
    if (!target || !d.canRead(target.path)) continue;
    const ext = posix.extname(target.path).slice(1).toLowerCase();
    const mime = MIME[ext];
    if (!mime) continue;
    try {
      const data = await readFile(absPath(mount, d.dataPath, target.path));
      if (data.length <= MAX_INLINE_BYTES) inline.set(src, `data:${mime};base64,${data.toString('base64')}`);
    } catch {
      // missing file: the link stays as it is
    }
  }
  const { title, html } = markdownToHtml(
    raw,
    {
      href: () => null,
      src: (src) => inline.get(src) ?? null,
    },
    tree,
  );
  return { name, html: page(title || name, html) };
}

/**
 * A folder (or the whole source with `folder` = '') as ZIP: one HTML per readable note at the
 * same relative path, links between exported notes rewritten, referenced files copied.
 */
export async function exportFolder(mount: Mount, folder: string, notes: string[], d: ExportDeps): Promise<{ name: string; zip: Uint8Array; count: number }> {
  const prefix = folder ? `${folder}/` : '';
  const inside = notes.filter((p) => (!folder || p.startsWith(prefix)) && d.canRead(p)).sort();
  const rel = (p: string) => p.slice(prefix.length);
  const htmlPath = (p: string) => rel(p).replace(/\.md$/i, '.html');
  const exported = new Set(inside);
  const files: Record<string, Uint8Array> = {};
  const copies = new Set<string>();
  const relLink = (from: string, to: string) => {
    const r = posix.relative(posix.dirname(from), to);
    return encodeURI(r || posix.basename(to));
  };
  // A folder note `index.md` becomes index.html; the generated overview then gets its own name.
  const listName = inside.some((p) => htmlPath(p).toLowerCase() === 'index.html') ? 'inhalt.html' : 'index.html';
  let count = 0;
  for (const p of inside) {
    const raw = (await d.readNote(mount, p)) ?? '';
    if (isEncryptedNote(raw)) continue;
    const out = htmlPath(p);
    const tree = await treeOf(raw);
    const { title, html } = markdownToHtml(raw, {
      href: (href) => {
        if (/^[a-z]+:|^#/i.test(href)) return null;
        const [path, hash] = href.split('#');
        const t = resolveHref(path ?? '', p);
        if (!t) return null;
        const candidates = [t.path, `${t.path}.md`, `${t.path}/${mount.options.folderNote}`];
        const hit = candidates.find((c) => exported.has(c));
        if (hit) return relLink(out, htmlPath(hit)) + (hash ? `#${hash}` : '');
        if (!/\.md$/i.test(t.path) && exportable(t.path) && d.canRead(t.path) && t.path.startsWith(prefix)) {
          copies.add(t.path);
          return relLink(out, rel(t.path));
        }
        return null;
      },
      src: (src) => {
        if (/^[a-z]+:/i.test(src)) return null;
        const t = resolveHref(src, p);
        if (!t || !exportable(t.path) || !d.canRead(t.path) || !t.path.startsWith(prefix)) return null;
        copies.add(t.path);
        return relLink(out, rel(t.path));
      },
    }, tree);
    const depth = out.split('/').length - 1;
    const crumbs = `<nav class="crumbs"><a href="${'../'.repeat(depth)}${listName}">${esc(mount.name)}${folder ? ` / ${esc(folder)}` : ''}</a></nav>\n`;
    files[out] = strToU8(page(title || noteName(p, mount.options.folderNote), html, crumbs));
    count++;
  }
  for (const c of copies) {
    try {
      files[rel(c)] = new Uint8Array(await readFile(absPath(mount, d.dataPath, c)));
    } catch {
      // referenced but missing: skipped
    }
  }
  // Index: the exported notes as a nested list.
  const list = inside.filter((p) => files[htmlPath(p)]);
  const items = list.map((p) => `<li><a href="${encodeURI(htmlPath(p))}">${esc(rel(p).replace(/\.md$/i, ''))}</a></li>`).join('\n');
  const title = folder ? `${mount.name} / ${folder}` : mount.name;
  files[listName] = strToU8(page(title, `<h1>${esc(title)}</h1>\n<p>${count} Notiz${count === 1 ? '' : 'en'}</p>\n<ul class="index">\n${items}\n</ul>`));
  const name = (folder ? posix.basename(folder) : mount.name).replace(/[\\/:*?"<>|]+/g, '-') || 'export';
  return { name, zip: zipSync(files, { level: 6 }), count };
}

/**
 * Markdown export: the notes as they are in the source (byte for byte, encrypted ones stay encrypted)
 * plus the images and files they point to, as ZIP. `path` is a note (with its pictures, paths relative
 * to its folder) or a folder/source (all readable notes in it). Files outside that folder are left out,
 * as in the HTML export.
 */
/** `only`: a single note that uses no pictures or files – its .md as it is, no ZIP needed (owner 28.10.). */
export async function exportMarkdown(mount: Mount, path: string, notes: string[], d: ExportDeps): Promise<{ name: string; zip: Uint8Array; count: number; only?: Uint8Array }> {
  const single = /\.md$/i.test(path);
  const folder = single ? (posix.dirname(path) === '.' ? '' : posix.dirname(path)) : path;
  const prefix = folder ? `${folder}/` : '';
  const inside = (single ? [path] : notes.filter((p) => !folder || p.startsWith(prefix))).filter((p) => d.canRead(p)).sort();
  const rel = (p: string) => p.slice(prefix.length);
  const files: Record<string, Uint8Array> = {};
  const copies = new Set<string>();
  for (const p of inside) {
    let data: Buffer;
    try {
      data = await readFile(absPath(mount, d.dataPath, p));
    } catch {
      continue;
    }
    files[rel(p)] = new Uint8Array(data);
    const raw = data.toString('utf8');
    if (isEncryptedNote(raw)) continue;
    // Same link resolution as the HTML export; only the targets are collected.
    const collect = (href: string) => {
      if (/^[a-z]+:|^#/i.test(href)) return null;
      const t = resolveHref(href.split('#')[0] ?? '', p);
      if (t && !/\.md$/i.test(t.path) && exportable(t.path) && d.canRead(t.path) && t.path.startsWith(prefix)) copies.add(t.path);
      return null;
    };
    const tree = await treeOf(raw);
    // Not parsed (too large, AD-076): its files are found without the parser – the export still carries them.
    if (tree) markdownToHtml(raw, { href: collect, src: collect }, tree);
    else for (const href of fileReferences(raw)) collect(href);
  }
  const count = Object.keys(files).length;
  for (const c of copies) {
    try {
      files[rel(c)] ??= new Uint8Array(await readFile(absPath(mount, d.dataPath, c)));
    } catch {
      // referenced but missing: skipped
    }
  }
  const base = single ? noteName(path, mount.options.folderNote) : folder ? posix.basename(folder) : mount.name;
  const name = base.replace(/[\\/:*?"<>|]+/g, '-') || 'export';
  const all = Object.values(files);
  if (single && all.length === 1) return { name, zip: new Uint8Array(), count, only: all[0] };
  return { name, zip: zipSync(files, { level: 6 }), count };
}
