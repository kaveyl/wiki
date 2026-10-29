// Test track for accounts and mail (AD-030): SMTP settings, „Passwort vergessen“, invitations,
// sharing a note by e-mail, guests. Mails go to a local fake SMTP server through the real Mailer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { FakeSmtp } from './mail/fake-smtp.js';

const ADMIN_PW = 'Sehr-geheim-Passwort-123';
let root: string;
let app: App;
let smtp: FakeSmtp;
let cookie: string;
let mountId: string;

type Res = { statusCode: number; json: () => any; cookies: { name: string; value: string; expires?: Date }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
const cookieOf = (res: Res) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
const post = (url: string, body: unknown, c: string | null = cookie) =>
  app.server.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) } }) as Promise<Res>;
const get = (url: string, c: string | null = cookie) => app.server.inject({ method: 'GET', url, headers: c ? { cookie: c } : {} }) as Promise<Res>;
const put = (url: string, body: unknown, c: string | null = cookie) =>
  app.server.inject({ method: 'PUT', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) } }) as Promise<Res>;
const tokenOf = (link: string, kind: 'reset' | 'invite') => new URL(link).hash.slice(`#${kind}=`.length);

async function configureMail() {
  const res = await put('/api/admin/mail', { host: '127.0.0.1', port: smtp.port, security: 'none', user: 'smtp-user', password: 'smtp-schluessel-geheim', fromAddress: 'wiki@example.test', fromName: 'Unser Wiki', publicUrl: 'https://wiki.example.test/' });
  expect(res.statusCode).toBe(200);
}

/** Admin-created user who already set their own password; returns id and session. */
async function addUser(name: string): Promise<{ id: string; cookie: string }> {
  const created = await post('/api/admin/users', { email: `${name}@example.test`, password: 'Start-Passwort-0001' });
  const c = cookieOf(await post('/api/login', { email: `${name}@example.test`, password: 'Start-Passwort-0001' }, null));
  expect((await post('/api/account/password', { current: 'Start-Passwort-0001', next: `${name}-Passwort-0001X` }, c)).statusCode).toBe(200);
  return { id: created.json().id, cookie: c };
}

beforeEach(async () => {
  smtp = new FakeSmtp();
  await smtp.start();
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-mail-'));
  const wiki = join(root, 'projekte', 'wiki');
  mkdirSync(join(wiki, 'team'), { recursive: true });
  writeFileSync(join(wiki, 'start.md'), '# Start\n\nZebrawort am Start.\n');
  writeFileSync(join(wiki, 'team', 'plan.md'), '# Plan\n\nZebrawort im Plan.\n');
  writeFileSync(join(wiki, 'team', 'lohn.md'), '# Lohn\n\nZebrawort geheim.\n');
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  cookie = cookieOf(await post('/api/setup', { email: 'admin@example.test', password: ADMIN_PW, displayName: 'Anna Admin' }, null));
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
  mountId = (await post('/api/mounts', { type: 'local', source: wiki, name: 'Wiki' })).json().id;
});

afterEach(async () => {
  await app.close();
  await smtp.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('SMTP settings', () => {
  it('admins only; the password never comes back; a test mail goes through the real transport', async () => {
    expect((await get('/api/session', null)).json().mail).toBe(false);
    await configureMail();
    const s = (await get('/api/admin/mail')).json();
    expect(s).toMatchObject({ host: '127.0.0.1', security: 'none', user: 'smtp-user', passwordSet: true, publicUrl: 'https://wiki.example.test', configured: true });
    expect(JSON.stringify(s)).not.toContain('smtp-schluessel-geheim');
    expect((await get('/api/session', null)).json().mail).toBe(true);
    expect((await post('/api/admin/mail/test', {})).json()).toEqual({ ok: true, to: 'admin@example.test' });
    const mail = await smtp.waitFor('admin@example.test');
    expect(mail.subject).toBe('Kaveyl Wiki: Testmail');
    expect(mail.raw).toMatch(/^From: "?Unser Wiki"? <wiki@example\.test>/m);
    // The logo travels inside the mail (images from elsewhere are blocked by many clients): an inline PNG the HTML points at.
    expect(mail.raw).toMatch(/Content-ID: <logo@kaveyl-wiki>/i);
    expect(mail.raw).toMatch(/Content-Type: image\/png/i);
    expect(mail.raw).toContain('cid:logo@kaveyl-wiki');
    // Not in the log either.
    expect(JSON.stringify(app.db.prepare('SELECT * FROM activity').all())).not.toContain('smtp-schluessel-geheim');
    const maria = await addUser('maria');
    expect((await get('/api/admin/mail', maria.cookie)).statusCode).toBe(403);
    expect((await put('/api/admin/mail', { host: 'evil.example' }, maria.cookie)).statusCode).toBe(403);
  });

  it('rejects odd public addresses and reports an unreachable server', async () => {
    expect((await put('/api/admin/mail', { publicUrl: 'javascript:alert(1)' })).statusCode).toBe(502);
    expect((await put('/api/admin/mail', { publicUrl: 'https://user:pw@wiki.example.test' })).statusCode).toBe(502);
    expect((await put('/api/admin/mail', { publicUrl: 'wiki.example.test:8443/kaveyl-wiki/' })).json().publicUrl).toBe('https://wiki.example.test:8443/kaveyl-wiki');
    await put('/api/admin/mail', { host: '127.0.0.1', port: 1, security: 'none', fromAddress: 'wiki@example.test' });
    const res = await post('/api/admin/mail/test', {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Versand fehlgeschlagen/);
  });
});

describe('Passwort vergessen', () => {
  it('mails a one-time link with the public address; the reset ends all sessions and sends a notice', async () => {
    await configureMail();
    const maria = await addUser('maria');
    // Host header is ignored for links (no host-header injection).
    const asked = await app.server.inject({ method: 'POST', url: '/api/password/forgot', payload: JSON.stringify({ email: 'MARIA@example.test' }), headers: { 'content-type': 'application/json', host: 'evil.example' } });
    expect(asked.json()).toEqual({ ok: true, mail: true });
    const mail = await smtp.waitFor('maria@example.test', (m) => m.subject.includes('zurücksetzen'));
    const link = FakeSmtp.link(mail, '#reset=');
    expect(link.startsWith('https://wiki.example.test/#reset=')).toBe(true);
    expect(mail.raw).not.toContain('evil.example');
    const token = tokenOf(link, 'reset');
    expect((await post('/api/invite/info', { token }, null)).json()).toMatchObject({ kind: 'reset', email: 'maria@example.test' });
    // The token is stored only as hash.
    expect(JSON.stringify(app.db.prepare('SELECT * FROM email_tokens').all())).not.toContain(token);
    expect((await post('/api/password/reset', { token, password: 'zu-schwach' }, null)).statusCode).toBe(400);
    const done = await post('/api/password/reset', { token, password: 'Ganz-Neues-Passwort-77' }, null);
    expect(done.statusCode).toBe(200);
    expect(done.cookies.find((c) => c.name === 'kw_session')!.expires).toBeUndefined();
    expect((await get('/api/mounts', maria.cookie)).statusCode).toBe(401);
    expect((await post('/api/login', { email: 'maria@example.test', password: 'Ganz-Neues-Passwort-77' }, null)).statusCode).toBe(200);
    expect((await post('/api/password/reset', { token, password: 'Noch-Ein-Passwort-777' }, null)).statusCode).toBe(400);
    await smtp.waitFor('maria@example.test', (m) => m.subject.includes('wurde geändert'));
  });

  it('answers the same for unknown addresses, sends nothing, and throttles', async () => {
    await configureMail();
    await addUser('maria');
    const unknown = await post('/api/password/forgot', { email: 'niemand@example.test' }, null);
    expect(unknown.json()).toEqual({ ok: true, mail: true });
    for (let i = 0; i < 5; i++) await post('/api/password/forgot', { email: 'maria@example.test' }, null);
    await new Promise((r) => setTimeout(r, 300));
    expect(smtp.mails.filter((m) => m.to.includes('niemand@example.test'))).toHaveLength(0);
    expect(smtp.mails.filter((m) => m.to.includes('maria@example.test') && m.subject.includes('zurücksetzen'))).toHaveLength(3);
    // Only the newest link works.
    const links = smtp.mails.filter((m) => m.subject.includes('zurücksetzen')).map((m) => tokenOf(FakeSmtp.link(m, '#reset='), 'reset'));
    expect((await post('/api/invite/info', { token: links[0] }, null)).statusCode).toBe(400);
    expect((await post('/api/invite/info', { token: links[2] }, null)).statusCode).toBe(200);
  });

  it('without SMTP: same answer, no error, the log says why', async () => {
    await addUser('maria');
    expect((await post('/api/password/forgot', { email: 'maria@example.test' }, null)).json()).toEqual({ ok: true, mail: false });
    expect(JSON.stringify(app.db.prepare('SELECT message FROM activity').all())).toContain('E-Mail-Versand ist nicht eingerichtet');
  });
});

describe('invitations', () => {
  it('admin invites a new user: the account appears only on accepting, with the chosen role', async () => {
    await configureMail();
    expect((await post('/api/admin/users', { email: 'neu@example.test', displayName: 'Nora Neu', invite: true })).json()).toEqual({ invited: true });
    expect(((await get('/api/admin/users')).json() as { email: string }[]).map((u) => u.email)).not.toContain('neu@example.test');
    const mail = await smtp.waitFor('neu@example.test');
    expect(mail.subject).toBe('Anna Admin lädt dich zu Kaveyl Wiki ein');
    const token = tokenOf(FakeSmtp.link(mail, '#invite='), 'invite');
    expect((await post('/api/invite/info', { token }, null)).json()).toMatchObject({ kind: 'invite', email: 'neu@example.test', displayName: 'Nora Neu', accountExists: false });
    const res = await post('/api/invite/accept', { token, password: 'Noras-Passwort-2026!' }, null);
    expect(res.json().user).toMatchObject({ email: 'neu@example.test', displayName: 'Nora Neu', username: 'neu', isGuest: false, isAdmin: false, mustChangePassword: false });
    expect((await get('/api/tree/' + mountId, cookieOf(res))).statusCode).toBe(200);
    expect((await post('/api/invite/accept', { token, password: 'Noras-Passwort-2026!' }, null)).statusCode).toBe(400);
    // Inviting an address that has an account is refused.
    expect((await post('/api/admin/users', { email: 'NEU@example.test', invite: true })).statusCode).toBe(400);
  });

  it('an inviter without a chosen language invites in the language of their interface', async () => {
    await configureMail();
    const res = await app.server.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: JSON.stringify({ email: 'lena@example.test', invite: true }),
      headers: { 'content-type': 'application/json', cookie, 'x-kaveyl-wiki-lang': 'en' },
    });
    expect(res.statusCode).toBe(200);
    expect((await smtp.waitFor('lena@example.test')).subject).toBe('Anna Admin invites you to Kaveyl Wiki');
  });

  it('open invitations end with the account that sent them', async () => {
    await configureMail();
    const maria = await addUser('maria');
    await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${maria.id}`, payload: JSON.stringify({ isAdmin: true }), headers: { 'content-type': 'application/json', cookie } });
    expect((await post('/api/admin/users', { email: 'gast@example.test', invite: true }, maria.cookie)).json()).toEqual({ invited: true });
    expect((await post('/api/admin/users', { email: 'bleibt@example.test', invite: true })).json()).toEqual({ invited: true });
    const token = tokenOf(FakeSmtp.link(await smtp.waitFor('gast@example.test'), '#invite='), 'invite');
    const kept = tokenOf(FakeSmtp.link(await smtp.waitFor('bleibt@example.test'), '#invite='), 'invite');
    expect((await post('/api/invite/info', { token }, null)).statusCode).toBe(200);
    expect((await app.server.inject({ method: 'DELETE', url: `/api/admin/users/${maria.id}`, payload: '{}', headers: { 'content-type': 'application/json', cookie } })).statusCode).toBe(200);
    expect((await post('/api/invite/info', { token }, null)).statusCode).toBe(400);
    expect((await post('/api/invite/accept', { token, password: 'Gast-Passwort-2026!' }, null)).statusCode).toBe(400);
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM email_tokens WHERE created_by = ?').get(maria.id)).toEqual({ n: 0 });
    // Invitations of others stay.
    expect((await post('/api/invite/info', { token: kept }, null)).statusCode).toBe(200);
  });

  it('without SMTP an invitation is refused with a clear message', async () => {
    const res = await post('/api/admin/users', { email: 'neu@example.test', invite: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/nicht eingerichtet/);
  });
});

describe('sharing a note by e-mail (guests)', () => {
  const tree = async (c: string) => ((await get(`/api/tree/${mountId}`, c)).json() as { path: string }[]).map((e) => e.path).sort();

  it('a new person becomes a guest who sees exactly that note — even though the default level is „write“', async () => {
    await configureMail();
    expect((await post('/api/share', { mountId, path: 'team/plan.md', email: 'kunde@example.test' })).json()).toEqual({ existing: false });
    const mail = await smtp.waitFor('kunde@example.test');
    expect(mail.subject).toBe('Anna Admin hat die Notiz „plan“ mit dir geteilt');
    const token = tokenOf(FakeSmtp.link(mail, '#invite='), 'invite');
    expect((await post('/api/invite/info', { token }, null)).json()).toMatchObject({ note: 'plan', inviter: 'Anna Admin' });
    // The name the person chose; a line break in it is taken out (sec-004).
    const res = await post('/api/invite/accept', { token, displayName: 'Karl\nKunde', password: 'Karls-Passwort-2026!' }, null);
    expect(res.json()).toMatchObject({ user: { isGuest: true, displayName: 'Karl Kunde' }, note: { mountId, path: 'team/plan.md' } });
    const guest = cookieOf(res);
    expect(await tree(guest)).toEqual(['team', 'team/plan.md']);
    expect((await get(`/api/notes/${mountId}/team/plan.md`, guest)).statusCode).toBe(200);
    expect((await get(`/api/notes/${mountId}/team/lohn.md`, guest)).statusCode).toBe(404);
    expect((await get(`/api/notes/${mountId}/start.md`, guest)).statusCode).toBe(404);
    const hits = (await get('/api/search?q=Zebrawort', guest)).json() as Record<'folders' | 'notes' | 'content', { path: string }[]>;
    expect([...hits.folders, ...hits.notes, ...hits.content].map((h) => h.path)).toEqual(['team/plan.md']);
    // Read only; no tokens, no invitations.
    const note = (await get(`/api/notes/${mountId}/team/plan.md`, guest)).json() as { hash: string; access: string };
    expect((await put(`/api/notes/${mountId}/team/plan.md`, { raw: '# x\n', baseHash: note.hash }, guest)).statusCode).toBe(403);
    expect((await post('/api/tokens', { name: 'x', scopes: ['read'] }, guest)).statusCode).toBe(400);
    expect((await post('/api/share', { mountId, path: 'team/plan.md', email: 'freund@example.test' }, guest)).statusCode).toBe(403);
    // The admin turns the guest into a normal user: the default level applies again.
    const karl = ((await get('/api/admin/users')).json() as { id: string; email: string }[]).find((u) => u.email === 'kunde@example.test')!;
    await app.server.inject({ method: 'PATCH', url: `/api/admin/users/${karl.id}`, payload: JSON.stringify({ isGuest: false }), headers: { 'content-type': 'application/json', cookie } });
    expect(await tree(guest)).toContain('start.md');
  });

  it('existing accounts get access at once (never less than before) and a notice mail', async () => {
    await configureMail();
    const maria = await addUser('maria');
    // Maria may write everywhere (default level): sharing must not turn plan.md read-only for her.
    expect((await post('/api/share', { mountId, path: 'team/plan.md', email: 'maria@example.test' })).json()).toEqual({ existing: true });
    expect(((await get(`/api/notes/${mountId}/team/plan.md`, maria.cookie)).json() as { access: string }).access).toBe('write');
    const notice = await smtp.waitFor('maria@example.test', (m) => m.subject.includes('geteilt'));
    expect(FakeSmtp.link(notice, '/n/')).toBe(`https://wiki.example.test/n/${mountId}/team/plan.md`);
    // Locked out of team/: the share opens just this note, for reading.
    await post(`/api/acl/${mountId}`, { target: 'mount', subject: 'all', level: 'none' });
    expect((await get(`/api/notes/${mountId}/team/lohn.md`, maria.cookie)).statusCode).toBe(404);
    await post('/api/share', { mountId, path: 'team/lohn.md', email: 'maria@example.test' });
    expect(((await get(`/api/notes/${mountId}/team/lohn.md`, maria.cookie)).json() as { access: string }).access).toBe('read');
  });

  it('only who may manage the note can share it; an explicit lock is reported', async () => {
    await configureMail();
    const maria = await addUser('maria');
    const bob = await addUser('bob');
    // Default „write“ is not enough to invite.
    expect((await post('/api/share', { mountId, path: 'team/plan.md', email: 'x@example.test' }, maria.cookie)).statusCode).toBe(403);
    await post(`/api/acl/${mountId}`, { target: 'folder', path: 'team', subject: 'user', subjectId: maria.id, level: 'admin' });
    expect((await post('/api/share', { mountId, path: 'team/plan.md', email: 'x@example.test' }, maria.cookie)).statusCode).toBe(200);
    // Bob is locked out of team/ explicitly: a note share would not help, so it is refused.
    await post(`/api/acl/${mountId}`, { target: 'folder', path: 'team', subject: 'user', subjectId: bob.id, level: 'none' });
    const res = await post('/api/share', { mountId, path: 'team/plan.md', email: 'bob@example.test' }, maria.cookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/gesperrt/);
    // Locked on the note itself: the share would replace that rule – refused, the lock stays.
    const carl = await addUser('carl');
    await post(`/api/acl/${mountId}`, { target: 'note', path: 'team/plan.md', subject: 'user', subjectId: carl.id, level: 'none' });
    const locked = await post('/api/share', { mountId, path: 'team/plan.md', email: 'carl@example.test' });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error).toMatch(/für die Notiz gesperrt/);
    expect((await get(`/api/notes/${mountId}/team/plan.md`, carl.cookie)).statusCode).toBe(404);
  });
});

describe('sharing a folder or a whole source by e-mail (owner 21.10.)', () => {
  const tree = async (c: string) => ((await get(`/api/tree/${mountId}`, c)).json() as { path: string }[]).map((e) => e.path).sort();
  const access = async (path: string, c: string) => ((await get(`/api/notes/${mountId}/${path}`, c)).json() as { access: string }).access;

  it('a folder with „lesen & schreiben“: the guest sees and edits everything inside, nothing outside', async () => {
    await configureMail();
    expect((await post('/api/share', { mountId, target: 'folder', path: 'team', level: 'write', email: 'kunde@example.test' })).json()).toEqual({ existing: false });
    const mail = await smtp.waitFor('kunde@example.test');
    expect(mail.subject).toBe('Anna Admin hat den Ordner „team“ mit dir geteilt');
    expect(mail.text).toContain('mit allem, was darin liegt');
    expect(mail.text).toContain('Du darfst dort lesen und bearbeiten.');
    const token = tokenOf(FakeSmtp.link(mail, '#invite='), 'invite');
    expect((await post('/api/invite/info', { token }, null)).json()).toMatchObject({ folder: 'team', level: 'write', inviter: 'Anna Admin' });
    const res = await post('/api/invite/accept', { token, password: 'Karls-Passwort-2026!' }, null);
    expect(res.json()).toMatchObject({ user: { isGuest: true }, folder: { mountId, path: 'team' } });
    const guest = cookieOf(res);
    expect(await tree(guest)).toEqual(['team', 'team/lohn.md', 'team/plan.md']);
    expect(await access('team/lohn.md', guest)).toBe('write');
    const note = (await get(`/api/notes/${mountId}/team/plan.md`, guest)).json() as { hash: string };
    expect((await put(`/api/notes/${mountId}/team/plan.md`, { raw: '# Plan\n\nVom Gast.\n', baseHash: note.hash }, guest)).statusCode).toBe(200);
    expect((await get(`/api/notes/${mountId}/start.md`, guest)).statusCode).toBe(404);
    // Guests never manage: no sharing further, no rules.
    expect((await post('/api/share', { mountId, target: 'folder', path: 'team', email: 'freund@example.test' }, guest)).statusCode).toBe(403);
  });

  it('an account without a chosen language gets mails in the language its interface shows', async () => {
    await configureMail();
    const tom = await addUser('tom');
    // Tom's browser app shows English (automatic: the browser's language) – one request is enough to know it.
    const seen = await app.server.inject({ method: 'GET', url: '/api/watches', headers: { cookie: tom.cookie, 'x-kaveyl-wiki-lang': 'en' } });
    expect(seen.statusCode).toBe(200);
    await post('/api/share', { mountId, target: 'mount', email: 'tom@example.test' });
    expect((await smtp.waitFor('tom@example.test', (m) => m.subject.includes('shared'))).subject).toBe('Anna Admin shared the source “Wiki” with you');
  });

  it('a whole source for an existing account: read access everywhere in it, a link that shows it in the tree', async () => {
    await configureMail();
    const maria = await addUser('maria');
    await post(`/api/acl/${mountId}`, { target: 'mount', subject: 'all', level: 'none' });
    expect((await get(`/api/tree/${mountId}`, maria.cookie)).statusCode).toBe(404);
    expect((await post('/api/share', { mountId, target: 'mount', email: 'maria@example.test' })).json()).toEqual({ existing: true });
    expect(await tree(maria.cookie)).toEqual(['start.md', 'team', 'team/lohn.md', 'team/plan.md']);
    expect(await access('start.md', maria.cookie)).toBe('read');
    const notice = await smtp.waitFor('maria@example.test', (m) => m.subject.includes('geteilt'));
    expect(notice.subject).toBe('Anna Admin hat die Quelle „Wiki“ mit dir geteilt');
    expect(FakeSmtp.link(notice, '/t/')).toBe(`https://wiki.example.test/t/${mountId}/`);
    // Sharing again with more raises her own rule; with less it never lowers it.
    await post('/api/share', { mountId, target: 'mount', level: 'write', email: 'maria@example.test' });
    expect(await access('start.md', maria.cookie)).toBe('write');
    await post('/api/share', { mountId, target: 'mount', level: 'read', email: 'maria@example.test' });
    expect(await access('start.md', maria.cookie)).toBe('write');
  });

  it('in the language of the account: every paragraph of the mail is translated', async () => {
    await configureMail();
    const maria = await addUser('maria');
    app.db.prepare("INSERT OR REPLACE INTO user_state (user_id, key, value_json) VALUES (?, 'prefs', ?)").run(maria.id, JSON.stringify({ language: 'en' }));
    await post(`/api/acl/${mountId}`, { target: 'mount', subject: 'all', level: 'none' });
    await post('/api/share', { mountId, target: 'folder', path: 'team', email: 'maria@example.test' });
    const mail = await smtp.waitFor('maria@example.test', (m) => m.subject.includes('shared'));
    expect(mail.subject).toBe('Anna Admin shared the folder “team” with you');
    expect(mail.text).toContain('Hello maria,');
    expect(mail.text).toContain('Anna Admin shared the folder “team” with you in Kaveyl Wiki, with everything in it.');
    expect(mail.text).toContain('You may read there.');
  });

  it('only who manages the folder shares it; a lock is never lifted and a share that cannot work changes nothing', async () => {
    await configureMail();
    const maria = await addUser('maria');
    const bob = await addUser('bob');
    expect((await post('/api/share', { mountId, target: 'folder', path: 'team', email: 'x@example.test' }, maria.cookie)).statusCode).toBe(403);
    expect((await post('/api/share', { mountId, target: 'mount', email: 'x@example.test' }, maria.cookie)).statusCode).toBe(403);
    expect((await post('/api/share', { mountId, target: 'folder', path: 'team', level: 'admin', email: 'x@example.test' })).statusCode).toBe(400);
    expect((await post('/api/share', { mountId, target: 'folder', path: 'gibtsnicht', email: 'x@example.test' })).statusCode).toBe(400);
    // Locked right there: refused, the lock stays.
    await post(`/api/acl/${mountId}`, { target: 'folder', path: 'team', subject: 'user', subjectId: bob.id, level: 'none' });
    const locked = await post('/api/share', { mountId, target: 'folder', path: 'team', email: 'bob@example.test' });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error).toMatch(/für den Ordner gesperrt/);
    expect(await tree(bob.cookie)).toEqual(['start.md']);
    // Locked through a group on the source: the share would not work – her rules stay as they were.
    const group = (await post('/api/admin/groups', { name: 'Draußen' })).json() as { id: string };
    await app.server.inject({ method: 'PATCH', url: `/api/admin/groups/${group.id}`, payload: JSON.stringify({ members: [maria.id] }), headers: { 'content-type': 'application/json', cookie } });
    await post(`/api/acl/${mountId}`, { target: 'mount', subject: 'group', subjectId: group.id, level: 'none' });
    await post(`/api/acl/${mountId}`, { target: 'folder', path: 'team', subject: 'user', subjectId: maria.id, level: 'read' });
    const blocked = await post('/api/share', { mountId, target: 'folder', path: 'team', level: 'write', email: 'maria@example.test' });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatch(/die Freigabe würde nicht greifen/);
    const rules = (await get(`/api/acl/${mountId}?target=folder&path=team`)).json() as { rules: { subjectId: string | null; level: string }[] };
    expect(rules.rules.filter((r) => r.subjectId === maria.id).map((r) => r.level)).toEqual(['read']);
  });
});

describe('several notes at once and notes sent by mail (owner 28.10.)', () => {
  const tree = async (c: string) => ((await get(`/api/tree/${mountId}`, c)).json() as { path: string }[]).map((e) => e.path).sort();

  it('one invitation for several notes: the guest gets all of them, the mail names them', async () => {
    await configureMail();
    const res = await post('/api/share', { mountId, path: 'team/plan.md', more: [{ target: 'note', path: 'start.md' }], email: 'kunde@example.test' });
    expect(res.json()).toEqual({ existing: false });
    const mail = await smtp.waitFor('kunde@example.test');
    expect(mail.subject).toBe('Anna Admin hat 2 Notizen mit dir geteilt');
    expect(mail.text).toContain('„plan“, „start“');
    const token = tokenOf(FakeSmtp.link(mail, '#invite='), 'invite');
    const guest = cookieOf(await post('/api/invite/accept', { token, password: 'Karls-Passwort-2026!' }, null));
    expect(await tree(guest)).toEqual(['start.md', 'team', 'team/plan.md']);
    // An existing account: everything at once, one mail.
    const maria = await addUser('maria');
    await post(`/api/acl/${mountId}`, { target: 'mount', subject: 'all', level: 'none' });
    await post('/api/share', { mountId, path: 'team/lohn.md', more: [{ target: 'folder', path: 'team' }], email: 'maria@example.test' });
    expect((await smtp.waitFor('maria@example.test', (m) => m.subject.includes('geteilt'))).subject).toBe('Anna Admin hat 2 Notizen und Ordner mit dir geteilt');
    expect(await tree(maria.cookie)).toEqual(['team', 'team/lohn.md', 'team/plan.md']);
  });

  it('every further one needs „verwalten“ there, too', async () => {
    await configureMail();
    const maria = await addUser('maria');
    await post(`/api/acl/${mountId}`, { target: 'folder', path: 'team', subject: 'user', subjectId: maria.id, level: 'admin' });
    const res = await post('/api/share', { mountId, path: 'team/plan.md', more: [{ target: 'note', path: 'start.md' }], email: 'x@example.test' }, maria.cookie);
    expect(res.statusCode).toBe(403);
    expect(smtp.mails).toHaveLength(0);
  });

  it('notes go out as .md attachments to any address, answers to the sender; no links', async () => {
    await configureMail();
    const maria = await addUser('maria');
    const res = await post('/api/mail-notes', { mountId, paths: ['team/plan.md', 'start.md'], to: ['partner@extern.test', 'zweite@extern.test'] }, maria.cookie);
    expect(res.json()).toEqual({ sent: 2, notes: 2 });
    const mail = await smtp.waitFor('partner@extern.test');
    expect(mail.subject).toBe('maria hat dir 2 Notizen aus Kaveyl Wiki geschickt');
    expect(mail.text).toContain('„plan“, „start“');
    expect(mail.text).toContain('Antworten auf diese Mail gehen an maria.');
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.raw).toMatch(/^Reply-To: "?maria"? <maria@example\.test>/m);
    expect(mail.raw).toMatch(/filename="?plan\.md"?/);
    expect(mail.raw).toMatch(/filename="?start\.md"?/);
    expect(mail.raw).toContain(Buffer.from('# Plan\n\nZebrawort im Plan.\n').toString('base64'));
    // One mail per address: nobody sees the other.
    expect((await smtp.waitFor('zweite@extern.test')).raw).not.toContain('partner@extern.test');
    // The log says to whom.
    expect(JSON.stringify(app.db.prepare("SELECT message FROM activity WHERE action = 'note-mailed'").all())).toContain('partner@extern.test');
  });

  it('only what the person may read; no guests, no folders, no encrypted notes, not without mail, limited', async () => {
    const maria = await addUser('maria');
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: ['a@extern.test'] }, maria.cookie)).statusCode).toBe(400);
    await configureMail();
    await post(`/api/acl/${mountId}`, { target: 'note', path: 'team/lohn.md', subject: 'user', subjectId: maria.id, level: 'none' });
    expect((await post('/api/mail-notes', { mountId, paths: ['team/lohn.md'], to: ['a@extern.test'] }, maria.cookie)).statusCode).toBe(404);
    expect((await post('/api/mail-notes', { mountId, paths: ['team'], to: ['a@extern.test'] }, maria.cookie)).statusCode).toBe(400);
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: ['kein-mail'] }, maria.cookie)).statusCode).toBe(400);
    writeFileSync(join(root, 'projekte', 'wiki', 'geheim.md'), '---\nencrypted: age\n---\n-----BEGIN AGE ENCRYPTED FILE-----\nYWJj\n-----END AGE ENCRYPTED FILE-----\n');
    for (let i = 0; i < 50 && !(await tree(cookie)).includes('geheim.md'); i++) await new Promise((r) => setTimeout(r, 100));
    const enc = await post('/api/mail-notes', { mountId, paths: ['geheim.md'], to: ['a@extern.test'] }, maria.cookie);
    expect(enc.statusCode).toBe(403);
    // 30 addresses per hour and person.
    const many = (n: number) => Array.from({ length: n }, (_, i) => `p${n}-${i}@extern.test`);
    for (let i = 0; i < 3; i++) expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: many(10).map((a) => `${i}${a}`) }, maria.cookie)).statusCode).toBe(200);
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: ['spaet@extern.test'] }, maria.cookie)).json().error).toMatch(/Zu viele Mails/);
    expect(smtp.mails.some((m) => m.to.includes('spaet@extern.test'))).toBe(false);
    // Guests never.
    await post('/api/share', { mountId, path: 'start.md', email: 'gast@example.test' });
    const token = tokenOf(FakeSmtp.link(await smtp.waitFor('gast@example.test'), '#invite='), 'invite');
    const guest = cookieOf(await post('/api/invite/accept', { token, password: 'Gast-Passwort-2026!' }, null));
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: ['a@extern.test'] }, guest)).statusCode).toBe(403);
  });

  it('an invitation gives only what the inviter may still share when it is accepted (audit 28.10. sec-004)', async () => {
    await configureMail();
    const maria = await addUser('maria');
    await post(`/api/acl/${mountId}`, { target: 'folder', path: 'team', subject: 'user', subjectId: maria.id, level: 'admin' });
    await post(`/api/acl/${mountId}`, { target: 'note', path: 'start.md', subject: 'user', subjectId: maria.id, level: 'admin' });
    expect((await post('/api/share', { mountId, path: 'team/plan.md', more: [{ target: 'note', path: 'start.md' }], email: 'kunde@example.test' }, maria.cookie)).statusCode).toBe(200);
    // Before the guest accepts, Maria loses „verwalten“ on start.md.
    await post(`/api/acl/${mountId}`, { target: 'note', path: 'start.md', subject: 'user', subjectId: maria.id, level: 'read' });
    const token = tokenOf(FakeSmtp.link(await smtp.waitFor('kunde@example.test'), '#invite='), 'invite');
    const guest = cookieOf(await post('/api/invite/accept', { token, password: 'Karls-Passwort-2026!' }, null));
    expect(await tree(guest)).toEqual(['team', 'team/plan.md']);
  });

  it('a request over the limit counts nothing; odd addresses are refused before anything goes out (audit 28.10. code-005, sec-002)', async () => {
    await configureMail();
    const maria = await addUser('maria');
    const many = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i}@extern.test`);
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: many('a', 10) }, maria.cookie)).statusCode).toBe(200);
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: many('b', 10) }, maria.cookie)).statusCode).toBe(200);
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: many('c', 5) }, maria.cookie)).statusCode).toBe(200);
    // 25 used: 10 more do not fit – refused, and the 5 places left are still there.
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: many('d', 10) }, maria.cookie)).json().error).toMatch(/Zu viele Mails/);
    expect((await post('/api/mail-notes', { mountId, paths: ['start.md'], to: many('e', 5) }, maria.cookie)).statusCode).toBe(200);
    const before = smtp.mails.length;
    const odd = await post('/api/mail-notes', { mountId, paths: ['start.md'], to: ['(a@b.example)'] }, maria.cookie);
    expect(odd.statusCode).toBe(400);
    expect(smtp.mails.length).toBe(before);
  });
});

