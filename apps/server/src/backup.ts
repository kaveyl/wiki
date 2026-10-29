// Nightly backup of the app database (users, mounts, encrypted tokens, settings, log).
// `VACUUM INTO` writes a consistent copy even while the WAL is active. Rotation by file
// name: daily copies for 7 days, plus one per ISO week (made on Sundays) for 4 weeks — both
// counts are Löschregeln (cleanup.ts). Other `.db` files in the folder are manual copies (e.g.
// `manuell-vor-migration-v14.db` before a deploy); they go after `backupManualDays`.
// The copies live next to the database (same disk) — no replacement for an off-site
// backup of the host folders; secret.key must be backed up together with them.
// SEE-DOC: DECISIONS.md AD-013

import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from './db/db.js';

export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;

export interface BackupFile {
  name: string;
  kind: 'daily' | 'weekly' | 'manual';
  size: number;
  createdAt: string;
}

const DAILY = /^daily-(\d{4}-\d{2}-\d{2})\.db$/;
const WEEKLY = /^weekly-(\d{4}-W\d{2})\.db$/;
const MANUAL = /^(?!daily-|weekly-)[^/]+\.db$/;

/** ISO 8601 week, e.g. 2026-W40 (weeks start on Monday). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Writes today's daily copy (and on Sundays — or `weekly: true` — the weekly copy), then
 * deletes copies beyond the retention; `manual: true` writes only a copy of its own. Returns the files written.
 */
export async function backupDatabase(db: DB, dir: string, now = new Date(), opts: { weekly?: boolean; manual?: boolean; keepDaily?: number; keepWeekly?: number } = {}): Promise<string[]> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  const write = async (name: string) => {
    const file = join(dir, name);
    await rm(file, { force: true }); // VACUUM INTO refuses to overwrite
    db.prepare('VACUUM INTO ?').run(file);
    await chmod(file, 0o600);
    written.push(name);
  };
  // „Jetzt sichern“: its own copy (kind „von Hand“) – the night's daily copy stays as it is.
  if (opts.manual) {
    await write(`manuell-${localDate(now)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.db`);
    return written;
  }
  await write(`daily-${localDate(now)}.db`);
  if (opts.weekly ?? now.getDay() === 0) await write(`weekly-${isoWeek(now)}.db`);
  await rotate(dir, opts.keepDaily, opts.keepWeekly);
  return written;
}

/** Keeps the newest `keepDaily` daily and `keepWeekly` weekly copies (names sort by date). */
export async function rotate(dir: string, keepDaily = KEEP_DAILY, keepWeekly = KEEP_WEEKLY): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const old = [
    ...names.filter((n) => DAILY.test(n)).sort().reverse().slice(Math.max(1, keepDaily)),
    ...names.filter((n) => WEEKLY.test(n)).sort().reverse().slice(Math.max(0, keepWeekly)),
  ];
  for (const n of old) await rm(join(dir, n), { force: true });
  return old;
}

export async function listBackups(dir: string): Promise<BackupFile[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: BackupFile[] = [];
  for (const name of names) {
    const kind = DAILY.test(name) ? 'daily' : WEEKLY.test(name) ? 'weekly' : MANUAL.test(name) ? 'manual' : null;
    if (!kind) continue;
    const st = await stat(join(dir, name)).catch(() => null);
    if (st) files.push({ name, kind, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Deletes manual copies (`.db` files that are neither daily nor weekly) older than `days`; 0 = never. */
export async function pruneManual(dir: string, days: number, now = Date.now()): Promise<string[]> {
  if (!days) return [];
  const removed: string[] = [];
  for (const b of await listBackups(dir)) {
    if (b.kind === 'manual' && now - Date.parse(b.createdAt) > days * 86_400_000) {
      await rm(join(dir, b.name), { force: true });
      removed.push(b.name);
    }
  }
  return removed;
}
