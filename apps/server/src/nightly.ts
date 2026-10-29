// Nightly maintenance (AD-013, AD-034, AD-035): consistency check, Löschregeln, database backup, disk space – at 03:00
// and on demand (routes/cleanup.ts). Moved out of buildApp (code-001): built before AppContext, so the route modules get
// these functions directly.
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ActivityInput, ActivityLog, Retention } from './activity.js';
import type { AccountMail } from './auth/accountmail.js';
import type { AuthService } from './auth/auth.js';
import { backupDatabase, pruneManual } from './backup.js';
import type { BackupService } from './backups/service.js';
import { compactDb, lowDisk, pruneOrphanClones, pruneTempDirs, readRules, type Rules } from './cleanup.js';
import type { Config } from './config.js';
import type { DB } from './db/db.js';
import { fsck } from './index/fsck.js';
import type { Indexer } from './index/indexer.js';
import type { ConnectionStore } from './mounts/connections.js';
import type { MountManager } from './mounts/manager.js';
import { repoDir } from './mounts/model.js';
import type { RepoTrash } from './mounts/repo-trash.js';
import type { NoteService } from './notes/service.js';
import type { Notifier } from './notify/notifier.js';
import type { Settings } from './settings.js';

export interface MaintenanceDeps {
  config: Pick<Config, 'dataPath' | 'configPath'>;
  db: DB;
  settings: Settings;
  manager: MountManager;
  indexer: Indexer;
  activity: ActivityLog;
  auth: AuthService;
  accountMail: AccountMail;
  notes: NoteService;
  repoTrash: RepoTrash;
  backups: BackupService;
  notifier: Notifier;
  /** Database backups (nightly, manual) and the clones of remote sources. */
  backupDir: string;
  reposDir: string;
  record(e: ActivityInput): void;
  log: FastifyBaseLogger;
  /** Hoster access for deleting a repository from the repository trash. */
  repoAccess(connectionId?: string | null): ReturnType<ConnectionStore['hostAccess']>;
  /** Deletes AI chats unused for longer than `days` (ai/assistant.ts). */
  pruneAiChats(days: number): number;
}

export type Maintenance = ReturnType<typeof createMaintenance>;

export function createMaintenance(d: MaintenanceDeps) {
  const { config, db, settings, manager, indexer, activity, auth, accountMail, notes, repoTrash, backups, notifier, backupDir, reposDir, record } = d;
  // Consistency check (read-only report): on demand by an admin and every night at 03:00.
  const runFsck = async () => {
    const report = await fsck(manager.list(), indexer, config.dataPath);
    settings.set('fsck_report', JSON.stringify(report));
    const found = report.mounts.reduce((n, m) => n + m.issues.length, 0);
    record({ category: 'system', level: found ? 'warn' : 'info', action: 'fsck', message: found ? `Prüfung: ${found} Auffälligkeit${found === 1 ? '' : 'en'}` : 'Prüfung: keine Probleme' });
    return report;
  };
  const rules = (): Rules => readRules(settings);
  const runBackup = async (opts: { weekly?: boolean; manual?: boolean } = {}) => {
    const r = rules();
    const written = await backupDatabase(db, backupDir, new Date(), { ...opts, keepDaily: r.backupDaily, keepWeekly: r.backupWeekly });
    record({ category: 'system', action: 'backup', message: `Datenbank gesichert: ${written.join(', ')}` });
    return written;
  };
  /** Days a deleted note stays in the trash (0 = forever). */
  const trashDays = () => rules().trashDays;
  const retention = (): Retention => {
    const r = rules();
    return { infoDays: r.logInfoDays, problemDays: r.logProblemDays, auditDays: r.logAuditDays };
  };
  const bundleDir = join(config.configPath, 'backups', 'repos');
  /** Clones that sources use; everything else under data/repos is left behind (AD-034). */
  const usedClones = () => new Set(manager.list().filter((m) => m.type === 'remote').map((m) => repoDir(m, config.dataPath)));
  /**
   * Applies every Löschregel once (nightly, or „Jetzt aufräumen“): each step on its own, so
   * one failure does not stop the others. Returns what each step removed.
   */
  const runCleanup = async (step: (name: string, fn: () => Promise<unknown> | unknown) => Promise<void>) => {
    const done: Record<string, number> = {};
    const r = rules();
    await step('retention', () => {
      const removed = activity.prune(retention());
      done.log = removed;
      if (removed) record({ category: 'system', action: 'prune', message: `${removed} alte Protokolleinträge gelöscht` });
    });
    await step('sessions', () => {
      auth.purgeExpired();
      accountMail.purgeExpired();
    });
    await step('note-trash', async () => {
      done.trash = 0;
      if (!r.trashDays) return;
      const cutoff = new Date(Date.now() - r.trashDays * 86_400_000);
      for (const m of manager.list().filter((m) => !m.paused)) {
        const n = await notes.purgeTrash(m, cutoff);
        done.trash += n;
        if (n) record({ category: 'system', action: 'trash-prune', mount: { id: m.id, name: m.name }, message: `${n} Papierkorb-Eintrag/Einträge in „${m.name}“ nach ${r.trashDays} Tagen endgültig gelöscht` });
      }
    });
    await step('ai-chats', () => {
      const n = d.pruneAiChats(r.aiChatDays);
      done.aiChats = n;
      if (n) record({ category: 'system', action: 'ai-chats-prune', message: `${n} unbenutzte KI-Chat(s) gelöscht` });
    });
    await step('repo-trash', async () => {
      done.repos = 0;
      for (const t of repoTrash.due()) {
        const bundle = await repoTrash.deleteNow(d.repoAccess(t.connectionId), t.fullName);
        done.repos++;
        record({ category: 'audit', level: 'warn', action: 'repo-deleted', actor: 'Kaveyl Wiki', message: `Repository ${t.fullName} nach ${r.repoTrashDays} Tagen im Papierkorb endgültig gelöscht (Sicherung: ${bundle})` });
      }
    });
    await step('orphan-clones', async () => {
      const res = await pruneOrphanClones(reposDir, usedClones(), r.orphanCloneDays, bundleDir);
      done.clones = res.removed.length;
      for (const c of res.removed) record({ category: 'system', action: 'clone-prune', message: `Verwaiste lokale Kopie ${c.name} gelöscht (Sicherung: ${c.bundle ?? 'nichts zu sichern'})` });
      for (const c of res.skipped) record({ category: 'system', level: 'warn', action: 'clone-prune', message: `Verwaiste lokale Kopie ${c.name} nicht gelöscht: ${c.reason}` });
    });
    await step('bundles', async () => {
      const old = await repoTrash.pruneBundles();
      done.bundles = old.length;
      if (old.length) record({ category: 'system', action: 'bundle-prune', message: `${old.length} alte Repository-Sicherung(en) gelöscht` });
    });
    await step('backups', async () => {
      const old = await pruneManual(backupDir, r.backupManualDays);
      done.manualBackups = old.length;
      if (old.length) record({ category: 'system', action: 'backup-prune', message: `${old.length} manuelle Datenbank-Sicherung(en) gelöscht: ${old.join(', ')}` });
    });
    await step('backup-runs', () => {
      const n = backups.pruneRuns(r.backupRunDays);
      done.backupRuns = n;
      if (n) record({ category: 'system', action: 'backup-runs-prune', message: `${n} alte Einträge im Backup-Verlauf gelöscht` });
    });
    await step('temp', async () => {
      done.temp = await pruneTempDirs();
    });
    await step('compact', () => {
      const freed = compactDb(db);
      done.compacted = freed;
      if (freed) record({ category: 'system', action: 'db-compact', message: `Datenbank verkleinert (${Math.round(freed / 1024)} KB frei gegeben)` });
    });
    return done;
  };
  /** Nightly: consistency check, log retention, database backup, expired sessions — each on its own. */
  const nightly = async () => {
    const problems: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
      try {
        await fn();
      } catch (e) {
        d.log.warn({ err: e }, `nightly ${name} failed`);
        const message = `Nächtliche Wartung (${name}) fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
        record({ category: 'error', action: `nightly-${name}`, message });
        problems.push(message);
      }
    };
    await step('fsck', async () => {
      const report = await runFsck();
      // Only what is new since the last night is reported, with source and note – a finding that stays is
      // not repeated every night; one that is fixed and comes back counts as new again.
      const now = report.mounts.flatMap((m) =>
        m.issues.map((i) => ({ key: `${m.mountId}|${i.kind}|${i.path}|${i.detail}`, line: `${m.name}${i.path ? ` / ${i.path}` : ''}: ${i.detail}` })),
      );
      const seen = new Set<string>((() => {
        try {
          return JSON.parse(settings.get('fsck_notified') ?? '[]') as string[];
        } catch {
          return [];
        }
      })());
      const fresh = now.filter((x) => !seen.has(x.key));
      settings.set('fsck_notified', JSON.stringify(now.map((x) => x.key)));
      if (fresh.length) {
        const shown = fresh.slice(0, 10).map((x) => `  – ${x.line}`);
        if (fresh.length > shown.length) shown.push(`  – … und ${fresh.length - shown.length} weitere`);
        problems.push(`Die Prüfung hat ${fresh.length === 1 ? 'eine neue Auffälligkeit' : `${fresh.length} neue Auffälligkeiten`} gefunden (Einstellungen → Werkzeuge → Prüfung):\n${shown.join('\n')}`);
      }
    });
    // Clean up first, so the backup is taken of the smaller database.
    await runCleanup(step);
    await step('backup', () => runBackup());
    await step('disk', async () => {
      for (const [label, path] of [['Daten (/data)', config.dataPath], ['Konfiguration (/config)', config.configPath]] as const) {
        const low = await lowDisk(path);
        if (low) problems.push(`Wenig Speicherplatz für ${label}: noch ${low}.`);
      }
    });
    // One message per night, and only when something needs attention (AD-035).
    if (problems.length)
      await notifier.send({ event: 'nightly', title: `Nachtlauf: ${problems.length === 1 ? 'ein Problem' : `${problems.length} Probleme`}`, text: problems.map((p) => `• ${p}`).join('\n') });
  };
  let fsckTimer: NodeJS.Timeout | undefined;
  /** The nightly run every day at 03:00 (container time, TZ). */
  const schedule = () => {
    const next = new Date();
    next.setHours(3, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    fsckTimer = setTimeout(() => void nightly().finally(schedule), next.getTime() - Date.now());
    fsckTimer.unref();
  };
  const stop = () => clearTimeout(fsckTimer);
  return { runFsck, rules, runBackup, trashDays, retention, usedClones, runCleanup, nightly, schedule, stop };
}
