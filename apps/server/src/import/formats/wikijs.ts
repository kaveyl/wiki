// Wiki.js 2.x: Administration → Storage → „Local File System“ → „Dump all content to disk“ (or the folder of the Git
// storage), zipped. Checked with a real dump of Wiki.js 2.5.317 (28.10.2026). Pages are `.md` (Markdown), `.html`
// (visual editor, raw HTML) or `.adoc` (AsciiDoc), each with Wiki.js's header – written as plain text, not as YAML
// (`title: A: B` is no valid YAML), so it is read line by line. Uploaded files lie between the pages. The main language
// is at the top, every other one in a folder of its own (`en/`); the Git storage puts every page in a language folder
// (`de/`, `en/`) – there the most frequent language is the main one. Links follow Wiki.js's rules: `/de/a/b` and `/a/b`
// (the page's language) from the top, `x` is a child page, `../x` is resolved by the browser against the page address;
// a link that led nowhere in Wiki.js but names a neighbour page is set to it (named in the report). Links to Wiki.js's
// tag pages (`/t/lesung`) become their text – the tags are in the frontmatter.
import { posix } from 'node:path';
import { decodeUriSafe, extractLinks, setFrontmatterKeys, type FrontmatterValue } from '@kaveyl-wiki/core';
import type { SourceFile } from '../zip.js';
import type { Draft, DraftFile, DraftNote, ImportFormat } from '../types.js';
import { htmlToMarkdown } from '../html.js';
import { CALLOUT_KINDS, codeLines, linksToText, outsideCode, relHref, warn } from '../text.js';

const PAGE = /\.(md|html|adoc)$/i;
const KEYS = ['title', 'description', 'published', 'date', 'tags', 'editor', 'dateCreated'];
const HEADER = /^(?:---\r?\n([\s\S]*?)\r?\n---|<!--\r?\n([\s\S]*?)\r?\n-->)[ \t]*(?:\r?\n|$)/;
const LOCALE = /^[a-z]{2}(-[a-z]{2})?$/;
/** Wiki.js's tag browser (`/t/lesung`, `/t/a/b`, `/t`), also below a language. */
const TAG_PAGE = /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?t(?:\/[^\s)>]*)?/;

interface Page {
  file: SourceFile;
  /** Path without extension = the page's address below its language (`bibliothek/standorte`). */
  path: string;
  locale: string;
  meta: Record<string, string>;
  body: string;
  editor: string;
}

export const wikijs: ImportFormat = {
  id: 'wikijs',
  label: 'Wiki.js',
  async detect(files) {
    for (const f of files.filter((x) => /\.(md|html)$/i.test(x.path)).slice(0, 50)) {
      const head = HEADER.exec((await f.text())?.slice(0, 2000) ?? '');
      const fields = head ? (head[1] ?? head[2] ?? '') : '';
      if (/^editor: (markdown|ckeditor|code|asciidoc)\s*$/m.test(fields) && /^dateCreated: /m.test(fields)) return 4;
    }
    return 0;
  },
  async convert(files) {
    // A language folder is a two-letter folder at the top that holds pages (Wiki.js forbids such page paths).
    const pagePaths = files.filter((f) => PAGE.test(f.path) && !f.path.split('/').some((p) => p.startsWith('.'))).map((f) => f.path);
    const locales = new Set(pagePaths.filter((f) => f.includes('/')).map((f) => f.split('/')[0]!).filter((s) => LOCALE.test(s)));
    // The Git storage has no page outside a language folder: the most frequent language is the main one (at the top).
    const main = mainLocale(pagePaths, locales);
    const pages = new Map<string, Page>(); // key: `<locale>/<path>` ('' = main language)
    const out: DraftFile[] = [];
    const notText: string[] = [];
    // The folder of the Git storage holds `.git` (history, remote address – maybe with its password): never content.
    const hidden: string[] = [];
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      if (f.path.split('/').some((p) => p.startsWith('.'))) {
        hidden.push(f.path);
        continue;
      }
      if (!PAGE.test(f.path)) {
        out.push({ from: f.path, dir: f.path.split('/').slice(0, -1), name: posix.basename(f.path), source: f });
        continue;
      }
      const raw = await f.text();
      if (raw === null) {
        notText.push(f.path);
        continue;
      }
      const parts = f.path.replace(PAGE, '').split('/');
      const lang = parts.length > 1 && locales.has(parts[0]!) ? parts.shift()! : '';
      const locale = lang === main ? '' : lang;
      const head = HEADER.exec(raw);
      const meta: Record<string, string> = {};
      if (head)
        for (const line of (head[1] ?? head[2] ?? '').split(/\r?\n/)) {
          const m = /^(\w+):[ \t]?(.*)$/.exec(line);
          if (m && KEYS.includes(m[1]!)) meta[m[1]!] = m[2]!.trim();
        }
      const editor = meta.editor ?? (/\.adoc$/i.test(f.path) ? 'asciidoc' : /\.html$/i.test(f.path) ? 'ckeditor' : 'markdown');
      pages.set(`${locale}/${parts.join('/')}`, { file: f, path: parts.join('/'), locale, meta, body: head ? raw.slice(head[0].length).replace(/^\r?\n/, '') : raw, editor });
    }

    const exists = (locale: string, path: string) => pages.get(`${locale}/${path}`);
    const fileAt = new Set(out.map((f) => f.from));
    const neighbours: string[] = [];
    const tagLinks: string[] = [];
    const html: string[] = [];
    const adoc: string[] = [];
    const drafts: string[] = [];
    const diagrams: string[] = [];
    const notes: DraftNote[] = [];
    // Every folder (per language) that holds a page.
    const holding = new Set([...pages.values()].flatMap((q) => q.path.split('/').slice(0, -1).map((_s, i, segs) => `${q.locale}/${segs.slice(0, i + 1).join('/')}`)));
    for (const p of pages.values()) {
      let body = p.editor === 'ckeditor' || p.editor === 'code' ? htmlToMarkdown(p.body) : p.body.replace(/\r\n/g, '\n');
      if (p.editor === 'ckeditor' || p.editor === 'code') html.push(p.file.path);
      if (p.editor === 'asciidoc') {
        adoc.push(p.file.path);
        body = `\`\`\`asciidoc\n${body.replace(/\n$/, '')}\n\`\`\`\n`;
      } else body = markdownOf(body);
      if (/^```diagram\b/m.test(body)) diagrams.push(p.file.path);

      // Every link to a page or file of the dump → the export path, so the shared step can follow renamed names.
      let neighbour = false;
      const parts: string[] = [];
      let at = 0;
      for (const l of extractLinks(body).sort((a, b) => a.start - b.start)) {
        const target = resolve(decodeUriSafe(l.href), p, exists, (path) => fileAt.has(path));
        if (!target) continue;
        if (target.neighbour) neighbour = true;
        parts.push(body.slice(at, l.start), `${relHref(p.file.path, target.path)}${target.anchor ? `#${target.anchor}` : ''}`);
        at = l.end;
      }
      body = parts.length ? parts.join('') + body.slice(at) : body;
      if (neighbour) neighbours.push(p.file.path);
      const untagged = outsideCode(body, (part) => linksToText(part, TAG_PAGE));
      if (untagged !== body) tagLinks.push(p.file.path);
      body = untagged;

      const fm: Record<string, FrontmatterValue> = {};
      if (p.meta.description) fm.description = p.meta.description;
      const tags = (p.meta.tags ?? '').split(', ').map((t) => t.trim()).filter(Boolean);
      if (tags.length) fm.tags = tags;
      if (/^(false|0)$/.test(p.meta.published ?? '')) {
        fm.published = false;
        drafts.push(p.file.path);
      }
      if (p.meta.dateCreated) fm.created = p.meta.dateCreated;
      if (p.meta.date) fm.updated = p.meta.date;
      const content = Object.keys(fm).length ? setFrontmatterKeys(body, fm) : body;
      const title = p.meta.title || (p.editor === 'asciidoc' ? /^=\s+(.+)$/m.exec(p.body)?.[1]?.trim() : undefined) || posix.basename(p.path);
      // A page with pages below it is the page of their folder (`bibliothek.md` + `bibliothek/…`).
      const below = holding.has(`${p.locale}/${p.path}`);
      // Folders are named like the page of the same address (`bibliothek` → „Bibliothek“), else like the address.
      const segs = p.path.split('/').slice(0, below ? undefined : -1);
      const dir = [...(p.locale ? [p.locale] : []), ...segs.map((s, i) => exists(p.locale, segs.slice(0, i + 1).join('/'))?.meta.title || s)];
      // Folders are named by title – two of the same title stay apart by their address (code-001).
      const dirKeys = [...(p.locale ? [p.locale] : []), ...segs.map((_s, i) => `${p.locale ? `${p.locale}/` : ''}${segs.slice(0, i + 1).join('/')}`)];
      notes.push({ from: p.file.path, dir, dirKeys, name: title, content, exactLinks: true, ...(below ? { folderPage: true } : {}) });
    }

    // Uploaded files lie in the same folders as the pages (of the main language) – under the same (renamed) folders.
    for (const f of out) {
      f.dirKeys = f.dir.map((_s, i) => f.dir.slice(0, i + 1).join('/'));
      f.dir = f.dir.map((s, i) => exists('', f.dir.slice(0, i + 1).join('/'))?.meta.title || s);
    }
    const draft: Draft = { notes, files: out, warnings: [] };
    const w = (text: string, list: string[]) => warn(draft, text, list);
    w('Links, die in Wiki.js ins Leere zeigten (Kindseite statt Nachbarseite) – auf die gleichnamige Nachbarseite gesetzt', neighbours);
    w('Links auf Schlagwort-Seiten von Wiki.js (/t/…) – nur der Text bleibt, die Schlagwörter stehen im Frontmatter (tags)', tagLinks);
    w('Seiten aus dem visuellen Editor oder mit HTML – in Markdown umgewandelt, bitte Aussehen prüfen', html);
    w('AsciiDoc-Seiten – als Codeblock übernommen', adoc);
    w('Unveröffentlichte Seiten – übernommen, im Frontmatter steht published: false', drafts);
    w('Zeichnungen (draw.io) – stehen als Codeblock in der Notiz', diagrams);
    if (notText.length) draft.warnings.push({ text: 'Dateien, die kein Text sind – nicht übernommen', items: notText });
    if (hidden.length) draft.warnings.push({ text: 'Versteckte Dateien (Einstellungen anderer Programme) – nicht übernommen', items: hidden });
    return draft;
  },
};

/** The language folder that holds the main language: none when a page lies outside every language folder. */
function mainLocale(pages: string[], locales: Set<string>): string {
  const count = new Map<string, number>();
  for (const p of pages) {
    const first = p.split('/')[0]!;
    if (!p.includes('/') || !locales.has(first)) return '';
    count.set(first, (count.get(first) ?? 0) + 1);
  }
  // The most pages; with as many, the first by name.
  return [...count].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] ?? '';
}

/** A link of a page → the export path it points to, by Wiki.js's rules (a neighbour page as the second try). */
function resolve(
  href: string,
  page: Page,
  exists: (locale: string, path: string) => Page | undefined,
  isFile: (path: string) => boolean,
): { path: string; anchor: string | null; neighbour?: boolean } | null {
  const hash = href.indexOf('#');
  const anchor = hash >= 0 ? href.slice(hash + 1) || null : null;
  let path = (hash >= 0 ? href.slice(0, hash) : href).replace(/\?.*$/, '');
  if (!path) return null;
  const tries: { locale: string; path: string; neighbour?: boolean }[] = [];
  if (path.startsWith('/')) {
    path = path.replace(/^\/+/, '').replace(/\/+$/, '');
    // Uploaded files have no language and keep their extension.
    if (isFile(path)) return { path, anchor };
    const [first, ...rest] = path.split('/');
    if (LOCALE.test(first!) && rest.length) tries.push({ locale: first!, path: rest.join('/') }, { locale: '', path: rest.join('/') });
    else tries.push({ locale: page.locale, path });
  } else if (/^\.\.?\//.test(path) || /\.[a-z0-9]{1,5}$/i.test(path)) {
    // The browser resolves it against the page's address `/<lang>/<path>`; meant was mostly the page as a folder.
    const browser = posix.normalize(posix.join(posix.dirname(page.path), path));
    const asFolder = posix.normalize(posix.join(page.path, path));
    const own = page.locale ? `${page.locale}/` : '';
    for (const p of [browser, asFolder]) if (isFile(`${own}${p}`) || isFile(p)) return { path: isFile(p) ? p : `${own}${p}`, anchor };
    tries.push({ locale: page.locale, path: browser.replace(/\.(html|md|adoc)$/i, '') }, { locale: page.locale, path: asFolder.replace(/\.(html|md|adoc)$/i, ''), neighbour: true });
  } else {
    // Without a dot Wiki.js makes it a child page; a sibling was meant when there is no such child.
    tries.push({ locale: page.locale, path: `${page.path}/${path.replace(/\/+$/, '')}` }, { locale: page.locale, path: posix.join(posix.dirname(page.path), path), neighbour: true });
  }
  for (const t of tries) {
    if (t.path.startsWith('..')) continue;
    const hit = exists(t.locale, t.path);
    if (hit) return { path: hit.file.path, anchor, ...(t.neighbour ? { neighbour: true } : {}) };
  }
  return null;
}

/** Wiki.js's Markdown extras → plain Markdown: callouts `{.is-info}`, `{.class}`/`{#id}` attributes, picture sizes. */
function markdownOf(body: string): string {
  const lines = body.split('\n');
  const code = codeLines(lines);
  const out: string[] = [];
  // Where the quote that ends the output so far began, and the callout kind that goes before such a first line
  // (kept aside: inserting into `out` each time was quadratic).
  let quote = -1;
  const kinds = new Map<number, string>();
  const push = (line: string) => {
    if (!line.startsWith('>')) quote = -1;
    else if (quote < 0) quote = out.length;
    out.push(line);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (code[i]) {
      push(line);
      continue;
    }
    // A blockquote followed by `{.is-info}` is a callout: the kind goes to the quote's first line.
    const kind = /^\{\.is-(info|success|warning|danger)\}\s*$/.exec(line);
    if (kind) {
      // One kind per quote: more `{.is-…}` after it say nothing more.
      if (quote >= 0 && !kinds.has(quote)) kinds.set(quote, `> [!${CALLOUT_KINDS[kind[1]!]}]`);
      continue;
    }
    if (/^\{[.#][\w-]+(?:\s+[.#][\w-]+)*\}\s*$/.test(line)) continue;
    push(line);
  }
  const text = out.map((line, i) => (kinds.has(i) ? `${kinds.get(i)}\n${line}` : line)).join('\n');
  return outsideCode(text, (part) =>
    part
      .replace(/(!\[[^\]\n]*\]\(\s*<?[^\s)>]+>?)\s+=\d*x\d*(\s+"[^"\n]*")?\s*\)/g, '$1$2)')
      .replace(/(\S)[ \t]*\{(?:[.#][\w-]+\s*)+\}(?=[ \t]*$)/gm, '$1')
      .replace(/(\))\{(?:[.#][\w-]+\s*)+\}/g, '$1'),
  );
}
