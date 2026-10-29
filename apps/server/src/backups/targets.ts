// Backup targets (AD-038): a folder below the backup root (`/backup` in the container) or an SMB
// share. The SMB password and the optional backup password (AES-ZIP) live in the SecretStore and
// never reach the frontend. Every target can be tested before it is saved.
// SEE-DOC: DECISIONS.md AD-038

import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { ulid } from 'ulid';
import { now, type DB } from '../db/db.js';
import type { SecretStore } from '../secrets.js';
import { formatSmbLocation, parseSmbLocation, SmbClient, SmbError, UNSAFE } from './smb.js';

export type TargetKind = 'local' | 'smb';

export interface Target {
  id: string;
  kind: TargetKind;
  name: string;
  /** local: folder below the backup root ('' = the root); smb: \\server\share\folder. */
  location: string;
  username: string | null;
  domain: string | null;
  /** SMB password stored. */
  passwordSet: boolean;
  /** Archives are encrypted with a backup password. */
  encrypted: boolean;
  createdAt: string;
}

export interface TargetInput {
  kind: TargetKind;
  name?: string;
  location: string;
  username?: string | null;
  domain?: string | null;
  /** SMB password: new value; undefined keeps the stored one. */
  password?: string;
  /** Backup password: new value, '' = no encryption from now on, undefined keeps it. */
  archivePassword?: string;
}

interface Row {
  id: string;
  kind: TargetKind;
  name: string;
  location: string;
  username: string | null;
  domain: string | null;
  secret_id: string | null;
  password_id: string | null;
  created_at: string;
}

export class TargetError extends Error {}

export interface TestResult {
  ok: true;
  /** Free bytes at the target, if known. */
  free: number | null;
  /** Hints that do not stop the target from working (e.g. same disk as the data). */
  warnings: string[];
}

/** What a run needs from a target: copy an archive there, fetch it back, delete it. */
export interface TargetDriver {
  test(): Promise<TestResult>;
  ensureDir(relDir: string): Promise<void>;
  put(localFile: string, rel: string): Promise<void>;
  get(rel: string, localFile: string): Promise<void>;
  remove(rel: string): Promise<void>;
  free(): Promise<number | null>;
  /** ZIP files one folder down (`<folder>/<name>.zip`, what a run writes) – for „Ziel durchsuchen“. */
  listArchives(): Promise<{ path: string; size: number }[]>;
  /** Local targets: the file itself (read without copying). */
  localPath?(rel: string): string;
}

/** Folders looked into when a target is searched – a target pointed at the root of a big share stays quick. */
const SCAN_FOLDERS = 500;

const MIN_PASSWORD = 8;

export class TargetStore {
  constructor(
    private readonly db: DB,
    private readonly secrets: SecretStore,
    /** Folder local targets live in; null = not available (no BACKUP_ROOT). */
    readonly root: string | null,
    private readonly dataPath: string,
  ) {}

  list(): Target[] {
    return (this.db.prepare('SELECT * FROM backup_targets ORDER BY name').all() as Row[]).map(toTarget);
  }

  get(id: string): Target | null {
    const r = this.row(id);
    return r ? toTarget(r) : null;
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM backup_targets WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  /** Secret id of the backup password currently used for new archives (null = unencrypted). */
  passwordId(id: string): string | null {
    return this.row(id)?.password_id ?? null;
  }

  secret(id: string | null): string | null {
    return id ? this.secrets.get(id) : null;
  }

  /** Checks and normalizes the form values; returns the location as stored. */
  normalize(input: TargetInput): string {
    if (input.kind === 'local') return this.localSub(input.location);
    if (input.kind === 'smb') {
      const loc = parseSmbLocation(input.location);
      if (!input.username?.trim()) throw new TargetError('Für die SMB-Freigabe einen Benutzernamen angeben');
      return formatSmbLocation(loc);
    }
    throw new TargetError('Unbekannte Art des Ziels');
  }

  /** Folder below the root, validated ('' = the root itself). */
  private localSub(location: string): string {
    const parts = (location ?? '').replace(/\\/g, '/').replace(/^\/?backup\/?/, '').split('/').filter((p) => p && p !== '.');
    for (const p of parts) if (p === '..' || /[\u0000-\u001f]/.test(p)) throw new TargetError(`Ungültiger Ordnername „${p}“`);
    return parts.join('/');
  }

  create(input: TargetInput): Target {
    const location = this.normalize(input);
    if (input.archivePassword && input.archivePassword.length < MIN_PASSWORD) throw new TargetError(`Das Backup-Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`);
    if (input.kind === 'smb' && !input.password) throw new TargetError('Für die SMB-Freigabe das Passwort angeben');
    const id = ulid();
    const secretId = input.kind === 'smb' && input.password ? this.secrets.put(input.password) : null;
    const passwordId = input.archivePassword ? this.secrets.put(input.archivePassword) : null;
    const name = input.name?.trim() || defaultName(input.kind, location);
    this.db
      .prepare('INSERT INTO backup_targets (id, kind, name, location, username, domain, secret_id, password_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.kind, name, location, input.kind === 'smb' ? input.username!.trim() : null, input.kind === 'smb' ? input.domain?.trim() || null : null, secretId, passwordId, now());
    return this.get(id)!;
  }

  /**
   * Changes a target. A new backup password applies to new archives only: the old one stays
   * stored as long as listed archives need it (`releasePasswords`).
   */
  update(id: string, input: Partial<TargetInput>): Target {
    const r = this.row(id);
    if (!r) throw new TargetError('Ziel nicht gefunden');
    const kind = r.kind;
    const location = input.location !== undefined ? this.normalize({ ...input, kind, location: input.location, username: input.username ?? r.username }) : r.location;
    let secretId = r.secret_id;
    if (kind === 'smb' && input.password) {
      if (secretId) this.secrets.put(input.password, secretId);
      else secretId = this.secrets.put(input.password);
    }
    let passwordId = r.password_id;
    if (input.archivePassword !== undefined) {
      if (input.archivePassword && input.archivePassword.length < MIN_PASSWORD) throw new TargetError(`Das Backup-Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`);
      passwordId = input.archivePassword ? this.secrets.put(input.archivePassword) : null;
    }
    this.db
      .prepare('UPDATE backup_targets SET name = ?, location = ?, username = ?, domain = ?, secret_id = ?, password_id = ? WHERE id = ?')
      .run(
        input.name?.trim() || r.name,
        location,
        kind === 'smb' ? (input.username?.trim() ?? r.username) : null,
        kind === 'smb' ? (input.domain !== undefined ? input.domain?.trim() || null : r.domain) : null,
        secretId,
        passwordId,
        id,
      );
    if (passwordId !== r.password_id) this.releasePasswords([r.password_id]);
    return this.get(id)!;
  }

  /** Stores a backup password someone typed for an archive (it fits a different one than the target's). */
  storePassword(password: string): string {
    return this.secrets.put(password);
  }

  remove(id: string) {
    const r = this.row(id);
    if (!r) return;
    const filePasswords = (this.db.prepare('SELECT DISTINCT password_id p FROM backup_files WHERE target_id = ?').all(id) as { p: string | null }[]).map((x) => x.p);
    this.db.prepare('DELETE FROM backup_targets WHERE id = ?').run(id);
    if (r.secret_id) this.secrets.delete(r.secret_id);
    this.releasePasswords([r.password_id, ...filePasswords]);
  }

  /** Deletes stored backup passwords that neither a target nor a listed archive needs any more. */
  releasePasswords(ids: (string | null)[]) {
    for (const p of new Set(ids.filter((x): x is string => !!x))) {
      const used = this.db.prepare('SELECT 1 FROM backup_targets WHERE password_id = ? UNION ALL SELECT 1 FROM backup_files WHERE password_id = ? LIMIT 1').get(p, p);
      if (!used) this.secrets.delete(p);
    }
  }

  /** Driver for a stored target. */
  driver(id: string): TargetDriver {
    const r = this.row(id);
    if (!r) throw new TargetError('Ziel nicht gefunden');
    return this.driverFor({ kind: r.kind, location: r.location, username: r.username, domain: r.domain }, r.secret_id ? (this.secrets.get(r.secret_id) ?? '') : '');
  }

  /** Driver for form values (test before saving); a missing password falls back to the stored one of `id`. */
  driverForInput(input: TargetInput, id?: string): TargetDriver {
    const location = this.normalize(input);
    let password = input.password ?? '';
    if (!password && id) {
      const r = this.row(id);
      password = r?.secret_id ? (this.secrets.get(r.secret_id) ?? '') : '';
    }
    return this.driverFor({ kind: input.kind, location, username: input.username ?? null, domain: input.domain ?? null }, password);
  }

  private driverFor(t: { kind: TargetKind; location: string; username: string | null; domain: string | null }, password: string): TargetDriver {
    if (t.kind === 'local') {
      if (!this.root) throw new TargetError('Kein Backup-Ordner eingehängt (/backup in docker-compose.yml)');
      return new LocalDriver(this.root, t.location, this.dataPath);
    }
    return new SmbDriver(new SmbClient(parseSmbLocation(t.location), { username: t.username ?? '', password, domain: t.domain }));
  }
}

function toTarget(r: Row): Target {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    location: r.location,
    username: r.username,
    domain: r.domain,
    passwordSet: !!r.secret_id,
    encrypted: !!r.password_id,
    createdAt: r.created_at,
  };
}

function defaultName(kind: TargetKind, location: string): string {
  if (kind === 'local') return location ? `Backup-Ordner (${location})` : 'Backup-Ordner';
  const l = parseSmbLocation(location);
  return `${l.host} (${l.share})`;
}

const TEST_NAME = () => `.kaveyl-wiki-test-${randomBytes(4).toString('hex')}`;

/** Whether `path` is a mount point (Linux): otherwise files there end up inside the container. */
async function isMountPoint(path: string): Promise<boolean | null> {
  const info = await readFile('/proc/self/mountinfo', 'utf8').catch(() => null);
  if (info === null) return null;
  const want = resolve(path);
  return info.split('\n').some((l) => l.split(' ')[4]?.replace(/\\040/g, ' ') === want);
}

export class LocalDriver implements TargetDriver {
  readonly base: string;
  constructor(
    private readonly root: string,
    sub: string,
    private readonly dataPath: string,
  ) {
    this.base = sub ? join(root, ...sub.split('/')) : root;
  }

  localPath(rel: string): string {
    const abs = resolve(this.base, ...rel.split('/'));
    if (!abs.startsWith(this.base + sep)) throw new TargetError('Pfad außerhalb des Ziels');
    return abs;
  }

  async test(): Promise<TestResult> {
    const root = await stat(this.root).catch(() => null);
    if (!root?.isDirectory()) throw new TargetError(`Der Backup-Ordner ${this.root} fehlt – in docker-compose.yml einen Host-Ordner dort einhängen`);
    await mkdir(this.base, { recursive: true }).catch((e: NodeJS.ErrnoException) => {
      throw new TargetError(e.code === 'EACCES' ? `Keine Schreibrechte für ${this.base}` : `Ordner ${this.base} lässt sich nicht anlegen: ${e.message}`);
    });
    const probe = join(this.base, TEST_NAME());
    const data = randomBytes(64);
    try {
      await writeFile(probe, data, { mode: 0o600 });
      const back = await readFile(probe);
      if (!back.equals(data)) throw new TargetError('Die Probedatei kam verändert zurück');
    } catch (e) {
      if (e instanceof TargetError) throw e;
      const err = e as NodeJS.ErrnoException;
      throw new TargetError(err.code === 'EACCES' ? `Keine Schreibrechte für ${this.base}` : `Schreiben in ${this.base} fehlgeschlagen: ${err.message}`);
    } finally {
      await rm(probe, { force: true });
    }
    const warnings: string[] = [];
    if ((await isMountPoint(this.root)) === false)
      warnings.push(`${this.root} ist kein eingehängter Host-Ordner – Sicherungen dort gehen verloren, wenn der Container neu gebaut wird`);
    const [a, b] = await Promise.all([stat(this.base), stat(this.dataPath).catch(() => null)]);
    if (b && a.dev === b.dev) warnings.push('Liegt auf demselben Datenträger wie die Daten von Kaveyl Wiki – schützt nicht vor einem Plattenausfall');
    return { ok: true, free: await this.free(), warnings };
  }

  async ensureDir(relDir: string) {
    await mkdir(relDir ? this.localPath(relDir) : this.base, { recursive: true, mode: 0o700 });
  }

  async put(localFile: string, rel: string) {
    const out = this.localPath(rel);
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    const tmp = `${out}.part`;
    await copyFile(localFile, tmp);
    await chmod(tmp, 0o600);
    await rename(tmp, out);
  }

  async get(rel: string, localFile: string) {
    await copyFile(this.localPath(rel), localFile);
  }

  async remove(rel: string) {
    await rm(this.localPath(rel), { force: true });
  }

  async free(): Promise<number | null> {
    const s = await statfs(this.base).catch(() => null);
    return s ? s.bavail * s.bsize : null;
  }

  async listArchives(): Promise<{ path: string; size: number }[]> {
    const out: { path: string; size: number }[] = [];
    const folders = (await readdir(this.base, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    for (const d of folders.slice(0, SCAN_FOLDERS)) {
      for (const f of await readdir(join(this.base, d.name), { withFileTypes: true }).catch(() => [])) {
        if (!f.isFile() || !/\.zip$/i.test(f.name)) continue;
        const st = await stat(join(this.base, d.name, f.name)).catch(() => null);
        if (st) out.push({ path: `${d.name}/${f.name}`, size: st.size });
      }
    }
    return out;
  }
}

export class SmbDriver implements TargetDriver {
  constructor(private readonly smb: SmbClient) {}

  async test(): Promise<TestResult> {
    const dir = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-smbtest-'));
    const name = TEST_NAME();
    const data = randomBytes(64);
    try {
      await this.smb.ensureDir('');
      await writeFile(join(dir, 'up'), data);
      await this.smb.put(join(dir, 'up'), name);
      try {
        await this.smb.get(name, join(dir, 'down'));
        if (!(await readFile(join(dir, 'down'))).equals(data)) throw new TargetError('Die Probedatei kam verändert zurück');
      } finally {
        await this.smb.remove(name).catch(() => undefined);
      }
      return { ok: true, free: await this.smb.free().catch(() => null), warnings: [] };
    } catch (e) {
      if (e instanceof SmbError) throw new TargetError(e.message);
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  ensureDir(relDir: string) {
    return wrap(() => this.smb.ensureDir(relDir));
  }
  put(localFile: string, rel: string) {
    return wrap(() => this.smb.put(localFile, rel));
  }
  get(rel: string, localFile: string) {
    return wrap(() => this.smb.get(rel, localFile));
  }
  remove(rel: string) {
    return wrap(() => this.smb.remove(rel));
  }
  free() {
    return wrap(() => this.smb.free());
  }
  listArchives() {
    return wrap(async () => {
      const out: { path: string; size: number }[] = [];
      // Names smbclient cannot carry in quotes are no folders a run writes (safeName) – left out.
      const folders = (await this.smb.ls('')).filter((e) => e.dir && !e.name.startsWith('.') && !UNSAFE.test(e.name));
      for (const d of folders.slice(0, SCAN_FOLDERS)) {
        // A folder this account may not read is skipped, like on a local target – the others are still found.
        const files = await this.smb.ls(d.name, '*.zip').catch(() => []);
        for (const f of files) if (!f.dir && !UNSAFE.test(f.name)) out.push({ path: `${d.name}/${f.name}`, size: f.size });
      }
      return out;
    });
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof SmbError ? new TargetError(e.message) : e;
  }
}
