// Derived index of all visible notes per mount (SQLite `entries` + FTS tables).
// Rebuildable at any time from the files on disk; the watcher feeds incremental updates.
// Directories are derived: a folder is visible when it (recursively) contains a visible note.
// Note identities (`note_ids`) are NOT derived: they follow a note across renames, detected
// by frontmatter id, identical content or git's rename detection. SEE-DOC: docs/PLAN.md §2.2

import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { listedAttachments, noteMeta, resolveHref, type LinkKind } from '@kaveyl-wiki/core';
import { fileReferences } from '../markdown/fileRefs.js';
import { markdown } from '../markdown/pool.js';
import type { DB } from '../db/db.js';
import { contentRoot, fileFilter, isIgnoredSegment, parentOf, subpathThroughSymlink, type Mount } from '../mounts/model.js';

const MAX_INDEX_BYTES = 2 * 1024 * 1024;

export interface Entry {
  mountId: string;
  path: string;
  parent: string;
  name: string;
  kind: 'file' | 'dir';
  noteId: string | null;
  title: string;
  icon: string | null;
  readonly: boolean;
  tags: string[];
  size: number;
  mtime: number;
  hash: string | null;
}

interface EntryRow {
  mount_id: string;
  path: string;
  parent: string;
  name: string;
  kind: 'file' | 'dir';
  note_id: string | null;
  title: string;
  icon: string | null;
  readonly: number;
  tags_json: string;
  size: number;
  mtime: number;
  hash: string | null;
}

export function entryFromRow(r: EntryRow): Entry {
  return {
    mountId: r.mount_id,
    path: r.path,
    parent: r.parent,
    name: r.name,
    kind: r.kind,
    noteId: r.note_id,
    title: r.title,
    icon: r.icon,
    readonly: r.readonly === 1,
    tags: JSON.parse(r.tags_json) as string[],
    size: r.size,
    mtime: r.mtime,
    hash: r.hash,
  };
}

export interface IndexChange {
  added: string[];
  updated: string[];
  removed: string[];
  /** Notes that moved; listed here only, not in added/removed. */
  renamed: { from: string; to: string }[];
}

/** A removed note, remembered briefly so a re-appearance under another path counts as a move. */
interface Gone {
  path: string;
  id: string;
  hash: string | null;
  at: number;
}

/** Window in which `unlink` + `add` with matching id/content count as a move (watcher batches). */
const RENAME_WINDOW_MS = 5000;

interface IndexedLink {
  target: string;
  kind: LinkKind;
  anchor: string | null;
}

type Rec = Entry & { text: string; fmId: string | null; links: IndexedLink[] };

export interface Backlink {
  path: string;
  title: string;
  count: number;
}

export const sha1 = (data: Buffer | string) => createHash('sha1').update(data).digest('hex');

export class Indexer {
  constructor(
    private readonly db: DB,
    private readonly dataPath: string,
  ) {}

  private readonly gone = new Map<string, Gone[]>();

  /** Full rebuild of a mount's index (identities are kept and matched, see resolveIds). */
  async rebuild(mount: Mount): Promise<IndexChange> {
    const visible = fileFilter(mount);
    const files: string[] = [];
    // A subpath that turned into a link (AD-047): nothing to index, earlier entries go.
    if (!subpathThroughSymlink(mount, this.dataPath))
      await walk(contentRoot(mount, this.dataPath), '', (rel) => {
        if (visible(rel)) files.push(rel);
      });
    const records = (await Promise.all(files.map((rel) => this.readRecord(mount, rel)))).filter((r): r is Rec => r !== null);
    const known = this.knownIds(mount.id);
    const present = new Set(records.map((r) => r.path));
    const removed = [...known.entries()].filter(([p]) => !present.has(p)).map(([path, k]) => ({ path, ...k }));
    const change: IndexChange = { added: [], updated: [], removed: [], renamed: [] };
    // What the index held before: only files whose content differs count as changed (a restart changes nothing).
    const before = new Map(
      (this.db.prepare("SELECT path, hash, size, mtime FROM entries WHERE mount_id = ? AND kind = 'file'").all(mount.id) as { path: string; hash: string | null; size: number; mtime: number }[]).map((r) => [r.path, r]),
    );
    const differs = (rec: Rec) => {
      const b = before.get(rec.path);
      return !b || b.hash !== rec.hash || (rec.hash === null && (b.size !== rec.size || b.mtime !== rec.mtime));
    };
    const byPath = new Map(records.map((r) => [r.path, r]));
    this.db.transaction(() => {
      // Identities are re-written from scratch; `known` carries the previous ones.
      this.db.prepare('DELETE FROM note_ids WHERE mount_id = ?').run(mount.id);
      const ids = this.resolveIds(mount.id, records, known, removed, new Map(), change);
      change.updated = change.updated.filter((p) => differs(byPath.get(p)!));
      this.clear(mount.id);
      for (const rec of records) this.insertFile({ ...rec, noteId: ids.get(rec.path)! });
      this.syncDirs(mount.id);
    })();
    return change;
  }

  /**
   * Re-reads the given mount-relative paths (files or folders) and updates the index.
   * `hints` maps new path → old path for renames git already detected (`diff -M`).
   */
  async update(mount: Mount, paths: string[], hints: Map<string, string> = new Map()): Promise<IndexChange> {
    if (subpathThroughSymlink(mount, this.dataPath)) return this.rebuild(mount);
    const visible = fileFilter(mount);
    const root = contentRoot(mount, this.dataPath);
    const change: IndexChange = { added: [], updated: [], removed: [], renamed: [] };
    const targets = new Set<string>();
    for (const p of paths) {
      const st = await lstat(join(root, ...p.split('/').filter(Boolean))).catch(() => null);
      if (st?.isDirectory()) {
        await walk(join(root, ...p.split('/')), p, (rel) => targets.add(rel));
        // Files under a moved/deleted folder that are still indexed must be re-checked too.
        for (const known of this.filePaths(mount.id)) if (known.startsWith(p + '/')) targets.add(known);
      } else {
        targets.add(p);
        if (!st) for (const known of this.filePaths(mount.id)) if (known.startsWith(p + '/')) targets.add(known);
      }
    }
    const records = new Map<string, Rec | null>();
    for (const rel of targets) records.set(rel, visible(rel) ? await this.readRecord(mount, rel) : null);

    this.db.transaction(() => {
      const known = new Map<string, { id: string; hash: string | null }>();
      const removed: { path: string; id: string; hash: string | null }[] = [];
      const changed: Rec[] = [];
      for (const [rel, rec] of records) {
        const row = this.db.prepare('SELECT id, hash FROM note_ids WHERE mount_id = ? AND path = ?').get(mount.id, rel) as
          | { id: string; hash: string | null }
          | undefined;
        const indexed = this.db.prepare("SELECT hash FROM entries WHERE mount_id = ? AND path = ? AND kind = 'file'").get(mount.id, rel) as
          | { hash: string | null }
          | undefined;
        if (row) known.set(rel, row);
        if (!rec) {
          if (indexed) removed.push({ path: rel, id: row?.id ?? ulid(), hash: indexed.hash });
          continue;
        }
        if (indexed && indexed.hash === rec.hash && row) continue;
        changed.push(rec);
      }
      const ids = this.resolveIds(mount.id, changed, known, removed, hints, change);
      for (const r of removed) {
        this.deleteFile(mount.id, r.path);
        if (!change.renamed.some((m) => m.from === r.path)) change.removed.push(r.path);
      }
      for (const rec of changed) {
        this.deleteFile(mount.id, rec.path);
        this.insertFile({ ...rec, noteId: ids.get(rec.path)! });
      }
      this.syncDirs(mount.id);
    })();
    return change;
  }

  /**
   * Decides the identity of every changed/new record and fills `change`. Order of evidence
   * for "this new path is that removed note": git rename hint, same frontmatter id, same
   * content hash — matched against notes removed in this batch or shortly before.
   * A frontmatter id that another note in the mount already carries is a copy: the existing
   * note keeps it, the copy gets a fresh id (fsck reports it).
   */
  private resolveIds(
    mountId: string,
    records: Rec[],
    known: Map<string, { id: string; hash: string | null }>,
    removed: { path: string; id: string; hash: string | null }[],
    hints: Map<string, string>,
    change: IndexChange,
  ): Map<string, string> {
    const now = Date.now();
    const recent = (this.gone.get(mountId) ?? []).filter((g) => now - g.at < RENAME_WINDOW_MS);
    const candidates: Gone[] = [...removed.map((r) => ({ ...r, at: now })), ...recent];
    const taken = (id: string, path: string) =>
      [...known.entries()].some(([p, k]) => k.id === id && p !== path && !removed.some((r) => r.path === p)) ||
      (this.db.prepare('SELECT 1 FROM note_ids WHERE mount_id = ? AND id = ? AND path != ?').get(mountId, id, path) !== undefined &&
        !candidates.some((c) => c.id === id));
    const ids = new Map<string, string>();
    const claim = (pred: (g: Gone) => boolean) => {
      const i = candidates.findIndex(pred);
      return i >= 0 ? candidates.splice(i, 1)[0]! : null;
    };
    // Existing paths keep their identity (a newly added frontmatter id wins if it is unique).
    const fresh: Rec[] = [];
    for (const rec of records) {
      const k = known.get(rec.path);
      if (!k) {
        fresh.push(rec);
        continue;
      }
      ids.set(rec.path, rec.fmId && rec.fmId !== k.id && !taken(rec.fmId, rec.path) ? rec.fmId : k.id);
      change.updated.push(rec.path);
    }
    for (const rec of fresh) {
      const hinted = hints.get(rec.path);
      const match =
        (hinted !== undefined ? claim((g) => g.path === hinted) : null) ??
        (rec.fmId ? claim((g) => g.id === rec.fmId) : null) ??
        (rec.hash ? claim((g) => g.hash === rec.hash) : null);
      if (match) {
        ids.set(rec.path, rec.fmId && rec.fmId !== match.id && !taken(rec.fmId, rec.path) ? rec.fmId : match.id);
        change.renamed.push({ from: match.path, to: rec.path });
        continue;
      }
      ids.set(rec.path, rec.fmId && !taken(rec.fmId, rec.path) ? rec.fmId : ulid());
      change.added.push(rec.path);
    }
    // Unmatched removals stay claimable for a moment (rename split across watcher batches).
    const removedNow = removed.filter((r) => !change.renamed.some((m) => m.from === r.path));
    this.gone.set(mountId, [...recent.filter((g) => candidates.includes(g)), ...removedNow.map((r) => ({ ...r, at: now }))]);
    for (const r of removed) this.db.prepare('DELETE FROM note_ids WHERE mount_id = ? AND path = ?').run(mountId, r.path);
    for (const rec of records) {
      this.db
        .prepare('INSERT INTO note_ids (mount_id, path, id, hash) VALUES (?, ?, ?, ?) ON CONFLICT (mount_id, path) DO UPDATE SET id = excluded.id, hash = excluded.hash')
        .run(mountId, rec.path, ids.get(rec.path)!, rec.hash);
    }
    return ids;
  }

  /** Link targets as written that resolve to the note at `path` (with `.md`, extension-less, folder). */
  linkKeys(mount: Mount, path: string): string[] {
    const keys = [path, path.replace(/\.md$/i, '')];
    const base = posix.basename(path);
    if (base === mount.options.folderNote) keys.push(parentOf(path));
    return [...new Set(keys)];
  }

  /** Notes linking to `path` (images excluded), with their titles. */
  backlinks(mount: Mount, path: string): Backlink[] {
    const keys = this.linkKeys(mount, path);
    const rows = this.db
      .prepare(
        `SELECT l.src_path AS path, COALESCE(e.title, l.src_path) AS title, COUNT(*) AS count
         FROM links l LEFT JOIN entries e ON e.mount_id = l.mount_id AND e.path = l.src_path
         WHERE l.mount_id = ? AND l.kind != 'image' AND l.target IN (${keys.map(() => '?').join(',')}) AND l.src_path != ?
         GROUP BY l.src_path ORDER BY title COLLATE NOCASE`,
      )
      .all(mount.id, ...keys, path) as Backlink[];
    return rows;
  }

  /** Source notes with links (any kind) whose target lies at or below one of `paths`. */
  linkSources(mountId: string, targets: string[]): string[] {
    const out = new Set<string>();
    for (const t of targets) {
      const rows = this.db
        .prepare("SELECT DISTINCT src_path FROM links WHERE mount_id = ? AND (target = ? OR target LIKE ? ESCAPE '\\')")
        .all(mountId, t, `${t.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`) as { src_path: string }[];
      for (const r of rows) out.add(r.src_path);
    }
    return [...out];
  }

  /** All indexed links of a mount (fsck). */
  allLinks(mountId: string): { src: string; target: string; kind: LinkKind }[] {
    return this.db.prepare('SELECT src_path AS src, target, kind FROM links WHERE mount_id = ?').all(mountId) as { src: string; target: string; kind: LinkKind }[];
  }

  /** Path → identity for a mount, from the persistent identity table. */
  private knownIds(mountId: string): Map<string, { id: string; hash: string | null }> {
    const rows = this.db.prepare('SELECT path, id, hash FROM note_ids WHERE mount_id = ?').all(mountId) as { path: string; id: string; hash: string | null }[];
    return new Map(rows.map((r) => [r.path, { id: r.id, hash: r.hash }]));
  }

  /** Current path of a note id in a mount (null if unknown). */
  pathOf(mountId: string, id: string): string | null {
    const row = this.db.prepare('SELECT path FROM note_ids WHERE mount_id = ? AND id = ?').get(mountId, id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  clear(mountId: string) {
    this.db.prepare('DELETE FROM links WHERE mount_id = ?').run(mountId);
    this.db.prepare('DELETE FROM entries WHERE mount_id = ?').run(mountId);
    this.db.prepare('DELETE FROM entries_fts WHERE mount_id = ?').run(mountId);
    this.db.prepare('DELETE FROM entries_tri WHERE mount_id = ?').run(mountId);
  }

  get(mountId: string, path: string): Entry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE mount_id = ? AND path = ?').get(mountId, path) as EntryRow | undefined;
    return row ? entryFromRow(row) : null;
  }

  children(mountId: string, parent: string): Entry[] {
    return (
      this.db
        .prepare("SELECT * FROM entries WHERE mount_id = ? AND parent = ? AND path != '' ORDER BY kind = 'file', name COLLATE NOCASE")
        .all(mountId, parent) as EntryRow[]
    ).map(entryFromRow);
  }

  all(mountId: string): Entry[] {
    return (this.db.prepare('SELECT * FROM entries WHERE mount_id = ? ORDER BY path').all(mountId) as EntryRow[]).map(entryFromRow);
  }

  private filePaths(mountId: string): string[] {
    return (this.db.prepare("SELECT path FROM entries WHERE mount_id = ? AND kind = 'file'").all(mountId) as { path: string }[]).map((r) => r.path);
  }

  private async readRecord(mount: Mount, rel: string): Promise<Rec | null> {
    const abs = join(contentRoot(mount, this.dataPath), ...rel.split('/'));
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) return null;
    const data = st.size <= MAX_INDEX_BYTES ? await readFile(abs) : null;
    const name = posix.basename(rel);
    const raw = data?.toString('utf8') ?? null;
    const meta = raw !== null ? noteMeta(raw, name) : null;
    const links: IndexedLink[] = [];
    if (raw !== null && meta?.frontmatter.encrypted !== 'age') {
      // In the worker, at most 256 KB (sec-006). A note too large or too nested for the parser has no links to notes
      // here – but its pictures and files count, so nothing it shows is taken for unused (AD-076).
      const parsed = await markdown.links(raw);
      const found = parsed ?? fileReferences(raw).map((href) => ({ href, kind: (/\.(png|jpe?g|gif|webp|avif|svg|bmp)([?#]|$)/i.test(href) ? 'image' : 'link') as LinkKind }));
      for (const l of found) {
        const t = resolveHref(l.href, rel);
        if (t && t.path !== rel) links.push({ target: t.path, kind: l.kind, anchor: t.anchor });
      }
    } else if (raw !== null) {
      // Encrypted: only the files it lists in the frontmatter (its attachments), never the hidden text.
      for (const href of listedAttachments(raw) ?? []) {
        const t = resolveHref(href, rel);
        if (t) links.push({ target: t.path, kind: 'image', anchor: null });
      }
    }
    return {
      mountId: mount.id,
      path: rel,
      parent: parentOf(rel),
      name,
      kind: 'file',
      noteId: null,
      fmId: meta?.id ?? null,
      title: meta?.title ?? name.replace(/\.md$/i, ''),
      icon: meta?.icon ?? null,
      readonly: meta?.readonly ?? false,
      tags: meta?.tags ?? [],
      size: st.size,
      mtime: st.mtimeMs,
      hash: data ? sha1(data) : `size:${st.size}:${st.mtimeMs}`,
      text: meta?.text ?? '',
      links,
    };
  }

  private insertFile(e: Entry & { text: string; links?: IndexedLink[] }) {
    const link = this.db.prepare('INSERT INTO links (mount_id, src_path, target, kind, anchor) VALUES (?, ?, ?, ?, ?)');
    for (const l of e.links ?? []) link.run(e.mountId, e.path, l.target, l.kind, l.anchor);
    this.db
      .prepare(
        `INSERT INTO entries (mount_id, path, parent, name, kind, note_id, title, icon, readonly, tags_json, size, mtime, hash)
         VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.mountId, e.path, e.parent, e.name, e.noteId, e.title, e.icon, e.readonly ? 1 : 0, JSON.stringify(e.tags), e.size, e.mtime, e.hash);
    this.db
      .prepare('INSERT INTO entries_fts (title, path, tags, body, mount_id, entry_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.title, e.path, e.tags.join(' '), e.text, e.mountId, e.path);
    this.db.prepare('INSERT INTO entries_tri (title, path, mount_id, entry_path) VALUES (?, ?, ?, ?)').run(e.title, e.path, e.mountId, e.path);
  }

  private deleteFile(mountId: string, path: string) {
    this.db.prepare('DELETE FROM links WHERE mount_id = ? AND src_path = ?').run(mountId, path);
    this.db.prepare("DELETE FROM entries WHERE mount_id = ? AND path = ? AND kind = 'file'").run(mountId, path);
    this.db.prepare('DELETE FROM entries_fts WHERE mount_id = ? AND entry_path = ?').run(mountId, path);
    this.db.prepare('DELETE FROM entries_tri WHERE mount_id = ? AND entry_path = ?').run(mountId, path);
  }

  /** Recomputes folder entries from the indexed files. */
  private syncDirs(mountId: string) {
    const wanted = new Set<string>();
    for (const p of this.filePaths(mountId)) {
      for (let d = parentOf(p); d; d = parentOf(d)) wanted.add(d);
    }
    const existing = new Set(
      (this.db.prepare("SELECT path FROM entries WHERE mount_id = ? AND kind = 'dir'").all(mountId) as { path: string }[]).map((r) => r.path),
    );
    for (const d of existing) {
      if (!wanted.has(d)) {
        this.db.prepare("DELETE FROM entries WHERE mount_id = ? AND path = ? AND kind = 'dir'").run(mountId, d);
        this.db.prepare('DELETE FROM entries_tri WHERE mount_id = ? AND entry_path = ?').run(mountId, d);
      }
    }
    for (const d of wanted) {
      if (existing.has(d)) continue;
      const name = posix.basename(d);
      this.db
        .prepare("INSERT INTO entries (mount_id, path, parent, name, kind, title) VALUES (?, ?, ?, ?, 'dir', ?)")
        .run(mountId, d, parentOf(d), name, name);
      this.db.prepare('INSERT INTO entries_tri (title, path, mount_id, entry_path) VALUES (?, ?, ?, ?)').run(name, d, mountId, d);
    }
  }
}

/** Recursively lists files (mount-relative POSIX paths), skipping dot-folders, VCS folders and symlinks. */
export async function walk(abs: string, rel: string, onFile: (rel: string) => void): Promise<void> {
  const items = await readdir(abs, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (item.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (isIgnoredSegment(item.name)) continue;
      await walk(join(abs, item.name), childRel, onFile);
    } else if (item.isFile()) {
      onFile(childRel);
    }
  }
}
