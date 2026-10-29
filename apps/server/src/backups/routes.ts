// HTTP routes of the backup module (AD-038) — admins only. Targets are tested with the form
// values before saving; passwords are write-only. Runs start in the background, the UI polls
// /api/backup/runs. Restores write through NoteService (Git commits them like any change).
// SEE-DOC: DECISIONS.md AD-038

import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Author } from '../git/sync.js';
import type { Mount } from '../mounts/model.js';
import { BackupError, type BackupService, type PlanInput } from './service.js';
import type { TargetInput, TargetStore } from './targets.js';
import { isText } from './text.js';

export interface BackupRouteDeps {
  backups: BackupService;
  targets: TargetStore;
  requireAdmin(req: FastifyRequest): void;
  author(req: FastifyRequest): Author;
  mount(id: string): Mount | undefined;
  audit(req: FastifyRequest, action: string, message: string, mount?: Mount): void;
}

export function registerBackups(server: FastifyInstance, d: BackupRouteDeps) {
  server.addHook('onRequest', async (req) => {
    // The route pattern, not the raw URL (%-escapes would slip past a prefix check).
    if (req.routeOptions.url?.startsWith('/api/backup/')) d.requireAdmin(req);
  });

  /** Where local targets live and whether SMB is available — for hints in the UI. */
  server.get('/api/backup/status', async () => ({
    root: d.targets.root,
    /** Plan times are in this zone (container: TZ). */
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    running: d.backups.running(),
  }));

  // ── Targets ────────────────────────────────────────────────────────────────────────
  server.get('/api/backup/targets', async () => d.targets.list().map((t) => ({ ...t, plans: d.backups.plansUsingTarget(t.id).map((p) => p.name) })));

  server.post<{ Body: TargetInput & { id?: string } }>('/api/backup/targets/test', async (req) => {
    const b = req.body ?? ({} as TargetInput);
    return d.targets.driverForInput(b, b.id).test();
  });

  /** A new target is searched for archives lying there right away (AD-075); an unreachable one is saved anyway. */
  server.post<{ Body: TargetInput }>('/api/backup/targets', async (req) => {
    const t = d.targets.create(req.body ?? ({} as TargetInput));
    d.audit(req, 'backup-target-added', `Backup-Ziel angelegt: ${t.name} (${t.kind === 'smb' ? `SMB ${t.location}` : `Ordner ${t.location || '/'}`}${t.encrypted ? ', verschlüsselt' : ''})`);
    const scan = await d.backups.scan(t.id).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return { ...t, scan };
  });

  /** „Ziel durchsuchen“: archives on the target into the list (AD-075). */
  server.post<{ Params: { id: string } }>('/api/backup/targets/:id/scan', async (req) => d.backups.scan(req.params.id));

  server.put<{ Params: { id: string }; Body: Partial<TargetInput> }>('/api/backup/targets/:id', async (req) => {
    const before = d.targets.get(req.params.id);
    const t = d.targets.update(req.params.id, req.body ?? {});
    const changes = [
      req.body?.password ? 'SMB-Passwort' : null,
      req.body?.archivePassword !== undefined && before?.encrypted !== t.encrypted ? (t.encrypted ? 'Verschlüsselung an' : 'Verschlüsselung aus') : null,
      req.body?.archivePassword && before?.encrypted && t.encrypted ? 'Backup-Passwort' : null,
    ].filter(Boolean);
    d.audit(req, 'backup-target-changed', `Backup-Ziel geändert: ${t.name}${changes.length ? ` (${changes.join(', ')})` : ''}`);
    return t;
  });

  /** `plans=1`: the plans using the target go along (the UI asked „Zeitplan mit löschen?“, AD-075). */
  server.delete<{ Params: { id: string }; Querystring: { plans?: string } }>('/api/backup/targets/:id', async (req) => {
    const t = d.targets.get(req.params.id);
    if (!t) return { ok: true };
    if (d.backups.busyWith(t.id)) throw new BackupError('Gerade läuft eine Sicherung auf dieses Ziel – bitte danach noch einmal');
    const plans = d.backups.plansUsingTarget(t.id);
    if (plans.length && req.query.plans !== '1') throw new BackupError(`Das Ziel wird noch von ${plans.map((p) => `„${p.name}“`).join(', ')} benutzt – zuerst den Zeitplan löschen oder umstellen`);
    for (const p of plans) {
      d.backups.deletePlan(p.id);
      d.audit(req, 'backup-plan-removed', `Backup-Zeitplan gelöscht: ${p.name} (mit dem Ziel ${t.name}; seine Sicherungen bleiben dort)`);
    }
    d.targets.remove(t.id);
    d.audit(req, 'backup-target-removed', `Backup-Ziel entfernt: ${t.name} (die Dateien dort bleiben)`);
    return { ok: true };
  });

  // ── Plans ──────────────────────────────────────────────────────────────────────────
  server.get('/api/backup/plans', async () => d.backups.listPlans());

  server.post<{ Body: PlanInput }>('/api/backup/plans', async (req) => {
    const p = d.backups.createPlan(req.body ?? ({} as PlanInput));
    d.audit(req, 'backup-plan-added', `Backup-Zeitplan angelegt: ${p.name}`);
    return p;
  });

  server.put<{ Params: { id: string }; Body: Partial<PlanInput> }>('/api/backup/plans/:id', async (req) => {
    const p = d.backups.updatePlan(req.params.id, req.body ?? {});
    d.audit(req, 'backup-plan-changed', `Backup-Zeitplan geändert: ${p.name}${p.enabled ? '' : ' (pausiert)'}`);
    return p;
  });

  server.delete<{ Params: { id: string } }>('/api/backup/plans/:id', async (req) => {
    const p = d.backups.getPlan(req.params.id);
    d.backups.deletePlan(req.params.id);
    if (p) d.audit(req, 'backup-plan-removed', `Backup-Zeitplan gelöscht: ${p.name} (seine Sicherungen bleiben)`);
    return { ok: true };
  });

  /** „Jetzt sichern“: the whole plan, in the background. */
  server.post<{ Params: { id: string } }>('/api/backup/plans/:id/run', async (req) => {
    const p = d.backups.getPlan(req.params.id);
    if (!p) throw new BackupError('Zeitplan nicht gefunden');
    void d.backups.enqueue(p.id, { trigger: 'manual' }).catch(() => undefined);
    d.audit(req, 'backup-manual', `Backup „${p.name}“ von Hand gestartet`);
    return { ok: true };
  });

  /** „Jetzt sichern“ on a source: every enabled plan that includes it, only this source. */
  server.post<{ Params: { mountId: string } }>('/api/backup/sources/:mountId/run', async (req) => {
    const m = d.mount(req.params.mountId);
    if (!m) throw new BackupError('Quelle nicht gefunden');
    const plans = d.backups.plansForMount(m.id);
    if (!plans.length) throw new BackupError(`Kein aktiver Zeitplan sichert „${m.name}“ – unter Einstellungen → Backup → Zeitpläne einen anlegen`);
    for (const p of plans) void d.backups.enqueue(p.id, { trigger: 'manual', mountId: m.id }).catch(() => undefined);
    d.audit(req, 'backup-manual', `Sicherung von „${m.name}“ von Hand gestartet (${plans.map((p) => p.name).join(', ')})`, m);
    return { plans: plans.map((p) => p.name) };
  });

  server.get<{ Querystring: { limit?: string } }>('/api/backup/runs', async (req) => ({
    runs: d.backups.listRuns(Math.min(200, Number(req.query.limit) || 50)),
    running: d.backups.running(),
  }));

  // ── Archives ───────────────────────────────────────────────────────────────────────
  server.get<{ Querystring: { mountId?: string; targetId?: string } }>('/api/backup/files', async (req) => d.backups.listFiles({ mountId: req.query.mountId || undefined, targetId: req.query.targetId || undefined }));

  server.delete<{ Params: { id: string } }>('/api/backup/files/:id', async (req) => {
    const f = await d.backups.deleteFile(req.params.id);
    d.audit(req, 'backup-file-removed', `Sicherung gelöscht: ${f.path} (${f.targetName})`);
    return { ok: true };
  });

  server.get<{ Params: { id: string } }>('/api/backup/files/:id/download', async (req, reply) => {
    const f = await d.backups.fetch(req.params.id);
    const stream = createReadStream(f.file);
    stream.on('close', () => void f.cleanup());
    d.audit(req, 'backup-download', `Sicherung heruntergeladen: ${f.name}`);
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).send(stream);
  });

  server.get<{ Params: { id: string } }>('/api/backup/files/:id/entries', async (req) => d.backups.entries(req.params.id));

  /** One file of an archive: text as JSON (for the comparison), anything else – and with `download=1` everything – as download. */
  server.get<{ Params: { id: string }; Querystring: { path: string; download?: string } }>('/api/backup/files/:id/entry', async (req, reply) => {
    const data = await d.backups.readEntry(req.params.id, req.query.path ?? '');
    if (req.query.download !== '1' && isText(req.query.path, data)) return { text: data.toString('utf8') };
    const name = req.query.path.split('/').pop() ?? 'datei';
    return reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).send(data);
  });

  /** The backup password for an archive the target's one does not open (AD-075). */
  /** `none: true`: an unencrypted archive on an encrypted target is opened without a password – the admin's decision. */
  server.post<{ Params: { id: string }; Body: { password?: string; none?: boolean } }>('/api/backup/files/:id/password', async (req) => {
    const none = req.body?.none === true;
    const updated = await d.backups.unlock(req.params.id, none ? null : String(req.body?.password ?? ''));
    if (none) d.audit(req, 'backup-password', `Unverschlüsselte Sicherung auf einem verschlüsselten Ziel bewusst zugelassen: ${d.backups.file(req.params.id).path}`);
    else d.audit(req, 'backup-password', `Backup-Passwort für ${updated} vorhandene Sicherung(en) eingegeben`);
    return { updated };
  });

  /** `to` (with mode copy): Speichern als — source and path of the copy (AD-039). */
  server.post<{ Params: { id: string }; Body: { path?: string; mode?: 'overwrite' | 'copy'; to?: { mountId: string; path: string } } }>('/api/backup/files/:id/restore', async (req) => {
    const mode = req.body?.mode === 'copy' ? 'copy' : 'overwrite';
    return d.backups.restore(req.params.id, { path: req.body?.path ?? '', mode, to: req.body?.to }, d.author(req));
  });
}
