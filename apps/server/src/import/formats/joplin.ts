// Joplin: File → Export all → „MD – Markdown + Front Matter“ (or „MD – Markdown“) gives a folder per notebook (nested),
// a `.md` per note named after its title (special characters as `_`, the same title as `-1`, no title „Untitled“), all
// resources in `_resources/` under their title, links between notes already as relative paths. Checked with a real
// export of Joplin 3.7.1 (28.10.2026). Resources go to `assets/` next to the first note that uses them; to-dos keep their
// state in the frontmatter; HTML notes (web clipper) become Markdown, as do `<img>` tags (Joplin's resized pictures) –
// Kaveyl Wiki shows no raw HTML.
import { extractLinks, readFrontmatter, resolveHref, setFrontmatterKeys, splitFrontmatter } from '@kaveyl-wiki/core';
import type { SourceFile } from '../zip.js';
import type { Draft, DraftFile, DraftNote, ImportFormat } from '../types.js';
import { htmlToMarkdown, imgTagsToMarkdown } from '../html.js';
import { firstWords, outsideCode } from '../text.js';

const RESOURCES = '_resources/';
/** Joplin's own frontmatter: title, then updated/created as „2026-10-28 17:34:40Z“. */
const JOPLIN_FM = /^---\r?\n(?:title: .*\r?\n)?updated: \d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ\r?\ncreated: /;

export const joplin: ImportFormat = {
  id: 'joplin',
  label: 'Joplin',
  async detect(files) {
    if (files.some((f) => f.path.startsWith(RESOURCES))) return 3;
    for (const f of files.filter((x) => /\.md$/i.test(x.path)).slice(0, 50)) if (JOPLIN_FM.test((await f.text()) ?? '')) return 3;
    return 0;
  },
  async convert(files) {
    const notes: DraftNote[] = [];
    const html: string[] = [];
    const todos: string[] = [];
    const notText: string[] = [];
    const used = new Map<string, string>(); // resource path → export path of the first note using it
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    for (const f of sorted) {
      if (f.path.startsWith(RESOURCES) || !/\.(md|html)$/i.test(f.path)) continue;
      const raw = await f.text();
      if (raw === null) {
        notText.push(f.path);
        continue;
      }
      const parts = f.path.split('/');
      const stem = parts.pop()!.replace(/\.(md|html)$/i, '');
      const fm = readFrontmatter(splitFrontmatter(raw).frontmatter);
      const body = splitFrontmatter(raw).body;
      const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : /^Untitled(-\d+)?$/.test(stem) ? (firstWords(body.trim().split('\n')[0] ?? '') ?? stem) : stem;
      let content = todo(raw);
      if (content !== raw) todos.push(f.path);
      content = fm.title !== undefined ? setFrontmatterKeys(content, { title: undefined }) : content;
      // `from` stays the export's path: other notes link to a clipping as `….html`.
      const from = f.path;
      if (/\.html$/i.test(f.path)) {
        html.push(from);
        const { frontmatter, body: inner } = splitFrontmatter(content);
        content = `${frontmatter}${frontmatter ? '\n' : ''}${htmlToMarkdown(inner)}\n`;
      } else content = outsideCode(content, imgTagsToMarkdown);
      for (const l of extractLinks(content)) {
        const target = resolveHref(l.href, f.path);
        if (target?.path.startsWith(RESOURCES) && !used.has(target.path)) used.set(target.path, from);
      }
      notes.push({ from, dir: parts, name: title, content });
    }
    // Each resource next to the first note that shows it; ones no note uses into `assets/` at the top.
    const out: DraftFile[] = sorted
      .filter((f: SourceFile) => f.path.startsWith(RESOURCES) && f.path.split('/').length === 2)
      .map((f) => {
        const by = used.get(f.path);
        return { from: f.path, dir: [...(by ? by.split('/').slice(0, -1) : []), 'assets'], name: f.path.slice(RESOURCES.length), source: f };
      });
    const draft: Draft = { notes, files: out, warnings: [] };
    if (todos.length) draft.warnings.push({ text: 'To-dos – erledigt oder offen und die Fälligkeit stehen im Frontmatter (todo, done, due)', notes: todos });
    if (html.length) draft.warnings.push({ text: 'HTML-Notizen (Web Clipper) – in Markdown umgewandelt, bitte Aussehen prüfen', notes: html });
    if (notText.length) draft.warnings.push({ text: 'Dateien, die kein Text sind – nicht übernommen', items: notText });
    return draft;
  },
};

/** Joplin's `completed?: yes|no` (a key YAML tools stumble over) → `todo: true` and `done: true|false`. */
function todo(raw: string): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (!frontmatter) return raw;
  const next = frontmatter.replace(/^completed\?: (yes|no)[ \t]*(\r?\n)/m, (_all, v: string, eol: string) => `todo: true${eol}done: ${v === 'yes'}${eol}`);
  return next + body;
}
