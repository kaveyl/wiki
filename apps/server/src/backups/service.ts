// Backup plans, runs and restores (AD-038). A plan = target + sources (single ones or all, also
// future ones) + optionally the Kaveyl Wiki database + the keep table. A run zips every source into
// one archive, copies it to the target, records it and applies the plan's keep rules. Runs are
// queued (one at a time). Restoring reads an archive (from an SMB target via a temporary copy)
// and writes through NoteService, so Git commits it like any other change.
// SEE-DOC: DECISIONS.md AD-038

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { ulid } from 'ulid';
import { now, type DB } from '../db/db.js';
import type { Author } from '../git/sync.js';
import { cleanRelPath, contentRoot, repoDir, type Mount } from '../mounts/model.js';
import { historyBundle, HISTORY_BUNDLE } from '../mounts/versions.js';
import { ConflictError, localReferences, type NoteService } from '../notes/service.js';
import { Archive, ArchiveError, zipFolder, type ArchiveEntry } from './archive.js';
import { anyTier, cleanKeep, cleanTime, lastSlot, nextSlot, toDelete, type Keep } from './schedule.js';
import { TargetError, type TargetStore } from './targets.js';

export class BackupError extends Error {
  constructor(
    message: string,
    /** Passed on to the UI (ArchiveError.code). */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface Plan {
  id: string;
  name: string;
  targetId: string;
  /** Mount ids, or ['*'] = every source (also ones added later). */
  sources: string[];
  includeDb: boolean;
  keep: Keep;
  /** Start time, "HH:MM" local time. */
  time: string;
  enabled: boolean;
  createdAt: string;
  /** Next planned start (ISO), null when disabled or nothing chosen. */
  nextRun: string | null;
}

export interface PlanInput {
  name?: string;
  targetId: string;
  sources?: string[];
  includeDb?: boolean;
  keep?: Partial<Keep>;
  time?: string;
  enabled?: boolean;
}

export type RunStatus = 'running' | 'ok' | 'partial' | 'error';

export interface Run {
  id: string;
  planId: string | null;
  planName: string;
  targetName: string;
  trigger: 'plan' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  message: string | null;
  archives: number;
  bytes: number;
}

export interface BackupFile {
  id: string;
  planId: string | null;
  targetId: string;
  targetName: string;
  /** Mount id; null = the Kaveyl Wiki database. */
  mountId: string | null;
  label: string;
  path: string;
  size: number;
  encrypted: boolean;
  createdAt: string;
}

export interface BackupDeps {
  db: DB;
  targets: TargetStore;
  notes: NoteService;
  dataPath: string;
  mounts(): Mount[];
  mount(id: string): Mount | undefined;
  /** Consistent copy of the app database into `file` (VACUUM INTO). */
  snapshotDb(file: string): void;
  /** The key that decrypts stored credentials (base64), for encrypted targets only. */
  secretKey(): string;
  record(e: { level?: 'info' | 'warn' | 'error'; category?: 'system' | 'error'; action: string; message: string; mount?: Mount }): void;
  /** After every run: `problems` null = success (the notifier says „wieder in Ordnung“ after a reported failure). */
  notify(plan: { id: string; name: string }, problems: string[] | null, partial: boolean): Promise<void> | void;
  /**
   * After a whole source came back over its old place (AD-075): `bundle` = the history from the archive (local folder
   * with versions) – the folder gets it when it has no Git yet; `missing` = the folder was not there before. True when
   * the history was taken over.
   */
  wholeRestored?(mount: Mount, o: { bundle: string | null; missing: boolean }, author: Author): Promise<boolean>;
}

/** What „Ziel durchsuchen“ found (AD-075). */
export interface ScanResult {
  /** Archives newly in the list. */
  added: number;
  /** Archives on the target in Kaveyl Wiki's naming, listed before or now. */
  found: number;
  /** Folders without a source of that name – their archives come back with „Speichern als“. */
  unmatched: string[];
}

/** Prefix of the source id of a found archive whose folder matches no source (like a source removed since). */
export const FOUND_PREFIX = 'ordner:';

interface PlanRow {
  id: string;
  name: string;
  target_id: string;
  sources: string;
  include_db: number;
  keep: string;
  time: string;
  enabled: number;
  last_slot: string | null;
  created_at: string;
}

interface FileRow {
  id: string;
  run_id: string | null;
  plan_id: string | null;
  target_id: string;
  mount_id: string | null;
  label: string;
  path: string;
  size: number;
  password_id: string | null;
  created_at: string;
}

/** Folder and file names on the target: readable, safe for SMB and Windows. */
export function safeName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|;\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .slice(0, 60) || 'Quelle'
  );
}

const DB_FOLDER = 'kaveyl-wiki-datenbank';
const DB_LABEL = 'Kaveyl-Wiki-Datenbank';
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
/** „03.10.2026“ for names of restored copies. */
export const germanDate = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};
const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** When an archive was written, from its name `<folder>_YYYY-MM-DD_HHMMSS[-n].zip` (local time, like `stamp`). */
export function archiveTime(folder: string, name: string): Date | null {
  if (!name.startsWith(`${folder}_`)) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)(\d\d)(?:-\d+)?\.zip$/i.exec(name.slice(folder.length + 1));
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi, se);
  return at.getMonth() === mo - 1 && at.getDate() === d && h < 24 && mi < 60 && se < 60 ? at : null;
}

export class BackupService {
  private queue: Promise<unknown> = Promise.resolve();
  /** What the running job is doing right now (for the overview). */
  private current: { runId: string; planName: string; step: string; targetId?: string } | null = null;
  private timer: NodeJS.Timeout | undefined;
  /** `<target>\0<path>` of archives a run is writing right now – „Durchsuchen“ leaves them out. */
  private readonly writing = new Set<string>();
  /** Opened archives for browsing/restoring (SMB ones as temporary copies). */
  private readonly open = new Map<string, { archive: Archive; tmpDir: string | null; used: number }>();

  constructor(private readonly d: BackupDeps) {}

  // ── Plans ──────────────────────────────────────────────────────────────────────────
  listPlans(at = new Date()): Plan[] {
    return (this.d.db.prepare('SELECT * FROM backup_plans ORDER BY name').all() as PlanRow[]).map((r) => this.toPlan(r, at));
  }

  getPlan(id: string): Plan | null {
    const r = this.d.db.prepare('SELECT * FROM backup_plans WHERE id = ?').get(id) as PlanRow | undefined;
    return r ? this.toPlan(r) : null;
  }

  private toPlan(r: PlanRow, at = new Date()): Plan {
    const keep = cleanKeep(JSON.parse(r.keep) as Partial<Keep>);
    return {
      id: r.id,
      name: r.name,
      targetId: r.target_id,
      sources: JSON.parse(r.sources) as string[],
      includeDb: !!r.include_db,
      keep,
      time: r.time,
      enabled: !!r.enabled,
      createdAt: r.created_at,
      nextRun: r.enabled ? (nextSlot(keep, r.time, at)?.toISOString() ?? null) : null,
    };
  }

  private cleanInput(input: PlanInput, prev?: Plan): Omit<Plan, 'id' | 'createdAt' | 'nextRun'> {
    const targetId = input.targetId ?? prev?.targetId;
    if (!targetId || !this.d.targets.get(targetId)) throw new BackupError('Ziel auswählen');
    const sources = [...new Set(input.sources ?? prev?.sources ?? ['*'])].filter((s) => s === '*' || !!this.d.mount(s));
    const includeDb = input.includeDb ?? prev?.includeDb ?? false;
    if (!sources.length && !includeDb) throw new BackupError('Mindestens eine Quelle oder die Kaveyl-Wiki-Datenbank auswählen');
    const keep = input.keep ? cleanKeep(input.keep) : (prev?.keep ?? { daily: 7, weekly: 4, monthly: 0, yearly: 0 });
    if (!anyTier(keep)) throw new BackupError('Mindestens einen Rhythmus (täglich, wöchentlich, monatlich oder jährlich) wählen');
    const target = this.d.targets.get(targetId)!;
    return {
      name: input.name?.trim() || prev?.name || `Sicherung nach ${target.name}`,
      targetId,
      sources: sources.includes('*') ? ['*'] : sources,
      includeDb,
      keep,
      time: cleanTime(input.time ?? prev?.time),
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
  }

  createPlan(input: PlanInput, at = new Date()): Plan {
    const p = this.cleanInput(input);
    const id = ulid();
    // The first run is the next planned slot, not right away.
    this.d.db
      .prepare('INSERT INTO backup_plans (id, name, target_id, sources, include_db, keep, time, enabled, last_slot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.name, p.targetId, JSON.stringify(p.sources), p.includeDb ? 1 : 0, JSON.stringify(p.keep), p.time, p.enabled ? 1 : 0, lastSlot(p.keep, p.time, at)?.toISOString() ?? null, now());
    return this.getPlan(id)!;
  }

  updatePlan(id: string, input: Partial<PlanInput>, at = new Date()): Plan {
    const prev = this.getPlan(id);
    if (!prev) throw new BackupError('Zeitplan nicht gefunden');
    const p = this.cleanInput({ ...input, targetId: input.targetId ?? prev.targetId }, prev);
    const rescheduled = p.time !== prev.time || JSON.stringify(p.keep) !== JSON.stringify(prev.keep) || (p.enabled && !prev.enabled);
    this.d.db
      .prepare('UPDATE backup_plans SET name = ?, target_id = ?, sources = ?, include_db = ?, keep = ?, time = ?, enabled = ? WHERE id = ?')
      .run(p.name, p.targetId, JSON.stringify(p.sources), p.includeDb ? 1 : 0, JSON.stringify(p.keep), p.time, p.enabled ? 1 : 0, id);
    if (rescheduled) this.d.db.prepare('UPDATE backup_plans SET last_slot = ? WHERE id = ?').run(lastSlot(p.keep, p.time, at)?.toISOString() ?? null, id);
    return this.getPlan(id)!;
  }

  /** Deletes a plan; its archives stay at the target and in the list (no longer rotated). */
  deletePlan(id: string) {
    this.d.db.prepare('DELETE FROM backup_plans WHERE id = ?').run(id);
  }

  plansUsingTarget(targetId: string): Plan[] {
    return this.listPlans().filter((p) => p.targetId === targetId);
  }

  /** Plans that back up this source (enabled ones). */
  plansForMount(mountId: string): Plan[] {
    return this.listPlans().filter((p) => p.enabled && (p.sources.includes('*') || p.sources.includes(mountId)));
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────────────
  /** Checks once a minute whether a plan is due (also catches up a slot missed while down). */
  start() {
    const tick = () => void this.tick().catch(() => undefined);
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    setTimeout(tick, 15_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Starts the plans that are due at `at`; returns their ids. */
  async tick(at = new Date()): Promise<string[]> {
    const due: string[] = [];
    for (const r of this.d.db.prepare('SELECT * FROM backup_plans WHERE enabled = 1').all() as PlanRow[]) {
      const plan = this.toPlan(r, at);
      const slot = lastSlot(plan.keep, plan.time, at);
      if (!slot || (r.last_slot && slot.toISOString() <= r.last_slot)) continue;
      this.d.db.prepare('UPDATE backup_plans SET last_slot = ? WHERE id = ?').run(slot.toISOString(), r.id);
      due.push(r.id);
      void this.enqueue(r.id, { trigger: 'plan' });
    }
    return due;
  }

  // ── Runs ───────────────────────────────────────────────────────────────────────────
  /** Queues a run; resolves with its id once it has finished. */
  enqueue(planId: string, opts: { trigger: 'plan' | 'manual'; mountId?: string }): Promise<Run> {
    const plan = this.getPlan(planId);
    if (!plan) return Promise.reject(new BackupError('Zeitplan nicht gefunden'));
    const target = this.d.targets.get(plan.targetId);
    const id = ulid();
    this.d.db
      .prepare("INSERT INTO backup_runs (id, plan_id, plan_name, target_name, trigger, started_at, status, archives, bytes) VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 0)")
      .run(id, plan.id, plan.name, target?.name ?? '?', opts.trigger, now());
    const job = this.queue.then(() => this.execute(id, plan, opts.mountId));
    this.queue = job.catch(() => undefined);
    return job;
  }

  running(): { runId: string; planName: string; step: string } | null {
    if (!this.current) return null;
    const { targetId: _target, ...shown } = this.current;
    return shown;
  }

  /** A run is writing to this target right now (it cannot go meanwhile). */
  busyWith(targetId: string): boolean {
    return this.current?.targetId === targetId;
  }

  /** Waits until queued runs are done (tests, shutdown). */
  idle(): Promise<unknown> {
    return this.queue;
  }

  private async execute(runId: string, plan: Plan, onlyMount?: string): Promise<Run> {
    this.current = { runId, planName: plan.name, step: 'Vorbereiten', targetId: plan.targetId };
    const problems: string[] = [];
    let archives = 0;
    let bytes = 0;
    let tmp: string | undefined;
    try {
      // Inside the try: a failing mkdtemp (e. g. full disk) ends the run as failed, not as 'running'.
      tmp = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-backup-'));
      const target = this.d.targets.get(plan.targetId);
      if (!target) throw new BackupError('Das Ziel des Zeitplans gibt es nicht mehr');
      const driver = this.d.targets.driver(target.id);
      const passwordId = this.d.targets.passwordId(target.id);
      const password = this.d.targets.secret(passwordId);
      if (passwordId && !password) throw new BackupError('Das Backup-Passwort des Ziels ist nicht lesbar');
      const mounts = plan.sources.includes('*') ? this.d.mounts() : plan.sources.map((id) => this.d.mount(id)).filter((m): m is Mount => !!m);
      const items: { key: string; mount: Mount | null; label: string }[] = mounts.filter((m) => !onlyMount || m.id === onlyMount).map((m) => ({ key: m.id, mount: m, label: m.name }));
      if (plan.includeDb && !onlyMount) items.push({ key: 'db', mount: null, label: DB_LABEL });
      if (!items.length) throw new BackupError(onlyMount ? 'Diese Quelle gehört nicht zum Zeitplan' : 'Keine Quelle zu sichern');
      for (const item of items) {
        this.current = { runId, planName: plan.name, step: item.label, targetId: plan.targetId };
        try {
          const size = await this.backupItem(item, plan, target.id, driver, password, passwordId, runId, tmp, (m) => problems.push(`${item.label}: ${m}`));
          archives++;
          bytes += size;
          if (item.mount) this.d.record({ action: 'backup-source', message: `„${item.label}“ gesichert nach „${target.name}“ (${mb(size)})`, mount: item.mount });
        } catch (e) {
          problems.push(`${item.label}: ${errText(e)}`);
          continue;
        }
        try {
          await this.prune(plan, target.id, item.key, driver);
        } catch (e) {
          problems.push(`${item.label} (Aufräumen alter Sicherungen): ${errText(e)}`);
        }
      }
    } catch (e) {
      problems.push(errText(e));
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      this.current = null;
    }
    const status: RunStatus = !problems.length ? 'ok' : archives ? 'partial' : 'error';
    const message = problems.length ? problems.join('\n') : `${archives} ${archives === 1 ? 'Sicherung' : 'Sicherungen'}, ${mb(bytes)}`;
    this.d.db.prepare('UPDATE backup_runs SET finished_at = ?, status = ?, message = ?, archives = ?, bytes = ? WHERE id = ?').run(now(), status, message, archives, bytes, runId);
    if (problems.length) {
      this.d.record({ category: 'error', level: 'error', action: 'backup-failed', message: `Backup „${plan.name}“ ${status === 'partial' ? 'teilweise ' : ''}fehlgeschlagen: ${problems.join('; ')}` });
      await Promise.resolve(this.d.notify(plan, problems, status === 'partial')).catch(() => undefined);
    } else {
      this.d.record({ action: 'backup-run', message: `Backup „${plan.name}“: ${message}` });
      await Promise.resolve(this.d.notify(plan, null, false)).catch(() => undefined);
    }
    return this.getRun(runId)!;
  }

  private async backupItem(
    item: { key: string; mount: Mount | null; label: string },
    plan: Plan,
    targetId: string,
    driver: ReturnType<TargetStore['driver']>,
    password: string | null,
    passwordId: string | null,
    runId: string,
    tmp: string,
    warn: (message: string) => void,
  ): Promise<number> {
    const at = new Date();
    const folder = item.mount ? safeName(item.mount.name) : DB_FOLDER;
    let name = `${folder}_${stamp(at)}.zip`;
    for (let i = 2; this.d.db.prepare('SELECT 1 FROM backup_files WHERE target_id = ? AND path = ?').get(targetId, `${folder}/${name}`); i++) name = `${folder}_${stamp(at)}-${i}.zip`;
    const rel = `${folder}/${name}`;
    const zipFile = join(tmp, name);
    if (item.mount) {
      const root = contentRoot(item.mount, this.d.dataPath);
      if (!(await stat(root).catch(() => null))?.isDirectory()) throw new BackupError('Ordner der Quelle nicht vorhanden');
      // A local folder with its own Git (AD-071): the versions travel along as a bundle – a folder only lives on this server.
      const bundle = join(tmp, `${name}.bundle`);
      const local = item.mount.type === 'local' && !item.mount.subpath;
      const history =
        local &&
        (await historyBundle(repoDir(item.mount, this.d.dataPath), bundle).catch((e: unknown) => {
          warn(`Verlauf nicht gesichert (${errText(e)}) – die Dateien sind gesichert`);
          return false;
        }));
      await zipFolder(root, zipFile, { password, extra: history ? [{ name: HISTORY_BUNDLE, file: bundle }] : [] });
      await rm(bundle, { force: true });
    } else {
      const dbFile = join(tmp, 'kaveyl-wiki.db');
      this.d.snapshotDb(dbFile);
      const extra = [{ name: 'kaveyl-wiki.db', file: dbFile }];
      // The key only travels encrypted: with the database it would open every stored credential.
      if (password) {
        const keyFile = join(tmp, 'secret.key');
        await writeFile(keyFile, this.d.secretKey(), { mode: 0o600 });
        extra.push({ name: 'secret.key', file: keyFile });
      }
      await zipFolder(null, zipFile, { password, extra });
    }
    const size = (await stat(zipFile)).size;
    const free = await driver.free().catch(() => null);
    if (free !== null && free < size + 16 * 1024 ** 2) throw new BackupError(`Am Ziel ist zu wenig Platz (frei: ${mb(free)}, nötig: ${mb(size)})`);
    const key = `${targetId}\0${rel}`;
    this.writing.add(key);
    try {
      await driver.ensureDir(folder);
      await driver.put(zipFile, rel);
      await rm(zipFile, { force: true });
      // A search that found the file in between listed it without this run – this row takes its place.
      this.d.db.prepare('DELETE FROM backup_files WHERE target_id = ? AND path = ? AND run_id IS NULL').run(targetId, rel);
      this.d.db
        .prepare('INSERT INTO backup_files (id, run_id, plan_id, target_id, mount_id, label, path, size, password_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ulid(), runId, plan.id, targetId, item.mount?.id ?? null, item.label, rel, size, passwordId, at.toISOString());
    } finally {
      this.writing.delete(key);
    }
    return size;
  }

  /** Applies the plan's keep rules to the archives of one source at one target. */
  private async prune(plan: Plan, targetId: string, key: string, driver: ReturnType<TargetStore['driver']>) {
    const rows = this.d.db
      .prepare(`SELECT * FROM backup_files WHERE plan_id = ? AND target_id = ? AND ${key === 'db' ? 'mount_id IS NULL' : 'mount_id = ?'}`)
      .all(...(key === 'db' ? [plan.id, targetId] : [plan.id, targetId, key])) as FileRow[];
    const gone = new Set(toDelete(rows.map((r) => ({ id: r.id, createdAt: r.created_at })), plan.keep));
    for (const r of rows.filter((x) => gone.has(x.id))) await this.removeFile(r, driver);
  }

  private async removeFile(r: FileRow, driver = this.d.targets.driver(r.target_id)) {
    await this.closeArchive(r.id);
    await driver.remove(r.path);
    this.d.db.prepare('DELETE FROM backup_files WHERE id = ?').run(r.id);
    this.d.targets.releasePasswords([r.password_id]);
  }

  // ── Ziel durchsuchen (AD-075) ──────────────────────────────────────────────────────
  private listedNow(targetId: string, path: string): boolean {
    return !!this.d.db.prepare('SELECT 1 FROM backup_files WHERE target_id = ? AND path = ?').get(targetId, path);
  }

  /** Who an archive folder belongs to: the database, the one source of that name, or nobody (undefined). */
  private owner(folder: string): { mountId: string | null; label: string } | undefined {
    if (folder === DB_FOLDER) return { mountId: null, label: DB_LABEL };
    const hits = this.d.mounts().filter((m) => safeName(m.name) === folder);
    return hits.length === 1 ? { mountId: hits[0]!.id, label: hits[0]!.name } : undefined;
  }

  /**
   * Takes the archives lying on a target into the list – after the target was removed and added again, or on a new
   * server. Each folder belongs to the source of that name (or the database); archives listed for a source that is gone
   * move to a source of that name added since. Found archives belong to no plan: none of them is rotated.
   */
  scan(targetId: string): Promise<ScanResult> {
    // Not behind the queue of runs (a night run can take hours): what a run is writing right now is left out, and a
    // run that lists an archive the search took in first replaces that row (backupItem).
    return (async () => {
      const target = this.d.targets.get(targetId);
      if (!target) throw new BackupError('Ziel nicht gefunden');
      const found = await this.d.targets.driver(targetId).listArchives();
      const rows = this.d.db.prepare('SELECT * FROM backup_files WHERE target_id = ?').all(targetId) as FileRow[];
      const listed = new Set(rows.map((r) => r.path));
      const passwordId = this.d.targets.passwordId(targetId);
      const insert = this.d.db.prepare(
        'INSERT INTO backup_files (id, run_id, plan_id, target_id, mount_id, label, path, size, password_id, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)',
      );
      const unmatched = new Set<string>();
      let added = 0;
      let count = 0;
      for (const f of found) {
        const [folder, name] = f.path.split('/') as [string, string];
        const at = archiveTime(folder, name);
        if (!at) continue;
        count++;
        if (this.writing.has(`${targetId}\0${f.path}`)) continue;
        const owner = this.owner(folder);
        if (!owner) unmatched.add(folder);
        if (listed.has(f.path) || this.listedNow(targetId, f.path)) continue;
        insert.run(ulid(), targetId, owner ? owner.mountId : `${FOUND_PREFIX}${folder}`, owner?.label ?? folder, f.path, f.size, passwordId, at.toISOString());
        added++;
      }
      const move = this.d.db.prepare('UPDATE backup_files SET mount_id = ?, label = ? WHERE id = ?');
      for (const r of rows) {
        if (r.mount_id === null || this.d.mount(r.mount_id)) continue;
        const owner = this.owner(r.path.split('/')[0]!);
        if (owner?.mountId) move.run(owner.mountId, owner.label, r.id);
      }
      if (added) this.d.record({ action: 'backup-scan', message: `Ziel „${target.name}“ durchsucht: ${added} vorhandene Sicherung(en) aufgenommen` });
      return { added, found: count, unmatched: [...unmatched].sort() };
    })();
  }

  /**
   * A backup password typed for an archive the target's one does not open (an older or another password), for this
   * archive only.
   */
  async unlock(id: string, password: string | null): Promise<number> {
    const r = this.fileRow(id);
    if (password === '') throw new BackupError('Bitte das Backup-Passwort angeben');
    await this.closeArchive(id);
    const f = await this.fetch(id);
    try {
      // null: the admin opens an unencrypted archive on an encrypted target on purpose (older than the password).
      await (await Archive.open(f.file, password)).close();
    } catch (e) {
      throw e instanceof ArchiveError ? new BackupError(e.message, e.code) : e;
    } finally {
      await f.cleanup();
    }
    if (password === null) {
      this.d.db.prepare('UPDATE backup_files SET password_id = NULL WHERE id = ?').run(id);
      this.d.targets.releasePasswords([r.password_id]);
      return 1;
    }
    // Only this archive: others on the target may have yet another password (taking them along would lock them out).
    const secretId = this.d.targets.storePassword(password);
    this.d.db.prepare('UPDATE backup_files SET password_id = ? WHERE id = ?').run(secretId, id);
    this.d.targets.releasePasswords([r.password_id]);
    return 1;
  }

  listRuns(limit = 50): Run[] {
    return (this.d.db.prepare('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[]).map(toRun);
  }

  getRun(id: string): Run | null {
    const r = this.d.db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  /** Runs older than `days` leave the history (Löschregel); 0 = keep. */
  pruneRuns(days: number, at = Date.now()): number {
    if (!days) return 0;
    return this.d.db.prepare("DELETE FROM backup_runs WHERE status != 'running' AND started_at < ?").run(new Date(at - days * 86_400_000).toISOString()).changes;
  }

  /** Runs left 'running' by a restart are marked as interrupted. */
  markInterrupted() {
    this.d.db.prepare("UPDATE backup_runs SET status = 'error', finished_at = ?, message = 'Abgebrochen (Kaveyl Wiki wurde neu gestartet)' WHERE status = 'running'").run(now());
  }

  // ── Archives ───────────────────────────────────────────────────────────────────────
  listFiles(filter: { mountId?: string; targetId?: string } = {}): BackupFile[] {
    const names = new Map(this.d.targets.list().map((t) => [t.id, t.name]));
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.mountId) {
      where.push(filter.mountId === 'db' ? 'mount_id IS NULL' : 'mount_id = ?');
      if (filter.mountId !== 'db') args.push(filter.mountId);
    }
    if (filter.targetId) {
      where.push('target_id = ?');
      args.push(filter.targetId);
    }
    const rows = this.d.db.prepare(`SELECT * FROM backup_files ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`).all(...args) as FileRow[];
    return rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      targetId: r.target_id,
      targetName: names.get(r.target_id) ?? '?',
      mountId: r.mount_id,
      label: r.label,
      path: r.path,
      size: r.size,
      encrypted: !!r.password_id,
      createdAt: r.created_at,
    }));
  }

  private fileRow(id: string): FileRow {
    const r = this.d.db.prepare('SELECT * FROM backup_files WHERE id = ?').get(id) as FileRow | undefined;
    if (!r) throw new BackupError('Sicherung nicht gefunden');
    return r;
  }

  async deleteFile(id: string): Promise<BackupFile> {
    const r = this.fileRow(id);
    const shown = this.listFiles().find((f) => f.id === id)!;
    await this.removeFile(r);
    return shown;
  }

  /** The archive as a local file (SMB: fetched into a temporary folder) for a download. */
  async fetch(id: string): Promise<{ file: string; name: string; cleanup: () => Promise<void> }> {
    const r = this.fileRow(id);
    const driver = this.d.targets.driver(r.target_id);
    const name = posix.basename(r.path);
    if (driver.localPath) {
      const file = driver.localPath(r.path);
      if (!(await stat(file).catch(() => null))) throw new BackupError('Die Datei fehlt am Ziel (von Hand gelöscht oder verschoben?)');
      return { file, name, cleanup: async () => undefined };
    }
    const dir = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-restore-'));
    try {
      await driver.get(r.path, join(dir, name));
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    return { file: join(dir, name), name, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  private async archive(id: string): Promise<Archive> {
    const hit = this.open.get(id);
    if (hit) {
      hit.used = Date.now();
      return hit.archive;
    }
    const r = this.fileRow(id);
    const f = await this.fetch(id);
    try {
      const archive = await Archive.open(f.file, this.d.targets.secret(r.password_id));
      this.open.set(id, { archive, tmpDir: f.file.includes('kaveyl-wiki-restore-') ? posix.dirname(f.file) : null, used: Date.now() });
      void this.evict();
      return archive;
    } catch (e) {
      await f.cleanup();
      throw e instanceof ArchiveError ? new BackupError(e.message, e.code) : e;
    }
  }

  /** Keeps at most 3 archives open, none unused for 10 minutes. */
  private async evict() {
    const list = [...this.open].sort((a, b) => b[1].used - a[1].used);
    for (const [id] of list.slice(3)) await this.closeArchive(id);
    for (const [id, o] of list) if (Date.now() - o.used > 10 * 60_000) await this.closeArchive(id);
  }

  private async closeArchive(id: string) {
    const o = this.open.get(id);
    if (!o) return;
    this.open.delete(id);
    await o.archive.close();
    if (o.tmpDir) await rm(o.tmpDir, { recursive: true, force: true });
  }

  async closeAll() {
    for (const id of [...this.open.keys()]) await this.closeArchive(id);
  }

  async entries(id: string): Promise<ArchiveEntry[]> {
    // The history (AD-071) is for a restored folder, not a file to pick.
    return (await this.archive(id)).entries().filter((e) => e.path !== HISTORY_BUNDLE);
  }

  async readEntry(id: string, path: string): Promise<Buffer> {
    return (await this.archive(id)).read(cleanRelPath(path));
  }

  file(id: string): BackupFile {
    const f = this.listFiles().find((x) => x.id === id);
    if (!f) throw new BackupError('Sicherung nicht gefunden');
    return f;
  }

  /**
   * Restores a note, a folder or the whole source ('' ) from an archive into its source.
   * overwrite: same paths (existing files replaced, nothing deleted). copy: next to the original,
   * „Name (Sicherung 03.10.2026)“ (a whole source: folder „Sicherung 03.10.2026“ at the top).
   * A single note brings along attachments it links to that are missing in the source.
   */
  async restore(
    id: string,
    req: { path: string; mode: 'overwrite' | 'copy'; to?: { mountId: string; path: string } },
    author: Author,
  ): Promise<{ paths: string[]; skipped: string[]; root: string; mountId: string; warnings: string[]; history?: boolean }> {
    const f = this.file(id);
    if (!f.mountId) throw new BackupError('Datenbank-Sicherungen lassen sich nur herunterladen – zurückspielen in der Ersteinrichtung eines neuen Servers (siehe Handbuch)');
    const src = this.d.mount(f.mountId) ?? null;
    // Speichern als (AD-039): a copy may go into another source — also when the original source is gone.
    const to = req.mode === 'copy' && req.to ? { mountId: String(req.to.mountId ?? ''), path: cleanRelPath(String(req.to.path ?? '').trim()) } : null;
    const mount = to ? this.d.mount(to.mountId) : src;
    if (!mount) throw new BackupError(to ? 'Die Ziel-Quelle gibt es nicht' : 'Die Quelle dieser Sicherung gibt es nicht mehr – „Speichern als“ in eine andere Quelle oder die Sicherung herunterladen');
    if (to && !to.path) throw new BackupError('Bitte einen Namen angeben');
    const archive = await this.archive(id);
    const path = req.path ? cleanRelPath(req.path) : '';
    const all = archive.entries().map((e) => e.path);
    const isNote = !!path && archive.has(path);
    // The note trash never comes back; a copy of the whole source leaves out Kaveyl Wiki's own folder.
    const internal = (p: string) => p === HISTORY_BUNDLE || p.startsWith('.kaveyl-wiki/trash/') || (req.mode === 'copy' && !path && p.startsWith('.kaveyl-wiki/'));
    const chosen = isNote && !internal(path) ? [path] : all.filter((p) => (!path || p.startsWith(`${path}/`)) && !internal(p));
    if (!chosen.length) throw new BackupError(`„${path}“ ist nicht in der Sicherung`);
    const label = `Sicherung ${germanDate(f.createdAt)}`;
    const what = isNote ? `„${path}“` : path ? `Ordner „${path}“` : 'alle Dateien';
    const exists = async (rel: string) => !!(await stat(join(contentRoot(mount, this.d.dataPath), ...rel.split('/'))).catch(() => null));
    const done = (written: number, root: string) =>
      this.d.record({
        action: 'backup-restore',
        mount,
        message: `${what} aus der ${label} (${f.targetName}) ${req.mode === 'copy' ? `als Kopie „${root}“${src?.id !== mount.id ? ` in „${mount.name}“` : ''}` : 'überschrieben'} wiederhergestellt (${written} Datei(en))`,
      });

    if (to && isNote && /\.md$/i.test(path)) {
      const raw = (await archive.read(path)).toString('utf8');
      const message = `docs: ${what} aus ${label} als „${to.path}“ gespeichert (Kaveyl Wiki)`;
      const res = await this.d.notes.saveNoteAs(src, path, raw, mount, to.path, author, message, async (ref) => (archive.has(ref) ? archive.read(ref) : null));
      done(1, res.path);
      return { paths: [res.path], skipped: [], root: res.path, mountId: mount.id, warnings: res.warnings };
    }

    let root = path;
    let map = (p: string) => p;
    if (req.mode === 'copy') {
      if (to) {
        root = to.path;
        if (await exists(root)) throw new ConflictError(null, null);
      } else {
        const parent = path ? (posix.dirname(path) === '.' ? '' : posix.dirname(path)) : '';
        const base = path ? posix.basename(path) : '';
        const ext = isNote ? posix.extname(base) : '';
        const stem = ext ? base.slice(0, -ext.length) : base;
        for (let i = 1; ; i++) {
          const suffix = i === 1 ? label : `${label} ${i}`;
          const name = path ? `${stem} (${suffix})${ext}` : suffix;
          root = parent ? `${parent}/${name}` : name;
          if (!(await exists(root))) break;
        }
      }
      const from = path;
      const dest = root;
      map = (p) => (isNote ? dest : from ? `${dest}${p.slice(from.length)}` : `${dest}/${p}`);
    }
    const files: { rel: string; data: Buffer }[] = [];
    for (const p of chosen) files.push({ rel: map(p), data: await archive.read(p) });
    if (!to && isNote && /\.md$/i.test(path)) {
      // Attachments the note links to that are gone from the source come back too (never overwritten).
      const raw = files[0]!.data.toString('utf8');
      for (const ref of await localReferences(raw, path)) {
        if (/\.md$/i.test(ref) || !archive.has(ref)) continue;
        if (await exists(ref)) continue;
        files.push({ rel: ref, data: await archive.read(ref) });
      }
    }
    const message = `docs: ${what} aus ${label} ${req.mode === 'copy' ? `als „${root}“ ` : ''}wiederhergestellt (Kaveyl Wiki)`;
    const whole = !path && req.mode === 'overwrite';
    const missing = whole && !(await stat(contentRoot(mount, this.d.dataPath)).catch(() => null));
    const res = await this.d.notes.writeRestored(mount, files, author, message, { freshIds: req.mode === 'copy' });
    let history = false;
    if (whole && this.d.wholeRestored) {
      // The history of a local folder with versions comes along (AD-071/075) – streamed out, it can be large.
      const tmp = archive.has(HISTORY_BUNDLE) ? await mkdtemp(join(tmpdir(), 'kaveyl-wiki-history-')) : null;
      try {
        const bundle = tmp ? join(tmp, HISTORY_BUNDLE) : null;
        if (bundle) await archive.extract(HISTORY_BUNDLE, bundle);
        history = await this.d.wholeRestored(mount, { bundle, missing }, author);
      } finally {
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    }
    done(res.written.length, root);
    return { paths: res.written, skipped: res.skipped, root: req.mode === 'copy' ? root : path, mountId: mount.id, warnings: [], ...(whole && { history }) };
  }
}

interface RunRow {
  id: string;
  plan_id: string | null;
  plan_name: string;
  target_name: string;
  trigger: 'plan' | 'manual';
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  message: string | null;
  archives: number;
  bytes: number;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  planId: r.plan_id,
  planName: r.plan_name,
  targetName: r.target_name,
  trigger: r.trigger,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  status: r.status,
  message: r.message,
  archives: r.archives,
  bytes: r.bytes,
});

export { TargetError };
