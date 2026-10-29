// Logseq (0.10.x, file graphs): the graph is a folder – `pages/`, `journals/`, `assets/`, `logseq/config.edn` – zip that
// folder. Checked with a graph written by Logseq 0.10.15 itself through its API (28.10.2026). Page names come from
// `title::` or the file name (`a___b` and `a%2Fb` are the namespace `a/b`, which becomes folders); journals go to
// `Journal/2026-10-28.md` and keep their title (`Oct 28th, 2026`) as a name `[[…]]` may use, like aliases. Page
// properties become frontmatter, block properties a line `key: value`; `TODO`/`DONE` become task boxes, `#+BEGIN_NOTE`
// a callout; block references `((uuid))` and embeds become a link to the page with the block's text. Org pages,
// whiteboards and queries cannot come over – the report names them. Logseq 2.x (database graphs) is not this format.
import { setFrontmatterKeys, type FrontmatterValue } from '@kaveyl-wiki/core';
import type { SourceFile } from '../zip.js';
import type { Draft, DraftFile, DraftNote, ImportFormat } from '../types.js';
import { codeLines, plainText, relHref } from '../text.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BLOCK_REF = new RegExp(`(\\{\\{embed \\(\\(|\\(\\()(${UUID})\\)\\)(\\}\\})?`, 'gi');
const PROPERTY = /^([ \t]*)([\p{L}\p{N}_-]+):: ?(.*)$/u;
/** Block properties Logseq keeps for itself. */
const OWN_PROPS = new Set(['id', 'collapsed', 'heading', 'background-color', 'title']);
const CALLOUT: Record<string, string> = { NOTE: 'NOTE', TIP: 'TIP', IMPORTANT: 'IMPORTANT', WARNING: 'WARNING', CAUTION: 'CAUTION', PINNED: 'NOTE' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Config {
  pages: string;
  journals: string;
  titleFormat: string;
}

export const logseq: ImportFormat = {
  id: 'logseq',
  label: 'Logseq',
  async detect(files) {
    if (files.some((f) => f.path === 'logseq/config.edn')) return 4;
    const dirs = new Set(files.filter((f) => /\.md$/i.test(f.path)).map((f) => f.path.split('/')[0]));
    return dirs.has('pages') && dirs.has('journals') ? 3 : 0;
  },
  async convert(files) {
    const config = await readConfig(files);
    const notes: (DraftNote & { blocks: Map<string, string> })[] = [];
    const out: DraftFile[] = [];
    const own: string[] = [];
    const org: string[] = [];
    const boards: string[] = [];
    const empty: string[] = [];
    const notText: string[] = [];
    const queries: string[] = [];
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = f.path.split('/');
      if (parts[0] === 'logseq' || parts.some((p) => p.startsWith('.'))) own.push(f.path);
      else if (parts[0] === 'whiteboards' || parts[0] === 'draws') boards.push(f.path);
      else if (/\.org$/i.test(f.path)) org.push(f.path);
      else if (/\.(md|markdown)$/i.test(f.path)) {
        const raw = await f.text();
        if (raw === null) {
          notText.push(f.path);
          continue;
        }
        const page = convertPage(raw);
        if (!page.body.trim() && !Object.keys(page.props).length) {
          empty.push(f.path);
          continue;
        }
        if (page.query) queries.push(f.path);
        const { dir, name, names } = placeOf(f.path, page.props, config);
        const fm: Record<string, FrontmatterValue> = {};
        for (const [k, v] of Object.entries(page.props)) {
          if (k === 'title') continue;
          if (k === 'tags' || k === 'alias') fm[k === 'alias' ? 'aliases' : 'tags'] = list(v);
          else fm[k] = v.replace(/\[\[([^\]]*)\]\]/g, '$1');
        }
        names.push(...list(page.props.alias ?? ''));
        notes.push({ from: f.path, dir, name, names, content: setFrontmatterKeys(page.body, fm), blocks: page.blocks });
      } else out.push({ from: f.path, dir: parts.slice(0, -1), name: parts.at(-1)!.replace(/_\d{13}_\d+(?=\.[^.]+$)/, ''), source: f });
    }

    // Block references and embeds: the block's text as a link to its page (Kaveyl Wiki has no block anchors).
    const blockAt = new Map<string, { from: string; text: string }>();
    for (const n of notes) for (const [id, text] of n.blocks) blockAt.set(id.toLowerCase(), { from: n.from, text });
    const linked: string[] = [];
    const lost: string[] = [];
    for (const n of notes) {
      let hit = false;
      let miss = false;
      n.content = outsideFences(n.content, (line) =>
        line.replace(BLOCK_REF, (all, _open: string, id: string) => {
          const block = blockAt.get(id.toLowerCase());
          if (!block) {
            miss = true;
            return all;
          }
          hit = true;
          return `[${block.text.replace(/[[\]\\]/g, '\\$&') || '→'}](${relHref(n.from, block.from)})`;
        }),
      );
      if (hit) linked.push(n.from);
      if (miss) lost.push(n.from);
    }

    const draft: Draft = { notes: notes.map(({ blocks: _b, ...n }) => n), files: out, warnings: [], wikiLinks: true };
    if (linked.length) draft.warnings.push({ text: 'Block-Verweise und Einbettungen – als Link auf die Seite mit dem Text des Blocks übernommen', notes: linked });
    if (lost.length) draft.warnings.push({ text: 'Block-Verweise auf Blöcke, die nicht im Export sind – sie bleiben als Text stehen', notes: lost });
    if (queries.length) draft.warnings.push({ text: 'Abfragen von Logseq ({{query}}, #+BEGIN_QUERY) – sie stehen als Text bzw. Codeblock in der Notiz', notes: queries });
    if (org.length) draft.warnings.push({ text: 'Seiten im Org-Format – nicht übernommen', items: org });
    if (boards.length) draft.warnings.push({ text: 'Whiteboards und Zeichnungen – nicht übernommen', items: boards });
    if (empty.length) draft.warnings.push({ text: 'Leere Seiten – nicht übernommen', items: empty });
    if (own.length) draft.warnings.push({ text: 'Einstellungen von Logseq (Ordner logseq/, versteckte Dateien) – nicht übernommen', items: own });
    if (notText.length) draft.warnings.push({ text: 'Dateien, die kein Text sind – nicht übernommen', items: notText });
    return draft;
  },
};

/** Folders and the directory names from `logseq/config.edn` (only uncommented settings count). */
async function readConfig(files: SourceFile[]): Promise<Config> {
  const edn = (await files.find((f) => f.path === 'logseq/config.edn')?.text()) ?? '';
  const get = (key: string) => new RegExp(`^[ \\t]*:${key}[ \\t]+"([^"]+)"`, 'm').exec(edn)?.[1];
  return { pages: get('pages-directory') ?? 'pages', journals: get('journals-directory') ?? 'journals', titleFormat: get('journal/page-title-format') ?? 'MMM do, yyyy' };
}

/** Where a page goes and the names `[[…]]` may use for it. */
function placeOf(path: string, props: Record<string, string>, config: Config): { dir: string[]; name: string; names: string[] } {
  const parts = path.split('/');
  const stem = parts.pop()!.replace(/\.(md|markdown)$/i, '');
  const date = /^(\d{4})[_-](\d{2})[_-](\d{2})$/.exec(stem);
  if (parts[0] === config.journals && date) {
    const d = new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])));
    return { dir: ['Journal'], name: `${date[1]}-${date[2]}-${date[3]}`, names: [formatDate(d, config.titleFormat), `${date[1]}-${date[2]}-${date[3]}`] };
  }
  const title = props.title?.trim() || decodeName(stem);
  const segments = title.split('/').map((s) => s.trim()).filter(Boolean);
  const sub = parts[0] === config.pages ? parts.slice(1) : parts;
  return { dir: [...sub, ...segments.slice(0, -1)], name: segments.at(-1) ?? stem, names: [title] };
}

/** File name → page name: `___` and `%2F` are Logseq's namespace separators, other characters are percent-encoded. */
function decodeName(stem: string): string {
  const s = stem.replace(/___/g, '/');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const list = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim().replace(/^#/, '').replace(/^\[\[(.*)\]\]$/, '$1').trim())
    .filter(Boolean);

/** Logseq's journal title format (date-fns tokens, English names) for a date. */
export function formatDate(d: Date, format: string): string {
  const day = d.getUTCDate();
  const ord = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  const pad = (n: number) => String(n).padStart(2, '0');
  const tokens: Record<string, string> = {
    yyyy: String(d.getUTCFullYear()),
    yy: String(d.getUTCFullYear()).slice(-2),
    MMMM: MONTHS[d.getUTCMonth()]!,
    MMM: MONTHS[d.getUTCMonth()]!.slice(0, 3),
    MM: pad(d.getUTCMonth() + 1),
    M: String(d.getUTCMonth() + 1),
    do: `${day}${ord}`,
    dd: pad(day),
    d: String(day),
    EEEE: DAYS[d.getUTCDay()]!,
    EEE: DAYS[d.getUTCDay()]!.slice(0, 3),
    EE: DAYS[d.getUTCDay()]!.slice(0, 3),
    E: DAYS[d.getUTCDay()]!.slice(0, 3),
  };
  return format.replace(/yyyy|yy|MMMM|MMM|MM|M|do|dd|d|EEEE|EEE|EE|E/g, (t) => tokens[t]!);
}

/** Applies `fn` to every line outside fenced code (fences may start after a block's `- `). */
function outsideFences(text: string, fn: (line: string) => string): string {
  const lines = text.split('\n');
  const code = codeLines(lines);
  return lines.map((line, i) => (code[i] ? line : fn(line))).join('\n');
}

interface Page {
  props: Record<string, string>;
  body: string;
  /** Block id → the block's first line as plain text (for references to it). */
  blocks: Map<string, string>;
  query: boolean;
}

/** One Logseq page: page properties apart, blocks as a Markdown list. */
export function convertPage(raw: string): Page {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const props: Record<string, string> = {};
  let i = 0;
  // Page properties: `key:: value` lines at the very top (Logseq writes them without a bullet).
  for (; i < lines.length; i++) {
    const m = PROPERTY.exec(lines[i]!);
    if (!m || m[1]) break;
    props[m[2]!.toLowerCase()] = m[3]!.trim();
  }
  // Where each `#+END_<kind>` is, found once (a search per `#+BEGIN` would be quadratic).
  const ends = new Map<string, { at: number[]; next: number }>();
  lines.forEach((l, j) => {
    const m = /^[ \t]*#\+END_(\w+)/i.exec(l);
    if (!m) return;
    const kind = m[1]!.toUpperCase();
    if (!ends.has(kind)) ends.set(kind, { at: [], next: 0 });
    ends.get(kind)!.at.push(j);
  });
  // `i` only grows, so each list is walked once.
  const endAfter = (kind: string, i: number) => {
    const e = ends.get(kind);
    if (!e) return -1;
    while (e.next < e.at.length && e.at[e.next]! <= i) e.next++;
    return e.next < e.at.length ? e.at[e.next]! : -1;
  };
  const blocks = new Map<string, string>();
  const out: string[] = [];
  let query = false;
  let lastBlock = '';
  const code = codeLines(lines);
  for (; i < lines.length; i++) {
    let line = lines[i]!;
    if (code[i]) {
      out.push(line);
      continue;
    }
    // An empty block (Logseq's placeholder in a new journal) – kept as an empty item when it has children, or they would
    // turn into an indented code block.
    if (/^[ \t]*-[ \t]*$/.test(line)) {
      const depth = (l: string) => /^[ \t]*/.exec(l)![0].replace(/\t/g, '    ').length;
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (!next || depth(next) <= depth(line)) continue;
      line = line.replace(/[ \t]*$/, '');
    }
    const begin = /^([ \t]*(?:- )?)#\+BEGIN_(\w+)(.*)$/i.exec(line);
    if (begin) {
      const kind = begin[2]!.toUpperCase();
      const end = endAfter(kind, i);
      if (end > i) {
        const prefix = begin[1]!;
        const cont = prefix.replace(/- $/, '  ');
        const inner = lines.slice(i + 1, end).map((l) => (l.startsWith(cont) ? l.slice(cont.length) : l.trimStart()));
        if (kind === 'QUERY') query = true;
        if (CALLOUT[kind]) out.push(`${prefix}> [!${CALLOUT[kind]}]`, ...inner.map((l) => `${cont}> ${l}`.trimEnd()));
        else if (kind === 'QUOTE') out.push(...inner.map((l, j) => `${j ? cont : prefix}> ${l}`.trimEnd()));
        else {
          const lang = kind === 'QUERY' ? 'clojure' : kind === 'SRC' ? begin[3]!.trim().split(/\s/)[0] ?? '' : '';
          out.push(`${prefix}\`\`\`${lang}`, ...inner.map((l) => `${cont}${l}`), `${cont}\`\`\``);
        }
        i = end;
        continue;
      }
    }
    const prop = PROPERTY.exec(line);
    if (prop && prop[1] && out.length) {
      const key = prop[2]!.toLowerCase();
      if (key === 'id' && new RegExp(`^${UUID}$`, 'i').test(prop[3]!.trim())) blocks.set(prop[3]!.trim(), lastBlock);
      if (OWN_PROPS.has(key)) continue;
      hardBreak(out);
      out.push(`${prop[1]}${prop[2]}: ${prop[3]}`);
      continue;
    }
    if (/^[ \t]+(SCHEDULED|DEADLINE): </.test(line) && out.length) {
      hardBreak(out);
      out.push(line);
      continue;
    }
    const block = /^([ \t]*- )(.*)$/.exec(line);
    if (block) {
      line = block[1] + task(block[2]!);
      lastBlock = blockText(block[2]!);
    }
    if (/\{\{query\b/i.test(line)) query = true;
    out.push(inline(line));
  }
  return { props, body: out.join('\n').replace(/^\n+|\n+$/g, '') + '\n', blocks, query };
}

/** A line break before a property or date line, so it does not run into the block's text. */
function hardBreak(out: string[]) {
  const last = out.length - 1;
  if (last >= 0 && out[last]!.trim() && !/ {2}$/.test(out[last]!)) out[last] += '  ';
}

/** `TODO x` → `[ ] x`, `DONE x` → `[x] x`; other states keep their word in an open box. */
function task(text: string): string {
  const m = /^(TODO|DOING|NOW|LATER|WAITING|WAIT|IN-PROGRESS|DONE|CANCELED|CANCELLED)\s+(.*)$/.exec(text);
  if (!m) return text;
  const [, marker, rest] = m;
  if (marker === 'TODO') return `[ ] ${rest}`;
  if (marker === 'DONE') return `[x] ${rest}`;
  if (marker === 'CANCELED' || marker === 'CANCELLED') return `[x] ~~${rest}~~`;
  return `[ ] ${marker} ${rest}`;
}

/** A block as a short text for links to it. */
function blockText(text: string): string {
  const t = plainText(task(text).replace(/^\[[ x]\]\s*/, '').replace(BLOCK_REF, '').replace(/\[\[([^\]]*)\]\]/g, '$1'));
  return t.length > 80 ? `${t.slice(0, 80).replace(/\s+\S*$/, '')} …` : t;
}

/** Logseq's inline syntax outside code spans: `^^mark^^`, `[text]([[Page]])`, `{{embed [[Page]]}}`, `{{video url}}`. */
function inline(line: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, j) =>
      j % 2
        ? part
        : part
            .replace(/\^\^([^^\n]+)\^\^/g, '==$1==')
            .replace(/\[([^\]\n]+)\]\(\[\[([^\]\n]+)\]\]\)/g, (_all, text: string, page: string) => `[[${page}|${text}]]`)
            .replace(/\{\{embed \[\[([^\]\n]+)\]\]\}\}/g, '[[$1]]')
            .replace(/\{\{(?:video|youtube|vimeo|tweet|twitter)\s+(https?:\/\/[^\s}]+)\s*\}\}/g, '<$1>'),
    )
    .join('');
}
