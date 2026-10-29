// One operations layer for the public REST API v1 and the MCP server (AD-023): every call goes
// through the same ACL checks as the web app (`access()`, AD-020), commits with the caller as
// author and leaves an audit entry for changes. The web app keeps its own /api/* routes; for move, copy and
// delete they call these operations too (via 'app', code-002).
import type { FastifyRequest } from 'fastify';
import { setFrontmatterKeys } from '@kaveyl-wiki/core';
import { atLeast, type Level } from '../acl/acl.js';
import type { Author, SyncResult } from '../git/sync.js';
import type { Entry, Indexer } from '../index/indexer.js';
import { searchFull } from '../index/search.js';
import type { MountManager } from '../mounts/manager.js';
import { cleanRelPath, PathError, type Mount } from '../mounts/model.js';
import { isEncryptedNote } from '../notes/encryption.js';
import { ForbiddenError, type NoteService } from '../notes/service.js';
import type { DB } from '../db/db.js';
import type { AttachmentInfo, StoredAttachment } from '../notes/attachments.js';
import type { Change, ChangeFeed } from '../changes.js';

export interface OpsDeps {
  db: DB;
  manager: MountManager;
  notes: NoteService;
  indexer: Indexer;
  access(req: FastifyRequest, mountId: string, path: string, need: Level, isDir?: boolean): Mount;
  /** access() plus `need` on everything inside a folder (delete, move). */
  accessAll(req: FastifyRequest, mountId: string, path: string, need: Level): Mount;
  canRead(req: FastifyRequest, mountId: string, path: string, isDir?: boolean): boolean;
  levelIn(req: FastifyRequest, mountId: string, path: string, isDir?: boolean): Level;
  mountVisible(req: FastifyRequest, mountId: string): boolean;
  /** Sync detail of a source as far as the user may see it (conflict files, sec-004). */
  syncDetailFor(req: FastifyRequest, m: Mount): string | null;
  /** A sync result as far as the user may see it (file names, sec2-002). */
  syncResultFor(req: FastifyRequest, m: Mount, r: SyncResult | null): SyncResult | null;
  visibleMount(req: FastifyRequest, mountId: string): Mount;
  visibleEntries(req: FastifyRequest, mountId: string): (Entry & { access: Level })[];
  author(req: FastifyRequest): Author;
  audit(req: FastifyRequest, action: string, message: string, mount: Mount): void;
  /** Folder rules (ACL, AI release) follow a moved folder. */
  rulesMoved(mountId: string, from: string, to: string, toMountId?: string): void;
  /** Rules of a move to another source: `before` the first copy, `placed` once indexed, `done` after success (sec2-012…015). */
  rulesAcross(mountId: string, from: string): { before(toMountId: string, to: string): void; placed(): void; done(): void; failed(): Promise<void> };
  /** Stores a file in `assets/` next to a note (same rules as an upload in the app: size setting, blocked types, encryption). */
  attach(req: FastifyRequest, mount: Mount, notePath: string, name: string, data: Buffer, maxBytes: number): Promise<StoredAttachment>;
  /** Local files a note links to (its attachments), with size; missing ones have size null. */
  attachments(mount: Mount, raw: string, notePath: string): Promise<AttachmentInfo[]>;
  /** Every change with the person behind it (AD-066): for agents that react to what people write. */
  changes: ChangeFeed;
  /** Who is typing in a note in the app right now (presence), so a script or an AI can hold back. */
  editingNow(mountId: string, path: string): { id: string; name: string }[];
}

/** Display name of a note: file name without `.md`, a folder note under its folder (AD-022). */
export function noteName(path: string, folderNote = 'index.md'): string {
  const parts = path.split('/').filter(Boolean);
  const base = parts.at(-1) ?? path;
  if (parts.length > 1 && base.toLowerCase() === folderNote.toLowerCase()) return parts.at(-2)!;
  return base.replace(/\.md$/i, '');
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Way in: 'app' = the web app's own routes (audit entry without prefix). */
export type Via = 'app' | 'api' | 'mcp';

/** Largest file one API/MCP call takes (base64 in JSON); the app's own setting may be lower. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** File content from an API/MCP call: base64 (any file) or plain text (SVG, CSV, …) – exactly one of them. */
export function fileContent(base64: unknown, text: unknown): Buffer {
  const b = typeof base64 === 'string' && base64.length ? base64 : null;
  const t = typeof text === 'string' && text.length ? text : null;
  if (!!b === !!t) throw new PathError('Genau eines angeben: content_base64 oder content_text');
  if (t !== null) return Buffer.from(t, 'utf8');
  const clean = b!.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new PathError('content_base64 ist kein gültiges Base64');
  if (clean.length > Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4) throw new PathError('Die Datei ist größer als 10 MB');
  return Buffer.from(clean, 'base64');
}

/** The level a caller can actually use: a token never reaches beyond its scopes. */
function capped(req: FastifyRequest, level: Level): Level {
  const scopes = req.tokenScopes;
  if (!scopes || level === 'none' || level === 'read') return level;
  if (!scopes.includes('write') && !scopes.includes('admin')) return 'read';
  return level === 'admin' && !scopes.includes('admin') ? 'write' : level;
}

/** How long one call may wait for a change (REST and MCP). */
export const MAX_WAIT_SEC = 50;

export function createOps(d: OpsDeps) {
  const done = (req: FastifyRequest, via: Via, action: string, message: string, mount: Mount) =>
    via === 'app' ? d.audit(req, action, message, mount) : d.audit(req, `${via}-${action}`, `${via === 'mcp' ? 'MCP' : 'API'}: ${message}`, mount);

  /** Sync state of the visible sources (or one): last sync, problems, edits still waiting for their commit. */
  const status = async (req: FastifyRequest, sourceId?: string) => {
    const only = sourceId ? d.visibleMount(req, sourceId).id : undefined;
    const mounts = d.manager.list().filter((m) => !m.paused && d.mountVisible(req, m.id) && (!only || m.id === only));
    return Promise.all(
      mounts.map(async (m) => {
        const st = await d.manager.status(m);
        return {
          id: m.id,
          name: m.name,
          type: m.type,
          syncStatus: m.type === 'remote' ? m.syncStatus : null,
          syncDetail: m.type === 'remote' ? d.syncDetailFor(req, m) : null,
          syncedAt: m.type === 'remote' ? m.syncedAt : null,
          autoCommit: m.options.autoCommit,
          commitIdleSec: m.options.commitIdleSec,
          /** App edits not committed yet (they become one Git version after the pause). */
          pendingEdits: st.pending,
          git: st.git,
          canSync: atLeast(capped(req, d.levelIn(req, m.id, '', true)), 'write'),
        };
      }),
    );
  };

  return {
    sources(req: FastifyRequest) {
      return d.manager
        .list()
        .filter((m) => !m.paused && d.mountVisible(req, m.id))
        .map((m) => ({ id: m.id, name: m.name, type: m.type, readonly: !!m.options.readonly, access: capped(req, d.levelIn(req, m.id, '', true)), folderNote: m.options.folderNote }));
    },

    /** Entries below `path` (all levels, or `depth` levels), only what the caller may see. */
    tree(req: FastifyRequest, sourceId: string, path = '', depth?: number) {
      const mount = d.visibleMount(req, sourceId);
      const root = path ? cleanRelPath(path) : '';
      const level = (p: string) => (root ? p.slice(root.length + 1) : p).split('/').length;
      return d
        .visibleEntries(req, mount.id)
        .filter((e) => (!root || e.path.startsWith(root + '/')) && (!depth || level(e.path) <= depth))
        .map((e) => ({ path: e.path, kind: e.kind, name: e.kind === 'dir' ? e.name : noteName(e.path, mount.options.folderNote), title: e.title, tags: e.tags, access: capped(req, e.access), mtime: e.mtime }));
    },

    /** Full-text search with the operators of the search page (`tag:`, `in:`, `"phrase"`, `-word`); optionally in one source. */
    search(req: FastifyRequest, q: string, limit = 20, sourceId?: string) {
      const only = sourceId ? d.visibleMount(req, sourceId).id : undefined;
      const mounts = d.manager
        .list()
        .filter((m) => !m.paused && d.mountVisible(req, m.id) && (!only || m.id === only))
        .map((m) => ({ id: m.id, name: m.name }));
      const max = Math.max(1, Math.min(100, limit));
      const res = searchFull(d.db, q, { limit: 200, mounts });
      const folderNote = (id: string) => d.manager.get(id)?.options.folderNote;
      return res.hits
        .filter((h) => d.canRead(req, h.mountId, h.path))
        .slice(0, max)
        .map((h) => ({
          sourceId: h.mountId,
          path: h.path,
          name: noteName(h.path, folderNote(h.mountId)),
          title: h.title,
          tags: h.tags,
          mtime: h.mtime,
          snippet: h.snippet ? h.snippet.replace(/\u0001/g, '«').replace(/\u0002/g, '»') : undefined,
        }));
    },

    /**
     * Changes after `after` (a cursor from an earlier answer) the caller may read, optionally only in one source or
     * below a path; own changes only with `includeOwn`. With `wait` (seconds) it waits for the first one (long polling).
     * Without `after` it answers at once with the current cursor – the starting point.
     */
    async changes(req: FastifyRequest, q: { source?: string; path?: string; after?: string; wait?: number; includeOwn?: boolean }, signal?: AbortSignal) {
      const only = q.source ? d.visibleMount(req, q.source).id : undefined;
      const prefix = q.path ? cleanRelPath(q.path) : '';
      const me = req.user!.id;
      const keep = (c: Change) =>
        (!only || c.mountId === only) &&
        // The old path of a move counts only when it may be read, too (sec-001).
        (!prefix ||
          c.path === prefix ||
          c.path.startsWith(prefix + '/') ||
          (!!c.from && (c.from === prefix || c.from.startsWith(prefix + '/')) && d.canRead(req, c.mountId, c.from, !/\.md$/i.test(c.from)))) &&
        (q.includeOwn || c.by?.id !== me) &&
        !!d.manager.get(c.mountId) &&
        d.canRead(req, c.mountId, c.path, !/\.md$/i.test(c.path));
      const wait = Math.max(0, Math.min(MAX_WAIT_SEC, Number(q.wait) || 0)) * 1000;
      const page = await d.changes.wait(q.after || undefined, keep, wait, signal);
      return {
        cursor: page.cursor,
        reset: page.reset,
        changes: page.changes.map((c) => ({
          sourceId: c.mountId,
          path: c.path,
          kind: c.kind,
          // The old path only when it may be read, too.
          ...(c.from && d.canRead(req, c.mountId, c.from, !/\.md$/i.test(c.from)) ? { from: c.from } : {}),
          at: c.at,
          by: c.by?.name ?? null,
          byId: c.by?.id ?? null,
          via: c.via,
        })),
      };
    },

    /** A note as Markdown. Encrypted notes: only name/title, never the age block (PLAN §3d). */
    async read(req: FastifyRequest, sourceId: string, path: string) {
      const mount = d.access(req, sourceId, path, 'read', false);
      const note = await d.notes.read(mount, path);
      const encrypted = isEncryptedNote(note.raw);
      return {
        sourceId: mount.id,
        path: note.path,
        name: noteName(note.path, mount.options.folderNote),
        title: note.title,
        hash: note.hash,
        encrypted,
        readonly: note.readonly,
        access: capped(req, d.levelIn(req, mount.id, note.path, false)),
        // People typing in it in the app right now (not the caller): better wait or ask before writing.
        editingNow: d.editingNow(mount.id, note.path).filter((u) => u.id !== req.user?.id).map((u) => u.name),
        markdown: encrypted ? null : note.raw,
      };
    },

    /** Replaces the whole file; `baseHash` from read() guards against overwriting newer changes (409). */
    async write(req: FastifyRequest, via: Via, sourceId: string, path: string, markdown: string, baseHash: string) {
      if (typeof markdown !== 'string') throw new PathError('markdown fehlt');
      if (typeof baseHash !== 'string' || !baseHash) throw new PathError('baseHash fehlt (aus dem Lesen der Notiz)');
      const mount = d.access(req, sourceId, path, 'write', false);
      const res = await d.notes.saveRaw(mount, path, markdown, baseHash, d.author(req));
      if (res.changed) done(req, via, 'note-saved', `Gespeichert: ${cleanRelPath(path)}`, mount);
      return res;
    },

    /** New note below `parent` (file name from the title, unique); optional full Markdown content. */
    async create(req: FastifyRequest, via: Via, sourceId: string, parent: string, title: string, markdown?: string) {
      if (!title.trim()) throw new PathError('Titel fehlt');
      const mount = d.access(req, sourceId, parent, 'write', true);
      // Checked before the note exists – otherwise a refused plaintext would leave an empty note behind.
      if (typeof markdown === 'string' && markdown.trim() && !isEncryptedNote(markdown) && (await d.notes.inEncryptedFolder(mount, parent ? `${cleanRelPath(parent)}/neu.md` : 'neu.md'))) {
        throw new ForbiddenError('Verschlüsselter Ordner: Klartext wird nicht gespeichert');
      }
      const path = await d.notes.create(mount, parent, title, 'file', d.author(req));
      let hash = (await d.notes.read(mount, path)).hash;
      if (typeof markdown === 'string' && markdown.length) {
        const created = await d.notes.read(mount, path);
        const id = created.frontmatter.id;
        const content = typeof id === 'string' && !/^---\n[\s\S]*?\bid:/.test(markdown) ? setFrontmatterKeys(markdown, { id }) : markdown;
        hash = (await d.notes.saveRaw(mount, path, content, created.hash, d.author(req))).hash;
      }
      done(req, via, 'note-created', `Angelegt: ${path}`, mount);
      return { sourceId: mount.id, path, hash };
    },

    /** New folder below `parent`, as in the app: with its folder note (Git keeps no empty folders). */
    async createFolder(req: FastifyRequest, via: Via, sourceId: string, parent: string, name: string) {
      if (!String(name ?? '').trim()) throw new PathError('Name des Ordners fehlt');
      const mount = d.access(req, sourceId, parent, 'write', true);
      const path = await d.notes.create(mount, parent, name, 'dir', d.author(req));
      done(req, via, 'folder-created', `Ordner angelegt: ${path}`, mount);
      return { sourceId: mount.id, path, folderNote: `${path}/${mount.options.folderNote}` };
    },

    status,

    /** Commits waiting edits now and – for Git sources – fetches, rebases and pushes (like „Jetzt abgleichen“). */
    async sync(req: FastifyRequest, sourceId: string) {
      const mount = d.access(req, sourceId, '', 'write', true);
      const result = d.syncResultFor(req, mount, await d.manager.syncNow(mount)); // null for a folder source
      const [after] = await status(req, mount.id);
      return {
        sourceId: mount.id,
        // null for a folder source (nothing to fetch or push); a failed sync shows in status.syncStatus/syncDetail.
        result:
          mount.type !== 'remote' ? null : result ? { status: result.status, incoming: result.incoming.length, pushed: result.pushed, conflictFiles: result.conflict?.files ?? [] } : { status: 'error' },
        status: after,
      };
    },

    /**
     * A file for a note (image, PDF, SVG …) into `assets/` next to it. Returns the link to put into the note – the
     * note itself is not changed. Never overwrites: the same name again gets a number.
     */
    async upload(req: FastifyRequest, via: Via, sourceId: string, notePath: string, name: string, data: Buffer) {
      const mount = d.access(req, sourceId, notePath, 'write', false);
      await d.notes.read(mount, notePath); // unknown note → 404
      const stored = await d.attach(req, mount, notePath, name, data, UPLOAD_MAX_BYTES);
      done(req, via, 'attachment-added', `Anhang: ${stored.path} (${Math.max(1, Math.round(stored.size / 1024))} KB)`, mount);
      const label = stored.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
      return {
        sourceId: mount.id,
        path: stored.path,
        href: stored.href,
        name: stored.name,
        size: stored.size,
        image: stored.image,
        markdown: stored.image ? `![${label}](${stored.href})` : `[${stored.name}](${stored.href})`,
      };
    },

    /** The files a note links to (images, PDFs, drawings …) with their size; size null = the link points nowhere. */
    async attachments(req: FastifyRequest, sourceId: string, notePath: string) {
      const mount = d.access(req, sourceId, notePath, 'read', false);
      const note = await d.notes.read(mount, notePath);
      if (isEncryptedNote(note.raw)) return [];
      return d.attachments(mount, note.raw, note.path);
    },

    /** Renames/moves a note or folder; `toSourceId` moves it into another source. */
    async move(req: FastifyRequest, via: Via, sourceId: string, from: string, to: string, toSourceId?: string) {
      const mount = d.accessAll(req, sourceId, from, 'write');
      if (toSourceId && toSourceId !== mount.id) {
        const target = d.access(req, toSourceId, parentOf(to), 'write', true);
        // Rules follow – also of a folder whose name ends in „.md“ (sec2-010) – before the old place is cleared (sec2-014).
        const rules = d.rulesAcross(mount.id, cleanRelPath(from));
        const moved = await d.notes
          .moveAcross(mount, target, from, to, d.author(req), (ref) => d.canRead(req, mount.id, ref), {
            before: (path) => rules.before(target.id, path),
            placed: () => rules.placed(),
          })
          .catch(async (e: unknown) => {
            await rules.failed();
            throw e;
          });
        rules.done();
        done(req, via, 'moved-across', `Verschoben: ${mount.name}/${from} → ${target.name}/${moved.path}`, mount);
        return { sourceId: target.id, ...moved };
      }
      d.access(req, mount.id, parentOf(to), 'write', true);
      const path = await d.notes.move(mount, from, to, d.author(req), (ref) => d.canRead(req, mount.id, ref));
      d.rulesMoved(mount.id, cleanRelPath(from), path);
      done(req, via, 'moved', `Verschoben: ${from} → ${path}`, mount);
      return { sourceId: mount.id, path, warnings: [] as string[] };
    },

    async copy(req: FastifyRequest, via: Via, sourceId: string, from: string, toParent: string, toSourceId?: string) {
      const mount = d.access(req, sourceId, from, 'read');
      const target = d.access(req, toSourceId || mount.id, toParent, 'write', true);
      const res = await d.notes.copy(mount, target, from, toParent, d.author(req), (rel) => d.canRead(req, mount.id, rel));
      done(req, via, 'copied', `Kopiert: ${mount.name}/${from} → ${target.name}/${res.path}`, target);
      return { sourceId: target.id, ...res };
    },

    async remove(req: FastifyRequest, via: Via, sourceId: string, path: string) {
      const mount = d.accessAll(req, sourceId, path, 'write');
      await d.notes.delete(mount, path, d.author(req));
      done(req, via, 'note-deleted', `Gelöscht: ${path}`, mount);
      return { ok: true };
    },

    async backlinks(req: FastifyRequest, sourceId: string, path: string) {
      const mount = d.access(req, sourceId, path, 'read', false);
      await d.notes.read(mount, path); // an unknown note is 404, not an empty list
      return d.indexer
        .backlinks(mount, cleanRelPath(path))
        .filter((b) => d.canRead(req, mount.id, b.path))
        .map((b) => ({ ...b, name: noteName(b.path, mount.options.folderNote) }));
    },

    async history(req: FastifyRequest, sourceId: string, path: string) {
      const mount = d.access(req, sourceId, path, 'read');
      return d.notes.history(mount, path);
    },

    /** The Markdown of an older version (commit + path from history()). */
    async version(req: FastifyRequest, sourceId: string, path: string, commit: string) {
      const mount = d.access(req, sourceId, path, 'read', false);
      const raw = await d.notes.version(mount, commit, path);
      return { sourceId: mount.id, path, commit, markdown: isEncryptedNote(raw) ? null : raw };
    },
  };
}

export type Ops = ReturnType<typeof createOps>;
