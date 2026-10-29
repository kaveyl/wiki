import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ActivityLog, DEFAULT_RETENTION, entryFor, redactInline, sanitize } from './activity.js';
import { backupDatabase, isoWeek, listBackups, rotate } from './backup.js';
import { openDb, type DB } from './db/db.js';

let db: DB;
let root: string;
beforeEach(() => {
  db = openDb(':memory:');
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-act-'));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('activity log', () => {
  it('never stores secrets: keys are dropped, inline credentials masked', () => {
    expect(sanitize({ user: 'anna', password: 'x', apiToken: 't', nested: { cookie: 'c', ok: 1 }, list: [{ secret: 's', n: 2 }] })).toEqual({
      user: 'anna',
      nested: { ok: 1 },
      list: [{ n: 2 }],
    });
    expect(redactInline('git clone https://mara:geheim@gitea.x/r.git')).toBe('git clone https://***@gitea.x/r.git');
    expect(redactInline('Authorization: token abc123def456')).toBe('Authorization: token ***');
    expect(redactInline('Token kw_ABCDEFGHIJKLMNOP gefunden')).toBe('Token kw_*** gefunden');
    const log = new ActivityLog(db);
    log.log({ category: 'error', action: 'sync', message: 'fetch https://a:b@host/x failed', detail: { token: 'zzz', files: 3 } });
    const [e] = log.list();
    expect(e).toMatchObject({ level: 'error', message: 'fetch https://***@host/x failed', detail: { files: 3 } });
    expect(JSON.stringify(db.prepare('SELECT * FROM activity').all())).not.toMatch(/zzz|a:b@/);
  });

  it('filters, pages, hides audit from non-admins and prunes by category', () => {
    const log = new ActivityLog(db);
    const m = { id: 'M1', name: 'Wiki' };
    log.log({ category: 'sync', action: 'pushed', message: 'a', mount: m });
    log.log({ category: 'error', action: 'sync-failed', message: 'b', mount: m });
    log.log({ category: 'audit', action: 'login', message: 'c', actor: 'admin' });
    log.log({ category: 'system', action: 'backup', message: 'd' });
    expect(log.list().map((e) => e.message)).toEqual(['d', 'b', 'a']);
    expect(log.list({ includeAudit: true }).map((e) => e.message)).toEqual(['d', 'c', 'b', 'a']);
    expect(log.list({ mountId: 'M1', problems: true }).map((e) => e.message)).toEqual(['b']);
    const newest = log.list({ includeAudit: true })[0]!.id;
    expect(log.list({ before: newest, limit: 1 }).map((e) => e.message)).toEqual(['b']);
    // 40 days later: info gone, problems + audit kept; 100 days: only audit; 400 days: nothing.
    const day = 86_400_000;
    expect(log.prune(DEFAULT_RETENTION, Date.now() + 40 * day)).toBe(2);
    expect(log.list({ includeAudit: true }).map((e) => e.message)).toEqual(['c', 'b']);
    expect(log.prune(DEFAULT_RETENTION, Date.now() + 100 * day)).toBe(1);
    expect(log.prune(DEFAULT_RETENTION, Date.now() + 400 * day)).toBe(1);
  });

  it('names note paths only to readers of all of them; unknown or cut-off path lists count as unreadable (sec-004)', () => {
    const log = new ActivityLog(db);
    const m = { id: 'M1', name: 'Wiki' };
    const many = Array.from({ length: 60 }, (_, i) => `team/n${i}.md`);
    log.log({ category: 'sync', action: 'synced', mount: m, message: '2 Dateien vom Server geholt', detail: { pushed: 0, incoming: ['M a.md', 'M geheim/b.md'], paths: ['a.md', 'geheim/b.md'] } });
    log.log({ category: 'sync', action: 'conflict-resolved', mount: m, message: 'Konflikt aufgelöst: a.md', detail: { paths: ['a.md'] } });
    log.log({ category: 'sync', action: 'conflict-resolved', mount: m, message: 'Konflikt aufgelöst: alt.md' });
    log.log({ category: 'sync', action: 'committed', mount: m, message: 'Commit 1234567: docs: 60 Notizen bearbeitet', detail: { paths: many } });
    log.log({ category: 'sync', action: 'recovered', mount: m, message: 'Wieder synchron' });
    const mayRead = (p: string) => !p.startsWith('geheim/');
    const list = log.list();
    const [recovered, committed, legacy, resolved, synced] = [list[0]!, list[1]!, list[2]!, list[3]!, list[4]!];
    expect(entryFor(recovered, mayRead)).toBe(recovered);
    expect(entryFor(committed, () => true)).toBeNull();
    expect(entryFor(legacy, () => true)).toBeNull();
    expect(entryFor(resolved, mayRead)).toBe(resolved);
    expect(entryFor(synced, () => true)).toBe(synced);
    expect(entryFor(synced, mayRead)).toMatchObject({ message: '2 Dateien vom Server geholt', detail: { pushed: 0 } });
    expect(JSON.stringify(entryFor(synced, mayRead))).not.toContain('geheim');
  });
});

describe('database backup', () => {
  it('writes consistent, private copies and keeps 7 daily + 4 weekly', async () => {
    const file = join(root, 'live.db');
    const live = openDb(file);
    live.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    const dir = join(root, 'backups');
    // A Sunday writes daily + weekly.
    expect(await backupDatabase(live, dir, new Date(2026, 9, 4, 3))).toEqual(['daily-2026-10-04.db', `weekly-${isoWeek(new Date(2026, 9, 4))}.db`]);
    expect(await backupDatabase(live, dir, new Date(2026, 9, 5, 3))).toEqual(['daily-2026-10-05.db']);
    const copy = new Database(join(dir, 'daily-2026-10-05.db'), { readonly: true });
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toEqual({ value: 'v' });
    copy.close();
    expect(statSync(join(dir, 'daily-2026-10-05.db')).mode & 0o777).toBe(0o600);
    live.close();

    for (let d = 1; d <= 20; d++) writeFileSync(join(dir, `daily-2026-09-${String(d).padStart(2, '0')}.db`), '');
    for (let w = 30; w <= 38; w++) writeFileSync(join(dir, `weekly-2026-W${w}.db`), '');
    writeFileSync(join(dir, 'fremd.txt'), 'bleibt');
    await rotate(dir);
    const left = readdirSync(dir).sort();
    expect(left.filter((n) => n.startsWith('daily-'))).toEqual([
      'daily-2026-09-16.db', 'daily-2026-09-17.db', 'daily-2026-09-18.db', 'daily-2026-09-19.db', 'daily-2026-09-20.db', 'daily-2026-10-04.db', 'daily-2026-10-05.db',
    ]);
    expect(left.filter((n) => n.startsWith('weekly-'))).toEqual(['weekly-2026-W36.db', 'weekly-2026-W37.db', 'weekly-2026-W38.db', 'weekly-2026-W40.db']);
    expect(left).toContain('fremd.txt');
    expect((await listBackups(dir)).length).toBe(11);
  });

  it('computes ISO weeks', () => {
    expect(isoWeek(new Date(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeek(new Date(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeek(new Date(2026, 9, 5))).toBe('2026-W41');
  });
});
