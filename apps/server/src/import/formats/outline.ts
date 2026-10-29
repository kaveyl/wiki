// Outline: Settings → Export (workspace) or a collection's menu → Export → „Markdown“ (also the newer „OKF“) gives a
// ZIP with a folder per collection, a document with children as `Name.md` + `Name/`, and the files of each document
// in `uploads/<user>/<id>/<name>` next to it (a file used in several folders is in each). Checked with real exports of
// Outline 1.12.0 (28.10.2026); only the format was taken over, no code (Outline is BSL 1.1). File names keep their
// characters except `\ / : * ? " < > | %` (as `%XX`); the title is the first line `# Titel`, an emoji icon before it;
// the dates are in each ZIP entry's comment. Links between documents are relative, a `#` in a name unencoded; links to
// documents not in the export stay `/doc/…` and become text (named in the report).
import { posix } from 'node:path';
import { decodeUriSafe, extractLinks, headingSlug, readFrontmatter, setFrontmatterKeys, splitFrontmatter, type FrontmatterValue } from '@kaveyl-wiki/core';
import type { SourceFile } from '../zip.js';
import type { Draft, DraftFile, DraftNote, ImportFormat } from '../types.js';
import { codeLines, convertContainers, escapeHtml, linksToText, outsideCode, relHref, trimPictureIndent, warn } from '../text.js';

/** The characters Outline writes as `%XX` in file names (and dots or spaces at the end). */
const CODES: Record<string, string> = { '5C': '\\', '2F': '/', '3A': ':', '2A': '*', '3F': '?', '22': '"', '3C': '<', '3E': '>', '7C': '|', '25': '%', '2E': '.', '20': ' ' };
const fileName = (seg: string) => seg.replace(/%(5C|2F|3A|2A|3F|22|3C|3E|7C|25|2E|20)/gi, (_all, hex: string) => CODES[hex.toUpperCase()]!);
const UPLOAD = /(?:^|\/)uploads\/[\w-]+\/([\w-]+)\/[^/]+$/;
/** Outline's notices (`:::info` … `:::`). */
const NOTICES = ['info', 'tip', 'success', 'warning'];
/** Links to documents and collections on the old server (`/doc/…`, `/collection/…`). */
const AWAY = /\/(?:doc|collection)\/[^\s)>]*/;

export const outline: ImportFormat = {
  id: 'outline',
  label: 'Outline',
  async detect(files) {
    const okf = files.find((f) => f.path === 'index.md');
    if (okf && /^okf_version:/m.test(splitFrontmatter((await okf.text()) ?? '').frontmatter)) return 5;
    if (files.some((f) => /\.md$/i.test(f.path) && /^\{"createdAt":"[^"]+","updatedAt":"[^"]+"\}$/.test(f.comment ?? ''))) return 4;
    return files.some((f) => UPLOAD.test(f.path) && /\/uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\//.test(`/${f.path}`)) ? 3 : 0;
  },
  async convert(files) {
    const at = new Map(files.map((f) => [f.path, f]));
    const docs = files.filter((f) => /\.md$/i.test(f.path) && !UPLOAD.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
    // OKF: the overview of the collections is no document; `resource` names each document's old address.
    const okf = docs.find((f) => f.path === 'index.md');
    const isOkf = !!okf && /^okf_version:/m.test(splitFrontmatter((await okf.text()) ?? '').frontmatter);
    const texts = new Map<SourceFile, string>();
    const byUrlId = new Map<string, string>();
    for (const f of docs) {
      if (isOkf && f === okf) continue;
      const t = await f.text();
      if (t === null) continue;
      texts.set(f, t);
      const resource = isOkf ? readFrontmatter(splitFrontmatter(t).frontmatter).resource : undefined;
      const id = typeof resource === 'string' ? /\/doc\/(?:[\w-]*-)?([A-Za-z0-9]{10})(?:[#?].*)?$/.exec(resource)?.[1] : undefined;
      if (id) byUrlId.set(id, f.path);
    }
    // Headings of each document by Outline's anchor (`#h-rostgrad-prufen`) → their text.
    const headings = new Map<string, Map<string, string>>();
    for (const [f, t] of texts) {
      const map = new Map<string, string>();
      const lines = t.split('\n');
      const code = codeLines(lines);
      lines.forEach((l, i) => {
        const m = !code[i] && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
        if (m && !map.has(outlineSlug(m[1]!))) map.set(outlineSlug(m[1]!), m[1]!);
      });
      headings.set(f.path, map);
    }

    // Each file once: the copies of one upload (by its id) all point to the first.
    const uploads = new Map<string, SourceFile>();
    for (const f of files) {
      const id = UPLOAD.exec(f.path)?.[1];
      if (id && !uploads.has(id)) uploads.set(id, f);
    }
    const out: DraftFile[] = [...uploads.values()].map((f) => {
      const dir = f.path.split('/').slice(0, -4).map(fileName);
      return { from: f.path, dir, name: posix.basename(f.path), source: f };
    });

    const notes: DraftNote[] = [];
    const away: string[] = [];
    const mentions: string[] = [];
    const underline: string[] = [];
    const toggles: string[] = [];
    // Every folder that holds a document: a document with a folder of its name is that folder's page.
    const holding = new Set(docs.flatMap((x) => x.path.split('/').slice(0, -1).map((_s, i, segs) => segs.slice(0, i + 1).join('/'))));
    for (const [f, raw] of texts) {
      const parts = f.path.split('/');
      const stem = fileName(parts.pop()!.replace(/\.md$/i, ''));
      const dir = parts.map(fileName);
      const below = holding.has(f.path.replace(/\.md$/i, ''));
      let body = splitFrontmatter(raw).body.replace(/^\n+/, '');
      // The title line; an emoji before the title that is not in the file name is the document's icon.
      const fm: Record<string, FrontmatterValue> = {};
      const first = /^# (.*)(?:\n|$)/.exec(body);
      if (first) {
        const title = first[1]!.trim();
        const icon = title !== stem && title.endsWith(stem) ? title.slice(0, -stem.length).trim() : '';
        if (icon && /^\p{Extended_Pictographic}/u.test(icon) && [...icon].length <= 4) fm.icon = icon;
        body = body.slice(first[0].length).replace(/^\n+/, '');
      }
      try {
        const dates = JSON.parse(f.comment ?? '') as { createdAt?: unknown; updatedAt?: unknown } | null;
        if (typeof dates?.createdAt === 'string') fm.created = dates.createdAt;
        if (typeof dates?.updatedAt === 'string') fm.updated = dates.updatedAt;
      } catch {
        // no dates – an export packed again by hand
      }

      // Links: a `#` may be part of a name; Outline's anchors become ours; copies of an upload → the one kept;
      // documents not in the export (drafts, archived, deleted) → text.
      // An Outline bug writes a link with its full address as `http://host./Name.md` – it is a relative link.
      body = outsideCode(body, (p) => p.replace(/\]\(\s*<?https?:\/\/[^/\s)>]+\.(\/[^\s)>]*\.md(?:#[^\s)>]*)?)>?\s*\)/g, '](.$1)'));
      // The editor's own name for Mermaid.
      body = body.replace(/^([ \t]*(?:`{3,}|~{3,}))mermaidjs[ \t]*$/gm, '$1mermaid');
      let gone = false;
      const pieces: string[] = [];
      let pos = 0;
      for (const l of extractLinks(body).sort((a, b) => a.start - b.start)) {
        const next = relink(l.href, f.path, at, uploads, headings, byUrlId);
        if (next !== null) {
          pieces.push(body.slice(pos, l.start), next);
          pos = l.end;
        }
      }
      body = pieces.length ? pieces.join('') + body.slice(pos) : body;
      body = outsideCode(body, (p) => {
        const before = p;
        const q = linksToText(p, AWAY);
        if (q !== before) gone = true;
        return q;
      });
      if (gone) away.push(f.path);

      // Outline's own syntax.
      let text = convertContainers(body, NOTICES);
      const t1 = toggle(text);
      if (t1 !== text) toggles.push(f.path);
      text = outsideCode(t1, (p) =>
        trimPictureIndent(
          p
            .replace(/@\[([^\]\n]+)\]\(mention:\/\/[^)\s]*\)/g, (_all, name: string) => `@${name}`)
            .replace(/(?<!!)(\[[^[\]\n]+?) \d+(\]\(\s*<?(?:\.\/)?(?:[^)\s]*\/)?uploads\/)/g, '$1$2'),
        ),
      );
      if (/@\[[^\]\n]+\]\(mention:/.test(body)) mentions.push(f.path);
      const marked = outsideCode(text, (p) => p.replace(/(?<![_\w\\])__(?=\S)([^_\n]+?)(?<=\S)__(?![_\w])/g, '*$1*'));
      if (marked !== text) underline.push(f.path);
      text = marked.replace(/\n*$/, '\n');
      notes.push({ from: f.path, dir: below ? [...dir, stem] : dir, name: stem, content: Object.keys(fm).length ? setFrontmatterKeys(text, fm) : text, ...(below ? { folderPage: true } : {}) });
    }

    const draft: Draft = { notes, files: out, warnings: [] };
    const w = (text: string, list: string[]) => warn(draft, text, list);
    w('Links auf Dokumente, die nicht im Export sind (Entwürfe, archivierte, gelöschte, andere Sammlungen) – nur der Text bleibt', away);
    w('Erwähnungen von Personen – als @Name übernommen', mentions);
    w('Unterstreichungen (__Text__) – als kursiv übernommen', underline);
    w('Einklappbare Abschnitte – als aufklappbarer Abschnitt übernommen, der erste Absatz ist die Überschrift', toggles);
    return draft;
  },
};

/** Outline's heading anchor: `h-` and the heading in ASCII (`Preise & Größen` → `h-preise-and-grossen`). */
export function outlineSlug(heading: string): string {
  const ascii = heading
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `h-${ascii}`;
}

/** A link's new destination (relative to the document in the export), or null to leave it as it is. */
function relink(
  href: string,
  from: string,
  at: Map<string, SourceFile>,
  uploads: Map<string, SourceFile>,
  headings: Map<string, Map<string, string>>,
  byUrlId: Map<string, string>,
): string | null {
  const encode = (p: string) => relHref(from, p);
  const doc = /^\/doc\/(?:[\w-]*-)?([A-Za-z0-9]{10})(#.*)?$/.exec(href);
  if (doc) {
    const to = byUrlId.get(doc[1]!);
    return to ? encode(to) + anchorOf(doc[2]?.slice(1), to, headings) : null;
  }
  if (/^[a-z][a-z0-9+.-]*:|^\//i.test(href)) return null;
  const base = posix.dirname(from);
  const whole = posix.normalize(posix.join(base, decodeUriSafe(href)));
  // The whole as a file first: `./#1 Bestseller.md` is a name with `#`, not an anchor.
  let path = at.has(whole) ? whole : null;
  let anchor: string | undefined;
  if (!path) {
    const hash = href.lastIndexOf('#');
    if (hash < 0) return null;
    const p = posix.normalize(posix.join(base, decodeUriSafe(href.slice(0, hash))));
    if (!at.has(p)) return null;
    path = p;
    anchor = href.slice(hash + 1);
  }
  const id = UPLOAD.exec(path)?.[1];
  const target = id ? uploads.get(id)!.path : path;
  return encode(target) + anchorOf(anchor, target, headings);
}

/** Outline's anchor `h-…` → the heading's text (the shared step turns it into Kaveyl Wiki's anchor). */
function anchorOf(anchor: string | undefined, target: string, headings: Map<string, Map<string, string>>): string {
  if (!anchor) return '';
  const text = headings.get(target)?.get(decodeUriSafe(anchor));
  return `#${encodeURIComponent(headingSlug(text ?? decodeUriSafe(anchor)))}`;
}

/** `+++` … `+++` (a toggle; the first paragraph is its heading) → `<details>`. */
function toggle(text: string): string {
  const lines = text.split('\n');
  const code = codeLines(lines);
  // The next line with the same `+++` below each line, found from the bottom in one pass.
  const below: number[] = new Array<number>(lines.length);
  const last = new Map<string, number>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const plus = !code[i] && /^\+{3,}$/.exec(lines[i]!.trim())?.[0];
    below[i] = plus ? (last.get(plus) ?? -1) : -1;
    if (plus) last.set(plus, i);
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = !code[i] && /^(\+{3,})\s*$/.exec(lines[i]!);
    const close = open ? below[i]! : -1;
    if (!open || close < 0) {
      out.push(lines[i]!);
      continue;
    }
    const inner = toggle(lines.slice(i + 1, close).join('\n')).replace(/^\n+/, '');
    const cut = inner.search(/\n\s*\n/);
    const summary = (cut < 0 ? inner : inner.slice(0, cut)).replace(/\s*\n\s*/g, ' ').trim();
    const rest = cut < 0 ? '' : inner.slice(cut).trim();
    out.push('<details>', `<summary>${escapeHtml(summary)}</summary>`, '', ...(rest ? [rest, ''] : []), '</details>', '');
    i = close;
  }
  return out.join('\n');
}
