// Sign-in through an auth proxy (AD-049) end to end: only requests straight from the configured proxy address count
// (socket, never X-Forwarded-For), only connected accounts, sessions end when the proxy stops naming the person.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions, Response } from 'light-my-request';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { hashProxySecret } from './proxyAuth.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let root: string;
let app: App;
let admin: string;
const PROXY = '192.168.1.40';
const OTHER = '192.168.1.77';
/** The container's default gateway, injected – the host's own route table must not decide the test. */
const GATEWAY = '172.17.0.1';
const inject = (o: InjectOptions): Promise<Response> => app.server.inject(o);
const json = (payload: unknown, headers: Record<string, string> = {}) => ({ payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...headers } });
const cookieOf = (res: Response) => {
  const c = res.cookies.find((x) => x.name === 'kw_session');
  return c?.value ? `kw_session=${c.value}` : null;
};
const ak = (uid: string, email = 'x@example.test') => ({ 'x-authentik-uid': uid, 'x-authentik-email': email });
/** A request as the proxy forwards it. */
const viaProxy = (url: string, headers: Record<string, string>, extra: Partial<InjectOptions> = {}) => inject({ method: 'GET', url, remoteAddress: PROXY, headers, ...extra });

async function login(email: string, password: string) {
  return cookieOf(await inject({ method: 'POST', url: '/api/login', payload: { email, password } }))!;
}
async function addUser(name: string, isAdmin = false) {
  const res = await inject({ method: 'POST', url: '/api/admin/users', ...json({ email: `${name}@example.test`, username: name, password: 'Start-Passwort-0001', isAdmin }, { cookie: admin }) });
  const id = (res.json() as { id: string }).id;
  const c = await login(`${name}@example.test`, 'Start-Passwort-0001');
  const pw = `${name}-Neues-Passwort-0001`;
  await inject({ method: 'POST', url: '/api/account/password', ...json({ current: 'Start-Passwort-0001', next: pw }, { cookie: c }) });
  return { id, password: pw, cookie: await login(`${name}@example.test`, pw) };
}
const setAuthentik = (body: Record<string, unknown>) => inject({ method: 'PUT', url: '/api/admin/proxy-auth/authentik', ...json(body, { cookie: admin }) });
/** Stores a raw Authentik setting (as an older version may have saved it); returns how to put the previous one back. */
function storeAuthentik(value: object): () => void {
  const prev = (app.db.prepare("SELECT value FROM settings WHERE key = 'proxy_auth_authentik'").get() as { value: string } | undefined)?.value;
  const put = (v: string) => app.db.prepare("INSERT INTO settings (key, value) VALUES ('proxy_auth_authentik', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
  put(JSON.stringify(value));
  return () => (prev === undefined ? app.db.prepare("DELETE FROM settings WHERE key = 'proxy_auth_authentik'").run() : put(prev));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-proxy-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  app = await buildApp(
    { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') },
    { logger: false, nightlyFsck: false, gateway: GATEWAY },
  );
  const setup = await inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Admin-Passwort-000001', displayName: 'Admin' } });
  admin = cookieOf(setup)!;
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('settings (admins)', () => {
  it('off by default; switching on needs a single proxy address; ranges, catch-alls and reserved headers are refused', async () => {
    const r = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: admin } });
    expect(r.json()).toMatchObject({ config: { enabled: false, proxies: [], idHeader: 'x-authentik-uid', emailHeader: 'x-authentik-email' } });
    // Each refusal names its field: the form shows the message there (design-006).
    const refused = async (body: Record<string, unknown>, field: string) => {
      const res = await setAuthentik(body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ field, error: expect.any(String) });
    };
    await refused({ enabled: true, proxies: [] }, 'proxies');
    await refused({ enabled: true, proxies: ['192.168.1.0/24'] }, 'proxies');
    await refused({ enabled: true, proxies: ['0.0.0.0'] }, 'proxies');
    await refused({ enabled: true, proxies: [PROXY], idHeader: 'Cookie' }, 'idHeader');
    await refused({ enabled: true, proxies: [PROXY], idHeader: 'remote-user', emailHeader: 'Remote-User' }, 'emailHeader');
    await refused({ enabled: true, proxies: [PROXY], logoutUrl: 'javascript:alert(1)' }, 'logoutUrl');
    // Switched on without a sign-out address, „Abmelden“ would sign in again at once (AD-058).
    await refused({ enabled: true, proxies: [PROXY] }, 'logoutUrl');
    expect((await inject({ method: 'GET', url: '/api/admin/proxy-auth/keycloak', headers: { cookie: admin } })).statusCode).toBe(404);
    const ok = await setAuthentik({ enabled: true, proxies: [PROXY], idHeader: 'X-Authentik-UID', logoutUrl: 'https://wiki.example.test/outpost.goauthentik.io/sign_out' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ config: { enabled: true, proxies: [PROXY], idHeader: 'x-authentik-uid' } });
  });

  it('normal users cannot read or change it', async () => {
    const u = await addUser('nina');
    expect((await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: u.cookie } })).statusCode).toBe(403);
    expect((await inject({ method: 'PUT', url: '/api/admin/proxy-auth/authentik', ...json({ enabled: false }, { cookie: u.cookie }) })).statusCode).toBe(403);
  });

  it('the setup help shows what arrived – header values only from the trusted address', async () => {
    const trusted = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', remoteAddress: PROXY, headers: { cookie: admin, ...ak('uid-admin', 'admin@example.test') } });
    expect(trusted.json()).toMatchObject({ request: { socket: PROXY, trusted: true, idHeaderSeen: true, subject: 'uid-admin', email: 'admin@example.test' } });
    const other = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', remoteAddress: OTHER, headers: { cookie: admin, ...ak('uid-admin') } });
    expect(other.json()).toMatchObject({ request: { socket: OTHER, trusted: false, idHeaderSeen: true, subject: null } });
  });

  it('the Docker gateway is refused as a proxy address (owner 2026-10-16, sec-002) – with a help anchor; loopback only flagged', async () => {
    const before = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', remoteAddress: OTHER, headers: { cookie: admin } });
    expect(before.json()).toMatchObject({ loopback: [], secretSet: false, request: { gateway: GATEWAY, socketIsGateway: false } });
    expect((await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', remoteAddress: GATEWAY, headers: { cookie: admin } })).json()).toMatchObject({ request: { socketIsGateway: true } });
    // Entered over the LAN address: refused all the same, nothing stored
    const refused = await inject({ method: 'PUT', url: '/api/admin/proxy-auth/authentik', remoteAddress: OTHER, ...json({ enabled: true, proxies: [PROXY, GATEWAY] }, { cookie: admin }) });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ help: 'authentik', field: 'proxies', error: expect.stringContaining('172.17.0.1 ist das Docker-Gateway und als Proxy-Adresse nicht erlaubt') });
    const en = await inject({ method: 'PUT', url: '/api/admin/proxy-auth/authentik', ...json({ enabled: true, proxies: [`::ffff:${GATEWAY}`] }, { cookie: admin, 'x-kaveyl-wiki-lang': 'en' }) });
    expect(en.json()).toMatchObject({ help: 'authentik', error: expect.stringContaining('172.17.0.1 is the Docker gateway and not allowed as a proxy address') });
    expect((await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: admin } })).json()).toMatchObject({ config: { proxies: [PROXY] } });
    // Loopback stays possible (proxy on the same machine, host network) but the tab flags it
    const loop = await setAuthentik({ enabled: true, proxies: [PROXY, '127.0.0.1'] });
    expect(loop.json()).toMatchObject({ loopback: ['127.0.0.1'] });
    expect((await setAuthentik({ enabled: true, proxies: [PROXY] })).json()).toMatchObject({ loopback: [] });
  });

  it('a gateway stored before the refusal switches the sign-in off (fail-closed) and the tab says why', async () => {
    const stored = { enabled: true, proxies: [GATEWAY], idHeader: 'remote-user', emailHeader: 'remote-email', logoutUrl: 'https://wiki.example.test/outpost.goauthentik.io/sign_out', autoLinkByEmail: false, secretHash: hashProxySecret('der-alte-Geheimwert') };
    const restore = storeAuthentik(stored);
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: GATEWAY, headers: { 'remote-user': 'bea' } })).statusCode).toBe(401);
    const tab = (await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: admin } })).json() as { problem: string };
    expect(tab.problem).toContain('ist das Docker-Gateway');
    // The setup help checks the secret against the stored setting: a correct one is not called wrong (code-001).
    const help = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: admin, 'x-kaveyl-wiki-proxy-secret': 'der-alte-Geheimwert' } });
    expect(help.json()).toMatchObject({ secretSet: true, request: { secretSeen: true, secretOk: true } });
    restore();
  });
});

describe('signing in through the proxy', () => {
  let anna: Awaited<ReturnType<typeof addUser>>;
  beforeAll(async () => {
    anna = await addUser('anna');
  });

  it('a person who never connected the account gets the normal login', async () => {
    const res = await viaProxy('/api/mounts', ak('uid-anna', 'anna@example.test'));
    expect(res.statusCode).toBe(401);
    expect(cookieOf(res)).toBeNull();
  });

  it('connecting needs the request to come through the proxy, with the id header', async () => {
    const direct = await inject({ method: 'POST', url: '/api/account/proxy/authentik', remoteAddress: OTHER, ...json({}, { cookie: anna.cookie, ...ak('uid-anna') }) });
    expect(direct.statusCode).toBe(400);
    const res = await inject({ method: 'POST', url: '/api/account/proxy/authentik', remoteAddress: PROXY, ...json({}, { cookie: anna.cookie, ...ak('uid-anna') }) });
    expect(res.statusCode).toBe(200);
    const mine = await inject({ method: 'GET', url: '/api/account/proxy', remoteAddress: PROXY, headers: { cookie: anna.cookie, ...ak('uid-anna') } });
    expect(mine.json()).toEqual([expect.objectContaining({ provider: 'authentik', enabled: true, available: true, linkedAt: expect.any(String) })]);
  });

  it('the same provider id cannot be connected to a second account', async () => {
    const bea = await addUser('bea');
    const res = await inject({ method: 'POST', url: '/api/account/proxy/authentik', remoteAddress: PROXY, ...json({}, { cookie: bea.cookie, ...ak('uid-anna') }) });
    expect(res.statusCode).toBe(400);
  });

  it('then the proxy signs in – by the id, not the e-mail; also with an IPv4-mapped socket address', async () => {
    const res = await viaProxy('/api/mounts', ak('uid-anna', 'jemand-anders@example.test'));
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res)).not.toBeNull();
    const session = await viaProxy('/api/session', { cookie: cookieOf(res)!, ...ak('uid-anna') });
    expect(session.json()).toMatchObject({ user: { username: 'anna' } });
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: `::ffff:${PROXY}`, headers: ak('uid-anna') })).statusCode).toBe(200);
  });

  it('optional shared secret (sec-003): shown once, only its hash kept; then only requests carrying it sign in', async () => {
    // A session the proxy made before ends with the new secret (it may have come without one)
    const before = cookieOf(await viaProxy('/api/mounts', ak('uid-anna')))!;
    const made = await inject({ method: 'POST', url: '/api/admin/proxy-auth/authentik/secret', ...json({}, { cookie: admin }) });
    expect((await inject({ method: 'GET', url: '/api/session', headers: { cookie: before } })).json()).toMatchObject({ user: null });
    expect(made.statusCode).toBe(200);
    const { secret, state } = made.json() as { secret: string; state: Record<string, unknown> };
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatchObject({ secretSet: true, config: { enabled: true, proxies: [PROXY] } });
    // Never handed out again – not the value, not its hash
    const tab = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', remoteAddress: PROXY, headers: { cookie: admin, 'x-kaveyl-wiki-proxy-secret': secret } });
    expect(tab.body).not.toContain(secret);
    expect(tab.json()).not.toHaveProperty('config.secretHash');
    expect(tab.json()).toMatchObject({ secretSet: true, request: { secretSeen: true, secretOk: true } });
    expect((await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', remoteAddress: PROXY, headers: { cookie: admin, 'x-kaveyl-wiki-proxy-secret': 'falsch' } })).json()).toMatchObject({ request: { secretSeen: true, secretOk: false } });
    // Without or with a wrong secret: no sign-in, even straight from the proxy
    expect((await viaProxy('/api/mounts', ak('uid-anna'))).statusCode).toBe(401);
    expect((await viaProxy('/api/mounts', { ...ak('uid-anna'), 'x-kaveyl-wiki-proxy-secret': 'falsch' })).statusCode).toBe(401);
    expect((await viaProxy('/api/mounts', { ...ak('uid-anna'), 'x-kaveyl-wiki-proxy-secret': `${secret}, ${secret}` })).statusCode).toBe(401);
    // From anywhere else the secret is worth nothing
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: OTHER, headers: { ...ak('uid-anna'), 'x-kaveyl-wiki-proxy-secret': secret } })).statusCode).toBe(401);
    const ok = await viaProxy('/api/mounts', { ...ak('uid-anna'), 'x-kaveyl-wiki-proxy-secret': secret });
    expect(ok.statusCode).toBe(200);
    // A session made with the secret ends as soon as a request comes without it
    const end = await viaProxy('/api/mounts', { cookie: cookieOf(ok)!, ...ak('uid-anna') });
    expect(end.statusCode).toBe(401);
    // The form can neither read, set nor clear it
    const saved = await setAuthentik({ enabled: true, proxies: [PROXY], secretHash: '0'.repeat(64) });
    expect(saved.json()).toMatchObject({ secretSet: true });
    expect((await viaProxy('/api/mounts', { ...ak('uid-anna'), 'x-kaveyl-wiki-proxy-secret': secret })).statusCode).toBe(200);
    // Admins only; removing it is logged as a warning
    const nina = await login('nina@example.test', 'nina-Neues-Passwort-0001');
    expect((await inject({ method: 'POST', url: '/api/admin/proxy-auth/authentik/secret', ...json({}, { cookie: nina }) })).statusCode).toBe(403);
    expect((await inject({ method: 'DELETE', url: '/api/admin/proxy-auth/authentik/secret', ...json({}, { cookie: nina }) })).statusCode).toBe(403);
    // Removing it ends the sessions this proxy made too (code-006)
    const proxySessions = () => (app.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash IN (SELECT token_hash FROM session_proxy WHERE proxy LIKE 'authentik:%')").get() as { n: number }).n;
    expect(cookieOf(await viaProxy('/api/mounts', { ...ak('uid-anna'), 'x-kaveyl-wiki-proxy-secret': secret }))).toBeTruthy();
    expect(proxySessions()).toBeGreaterThan(0);
    const removed = await inject({ method: 'DELETE', url: '/api/admin/proxy-auth/authentik/secret', ...json({}, { cookie: admin }) });
    expect(removed.json()).toMatchObject({ secretSet: false });
    expect(proxySessions()).toBe(0);
    expect((await viaProxy('/api/mounts', ak('uid-anna'))).statusCode).toBe(200);
    const log = (await inject({ method: 'GET', url: '/api/activity?category=audit', headers: { cookie: admin } })).json() as { action: string; level: string; message: string }[];
    expect(log.find((e) => e.action === 'proxy-auth-secret')).toMatchObject({ message: 'Authentik: Geheimwert für den Proxy neu erzeugt' });
    expect(log.find((e) => e.action === 'proxy-auth-secret-removed')).toMatchObject({ level: 'warn' });
    expect(JSON.stringify(log)).not.toContain(secret);
  });

  it('the same headers from anywhere else count for nothing – also with X-Forwarded-For naming the proxy', async () => {
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: OTHER, headers: ak('uid-anna') })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: OTHER, headers: { ...ak('uid-anna'), 'x-forwarded-for': PROXY } })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: '127.0.0.1', headers: { ...ak('uid-anna'), 'x-forwarded-for': PROXY } })).statusCode).toBe(401);
  });

  it('never on paths a proxy usually lets through without its own sign-in: REST API, webhooks, logout (veto 2026-10-16)', async () => {
    // e.g. an NPM location for /api/v1 without auth_request passes the browser's own X-authentik-* on.
    const api = await viaProxy('/api/v1/sources', ak('uid-anna'));
    expect(api.statusCode).toBe(401);
    expect(cookieOf(api)).toBeNull();
    const hook = await inject({ method: 'POST', url: '/api/webhooks/git', remoteAddress: PROXY, ...json({}, ak('uid-anna')) });
    expect(cookieOf(hook)).toBeNull();
    const out = await inject({ method: 'POST', url: '/api/logout', remoteAddress: PROXY, ...json({}, ak('uid-anna')) });
    expect(cookieOf(out)).toBeNull();
    // Also paths without a route (404) and prefix look-alikes a proxy location would match (second veto).
    for (const url of ['/api/v1', '/api/v1x', '/api/v1.json', '/api/webhooks/git/', '/api/webhooks/gitx', '/api/gibt-es-nicht']) {
      expect(cookieOf(await viaProxy(url, ak('uid-anna'))), url).toBeNull();
    }
  });

  it('no new sign-in on a path the proxy may have mapped differently (dot segments, //, encoded / . \\) – normal paths still work', async () => {
    // (dot segments: light-my-request resolves them like a URL object before the server sees them – the rule itself is
    // checked in proxyAuth.test.ts)
    for (const url of ['/api//mounts', '/api/notes/x/a%2Fb.md', '/api/notes/x/%2E%2E/a.md', '/api/notes/x/a%5Cb.md']) {
      expect(cookieOf(await viaProxy(url, ak('uid-anna'))), url).toBeNull();
    }
    // Umlauts and a literal % in a note name are encoded by the app, too – those stay fine.
    expect(cookieOf(await viaProxy('/api/notes/x/Gr%C3%B6%C3%9Fe%20100%25.md', ak('uid-anna')))).not.toBeNull();
  });

  it('a session made by the proxy is no login for the REST API (tokens only)', async () => {
    const cookie = cookieOf(await viaProxy('/api/mounts', ak('uid-anna')))!;
    expect((await viaProxy('/api/v1/sources', { cookie, ...ak('uid-anna') })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/v1/sources', remoteAddress: OTHER, headers: { cookie } })).statusCode).toBe(401);
    // A password session still works there (unchanged behaviour).
    expect((await inject({ method: 'GET', url: '/api/v1/sources', remoteAddress: OTHER, headers: { cookie: anna.cookie } })).statusCode).toBe(200);
  });

  it('a proxy session lasts for the browser session only (no 30-day cookie)', async () => {
    const res = await viaProxy('/api/mounts', ak('uid-anna'));
    const c = res.cookies.find((x) => x.name === 'kw_session')!;
    expect(c.expires).toBeUndefined();
    expect(c.maxAge).toBeUndefined();
  });

  it('a header sent twice (browser + proxy) is refused', async () => {
    expect((await viaProxy('/api/mounts', { 'x-authentik-uid': 'uid-anna, uid-admin' })).statusCode).toBe(401);
  });

  it('the proxy session ends when the proxy stops naming the person or names someone else', async () => {
    const cookie = cookieOf(await viaProxy('/api/mounts', ak('uid-anna')))!;
    expect((await viaProxy('/api/mounts', { cookie, ...ak('uid-anna') })).statusCode).toBe(200);
    const without = await viaProxy('/api/mounts', { cookie });
    expect(without.statusCode).toBe(401);
    // ended for good: with the header again it is a new sign-in, the old cookie stays dead
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: OTHER, headers: { cookie } })).statusCode).toBe(401);
    const cookie2 = cookieOf(await viaProxy('/api/mounts', ak('uid-anna')))!;
    expect((await viaProxy('/api/mounts', { cookie: cookie2, ...ak('uid-unbekannt') })).statusCode).toBe(401);
  });

  it('a password session is not touched by the proxy check', async () => {
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: OTHER, headers: { cookie: anna.cookie } })).statusCode).toBe(200);
    expect((await viaProxy('/api/mounts', { cookie: anna.cookie })).statusCode).toBe(200);
  });

  it('a locked account is not signed in', async () => {
    await inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, ...json({ disabled: true }, { cookie: admin }) });
    expect((await viaProxy('/api/mounts', ak('uid-anna'))).statusCode).toBe(401);
    await inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, ...json({ disabled: false }, { cookie: admin }) });
    expect((await viaProxy('/api/mounts', ak('uid-anna'))).statusCode).toBe(200);
  });

  it('logging out ends the session and sends the browser to the proxy logout – only when it came through the proxy', async () => {
    const cookie = cookieOf(await viaProxy('/api/mounts', ak('uid-anna')))!;
    const out = await inject({ method: 'POST', url: '/api/logout', remoteAddress: PROXY, ...json({}, { cookie, ...ak('uid-anna') }) });
    expect(out.json()).toEqual({ ok: true, redirect: 'https://wiki.example.test/outpost.goauthentik.io/sign_out' });
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: OTHER, headers: { cookie } })).statusCode).toBe(401);
    const direct = await inject({ method: 'POST', url: '/api/logout', remoteAddress: OTHER, ...json({}, { cookie: await login('anna@example.test', anna.password) }) });
    expect(direct.json()).toEqual({ ok: true });
  });

  it('the admin sees the connection and can remove it – sessions made by the proxy end with it', async () => {
    const cookie = cookieOf(await viaProxy('/api/mounts', ak('uid-anna')))!;
    const users = (await inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).json() as { username: string; proxyLinks: string[] }[];
    expect(users.find((u) => u.username === 'anna')!.proxyLinks).toEqual(['authentik']);
    expect((await inject({ method: 'DELETE', url: `/api/admin/users/${anna.id}/proxy/authentik`, ...json({}, { cookie: admin }) })).statusCode).toBe(200);
    expect((await viaProxy('/api/mounts', { cookie, ...ak('uid-anna') })).statusCode).toBe(401);
    expect((await viaProxy('/api/mounts', ak('uid-anna'))).statusCode).toBe(401);
  });

  it('optional: normal users are connected by e-mail on the first visit – admins never, also not after a promotion', async () => {
    await setAuthentik({ autoLinkByEmail: true });
    const res = await viaProxy('/api/mounts', ak('uid-anna-2', 'anna@example.test'));
    expect(res.statusCode).toBe(200);
    expect((await viaProxy('/api/mounts', ak('uid-admin-2', 'admin@example.test'))).statusCode).toBe(401);
    await setAuthentik({ autoLinkByEmail: false });
    // Made admin later: the connection made by e-mail goes (one made by hand would stay).
    const before = cookieOf(await viaProxy('/api/mounts', ak('uid-anna-2')))!;
    await inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, ...json({ isAdmin: true }, { cookie: admin }) });
    expect((await viaProxy('/api/mounts', ak('uid-anna-2'))).statusCode).toBe(401);
    // … and the sessions the proxy made before the promotion end too.
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: OTHER, headers: { cookie: before } })).statusCode).toBe(401);
    await inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, ...json({ isAdmin: false }, { cookie: admin }) });
  });

  it('a new start password from the admin removes the proxy connections (account may have been in wrong hands)', async () => {
    const cleo = await addUser('cleo');
    await inject({ method: 'POST', url: '/api/account/proxy/authentik', remoteAddress: PROXY, ...json({}, { cookie: cleo.cookie, ...ak('uid-cleo') }) });
    expect((await viaProxy('/api/mounts', ak('uid-cleo'))).statusCode).toBe(200);
    expect((await inject({ method: 'POST', url: `/api/admin/users/${cleo.id}/password`, ...json({ password: 'Neues-Start-Passwort-0002' }, { cookie: admin }) })).statusCode).toBe(200);
    expect((await viaProxy('/api/mounts', ak('uid-cleo'))).statusCode).toBe(401);
  });

  it('connecting again (other id) ends the sessions the old id made', async () => {
    const dora = await addUser('dora');
    await inject({ method: 'POST', url: '/api/account/proxy/authentik', remoteAddress: PROXY, ...json({}, { cookie: dora.cookie, ...ak('uid-dora-alt') }) });
    const old = cookieOf(await viaProxy('/api/mounts', ak('uid-dora-alt')))!;
    await inject({ method: 'POST', url: '/api/account/proxy/authentik', remoteAddress: PROXY, ...json({}, { cookie: dora.cookie, ...ak('uid-dora-neu') }) });
    expect((await viaProxy('/api/mounts', { cookie: old, ...ak('uid-dora-alt') })).statusCode).toBe(401);
  });

  it('an admin connects the own account explicitly (one-person setup) and is signed in by the proxy', async () => {
    expect((await inject({ method: 'POST', url: '/api/account/proxy/authentik', remoteAddress: PROXY, ...json({}, { cookie: admin, ...ak('uid-admin') }) })).statusCode).toBe(200);
    const res = await viaProxy('/api/admin/users', ak('uid-admin'));
    expect(res.statusCode).toBe(200);
  });

  it('Pangolin is gone (AD-058): no tab, its headers and old connections sign no one in', async () => {
    expect((await inject({ method: 'GET', url: '/api/admin/proxy-auth/pangolin', headers: { cookie: admin } })).statusCode).toBe(404);
    // A setting and a connection from before stay in the database but count for nothing.
    const bea = app.db.prepare("SELECT id FROM users WHERE email = 'bea@example.test'").get() as { id: string };
    app.db.prepare("INSERT INTO settings (key, value) VALUES ('proxy_auth_pangolin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ enabled: true, proxies: ['fd00::40'], idHeader: 'remote-user', emailHeader: 'remote-email', logoutUrl: '', autoLinkByEmail: false }));
    app.db.prepare("INSERT INTO proxy_links (user_id, provider, subject, created_at) VALUES (?, 'pangolin', 'bea', '2026-10-20')").run(bea.id);
    expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: 'fd00::40', headers: { 'remote-user': 'bea' } })).statusCode).toBe(401);
    const users = (await inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).json() as { email: string; proxyLinks?: string[] }[];
    expect(users.find((u) => u.email === 'bea@example.test')?.proxyLinks ?? []).not.toContain('pangolin');
  });

  it('a stored setting that no longer passes the check: sign-in off, the tab shows it with the reason, logged once', async () => {
    // e.g. saved before the check became stricter
    const stored = { enabled: true, proxies: ['fd00::40', '0.0.0.0'], idHeader: 'x-wiki-user', emailHeader: 'remote-email', logoutUrl: 'https://wiki.example.test/outpost.goauthentik.io/sign_out', autoLinkByEmail: false };
    const restore = storeAuthentik(stored);
    for (const headers of [{ 'x-wiki-user': 'bea' }, { 'remote-user': 'bea' }]) {
      expect((await inject({ method: 'GET', url: '/api/mounts', remoteAddress: 'fd00::40', headers })).statusCode).toBe(401);
    }
    const tab = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: admin } });
    expect(tab.json()).toMatchObject({ config: stored, problem: 'Diese Adresse ist nicht erlaubt: 0.0.0.0' });
    const en = await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: admin, 'x-kaveyl-wiki-lang': 'en' } });
    expect(en.json()).toMatchObject({ problem: 'This address is not allowed: 0.0.0.0' });
    const log = (await inject({ method: 'GET', url: '/api/activity?category=system', headers: { cookie: admin } })).json() as { action: string; level: string; message: string }[];
    const warned = log.filter((e) => e.action === 'proxy-auth-invalid' && e.message.includes('0.0.0.0'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 'warn', message: 'Authentik: gespeicherte Einstellung ungültig – Anmeldung über den Proxy ist aus: Diese Adresse ist nicht erlaubt: 0.0.0.0' });
    // Correcting the addresses keeps the other stored fields
    const fixed = await inject({ method: 'PUT', url: '/api/admin/proxy-auth/authentik', ...json({ proxies: ['fd00::40'] }, { cookie: admin }) });
    expect(fixed.json()).toMatchObject({ config: { ...stored, proxies: ['fd00::40'] }, problem: null });
    expect((await inject({ method: 'GET', url: '/api/admin/proxy-auth/authentik', headers: { cookie: admin } })).json()).toMatchObject({ problem: null });
    restore();
  });
});

it('reverse proxy tab: state only (admins)', async () => {
  const r = await inject({ method: 'GET', url: '/api/admin/reverse-proxy', remoteAddress: '127.0.0.1', headers: { cookie: admin } });
  expect(r.json()).toMatchObject({ trustProxy: null, socket: '127.0.0.1', https: false, forwarded: false });
});
