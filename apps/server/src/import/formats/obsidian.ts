// Obsidian: the vault is a folder of Markdown files – zip that folder (with or without `.obsidian/`). Folders, files and
// relative links stay; `[[Name]]`, `[[Name#Überschrift]]` and `![[bild.png|200]]` resolve over the whole vault (the
// shared wiki-link converter, nearest of several). Obsidian's own syntax becomes what Kaveyl Wiki shows: callouts of
// any type → one of the five kinds (title kept), foldable ones → `<details>`; `%%comments%%` → HTML comments; `==marks==`
// → bold; block ids `^abc` go (Kaveyl Wiki has no block anchors); inline `#tags` also land in `tags`.
import { readFrontmatter, setFrontmatterKeys, splitFrontmatter } from '@kaveyl-wiki/core';
import type { Draft, ImportFormat } from '../types.js';
import { CALLOUT_KINDS, codeLines, escapeHtml, marksToBold, outsideCode } from '../text.js';
import { markdown } from './markdown.js';

/** Types whose kind says it all – no title needed when Obsidian showed none. */
const PLAIN = new Set(['note', 'tip', 'important', 'warning', 'caution']);

export const obsidian: ImportFormat = {
  id: 'obsidian',
  label: 'Obsidian',
  async detect(files) {
    if (files.some((f) => f.path.startsWith('.obsidian/'))) return 4;
    // Without its settings folder a vault is a Markdown folder; `![[…]]` embeds and callouts are Obsidian's – but
    // `> [!NOTE]` alone is also GitHub's way (alerts), common in any docs folder.
    for (const f of files.filter((x) => /\.md$/i.test(x.path)).slice(0, 100)) {
      const text = (await f.text()) ?? '';
      if (/!\[\[[^\]\n]+\]\]/.test(text)) return 3;
      for (const m of text.matchAll(/^>[ \t]*\[!([a-z-]+)\]([+-]?)[ \t]*(\S?)/gim)) if (!PLAIN.has(m[1]!.toLowerCase()) || m[2] || m[3]) return 3;
    }
    return 0;
  },
  async convert(files) {
    const draft: Draft = await markdown.convert(files);
    // `.obsidian/` is the vault's settings – said once, not file by file.
    const own = draft.warnings.find((w) => w.items?.some((i) => i.startsWith('.obsidian/')));
    if (own) {
      own.items = own.items!.filter((i) => !i.startsWith('.obsidian/'));
      if (!own.items.length) draft.warnings.splice(draft.warnings.indexOf(own), 1);
      draft.warnings.push({ text: 'Einstellungen von Obsidian (Ordner .obsidian: Plugins, Themes, Arbeitsbereich) – nicht übernommen' });
    }
    // `.trash/` is Obsidian's own wastebasket (with „Move to Obsidian trash“) – said apart from the settings.
    const hidden = draft.warnings.find((w) => w.items?.some((i) => i.startsWith('.trash/')));
    if (hidden) {
      const trash = hidden.items!.filter((i) => i.startsWith('.trash/'));
      hidden.items = hidden.items!.filter((i) => !i.startsWith('.trash/'));
      if (!hidden.items.length) draft.warnings.splice(draft.warnings.indexOf(hidden), 1);
      draft.warnings.push({ text: 'Papierkorb von Obsidian (.trash) – nicht übernommen', items: trash });
    }
    const callouts: string[] = [];
    const tasks: string[] = [];
    const marks: string[] = [];
    const blockIds: string[] = [];
    const comments: string[] = [];
    for (const n of draft.notes) {
      n.content = outsideCode(n.content, markdownLinks);
      const t = outsideCode(n.content, (p) => p.replace(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([^ xX\]])\]/gm, (_all, lead: string, mark: string) => `${lead}[${mark === '-' ? 'x' : ' '}]`), false);
      if (t !== n.content) tasks.push(n.from);
      n.content = t;
      const c = convertCallouts(n.content);
      if (c !== n.content) callouts.push(n.from);
      let content = comment(c);
      if (content !== c) comments.push(n.from);
      const marked = outsideCode(content, marksToBold);
      if (marked !== content) marks.push(n.from);
      const ided = outsideCode(marked, (p) => p.replace(/^([^\n]*?\S)?[ \t]+\^[A-Za-z0-9-]+[ \t]*$|^\^[A-Za-z0-9-]+[ \t]*$/gm, (_all, text: string | undefined) => text ?? ''));
      if (ided !== marked) blockIds.push(n.from);
      content = ided;
      const tags = inlineTags(content);
      if (tags.length) {
        const fm = readFrontmatter(splitFrontmatter(content).frontmatter);
        const had = listOf(fm.tags ?? fm.tag);
        const all = [...had, ...tags.filter((t) => !had.some((h) => h.toLowerCase() === t.toLowerCase()))];
        if (all.length !== had.length) content = setFrontmatterKeys(content, { tags: all, tag: undefined });
      }
      n.content = content;
    }
    const drawings = draft.files.filter((f) => /\.(canvas|base|excalidraw)$/i.test(f.name)).map((f) => f.from);
    if (callouts.length) draft.warnings.push({ text: 'Callouts – auf die fünf Arten von Kaveyl Wiki abgebildet, einklappbare als aufklappbarer Abschnitt', notes: callouts });
    if (tasks.length) draft.warnings.push({ text: 'Aufgaben mit eigenem Zustand ([/], [>], [?] …) – als offen übernommen, [-] (abgebrochen) als erledigt', notes: tasks });
    if (marks.length) draft.warnings.push({ text: 'Hervorhebungen (==Text==) – als fett übernommen', notes: marks });
    if (blockIds.length) draft.warnings.push({ text: 'Block-IDs (^abc) am Zeilenende – entfernt, Links auf einzelne Blöcke zeigen auf die Notiz', notes: blockIds });
    if (comments.length) draft.warnings.push({ text: 'Kommentare (%%…%%) – als unsichtbare HTML-Kommentare übernommen', notes: comments });
    if (drawings.length) draft.warnings.push({ text: 'Canvas, Bases und Zeichnungen – als Datei übernommen, nicht als Notiz', items: drawings });
    return draft;
  },
};

/**
 * Obsidian's Markdown links (with „Use [[Wikilinks]]“ off): an embedded note `![Name](Name.md)` → a link to it; a
 * size in the picture text (`![200](x.png)`, `![Text|200](x.png)`) goes; a file link without text gets its name.
 */
export function markdownLinks(part: string): string {
  return part
    .replace(/!\[([^\]\n]*)\]\((\s*<?[^)\n]*?\.md(?:#[^)\n]*)?>?\s*)\)/gi, '[$1]($2)')
    .replace(/!\[[^\]\n]*\]\((\s*<?[^)\n]*?\.(?!(?:png|jpe?g|gif|webp|avif|bmp|svg)\b)\w{1,6}(?:#[^)\n]*)?>?\s*)\)/gi, '[]($1)')
    .replace(/(!\[)(?:(\d+(?:x\d+)?)|([^\]\n|]*)\|\d+(?:x\d+)?)\]\(/g, (_all, open: string, _size: string | undefined, text: string | undefined) => `${open}${text ?? ''}](`)
    .replace(/(?<![!\]])\[\]\(\s*<?([^)>\s[\]][^)>\n[\]]*?)>?\s*\)/g, (all, href: string) => {
      const name = decodeURIComponent(href.replace(/#.*$/, '').split('/').pop() ?? '').replace(/\.md$/i, '');
      return name ? `[${name.replace(/[[\]\\]/g, '\\$&')}]${all.slice(2)}` : all;
    });
}

const listOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,\s]+/) : []).map((t) => t.trim().replace(/^#/, '')).filter(Boolean);

/** `#tag` and `#nested/tag` in the text (not in headings' `#`, links, code or addresses); a tag has at least one letter. */
export function inlineTags(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  outsideCode(splitFrontmatter(text).body, (part) => {
    for (const m of part.replace(/\]\([^)]*\)|\[\[[^\]\n]*\]\]|<[^>\n]*>|https?:\/\/\S+/g, ' ').matchAll(/(?<![\p{L}\p{N}_&/#])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu)) {
      const tag = m[1]!.replace(/\/+$/, '');
      if (seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      found.push(tag);
    }
    return part;
  });
  return found;
}

/** `%%hidden%%` (also over several lines) → `<!-- hidden -->`; `--` inside would end the HTML comment early. */
function comment(text: string): string {
  return outsideCode(text, (p) => p.replace(/%%([\s\S]*?)%%/g, (_all, inner: string) => `<!--${inner.replace(/--/g, '- -')}-->`));
}

/** `> [!type][+-] Titel` blocks → `> [!KIND]` with the title as first line; `+`/`-` (foldable) → `<details>`. */
export function convertCallouts(text: string): string {
  const lines = text.split('\n');
  const code = codeLines(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = code[i] ? null : /^(\s*)>\s*\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/.exec(lines[i]!);
    if (!head) {
      out.push(lines[i]!);
      continue;
    }
    const [, indent, rawType, fold, title] = head as unknown as [string, string, string, string, string];
    const type = rawType.toLowerCase();
    let end = i + 1;
    while (end < lines.length && new RegExp(`^${indent}>`).test(lines[end]!)) end++;
    // The body without its `>`, callouts nested in it converted the same way.
    const body = convertCallouts(lines.slice(i + 1, end).map((l) => l.slice(indent.length).replace(/^> ?/, '')).join('\n')).split('\n');
    const name = title.trim() || (PLAIN.has(type) && !fold ? '' : type[0]!.toUpperCase() + type.slice(1));
    if (fold) {
      out.push(`${indent}<details${fold === '+' ? ' open' : ''}>`, `${indent}<summary>${escapeHtml(name)}</summary>`, '', ...body.map((l) => (l ? indent + l : l)), '', `${indent}</details>`);
    } else {
      out.push(`${indent}> [!${CALLOUT_KINDS[type] ?? 'NOTE'}]`);
      if (name && (title.trim() || !PLAIN.has(type))) out.push(`${indent}> **${name}**`);
      for (const l of body) out.push(l.trim() ? `${indent}> ${l}` : `${indent}>`);
    }
    i = end - 1;
  }
  return out.join('\n');
}
