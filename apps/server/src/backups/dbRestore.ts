// Database back from a backup in the first-run setup (AD-075): the upload (the ZIP of a database backup from a target,
// with its backup password, or a plain kaveyl-wiki.db) is checked – a Kaveyl Wiki database, not newer than this program,
// with an active administrator – and staged in <config>/restore. The swap happens at the next start, before the
// database is opened: no open handle is replaced under a running server. The database from before goes to backups/.
// SEE-DOC: DECISIONS.md AD-075

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freshDatabase, schemaAt, SCHEMA_VERSION } from '../db/db.js';
import { removeSetupCode } from '../auth/setupCode.js';
import { Archive, ArchiveError } from './archive.js';

export class RestoreError extends Error {
  readonly statusCode = 400;
}

/** Where an upload waits and a checked database is staged for the next start. */
export const RESTORE_DIR = 'restore';
/** Largest upload taken (a database with a big search index stays far below). */
export const RESTORE_LIMIT = 4 * 1024 ** 3;

const DB_NAME = 'kaveyl-wiki.db';
const KEY_NAME = 'secret.key';
const READY = 'ready.json';

export interface RestoreInfo {
  /** Schema version of the database from the backup. */
  version: number;
  users: number;
  admins: number;
  /** The backup brought the key for the stored credentials (only encrypted targets have it). */
  key: boolean;
}

const notOurs = () => new RestoreError('Das ist keine Datenbank von Kaveyl Wiki');

/** Checks a database file from a backup; throws a RestoreError saying what does not fit. */
export function checkDatabase(file: string): Omit<RestoreInfo, 'key'> {
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    throw new RestoreError('Die Datei ist keine lesbare Datenbank');
  }
  try {
    // Nothing in the file's schema may run code while it is read.
    db.pragma('trusted_schema = OFF');
    let check: unknown;
    try {
      check = db.pragma('quick_check', { simple: true });
    } catch {
      throw new RestoreError('Die Datei ist keine lesbare Datenbank');
    }
    if (check !== 'ok') throw new RestoreError('Die Datenbank ist beschädigt');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < 1) throw notOurs();
    if (version > SCHEMA_VERSION)
      throw new RestoreError(`Die Sicherung stammt von einer neueren Version von Kaveyl Wiki (Datenbank v${version}, dieses Programm kennt v${SCHEMA_VERSION}) – zuerst die neuere Version installieren`);
    const have = db.prepare('SELECT type, name, sql FROM sqlite_master').all() as { type: string; name: string; sql: string | null }[];
    const want = schemaAt(version);
    const wanted = new Map(want.map((o) => [`${o.type}:${o.name}`, o.sql]));
    // Kaveyl Wiki has no triggers or views, and its virtual tables (search) are always the same – anything else is foreign.
    for (const o of have) {
      const isVirtual = o.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(o.sql ?? '');
      if (o.type === 'trigger' || o.type === 'view' || (isVirtual && wanted.get(`table:${o.name}`) !== o.sql)) throw notOurs();
    }
    const names = new Set(have.map((o) => `${o.type}:${o.name}`));
    if (want.some((o) => o.type === 'table' && !names.has(`table:${o.name}`))) throw notOurs();
    // Every table with the columns of that version – also their defaults (`is_admin DEFAULT 1` would make admins).
    const columns = (d: Database.Database, table: string) => JSON.stringify(d.prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid').all(table));
    const fresh = freshDatabase(version);
    try {
      for (const o of want) if (o.type === 'table' && !/^CREATE VIRTUAL TABLE/i.test(o.sql ?? '') && columns(db, o.name) !== columns(fresh, o.name)) throw notOurs();
    } finally {
      fresh.close();
    }
    const cols = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
    const users = (db.prepare('SELECT count(*) n FROM users').get() as { n: number }).n;
    const admins = (db.prepare(`SELECT count(*) n FROM users WHERE is_admin = 1${cols.has('disabled') ? ' AND disabled = 0' : ''}`).get() as { n: number }).n;
    if (!admins) throw new RestoreError('Die Sicherung enthält kein aktives Administrator-Konto – damit könnte sich niemand anmelden');
    return { version, users, admins };
  } finally {
    db.close();
  }
}

/** A key file as SecretStore writes it: 32 bytes, base64. */
const validKey = (text: string) => Buffer.from(text.trim(), 'base64').length === 32 && /^[A-Za-z0-9+/=\s]+$/.test(text);

/**
 * Checks the uploaded file and stages it for the next start. `upload` lies in <config>/restore and is used up.
 * `password`: the backup password of an encrypted ZIP.
 */
export async function stageDbRestore(upload: string, configPath: string, password: string | null): Promise<RestoreInfo> {
  const dir = join(configPath, RESTORE_DIR);
  const dbFile = join(dir, `${DB_NAME}.neu`);
  const keyFile = join(dir, `${KEY_NAME}.neu`);
  await Promise.all([dbFile, keyFile, join(dir, READY)].map((f) => rm(f, { force: true })));
  const head = Buffer.alloc(16);
  const fh = await open(upload, 'r');
  try {
    await fh.read(head, 0, 16, 0);
  } finally {
    await fh.close();
  }
  let key = false;
  try {
    if (head.toString('latin1') === 'SQLite format 3\0') {
      // A backup password belongs to an encrypted ZIP: a plain database with one is not what was meant (sec-002 0.2.7).
      if (password) throw new RestoreError('Eine kaveyl-wiki.db ist nicht verschlüsselt – das Backup-Passwort gehört zur ZIP-Datei eines verschlüsselten Ziels');
      await rename(upload, dbFile);
    }
    else if (head.subarray(0, 2).toString('latin1') === 'PK') {
      let zip: Archive;
      try {
        zip = await Archive.open(upload, password);
      } catch (e) {
        if (!(e instanceof ArchiveError)) throw new RestoreError('Die ZIP-Datei lässt sich nicht lesen');
        if (e.code !== 'backup-password') throw new RestoreError(e.message);
        throw new RestoreError(password ? 'Das Backup-Passwort passt nicht zu dieser Sicherung' : 'Die Sicherung ist verschlüsselt – bitte das Backup-Passwort angeben');
      }
      try {
        const size = zip.size(DB_NAME);
        if (size === null) throw new RestoreError('In der ZIP-Datei ist keine Datenbank-Sicherung (kaveyl-wiki.db fehlt) – die Sicherung aus dem Ordner „kaveyl-wiki-datenbank“ nehmen');
        if (size > RESTORE_LIMIT) throw new RestoreError('Die Datenbank in der Sicherung ist zu groß');
        await zip.extract(DB_NAME, dbFile);
        const keySize = zip.size(KEY_NAME);
        if (keySize !== null && keySize < 1024) {
          await zip.extract(KEY_NAME, keyFile);
          key = validKey(await readFile(keyFile, 'utf8'));
          if (!key) await rm(keyFile, { force: true });
        }
      } finally {
        await zip.close();
      }
    } else throw new RestoreError('Erwartet: die ZIP-Datei einer Datenbank-Sicherung oder kaveyl-wiki.db');
    const info = checkDatabase(dbFile);
    await writeFile(join(dir, READY), JSON.stringify({ ...info, key }), { mode: 0o600 });
    return { ...info, key };
  } catch (e) {
    await Promise.all([dbFile, keyFile].map((f) => rm(f, { force: true })));
    throw e;
  } finally {
    await rm(upload, { force: true });
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * At the start, before the database is opened: a staged database replaces the live one (which goes to backups/ as
 * `manuell-vor-wiederherstellung-…`, falling under the rule for hand-made copies), with its key if the backup had one
 * (a key from KAVEYL_WIKI_SECRET_KEY still wins – SecretStore).
 * Returns what came back, null when nothing was staged.
 */
export function applyDbRestore(configPath: string, liveDb: string): RestoreInfo | null {
  const dir = join(configPath, RESTORE_DIR);
  const ready = join(dir, READY);
  const dbFile = join(dir, `${DB_NAME}.neu`);
  if (!existsSync(ready) || !existsSync(dbFile)) {
    // An upload cut off by a restart: nothing to apply.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const info = JSON.parse(readFileSync(ready, 'utf8')) as RestoreInfo;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const backups = join(configPath, 'backups');
  mkdirSync(backups, { recursive: true });
  if (existsSync(liveDb)) renameSync(liveDb, join(backups, `manuell-vor-wiederherstellung-${stamp}.db`));
  for (const x of ['-wal', '-shm']) rmSync(`${liveDb}${x}`, { force: true });
  renameSync(dbFile, liveDb);
  const keyFile = join(dir, `${KEY_NAME}.neu`);
  // The key replaced belongs to the database of a setup without accounts – it encrypts nothing worth keeping.
  if (info.key && existsSync(keyFile)) writeFileSync(join(configPath, KEY_NAME), readFileSync(keyFile), { mode: 0o600 });
  rmSync(dir, { recursive: true, force: true });
  removeSetupCode(configPath);
  return info;
}
