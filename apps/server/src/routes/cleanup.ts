// Löschregeln (AD-034) for admins: all rules, what they currently hold, „Jetzt aufräumen“, database backups,
// consistency check, orphan clones. Moved out of buildApp (code-002); the nightly run itself is in nightly.ts.
import type { FastifyInstance } from 'fastify';
import { type FsckReport } from '../index/fsck.js';
import { listBackups } from '../backup.js';
import { dbUsage, folderSize, RULES, scanOrphanClones, writeRules, type Rules } from '../cleanup.js';
import type { AppContext } from './context.js';

export function registerCleanupRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, backupDir, db, manager, notes, record, repoTrash, reposDir, requireAdmin, rules, runBackup, runCleanup, runFsck, settings, usedClones } = ctx;
  // ── Löschregeln (AD-034): all rules, what they currently hold, and „Jetzt aufräumen“ ────
  server.get('/api/admin/cleanup', async (req) => {
    requireAdmin(req);
    const backups = await listBackups(backupDir);
    const sum = (k: string) => backups.filter((b) => b.kind === k).reduce((a, b) => ({ count: a.count + 1, size: a.size + b.size }), { count: 0, size: 0 });
    const bundles = await repoTrash.bundles();
    const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const trash = await Promise.all(
      manager
        .list()
        .filter((m) => !m.paused)
        .map(async (m) => ({ mountId: m.id, name: m.name, ...(await notes.folderTrashUsage(m)), mode: await notes.trashMode(m), aiChatDays: m.options.aiChatDays ?? -1 })),
    );
    return {
      rules: rules(),
      limits: RULES,
      usage: {
        log: { count: count('SELECT count(*) n FROM activity'), oldest: (db.prepare('SELECT min(at) a FROM activity').get() as { a: string | null }).a },
        trash,
        aiChats: { count: count('SELECT count(*) n FROM ai_chats'), messages: count('SELECT count(*) n FROM ai_messages') },
        repoTrash: { count: repoTrash.list().length },
        bundles: { count: bundles.length, size: bundles.reduce((a, b) => a + b.size, 0) },
        backups: { daily: sum('daily'), weekly: sum('weekly'), manual: sum('manual') },
        backupRuns: { count: count('SELECT count(*) n FROM backup_runs') },
        clones: { used: usedClones().size, orphans: await scanOrphanClones(reposDir, usedClones(), new Date(), true), size: await folderSize(reposDir) },
        db: dbUsage(db),
        sessions: { count: count('SELECT count(*) n FROM sessions') },
      },
    };
  });

  server.put<{ Body: Partial<Record<keyof Rules, number>> }>('/api/admin/cleanup', async (req) => {
    requireAdmin(req);
    const before = rules();
    const next = writeRules(settings, req.body ?? {});
    const changed = (Object.keys(next) as (keyof Rules)[]).filter((k) => next[k] !== before[k]);
    if (changed.length) audit(req, 'cleanup-rules-changed', `Löschregeln geändert: ${changed.map((k) => `${k} ${before[k]} → ${next[k]}`).join(', ')}`);
    return next;
  });

  server.post('/api/admin/cleanup/run', async (req) => {
    requireAdmin(req);
    const failed: string[] = [];
    const done = await runCleanup(async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        failed.push(name);
        record({ category: 'error', action: `cleanup-${name}`, message: `Aufräumen (${name}) fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
    audit(req, 'cleanup-run', 'Aufräumen von Hand ausgelöst');
    return { done, failed };
  });

  server.get('/api/admin/backups', async (req) => {
    requireAdmin(req);
    return listBackups(backupDir);
  });

  server.post('/api/admin/backups', async (req) => {
    requireAdmin(req);
    await runBackup({ manual: true });
    audit(req, 'backup-manual', 'Datenbank-Sicherung von Hand ausgelöst');
    return listBackups(backupDir);
  });

  server.get('/api/admin/fsck', async (req) => {
    requireAdmin(req);
    const raw = settings.get('fsck_report');
    return raw ? (JSON.parse(raw) as FsckReport) : null;
  });

  server.post('/api/admin/fsck', async (req) => {
    requireAdmin(req);
    return runFsck();
  });
}
