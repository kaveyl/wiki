// Notifications for admins (AD-035): event choice per channel, Pushover against a local fake API,
// mail through the fake SMTP server, sync/security triggers, the nightly summary.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { FakeSmtp } from './mail/fake-smtp.js';
import { Mailer } from './mail/mailer.js';
import { defaultRules, emptyRules, Notifier } from './notify/notifier.js';
import { SecretStore } from './secrets.js';
import { openDb, type DB } from './db/db.js';
import { lowDisk } from './cleanup.js';
import type { ActivityInput } from './activity.js';

const TOKEN = 'a'.repeat(30);
const USER = 'u'.repeat(30);

/** Minimal Pushover API: records each message, answers like the real one. */
class FakePushover {
  readonly messages: Record<string, string>[] = [];
  reject: string | null = null;
  private server: Server | null = null;
  url = '';
  async start() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const m = Object.fromEntries(new URLSearchParams(body));
        res.setHeader('content-type', 'application/json');
        if (this.reject) {
          res.statusCode = 400;
          res.end(JSON.stringify({ status: 0, errors: [this.reject] }));
          return;
        }
        this.messages.push(m);
        res.end(JSON.stringify({ status: 1, request: 'r' }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/1/messages.json`;
  }
  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}


describe('Notifier', () => {
  let root: string;
  let db: DB;
  let push: FakePushover;
  let logged: ActivityInput[];
  let now: number;
  let n: Notifier;
  let kv: Map<string, string>;
  let settings: { get: (k: string) => string | null; set: (k: string, v: string) => void };
  let secrets: SecretStore;
  const fresh = (opts: { maxPerHour?: number } = {}) =>
    new Notifier(settings, secrets, new Mailer(settings, secrets), () => [], (e) => logged.push(e), { pushoverUrl: push.url, now: () => now, ...opts });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-notify-'));
    db = openDb(join(root, 'kaveyl-wiki.db'));
    push = new FakePushover();
    await push.start();
    logged = [];
    now = Date.parse('2026-10-11T10:00:00Z');
    kv = new Map<string, string>();
    settings = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) };
    secrets = SecretStore.open(db, root);
    n = fresh();
  });

  afterEach(async () => {
    await push.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('starts with the important events on (backup, nightly, security) and merges changes, ignoring junk', () => {
    expect(n.rules()).toEqual(defaultRules());
    expect(defaultRules()).toEqual({ ...emptyRules(), backup: { mail: true, pushover: true }, nightly: { mail: true, pushover: true }, security: { mail: true, pushover: true } });
    n.saveRules({ sync: { pushover: true, mail: 'ja' }, gibtsnicht: { mail: true }, nightly: null });
    expect(n.rules()).toEqual({ ...defaultRules(), sync: { mail: false, pushover: true } });
    n.saveRules({ security: { pushover: false } });
    expect(n.rules().sync.pushover).toBe(true);
    expect(n.rules().security).toEqual({ mail: true, pushover: false });
  });

  it('the defaults use only channels that are set up – no „not delivered“ warnings before mail or Pushover exist', async () => {
    expect(await n.send({ event: 'backup', title: 'Backup „Nacht“ fehlgeschlagen', text: 'x' })).toEqual([]);
    expect(logged).toEqual([]);
    n.savePushover({ token: TOKEN, userKey: USER });
    expect(await n.send({ event: 'backup', title: 'Backup „Nacht“ fehlgeschlagen', text: 'x' })).toEqual(['pushover']);
    // Chosen by the admin: then a channel that is missing is worth a warning.
    n.saveRules({ backup: { mail: true } });
    expect(await n.send({ event: 'backup', title: 'Backup „Nacht“ fehlgeschlagen', text: 'x' })).toEqual(['pushover']);
    expect(logged.map((e) => e.action)).toEqual(['notify-failed']);
  });

  it('a chosen channel that is not set up is reported once a day, not with every notice', async () => {
    n.saveRules({ sync: { pushover: true } });
    for (const title of ['A', 'B', 'C']) expect(await n.send({ event: 'sync', title, text: 'x' })).toEqual([]);
    expect(logged.map((e) => e.message)).toEqual([expect.stringMatching(/^Benachrichtigungen per Pushover werden nicht zugestellt: Pushover ist nicht eingerichtet/)]);
    now += 25 * 3_600_000;
    await n.send({ event: 'sync', title: 'D', text: 'x' });
    expect(logged).toHaveLength(2);
  });

  it('a failing backup is reported once a day while it keeps failing, its recovery once', async () => {
    n.savePushover({ token: TOKEN, userKey: USER });
    const plan = { id: 'p1', name: 'Nacht' };
    await n.backupResult(plan, ['Zugriff verweigert'], false);
    await n.backupResult(plan, ['Zugriff verweigert'], false);
    now += 3_600_000;
    await n.backupResult(plan, ['Zugriff verweigert'], true);
    expect(push.messages.map((m) => m.title)).toEqual(['Kaveyl Wiki: Backup „Nacht“ fehlgeschlagen']);
    now += 24 * 3_600_000;
    await n.backupResult(plan, ['Zugriff verweigert'], false);
    expect(push.messages).toHaveLength(2);
    await n.backupResult(plan, null, false);
    await n.backupResult(plan, null, false);
    expect(push.messages.map((m) => m.title).at(-1)).toBe('Kaveyl Wiki: Backup „Nacht“ wieder in Ordnung');
    expect(push.messages).toHaveLength(3);
    // Fine again: the next failure is news at once.
    await n.backupResult(plan, ['Ziel voll'], false);
    expect(push.messages).toHaveLength(4);
    // Never failed: a success says nothing.
    await n.backupResult({ id: 'p2', name: 'Woche' }, null, false);
    expect(push.messages).toHaveLength(4);
  });

  it('remembers across a restart what it already sent (a restart loop does not repeat it)', async () => {
    n.savePushover({ token: TOKEN, userKey: USER });
    await n.backupResult({ id: 'p1', name: 'Nacht' }, ['kaputt'], false);
    n = fresh();
    await n.backupResult({ id: 'p1', name: 'Nacht' }, ['kaputt'], false);
    expect(push.messages).toHaveLength(1);
    await n.backupResult({ id: 'p1', name: 'Nacht' }, null, false);
    expect(push.messages.at(-1)!.title).toBe('Kaveyl Wiki: Backup „Nacht“ wieder in Ordnung');
  });

  it('never more than the limit per hour: then one notice that further ones are held back, quiet until the hour is over', async () => {
    n = fresh({ maxPerHour: 3 });
    n.savePushover({ token: TOKEN, userKey: USER });
    n.saveRules({ sync: { pushover: true } });
    for (let i = 0; i < 6; i++) await n.send({ event: 'sync', title: `Fehler ${i}`, text: 'x' });
    expect(push.messages.map((m) => m.title)).toEqual(['Kaveyl Wiki: Fehler 0', 'Kaveyl Wiki: Fehler 1', 'Kaveyl Wiki: Fehler 2', 'Kaveyl Wiki: Weitere Benachrichtigungen zurückgehalten']);
    expect(push.messages.at(-1)!.message).toMatch(/höchstens 3 Benachrichtigungen je Stunde/);
    expect(logged.filter((e) => e.action === 'notify-held').length).toBe(3);
    // A restart does not reset the count.
    n = fresh({ maxPerHour: 3 });
    await n.send({ event: 'sync', title: 'Fehler 6', text: 'x' });
    expect(push.messages).toHaveLength(4);
    now += 3_600_000;
    await n.send({ event: 'sync', title: 'Fehler 7', text: 'x' });
    expect(push.messages.at(-1)!.title).toBe('Kaveyl Wiki: Fehler 7');
  });

  it('checks Pushover keys and never hands them out', () => {
    expect(() => n.savePushover({ token: 'zu-kurz' })).toThrow(/API-Token/);
    expect(() => n.savePushover({ userKey: 'x'.repeat(31) })).toThrow(/User-Key/);
    expect(() => n.savePushover({ device: 'mein handy!' })).toThrow(/Gerät/);
    const s = n.savePushover({ token: TOKEN, userKey: USER, device: 'iphone, ipad' });
    expect(s).toEqual({ tokenSet: true, userKeySet: true, device: 'iphone,ipad' });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(n.channels().pushover).toBe(true);
    expect(n.savePushover({ token: '' }).tokenSet).toBe(false);
    expect(n.channels().pushover).toBe(false);
  });

  it('sends only events the admin chose, once per key and gap', async () => {
    n.savePushover({ token: TOKEN, userKey: USER });
    expect(await n.send({ event: 'sync', title: 'X', text: 'y' })).toEqual([]);
    n.saveRules({ sync: { pushover: true } });
    expect(await n.send({ event: 'sync', title: 'Sync-Fehler', text: 'kaputt', key: 'k' })).toEqual(['pushover']);
    expect(await n.send({ event: 'sync', title: 'Sync-Fehler', text: 'kaputt', key: 'k' })).toEqual([]);
    now += 7 * 3_600_000;
    expect(await n.send({ event: 'sync', title: 'Sync-Fehler', text: 'kaputt', key: 'k' })).toEqual(['pushover']);
    expect(push.messages).toHaveLength(2);
    expect(push.messages[0]).toMatchObject({ token: TOKEN, user: USER, title: 'Kaveyl Wiki: Sync-Fehler', message: 'kaputt', priority: '0' });
  });

  it('logs a refused delivery instead of throwing; the test message names the reason', async () => {
    n.savePushover({ token: TOKEN, userKey: USER });
    n.saveRules({ nightly: { pushover: true, mail: true } });
    push.reject = 'application token is invalid';
    expect(await n.send({ event: 'nightly', title: 'Nachtlauf', text: 'x' })).toEqual([]);
    expect(logged.map((e) => e.action)).toEqual(['notify-failed', 'notify-failed']);
    expect(logged[0]!.message).toMatch(/E-Mail.*nicht eingerichtet/);
    expect(logged[1]!.message).toContain('application token is invalid');
    await expect(n.test('pushover')).rejects.toThrow('Pushover lehnt ab: application token is invalid');
    push.reject = null;
    await n.test('pushover');
    expect(push.messages.at(-1)).toMatchObject({ title: 'Kaveyl Wiki: Testnachricht', priority: '-1' });
  });

  it('never throws, even when the settings cannot be written: the failure is logged, send and dispatch settle', async () => {
    n.savePushover({ token: TOKEN, userKey: USER });
    n.saveRules({ nightly: { pushover: true } });
    const set = settings.set;
    settings.set = (k, v) => {
      if (k === 'notify_window' || k === 'notify_sent') throw new Error('database or disk is full');
      set(k, v);
    };
    expect(await n.send({ event: 'nightly', title: 'Nachtlauf', text: 'x' })).toEqual([]);
    expect(await n.send({ event: 'nightly', title: 'Nachtlauf', text: 'x', key: 'k' })).toEqual([]);
    n.dispatch({ event: 'nightly', title: 'Nachtlauf', text: 'x' });
    await n.idle();
    expect(push.messages).toHaveLength(0);
    expect(logged.map((e) => e.action)).toEqual(['notify-failed', 'notify-failed', 'notify-failed']);
    expect(logged[0]).toMatchObject({ category: 'error' });
    expect(logged[0]!.message).toContain('database or disk is full');
  });

  it('turns sync failures, conflicts and recovery from the log into notices', async () => {
    n.savePushover({ token: TOKEN, userKey: USER });
    n.saveRules({ sync: { pushover: true } });
    const mount = { id: 'm1', name: 'Wiki' };
    n.observe({ category: 'error', action: 'sync-failed', mount, message: 'Push abgelehnt' });
    n.observe({ category: 'error', action: 'sync-failed', mount, message: 'Push abgelehnt (anders)' });
    await n.idle();
    expect(push.messages.map((m) => m.title)).toEqual(['Kaveyl Wiki: Sync-Fehler in „Wiki“']);
    n.observe({ category: 'sync', action: 'recovered', mount, message: 'Wieder synchron' });
    n.observe({ category: 'sync', action: 'recovered', mount: { id: 'm2', name: 'Anderes' }, message: 'Wieder synchron' });
    n.observe({ category: 'sync', level: 'warn', action: 'conflict', mount, message: 'Konflikt mit Änderungen auf dem Server: a.md' });
    await n.idle();
    expect(push.messages.map((m) => m.title).slice(1).sort()).toEqual(['Kaveyl Wiki: Konflikt in „Wiki“', 'Kaveyl Wiki: „Wiki“ wieder synchron']);
    // After recovery, the next failure is news again.
    n.observe({ category: 'error', action: 'sync-failed', mount, message: 'wieder kaputt' });
    await n.idle();
    expect(push.messages).toHaveLength(4);
  });

  it('reports a burst of failed logins once an hour', async () => {
    n.savePushover({ token: TOKEN, userKey: USER });
    n.saveRules({ security: { pushover: true } });
    for (let i = 0; i < 9; i++) n.observe({ category: 'audit', action: 'login-failed', message: 'x', detail: { ip: `10.0.0.${i % 2}` } });
    await n.idle();
    expect(push.messages).toHaveLength(0);
    for (let i = 0; i < 5; i++) n.observe({ category: 'audit', action: 'login-failed', message: 'x', detail: { ip: '10.0.0.9' } });
    await n.idle();
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]).toMatchObject({ title: 'Kaveyl Wiki: Viele fehlgeschlagene Anmeldungen', priority: '1' });
    expect(push.messages[0]!.message).toMatch(/^10 fehlgeschlagene Anmeldungen in den letzten 15 Minuten \(von 3 Adressen\)/);
    // Spread out over more than 15 minutes: no burst.
    now += 2 * 3_600_000;
    for (let i = 0; i < 12; i++) {
      now += 2 * 60_000;
      n.observe({ category: 'audit', action: 'login-failed', message: 'x', detail: { ip: '10.0.0.1' } });
    }
    await n.idle();
    expect(push.messages).toHaveLength(1);
  });

  it('lowDisk is quiet with enough space and speaks up below the limit', async () => {
    expect(await lowDisk(root, 1)).toBeNull();
    expect(await lowDisk(root, Number.MAX_SAFE_INTEGER)).toMatch(/(GB|MB) \(\d+ %\)$/);
  });
});

describe('Benachrichtigungen in der App', () => {
  const ADMIN_PW = 'Sehr-geheim-Passwort-123';
  let root: string;
  let app: App;
  let smtp: FakeSmtp;
  let push: FakePushover;
  let cookie: string;
  type Res = { statusCode: number; json: () => any; cookies: { name: string; value: string }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown, c: string | null = cookie) =>
    app.server.inject({ method, url, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}), headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(c ? { cookie: c } : {}) } }) as Promise<Res>;

  beforeEach(async () => {
    smtp = new FakeSmtp();
    await smtp.start();
    push = new FakePushover();
    await push.start();
    root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-notify-app-'));
    mkdirSync(join(root, 'projekte', 'wiki'), { recursive: true });
    writeFileSync(join(root, 'projekte', 'wiki', 'start.md'), '# Start\n');
    const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
    app = await buildApp(config, { logger: false, nightlyFsck: false, pushoverUrl: push.url });
    await app.manager.start();
    const setup = await req('POST', '/api/setup', { email: 'admin@example.test', password: ADMIN_PW, displayName: 'Anna Admin' }, null);
    cookie = `kw_session=${setup.cookies.find((c) => c.name === 'kw_session')!.value}`;
    await req('PUT', '/api/admin/mail', { host: '127.0.0.1', port: smtp.port, security: 'none', fromAddress: 'wiki@example.test', publicUrl: 'https://wiki.example.test' });
  });

  afterEach(async () => {
    await app.close();
    await smtp.stop();
    await push.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('settings: admins only, keys stay secret, changes are audited', async () => {
    const user = await req('POST', '/api/admin/users', { email: 'max@example.test', password: 'Start-Passwort-0001' });
    expect(user.statusCode).toBe(200);
    const max = await req('POST', '/api/login', { email: 'max@example.test', password: 'Start-Passwort-0001' }, null);
    const maxCookie = `kw_session=${max.cookies.find((c) => c.name === 'kw_session')!.value}`;
    expect((await req('GET', '/api/admin/notify', undefined, maxCookie)).statusCode).toBe(403);

    const first = (await req('GET', '/api/admin/notify')).json();
    expect(first).toMatchObject({ rules: defaultRules(), channels: { mail: true, pushover: false }, recipients: ['admin@example.test'] });
    expect((await req('PUT', '/api/admin/notify', { pushover: { token: 'falsch' } })).json().error).toMatch(/API-Token/);
    const saved = await req('PUT', '/api/admin/notify', { pushover: { token: TOKEN, userKey: USER }, rules: { security: { mail: true, pushover: true } } });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain(TOKEN);
    expect(saved.json()).toMatchObject({ pushover: { tokenSet: true, userKeySet: true }, channels: { pushover: true }, rules: { security: { mail: true, pushover: true } } });
    const log = (await req('GET', '/api/activity?category=audit&limit=5')).json() as { action: string; message: string }[];
    const entry = log.find((e) => e.action === 'notify-settings')!;
    expect(entry.message).toContain('Pushover-Token geändert');
    expect(entry.message).not.toContain(TOKEN);
  });

  it('test messages: mail to the admin, Pushover with the stored keys', async () => {
    expect((await req('POST', '/api/admin/notify/test', { channel: 'pushover' })).json().error).toMatch(/nicht eingerichtet/);
    await req('PUT', '/api/admin/notify', { pushover: { token: TOKEN, userKey: USER } });
    expect((await req('POST', '/api/admin/notify/test', { channel: 'pushover' })).statusCode).toBe(200);
    expect(push.messages[0]).toMatchObject({ title: 'Kaveyl Wiki: Testnachricht', url: 'https://wiki.example.test/' });
    expect((await req('POST', '/api/admin/notify/test', { channel: 'mail' })).statusCode).toBe(200);
    const mail = await smtp.waitFor('admin@example.test');
    expect(mail.subject).toBe('Kaveyl Wiki: Testnachricht');
    push.reject = 'user identifier is invalid';
    const bad = await req('POST', '/api/admin/notify/test', { channel: 'pushover' });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toBe('Pushover lehnt ab: user identifier is invalid');
  });

  it('security: new admin and new API token, by the channels chosen', async () => {
    await req('PUT', '/api/admin/notify', { pushover: { token: TOKEN, userKey: USER }, rules: { security: { pushover: true, mail: true } } });
    const created = (await req('POST', '/api/admin/users', { email: 'eva@example.test', password: 'Start-Passwort-0001' })).json();
    await new Promise((r) => setTimeout(r, 100));
    expect(push.messages).toHaveLength(0);
    await req('PATCH', `/api/admin/users/${created.id}`, { isAdmin: true });
    await expect.poll(() => push.messages.length).toBe(1);
    await req('POST', '/api/tokens', { name: 'Skript', scopes: ['read'], expiresDays: 30 });
    await expect.poll(() => push.messages.length).toBe(2);
    expect(push.messages.map((m) => m.title)).toEqual(['Kaveyl Wiki: Neuer Administrator', 'Kaveyl Wiki: Neuer API-Token']);
    expect(push.messages[0]!.message).toBe('eva ist jetzt Administrator von Kaveyl Wiki (ernannt von admin).');
    expect(push.messages[1]!.message).toContain('„Skript“');
    // Mail goes to every admin with a real address — Eva is one now.
    await smtp.waitFor('eva@example.test', (m) => m.subject === 'Kaveyl Wiki: Neuer API-Token');
    await smtp.waitFor('admin@example.test', (m) => m.subject === 'Kaveyl Wiki: Neuer Administrator');
  });

  it('nightly: quiet when all is well, one summary when something fails', async () => {
    await req('PUT', '/api/admin/notify', { pushover: { token: TOKEN, userKey: USER }, rules: { nightly: { pushover: true } } });
    await app.nightly();
    expect(push.messages).toHaveLength(0);
    // The backup folder is suddenly a file: the backup fails.
    rmSync(join(root, 'config', 'backups'), { recursive: true, force: true });
    writeFileSync(join(root, 'config', 'backups'), 'kein Ordner');
    await app.nightly();
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]!.title).toMatch(/^Kaveyl Wiki: Nachtlauf: /);
    expect(push.messages[0]!.message).toMatch(/^• Nächtliche Wartung \(backup\) fehlgeschlagen/m);
  });

  it('nightly: a broken link is reported once, with source and note, and again only when it comes back', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    // Written before the source is added: indexed right away (the check reads links from the index, targets from disk).
    writeFileSync(join(wiki, 'start.md'), '# Start\n\n[Plan](plan.md)\n');
    expect((await req('POST', '/api/mounts', { type: 'local', source: wiki, name: 'Wiki' })).statusCode).toBe(200);
    await req('PUT', '/api/admin/notify', { pushover: { token: TOKEN, userKey: USER }, rules: { nightly: { pushover: true } } });
    await app.nightly();
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]!.message).toContain('eine neue Auffälligkeit');
    expect(push.messages[0]!.message).toContain('Wiki / start.md: Link auf „plan.md“ führt ins Leere');
    // Still broken the next night: nothing new, no message.
    await app.nightly();
    expect(push.messages).toHaveLength(1);
    // Fixed, then broken again: new again.
    const { id } = (await req('GET', '/api/mounts')).json()[0] as { id: string };
    expect((await req('POST', `/api/notes/${id}`, { parent: '', title: 'plan' })).json()).toEqual({ path: 'plan.md' });
    await app.nightly();
    expect(push.messages).toHaveLength(1);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/notes/${id}/plan.md`, payload: '{}', headers: { cookie, 'content-type': 'application/json' } })).statusCode).toBe(200);
    await app.nightly();
    expect(push.messages).toHaveLength(2);
  });
});
