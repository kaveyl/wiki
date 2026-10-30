// From a converter's draft to what gets written (docs/PLAN-IMPORT.md), the same for every format: safe and unique
// names (as „Name 2“, never two files that differ only in case), files the app would not serve go to `assets/`,
// blocked file types stay out, links between the imported notes and files point to their new places, and `[[Name]]`
// links become Markdown links. What could not be resolved ends up in the warnings, with the notes concerned. Names are
// written in NFC (a ZIP from macOS may hold `Übung.md` as `U` + `¨`), and a link finds its target in either form.
import { posix } from 'node:path';
import { decodeUriSafe, extractLinks, formatLink, headingSlug, resolveHref, scriptLinks, splitFrontmatter } from '@kaveyl-wiki/core';
import { ASSETS_DIR, attachmentName, extensionOf, fileNameFor, isServable } from '../notes/names.js';
import { outsideCode } from './text.js';
import type { Draft, Plan, PlannedFile, PlannedNote, Warning } from './types.js';

export const REPORT_NAME = 'Import-Bericht.md';

export interface BuildOptions {
  folderNote: string;
  /** Lower-case file extensions that may not be uploaded (AD-069). */
  blocked: ReadonlySet<string>;
}

export function buildPlan(draft: Draft, opts: BuildOptions): Plan {
  const taken = new Map<string, Set<string>>([['', new Set([REPORT_NAME.toLowerCase()])]]);
  const folders = new Set<string>();
  // The next number to try per folder and name – counting up from 1 each time was quadratic for many equal names.
  const next = new Map<string, number>();
  const unique = (dir: string, base: string, ext: string) => {
    let names = taken.get(dir);
    if (!names) taken.set(dir, (names = new Set()));
    const key = `${dir}\0${base}${ext}`.toLowerCase();
    for (let i = next.get(key) ?? 1; ; i++) {
      const name = i === 1 ? `${base}${ext}` : `${base} ${i}${ext}`;
      if (!names.has(name.toLowerCase())) {
        next.set(key, i + 1);
        names.add(name.toLowerCase());
        return dir ? `${dir}/${name}` : name;
      }
    }
  };
  // Folders that differ only in case are one folder (the first spelling wins) – never `Projekt/` next to `projekt/`;
  // unless they come from different places in the export (`keys`), then the later one is numbered.
  const folderAt = new Map<string, string>();
  const ownerOf = new Map<string, string>();
  const dirOf = (segs: string[], keys?: string[]) => {
    let dir = '';
    for (const [i, s] of segs.entries()) {
      const key = keys?.[i];
      let next = '';
      for (let n = 1; ; n++) {
        const name = n === 1 ? fileNameFor(s.normalize('NFC')) : `${fileNameFor(s.normalize('NFC'))} ${n}`;
        next = dir ? `${dir}/${name}` : name;
        const owner = ownerOf.get(next.toLowerCase());
        if (key === undefined || owner === undefined || owner === key) break;
      }
      if (key !== undefined && !ownerOf.has(next.toLowerCase())) ownerOf.set(next.toLowerCase(), key);
      dir = folderAt.get(next.toLowerCase()) ?? next;
      folderAt.set(dir.toLowerCase(), dir);
      folders.add(dir);
    }
    return dir;
  };

  const warnings: Warning[] = [];
  const noteAt = new Map<string, string>();
  // Export paths in NFC (and in NFC and lower case) → the first note or file there: for links written in the other
  // Unicode form or case.
  const nfc = new Map<string, string>();
  const loose = new Map<string, string>();
  const other = (from: string, path: string) => {
    for (const [map, key] of [[nfc, from.normalize('NFC')], [loose, from.normalize('NFC').toLowerCase()]] as const) if (!map.has(key)) map.set(key, path);
  };
  const notes: (PlannedNote & { from: string; name: string; names: string[]; exact: boolean })[] = draft.notes.map((n) => {
    const dir = dirOf(n.dir, n.dirKeys);
    const path = n.folderPage ? unique(dir, opts.folderNote.replace(/\.md$/i, ''), '.md') : unique(dir, fileNameFor(n.name.normalize('NFC')), '.md');
    noteAt.set(n.from, path);
    other(n.from, path);
    return { path, content: n.content, from: n.from, name: n.name, names: n.names ?? [], exact: !!n.exactLinks };
  });

  const fileAt = new Map<string, string>();
  const files: PlannedFile[] = [];
  const blocked: string[] = [];
  for (const f of draft.files) {
    const name = attachmentName(f.name);
    if (opts.blocked.has(extensionOf(name))) {
      blocked.push(f.from);
      continue;
    }
    let dir = dirOf(f.dir, f.dirKeys);
    // The app shows images and PDFs anywhere, other files only as attachments (isServable).
    if (!isServable(dir ? `${dir}/${name}` : name)) dir = dir ? `${dir}/${ASSETS_DIR}` : ASSETS_DIR;
    const path = unique(dir, name.replace(/(\.[^.]*)?$/, ''), name.match(/\.[^.]*$/)?.[0] ?? '');
    fileAt.set(f.from, path);
    other(f.from, path);
    files.push({ path, source: f.source });
  }
  if (blocked.length) warnings.push({ text: 'Dateien mit gesperrter Dateiendung – nicht übernommen', notes: [], items: blocked });

  // Links between the imported files: from their old places to the new ones.
  const lookup = (path: string, kind: string, exact: boolean) => {
    const tries = kind === 'image' || exact ? [path] : [path, `${path}.md`, `${path}/${opts.folderNote}`, `${path}/index.md`, `${path}/README.md`];
    for (const p of tries) {
      const hit = noteAt.get(p) ?? fileAt.get(p);
      if (hit) return hit;
    }
    // Then in the other Unicode form – for the exact links of a converter (Wiki.js) only that, else in any case too.
    for (const p of tries) {
      const hit = nfc.get(p.normalize('NFC')) ?? (exact ? undefined : loose.get(p.normalize('NFC').toLowerCase()));
      if (hit) return hit;
    }
    return null;
  };
  const dangling: string[] = [];
  for (const n of notes) {
    const raw = n.content;
    const parts: string[] = [];
    let at = 0;
    let broken = false;
    for (const l of extractLinks(raw).sort((a, b) => a.start - b.start)) {
      // Programs that write names as they are (Obsidian) leave `?` and a lone `%` in a link – as part of the name.
      const literal = l.href.replace(/%(?![0-9a-f]{2})/gi, '%25').replace(/\?/g, '%3F');
      let target = resolveHref(l.href, n.from);
      let found = target && lookup(target.path, l.kind, n.exact);
      if (!found && literal !== l.href) {
        target = resolveHref(literal, n.from);
        found = target && lookup(target.path, l.kind, n.exact);
      }
      if (!found || !target) {
        broken = true;
        continue;
      }
      // An anchor on a note is a heading, written as GitHub/Gitea name it (`#Erste Schritte` → `#erste-schritte`); the app
      // itself opens the note at the top.
      const anchor = target.anchor === null ? null : /\.md$/i.test(found) ? (target.anchor.startsWith('^') ? null : headingSlug(decodeUriSafe(target.anchor))) : decodeUriSafe(target.anchor);
      // An absolute link of the export (`/Sub/Seite.md`) is relative to the export – inside the import it becomes relative.
      parts.push(raw.slice(at, l.start), formatLink(l.raw.replace(/^(<?)\/+/, '$1'), n.path, found, opts.folderNote, anchor));
      at = l.end;
    }
    n.content = parts.length ? parts.join('') + raw.slice(at) : raw;
    if (broken) dangling.push(n.path);
  }

  // `#[[two words]]` is a tag, `query[[…]]` a query (SilverBullet) – no links.
  if (draft.wikiLinks) {
    const index = new WikiIndex(notes, draft.files.map((f) => ({ from: f.from, path: fileAt.get(f.from) })));
    const missing = new Set<string>();
    const ambiguous = new Set<string>();
    for (const n of notes) {
      // Properties keep their `[[…]]` as written – a Markdown link there would only be text.
      const { frontmatter, body } = splitFrontmatter(n.content);
      n.content = frontmatter + outsideCode(body, (part) =>
        part.replace(/(?<![#\w])(!?)\[\[([^[\]\n]+?)\]\]/g, (all, bang: string, inner: string) => {
          // In a table Obsidian writes the separator as `\|`.
          const [target = '', alias] = inner.split(/\\?\|/);
          const hash = target.indexOf('#');
          const name = (hash >= 0 ? target.slice(0, hash) : target).trim();
          // A `#` may also be part of the name (`[[Grillabend #3]]`) – then the whole is the name.
          let hit = name ? index.find(name, n.from, n.path, !!bang) : { path: n.path, ambiguous: false };
          let heading = hash >= 0 ? target.slice(hash + 1).trim() : '';
          if (!hit && hash >= 0 && (hit = index.find(target.trim(), n.from, n.path, !!bang))) heading = '';
          if (!hit) {
            missing.add(n.path);
            return all;
          }
          if (hit.ambiguous) ambiguous.add(n.path);
          const note = /\.md$/i.test(hit.path);
          // On a note a heading (block ids `^abc` have no anchor here); on a PDF its own `#page=2`.
          const anchor = !heading || heading.startsWith('^') ? null : note ? headingSlug(heading) : heading;
          const href = formatLink('x.md', n.path, hit.path, opts.folderNote, anchor);
          // A relative path (`[[../Hafen/Küche]]`, Obsidian after a rename) shows as its last part; page names with
          // `/` (Logseq namespaces, SilverBullet) stay whole.
          const written = heading ? name : target.trim();
          const label = written.startsWith('.') ? written.split('/').pop()! : written;
          const shown = heading && !heading.startsWith('^') && note ? (name ? `${label} – ${heading}` : heading) : label || posix.basename(hit.path, '.md');
          const text = (alias ?? shown).trim() || shown;
          // An embedded picture stays a picture; an embedded note or PDF becomes a link to it.
          return bang && /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(hit.path) ? `![${alias && !/^\d+(x\d+)?$/.test(alias) ? linkText(alias) : ''}](${href})` : `[${linkText(text)}](${href})`;
        }),
      );
    }
    if (missing.size) warnings.push({ text: '[[Links]] auf Seiten, die nicht im Export sind – sie bleiben als Text stehen', notes: [...missing], items: [] });
    if (ambiguous.size) warnings.push({ text: '[[Links]] auf Namen, die es mehrfach gibt – die nächstgelegene Seite wurde gewählt', notes: [...ambiguous], items: [] });
  }
  if (dangling.length) warnings.push({ text: 'Links auf Seiten oder Dateien, die nicht im Export sind', notes: dangling, items: [] });

  // Links that would run code (`javascript:` from a clipped web page) lose their address – only the app's click guard
  // would stop them otherwise; pictures as `data:image/…` stay pictures.
  const scripted: string[] = [];
  for (const n of notes) {
    const found = scriptLinks(n.content);
    if (!found.length) continue;
    let content = n.content;
    for (const l of found.sort((a, b) => b.start - a.start)) content = content.slice(0, l.start) + l.text + content.slice(l.end);
    n.content = content;
    scripted.push(n.path);
  }
  if (scripted.length) warnings.push({ text: 'Links mit Skript-Adressen (javascript:, data:) – die Adresse wurde entfernt, der Text bleibt', notes: scripted, items: [] });

  const remote = draft.remote ?? [];
  if (remote.length) {
    const concerned = [...new Set(remote.flatMap((r) => r.notes))];
    warnings.push({
      text: draft.remoteTried ? 'Notizen mit Bildern, die sich vom alten Server nicht holen ließen – sie bleiben Web-Links' : 'Notizen mit Bildern auf dem alten Server – der Export enthält sie nicht, sie bleiben Web-Links',
      notes: concerned.map((f) => noteAt.get(f)).filter((p): p is string => !!p),
      items: [],
      remote: !draft.remoteTried,
    });
  }
  for (const w of draft.warnings) warnings.push({ text: w.text, notes: (w.notes ?? []).map((f) => noteAt.get(f)).filter((p): p is string => !!p), items: w.items ?? [] });
  for (const f of files) for (let d = posix.dirname(f.path); d !== '.'; d = posix.dirname(d)) folders.add(d);
  const servers = [...new Set(remote.map((r) => new URL(r.url).host))].sort();
  return { notes: notes.map(({ path, content }) => ({ path, content })), files, folders: folders.size, warnings, remote: { count: remote.length, servers } };
}

/** Names that `[[…]]` may use for a note or file: its name, its file name, its path (with or without extension). */
class WikiIndex {
  private readonly byKey = new Map<string, Set<string>>();
  /** Keys by their last path segment, built on the first `[[a/b]]` that needs it; the paths per tail found. */
  private byLast: Map<string, string[]> | null = null;
  private readonly tails = new Map<string, string[] | null>();
  private readonly found = new Map<string, { path: string; ambiguous: boolean } | null>();
  constructor(notes: { path: string; from: string; name: string; names: string[] }[], files: { from: string; path: string | undefined }[]) {
    for (const n of notes) {
      const fromNoExt = n.from.replace(/\.(md|markdown)$/i, '');
      for (const k of [n.name, ...n.names, fromNoExt, posix.basename(fromNoExt), n.path.replace(/\.md$/, ''), posix.basename(n.path, '.md')]) this.add(k, n.path);
    }
    for (const f of files) if (f.path) for (const k of [f.from, posix.basename(f.from)]) this.add(k, f.path);
  }
  private add(key: string, path: string) {
    const k = key.normalize('NFC').toLowerCase();
    const set = this.byKey.get(k);
    if (set) set.add(path);
    else this.byKey.set(k, new Set([path]));
  }
  /** Paths of all keys that end with `/k` or `/k.md`. */
  private tail(k: string): string[] | null {
    if (this.tails.has(k)) return this.tails.get(k)!;
    if (!this.byLast) {
      this.byLast = new Map();
      for (const key of this.byKey.keys()) {
        const last = posix.basename(key);
        const keys = this.byLast.get(last);
        if (keys) keys.push(key);
        else this.byLast.set(last, [key]);
      }
    }
    const last = posix.basename(k);
    const tail = `/${k}`;
    const keys = [...(this.byLast.get(last) ?? []), ...(this.byLast.get(`${last}.md`) ?? [])].filter((key) => key.endsWith(tail) || key.endsWith(`${tail}.md`));
    const found = [...new Set(keys.flatMap((key) => [...this.byKey.get(key)!]))];
    this.tails.set(k, found.length ? found : null);
    return found.length ? found : null;
  }
  /** The target for a name (`from` = the linking note in the export, `at` = in the import); with several, the one nearest to it (same folder first, then shortest path). */
  find(name: string, from: string, at: string, embed: boolean): { path: string; ambiguous: boolean } | null {
    // The same link many times in a note is looked up once.
    const memo = `${name}\0${posix.dirname(from)}\0${posix.dirname(at)}\0${embed}`;
    if (!this.found.has(memo)) this.found.set(memo, this.lookup(name, from, at, embed));
    return this.found.get(memo)!;
  }
  private lookup(name: string, from: string, at: string, embed: boolean): { path: string; ambiguous: boolean } | null {
    const k = name.normalize('NFC').toLowerCase().replace(/^\/+/, '');
    const set = (key: string) => this.byKey.get(key) ?? (embed ? null : this.byKey.get(`${key}.md`)) ?? null;
    const get = (key: string) => {
      const paths = set(key);
      return paths ? [...paths] : null;
    };
    // `[[../Hafen/Küche]]` (Obsidian after a rename) is relative to the linking note; `[[Theorie/Wetter]]` may be any
    // path that ends so.
    const relative = /^\.\.?\//.test(k) || k.includes('/') ? posix.normalize(posix.join(posix.dirname(from.normalize('NFC').toLowerCase()), k)) : null;
    let list = get(k) ?? (relative && !relative.startsWith('..') ? get(relative) : null);
    if (!list && k.includes('/') && !k.startsWith('.')) list = this.tail(k);
    if (!list?.length) return null;
    if (list.length === 1) return { path: list[0]!, ambiguous: false };
    const dir = posix.dirname(at);
    const best = [...list].sort((a, b) => Number(posix.dirname(b) === dir) - Number(posix.dirname(a) === dir) || a.split('/').length - b.split('/').length || a.localeCompare(b))[0]!;
    return { path: best, ambiguous: true };
  }
}

/** Text between `[` and `]` of a Markdown link: brackets and the backslash escaped (CodeQL js/incomplete-sanitization – an
 * unescaped `\` before `]` broke the link). */
function linkText(s: string): string {
  return s.replace(/[[\]\\]/g, '\\$&');
}
