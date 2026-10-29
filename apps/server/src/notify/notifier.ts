// Notifications for admins (AD-035): sync problems, the nightly run, failed backups (AD-038) and security events go out by
// e-mail and/or Pushover — per event, as the admin chose (Einstellungen → Benachrichtigungen).
// Account mails (password reset, invitations, „Passwort geändert“) are separate and unchanged.
// The Pushover application token and user key live in the SecretStore and never reach the frontend.
// Messages are built from log texts, which never contain secrets (AD-013).

import type { SecretStore } from '../secrets.js';
import type { Mailer } from '../mail/mailer.js';
import type { ActivityInput } from '../activity.js';
import { fallbackLang, tr, translateLines } from '../i18n/index.js';

export type NotifyEvent = 'sync' | 'nightly' | 'backup' | 'security';
export type Channel = 'mail' | 'pushover';
export type NotifyRules = Record<NotifyEvent, Record<Channel, boolean>>;

export const EVENTS: NotifyEvent[] = ['sync', 'nightly', 'backup', 'security'];
const CHANNELS: Channel[] = ['mail', 'pushover'];

export interface PushoverSettings {
  tokenSet: boolean;
  userKeySet: boolean;
  /** Optional device name(s), comma-separated; empty = all devices of the user. */
  device: string;
}

export interface PushoverInput {
  /** New value; empty string removes it, undefined keeps it. */
  token?: string;
  userKey?: string;
  device?: string;
}

export interface Notice {
  event: NotifyEvent;
  title: string;
  text: string;
  /** Pushover: -1 quiet, 0 normal, 1 high (ignores the quiet hours of the phone). */
  priority?: -1 | 0 | 1;
  /** Path inside the app for the „Öffnen“ link, e.g. '#settings'; needs the public address. */
  link?: string;
  /** Same key within `gapMs` → sent once. */
  key?: string;
  gapMs?: number;
}

interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class NotifyError extends Error {}

const TOKEN_ID = 'pushover-token';
const USER_ID = 'pushover-user';
const KEY = /^[A-Za-z0-9]{30}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,25}(,[A-Za-z0-9_-]{1,25})*$/;
const LABEL: Record<NotifyEvent, string> = { sync: 'Sync-Probleme', nightly: 'Nachtlauf', backup: 'Backup', security: 'Sicherheit' };

/** Failed logins within this window … */
const LOGIN_WINDOW_MS = 15 * 60_000;
/** … from this many on raise a security notice (at most once per hour). */
const LOGIN_BURST = 10;

/** Same notice again at the earliest after … (sync problems); backups once a day while they keep failing. */
const DEFAULT_GAP_MS = 6 * 3_600_000;
const BACKUP_GAP_MS = 24 * 3_600_000;
/** A channel chosen for an event but not set up is reported at most this often. */
const MISSING_GAP_MS = 86_400_000;
/** All notices together, per hour – a fault that repeats can never flood the inbox. */
const MAX_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

export const emptyRules = (): NotifyRules => ({
  sync: { mail: false, pushover: false },
  nightly: { mail: false, pushover: false },
  backup: { mail: false, pushover: false },
  security: { mail: false, pushover: false },
});

/** Until the admin saves a choice: what nobody wants to miss is on – on the channels that are set up. */
export const defaultRules = (): NotifyRules => ({
  ...emptyRules(),
  backup: { mail: true, pushover: true },
  nightly: { mail: true, pushover: true },
  security: { mail: true, pushover: true },
});

export class Notifier {
  /** When a notice with this key last went out – in the settings (KV), so a restart does not send it again. */
  private readonly sent: { get(k: string): number | undefined; set(k: string, at: number): void; delete(k: string): void };
  /** Mounts with a „Sync-Fehler“ notice out: only those get „Wieder synchron“. */
  private readonly failing = new Set<string>();
  private failedLogins: { at: number; ip: string }[] = [];
  /** Deliveries started from the log (fire and forget); `idle()` waits for them. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly kv: KV,
    private readonly secrets: SecretStore,
    private readonly mailer: Mailer,
    /** Who gets the mails: admins with a real address, not locked. */
    private readonly recipients: () => { email: string; displayName: string }[],
    /** Delivery problems go to the log (never notified again, no loop). */
    private readonly record: (e: ActivityInput) => void,
    private readonly opts: { pushoverUrl?: string; now?: () => number; maxPerHour?: number } = {},
  ) {
    const load = (): Record<string, number> => {
      try {
        const v = JSON.parse(this.kv.get('notify_sent') ?? '{}') as unknown;
        return v && typeof v === 'object' ? (v as Record<string, number>) : {};
      } catch {
        return {};
      }
    };
    const save = (m: Record<string, number>) => {
      // Older than a week is no use for any gap: dropped.
      const week = this.now() - 7 * 86_400_000;
      this.kv.set('notify_sent', JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, at]) => typeof at === 'number' && at > week))));
    };
    this.sent = {
      get: (k) => load()[k],
      set: (k, at) => save({ ...load(), [k]: at }),
      delete: (k) => {
        const m = load();
        if (k in m) delete m[k], save(m);
      },
    };
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  rules(): NotifyRules {
    const stored = this.kv.get('notify_rules');
    if (stored === null) return defaultRules();
    const out = emptyRules();
    try {
      const raw = JSON.parse(stored) as Partial<Record<string, Partial<Record<string, unknown>>>>;
      for (const e of EVENTS) for (const c of CHANNELS) out[e][c] = raw[e]?.[c] === true;
    } catch {
      /* broken value → everything off */
    }
    return out;
  }

  /** Merges a partial change; unknown events/channels and non-booleans are ignored. */
  saveRules(patch: unknown): NotifyRules {
    const next = this.rules();
    if (patch && typeof patch === 'object') {
      for (const e of EVENTS) {
        const p = (patch as Record<string, unknown>)[e];
        if (!p || typeof p !== 'object') continue;
        for (const c of CHANNELS) {
          const v = (p as Record<string, unknown>)[c];
          if (typeof v === 'boolean') next[e][c] = v;
        }
      }
    }
    this.kv.set('notify_rules', JSON.stringify(next));
    return next;
  }

  pushover(): PushoverSettings {
    return { tokenSet: this.secrets.get(TOKEN_ID) !== null, userKeySet: this.secrets.get(USER_ID) !== null, device: this.kv.get('pushover_device') ?? '' };
  }

  savePushover(input: PushoverInput): PushoverSettings {
    const token = input.token?.trim();
    const user = input.userKey?.trim();
    const device = input.device?.replace(/\s+/g, '');
    if (token && !KEY.test(token)) throw new NotifyError('API-Token: 30 Zeichen, nur Buchstaben und Ziffern (bei Pushover unter „Your Applications“)');
    if (user && !KEY.test(user)) throw new NotifyError('User-Key: 30 Zeichen, nur Buchstaben und Ziffern (oben auf pushover.net nach der Anmeldung)');
    if (device && !DEVICE.test(device)) throw new NotifyError('Gerät: Name(n) aus Buchstaben, Ziffern, _ und -, mehrere mit Komma');
    if (token !== undefined) token ? this.secrets.put(token, TOKEN_ID) : this.secrets.delete(TOKEN_ID);
    if (user !== undefined) user ? this.secrets.put(user, USER_ID) : this.secrets.delete(USER_ID);
    if (device !== undefined) this.kv.set('pushover_device', device);
    return this.pushover();
  }

  /** Resolves when every delivery started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Starts a delivery in the background (never throws, see `send`). */
  dispatch(n: Notice): void {
    const p = this.send(n).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  channels(): Record<Channel, boolean> {
    const p = this.pushover();
    return { mail: this.mailer.configured() && this.recipients().length > 0, pushover: p.tokenSet && p.userKeySet };
  }

  /** Sends a notice on every channel the admin chose for its event; never throws (a failure goes to the log). */
  async send(n: Notice): Promise<Channel[]> {
    try {
      return await this.trySend(n);
    } catch (e) {
      this.record({ category: 'error', level: 'warn', action: 'notify-failed', message: `Benachrichtigung „${n.title}“ nicht zugestellt: ${e instanceof Error ? e.message : String(e)}` });
      return [];
    }
  }

  private async trySend(n: Notice): Promise<Channel[]> {
    const rule = this.rules()[n.event];
    let wanted = CHANNELS.filter((c) => rule[c]);
    // The defaults (nothing saved yet) only use what is set up; a channel the admin chose but is missing is reported below.
    if (this.kv.get('notify_rules') === null) {
      const ready = this.channels();
      wanted = wanted.filter((c) => ready[c]);
    }
    if (!wanted.length) return [];
    if (n.key) {
      const last = this.sent.get(n.key);
      if (last !== undefined && this.now() - last < (n.gapMs ?? DEFAULT_GAP_MS)) return [];
      this.sent.set(n.key, this.now());
    }
    const held = this.hold(n);
    if (held === 'quiet') return [];
    return this.deliver(held === 'last' ? this.heldNotice(n) : n, wanted);
  }

  /**
   * The hourly limit over all notices (kept in the settings, a restart does not reset it): 'send' within it,
   * 'last' = the one past it – replaced by „Weitere Benachrichtigungen zurückgehalten“, 'quiet' after that.
   */
  private hold(n: Notice): 'send' | 'last' | 'quiet' {
    const max = this.opts.maxPerHour ?? MAX_PER_HOUR;
    const now = this.now();
    let w = { start: now, count: 0 };
    try {
      const v = JSON.parse(this.kv.get('notify_window') ?? 'null') as { start?: unknown; count?: unknown } | null;
      if (v && typeof v.start === 'number' && typeof v.count === 'number' && now - v.start < HOUR_MS && v.start <= now) w = { start: v.start, count: v.count };
    } catch {
      /* broken value → a new window */
    }
    w.count++;
    this.kv.set('notify_window', JSON.stringify(w));
    if (w.count <= max) return 'send';
    this.record({ category: 'system', level: 'warn', action: 'notify-held', message: `Benachrichtigung „${n.title}“ zurückgehalten (mehr als ${max} je Stunde)` });
    return w.count === max + 1 ? 'last' : 'quiet';
  }

  private heldNotice(n: Notice): Notice {
    const max = this.opts.maxPerHour ?? MAX_PER_HOUR;
    return {
      event: n.event,
      title: 'Weitere Benachrichtigungen zurückgehalten',
      text: `Kaveyl Wiki schickt höchstens ${max} Benachrichtigungen je Stunde. Was in dieser Stunde noch passiert, steht im Protokoll (Einstellungen → Werkzeuge → Protokoll).`,
      link: '#settings',
    };
  }

  /** Delivers on the given channels; a failure is logged, never thrown. */
  private async deliver(n: Notice, channels: Channel[]): Promise<Channel[]> {
    const done: Channel[] = [];
    const ready = this.channels();
    for (const c of channels) {
      const via = c === 'mail' ? 'E-Mail' : 'Pushover';
      // Chosen but not set up (e.g. after „Zugang entfernen“): said once a day, not with every notice.
      if (!ready[c]) {
        const key = `missing:${c}`;
        const last = this.sent.get(key);
        if (last === undefined || this.now() - last >= MISSING_GAP_MS) {
          this.sent.set(key, this.now());
          const why = c === 'mail' ? (this.mailer.configured() ? 'Kein Admin mit E-Mail-Adresse' : 'E-Mail-Versand ist nicht eingerichtet') : 'Pushover ist nicht eingerichtet (API-Token und User-Key fehlen)';
          this.record({
            category: 'error',
            level: 'warn',
            action: 'notify-failed',
            message: `Benachrichtigungen per ${via} werden nicht zugestellt: ${why}. Einrichten oder bei den Ereignissen abwählen (Einstellungen → Benachrichtigungen) – dieser Hinweis kommt höchstens einmal am Tag.`,
          });
        }
        continue;
      }
      try {
        await (c === 'mail' ? this.viaMail(n) : this.viaPushover(n));
        done.push(c);
      } catch (e) {
        this.record({
          category: 'error',
          level: 'warn',
          action: 'notify-failed',
          message: `Benachrichtigung „${n.title}“ per ${via} nicht zugestellt: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    return done;
  }

  /**
   * After a backup run: a failure once a day while it keeps failing (per plan – a plan has one target), and once
   * „wieder in Ordnung“ when a run after a reported failure succeeds. `problems` null = success.
   */
  async backupResult(plan: { id: string; name: string }, problems: string[] | null, partial: boolean): Promise<void> {
    const key = `backup:${plan.id}`;
    if (problems) {
      await this.send({
        event: 'backup',
        title: `Backup „${plan.name}“ ${partial ? 'teilweise ' : ''}fehlgeschlagen`,
        text: problems.map((p) => `• ${p}`).join('\n'),
        link: '#settings',
        key,
        gapMs: BACKUP_GAP_MS,
      });
    } else if (this.sent.get(key) !== undefined) {
      this.sent.delete(key);
      await this.send({ event: 'backup', title: `Backup „${plan.name}“ wieder in Ordnung`, text: 'Die Sicherung läuft wieder ohne Fehler.', priority: -1, link: '#settings' });
    }
  }

  /** „Testnachricht senden“: one channel, regardless of the event choice; throws with a readable reason. */
  async test(channel: Channel, to?: { email: string; displayName: string }): Promise<void> {
    const n: Notice = { event: 'security', title: 'Testnachricht', text: 'Diese Nachricht zeigt: Benachrichtigungen von Kaveyl Wiki kommen an.', priority: -1 };
    if (channel === 'pushover') return this.viaPushover(n);
    await this.viaMail(n, to ? [to] : undefined);
  }

  private link(n: Notice): string | null {
    const base = this.mailer.settings().publicUrl;
    return base ? `${base}/${(n.link ?? '').replace(/^\//, '')}` : null;
  }

  private async viaMail(n: Notice, to = this.recipients()) {
    if (!this.mailer.configured()) throw new NotifyError('E-Mail-Versand ist nicht eingerichtet');
    if (!to.length) throw new NotifyError('Kein Admin mit E-Mail-Adresse');
    const url = this.link(n);
    for (const r of to) {
      // Each admin in their own language (AD-046); title and text line by line (lists of findings).
      const lang = this.mailer.langOf(r.email) ?? fallbackLang();
      await this.mailer.send({
        to: r.email,
        lang,
        subject: `Kaveyl Wiki: ${translateLines(lang, n.title)}`,
        text: tr(lang, 'Hallo {name},\n\n{text}\n\nDu bekommst diese Nachricht, weil in Kaveyl Wiki unter Einstellungen → Benachrichtigungen „{event}“ per E-Mail eingeschaltet ist.', {
          name: r.displayName,
          text: translateLines(lang, n.text),
          event: tr(lang, LABEL[n.event]),
        }),
        action: url ? { label: tr(lang, 'Kaveyl Wiki öffnen'), url } : undefined,
      });
    }
  }

  private async viaPushover(n: Notice) {
    const token = this.secrets.get(TOKEN_ID);
    const user = this.secrets.get(USER_ID);
    if (!token || !user) throw new NotifyError('Pushover ist nicht eingerichtet (API-Token und User-Key fehlen)');
    // One Pushover account for all: in the language of the first admin (AD-046).
    const first = this.recipients()[0];
    const lang = (first && this.mailer.langOf(first.email)) || fallbackLang();
    const url = this.link(n);
    await this.postPushover(token, user, {
      title: `Kaveyl Wiki: ${translateLines(lang, n.title)}`,
      message: translateLines(lang, n.text),
      priority: n.priority ?? 0,
      device: this.kv.get('pushover_device') ?? undefined,
      url: url ? { url, title: tr(lang, 'Kaveyl Wiki öffnen') } : undefined,
    });
  }

  private async postPushover(token: string, user: string, m: { title: string; message: string; priority?: number; device?: string; url?: { url: string; title: string } }) {
    const body = new URLSearchParams({ token, user, title: m.title.slice(0, 250), message: m.message.slice(0, 1024), priority: String(m.priority ?? 0) });
    if (m.device) body.set('device', m.device);
    if (m.url) body.set('url', m.url.url), body.set('url_title', m.url.title);
    let res: Response;
    try {
      res = await fetch(this.opts.pushoverUrl ?? 'https://api.pushover.net/1/messages.json', { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new NotifyError(`Pushover nicht erreichbar (${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)})`);
    }
    const data = (await res.json().catch(() => null)) as { status?: number; errors?: unknown[] } | null;
    if (res.ok && data?.status === 1) return;
    // Pushover names the problem („application token is invalid“, „user identifier is not a valid user …“), never the key itself.
    const why = Array.isArray(data?.errors) ? data.errors.map(String).join('; ').slice(0, 200) : `HTTP ${res.status}`;
    throw new NotifyError(`Pushover lehnt ab: ${why}`);
  }

  /**
   * „Beobachten“ (AD-066): every person may give their own Pushover user key; the application token stays the one
   * the admin set up. Without that token the option is not available.
   */
  personalPushover(userId: string): { available: boolean; userKeySet: boolean } {
    return { available: this.secrets.get(TOKEN_ID) !== null, userKeySet: this.secrets.get(`${USER_ID}:${userId}`) !== null };
  }

  savePersonalPushover(userId: string, userKey: string): { available: boolean; userKeySet: boolean } {
    const key = userKey.trim();
    if (key && !KEY.test(key)) throw new NotifyError('User-Key: 30 Zeichen, nur Buchstaben und Ziffern (oben auf pushover.net nach der Anmeldung)');
    if (key) this.secrets.put(key, `${USER_ID}:${userId}`);
    else this.secrets.delete(`${USER_ID}:${userId}`);
    return this.personalPushover(userId);
  }

  async pushoverToPerson(userId: string, title: string, message: string, url?: { url: string; title: string }): Promise<void> {
    const token = this.secrets.get(TOKEN_ID);
    const user = this.secrets.get(`${USER_ID}:${userId}`);
    if (!token) throw new NotifyError('Pushover ist nicht eingerichtet (ein Admin trägt den API-Token ein)');
    if (!user) throw new NotifyError('Kein eigener Pushover-User-Key (Mein Konto)');
    await this.postPushover(token, user, { title, message, url });
  }

  /**
   * Watches the event log for sync problems and bursts of failed logins. The nightly run and new
   * admins/API tokens are reported directly by their code paths.
   */
  observe(e: ActivityInput): void {
    if (e.action === 'notify-failed') return;
    const mount = e.mount;
    if (mount && e.action === 'sync-failed') {
      this.failing.add(mount.id);
      this.dispatch({ event: 'sync', title: `Sync-Fehler in „${mount.name}“`, text: e.message, key: `sync:${mount.id}` });
    } else if (mount && e.action === 'conflict') {
      this.dispatch({
        event: 'sync',
        title: `Konflikt in „${mount.name}“`,
        text: `${e.message}\n\nLokale Änderungen sind gesichert. Auflösen über das Sync-Symbol oben links in der Seitenleiste.`,
        key: `conflict:${mount.id}`,
        gapMs: 3_600_000,
      });
    } else if (mount && e.action === 'recovered' && this.failing.delete(mount.id)) {
      this.sent.delete(`sync:${mount.id}`);
      this.dispatch({ event: 'sync', title: `„${mount.name}“ wieder synchron`, text: 'Der Abgleich funktioniert wieder.', priority: -1 });
    } else if (e.action === 'login-failed') {
      const now = this.now();
      this.failedLogins = [...this.failedLogins.filter((f) => now - f.at < LOGIN_WINDOW_MS), { at: now, ip: String(e.detail?.ip ?? '') }];
      if (this.failedLogins.length >= LOGIN_BURST) {
        const ips = new Set(this.failedLogins.map((f) => f.ip)).size;
        this.dispatch({
          event: 'security',
          title: 'Viele fehlgeschlagene Anmeldungen',
          text: `${this.failedLogins.length} fehlgeschlagene Anmeldungen in den letzten 15 Minuten (von ${ips} Adresse${ips === 1 ? '' : 'n'}). Details: Einstellungen → Werkzeuge → Protokoll.`,
          priority: 1,
          key: 'login-burst',
          gapMs: 3_600_000,
        });
      }
    }
  }
}
