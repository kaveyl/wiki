// Messages about followed changes (AD-068): the person's rhythm, the limits per hour and day – which delay, never drop –
// and a queue in the database that outlives a restart.
import { describe, expect, it, vi } from 'vitest';
import { openDb } from './db/db.js';
import type { Change } from './changes.js';
import { dueAt, Follows, type FollowDeps } from './follows.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (s: string) => new Date(s).getTime();

describe('dueAt', () => {
  const base = { bundleMs: 2 * MIN, sent: [] as number[], perDay: 100 };
  it('bundled: two minutes after the first change', () => {
    const first = at('2026-10-25T10:00:00');
    expect(dueAt({ ...base, first, rhythm: 'bundled', now: first })).toBe(first + 2 * MIN);
  });
  it('hourly: an hour after the last message, never before the bundle', () => {
    const last = at('2026-10-25T10:00:00');
    expect(dueAt({ ...base, first: at('2026-10-25T10:10:00'), rhythm: 'hourly', sent: [last], now: at('2026-10-25T10:10:00') })).toBe(last + HOUR);
    expect(dueAt({ ...base, first: at('2026-10-25T12:00:00'), rhythm: 'hourly', sent: [last], now: at('2026-10-25T12:00:00') })).toBe(at('2026-10-25T12:02:00'));
  });
  it('daily: at the time the person chose', () => {
    expect(dueAt({ ...base, first: at('2026-10-25T08:00:00'), rhythm: 'daily', dailyAt: '18:30', now: at('2026-10-25T08:00:00') })).toBe(at('2026-10-25T18:30:00'));
    expect(dueAt({ ...base, first: at('2026-10-25T19:00:00'), rhythm: 'daily', dailyAt: '18:30', now: at('2026-10-25T19:00:00') })).toBe(at('2026-10-26T18:30:00'));
  });
  it('daily: the next 7:00 (server time)', () => {
    expect(dueAt({ ...base, first: at('2026-10-25T08:00:00'), rhythm: 'daily', now: at('2026-10-25T08:00:00') })).toBe(at('2026-10-26T07:00:00'));
    expect(dueAt({ ...base, first: at('2026-10-25T06:30:00'), rhythm: 'daily', now: at('2026-10-25T06:30:00') })).toBe(at('2026-10-25T07:00:00'));
  });
  it('limits delay until the oldest message of the full window drops out', () => {
    const now = at('2026-10-25T10:30:00');
    const hour = Array.from({ length: 20 }, (_, i) => at('2026-10-25T09:45:00') + i * MIN);
    expect(dueAt({ ...base, first: now, rhythm: 'bundled', sent: hour, now })).toBe(at('2026-10-25T10:45:00'));
    const day = [at('2026-10-25T01:00:00'), at('2026-10-25T05:00:00'), at('2026-10-25T09:00:00')];
    // 24 real hours (25.10. is the change from summer time – the wall clock would say 00:00).
    expect(dueAt({ ...base, first: now, rhythm: 'bundled', sent: day, perDay: 3, now })).toBe(day[0]! + 24 * HOUR);
  });
});

function setup(db = openDb(':memory:')) {
  db.pragma('foreign_keys = OFF');
  const mails: { to: string; subject: string; text: string }[] = [];
  const deps: FollowDeps = {
    person: (id) => ({ id, email: `${id}@example.test`, displayName: id, disabled: false }),
    readable: () => true,
    mountName: () => 'Wiki',
    emit: () => {},
    mail: { configured: () => true, send: async (m) => void mails.push(m), langOf: () => undefined, publicUrl: () => '' },
    pushover: async () => {},
    failed: () => {},
    fallbackLang: () => 'de',
  };
  const follows = new Follows(db, deps, 1000);
  follows.set('eva', { mountId: 'm', path: '', isDir: true, badge: false, mail: true, pushover: false });
  return { db, follows, mails, deps };
}
let seq = 0;
const change = (path: string): Change => ({ seq: ++seq, at: new Date().toISOString(), mountId: 'm', path, kind: 'changed', by: { id: 'anna', name: 'Anna' }, via: 'app' });

describe('Follows', () => {
  it('sends in the rhythm: nothing before it is due, everything in one message after', async () => {
    const { follows, mails } = setup();
    follows.onChanges([change('a.md'), change('b.md')]);
    await follows.tick(Date.now());
    expect(mails).toHaveLength(0);
    await follows.tick(Date.now() + 5000);
    expect(mails.map((m) => m.subject)).toEqual(['Kaveyl Wiki: 2 Änderungen in Beobachtetem']);
    follows.stop();
  });

  it('a restart keeps what waits: a new instance on the same database sends it', async () => {
    const { db, follows, deps } = setup();
    follows.onChanges([change('a.md')]);
    follows.stop();
    const mails: { subject: string }[] = [];
    const again = new Follows(db, { ...deps, mail: { ...deps.mail, send: async (m) => void mails.push(m) } }, 1000);
    await again.tick(Date.now() + 5000);
    expect(mails.map((m) => m.subject)).toEqual(['Kaveyl Wiki: Neues in „a“']);
    again.stop();
  });

  it('over the daily limit nothing is lost: the next allowed message brings it', async () => {
    const { follows, mails } = setup();
    follows.setPerDay(1);
    follows.onChanges([change('a.md')]);
    const t1 = Date.now() + 5000;
    await follows.tick(t1);
    follows.onChanges([change('b.md')]);
    await follows.tick(t1 + 10 * MIN);
    expect(mails).toHaveLength(1);
    const next = follows.nextFor('eva', t1 + 10 * MIN)!;
    expect(next).toBe(t1 + 24 * HOUR);
    await follows.tick(next);
    expect(mails).toHaveLength(2);
    expect(mails[1]!.text).toContain('Wiki: b.md – geändert (Anna)');
    follows.stop();
  });

  it('the rhythm and the daily limit are stored; unknown values fall back', () => {
    const { follows, db } = setup();
    expect(follows.rhythm('eva')).toBe('bundled');
    follows.setRhythm('eva', 'daily');
    expect(follows.rhythm('eva')).toBe('daily');
    db.prepare("UPDATE user_state SET value_json = '\"sometimes\"' WHERE user_id = 'eva' AND key = 'notifyRhythm'").run();
    expect(follows.rhythm('eva')).toBe('bundled');
    expect(follows.dailyAt('eva')).toBe('07:00');
    follows.setDailyAt('eva', '18:30');
    expect(follows.dailyAt('eva')).toBe('18:30');
    expect(() => follows.setDailyAt('eva', '25:00')).toThrow();
    expect(follows.perDay()).toBe(100);
    expect(() => follows.setPerDay(0)).toThrow();
    follows.stop();
  });
});

describe('Follows: what is followed moves along (code-001)', () => {
  const moved = (path: string, from: string): Change => ({ ...change(path), kind: 'moved', from });
  const waiting = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT COUNT(*) AS n FROM follow_queue WHERE user_id = 'tom'").get() as { n: number }).n;
  const followed = (follows: Follows) => follows.list('tom').map((w) => w.path).sort();

  it('a followed note, its folder and a folder above it – the next change at the new place arrives', () => {
    const { db, follows } = setup();
    follows.set('tom', { mountId: 'm', path: 'Team/Plan.md', isDir: false, badge: false, mail: true, pushover: false });
    follows.set('tom', { mountId: 'm', path: 'Team/Vorfälle', isDir: true, badge: false, mail: true, pushover: false });
    follows.set('tom', { mountId: 'm', path: 'Teamwork.md', isDir: false, badge: false, mail: true, pushover: false });
    // The note itself.
    follows.moved('m', 'Team/Plan.md', 'Team/Plan 2026.md');
    expect(followed(follows)).toEqual(['Team/Plan 2026.md', 'Team/Vorfälle', 'Teamwork.md']);
    follows.onChanges([change('Team/Plan 2026.md')]);
    expect(waiting(db)).toBe(1);
    // The folder itself.
    follows.moved('m', 'Team/Vorfälle', 'Team/Incidents');
    expect(followed(follows)).toEqual(['Team/Incidents', 'Team/Plan 2026.md', 'Teamwork.md']);
    follows.onChanges([change('Team/Incidents/Platte.md')]);
    expect(waiting(db)).toBe(2);
    // A folder above both; a name that only starts the same („Teamwork.md“) stays.
    follows.moved('m', 'Team', 'Archiv/Team');
    expect(followed(follows)).toEqual(['Archiv/Team/Incidents', 'Archiv/Team/Plan 2026.md', 'Teamwork.md']);
    follows.onChanges([change('Archiv/Team/Plan 2026.md'), change('Archiv/Team/Incidents/Platte.md')]);
    expect(waiting(db)).toBe(4);
    follows.stop();
  });

  it('into another source; a rename outside (only a note) moves along, too', () => {
    const { follows } = setup();
    follows.set('tom', { mountId: 'm', path: 'Plan.md', isDir: false, badge: true, mail: false, pushover: false });
    follows.set('tom', { mountId: 'm', path: 'Ordner', isDir: true, badge: true, mail: false, pushover: false });
    follows.moved('m', 'Ordner', 'Neu/Ordner', 'n');
    expect(follows.list('tom').map((w) => `${w.mountId}:${w.path}`).sort()).toEqual(['m:Plan.md', 'n:Neu/Ordner']);
    follows.onChanges([moved('Plan 2026.md', 'Plan.md')]);
    follows.moved('m', 'Plan.md', 'Plan 2026.md');
    follows.onChanges([change('Plan 2026.md')]);
    expect(followed(follows)).toEqual(['Neu/Ordner', 'Plan 2026.md']);
    expect(follows.unread('tom').map((u) => u.path)).toEqual(['Plan 2026.md']);
    follows.stop();
  });

  it('a removed source: what was followed there, its dots and waiting messages go', () => {
    const { db, follows } = setup();
    follows.set('tom', { mountId: 'm', path: 'Plan.md', isDir: false, badge: true, mail: true, pushover: false });
    follows.set('tom', { mountId: 'n', path: '', isDir: true, badge: true, mail: false, pushover: false });
    follows.onChanges([change('Plan.md')]);
    expect(waiting(db)).toBe(1);
    follows.mountRemoved('m');
    expect(follows.list('tom').map((w) => w.mountId)).toEqual(['n']);
    expect(follows.list('eva')).toEqual([]);
    expect(follows.unread('tom')).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM follow_queue').get() as { n: number }).n).toBe(0);
    follows.stop();
  });
});

describe('Follows: the old path of a move only when it may be read (sec-001)', () => {
  const moved = (path: string, from: string): Change => ({ ...change(path), kind: 'moved', from });
  const hidden: FollowDeps['readable'] = (_u, _m, p) => !p.startsWith('Geheim');

  it('a note moved out of a folder the person may not read: e-mail and Pushover without the old path', async () => {
    const pushes: string[] = [];
    const { follows, mails, deps } = setup();
    deps.readable = hidden;
    deps.pushover = async (_u, _t, message) => void pushes.push(message);
    follows.set('tom', { mountId: 'm', path: 'Team', isDir: true, badge: false, mail: true, pushover: true });
    follows.onChanges([moved('Team/x.md', 'Geheim/Kuendigung-Max.md'), moved('Team/y.md', 'Team/alt/y.md')]);
    await follows.flush();
    const text = mails.find((m) => m.to === 'tom@example.test')!.text;
    expect(text).not.toContain('Geheim');
    expect(text).toContain('Wiki: Team/x.md – verschoben (Anna)');
    expect(text).toContain('Wiki: Team/y.md – verschoben von Team/alt/y.md (Anna)');
    expect(pushes.join('\n')).not.toContain('Geheim');
    follows.stop();
  });

  it('following the old place counts only while it may be read', async () => {
    const { follows, mails, deps } = setup();
    deps.readable = hidden;
    follows.set('tom', { mountId: 'm', path: 'Geheim', isDir: true, badge: true, mail: true, pushover: false });
    follows.onChanges([moved('Team/x.md', 'Geheim/Kuendigung-Max.md')]);
    await follows.flush();
    expect(mails.filter((m) => m.to === 'tom@example.test')).toEqual([]);
    expect(follows.unread('tom')).toEqual([]);
    follows.stop();
  });
});

describe('Follows: many changes at once (code-002)', () => {
  it('the schedule is worked out once per batch, not once per message', () => {
    const { db, follows } = setup();
    for (let u = 0; u < 5; u++) follows.set(`u${u}`, { mountId: 'm', path: '', isDir: true, badge: true, mail: true, pushover: false });
    const nextFor = vi.spyOn(follows, 'nextFor');
    follows.onChanges(Array.from({ length: 500 }, (_, i) => change(`ordner/n${i}.md`)));
    expect((db.prepare('SELECT COUNT(*) AS n FROM follow_queue').get() as { n: number }).n).toBe(6 * 500);
    expect(follows.unread('u0')).toHaveLength(500);
    // One look per person waiting (eva + 5), not 3000 × 6.
    expect(nextFor.mock.calls.length).toBeLessThanOrEqual(6);
    follows.stop();
  });
});

describe('Follows: marking as read (Hinweis Fixer)', () => {
  it('a folder marks exactly itself and what is below it – case-sensitive, % and _ literal', () => {
    const { db, follows } = setup();
    const add = db.prepare("INSERT INTO unread (user_id, mount_id, path, kind, by_name, at) VALUES ('eva', 'm', ?, 'changed', 'Anna', '2026-10-26T10:00:00Z')");
    for (const p of ['Plan', 'Plan/a.md', 'plan/b.md', 'PLAN/c.md', 'Planung/d.md', 'Pl%n/e.md', 'Pl_n/f.md', 'Plxn/g.md']) add.run(p);
    const left = () => follows.unread('eva').map((u) => u.path).sort();
    follows.markRead('eva', 'm', 'Plan');
    expect(left()).toEqual(['PLAN/c.md', 'Pl%n/e.md', 'Pl_n/f.md', 'Planung/d.md', 'Plxn/g.md', 'plan/b.md']);
    follows.markRead('eva', 'm', 'Pl_n');
    follows.markRead('eva', 'm', 'Pl%n/');
    expect(left()).toEqual(['PLAN/c.md', 'Planung/d.md', 'Plxn/g.md', 'plan/b.md']);
    follows.stop();
  });
});

describe('Follows: one waiting message per note (v23)', () => {
  it('saving the same note again replaces its waiting message; created stays „created“, the wait counts from the first', async () => {
    const { db, follows, mails } = setup();
    follows.onChanges([{ ...change('ordner/neu.md'), kind: 'created' }]);
    const first = (db.prepare('SELECT at FROM follow_queue').get() as { at: number }).at;
    for (let i = 0; i < 50; i++) follows.onChanges([change('ordner/neu.md'), change('ordner/alt.md')]);
    expect(db.prepare('SELECT path, at FROM follow_queue ORDER BY id').all()).toEqual([
      { path: 'ordner/neu.md', at: first },
      { path: 'ordner/alt.md', at: expect.any(Number) },
    ]);
    await follows.flush();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toMatch(/neu\.md[^\n]*angelegt/);
    expect(mails[0]!.text).not.toMatch(/neu\.md[^\n]*geändert/);
    follows.stop();
  });

  it('the migration folds a queue from before into one row per note', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-v23-'));
    let db = openDb(join(dir, 'k.db'));
    for (const u of ['eva', 'tom']) db.prepare("INSERT INTO users (id, username, display_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, 'x', '')").run(u, u, u, `${u}@example.test`);
    db.exec(`DROP TABLE follow_queue;
      CREATE TABLE follow_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        change_json TEXT NOT NULL, mail INTEGER NOT NULL, pushover INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX follow_queue_user ON follow_queue (user_id);`);
    const add = db.prepare('INSERT INTO follow_queue (user_id, change_json, mail, pushover, at) VALUES (?, ?, ?, ?, ?)');
    add.run('eva', JSON.stringify({ ...change('a.md'), kind: 'created' }), 1, 0, 100);
    add.run('eva', JSON.stringify({ ...change('a.md'), by: { id: 'tom', name: 'Tom' } }), 0, 1, 200);
    add.run('eva', JSON.stringify(change('b.md')), 1, 0, 300);
    add.run('tom', JSON.stringify(change('a.md')), 1, 0, 400);
    db.pragma('user_version = 22');
    db.close();
    db = openDb(join(dir, 'k.db'));
    const rows = (db.prepare('SELECT user_id, path, change_json, mail, pushover, at FROM follow_queue ORDER BY id').all() as { user_id: string; path: string; change_json: string; mail: number; pushover: number; at: number }[]).map(
      (r) => ({ ...r, change_json: undefined, kind: (JSON.parse(r.change_json) as Change).kind, by: (JSON.parse(r.change_json) as Change).by?.name }),
    );
    expect(rows).toEqual([
      { user_id: 'eva', path: 'a.md', change_json: undefined, kind: 'created', by: 'Tom', mail: 1, pushover: 1, at: 100 },
      { user_id: 'eva', path: 'b.md', change_json: undefined, kind: 'changed', by: 'Anna', mail: 1, pushover: 0, at: 300 },
      { user_id: 'tom', path: 'a.md', change_json: undefined, kind: 'changed', by: 'Anna', mail: 1, pushover: 0, at: 400 },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'follow_queue' AND name = 'follow_queue_due'").get()).toBeTruthy();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
