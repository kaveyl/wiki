// Trilium Notes: right-click a note → Export → „Markdown“ gives a ZIP with `!!!meta.json` (the tree: titles, types,
// labels, relations, attachments, clones) and a file per note. Checked with a real export of Trilium 0.106.1
// (28.10.2026). The tree comes from the meta file, so names are Trilium's titles (not its shortened file names, which
// drop `: / ?` and number clashes as `1_Name`); a note with text and children becomes the page of its folder. What the
// Markdown export leaves as HTML is turned into Markdown: pictures (`<figure>`), references, embedded notes (by id),
// footnotes, `<details>`, tables. Code and Mermaid notes become notes with a code block, canvases a picture of their
// drawing; protected notes are not in the export (only their place) – named in the report.
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { setFrontmatterKeys, type FrontmatterValue } from '@kaveyl-wiki/core';
import type { Draft, DraftFile, DraftNote, ImportFormat } from '../types.js';
import { htmlToMarkdown, imgTagsToMarkdown } from '../html.js';
import { linksToText, marksToBold, outsideCode, relHref as href, trimPictureIndent, warn } from '../text.js';

const META = '!!!meta.json';

interface Attribute {
  type: 'label' | 'relation';
  name: string;
  value: string;
}
interface Attachment {
  attachmentId: string;
  title: string;
  role?: string;
  dataFileName?: string;
}
interface MetaNote {
  noteId: string;
  title: string;
  type?: string;
  mime?: string;
  prefix?: string | null;
  isClone?: boolean;
  format?: string;
  dataFileName?: string;
  dirFileName?: string;
  attributes?: Attribute[];
  attachments?: Attachment[];
  children?: MetaNote[];
  /** The HTML export's own pages (index, navigation, style). */
  noImport?: boolean;
}

/** Labels that steer Trilium itself (views, scripts, templates) – no information for a note in Kaveyl Wiki. */
const OWN_LABELS = new Set([
  'iconClass', 'viewType', 'originalFileName', 'searchString', 'webViewSrc', 'excludeFromExport', 'cssClass', 'template',
  'workspace', 'workspaceIconClass', 'workspaceTabBackgroundColor', 'run', 'runOnInstance', 'runAtHour', 'widget', 'appCss',
  'appTheme', 'customRequestHandler', 'customResourceProvider', 'hideChildrenOverview', 'sorted', 'sortDirection', 'top',
  'bottom', 'readOnly', 'autoReadOnlyDisabled', 'shareRoot', 'shareHiddenFromTree', 'mapType', 'calendarRoot', 'expanded',
  'dateNote', 'monthNote', 'yearNote', 'weekNote', 'archived', 'color', 'title', 'tags',
]);
const OWN_RELATIONS = new Set(['includeNoteLink', 'relationMapLink', 'renderNote', 'template', 'inherit', 'imageLink', 'internalLink', 'widget', 'runOnNoteCreation', 'runOnNoteChange', 'runOnAttributeChange', 'shareCss', 'shareJs', 'shareTemplate']);
/** Notes Trilium shows by running something – nothing to take over. */
const DYNAMIC = new Set(['search', 'render', 'noteMap', 'launcher', 'contentWidget', 'shortcut', 'llmChat', 'doc']);
const DRAWINGS = new Set(['canvas', 'mindMap', 'relationMap', 'spreadsheet']);

export const trilium: ImportFormat = {
  id: 'trilium',
  label: 'Trilium',
  async detect(files) {
    const meta = files.find((f) => f.path === META);
    return meta && /"formatVersion"/.test((await meta.text())?.slice(0, 200) ?? '') ? 5 : 0;
  },
  async convert(files) {
    const at = new Map(files.map((f) => [f.path, f]));
    let meta: { files?: MetaNote[] };
    try {
      meta = JSON.parse((await at.get(META)?.text()) ?? '{}') as { files?: MetaNote[] };
    } catch {
      meta = {};
    }
    const notes: DraftNote[] = [];
    const out: DraftFile[] = [];
    const report = { protected: [] as string[], dynamic: [] as string[], drawings: [] as string[], clones: [] as string[], props: [] as string[], html: [] as string[], outside: [] as string[], simplified: [] as string[], missing: [] as string[] };
    // Where each note's file and each attachment lies in the export (links and embeds point there by path or id).
    const pathOf = new Map<string, string>();
    const titleOf = new Map<string, string>();
    const attachmentAt = new Map<string, string>();
    const index = (n: MetaNote, dir: string) => {
      if (n.isClone) return;
      titleOf.set(n.noteId, n.title);
      if (n.dataFileName && !pathOf.has(n.noteId)) pathOf.set(n.noteId, join(dir, n.dataFileName));
      for (const a of n.attachments ?? []) if (a.dataFileName) attachmentAt.set(a.attachmentId, join(dir, a.dataFileName));
      for (const c of n.children ?? []) index(c, n.dirFileName ? join(dir, n.dirFileName) : dir);
    };
    for (const n of meta.files ?? []) index(n, '');

    let markdownTexts = 0;
    const walk = async (n: MetaNote, dir: string, outDir: string[], outKeys: string[], top: boolean) => {
      // Without the protected session Trilium exports a protected note as „[protected]“, without content.
      if (n.noImport) return;
      if (n.title === '[protected]' && !n.dataFileName) {
        const count = (x: MetaNote): number => 1 + (x.children ?? []).reduce((sum, c) => sum + count(c), 0);
        // Their titles are not in the export either – the report names where they were (once per note).
        report.protected.push(...Array.from({ length: count(n) }, () => outDir.join('/') || '/'));
        return;
      }
      const from = n.dataFileName ? join(dir, n.dataFileName) : '';
      const childDir = n.dirFileName ? join(dir, n.dirFileName) : null;
      const kids = n.children ?? [];
      const own = top ? [] : [...outDir, n.title];
      // Folders are named by title – two of the same name stay apart by where they are in the export.
      const ownKeys = top ? [] : [...outKeys, childDir ?? `${dir}#${n.noteId}`];
      const name = n.prefix ? `${n.prefix} - ${n.title}` : n.title;
      const place = kids.length ? { dir: own, dirKeys: ownKeys, name, folderPage: true } : { dir: outDir, dirKeys: outKeys, name };
      const source = from ? at.get(from) : undefined;
      const add = (content: string) => {
        const fm = frontmatterOf(n.attributes ?? [], titleOf);
        if (Object.keys(fm).length) report.props.push(from);
        notes.push({ from, ...place, content: Object.keys(fm).length ? setFrontmatterKeys(content, fm) : content });
      };

      if (n.isClone) {
        const primary = pathOf.get(n.noteId);
        report.clones.push(from);
        if (primary) notes.push({ from, dir: outDir, dirKeys: outKeys, name, content: `[${escapeText(n.title)}](${href(from, primary)})\n` });
      } else if (n.type === 'text' || (!n.type && /\.md$/i.test(from))) {
        // Without its file (a hand-made `!!!meta.json`) only a folder is left, never an empty note.
        const raw = source ? await source.text() : kids.length ? '' : null;
        if (raw === null) report.missing.push(from || n.title);
        else if (raw.trim() || !kids.length) {
          const ctx = { from, pathOf, titleOf, attachmentAt, report };
          if (n.format !== 'html') markdownTexts++;
          add(n.format === 'html' ? htmlNote(raw, n.title, ctx) : markdownNote(raw, n.title, ctx));
        }
      } else if (n.type === 'code' || n.type === 'mermaid') {
        const raw = source ? await source.text() : null;
        if (raw === null) report.missing.push(from || n.title);
        else if (/^text\/(x-)?markdown/.test(n.mime ?? '')) add(raw);
        else add(fenced(raw, n.type === 'mermaid' ? 'mermaid' : languageOf(n.mime ?? '')));
      } else if (n.type === 'image' || n.type === 'file') {
        if (source) out.push({ from, dir: outDir, dirKeys: outKeys, name: withExtension(n.title, from), source });
      } else if (n.type === 'webView') {
        const url = n.attributes?.find((a) => a.type === 'label' && a.name === 'webViewSrc')?.value;
        if (url && /^https?:\/\//i.test(url)) add(`<${url}>\n`);
        else report.dynamic.push(n.title);
      } else if (n.type && DRAWINGS.has(n.type)) {
        report.drawings.push(n.title);
        if (source) out.push({ from, dir: outDir, dirKeys: outKeys, name: `${n.title}.${n.type === 'canvas' ? 'excalidraw' : n.type}.json`, source });
        // The picture Trilium saved of the drawing makes it visible; the drawing itself stays as a file next to it.
        const picture = n.attachments?.find((a) => /-export\.(svg|png)$/.test(a.title) && a.dataFileName);
        if (picture) add(`![${escapeText(n.title)}](${href(from, join(dir, picture.dataFileName!))})\n`);
      } else if (n.type && DYNAMIC.has(n.type)) report.dynamic.push(n.title);
      // book (a collection) and notes without own content: only their children.

      for (const a of n.attachments ?? []) {
        const file = a.dataFileName && at.get(join(dir, a.dataFileName));
        // Mermaid's picture is drawn from its source again; the source is in the note.
        if (!file || (n.type === 'mermaid' && /^mermaid-export\./.test(a.title))) continue;
        // `canvas-export.svg` says nothing – the picture of a drawing is named after the drawing.
        const title = /^[a-z]+-export\.\w+$/i.test(a.title) ? `${n.title}${posix.extname(a.title)}` : a.title;
        out.push({ from: file.path, dir: place.dir, dirKeys: place.dirKeys, name: withExtension(title, file.path), source: file });
      }
      for (const c of kids) await walk(c, childDir ?? dir, own, ownKeys, false);
    };
    for (const n of meta.files ?? []) await walk(n, '', [], [], true);

    const draft: Draft = { notes, files: out, warnings: [] };
    const w = (text: string, list: string[], asItems = false) => warn(draft, text, list, asItems);
    if (report.protected.length) draft.warnings.push({ text: 'Geschützte Notizen – Trilium exportiert sie ohne Titel und Inhalt, nicht übernommen (genannt ist der Ordner, in dem sie waren)', items: report.protected });
    w('Klone – am ersten Ort übernommen, an den weiteren Orten als Link dorthin', report.clones);
    w('Labels und Beziehungen von Trilium – als Eigenschaften im Frontmatter übernommen', report.props);
    w('Leinwände, Mindmaps und Beziehungskarten – als Datei (JSON) übernommen, Leinwände mit ihrem Bild', report.drawings, true);
    w('Suchen, Render-, Webseiten- und Karten-Notizen von Trilium – nicht übernommen', report.dynamic, true);
    w('Links auf Notizen, die nicht im Export sind – nur der Text bleibt', report.outside);
    w('Tabellen mit verbundenen Zellen oder Absätzen – vereinfacht als Markdown-Tabelle, bitte prüfen', report.simplified);
    // The HTML export loses tasks, boxes, marks, <details> and code languages on the way – the Markdown export keeps them.
    if (report.html.length && !markdownTexts) draft.warnings.unshift({ text: 'Trilium-Export im HTML-Format – Aufgaben, Hinweisboxen, Markierungen, aufklappbare Abschnitte und die Sprache von Codeblöcken kommen nicht richtig an, besser in Trilium als „Markdown“ exportieren' });
    w('Notizen im HTML-Format – in Markdown umgewandelt, bitte Aussehen prüfen', report.html);
    w('Dateien, die im Export fehlen oder kein Text sind – nicht übernommen', report.missing, true);
    return draft;
  },
};

interface Context {
  from: string;
  pathOf: Map<string, string>;
  titleOf: Map<string, string>;
  attachmentAt: Map<string, string>;
  report: { outside: string[]; simplified: string[]; html: string[] };
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** Links into Trilium's tree (`#root/…`): to notes the export does not hold. */
const ROOT = /#root\/[^\s)>]*/;

const escapeText = (s: string) => s.replace(/[[\]\\]/g, '\\$&');
const angle = (url: string) => (/[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url);
const NAMED: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', quot: '"', amp: '&' };
/** The entities of an attribute or label, numeric ones too (`&#106;avascript:` must read as what it is). */
const decodeEntities = (s: string) =>
  s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(nbsp|lt|gt|quot|amp));/gi, (all, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()]!;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });

/** The note's title, once more as `# Titel` + CRLF at the very top (Trilium adds it) – it is the file name already. */
function withoutTitle(raw: string, title: string): string {
  const text = raw.replace(/\r\n?/g, '\n');
  const first = text.indexOf('\n');
  const line = first < 0 ? text : text.slice(0, first);
  return line.trim() === `# ${title}`.trim() ? text.slice(first < 0 ? text.length : first + 1).replace(/^\n+/, '') : text;
}

function markdownNote(raw: string, title: string, ctx: Context): string {
  let text = withoutTitle(raw, title);
  text = footnotes(text);
  text = outsideCode(text, (part) => blocks(part, ctx), false);
  text = outsideCode(text, (part) => inline(part, ctx));
  return text.replace(/\n*$/, '\n');
}

function htmlNote(raw: string, title: string, ctx: Context): string {
  ctx.report.html.push(ctx.from);
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(raw)?.[1] ?? raw;
  // Formulas and footnotes go aside before the HTML converter (it would escape them) and come back as Markdown;
  // formulas after the inline changes, which must not touch them.
  const math = new Kept('kwmath', raw);
  const notes = new Kept('kwnote', raw);
  const html = footnotesHtml(formulas(body, math), notes);
  const text = notes.restore(htmlToMarkdown(html.replace(/<h1[^<>]*data-trilium-h1[^<>]*>(?:(?!<h1\b)[\s\S])*?<\/h1>/i, '')));
  return math.restore(withoutTitle(outsideCode(text, (part) => inline(part, ctx)), title)).replace(/\n*$/, '\n');
}

/** Markdown kept aside under a token of letters and digits (no converter changes it) – the token is not in the note. */
export class Kept {
  private readonly items: string[] = [];
  private readonly token: string;
  constructor(prefix: string, text: string) {
    // A random part: counting up until the note does not hold it was quadratic on a note made of such tokens.
    let token: string;
    do token = `${prefix}${randomBytes(6).toString('hex')}x`;
    while (text.includes(token));
    this.token = token;
  }
  keep(markdown: string): string {
    this.items.push(markdown);
    return `${this.token}${this.items.length - 1}z`;
  }
  /** Kept parts may hold tokens of earlier ones (a formula in a footnote). */
  restore(text: string): string {
    return text.replace(new RegExp(`${this.token}(\\d+)z`, 'g'), (all, i: string) => {
      const md = this.items[Number(i)];
      return md === undefined ? all : this.restore(md);
    });
  }
}

/** CKEditor's formulas: `<span class="math-tex">\(…\)</span>` → `$…$`, `\[…\]` → `$$…$$` (as the Markdown export writes them). */
export function formulas(html: string, kept: Kept): string {
  return html.replace(/<span\s+class="math-tex"[^<>]*>((?:(?!<\/?span\b)[\s\S])*)<\/span>/gi, (all, tex: string) => {
    const m = /^\s*\\([([])([\s\S]*)\\([)\]])\s*$/.exec(decodeEntities(tex));
    if (!m || (m[1] === '(') !== (m[3] === ')')) return all;
    return kept.keep(m[1] === '(' ? `$${m[2]!.trim()}$` : `$$${m[2]!.trim()}$$`);
  });
}

/**
 * CKEditor's footnotes in the HTML export: the reference `<span class="footnote-reference" data-footnote-index="1">` →
 * `[^1]`, the list `<ol class="footnote-section">` → `[^1]: Text` lines where it was. Read tag by tag (linear).
 */
export function footnotesHtml(html: string, kept: Kept): string {
  const refs = html.replace(/<span\s+class="footnote-reference"[^<>]*>(?:(?!<span\b)[\s\S])*?<\/span>/gi, (all) => {
    const n = /data-footnote-index="(\d{1,6})"/.exec(/^<[^>]*>/.exec(all)![0])?.[1];
    return n ? kept.keep(`[^${n}]`) : all;
  });
  let out = '';
  let done = 0;
  for (const m of refs.matchAll(/<ol\b[^<>]*>/gi)) {
    if (m.index < done || !m[0].includes('footnote-section')) continue;
    const end = closingOl(refs, m.index + m[0].length);
    if (!end) break;
    const lines = footnoteItems(refs.slice(m.index + m[0].length, end.at));
    out += refs.slice(done, m.index) + (lines.length ? `<p>${kept.keep(lines.join('\n'))}</p>` : '');
    done = end.at + end.length;
  }
  return out + refs.slice(done);
}

/** Where the `</ol>` that closes an `<ol>` opened before `from` begins (lists inside a footnote counted) – or null. */
function closingOl(html: string, from: number): { at: number; length: number } | null {
  const tags = /<(\/?)ol\b[^<>]*>/gi;
  tags.lastIndex = from;
  for (let depth = 1, m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (!depth) return { at: m.index, length: m[0].length };
  }
  return null;
}

/** The footnotes of a footnote list as `[^1]: Text` (more paragraphs indented). */
function footnoteItems(list: string): string[] {
  const items = [...list.matchAll(/<li\b[^<>]*>/gi)].filter((m) => m[0].includes('data-footnote-item'));
  return items.flatMap((m, i) => {
    const n = /data-footnote-index="(\d{1,6})"/.exec(m[0])?.[1];
    if (!n) return [];
    const inner = list.slice(m.index + m[0].length, items[i + 1]?.index ?? list.length).replace(/<\/li>\s*$/i, '');
    const text = htmlToMarkdown(inner.replace(/<span\s+class="footnote-back-link"[^<>]*>(?:(?!<span\b)[\s\S])*?<\/span>/i, ''));
    return [`[^${n}]: ${text.replace(/\n/g, '\n    ')}`];
  });
}

/** HTML blocks the Markdown export leaves: `<details>` and tables Markdown cannot hold. */
function blocks(part: string, ctx: Context): string {
  const details = replaceBlocks(
    part,
    /^[ \t]*<details[^>\n]*>/gm,
    '</details>',
    (m) => {
      const summary = /\s*<summary>/y;
      summary.lastIndex = m.index + m[0].length;
      if (!summary.test(part)) return -1;
      const end = part.indexOf('</summary>', summary.lastIndex);
      return end < 0 ? part.length : end;
    },
    (block) => {
      const open = block.indexOf('<summary>') + '<summary>'.length;
      const close = block.indexOf('</summary>', open);
      const md = htmlToMarkdown(block.slice(close + '</summary>'.length, block.lastIndexOf('</details>')).replace(/^[ \t]+/gm, ''));
      return `<details>\n<summary>${block.slice(open, close).trim()}</summary>\n\n${md}\n\n</details>`;
    },
  );
  return replaceBlocks(
    details,
    /^[ \t]*<table/gm,
    '</table>',
    (m) => m.index + m[0].length,
    (table) => {
      ctx.report.simplified.push(ctx.from);
      return htmlToMarkdown(table.replace(/^[ \t]+/gm, '').replace(/<\/p>\s*<p>/g, ' '));
    },
  );
}

/** Each block from a line starting with `open` to the first `close` that ends a line, replaced by `fn` – in one pass:
 *  as one regex with lazy groups (`^<details>…</details>$`) crafted input took minutes. `from` says where to look for
 *  `close` (-1: the opener does not fit, the end of the text: no later opener fits either). */
function replaceBlocks(text: string, open: RegExp, close: string, from: (m: RegExpExecArray) => number, fn: (block: string) => string): string {
  let out = '';
  let done = 0;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const at = from(m);
    if (at < 0) continue;
    const end = closingLine(text, close, at);
    // A later opener finds no closing line either.
    if (end < 0) break;
    out += text.slice(done, m.index) + fn(text.slice(m.index, end));
    done = open.lastIndex = end;
  }
  open.lastIndex = 0;
  return out + text.slice(done);
}

/** Where the first `close` with only spaces after it on its line ends, from `at` on – or -1. */
function closingLine(text: string, close: string, at: number): number {
  for (let i = text.indexOf(close, at); i >= 0; i = text.indexOf(close, i + 1)) {
    let end = i + close.length;
    while (text[end] === ' ' || text[end] === '\t') end++;
    if (end === text.length || text[end] === '\n' || text[end] === '\r') return end;
  }
  return -1;
}

/**
 * Pictures, references, embedded notes, download links and links out of the export, inside a paragraph. A tag's content
 * never reaches past the next opener of the same tag – linear even when the closers are missing.
 */
function inline(part: string, ctx: Context): string {
  let outside = false;
  const linked = part
    .replace(/<figure\b[^<>]*>\s*(<img\b[^<>]*>)\s*(?:<figcaption>(?:(?!<figure\b)[\s\S])*?<\/figcaption>\s*)?<\/figure>/gi, (_all, img: string) => ` ${imgTagsToMarkdown(img)} `)
    .replace(/<a\s+class="reference-link"\s+href="([^"]*)"[^<>]*>((?:(?!<a\b)[\s\S])*?)<\/a>/gi, (_all, url: string, label: string) => `[${escapeText(decodeEntities(label.replace(/<[^>]+>/g, '')))}](${angle(decodeEntities(url))})`)
    .replace(/<section\s+class="include-note"\s+data-note-id="([\w-]+)"[^<>]*>(?:(?!<section\b)[\s\S])*?<\/section>/gi, (_all, id: string) => {
      const to = ctx.pathOf.get(id);
      if (!to) {
        outside = true;
        return ctx.titleOf.get(id) ?? '';
      }
      return `[${escapeText(ctx.titleOf.get(id) ?? posix.basename(to))}](${href(ctx.from, to)})`;
    })
    .replace(/\]\(\s*<?api\/attachments\/([\w-]+)\/download>?\s*\)/g, (all, id: string) => {
      const to = ctx.attachmentAt.get(id);
      return to ? `](${href(ctx.from, to)})` : all;
    });
  const plain = linksToText(linked, ROOT);
  if (plain !== linked) outside = true;
  const text = marksToBold(plain.replace(/<mark\b[^<>]*>((?:(?!<mark\b)[\s\S])*?)<\/mark>/gi, '**$1**'))
    .replace(/<span\s+style="[^"]*">((?:(?!<span\b)[\s\S])*?)<\/span>/gi, '$1');
  // The one space around a picture from a <figure> – not a list item's indent or the two of a hard line break.
  const tidy = trimPictureIndent(text).replace(/(\)) $/gm, '$1');
  if (outside) ctx.report.outside.push(ctx.from);
  return imgTagsToMarkdown(tidy);
}

/** CKEditor's footnotes, as the export leaves them: `<sup><a href="#fnX">[1]</a></sup>` and a numbered list → `[^1]`. */
function footnotes(text: string): string {
  const numbers = new Map<string, string>();
  let out = text.replace(/<sup><a href="#fn([\w-]+)">\[(\d+)\]<\/a><\/sup>/g, (_all, id: string, n: string) => {
    numbers.set(id, n);
    return `[^${n}]`;
  });
  if (!numbers.size) return text;
  const lines = out.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\d+\.\s+<sup><strong><a href="#fnref([\w-]+)">\^<\/a><\/strong><\/sup>\s*$/.exec(lines[i]!);
    if (!m) {
      result.push(lines[i]!);
      continue;
    }
    const body: string[] = [];
    while (i + 1 < lines.length && (/^ {4}/.test(lines[i + 1]!) || (!lines[i + 1]!.trim() && /^ {4}\S/.test(lines[i + 2] ?? '')))) body.push(lines[++i]!.replace(/^ {4}/, ''));
    const paragraphs = body.join('\n').trim().replace(/\n/g, '\n    ');
    result.push(`[^${numbers.get(m[1]!) ?? '?'}]: ${paragraphs}`);
  }
  out = result.join('\n');
  return out;
}

/** Trilium's labels and relations → frontmatter: labels without value are tags, the others keep their name. */
function frontmatterOf(attributes: Attribute[], titleOf: Map<string, string>): Record<string, FrontmatterValue> {
  // A Map: a label may be called `toString` or `__proto__`.
  const fm = new Map<string, FrontmatterValue>();
  const tags: string[] = [];
  const put = (key: string, value: string) => {
    const had = fm.get(key);
    fm.set(key, had === undefined ? value : Array.isArray(had) ? [...had, value] : [String(had), value]);
  };
  for (const a of attributes) {
    if (a.name.includes(':')) continue;
    if (a.type === 'label') {
      if (OWN_LABELS.has(a.name)) continue;
      if (!a.value) tags.push(a.name);
      else put(a.name, a.value);
      if (a.value && /^-?\d{1,15}(\.\d+)?$/.test(a.value) && fm.get(a.name) === a.value) fm.set(a.name, Number(a.value));
    } else if (!OWN_RELATIONS.has(a.name)) {
      const target = titleOf.get(a.value);
      if (target) put(a.name, target);
    }
  }
  if (tags.length) fm.set('tags', tags);
  return Object.fromEntries(fm);
}

/** Trilium's MIME type of a code note → the language of a code block. */
function languageOf(mime: string): string {
  const m = mime.split(';')[0]!.trim().toLowerCase();
  if (/javascript|ecmascript/.test(m)) return 'javascript';
  if (/typescript/.test(m)) return 'typescript';
  if (m === 'text/plain' || !m) return '';
  return m.replace(/^(text|application)\/(x-)?/, '').replace(/src$/, '').replace(/[^a-z0-9+#-]/g, '');
}

function fenced(code: string, lang: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}\n`;
}

/** A file name from the title, with the extension of the exported file when the title has none. */
function withExtension(title: string, path: string): string {
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(posix.basename(path))?.[0] ?? '';
  // „Plan v1.2“ ends in no file type – the file's own one counts.
  return !ext || /\.[A-Za-z0-9]{1,6}$/.exec(title)?.[0].toLowerCase() === ext.toLowerCase() ? title : `${title}${ext}`;
}

