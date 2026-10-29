import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, listBackups, pruneManual } from './backup.js';
import { compactDb, DEFAULT_RULES, dbUsage, ORPHAN_MARK, pruneOrphanClones, pruneTempDirs, readRules, scanOrphanClones, writeRules } from './cleanup.js';
import { openDb, type DB } from './db/db.js';
import { git } from './git/git.js';

const DAY = 86_400_000;
const ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };

let root: string;
let db: DB;
const settings = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), m };
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-cleanup-test-'));
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Löschregeln', () => {
  it('has a default for everything that grows and keeps values within their range', () => {
    const s = settings();
    expect(readRules(s)).toEqual(DEFAULT_RULES);
    expect(DEFAULT_RULES).toMatchObject({ logInfoDays: 30, logProblemDays: 90, logAuditDays: 365, trashDays: 30, aiChatDays: 90, backupDaily: 7, backupWeekly: 4, orphanCloneDays: 30 });
    // Earlier settings keys stay in force.
    s.set('trash_days', '0');
    s.set('retention_info_days', '14');
    expect(readRules(s)).toMatchObject({ trashDays: 0, logInfoDays: 14 });
    // Clamped on write; junk ignored; 0 only where „nie“ is allowed.
    const r = writeRules(s, { logInfoDays: 0, backupDaily: 1000, aiChatDays: 'x', orphanCloneDays: 0, foo: 3 });
    expect(r).toMatchObject({ logInfoDays: 1, backupDaily: 90, aiChatDays: 90, orphanCloneDays: 0 });
    expect(s.m.has('foo')).toBe(false);
    // A broken stored value falls back to the default.
    s.set('backup_keep_weekly', 'kaputt');
    expect(readRules(s).backupWeekly).toBe(4);
  });
});

describe('database backups', () => {
  it('rotates by the configured counts and removes old manual copies', async () => {
    const dir = join(root, 'backups');
    for (let i = 0; i < 5; i++) await backupDatabase(db, dir, new Date(2026, 0, 4 + i * 7), { keepDaily: 2, keepWeekly: 3 });
    const kinds = (await listBackups(dir)).map((b) => b.kind);
    expect(kinds.filter((k) => k === 'daily')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'weekly')).toHaveLength(3);
    writeFileSync(join(dir, 'manuell-vor-migration-v14.db'), 'x');
    writeFileSync(join(dir, 'manuell-neu.db'), 'x');
    writeFileSync(join(dir, 'notiz.txt'), 'kein Backup');
    const old = (Date.now() - 100 * DAY) / 1000;
    utimesSync(join(dir, 'manuell-vor-migration-v14.db'), old, old);
    expect((await listBackups(dir)).filter((b) => b.kind === 'manual').map((b) => b.name).sort()).toEqual(['manuell-neu.db', 'manuell-vor-migration-v14.db']);
    expect(await pruneManual(dir, 0)).toEqual([]);
    expect(await pruneManual(dir, 90)).toEqual(['manuell-vor-migration-v14.db']);
    expect(existsSync(join(dir, 'manuell-neu.db'))).toBe(true);
    expect(existsSync(join(dir, 'notiz.txt'))).toBe(true);
  });
});

describe('orphaned clones', () => {
  it('marks clones nobody uses, saves them as a bundle (with uncommitted files) and removes them after the rule', async () => {
    const repos = join(root, 'repos');
    const bundles = join(root, 'bundles');
    const used = join(repos, 'aktiv');
    const orphan = join(repos, 'f00.alt-2026-10-05T22-37-24-776Z');
    for (const d of [used, orphan]) {
      mkdirSync(d, { recursive: true });
      await git(d, ['init', '-q', '-b', 'main']);
      writeFileSync(join(d, 'a.md'), '# A\n');
      await git(d, ['add', '-A']);
      await git(d, ['commit', '-q', '-m', 'eins'], { env: ENV });
    }
    writeFileSync(join(orphan, 'ungesichert.md'), 'nicht committet\n');
    mkdirSync(join(repos, 'kein-git'));
    const t0 = new Date('2026-10-11T03:00:00Z');
    const inUse = new Set([used]);

    // First sighting: marked, nothing removed.
    const seen = await scanOrphanClones(repos, inUse, t0);
    expect(seen.map((o) => o.name).sort()).toEqual(['f00.alt-2026-10-05T22-37-24-776Z', 'kein-git']);
    expect(readFileSync(join(orphan, '.git', ORPHAN_MARK), 'utf8').trim()).toBe(t0.toISOString());
    expect(existsSync(join(used, '.git', ORPHAN_MARK))).toBe(false);
    expect((await pruneOrphanClones(repos, inUse, 30, bundles, new Date(t0.getTime() + 29 * DAY))).removed).toEqual([]);
    // „nie“ keeps them.
    expect((await pruneOrphanClones(repos, inUse, 0, bundles, new Date(t0.getTime() + 400 * DAY))).removed).toEqual([]);

    const res = await pruneOrphanClones(repos, inUse, 30, bundles, new Date(t0.getTime() + 31 * DAY));
    expect(res.removed.map((r) => r.name)).toEqual(['f00.alt-2026-10-05T22-37-24-776Z']);
    expect(res.skipped.map((r) => r.name)).toEqual(['kein-git']);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(used)).toBe(true);
    // The bundle holds everything, also what was never committed.
    const bundle = join(bundles, res.removed[0]!.bundle!);
    const back = join(root, 'zurück');
    await git(root, ['clone', '-q', bundle, back]);
    expect(readFileSync(join(back, 'ungesichert.md'), 'utf8')).toBe('nicht committet\n');

    // A clone in use again loses its mark (its count starts over when it is orphaned later).
    await scanOrphanClones(repos, new Set(), t0);
    expect(existsSync(join(used, '.git', ORPHAN_MARK))).toBe(true);
    await scanOrphanClones(repos, inUse, t0);
    expect(existsSync(join(used, '.git', ORPHAN_MARK))).toBe(false);
  });
});

describe('database file and temp folders', () => {
  it('compacts only when much is free', () => {
    db.exec('CREATE TABLE junk (x BLOB)');
    const ins = db.prepare('INSERT INTO junk VALUES (randomblob(4000))');
    for (let i = 0; i < 1000; i++) ins.run();
    expect(compactDb(db)).toBe(0);
    db.exec('DELETE FROM junk');
    expect(dbUsage(db).free).toBeGreaterThan(1024 * 1024);
    expect(compactDb(db)).toBeGreaterThan(1024 * 1024);
    expect(dbUsage(db).free).toBe(0);
  });

  it('removes Kaveyl Wiki temp folders older than a day, nothing else', async () => {
    const tmp = join(root, 'tmp');
    for (const n of ['kaveyl-wiki-diff-alt', 'kaveyl-wiki-diff-neu', 'fremd-alt']) mkdirSync(join(tmp, n), { recursive: true });
    const old = (Date.now() - 2 * DAY) / 1000;
    utimesSync(join(tmp, 'kaveyl-wiki-diff-alt'), old, old);
    utimesSync(join(tmp, 'fremd-alt'), old, old);
    expect(await pruneTempDirs(Date.now(), tmp)).toBe(1);
    expect(readdirSync(tmp).sort()).toEqual(['fremd-alt', 'kaveyl-wiki-diff-neu']);
  });
});
