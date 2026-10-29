// Event log of the app: sync results, errors, security-relevant actions and system jobs.
// Stored in SQLite with per-category retention. Content changes are NOT logged here — git
// history already records them. Nothing secret ever goes in: details pass through
// sanitize(), and callers only log names/counts, never passwords, tokens, cookies,
// request bodies or note content. SEE-DOC: DECISIONS.md AD-013

import type { DB } from './db/db.js';

/** API tokens (also of the old app) and keys of Git hosts and AI providers, cut down in log texts. */
const SECRET_PREFIXES = new RegExp(`\\b(kw_|ghp_|gho_|glpat-|sk-)[A-Za-z0-9_-]{8,}`, 'g');

export type Category = 'sync' | 'error' | 'audit' | 'system';
export type Level = 'info' | 'warn' | 'error';

export interface ActivityInput {
  category: Category;
  level?: Level;
  action: string;
  message: string;
  mount?: { id: string; name: string } | null;
  actor?: string | null;
  detail?: Record<string, unknown>;
}

export interface ActivityEntry {
  id: number;
  at: string;
  category: Category;
  level: Level;
  mountId: string | null;
  mountName: string | null;
  actor: string | null;
  action: string;
  message: string;
  detail: Record<string, unknown> | null;
}

export interface ActivityFilter {
  mountId?: string;
  category?: Category;
  /** Only warnings and errors. */
  problems?: boolean;
  /** Paging: entries with an id below this. */
  before?: number;
  limit?: number;
  /** Security entries are for admins only. */
  includeAudit?: boolean;
  /** Only entries by one person (any of their names: user name in the log, display name in commits). */
  actors?: string[];
}

export interface Retention {
  /** Normal entries (info). */
  infoDays: number;
  /** Warnings and errors. */
  problemDays: number;
  /** Security entries (audit), any level. */
  auditDays: number;
}

export const DEFAULT_RETENTION: Retention = { infoDays: 30, problemDays: 90, auditDays: 365 };

const SECRET_KEY = /pass|token|secret|cookie|authori|credential|key|session|hash/i;
const MAX_STRING = 500;
const MAX_LIST = 50;

/** Removes anything that could be a secret and bounds sizes (defense in depth). */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactInline(value).slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.slice(0, MAX_LIST).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

/** Masks credentials that may hide inside free text (URLs with user:pass@, auth headers, tokens). */
export function redactInline(text: string): string {
  return text
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@')
    .replace(/(authorization:\s*)(token|bearer|basic)\s+\S+/gi, '$1$2 ***')
    .replace(SECRET_PREFIXES, '$1***');
}

/** Actions whose message itself names note paths (conflict list, commit message, restored path). */
const PATHS_IN_MESSAGE = new Set(['committed', 'conflict', 'conflict-resolved', 'backup-restore']);
/** Detail keys that list note paths. */
const PATH_LISTS = ['paths', 'files', 'renamed', 'incoming'];

/**
 * An entry as a user without full read access to its source may see it (AD-020, audit sec-004). The note paths it
 * names are in `detail.paths` (mount-relative); without that list, or when sanitize() may have cut it, they are
 * unknown and count as unreadable. All readable → unchanged. Otherwise path lists in the details are dropped, and an
 * entry whose message names paths is left out entirely – its text cannot be shortened safely.
 */
export function entryFor(e: ActivityEntry, mayRead: (path: string) => boolean): ActivityEntry | null {
  const list = e.detail?.paths;
  const known =
    Array.isArray(list) && list.length < MAX_LIST && list.every((p): p is string => typeof p === 'string' && p.length < MAX_STRING) ? list : null;
  if (known?.every(mayRead)) return e;
  if (PATHS_IN_MESSAGE.has(e.action)) return null;
  if (!e.detail) return e;
  const detail = Object.fromEntries(Object.entries(e.detail).filter(([k]) => !PATH_LISTS.includes(k)));
  return { ...e, detail: Object.keys(detail).length ? detail : null };
}

/** General text per error action for users without admin rights (sec-004). */
const ERROR_TEXT: Record<string, string> = {
  'sync-failed': 'Abgleich fehlgeschlagen – Details sehen Administratoren im Protokoll',
  index: 'Index-Aktualisierung fehlgeschlagen – Details sehen Administratoren im Protokoll',
  'link-repair': 'Link-Reparatur fehlgeschlagen – Details sehen Administratoren im Protokoll',
  watcher: 'Dateiüberwachung unterbrochen – wird neu gestartet und abgeglichen',
  'backup-failed': 'Backup fehlgeschlagen – Details sehen Administratoren im Protokoll',
};
export const ERROR_HIDDEN = 'Fehler – Details sehen Administratoren im Protokoll';

/** Text of a failed sync (`syncDetail`) for users without admin rights (sec-004). */
export const SYNC_ERROR_HIDDEN = ERROR_TEXT['sync-failed']!;

/**
 * An error entry as a user without admin rights sees it (sec-004): raw git and file system messages can name paths
 * from closed folders and of the server – only a general text, no details. Other entries stay unchanged.
 */
export function errorFor(e: ActivityEntry): ActivityEntry {
  if (e.category !== 'error') return e;
  return { ...e, message: ERROR_TEXT[e.action] ?? ERROR_HIDDEN, detail: null };
}

/** System entries of a source whose message names server paths: their general text (audit sec2-004). */
const SYSTEM_TEXT: Record<string, string> = {
  'stale-clone': 'Alter lokaler Clone beiseitegelegt (neu geklont)',
};

/**
 * A system entry as a user without admin rights sees it (audit sec2-004): general ones (housekeeping, database backups,
 * orphaned clones – file names and server paths) not at all, those of a source with a general text where the message
 * names server paths. Other entries stay unchanged.
 */
export function systemFor(e: ActivityEntry): ActivityEntry | null {
  if (e.category !== 'system') return e;
  if (!e.mountId) return null;
  const text = SYSTEM_TEXT[e.action];
  return text ? { ...e, message: text, detail: null } : e;
}

export class ActivityLog {
  private readonly listeners: ((e: ActivityInput) => void)[] = [];

  constructor(private readonly db: DB) {}

  /** Called after every entry (notifications, AD-035); a failing listener never breaks logging. */
  onLog(fn: (e: ActivityInput) => void): void {
    this.listeners.push(fn);
  }

  log(e: ActivityInput): void {
    const detail = e.detail ? (sanitize(e.detail) as Record<string, unknown>) : null;
    this.db
      .prepare(
        `INSERT INTO activity (at, category, level, mount_id, mount_name, actor, action, message, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        e.category,
        e.level ?? (e.category === 'error' ? 'error' : 'info'),
        e.mount?.id ?? null,
        e.mount?.name ?? null,
        e.actor ?? null,
        e.action,
        redactInline(e.message).slice(0, MAX_STRING),
        detail && Object.keys(detail).length ? JSON.stringify(detail) : null,
      );
    // Listeners see what was stored: message redacted, detail sanitized.
    const stored: ActivityInput = { ...e, message: redactInline(e.message).slice(0, MAX_STRING), detail: detail ?? undefined };
    for (const fn of this.listeners) {
      try {
        fn(stored);
      } catch {
        /* a notification problem must not break logging */
      }
    }
  }

  list(f: ActivityFilter = {}): ActivityEntry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.mountId) where.push('mount_id = ?'), args.push(f.mountId);
    if (f.category) where.push('category = ?'), args.push(f.category);
    if (f.problems) where.push("level != 'info'");
    if (f.before) where.push('id < ?'), args.push(f.before);
    if (!f.includeAudit) where.push("category != 'audit'");
    if (f.actors?.length) where.push(`actor IN (${f.actors.map(() => '?').join(', ')})`), args.push(...f.actors);
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as {
      id: number;
      at: string;
      category: Category;
      level: Level;
      mount_id: string | null;
      mount_name: string | null;
      actor: string | null;
      action: string;
      message: string;
      detail_json: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      category: r.category,
      level: r.level,
      mountId: r.mount_id,
      mountName: r.mount_name,
      actor: r.actor,
      action: r.action,
      message: r.message,
      detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
    }));
  }

  /** Deletes entries older than their retention. Returns the number removed. */
  prune(r: Retention, now = Date.now()): number {
    const cutoff = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const a = this.db.prepare("DELETE FROM activity WHERE category = 'audit' AND at < ?").run(cutoff(r.auditDays)).changes;
    const p = this.db.prepare("DELETE FROM activity WHERE category != 'audit' AND level != 'info' AND at < ?").run(cutoff(r.problemDays)).changes;
    const i = this.db.prepare("DELETE FROM activity WHERE category != 'audit' AND level = 'info' AND at < ?").run(cutoff(r.infoDays)).changes;
    return a + p + i;
  }
}
