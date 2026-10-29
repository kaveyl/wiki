// Mount configuration (stored in SQLite) and safe path handling inside a mount.
// SEE-DOC: docs/PLAN.md §2.1, DECISION: AD-002, AD-003

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, normalize, posix, sep } from 'node:path';
import picomatch from 'picomatch';
import { ulid } from 'ulid';
import { now, type DB } from '../db/db.js';

export type MountType = 'remote' | 'local';

export interface MountOptions {
  /** Write ids/icons into frontmatter (AD-002). */
  writeMetadata: boolean;
  /** Whole mount is read-only in the app. */
  readonly: boolean;
  /** Commit (and for remote mounts push) app edits automatically. */
  autoCommit: boolean;
  /** File name that acts as the content of its folder (Trilium "folder is a note"). */
  folderNote: string;
  /**
   * Pause after the last edit before the automatic commit (+ push). Leaving the note or
   * Ctrl+S commits right away; while editing non-stop a commit happens at least every 10 min.
   */
  commitIdleSec: number;
  /** AI memory in `.kaveyl-wiki/ai/` (AD-026); absent = on. */
  aiMemory?: boolean;
  /** Days unused AI chats about this source are kept (0 = keep); absent or -1 = the general rule (AD-034). */
  aiChatDays?: number;
}

export interface Mount {
  id: string;
  name: string;
  type: MountType;
  /** Clone URL (remote) or absolute folder path (local). */
  source: string;
  branch: string | null;
  /** Folder inside the repo/folder that becomes the mount root ('' = everything). */
  subpath: string;
  include: string[];
  exclude: string[];
  icon: string | null;
  position: number;
  options: MountOptions;
  credentialId: string | null;
  /** Connection with the access data (AD-029); null = local folder or public repository. */
  connectionId: string | null;
  paused: boolean;
  createdAt: string;
  syncStatus: string | null;
  syncDetail: string | null;
  syncedAt: string | null;
}

export type MountInput = Pick<Mount, 'name' | 'type' | 'source'> &
  Partial<Pick<Mount, 'branch' | 'subpath' | 'include' | 'exclude' | 'icon' | 'position' | 'credentialId' | 'connectionId' | 'paused'>> & {
    options?: Partial<MountOptions>;
  };

export function defaultOptions(type: MountType): MountOptions {
  return { writeMetadata: true, readonly: false, autoCommit: type === 'remote', folderNote: 'index.md', commitIdleSec: 120 };
}

interface MountRow {
  id: string;
  name: string;
  type: MountType;
  source: string;
  branch: string | null;
  subpath: string;
  include_json: string;
  exclude_json: string;
  icon: string | null;
  position: number;
  options_json: string;
  credential_id: string | null;
  connection_id: string | null;
  paused: number;
  created_at: string;
  sync_status: string | null;
  sync_detail: string | null;
  synced_at: string | null;
}

function fromRow(r: MountRow): Mount {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    source: r.source,
    branch: r.branch,
    subpath: r.subpath,
    include: JSON.parse(r.include_json) as string[],
    exclude: JSON.parse(r.exclude_json) as string[],
    icon: r.icon,
    position: r.position,
    options: { ...defaultOptions(r.type), ...(JSON.parse(r.options_json) as Partial<MountOptions>) },
    credentialId: r.credential_id,
    connectionId: r.connection_id,
    paused: r.paused === 1,
    createdAt: r.created_at,
    syncStatus: r.sync_status,
    syncDetail: r.sync_detail,
    syncedAt: r.synced_at,
  };
}

export class MountStore {
  constructor(private readonly db: DB) {}

  list(): Mount[] {
    return (this.db.prepare('SELECT * FROM mounts ORDER BY position, name').all() as MountRow[]).map(fromRow);
  }

  get(id: string): Mount | null {
    const row = this.db.prepare('SELECT * FROM mounts WHERE id = ?').get(id) as MountRow | undefined;
    return row ? fromRow(row) : null;
  }

  create(input: MountInput): Mount {
    const id = ulid();
    const position =
      input.position ?? ((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM mounts').get() as { p: number }).p);
    this.db
      .prepare(
        `INSERT INTO mounts (id, name, type, source, branch, subpath, include_json, exclude_json, icon, position, options_json, credential_id, connection_id, paused, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.type,
        input.source,
        input.branch ?? null,
        cleanSubpath(input.subpath ?? ''),
        JSON.stringify(input.include?.length ? input.include : ['**']),
        JSON.stringify(input.exclude ?? []),
        input.icon ?? null,
        position,
        JSON.stringify({ ...defaultOptions(input.type), ...input.options }),
        input.credentialId ?? null,
        input.connectionId ?? null,
        input.paused ? 1 : 0,
        now(),
      );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<MountInput>): Mount {
    const current = this.get(id);
    if (!current) throw new Error(`mount ${id} not found`);
    const next = {
      ...current,
      ...patch,
      subpath: patch.subpath !== undefined ? cleanSubpath(patch.subpath) : current.subpath,
      options: { ...current.options, ...patch.options },
    };
    this.db
      .prepare(
        `UPDATE mounts SET name = ?, branch = ?, subpath = ?, include_json = ?, exclude_json = ?, icon = ?, position = ?,
         options_json = ?, credential_id = ?, connection_id = ?, paused = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.branch,
        next.subpath,
        JSON.stringify(next.include.length ? next.include : ['**']),
        JSON.stringify(next.exclude),
        next.icon,
        next.position,
        JSON.stringify(next.options),
        next.credentialId,
        next.connectionId,
        next.paused ? 1 : 0,
        id,
      );
    return this.get(id)!;
  }

  setSyncStatus(id: string, status: string, detail: string | null = null) {
    this.db.prepare('UPDATE mounts SET sync_status = ?, sync_detail = ?, synced_at = ? WHERE id = ?').run(status, detail, now(), id);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM mounts WHERE id = ?').run(id);
  }
}

/** Working directory of a mount's repository (before applying the subpath). */
export function repoDir(mount: Mount, dataPath: string): string {
  if (mount.type === 'local') return normalize(mount.source);
  return join(dataPath, 'repos', repoKey(mount.source, mount.branch));
}

/** Mounts of the same repository and branch share one clone. */
export function repoKey(url: string, branch: string | null): string {
  return createHash('sha256').update(`${url}#${branch ?? ''}`).digest('hex').slice(0, 16);
}

/**
 * Absolute folder that is the root of the mount (repo dir + subpath). Only the repo dir itself may be a link
 * (AD-047); a subpath that leads through one (e.g. replaced by a link in a pull) is refused.
 */
export function contentRoot(mount: Mount, dataPath: string): string {
  if (subpathThroughSymlink(mount, dataPath)) throw new PathError('Pfad nicht erlaubt (symbolischer Link)');
  return mount.subpath ? join(repoDir(mount, dataPath), ...mount.subpath.split('/')) : repoDir(mount, dataPath);
}

/** True when a part of the mount's subpath is a symbolic link – the source then shows nothing. */
export function subpathThroughSymlink(mount: Mount, dataPath: string): boolean {
  return !!mount.subpath && throughSymlink(repoDir(mount, dataPath), mount.subpath);
}

export class PathError extends Error {}

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules']);

/**
 * Validates a mount-relative path ("a/b.md") and returns it normalized (POSIX, no leading
 * slash). Rejects traversal, absolute paths, NUL bytes and VCS/internal folders.
 */
export function cleanRelPath(rel: string): string {
  if (rel.includes('\0')) throw new PathError('Ungültiger Pfad');
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new PathError('Pfad außerhalb der Quelle („..“)');
    if (IGNORED_SEGMENTS.has(p)) throw new PathError('Pfad nicht erlaubt (.git, node_modules)');
  }
  return parts.join('/');
}

export function absPath(mount: Mount, dataPath: string, rel: string): string {
  const clean = cleanRelPath(rel);
  const root = contentRoot(mount, dataPath);
  const abs = clean ? join(root, ...clean.split('/')) : root;
  if (abs !== root && !abs.startsWith(root + sep)) throw new PathError('path outside mount');
  if (clean && throughSymlink(root, clean)) throw new PathError('Pfad nicht erlaubt (symbolischer Link)');
  return abs;
}

/**
 * Symbolic links inside a source are never followed – the tree skips them too (`walk`). A link committed to a
 * Git repo could otherwise point at files of the server (data folder, keys) or anywhere else. Parts of the path
 * that do not exist yet (a new note or folder) are fine.
 */
export function throughSymlink(root: string, clean: string): boolean {
  let p = root;
  for (const part of clean.split('/')) {
    p = join(p, part);
    try {
      if (lstatSync(p).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * `rel` below a folder (fixed paths like the app folder `.kaveyl-wiki` and what lies in it), refused like in
 * `absPath` when a part of it is a symbolic link.
 */
export function noLinkPath(root: string, rel: string): string {
  const clean = cleanRelPath(rel);
  if (clean && throughSymlink(root, clean)) throw new PathError('Pfad nicht erlaubt (symbolischer Link)');
  return clean ? join(root, ...clean.split('/')) : root;
}

function cleanSubpath(subpath: string): string {
  return cleanRelPath(subpath);
}

export function isIgnoredSegment(name: string): boolean {
  return IGNORED_SEGMENTS.has(name) || name.startsWith('.');
}

/** Visibility filter for files inside a mount: Markdown, included and not excluded. */
export function fileFilter(mount: Pick<Mount, 'include' | 'exclude'>): (rel: string) => boolean {
  const inc = picomatch(mount.include.length ? mount.include : ['**'], { dot: false });
  const exc = mount.exclude.length ? picomatch(mount.exclude, { dot: true }) : () => false;
  return (rel) => rel.toLowerCase().endsWith('.md') && inc(rel) && !exc(rel);
}

export const parentOf = (rel: string) => posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
