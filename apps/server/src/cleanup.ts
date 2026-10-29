// Löschregeln (owner 2026-10-11): everything that keeps growing inside the container gets a
// rule with a default, editable in Einstellungen → Werkzeuge → Aufräumen and next to what it concerns
// (Protokoll, Papierkorb, KI, Quellen). The nightly job (3 Uhr) and „Jetzt aufräumen“ apply
// them: event log, note trash, AI chats (per source overridable), repository trash and its
// bundles, database backups (also manual copies), the backup run history (AD-038), clones left behind by removed sources,
// stray temp folders — and the database file is compacted when much of it is free.
// Rules are plain settings rows; 0 = „nie“ where a rule allows it. SEE-DOC: DECISIONS.md AD-034

import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db/db.js';
import { git } from './git/git.js';

export type RuleKey =
  | 'logInfoDays'
  | 'logProblemDays'
  | 'logAuditDays'
  | 'trashDays'
  | 'aiChatDays'
  | 'repoTrashDays'
  | 'repoBundleDays'
  | 'backupDaily'
  | 'backupWeekly'
  | 'backupManualDays'
  | 'backupRunDays'
  | 'orphanCloneDays';

export interface RuleDef {
  /** Row in `settings` (the older keys are kept, so earlier values stay in force). */
  setting: string;
  def: number;
  min: number;
  max: number;
  unit: 'days' | 'count';
}

export const RULES: Record<RuleKey, RuleDef> = {
  logInfoDays: { setting: 'retention_info_days', def: 30, min: 1, max: 3650, unit: 'days' },
  logProblemDays: { setting: 'retention_problem_days', def: 90, min: 1, max: 3650, unit: 'days' },
  logAuditDays: { setting: 'retention_audit_days', def: 365, min: 1, max: 3650, unit: 'days' },
  trashDays: { setting: 'trash_days', def: 30, min: 0, max: 3650, unit: 'days' },
  aiChatDays: { setting: 'ai_chat_retention_days', def: 90, min: 0, max: 3650, unit: 'days' },
  repoTrashDays: { setting: 'repo_trash_days', def: 30, min: 0, max: 3650, unit: 'days' },
  repoBundleDays: { setting: 'repo_bundle_days', def: 30, min: 0, max: 3650, unit: 'days' },
  backupDaily: { setting: 'backup_keep_daily', def: 7, min: 1, max: 90, unit: 'count' },
  backupWeekly: { setting: 'backup_keep_weekly', def: 4, min: 0, max: 104, unit: 'count' },
  backupManualDays: { setting: 'backup_manual_days', def: 90, min: 0, max: 3650, unit: 'days' },
  backupRunDays: { setting: 'backup_run_days', def: 180, min: 0, max: 3650, unit: 'days' },
  orphanCloneDays: { setting: 'orphan_clone_days', def: 30, min: 0, max: 3650, unit: 'days' },
};

export type Rules = Record<RuleKey, number>;

export interface SettingsLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const DEFAULT_RULES = Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, r.def])) as Rules;

/** A stored value, or the default when missing or invalid (also below a rule's minimum). */
export function readRules(settings: SettingsLike): Rules {
  const out = { ...DEFAULT_RULES };
  for (const [k, r] of Object.entries(RULES) as [RuleKey, RuleDef][]) {
    const raw = settings.get(r.setting);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= r.min && n <= r.max) out[k] = Math.round(n);
  }
  return out;
}

/** Saves the given rules, clamped to their range; unknown keys and non-numbers are ignored. */
export function writeRules(settings: SettingsLike, patch: Partial<Record<string, unknown>>): Rules {
  for (const [k, r] of Object.entries(RULES) as [RuleKey, RuleDef][]) {
    const v = patch[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    settings.set(r.setting, String(Math.min(r.max, Math.max(r.min, Math.round(n)))));
  }
  return readRules(settings);
}

const DAY = 86_400_000;

// ── Clones left behind ─────────────────────────────────────────────────────────────────

/**
 * Folders under data/repos that no source uses anymore: clones of removed sources and the
 * `.alt-…` copies set aside when a repository was mounted again (manager.setAsideOrphanedClone).
 * Nobody reuses them, so after `days` since Kaveyl Wiki first saw them orphaned they are saved as a
 * git bundle (with any uncommitted files committed first) and removed. The first sighting is
 * stored in a marker file inside the clone; a folder in use again loses its marker.
 */
export const ORPHAN_MARK = 'kaveyl-wiki-orphaned-since';

export interface OrphanClone {
  name: string;
  size: number;
  since: string;
}

async function markerPath(dir: string): Promise<string> {
  const inGit = (await stat(join(dir, '.git')).catch(() => null))?.isDirectory();
  const at = (name: string) => (inGit ? join(dir, '.git', name) : join(dir, `.${name}`));
  return at(ORPHAN_MARK);
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

/** Orphaned clones with the date they were first seen (marking new ones now). */
export async function scanOrphanClones(reposDir: string, used: Set<string>, now = new Date(), withSize = false): Promise<OrphanClone[]> {
  const out: OrphanClone[] = [];
  for (const e of await readdir(reposDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const dir = join(reposDir, e.name);
    const mark = await markerPath(dir);
    if (used.has(dir)) {
      await rm(mark, { force: true });
      continue;
    }
    let since = (await readFile(mark, 'utf8').catch(() => '')).trim();
    if (!since || Number.isNaN(Date.parse(since))) {
      since = now.toISOString();
      await writeFile(mark, `${since}\n`).catch(() => undefined);
    }
    out.push({ name: e.name, since, size: withSize ? await folderSize(dir) : 0 });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

const BOT = { GIT_AUTHOR_NAME: 'Kaveyl Wiki', GIT_AUTHOR_EMAIL: 'kaveyl-wiki@localhost', GIT_COMMITTER_NAME: 'Kaveyl Wiki', GIT_COMMITTER_EMAIL: 'kaveyl-wiki@localhost' };

/**
 * Removes orphaned clones older than `days` (0 = never). Each is saved first as
 * `<bundleDir>/clone__<name>-<date>.bundle` (kept like other repository backups).
 */
export async function pruneOrphanClones(
  reposDir: string,
  used: Set<string>,
  days: number,
  bundleDir: string,
  now = new Date(),
): Promise<{ removed: { name: string; bundle: string | null }[]; skipped: { name: string; reason: string }[] }> {
  const removed: { name: string; bundle: string | null }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const orphans = await scanOrphanClones(reposDir, used, now);
  if (!days) return { removed, skipped };
  for (const o of orphans) {
    if (now.getTime() - Date.parse(o.since) < days * DAY) continue;
    const dir = join(reposDir, o.name);
    const isGit = (await stat(join(dir, '.git')).catch(() => null))?.isDirectory();
    if (!isGit) {
      skipped.push({ name: o.name, reason: 'kein Git-Repository – bitte von Hand prüfen' });
      continue;
    }
    try {
      // Nothing may get lost: uncommitted files become a commit inside the bundle.
      if ((await git(dir, ['status', '--porcelain'])).trim()) {
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '-q', '--no-verify', '-m', 'Kaveyl Wiki: Stand vor dem Aufräumen'], { env: BOT });
      }
      let bundle: string | null = null;
      if ((await git(dir, ['for-each-ref', '--count=1'])).trim()) {
        await mkdir(bundleDir, { recursive: true, mode: 0o700 });
        bundle = `clone__${o.name}-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.bundle`;
        await git(dir, ['bundle', 'create', join(bundleDir, bundle), '--all']);
        await chmod(join(bundleDir, bundle), 0o600);
      }
      await rm(dir, { recursive: true, force: true });
      removed.push({ name: o.name, bundle });
    } catch (e) {
      skipped.push({ name: o.name, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return { removed, skipped };
}

// ── Database file ──────────────────────────────────────────────────────────────────────

export interface DbUsage {
  size: number;
  free: number;
}

export function dbUsage(db: DB): DbUsage {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const pages = db.pragma('page_count', { simple: true }) as number;
  const free = db.pragma('freelist_count', { simple: true }) as number;
  return { size: pages * pageSize, free: free * pageSize };
}

/**
 * Deleted rows leave free pages behind; the file never shrinks by itself. When at least a
 * quarter (and 1 MB) is free, VACUUM rewrites it. Returns the bytes given back.
 */
export function compactDb(db: DB, force = false): number {
  const before = dbUsage(db);
  if (!force && (before.free < 1024 * 1024 || before.free < before.size / 4)) return 0;
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return Math.max(0, before.size - dbUsage(db).size);
}

// ── Temp folders ───────────────────────────────────────────────────────────────────────

/** Kaveyl Wiki's own temp folders (`kaveyl-wiki-*`) older than a day: left over by a crash. */
export async function pruneTempDirs(now = Date.now(), dir = tmpdir()): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !e.name.startsWith('kaveyl-wiki-')) continue;
    const st = await stat(join(dir, e.name)).catch(() => null);
    if (st && now - st.mtimeMs > DAY) {
      await rm(join(dir, e.name), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

/** Size of a folder via `du` when available (fast), else by walking it. */
export function folderSize(dir: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', dir], (err, stdout) => {
      const kb = Number(String(stdout).split(/\s/)[0]);
      if (err || !Number.isFinite(kb)) void dirSize(dir).then(resolve);
      else resolve(kb * 1024);
    });
  });
}

/**
 * Free space of the file system holding `path`, as text — or null while there is enough
 * (at least 1 GB and 5 %). The nightly run reports it (AD-035).
 */
export async function lowDisk(path: string, minBytes = 1024 ** 3, minShare = 0.05): Promise<string | null> {
  const s = await statfs(path);
  const free = s.bavail * s.bsize;
  const total = s.blocks * s.bsize;
  if (free >= minBytes && (!total || free / total >= minShare)) return null;
  const gb = free / 1024 ** 3;
  return `${gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(free / 1024 ** 2)} MB`}${total ? ` (${Math.round((free / total) * 100)} %)` : ''}`;
}
