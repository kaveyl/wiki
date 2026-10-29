// „Beobachten“ (AD-066): a person follows a note, a folder or a whole source and learns about changes others make there –
// as a dot in the tree (until they open the note), by e-mail and/or Pushover. Messages wait in the database and go out
// in the person's rhythm (AD-068): bundled every 2 minutes, at most hourly, or a daily summary at a time they choose; limits per hour
// and per day (the admin's) only delay them – the next message brings everything. Only what the person may read
// counts, never their own changes.
import type { DB } from './db/db.js';
import type { Change } from './changes.js';
import type { Lang } from '@kaveyl-wiki/core';
import { tr, translateLines } from './i18n/index.js';

export interface WatchInput {
  mountId: string;
  /** '' = the whole source. */
  path: string;
  isDir: boolean;
  badge: boolean;
  mail: boolean;
  pushover: boolean;
}

export interface Watch extends WatchInput {
  createdAt: string;
}

export interface Unread {
  mountId: string;
  path: string;
  kind: Change['kind'];
  by: string | null;
  at: string;
}

interface Person {
  id: string;
  email: string;
  displayName: string;
  disabled: boolean;
}

export interface FollowDeps {
  person(userId: string): Person | null;
  /** May this person read it (rights, paused/removed sources)? */
  readable(userId: string, mountId: string, path: string, isDir: boolean): boolean;
  mountName(mountId: string): string | null;
  /** Tells the person's open app that the dots changed. */
  emit(userId: string): void;
  mail: { configured(): boolean; send(m: { to: string; subject: string; text: string; action?: { label: string; url: string } }): Promise<void>; langOf(email: string): Lang | undefined; publicUrl(): string };
  pushover(userId: string, title: string, message: string, url?: { url: string; title: string }): Promise<void>;
  /** A message that could not go out (no secrets in it). */
  failed(userId: string, channel: 'mail' | 'pushover', error: unknown): void;
  fallbackLang(): Lang;
}

/** Changes that come close together go out as one message … */
const BUNDLE_MS = 2 * 60_000;
/** … and never more than this many messages per person and hour … */
const MAX_PER_HOUR = 20;
/** … and per day, unless the admin sets another number (Einstellungen → Benachrichtigungen → Ereignisse). */
export const DEFAULT_PER_DAY = 100;
/** At most this many lines in one message (a daily summary may be longer). */
const MAX_LINES = 15;
const MAX_LINES_DAILY = 50;
/** The daily summary goes out at this time unless the person chooses another (server time zone, TZ). */
export const DEFAULT_DAILY_AT = '07:00';
const DAILY_AT_KEY = 'notifyDailyAt';
export const isDailyAt = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How often a person gets messages about what they follow. */
export type Rhythm = 'bundled' | 'hourly' | 'daily';
export const RHYTHMS: Rhythm[] = ['bundled', 'hourly', 'daily'];
const RHYTHM_KEY = 'notifyRhythm';
const LIMIT_KEY = 'follow_daily_limit';

/** When the messages waiting since `first` may go out – rhythm first, then the limits (never earlier than `now`). */
export function dueAt(o: { first: number; rhythm: Rhythm; bundleMs: number; sent: number[]; perDay: number; now: number; dailyAt?: string }): number {
  let due = o.first + o.bundleMs;
  const last = Math.max(0, ...o.sent);
  if (o.rhythm === 'hourly' && last) due = Math.max(due, last + HOUR);
  if (o.rhythm === 'daily') {
    const [h, m] = (o.dailyAt ?? DEFAULT_DAILY_AT).split(':').map(Number) as [number, number];
    const d = new Date(o.first);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= o.first) d.setDate(d.getDate() + 1);
    due = d.getTime();
  }
  // Limits: wait until the oldest message of the full window drops out of it.
  const inHour = o.sent.filter((t) => o.now - t < HOUR).sort((a, b) => a - b);
  if (inHour.length >= MAX_PER_HOUR) due = Math.max(due, inHour[inHour.length - MAX_PER_HOUR]! + HOUR);
  const inDay = o.sent.filter((t) => o.now - t < DAY).sort((a, b) => a - b);
  if (inDay.length >= o.perDay) due = Math.max(due, inDay[inDay.length - o.perDay]! + DAY);
  return due;
}

const covers = (w: { path: string; isDir: boolean }, path: string) => (!w.path ? true : w.isDir ? path === w.path || path.startsWith(w.path + '/') : path === w.path);
const isDirPath = (p: string) => !/\.md$/i.test(p);

export class Follows {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly db: DB,
    private readonly deps: FollowDeps,
    private readonly bundleMs = BUNDLE_MS,
  ) {
    // Messages that waited across a restart go out when they are due.
    this.schedule();
  }

  /** The person's rhythm (Einstellungen → Konto → Beobachten); bundled unless chosen otherwise. */
  rhythm(userId: string): Rhythm {
    const row = this.db.prepare('SELECT value_json FROM user_state WHERE user_id = ? AND key = ?').get(userId, RHYTHM_KEY) as { value_json: string } | undefined;
    const v = row ? (JSON.parse(row.value_json) as unknown) : null;
    return RHYTHMS.includes(v as Rhythm) ? (v as Rhythm) : 'bundled';
  }

  setRhythm(userId: string, rhythm: Rhythm): void {
    this.putState(userId, RHYTHM_KEY, rhythm);
  }

  /** When the daily summary comes for the person („HH:MM“, server time). */
  dailyAt(userId: string): string {
    const row = this.db.prepare('SELECT value_json FROM user_state WHERE user_id = ? AND key = ?').get(userId, DAILY_AT_KEY) as { value_json: string } | undefined;
    const v = row ? (JSON.parse(row.value_json) as unknown) : null;
    return isDailyAt(v) ? v : DEFAULT_DAILY_AT;
  }

  setDailyAt(userId: string, at: string): void {
    if (!isDailyAt(at)) throw new RangeError('HH:MM');
    this.putState(userId, DAILY_AT_KEY, at);
  }

  private putState(userId: string, key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO user_state (user_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json')
      .run(userId, key, JSON.stringify(value));
    this.schedule();
  }

  /** At most this many messages per person and day (admin). */
  perDay(): number {
    const v = Number((this.db.prepare('SELECT value FROM settings WHERE key = ?').get(LIMIT_KEY) as { value: string } | undefined)?.value);
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_PER_DAY;
  }

  setPerDay(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RangeError('1 bis 1000');
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(LIMIT_KEY, String(n));
    this.schedule();
  }

  /** When the person's waiting messages go out; null when nothing waits. */
  nextFor(userId: string, now = Date.now()): number | null {
    const first = (this.db.prepare('SELECT MIN(at) AS first FROM follow_queue WHERE user_id = ?').get(userId) as { first: number | null }).first;
    if (first === null) return null;
    const sent = (this.db.prepare('SELECT at FROM follow_sent WHERE user_id = ? AND at > ?').all(userId, now - DAY) as { at: number }[]).map((r) => r.at);
    return dueAt({ first, rhythm: this.rhythm(userId), bundleMs: this.bundleMs, sent, perDay: this.perDay(), now, dailyAt: this.dailyAt(userId) });
  }

  list(userId: string): (Watch & { unread: number })[] {
    const rows = this.db.prepare('SELECT mount_id, path, is_dir, badge, mail, pushover, created_at FROM watches WHERE user_id = ? ORDER BY created_at').all(userId) as {
      mount_id: string;
      path: string;
      is_dir: number;
      badge: number;
      mail: number;
      pushover: number;
      created_at: string;
    }[];
    const unread = this.unread(userId);
    return rows
      .filter((r) => this.deps.readable(userId, r.mount_id, r.path, !!r.is_dir))
      .map((r) => {
        const w = { mountId: r.mount_id, path: r.path, isDir: !!r.is_dir, badge: !!r.badge, mail: !!r.mail, pushover: !!r.pushover, createdAt: r.created_at };
        return { ...w, unread: unread.filter((u) => u.mountId === w.mountId && covers(w, u.path)).length };
      });
  }

  /** Sets how the person follows it; nothing chosen = no longer followed (and its dots go). */
  set(userId: string, input: WatchInput): void {
    const path = input.path.replace(/^\/+|\/+$/g, '');
    if (!input.badge && !input.mail && !input.pushover) {
      this.db.prepare('DELETE FROM watches WHERE user_id = ? AND mount_id = ? AND path = ?').run(userId, input.mountId, path);
      this.dropUnreadOutside(userId, input.mountId);
    } else {
      this.db
        .prepare(
          `INSERT INTO watches (user_id, mount_id, path, is_dir, badge, mail, pushover, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, mount_id, path) DO UPDATE SET is_dir = excluded.is_dir, badge = excluded.badge, mail = excluded.mail, pushover = excluded.pushover`,
        )
        .run(userId, input.mountId, path, input.isDir || !path ? 1 : 0, +input.badge, +input.mail, +input.pushover, new Date().toISOString());
      if (!input.badge) this.dropUnreadOutside(userId, input.mountId);
    }
    this.deps.emit(userId);
  }

  /**
   * A note or folder moved (in the app, also into another source) or a note renamed outside: what is followed at or
   * below it moves along, so the next change at the new place is heard (code-001).
   */
  moved(mountId: string, from: string, to: string, toMountId = mountId): void {
    if (!from) return;
    const rows = (this.db.prepare('SELECT user_id, path FROM watches WHERE mount_id = ?').all(mountId) as { user_id: string; path: string }[]).filter(
      (r) => r.path === from || r.path.startsWith(from + '/'),
    );
    if (!rows.length) return;
    // Already followed at the new place: the moved one takes its place.
    const move = this.db.prepare('UPDATE OR REPLACE watches SET mount_id = ?, path = ? WHERE user_id = ? AND mount_id = ? AND path = ?');
    this.db.transaction(() => {
      for (const r of rows) move.run(toMountId, to + r.path.slice(from.length), r.user_id, mountId, r.path);
    })();
    for (const userId of new Set(rows.map((r) => r.user_id))) this.deps.emit(userId);
  }

  /** A source was removed: what was followed there, its dots and the messages waiting about it go (code-001). */
  mountRemoved(mountId: string): void {
    const users = (this.db.prepare('SELECT user_id FROM watches WHERE mount_id = ? UNION SELECT user_id FROM unread WHERE mount_id = ?').all(mountId, mountId) as { user_id: string }[]).map((r) => r.user_id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM watches WHERE mount_id = ?').run(mountId);
      this.db.prepare('DELETE FROM unread WHERE mount_id = ?').run(mountId);
      this.db.prepare('DELETE FROM follow_queue WHERE mount_id = ?').run(mountId);
    })();
    for (const userId of users) this.deps.emit(userId);
    this.schedule();
  }

  /** What is new for the person, as far as they (still) may read it. */
  unread(userId: string): Unread[] {
    const rows = this.db.prepare('SELECT mount_id, path, kind, by_name, at FROM unread WHERE user_id = ? ORDER BY at DESC').all(userId) as {
      mount_id: string;
      path: string;
      kind: Change['kind'];
      by_name: string | null;
      at: string;
    }[];
    return rows.filter((r) => this.deps.readable(userId, r.mount_id, r.path, isDirPath(r.path))).map((r) => ({ mountId: r.mount_id, path: r.path, kind: r.kind, by: r.by_name, at: r.at }));
  }

  /** Opened (a note) or marked as read (a folder or source: everything in it). */
  markRead(userId: string, mountId: string, path: string): void {
    const p = path.replace(/^\/+|\/+$/g, '');
    // Exact, with the „/“ border: LIKE ignores case („Plan“ would hit „plan/…“), substr does not and has no wildcards.
    const res = p
      ? this.db.prepare('DELETE FROM unread WHERE user_id = ? AND mount_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?)').run(userId, mountId, p, `${p}/`, `${p}/`)
      : this.db.prepare('DELETE FROM unread WHERE user_id = ? AND mount_id = ?').run(userId, mountId);
    if (res.changes) this.deps.emit(userId);
  }

  /** New changes from the feed: dots and messages for everyone who follows them. */
  onChanges(changes: Change[]): void {
    const watches = this.db.prepare('SELECT user_id, mount_id, path, is_dir, badge, mail, pushover FROM watches').all() as {
      user_id: string;
      mount_id: string;
      path: string;
      is_dir: number;
      badge: number;
      mail: number;
      pushover: number;
    }[];
    if (!watches.length) return;
    const touched = new Set<string>();
    let queued = false;
    // One transaction and one look at the schedule per batch – a big sync once took seconds (code-002).
    this.db.transaction(() => {
      for (const c of changes) {
        // Per person: all their watches that cover it (a note in a followed folder counts once).
        const per = new Map<string, { badge: boolean; mail: boolean; pushover: boolean }>();
        for (const w of watches) {
          if (w.mount_id !== c.mountId || c.by?.id === w.user_id) continue;
          const ww = { path: w.path, isDir: !!w.is_dir };
          // The old place of a move counts only while the person may read it (sec-001).
          if (!covers(ww, c.path) && !(c.from && covers(ww, c.from) && this.deps.readable(w.user_id, c.mountId, c.from, isDirPath(c.from)))) continue;
          const acc = per.get(w.user_id) ?? { badge: false, mail: false, pushover: false };
          per.set(w.user_id, { badge: acc.badge || !!w.badge, mail: acc.mail || !!w.mail, pushover: acc.pushover || !!w.pushover });
        }
        for (const [userId, how] of per) {
          const person = this.deps.person(userId);
          if (!person || person.disabled || !this.deps.readable(userId, c.mountId, c.path, isDirPath(c.path))) continue;
          if (how.badge) {
            if (c.from) this.db.prepare('DELETE FROM unread WHERE user_id = ? AND mount_id = ? AND path = ?').run(userId, c.mountId, c.from);
            // A deleted note has no place for a dot (the e-mail still tells about it).
            if (c.kind === 'deleted') {
              this.db.prepare('DELETE FROM unread WHERE user_id = ? AND mount_id = ? AND path = ?').run(userId, c.mountId, c.path);
              touched.add(userId);
              if (how.mail || how.pushover) queued = this.enqueue(userId, c, how.mail, how.pushover);
              continue;
            }
            this.db
              .prepare(
                `INSERT INTO unread (user_id, mount_id, path, kind, by_name, at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, mount_id, path) DO UPDATE SET kind = excluded.kind, by_name = excluded.by_name, at = excluded.at`,
              )
              .run(userId, c.mountId, c.path, c.kind, c.by?.name ?? null, c.at);
            touched.add(userId);
          }
          if (how.mail || how.pushover) queued = this.enqueue(userId, c, how.mail, how.pushover);
        }
      }
    })();
    if (queued) this.schedule();
    for (const userId of touched) this.deps.emit(userId);
  }

  /** Sends what is due at `now` (the timer; tests pass a time), then waits for the messages on their way. */
  async tick(now = Date.now()): Promise<void> {
    const users = (this.db.prepare('SELECT DISTINCT user_id FROM follow_queue').all() as { user_id: string }[]).map((r) => r.user_id);
    for (const userId of users) if ((this.nextFor(userId, now) ?? Infinity) <= now) this.send(userId, now);
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    this.schedule();
  }

  /** Tests: sends everything waiting now, whatever the rhythm and limits. */
  async flush(): Promise<void> {
    for (const r of this.db.prepare('SELECT DISTINCT user_id FROM follow_queue').all() as { user_id: string }[]) this.send(r.user_id, Date.now());
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Shutdown: the timer stops; waiting messages stay in the database for the next start. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** One timer for the earliest due message of anyone. */
  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const now = Date.now();
    const users = (this.db.prepare('SELECT DISTINCT user_id FROM follow_queue').all() as { user_id: string }[]).map((r) => r.user_id);
    const next = Math.min(...users.map((u) => this.nextFor(u, now) ?? Infinity));
    if (next === Infinity) return;
    // setTimeout holds at most ~24.8 days; a later time is looked at again then.
    this.timer = setTimeout(() => void this.tick(), Math.min(Math.max(0, next - now), 2 ** 31 - 1));
    this.timer.unref?.();
  }

  private dropUnreadOutside(userId: string, mountId: string) {
    const left = this.db.prepare('SELECT path, is_dir FROM watches WHERE user_id = ? AND mount_id = ? AND badge = 1').all(userId, mountId) as { path: string; is_dir: number }[];
    const rows = this.db.prepare('SELECT path FROM unread WHERE user_id = ? AND mount_id = ?').all(userId, mountId) as { path: string }[];
    for (const r of rows) if (!left.some((w) => covers({ path: w.path, isDir: !!w.is_dir }, r.path))) this.db.prepare('DELETE FROM unread WHERE user_id = ? AND mount_id = ? AND path = ?').run(userId, mountId, r.path);
  }

  /**
   * Queues a message; the caller looks at the schedule afterwards (once per batch). One row per person and note: a later
   * change replaces the earlier one (created in this bundle stays „created“ – the later edits are part of it), the
   * waiting time counts from the first.
   */
  private enqueue(userId: string, change: Change, mail: boolean, pushover: boolean): true {
    this.db
      .prepare(
        `INSERT INTO follow_queue (user_id, mount_id, path, change_json, mail, pushover, at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, mount_id, path) DO UPDATE SET
           change_json = CASE WHEN json_extract(follow_queue.change_json, '$.kind') = 'created' AND json_extract(excluded.change_json, '$.kind') = 'changed'
             THEN json_set(excluded.change_json, '$.kind', 'created') ELSE excluded.change_json END,
           mail = max(follow_queue.mail, excluded.mail),
           pushover = max(follow_queue.pushover, excluded.pushover)`,
      )
      .run(userId, change.mountId, change.path, JSON.stringify(change), +mail, +pushover, Date.now());
    return true;
  }

  private send(userId: string, now: number) {
    const rows = this.db.prepare('SELECT change_json, mail, pushover FROM follow_queue WHERE user_id = ? ORDER BY id').all(userId) as { change_json: string; mail: number; pushover: number }[];
    this.db.prepare('DELETE FROM follow_queue WHERE user_id = ?').run(userId);
    const person = this.deps.person(userId);
    if (!rows.length || !person || person.disabled) return;
    const items = rows.map((r) => ({ change: JSON.parse(r.change_json) as Change, mail: !!r.mail, pushover: !!r.pushover }));
    // One row per note already holds its newest state (enqueue); still readable at sending time?
    const changes = items.map((i) => i.change).filter((c) => this.deps.readable(userId, c.mountId, c.path, isDirPath(c.path)));
    if (!changes.length) return;
    this.db.prepare('DELETE FROM follow_sent WHERE user_id = ? AND at <= ?').run(userId, now - DAY);
    this.db.prepare('INSERT INTO follow_sent (user_id, at) VALUES (?, ?)').run(userId, now);
    const lang = this.deps.mail.langOf(person.email) ?? this.deps.fallbackLang();
    const max = this.rhythm(userId) === 'daily' ? MAX_LINES_DAILY : MAX_LINES;
    const lines = changes.slice(0, max).map((c) => this.line(lang, c, userId));
    if (changes.length > max) lines.push(tr(lang, '… und {n} weitere', { n: changes.length - max }));
    const base = this.deps.mail.publicUrl();
    const first = changes[0]!;
    // The app's own note address (/n/<source>/<path>).
    const url = base ? `${base.replace(/\/$/, '')}/n/${first.mountId}/${first.path.split('/').map(encodeURIComponent).join('/')}` : undefined;
    const title = changes.length === 1 ? tr(lang, 'Neues in „{name}“', { name: first.path.split('/').pop()!.replace(/\.md$/i, '') }) : tr(lang, '{n} Änderungen in Beobachtetem', { n: changes.length });
    const wantMail = items.some((i) => i.mail);
    const wantPush = items.some((i) => i.pushover);
    if (wantMail && this.deps.mail.configured()) {
      const text = [
        tr(lang, 'Hallo {name},', { name: person.displayName }),
        tr(lang, 'in dem, was du in Kaveyl Wiki beobachtest, hat sich etwas geändert:'),
        lines.join('\n'),
        tr(lang, 'Du bekommst diese Nachricht, weil du es beobachtest. Abbestellen: Rechtsklick darauf → „Beobachten …“.'),
      ].join('\n\n');
      this.track(
        this.deps.mail.send({ to: person.email, subject: `Kaveyl Wiki: ${title}`, text, action: url ? { label: tr(lang, 'In Kaveyl Wiki öffnen'), url } : undefined }),
        userId,
        'mail',
      );
    }
    if (wantPush) this.track(this.deps.pushover(userId, `Kaveyl Wiki: ${title}`, lines.join('\n'), url ? { url, title: tr(lang, 'In Kaveyl Wiki öffnen') } : undefined), userId, 'pushover');
  }

  private line(lang: Lang, c: Change, userId: string): string {
    const where = `${this.deps.mountName(c.mountId) ?? '?'}: ${c.path}`;
    const by = c.by?.name ?? tr(lang, 'von außen (Git, anderes Programm)');
    // The old path of a move only when it may be read, too (sec-001) – as in /changes and event webhooks.
    const from = c.from && this.deps.readable(userId, c.mountId, c.from, isDirPath(c.from)) ? c.from : null;
    const what =
      c.kind === 'created'
        ? tr(lang, 'neu angelegt', {})
        : c.kind === 'deleted'
          ? tr(lang, 'gelöscht', {})
          : c.kind === 'moved'
            ? from
              ? tr(lang, 'verschoben von {from}', { from })
              : tr(lang, 'verschoben', {})
            : tr(lang, 'geändert', {});
    return translateLines(lang, `- ${where} – ${what} (${by})`);
  }

  private track(p: Promise<unknown>, userId: string, channel: 'mail' | 'pushover') {
    const run = p.catch((e: unknown) => this.deps.failed(userId, channel, e)).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }
}
