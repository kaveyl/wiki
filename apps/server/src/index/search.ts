// Instant search: grouped results (folders, title matches, content matches with snippet).
// Word-prefix search via FTS5 unicode61, substring search via the trigram table.
// SEE-DOC: docs/PLAN.md §3b

import type { DB } from '../db/db.js';

export interface SearchHit {
  mountId: string;
  path: string;
  kind: 'file' | 'dir';
  title: string;
  icon: string | null;
  /** Content snippet with matches wrapped in \u0001 … \u0002 (the client renders highlights). */
  snippet?: string;
}

export interface SearchResult {
  folders: SearchHit[];
  notes: SearchHit[];
  content: SearchHit[];
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to these mounts (e.g. those the user may read). */
  mountIds?: string[];
}

export function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
}

export function search(db: DB, q: string, opts: SearchOptions = {}): SearchResult {
  const limit = opts.limit ?? 8;
  const tokens = tokenize(q);
  if (!tokens.length) return { folders: [], notes: [], content: [] };

  const mountFilter = opts.mountIds ? `AND mount_id IN (${opts.mountIds.map(() => '?').join(',') || "''"})` : '';
  const mountArgs = opts.mountIds ?? [];
  const wordQuery = tokens.map((t) => `"${t}"*`).join(' AND ');
  const triTokens = tokens.filter((t) => t.length >= 3);

  // Titles / folder names: substring (trigram) for tokens ≥ 3 chars, prefix otherwise.
  const titleRows: { mount_id: string; entry_path: string }[] = [];
  if (triTokens.length === tokens.length) {
    const triQuery = tokens.map((t) => `"${t}"`).join(' AND ');
    titleRows.push(
      ...(db
        .prepare(`SELECT mount_id, entry_path FROM entries_tri WHERE entries_tri MATCH ? ${mountFilter} ORDER BY rank LIMIT 200`)
        .all(`{title path} : (${triQuery})`, ...mountArgs) as typeof titleRows),
    );
  } else {
    titleRows.push(
      ...(db
        .prepare(`SELECT mount_id, entry_path FROM entries_fts WHERE entries_fts MATCH ? ${mountFilter} ORDER BY rank LIMIT 200`)
        .all(`{title path} : (${wordQuery})`, ...mountArgs) as typeof titleRows),
    );
  }

  const entry = db.prepare('SELECT kind, title, icon FROM entries WHERE mount_id = ? AND path = ?');
  const folders: SearchHit[] = [];
  const notes: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of titleRows) {
    const e = entry.get(r.mount_id, r.entry_path) as { kind: 'file' | 'dir'; title: string; icon: string | null } | undefined;
    if (!e) continue;
    const hit: SearchHit = { mountId: r.mount_id, path: r.entry_path, kind: e.kind, title: e.title, icon: e.icon };
    if (e.kind === 'dir') {
      if (folders.length < limit) folders.push(hit);
    } else if (notes.length < limit) {
      notes.push(hit);
      seen.add(`${r.mount_id}\0${r.entry_path}`);
    }
  }

  const contentRows = db
    .prepare(
      `SELECT mount_id, entry_path, title, snippet(entries_fts, 3, char(1), char(2), '…', 12) AS snip
       FROM entries_fts WHERE entries_fts MATCH ? ${mountFilter} ORDER BY rank LIMIT ?`,
    )
    .all(`body : (${wordQuery})`, ...mountArgs, limit * 3) as { mount_id: string; entry_path: string; title: string; snip: string }[];
  const content: SearchHit[] = [];
  for (const r of contentRows) {
    if (content.length >= limit) break;
    if (seen.has(`${r.mount_id}\0${r.entry_path}`)) continue;
    const e = entry.get(r.mount_id, r.entry_path) as { icon: string | null } | undefined;
    content.push({ mountId: r.mount_id, path: r.entry_path, kind: 'file', title: r.title, icon: e?.icon ?? null, snippet: r.snip });
  }
  return { folders, notes, content };
}

// ── Search page: operators and filters (docs/PLAN.md §3b) ─────────────────────────────

export interface ParsedQuery {
  words: string[];
  phrases: string[];
  excludes: string[];
  tags: string[];
  /** `in:` values — matched against mount names (case-insensitive) or ids. */
  mounts: string[];
  /** `path:` prefixes relative to the mount root. */
  paths: string[];
  /** `seit:`/`since:` — epoch milliseconds, or null. */
  since: number | null;
}

/**
 * `tag:projekt in:wikijs path:docs/ seit:7d "exakte phrase" -ausschluss wort`.
 * Unknown `x:y` stays a normal word, so "10:30" or URLs still search as text.
 */
export function parseQuery(q: string, now = Date.now()): ParsedQuery {
  const out: ParsedQuery = { words: [], phrases: [], excludes: [], tags: [], mounts: [], paths: [], since: null };
  for (const m of q.matchAll(/(-?)(?:([a-zäöü]+):)?("([^"]*)"?|\S+)/gi)) {
    const neg = m[1] === '-';
    const op = m[2]?.toLowerCase();
    const value = (m[4] ?? m[3]!).trim();
    if (!value) continue;
    const quoted = m[4] !== undefined;
    if (op === 'tag' || op === 'tags') out.tags.push(value.toLowerCase().replace(/^#/, ''));
    else if (op === 'in' || op === 'quelle') out.mounts.push(value.toLowerCase());
    else if (op === 'path' || op === 'pfad') out.paths.push(value.replace(/^\/+/, ''));
    else if (op === 'seit' || op === 'since' || op === 'geändert') out.since = parseSince(value, now);
    else {
      const text = op ? `${m[2]}:${value}` : value;
      if (neg) out.excludes.push(text);
      else if (quoted) out.phrases.push(text);
      else out.words.push(text);
    }
  }
  return out;
}

function parseSince(v: string, now: number): number | null {
  const rel = /^(\d+)\s*([hdwmy])$/i.exec(v);
  if (rel) {
    const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[rel[2]!.toLowerCase() as 'h'];
    return now - Number(rel[1]) * unit;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export interface FullHit {
  mountId: string;
  path: string;
  title: string;
  icon: string | null;
  tags: string[];
  mtime: number;
  snippet?: string;
}

export interface FullSearchOptions {
  limit?: number;
  mounts: { id: string; name: string }[];
}

export function searchFull(db: DB, q: string, opts: FullSearchOptions): { hits: FullHit[]; query: ParsedQuery } {
  const query = parseQuery(q);
  const limit = Math.min(200, opts.limit ?? 100);
  let mountIds = opts.mounts.map((m) => m.id);
  if (query.mounts.length) {
    mountIds = opts.mounts.filter((m) => query.mounts.some((v) => m.name.toLowerCase().includes(v) || m.id.toLowerCase() === v)).map((m) => m.id);
  }
  if (!mountIds.length) return { hits: [], query };

  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const positive = [
    ...query.words.flatMap(tokenize).map((t) => `${quote(t)}*`),
    ...query.phrases.map((p) => quote(tokenize(p).join(' '))).filter((p) => p !== '""'),
  ];
  const negative = query.excludes.flatMap(tokenize).map((t) => `${quote(t)}*`);
  const inMounts = `mount_id IN (${mountIds.map(() => '?').join(',')})`;

  let rows: { mount_id: string; entry_path: string; snip: string | null }[];
  if (positive.length) {
    const match = positive.join(' AND ') + negative.map((n) => ` NOT ${n}`).join('');
    rows = db
      .prepare(
        `SELECT mount_id, entry_path, snippet(entries_fts, 3, char(1), char(2), '…', 16) AS snip
         FROM entries_fts WHERE entries_fts MATCH ? AND ${inMounts} ORDER BY rank LIMIT 2000`,
      )
      .all(`{title path tags body} : (${match})`, ...mountIds) as typeof rows;
  } else if (query.tags.length || query.paths.length || query.since !== null || query.mounts.length) {
    // Filters only: newest first.
    rows = db
      .prepare(`SELECT mount_id, path AS entry_path, NULL AS snip FROM entries WHERE kind = 'file' AND ${inMounts} ORDER BY mtime DESC LIMIT 5000`)
      .all(...mountIds) as typeof rows;
    if (negative.length) {
      const excluded = new Set(
        (
          db
            .prepare(`SELECT mount_id, entry_path FROM entries_fts WHERE entries_fts MATCH ? AND ${inMounts}`)
            .all(`{title path tags body} : (${negative.join(' OR ')})`, ...mountIds) as { mount_id: string; entry_path: string }[]
        ).map((r) => `${r.mount_id}\0${r.entry_path}`),
      );
      rows = rows.filter((r) => !excluded.has(`${r.mount_id}\0${r.entry_path}`));
    }
  } else {
    return { hits: [], query };
  }

  const entry = db.prepare("SELECT title, icon, tags_json, mtime FROM entries WHERE mount_id = ? AND path = ? AND kind = 'file'");
  const hits: FullHit[] = [];
  for (const r of rows) {
    if (hits.length >= limit) break;
    if (query.paths.length && !query.paths.some((p) => r.entry_path === p || r.entry_path.startsWith(p.endsWith('/') ? p : `${p}/`) || r.entry_path.startsWith(p))) continue;
    const e = entry.get(r.mount_id, r.entry_path) as { title: string; icon: string | null; tags_json: string; mtime: number } | undefined;
    if (!e) continue;
    const tags = (JSON.parse(e.tags_json) as string[]).map(String);
    if (query.tags.length && !query.tags.every((t) => tags.some((x) => x.toLowerCase() === t))) continue;
    if (query.since !== null && e.mtime < query.since) continue;
    hits.push({ mountId: r.mount_id, path: r.entry_path, title: e.title, icon: e.icon, tags, mtime: e.mtime, ...(r.snip ? { snippet: r.snip } : {}) });
  }
  return { hits, query };
}
