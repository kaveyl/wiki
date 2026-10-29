// HedgeDoc 1.x (and CodiMD): „Export user data“ in the user menu gives a ZIP with one `.md` per own note, all in one
// folder, named after the title (special characters as `_`, the same title as `-1`, `-2`, no title as „Untitled“).
// Checked with a real export from HedgeDoc 1.12.0 (28.10.2026). The export has no note addresses, so links between
// notes (`/<id>`) cannot be matched (named in the report). Uploaded pictures are not in it either: they are `remote`,
// and the import fetches them from the old server if the person wants (remote.ts).
import { readFrontmatter, setFrontmatterKeys, splitFrontmatter } from '@kaveyl-wiki/core';
import type { SourceFile } from '../zip.js';
import type { Draft, DraftNote, ImportFormat, RemotePicture } from '../types.js';
import { imgTagsToMarkdown } from '../html.js';
import { convertContainers, firstWords, outsideCode, plainText } from '../text.js';

const MARKS = /\{%\s*(youtube|vimeo|gist|slideshare|speakerdeck|pdf)\s|^:::(info|success|warning|danger|spoiler)\b|^\[TOC\]\s*$|^type:\s*slide\s*$|\/uploads\/[\w-]+\.\w+/m;

/** HedgeDoc's boxes (`:::info` … `:::`); `spoiler` is a foldable one. */
const BOXES = ['info', 'success', 'warning', 'danger', 'spoiler'];

const EMBED: Record<string, (id: string) => string> = {
  youtube: (id) => `[YouTube](https://www.youtube.com/watch?v=${encodeURIComponent(id)})`,
  vimeo: (id) => `[Vimeo](https://vimeo.com/${encodeURIComponent(id)})`,
  gist: (id) => `[Gist](https://gist.github.com/${id.split('/').map(encodeURIComponent).join('/')})`,
  slideshare: (id) => `[SlideShare](https://www.slideshare.net/${id.split('/').map(encodeURIComponent).join('/')})`,
  speakerdeck: (id) => `[Speaker Deck](https://speakerdeck.com/${id.split('/').map(encodeURIComponent).join('/')})`,
  pdf: (url) => (/^https?:\/\//i.test(url) ? `[PDF](<${url}>)` : `PDF: ${url}`),
};

export const hedgedoc: ImportFormat = {
  id: 'hedgedoc',
  label: 'HedgeDoc',
  async detect(files) {
    if (!files.length || !files.every((f) => !f.path.includes('/') && /\.md$/i.test(f.path))) return 0;
    if (files.some((f) => /^Untitled(-\d+)?\.md$/.test(f.path))) return 3;
    for (const f of files.slice(0, 200)) if (MARKS.test((await f.text()) ?? '')) return 3;
    return 1;
  },
  async convert(files) {
    const notes: DraftNote[] = [];
    const empty: string[] = [];
    const notText: string[] = [];
    const texts = new Map<SourceFile, string>();
    for (const f of files) {
      const t = /\.md$/i.test(f.path) ? await f.text() : null;
      if (t === null) notText.push(f.path);
      else if (!t.trim()) empty.push(f.path);
      else texts.set(f, t);
    }
    // The server the pictures were uploaded to: links there point to the old HedgeDoc.
    const hosts = new Set<string>();
    for (const t of texts.values()) for (const m of t.matchAll(/https?:\/\/([^/\s)"'>]+)\/uploads\//g)) hosts.add(m[1]!.toLowerCase());
    const onOld = (url: string) => {
      const m = /^https?:\/\/([^/\s)"'>]+)(\/[^\s)"'>]*)?/i.exec(url);
      return m && hosts.has(m[1]!.toLowerCase()) ? (m[2] ?? '/') : null;
    };
    // Links written relative to HedgeDoc (`/<id>`) point to the old server like the absolute ones, not into the import.
    const origin = hosts.size === 1 ? /(https?:\/\/[^/\s)"'>]+)\/uploads\//.exec([...texts.values()].find((t) => /\/uploads\//.test(t))!)?.[1] : undefined;
    const pictures = new Map<string, RemotePicture>();
    const noteLinks: string[] = [];
    const slides: string[] = [];
    const sorted = [...texts].sort(([a], [b]) => a.path.replace(/\.md$/i, '').localeCompare(b.path.replace(/\.md$/i, '')));
    for (const [f, raw] of sorted) {
      const fm = readFrontmatter(splitFrontmatter(raw).frontmatter);
      const name = titleOf(raw, fm) ?? f.path.replace(/\.md$/i, '');
      let content = outsideCode(convertBody(fm.title !== undefined ? setFrontmatterKeys(raw, { title: undefined }) : raw), imgTagsToMarkdown);
      // Picture sizes `![x](url =200x)` are HedgeDoc's own – without them the picture shows at all.
      content = outsideCode(content, (p) => p.replace(/(!\[[^\]\n]*\]\(\s*<?[^\s)>]+>?)\s+=\d*x\d*(\s+"[^"\n]*")?\s*\)/g, '$1$2)'));
      if (origin) content = outsideCode(content, (p) => p.replace(/(\]\(\s*<?)(\/(?:s\/|p\/)?[\w-]{4,}(?:#[^\s)>]*)?)(?=>?[\s)])/g, `$1${origin}$2`));
      let link = false;
      for (const m of content.matchAll(/(!?)\[([^\]\n]*)\]\(\s*<?([^\s)>]+)/g)) {
        const path = onOld(m[3]!);
        if (path === null) continue;
        if (path.startsWith('/uploads/')) {
          // HedgeDoc names uploads by a random id – the picture's text makes the better file name.
          const pic = pictures.get(m[3]!) ?? { url: m[3]!, notes: [] };
          if (!pic.notes.includes(f.path)) pic.notes.push(f.path);
          if (!pic.title && m[2]!.trim()) pic.title = m[2]!.trim();
          pictures.set(m[3]!, pic);
        } else if (/^\/(s\/|p\/)?[\w-]{4,}(#.*)?$/.test(path)) link = true;
      }
      if (link) noteLinks.push(f.path);
      if (String(fm.type ?? '').trim() === 'slide') slides.push(f.path);
      notes.push({ from: f.path, dir: [], name, content });
    }
    const draft: Draft = { notes, files: [], warnings: [], remote: [...pictures.values()] };
    if (noteLinks.length)
      draft.warnings.push({ text: 'Links auf andere HedgeDoc-Notizen – HedgeDoc exportiert keine Notiz-Adressen, die Links zeigen weiter auf den alten Server', notes: noteLinks });
    if (slides.length) draft.warnings.push({ text: 'Folien – sie erscheinen als normaler Text', notes: slides });
    if (empty.length) draft.warnings.push({ text: 'Leere Notizen – nicht übernommen', items: empty });
    if (notText.length) draft.warnings.push({ text: 'Dateien, die kein Text sind – nicht übernommen', items: notText });
    return draft;
  },
};

/** HedgeDoc's own title rule: `title:` in the frontmatter, else the first `# heading`, else the first line of text. */
function titleOf(raw: string, fm: Record<string, unknown>): string | null {
  if (typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim();
  const { body } = splitFrontmatter(raw);
  let firstLine: string | null = null;
  let heading: string | null = null;
  outsideCode(
    body,
    (part) => {
      for (const line of part.split('\n')) {
        const h = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
        if (h && heading === null) heading = h[1]!;
        if (firstLine === null && line.trim()) firstLine = line.trim();
      }
      return part;
    },
    false,
  );
  if (heading) return plainText(heading) || null;
  return firstLine ? firstWords(firstLine) : null;
}

/** HedgeDoc's own syntax outside code: `:::info` boxes → callouts, `:::spoiler` → <details>, `[TOC]` out, `{%youtube x %}` → link. */
export function convertBody(raw: string): string {
  return convertContainers(raw, BOXES, (line) =>
    /^\[TOC\]\s*$/i.test(line) ? null : outsideCode(line, (part) => part.replace(/\{%\s*(youtube|vimeo|gist|slideshare|speakerdeck|pdf)\s+(\S+?)\s*%\}/g, (_all, kind: string, id: string) => EMBED[kind]!(id))),
  );
}
