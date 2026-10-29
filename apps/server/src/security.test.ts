// Security sweep over EVERY route the server registers (collected at start-up, so new routes are covered without
// touching this file): nothing without a login, a token never does more than its scopes and its owner allow,
// no CSRF way in with the session cookie, no tricks with paths or URLs. AD-020 (access), AD-023 (tokens, MCP).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { InjectOptions, Response } from 'light-my-request';
import { join } from 'node:path';
import WS from 'ws';

const routes: { method: string; url: string }[] = [];
vi.mock('fastify', async (orig) => {
  type Hookable = { addHook: (name: string, fn: (r: { method: string | string[]; url: string }) => void) => void };
  const real = (await orig()) as { default: (...a: unknown[]) => Hookable };
  const factory = (...a: unknown[]) => {
    const server = real.default(...a);
    server.addHook('onRoute', (r) => {
      for (const method of [r.method].flat()) {
        if (method !== 'HEAD' && method !== 'OPTIONS' && !routes.some((x) => x.method === method && x.url === r.url)) routes.push({ method, url: r.url });
      }
    });
    return server;
  };
  return { ...real, default: factory };
});
const { buildApp } = await import('./app.js');
const { loadConfig } = await import('./config.js');
type App = Awaited<ReturnType<typeof buildApp>>;

/** Reachable without a login, each for a reason; everything else must answer 401. */
const PUBLIC: Record<string, string> = {
  'GET /health': 'health check of the container',
  'GET /api/session': 'tells the login page whether someone is logged in',
  'POST /api/setup': 'first start only (409 afterwards)',
  'POST /api/setup/restore': 'first start only (409 afterwards), with the setup code – database from a backup (AD-075)',
  'POST /api/login': 'login',
  'POST /api/logout': 'logout',
  'POST /api/password/forgot': 'mail with a reset link (same answer for unknown addresses)',
  'POST /api/password/reset': 'needs the secret code from the mail',
  'POST /api/invite/info': 'needs the secret invitation code',
  'POST /api/invite/accept': 'needs the secret invitation code',
  'POST /api/webhooks/git': 'needs the webhook signature',
  'GET /api/v1/openapi.json': 'API description, no data',
  'GET /mcp': '405 – MCP is POST only',
  'DELETE /mcp': '405 – MCP is POST only',
  'GET *': 'the web app itself (HTML, scripts)',
  'GET /api/events': 'WebSocket – checked separately below',
};

let root: string;
let app: App;
let admin: string; // session cookie
let mountId: string;
const ADMIN_PW = 'Sehr-geheim-Passwort-123';
const inject = (o: InjectOptions): Promise<Response> => app.server.inject(o);
const fill = (url: string) =>
  url
    .replace(/:(mountId|sourceId)/g, mountId)
    .replace(/:[a-zA-Z]+/g, 'x')
    .replace(/\*$/, 'docs/home.md')
    .replace(/^\*$/, '/');
const all = () => routes.filter((r) => r.url !== '/api/events');
const esc = (c: string) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
/** The router decodes %-escapes, so these reach the same route as `url` (the auth check must follow). */
const encoded = (url: string) => {
  const [, first, rest] = /^\/([^/]+)(.*)$/.exec(url) as unknown as [string, string, string];
  return [
    `/${esc(first[0]!)}${first.slice(1)}${rest}`, // /%61pi/…
    `/${[...first].map(esc).join('')}${rest}`, // /%61%70%69/…
    url.replace(/^(\/[^/]+\/)([^/])/, (_, a: string, c: string) => a + esc(c)), // /api/b%61ckup/…
  ].filter((v) => v !== url);
};
const label = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
const send = (r: { method: string; url: string }, headers: Record<string, string>, payload = '{}') =>
  inject({ method: r.method as 'GET', url: fill(r.url), headers: r.method === 'GET' || r.method === 'DELETE' ? headers : { 'content-type': 'application/json', ...headers }, payload: r.method === 'GET' ? undefined : payload });

async function login(email: string, password: string) {
  const res = await inject({ method: 'POST', url: '/api/login', payload: { email, password } });
  return `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
}
async function token(cookie: string, scopes: string[], name = scopes.join('+')) {
  const res = await inject({ method: 'POST', url: '/api/tokens', payload: JSON.stringify({ name, scopes }), headers: { 'content-type': 'application/json', cookie } });
  return res.json() as { token: string; info: { id: string; scopes: string[] } };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function addUser(name: string) {
  const res = await inject({ method: 'POST', url: '/api/admin/users', payload: JSON.stringify({ email: `${name}@example.test`, username: name, password: 'Start-Passwort-0001' }), headers: { 'content-type': 'application/json', cookie: admin } });
  const id = (res.json() as { id: string }).id;
  const c = await login(`${name}@example.test`, 'Start-Passwort-0001');
  const pw = `${name[0]!.toUpperCase()}${name.slice(1)}-Passwort-0001`;
  await inject({ method: 'POST', url: '/api/account/password', payload: JSON.stringify({ current: 'Start-Passwort-0001', next: pw }), headers: { 'content-type': 'application/json', cookie: c } });
  return { id, cookie: await login(`${name}@example.test`, pw) };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-sec-'));
  const wiki = join(root, 'projekte', 'wiki');
  mkdirSync(join(wiki, 'docs'), { recursive: true });
  mkdirSync(join(wiki, 'geheim'), { recursive: true });
  mkdirSync(join(root, 'draussen'), { recursive: true });
  writeFileSync(join(wiki, 'docs', 'home.md'), '# Home\n\nTrilium und Outline.\n');
  writeFileSync(join(wiki, 'geheim', 'lohn.md'), '# Lohn\n\nZebrawort.\n');
  writeFileSync(join(root, 'draussen', 'passwort.md'), '# Draußen\n\nGEHEIM-AUSSERHALB\n');
  writeFileSync(join(root, 'draussen', 'bild.png'), 'GEHEIM-AUSSERHALB');
  symlinkSync(join(root, 'draussen', 'passwort.md'), join(wiki, 'docs', 'link-raus.md'));
  symlinkSync(join(root, 'draussen'), join(wiki, 'docs', 'ordner-raus'));
  symlinkSync(join(root, 'draussen', 'bild.png'), join(wiki, 'docs', 'bild-raus.png'));
  app = await buildApp(
    { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') },
    { logger: false, nightlyFsck: false },
  );
  await app.manager.start();
  const setup = await inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: ADMIN_PW, displayName: 'Admin' } });
  admin = `kw_session=${setup.cookies.find((c) => c.name === 'kw_session')!.value}`;
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
  const m = await inject({ method: 'POST', url: '/api/mounts', payload: JSON.stringify({ type: 'local', source: wiki, name: 'Wiki' }), headers: { 'content-type': 'application/json', cookie: admin } });
  mountId = (m.json() as { id: string }).id;
  expect(routes.length).toBeGreaterThan(150);
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('without a login', () => {
  it('every route that is not public answers 401 – without credentials, with a made-up token or a made-up cookie', async () => {
    const wrong: string[] = [];
    for (const r of all()) {
      if (PUBLIC[label(r)]) continue;
      for (const [how, headers] of [
        ['nothing', {}],
        ['made-up token', bearer('kw_' + 'A'.repeat(43))],
        ['not a Kaveyl Wiki token', { authorization: 'Bearer abc' }],
        ['basic auth', { authorization: 'Basic YWRtaW46YWRtaW4=' }],
        ['made-up cookie', { cookie: 'kw_session=' + 'A'.repeat(43) }],
      ] as const) {
        const res = await send(r, headers);
        if (res.statusCode !== 401) wrong.push(`${label(r)} (${how}) → ${res.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('percent-encoded paths meet the same login check: 401 on every route, 404 for other paths, 400 for broken escapes', async () => {
    const wrong: string[] = [];
    for (const r of all()) {
      if (PUBLIC[label(r)]) continue;
      const url = fill(r.url);
      const [, first, rest] = /^\/([^/]+)(.*)$/.exec(url) as unknown as [string, string, string];
      const cases: [string, number[]][] = [
        ...encoded(url).map((u) => [u, [401]] as [string, number[]]),
        [`/${esc(first[0]!.toUpperCase())}${first.slice(1).toUpperCase()}${rest}`, [401, 404]], // /%41PI/… is another path
        [`/${esc(first[0]!)}${first.slice(1)}${rest}%`, [400]],
        [`/%zz${first.slice(1)}${rest}`, [400]],
      ];
      for (const [u, ok] of cases) {
        const res = await send({ method: r.method, url: u }, {});
        if (!ok.includes(res.statusCode)) wrong.push(`${r.method} ${u} → ${res.statusCode} ${res.body.slice(0, 60)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('public routes give nothing away', async () => {
    const pub = all().filter((r) => PUBLIC[label(r)]);
    expect(pub.length).toBeGreaterThan(10); // (GET * only exists with a built web app)
    expect((await inject({ method: 'POST', url: '/api/setup', payload: { email: 'x@example.test', password: 'Yyyyyyyyyyyyyyy-1' } })).statusCode).toBe(409);
    expect((await inject({ method: 'POST', url: '/api/setup/restore', payload: Buffer.from('SQLite format 3\0'), headers: { 'content-type': 'application/x-sqlite3' } })).statusCode).toBe(409);
    const session = (await inject({ method: 'GET', url: '/api/session' })).json() as Record<string, unknown>;
    expect(JSON.stringify(session)).not.toMatch(/admin@example|setupCode"\s*:\s*"/);
    expect((await inject({ method: 'POST', url: '/api/webhooks/git', payload: JSON.stringify({ repository: { full_name: 'a/b' } }), headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect((await inject({ method: 'POST', url: '/api/invite/info', payload: JSON.stringify({ token: 'x'.repeat(40) }), headers: { 'content-type': 'application/json' } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await inject({ method: 'POST', url: '/api/password/reset', payload: JSON.stringify({ token: 'x'.repeat(40), password: 'Neues-Passwort-0001' }), headers: { 'content-type': 'application/json' } })).statusCode).toBeGreaterThanOrEqual(400);
    const forgotKnown = await inject({ method: 'POST', url: '/api/password/forgot', payload: JSON.stringify({ email: 'admin@example.test' }), headers: { 'content-type': 'application/json' } });
    const forgotUnknown = await inject({ method: 'POST', url: '/api/password/forgot', payload: JSON.stringify({ email: 'niemand@example.test' }), headers: { 'content-type': 'application/json' } });
    expect([forgotKnown.statusCode, forgotKnown.body]).toEqual([forgotUnknown.statusCode, forgotUnknown.body]);
    // The web app catch-all must not serve API answers or files outside the web root.
    for (const url of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd']) {
      const res = await inject({ method: 'GET', url });
      expect(res.body).not.toMatch(/root:|GEHEIM/);
    }
  });

  it('URL tricks do not slip past the login check', async () => {
    const leaks: string[] = [];
    const targets = ['/api/mounts', `/api/v1/notes/${mountId}/docs/home.md`, `/api/notes/${mountId}/docs/home.md`, `/api/files/${mountId}/docs/home.md`, '/api/admin/users', '/api/tokens'];
    for (const t of targets) {
      const rest = t.slice('/api'.length);
      for (const url of [
        t.toUpperCase(),
        `/API${rest}`,
        `//api${rest}`,
        `/api/${rest}`,
        `/api/.${rest}`,
        `/api/x/..${rest}`,
        `/%61pi${rest}`,
        `/%41PI${rest}`,
        `/api%2F${rest.slice(1)}`,
        `${t}/`,
        `${t}?`,
        `${t}#x`,
        `${t};x`,
        `${t}%00`,
        `/./api${rest}`,
        `/health/../api${rest}`,
        `/mcp/../api${rest}`,
      ]) {
        const res = await inject({ method: 'GET', url });
        if (res.statusCode < 300 && /Trilium|admin@example|"id"/.test(res.body)) leaks.push(`${url} → ${res.statusCode}`);
      }
    }
    for (const url of ['/mcp/', '/MCP', '/mcp?x=1', '//mcp', '/./mcp', '/%6dcp']) {
      const res = await inject({ method: 'POST', url, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sources', arguments: {} } }), headers: { 'content-type': 'application/json' } });
      if (res.statusCode < 300) leaks.push(`POST ${url} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(leaks).toEqual([]);
  });

  it('the live-update socket needs a login', async () => {
    await app.server.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.server.address() as { port: number }).port;
    const opened = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers } as unknown as string[]);
        ws.onopen = () => {
          ws.close();
          resolve('open');
        };
        ws.onerror = () => resolve('refused');
      });
    expect(await opened({})).toBe('refused');
    expect(await opened({ cookie: admin })).toBe('open');
  });

  it('the live-update socket refuses pages from elsewhere and ends with the session (sec-005)', async () => {
    if (!app.server.server.listening) await app.server.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.server.address() as { port: number }).port;
    const connect = (headers: Record<string, string>) =>
      new Promise<{ status: number; ws?: WS }>((resolve) => {
        const ws = new WS(`ws://127.0.0.1:${port}/api/events`, { headers });
        ws.once('open', () => resolve({ status: 101, ws }));
        ws.once('unexpected-response', (req, res) => {
          req.destroy();
          resolve({ status: res.statusCode ?? 0 });
        });
        ws.once('error', () => resolve({ status: 0 }));
      });
    const status = async (headers: Record<string, string>) => {
      const r = await connect(headers);
      r.ws?.close();
      return r.status;
    };
    // Origin: missing (not a browser) or the own address; behind a trusted proxy its forwarded host counts.
    expect(await status({ cookie: admin, origin: 'https://evil.example.test' })).toBe(403);
    expect(await status({ cookie: admin, origin: 'null' })).toBe(403);
    expect(await status({ cookie: admin, origin: `http://127.0.0.1:${port}` })).toBe(101);
    expect(await status({ cookie: admin, origin: 'https://wiki.example.test', 'x-forwarded-host': 'wiki.example.test', 'x-forwarded-proto': 'https' })).toBe(101);
    expect(await status({ cookie: admin })).toBe(101);

    // Events only while the session lasts: after signing out the socket is closed and nothing more arrives.
    let editing = false;
    const beat = () =>
      inject({ method: 'POST', url: '/api/presence', payload: JSON.stringify({ mountId, path: 'docs/home.md', editing: (editing = !editing) }), headers: { 'content-type': 'application/json', cookie: admin } });
    const ends = async (cookie: string, end: () => Promise<unknown>) => {
      const { ws } = await connect({ cookie });
      const got: string[] = [];
      ws!.on('message', (m) => got.push(String(m)));
      const closed = new Promise<number>((r) => ws!.once('close', (code) => r(code)));
      await beat();
      await vi.waitFor(() => expect(got.length).toBeGreaterThan(0));
      await end();
      got.length = 0;
      await beat();
      const code = await Promise.race([closed, new Promise<string>((r) => setTimeout(() => r('still open'), 2000))]);
      ws!.terminate();
      return { code, got };
    };
    const second = await login('admin@example.test', ADMIN_PW);
    expect(await ends(second, () => inject({ method: 'POST', url: '/api/logout', payload: '{}', headers: { 'content-type': 'application/json', cookie: second } }))).toEqual({ code: 4401, got: [] });
    // Locked by an admin: the same.
    const jonas = await addUser('jonas');
    const lock = () => inject({ method: 'PATCH', url: `/api/admin/users/${jonas.id}`, payload: JSON.stringify({ disabled: true }), headers: { 'content-type': 'application/json', cookie: admin } });
    const { code } = await ends(jonas.cookie, lock);
    expect(code).toBe(4401);
    // …and at once, not only at the next event: a socket that is dropped later can't reconnect (401 before the upgrade,
    // the browser sees 1006) – the app would show „Keine Verbindung“ instead of the login.
    const quiet = async (cookie: string, end: () => Promise<unknown>) => {
      const { ws } = await connect({ cookie });
      const closed = new Promise<number>((r) => ws!.once('close', (code) => r(code)));
      await end();
      const code = await Promise.race([closed, new Promise<string>((r) => setTimeout(() => r('still open'), 2000))]);
      ws!.terminate();
      return code;
    };
    const pia = await addUser('pia');
    expect(await quiet(pia.cookie, () => inject({ method: 'PATCH', url: `/api/admin/users/${pia.id}`, payload: JSON.stringify({ disabled: true }), headers: { 'content-type': 'application/json', cookie: admin } }))).toBe(4401);
    const third = await login('admin@example.test', ADMIN_PW);
    expect(await quiet(third, () => inject({ method: 'POST', url: '/api/logout', payload: '{}', headers: { 'content-type': 'application/json', cookie: third } }))).toBe(4401);
    // Other sessions stay connected.
    const { ws: still } = await connect({ cookie: admin });
    const otherClosed = new Promise<number>((r) => still!.once('close', (code) => r(code)));
    const fourth = await login('admin@example.test', ADMIN_PW);
    await inject({ method: 'POST', url: '/api/logout', payload: '{}', headers: { 'content-type': 'application/json', cookie: fourth } });
    expect(await Promise.race([otherClosed, new Promise<string>((r) => setTimeout(() => r('still open'), 500))])).toBe('still open');
    still!.terminate();
  });

  it('a rename reaches a user only with both names readable; otherwise just the readable side, as removed or added', async () => {
    if (!app.server.server.listening) await app.server.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.server.address() as { port: number }).port;
    const rolf = await addUser('rolf');
    const rule = (await inject({ method: 'POST', url: `/api/acl/${mountId}`, payload: JSON.stringify({ target: 'folder', path: 'geheim', subject: 'user', subjectId: rolf.id, level: 'none' }), headers: { 'content-type': 'application/json', cookie: admin } })).json() as { id: string };
    const ws = new WS(`ws://127.0.0.1:${port}/api/events`, { headers: { cookie: rolf.cookie } });
    await new Promise((r) => ws.once('open', r));
    const got: { type: string; change?: unknown }[] = [];
    ws.on('message', (m) => got.push(JSON.parse(String(m))));
    const events = (app.manager as unknown as { events: { emit(e: unknown): void } }).events;
    events.emit({
      type: 'tree',
      mountId,
      change: {
        added: [],
        updated: [],
        removed: [],
        renamed: [
          { from: 'geheim/lohn.md', to: 'docs/lohn.md' },
          { from: 'docs/alt.md', to: 'geheim/neu.md' },
          { from: 'docs/a.md', to: 'docs/b.md' },
          { from: 'geheim/x.md', to: 'geheim/y.md' },
        ],
      },
    });
    await vi.waitFor(() => expect(got.some((e) => e.type === 'tree')).toBe(true));
    // A change only in the hidden folder: not even an empty tree event (team test 23.10.).
    events.emit({ type: 'tree', mountId, change: { added: ['geheim/neu2.md'], updated: ['geheim/lohn.md'], removed: [], renamed: [] } });
    events.emit({ type: 'tree', mountId, change: { added: ['docs/marke.md'], updated: [], removed: [], renamed: [] } });
    await vi.waitFor(() => expect(got.filter((e) => e.type === 'tree')).toHaveLength(2));
    expect((got.filter((e) => e.type === 'tree')[1]!.change as { added: string[] }).added).toEqual(['docs/marke.md']);
    ws.terminate();
    // The other tests here expect no folder rules on this source.
    expect((await inject({ method: 'DELETE', url: `/api/acl/rule/${rule.id}`, payload: '{}', headers: { 'content-type': 'application/json', cookie: admin } })).statusCode).toBe(200);
    expect(got.find((e) => e.type === 'tree')!.change).toEqual({ added: ['docs/lohn.md'], updated: [], removed: ['docs/alt.md'], renamed: [{ from: 'docs/a.md', to: 'docs/b.md' }] });
  });
});

describe('tokens', () => {
  it('revoked, expired, disabled or deleted: 401 everywhere, also on /mcp', async () => {
    const maria = await addUser('maria');
    const users = (await inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).json() as { id: string; username: string }[];
    const mariaId = users.find((u) => u.username === 'maria')!.id;
    const revoked = await token(admin, ['read', 'write', 'mcp']);
    const expired = await token(admin, ['read', 'write', 'mcp']);
    const disabled = await token(maria.cookie, ['read', 'write', 'mcp']);
    expect((await inject({ method: 'DELETE', url: `/api/tokens/${revoked.info.id}`, headers: { cookie: admin, 'content-type': 'application/json' } })).statusCode).toBe(200);
    app.db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.info.id);
    expect((await inject({ method: 'PATCH', url: `/api/admin/users/${mariaId}`, payload: JSON.stringify({ disabled: true }), headers: { 'content-type': 'application/json', cookie: admin } })).statusCode).toBe(200);
    const mcp = (t: string) => inject({ method: 'POST', url: '/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { 'content-type': 'application/json', ...bearer(t) } });
    for (const t of [revoked, expired, disabled]) {
      expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(t.token) })).statusCode).toBe(401);
      expect((await inject({ method: 'GET', url: '/api/mounts', headers: bearer(t.token) })).statusCode).toBe(401);
      expect((await mcp(t.token)).statusCode).toBe(401);
    }
    // Locking deletes the tokens: unlocking again does not bring them back.
    await inject({ method: 'PATCH', url: `/api/admin/users/${mariaId}`, payload: JSON.stringify({ disabled: false }), headers: { 'content-type': 'application/json', cookie: admin } });
    expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(disabled.token) })).statusCode).toBe(401);
    // Deleted user: the token goes with them.
    const fresh = await token(await login('maria@example.test', 'Maria-Passwort-0001'), ['read']);
    expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(fresh.token) })).statusCode).toBe(200);
    expect((await inject({ method: 'DELETE', url: `/api/admin/users/${mariaId}`, headers: { cookie: admin, 'content-type': 'application/json' } })).statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(fresh.token) })).statusCode).toBe(401);
  });

  it('only a fingerprint is stored, and the token is long and random', async () => {
    const t = await token(admin, ['read']);
    expect(t.token).toMatch(/^kw_[A-Za-z0-9_-]{32,}$/);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM api_tokens').all())).not.toContain(t.token.slice(3));
  });

  it('a read token changes nothing, on any route', async () => {
    const t = await token(admin, ['read', 'mcp']);
    const wrong: string[] = [];
    for (const r of all()) {
      if (r.method === 'GET' || PUBLIC[label(r)] || r.url === '/mcp') continue;
      const res = await send(r, bearer(t.token));
      if (res.statusCode !== 403) wrong.push(`${label(r)} → ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('tokens never manage tokens or the account – whatever their scopes', async () => {
    const t = await token(admin, ['read', 'write', 'mcp', 'admin']);
    const wrong: string[] = [];
    for (const r of all().filter((r) => /^\/api\/(tokens|account)/.test(r.url))) {
      const res = await send(r, bearer(t.token), JSON.stringify({ name: 'x', scopes: ['admin'], current: ADMIN_PW, next: 'Anderes-Passwort-0001' }));
      if (res.statusCode !== 403) wrong.push(`${label(r)} → ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a non-admin cannot get an admin token; an admin token without „admin“ does not get further than a normal user', async () => {
    const otto = await addUser('otto');
    const refused = await inject({ method: 'POST', url: '/api/tokens', payload: JSON.stringify({ name: 'x', scopes: ['read', 'admin'] }), headers: { 'content-type': 'application/json', cookie: otto.cookie } });
    expect(refused.statusCode).toBe(400);
    // Made admin, token with „admin“, admin rights taken away again: the token loses „admin“ with them.
    const users = (await inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).json() as { id: string; username: string }[];
    const ottoId = users.find((u) => u.username === 'otto')!.id;
    const patch = (isAdmin: boolean) => inject({ method: 'PATCH', url: `/api/admin/users/${ottoId}`, payload: JSON.stringify({ isAdmin }), headers: { 'content-type': 'application/json', cookie: admin } });
    expect((await patch(true)).statusCode).toBe(200);
    const mine = await token(otto.cookie, ['read', 'write', 'admin']);
    expect(mine.info.scopes).toContain('admin');
    expect((await patch(false)).statusCode).toBe(200);
    const adminNoScope = await token(admin, ['read', 'write', 'mcp']);
    const wrong: string[] = [];
    const skip = new Set(['POST /api/logout', 'POST /api/account/password']);
    for (const r of all()) {
      if (PUBLIC[label(r)] || skip.has(label(r)) || r.url === '/mcp') continue;
      const asUser = await send(r, { cookie: otto.cookie });
      if (asUser.statusCode !== 403 || !/Administrator|admin/i.test(asUser.body)) continue;
      for (const [who, t] of [['admin token without scope admin', adminNoScope.token], ['admin token of a former admin', mine.token]] as const) {
        const res = await send(r, bearer(t));
        if (res.statusCode !== 403) wrong.push(`${label(r)} (${who}) → ${res.statusCode} ${res.body.slice(0, 80)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('encoded paths do not dodge the token rules', async () => {
    const t = await token(admin, ['read', 'write']);
    const wrong: string[] = [];
    for (const url of ['/api/admin/notify/test', ...encoded('/api/admin/notify/test'), '/api/%61dmin/notify/test', ...encoded('/api/mounts')]) {
      const res = await inject({ method: 'POST', url, payload: '{}', headers: { 'content-type': 'application/json', ...bearer(t.token) } });
      if (res.statusCode !== 403) wrong.push(`POST ${url} → ${res.statusCode} ${res.body.slice(0, 60)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('tokens work only for /api/v1, /mcp and reading files – every app route needs the browser login', async () => {
    const t = await token(admin, ['read', 'write', 'mcp', 'admin']);
    const wrong: string[] = [];
    for (const r of all()) {
      if (r.url.startsWith('/api/v1/') || r.url === '/mcp' || (r.url.startsWith('/api/files/') && r.method === 'GET') || PUBLIC[label(r)]) continue;
      const res = await send(r, bearer(t.token));
      if (res.statusCode !== 403) wrong.push(`${label(r)} → ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
    expect((await inject({ method: 'GET', url: `/api/files/${mountId}/docs/home.md`, headers: bearer(t.token) })).statusCode).toBe(404); // .md is not a file there
    expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(t.token) })).statusCode).toBe(200);
  });

  it('an admin resetting a password ends sessions and revokes the tokens', async () => {
    const kim = await addUser('kim');
    const t = await token(kim.cookie, ['read']);
    const users = (await inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).json() as { id: string; username: string }[];
    const kimId = users.find((u) => u.username === 'kim')!.id;
    expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(t.token) })).statusCode).toBe(200);
    const reset = await inject({ method: 'POST', url: `/api/admin/users/${kimId}/password`, payload: JSON.stringify({ password: 'Neues-Start-Passwort-01' }), headers: { 'content-type': 'application/json', cookie: admin } });
    expect(reset.statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(t.token) })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/session', headers: { cookie: kim.cookie } })).json()).toMatchObject({ user: null });
  });

  it('a token without „read“ reads nothing; a token without „mcp“ does not reach /mcp', async () => {
    const onlyMcp = await token(admin, ['mcp']);
    const onlyRead = await token(admin, ['read']);
    expect((await inject({ method: 'GET', url: '/api/v1/sources', headers: bearer(onlyMcp.token) })).statusCode).toBe(403);
    expect((await inject({ method: 'GET', url: `/api/v1/notes/${mountId}/docs/home.md`, headers: bearer(onlyMcp.token) })).statusCode).toBe(403);
    const call = (t: string) =>
      inject({ method: 'POST', url: '/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_note', arguments: { source_id: mountId, path: 'docs/home.md' } } }), headers: { 'content-type': 'application/json', ...bearer(t) } });
    expect((await call(onlyRead.token)).statusCode).toBe(403);
    expect((await call(onlyMcp.token)).body).not.toContain('Trilium');
  });
});

describe('guessing passwords', () => {
  it('pauses an address after 10 failures – even the right password – and lets others in', async () => {
    const tries = (email: string, password: string) => inject({ method: 'POST', url: '/api/login', payload: { email, password }, headers: { 'x-forwarded-for': '203.0.113.7' } });
    await addUser('lena');
    for (let i = 0; i < 10; i++) expect((await tries('lena@example.test', `Falsch-Passwort-${i}`)).statusCode).toBe(401);
    expect((await tries('lena@example.test', 'Lena-Passwort-0001')).statusCode).toBe(429);
    expect((await tries('LENA@example.test ', 'Lena-Passwort-0001')).statusCode).toBe(429);
    expect((await inject({ method: 'POST', url: '/api/login', payload: { email: 'admin@example.test', password: ADMIN_PW } })).statusCode).toBe(200);
    const log = JSON.stringify(app.db.prepare("SELECT message FROM activity WHERE action = 'login-throttled'").all());
    expect(log).toContain('Anmeldung gebremst nach zu vielen Fehlversuchen für „lena“');
  });

  it('a locked account says so – but only to whoever knows its password', async () => {
    const tries = (email: string, password: string) => inject({ method: 'POST', url: '/api/login', payload: { email, password }, headers: { 'x-forwarded-for': '203.0.113.21' } });
    const kurt = await addUser('kurt');
    await inject({ method: 'PATCH', url: `/api/admin/users/${kurt.id}`, payload: JSON.stringify({ disabled: true }), headers: { 'content-type': 'application/json', cookie: admin } });
    const right = await tries('kurt@example.test', 'Kurt-Passwort-0001');
    expect([right.statusCode, right.json().error]).toEqual([403, 'Dieses Konto ist gesperrt – bitte wende dich an einen Administrator']);
    expect(right.headers['set-cookie']).toBeUndefined();
    // Wrong password or unknown address: the same answer as ever, nothing about the lock.
    expect((await tries('kurt@example.test', 'Falsch-Passwort-0001')).json().error).toBe('E-Mail oder Passwort falsch');
    expect((await tries('niemand@example.test', 'Kurt-Passwort-0001')).json().error).toBe('E-Mail oder Passwort falsch');
    expect(JSON.stringify(app.db.prepare("SELECT message FROM activity WHERE action = 'login-locked'").all())).toContain('„kurt“');
  });

  it('pauses an IP after 30 failures, whatever the address', async () => {
    const tries = (email: string) => inject({ method: 'POST', url: '/api/login', payload: { email, password: 'Falsch-Passwort-0001' }, headers: { 'x-forwarded-for': '198.51.100.9' } });
    for (let i = 0; i < 30; i++) expect((await tries(`raten${i}@example.test`)).statusCode).toBe(401);
    expect((await tries('noch-einer@example.test')).statusCode).toBe(429);
  });
});

describe('client address (TRUST_PROXY)', () => {
  it('own network by default; a list trusts only those proxies; true/false as written', async () => {
    const { parseTrustProxy } = await import('./config.js');
    expect(parseTrustProxy(undefined)).toBe('loopback, uniquelocal');
    expect(parseTrustProxy(' ')).toBe('loopback, uniquelocal');
    expect(parseTrustProxy('192.168.7.40')).toBe('192.168.7.40');
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('a list one per line with # comments (compose block), mixed separators, a clear error for a bad entry', async () => {
    const { parseTrustProxy } = await import('./config.js');
    const block = '192.168.7.40      # Nginx Proxy Manager\n# 10.0.0.5   # Pangolin/Newt – später einkommentieren\n';
    expect(parseTrustProxy(block)).toBe('192.168.7.40');
    expect(parseTrustProxy('192.168.7.40,10.0.0.5 \t fd00::/8\n  loopback, ::ffff:172.18.0.2 # docker\n')).toBe(
      '192.168.7.40, 10.0.0.5, fd00::/8, loopback, ::ffff:172.18.0.2',
    );
    expect(parseTrustProxy('192.168.7.40,10.0.0.5')).toBe('192.168.7.40, 10.0.0.5');
    expect(parseTrustProxy('10.0.0.0/255.0.0.0')).toBe('10.0.0.0/255.0.0.0');
    expect(parseTrustProxy('false # no proxy\n')).toBe(false);
    expect(parseTrustProxy('# 192.168.7.40   # NPM\n   \n# later\n')).toBe('loopback, uniquelocal');
    expect(() => parseTrustProxy('192.168.7.40\nnpm.example.org # NPM')).toThrow(/TRUST_PROXY.*"npm\.example\.org"/);
    for (const bad of ['192.168.7.400', '10.0.0.0/33', '10.0.0.0/0', 'fd00::/129', '10.0.0.0/255.0.255.0', 'true, 10.0.0.5', '10.0.0.5 false']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/TRUST_PROXY/);
    }
  });

  it('the login cookie is https-only when the request came over https – plain http in the own network keeps working', async () => {
    const cookieOf = async (remoteAddress: string, headers: Record<string, string>) => {
      const res = await inject({ method: 'POST', url: '/api/login', remoteAddress, payload: { email: 'admin@example.test', password: ADMIN_PW }, headers });
      expect(res.statusCode).toBe(200);
      return String(res.headers['set-cookie']);
    };
    expect(await cookieOf('127.0.0.1', { 'x-forwarded-proto': 'https' })).toMatch(/; Secure/); // through the proxy over https
    expect(await cookieOf('127.0.0.1', {})).not.toMatch(/Secure/); // http directly (e.g. :8093)
    expect(await cookieOf('203.0.113.20', { 'x-forwarded-proto': 'https' })).not.toMatch(/Secure/); // not a trusted proxy
  });

  it('X-Forwarded-For from someone who is not the proxy is ignored', async () => {
    const root2 = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-proxy-'));
    const other = await buildApp(
      { ...loadConfig({ TRUST_PROXY: '192.0.2.1' }), dataPath: join(root2, 'data'), configPath: join(root2, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root2, 'w') },
      { logger: false, nightlyFsck: false },
    );
    other.server.get('/whoami', async (req) => ({ ip: req.ip }));
    const ip = async (remoteAddress: string) =>
      (await other.server.inject({ method: 'GET', url: '/whoami', remoteAddress, headers: { 'x-forwarded-for': '203.0.113.99' } })).json().ip as string;
    expect(await ip('192.0.2.1')).toBe('203.0.113.99'); // the proxy may name the client
    expect(await ip('192.168.1.50')).toBe('192.168.1.50'); // anyone else: their own address counts
    await other.close();
    rmSync(root2, { recursive: true, force: true });
  });

  it('a proxy in front without TRUST_PROXY: one warning in the app\'s log, not one per request (AD-048)', async () => {
    const hints = async (env: Record<string, string>) => {
      const root2 = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-proxy-'));
      const other = await buildApp(
        { ...loadConfig(env), dataPath: join(root2, 'data'), configPath: join(root2, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root2, 'w') },
        { logger: false, nightlyFsck: false },
      );
      const count = () => (other.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE action = 'trust-proxy-missing' AND level = 'warn'").get() as { n: number }).n;
      await other.server.inject({ method: 'GET', url: '/health', remoteAddress: '127.0.0.1' });
      const before = count();
      for (let i = 0; i < 2; i++) await other.server.inject({ method: 'GET', url: '/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.5' } });
      const after = count();
      entry = other.db.prepare("SELECT message, detail_json AS detail FROM activity WHERE action = 'trust-proxy-missing'").get() as typeof entry;
      await other.close();
      rmSync(root2, { recursive: true, force: true });
      return [before, after];
    };
    let entry: { message: string; detail: string } | undefined;
    expect(await hints({})).toEqual([0, 1]);
    // The address is only that of the first such request (any client can send the header): a hint, not an instruction.
    expect(entry!.message).toMatch(/erste.* Anfrage .*vermutlich der Proxy – vor dem Eintragen .*mit der Adresse des Reverse-Proxys abgleichen/);
    expect(JSON.parse(entry!.detail)).toEqual({ proxy: '127.0.0.1' });
    expect(await hints({ TRUST_PROXY: '127.0.0.1' })).toEqual([0, 0]);
  });
});

describe('browser session', () => {
  it('state-changing requests need JSON or the upload header (no CSRF through forms)', async () => {
    const wrong: string[] = [];
    for (const r of all()) {
      if (r.method === 'GET' || PUBLIC[label(r)] || r.url === '/mcp') continue;
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const res = await inject({ method: r.method as 'POST', url: fill(r.url), headers: { cookie: admin, 'content-type': type }, payload: 'a=b' });
        if (res.statusCode !== 415) wrong.push(`${label(r)} (${type}) → ${res.statusCode}`);
      }
      for (const url of encoded(fill(r.url))) {
        const res = await inject({ method: r.method as 'POST', url, headers: { cookie: admin, 'content-type': 'text/plain' }, payload: 'a=b' });
        if (res.statusCode !== 415) wrong.push(`${r.method} ${url} (text/plain) → ${res.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('backups stay admin-only for a logged-in user – also on encoded paths', async () => {
    const ida = await addUser('ida');
    const wrong: string[] = [];
    for (const url of ['/api/backup/status', ...encoded('/api/backup/status'), '/api/b%61ckup/targets']) {
      const res = await inject({ method: 'GET', url, headers: { cookie: ida.cookie } });
      if (res.statusCode !== 403) wrong.push(`GET ${url} → ${res.statusCode} ${res.body.slice(0, 60)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a session that must change its password gets nothing else – also on encoded paths', async () => {
    await inject({ method: 'POST', url: '/api/admin/users', payload: JSON.stringify({ email: 'neu@example.test', username: 'neu', password: 'Start-Passwort-0001' }), headers: { 'content-type': 'application/json', cookie: admin } });
    const c = await login('neu@example.test', 'Start-Passwort-0001');
    const wrong: string[] = [];
    for (const url of ['/api/mounts', ...encoded('/api/mounts'), ...encoded('/api/backup/status')]) {
      const res = await inject({ method: 'GET', url, headers: { cookie: c } });
      if (res.statusCode !== 403) wrong.push(`GET ${url} → ${res.statusCode} ${res.body.slice(0, 60)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a request that names another account than the session’s is refused – without the header as before (code-012)', async () => {
    const headers = { 'content-type': 'application/json', cookie: admin };
    const created = await inject({ method: 'POST', url: `/api/notes/${mountId}`, payload: JSON.stringify({ parent: '', title: 'konto-pruefung', kind: 'file' }), headers });
    const path = (created.json() as { path: string }).path;
    const me = ((await inject({ method: 'GET', url: '/api/session', headers: { cookie: admin } })).json() as { user: { id: string } }).user.id;
    const save = async (raw: string, extra: Record<string, string>) => {
      const { hash } = (await inject({ method: 'GET', url: `/api/notes/${mountId}/${path}`, headers: { cookie: admin } })).json() as { hash: string };
      return inject({ method: 'PUT', url: `/api/notes/${mountId}/${path}`, payload: JSON.stringify({ raw, baseHash: hash }), headers: { ...headers, ...extra } });
    };
    const other = await save('# Fremd\n', { 'x-kaveyl-wiki-user': 'jemand-anderes' });
    expect([other.statusCode, (other.json() as { code: string }).code]).toEqual([403, 'other-user']);
    expect(((await inject({ method: 'GET', url: `/api/notes/${mountId}/${path}`, headers: { cookie: admin } })).json() as { raw: string }).raw).not.toContain('Fremd');
    expect((await save('# Eigen\n', { 'x-kaveyl-wiki-user': me })).statusCode).toBe(200);
    expect((await save('# Ohne\n', {})).statusCode).toBe(200);
  });

  it('a JSON body that is no object is a 400 with a clear message, not an internal error (code-007)', async () => {
    // Exceptions: UI state stores any JSON value; MCP takes JSON-RPC batches (lists) and answers in its own format.
    const ANY_JSON = ['/api/state/:key', '/mcp'];
    const wrong: string[] = [];
    for (const r of all()) {
      if (r.method === 'GET' || ANY_JSON.includes(r.url)) continue;
      for (const payload of ['null', '[]', '"x"', '5', 'true']) {
        const res = await inject({ method: r.method as 'POST', url: fill(r.url), headers: { cookie: admin, 'content-type': 'application/json' }, payload });
        if (res.statusCode === 415) continue; // upload routes take no JSON at all
        if (res.statusCode !== 400 || (res.json() as { error?: string }).error !== 'JSON-Objekt erwartet') wrong.push(`${label(r)} (${payload}) → ${res.statusCode} ${res.body.slice(0, 60)}`);
      }
    }
    expect(wrong).toEqual([]);
    const state = await inject({ method: 'PUT', url: '/api/state/probe', headers: { cookie: admin, 'content-type': 'application/json' }, payload: '[1,2]' });
    expect(state.statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: '/api/state/probe', headers: { cookie: admin } })).json()).toEqual([1, 2]);
  });

  it('MCP never takes the session cookie and refuses foreign pages', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((await inject({ method: 'POST', url: '/mcp', payload: body, headers: { 'content-type': 'application/json', cookie: admin } })).statusCode).toBe(401);
    const t = await token(admin, ['read', 'mcp']);
    expect((await inject({ method: 'POST', url: '/mcp', payload: body, headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...bearer(t.token) } })).statusCode).toBe(403);
    expect((await inject({ method: 'POST', url: '/mcp', payload: body, headers: { 'content-type': 'text/plain', ...bearer(t.token) } })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('paths', () => {
  const tricks = ['../draussen/passwort.md', '../../etc/passwd', '%2e%2e/draussen/passwort.md', '..%2fdraussen%2fpasswort.md', '/etc/passwd', 'docs/../../draussen/passwort.md', 'docs\\..\\..\\draussen\\passwort.md', 'docs/home.md%00.png'];

  it('nothing outside the source: REST v1, app routes, files and MCP', async () => {
    const t = await token(admin, ['read', 'write', 'mcp']);
    const leaks: string[] = [];
    const look = (what: string, status: number, body: string) => {
      if (/GEHEIM-AUSSERHALB|root:x:/.test(body)) leaks.push(`${what} → ${status}`);
    };
    for (const p of [...tricks, 'docs/link-raus.md', 'docs/ordner-raus/passwort.md', 'docs/bild-raus.png', 'docs/ordner-raus/bild.png']) {
      for (const url of [`/api/v1/notes/${mountId}/${p}`, `/api/notes/${mountId}/${p}`, `/api/files/${mountId}/${p}`, `/api/v1/attachments/${mountId}/${p}`, `/api/export/${mountId}/${p}`, `/api/history/${mountId}/${p}`]) {
        const res = await inject({ method: 'GET', url, headers: bearer(t.token) });
        look(url, res.statusCode, res.body);
        const res2 = await inject({ method: 'GET', url, headers: { cookie: admin } });
        look(`${url} (session)`, res2.statusCode, res2.body);
      }
      const decoded = decodeURIComponent(p);
      const mcp = await inject({ method: 'POST', url: '/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_note', arguments: { source_id: mountId, path: decoded } } }), headers: { 'content-type': 'application/json', ...bearer(t.token) } });
      look(`MCP read_note ${decoded}`, mcp.statusCode, mcp.body);
    }
    const tree = await inject({ method: 'GET', url: `/api/v1/tree/${mountId}`, headers: bearer(t.token) });
    look('tree', tree.statusCode, tree.body);
    const search = await inject({ method: 'GET', url: '/api/v1/search?q=GEHEIM', headers: bearer(t.token) });
    look('search', search.statusCode, search.body);
    expect(leaks).toEqual([]);
  });

  it('no writing outside the source or through a link that leads out', async () => {
    const t = await token(admin, ['read', 'write', 'mcp']);
    const h = { 'content-type': 'application/json', ...bearer(t.token) };
    const outcomes: string[] = [];
    for (const p of [...tricks.map(decodeURIComponent), 'docs/link-raus.md', 'docs/ordner-raus/neu.md']) {
      const put = await inject({ method: 'PUT', url: `/api/v1/notes/${mountId}/${p}`, payload: JSON.stringify({ markdown: '# kaputt\n', baseHash: 'x' }), headers: h });
      if (put.statusCode < 300) outcomes.push(`PUT ${p} → ${put.statusCode}`);
      // A leading slash or a strange name just lands inside the source – only the file system check below matters.
      await inject({ method: 'POST', url: `/api/v1/notes/${mountId}`, payload: JSON.stringify({ parent: p, title: 'neu' }), headers: h });
      await inject({ method: 'POST', url: `/api/v1/folders/${mountId}`, payload: JSON.stringify({ parent: p, name: 'neu' }), headers: h });
      const up = await inject({ method: 'POST', url: `/api/v1/attachments/${mountId}`, payload: JSON.stringify({ note: p, name: 'x.svg', contentText: '<svg/>' }), headers: h });
      if (up.statusCode < 300) outcomes.push(`upload to ${p} → ${up.statusCode} ${up.body}`);
      const up2 = await inject({ method: 'POST', url: `/api/v1/attachments/${mountId}`, payload: JSON.stringify({ note: 'docs/home.md', name: p.split('/').join('_') === p ? '../../x.svg' : p, contentText: '<svg/>' }), headers: h });
      if (up2.statusCode < 300 && !(up2.json() as { path: string }).path.startsWith('docs/assets/')) outcomes.push(`upload name ${p} → ${up2.body}`);
      const mv = await inject({ method: 'POST', url: `/api/v1/move/${mountId}`, payload: JSON.stringify({ from: 'docs/home.md', to: p }), headers: h });
      if (mv.statusCode < 300) outcomes.push(`move to ${p} → ${mv.statusCode} ${mv.body}`);
      const del = await inject({ method: 'DELETE', url: `/api/v1/notes/${mountId}/${p}`, headers: bearer(t.token) });
      if (del.statusCode < 300 && !p.startsWith('/')) outcomes.push(`DELETE ${p} → ${del.statusCode}`); // „/etc/passwd“ = etc/passwd inside, made above
    }
    expect(outcomes).toEqual([]);
    const { readFileSync, readdirSync } = await import('node:fs');
    expect(readFileSync(join(root, 'draussen', 'passwort.md'), 'utf8')).toBe('# Draußen\n\nGEHEIM-AUSSERHALB\n');
    expect(readdirSync(join(root, 'draussen')).sort()).toEqual(['bild.png', 'passwort.md']);
    expect(readdirSync(root).sort()).toEqual(['config', 'data', 'draussen', 'projekte']);
    expect(readdirSync(join(root, 'projekte'))).toEqual(['wiki']);
  });

  it('a subfolder (subpath) that turns into a link after mounting is not followed either (AD-047)', async () => {
    const { readdirSync } = await import('node:fs');
    const t = await token(admin, ['read', 'write']);
    const h = { 'content-type': 'application/json', cookie: admin };
    const repo = join(root, 'projekte', 'zweit');
    mkdirSync(join(repo, 'wiki'), { recursive: true });
    writeFileSync(join(repo, 'wiki', 'start.md'), '# Start\n');
    const m = await inject({ method: 'POST', url: '/api/mounts', payload: JSON.stringify({ type: 'local', source: repo, subpath: 'wiki', name: 'Zweit' }), headers: h });
    const id = (m.json() as { id: string }).id;
    expect((await inject({ method: 'GET', url: `/api/v1/tree/${id}`, headers: bearer(t.token) })).body).toContain('start.md');
    // Like a pull that replaces the folder by a link; then the source starts anew (indexes everything).
    rmSync(join(repo, 'wiki'), { recursive: true });
    symlinkSync(join(root, 'draussen'), join(repo, 'wiki'));
    await inject({ method: 'PATCH', url: `/api/mounts/${id}`, payload: JSON.stringify({ paused: true }), headers: h });
    await inject({ method: 'PATCH', url: `/api/mounts/${id}`, payload: JSON.stringify({ paused: false }), headers: h });
    const leaks: string[] = [];
    for (const [url, headers] of [
      [`/api/notes/${id}/passwort.md`, { cookie: admin }],
      [`/api/files/${id}/bild.png`, { cookie: admin }],
      [`/api/order/${id}`, { cookie: admin }],
      [`/api/v1/notes/${id}/passwort.md`, bearer(t.token)],
      [`/api/v1/tree/${id}`, bearer(t.token)],
      ['/api/v1/search?q=GEHEIM', bearer(t.token)],
    ] as const) {
      const res = await inject({ method: 'GET', url, headers });
      if (/GEHEIM-AUSSERHALB/.test(res.body) || (url.includes('/tree/') && res.body.includes('passwort.md'))) leaks.push(`${url} → ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
    await inject({ method: 'PUT', url: `/api/v1/notes/${id}/neu.md`, payload: JSON.stringify({ markdown: '# kaputt\n', baseHash: 'x' }), headers: { 'content-type': 'application/json', ...bearer(t.token) } });
    await inject({ method: 'POST', url: `/api/v1/notes/${id}`, payload: JSON.stringify({ parent: '', title: 'neu' }), headers: { 'content-type': 'application/json', ...bearer(t.token) } });
    expect(readdirSync(join(root, 'draussen')).sort()).toEqual(['bild.png', 'passwort.md']);
    await inject({ method: 'DELETE', url: `/api/mounts/${id}`, headers: { cookie: admin } });
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('access rules through API and MCP', () => {
  it('a source closed for someone does not exist for their token – anywhere', async () => {
    const eva = await addUser('eva');
    const users = (await inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).json() as { id: string; username: string }[];
    const evaId = users.find((u) => u.username === 'eva')!.id;
    await inject({ method: 'POST', url: `/api/acl/${mountId}`, payload: JSON.stringify({ target: 'mount', subject: 'user', subjectId: evaId, level: 'none' }), headers: { 'content-type': 'application/json', cookie: admin } });
    const t = await token(eva.cookie, ['read', 'write', 'mcp']);
    const shows: string[] = [];
    for (const r of all()) {
      if (PUBLIC[label(r)] || r.url === '/mcp' || !/:(mountId|sourceId)|\*$/.test(r.url) || r.url.startsWith('/api/backup') || r.url.startsWith('/api/admin')) continue;
      const res = await send(r, bearer(t.token), JSON.stringify({ from: 'docs/home.md', to: 'docs/x.md', toParent: 'docs', parent: 'docs', title: 'x', name: 'x', note: 'docs/home.md', contentText: '<svg/>', markdown: '# x\n', baseHash: 'x' }));
      if (res.statusCode < 400 || /Trilium|home\.md|Wiki/.test(res.body)) shows.push(`${label(r)} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    for (const url of ['/api/v1/sources', '/api/v1/status', '/api/v1/search?q=Trilium', '/api/mounts', '/api/search?q=Trilium', '/api/recent', '/api/tags']) {
      const res = await inject({ method: 'GET', url, headers: bearer(t.token) });
      if (res.body.includes(mountId) || /Trilium|home\.md/.test(res.body)) shows.push(`${url} → ${res.body.slice(0, 80)}`);
    }
    const mcp = async (name: string, args: Record<string, unknown>) =>
      (await inject({ method: 'POST', url: '/mcp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), headers: { 'content-type': 'application/json', ...bearer(t.token) } })).body;
    for (const [name, args] of [
      ['list_sources', {}],
      ['search', { query: 'Trilium' }],
      ['list_tree', { source_id: mountId }],
      ['read_note', { source_id: mountId, path: 'docs/home.md' }],
      ['write_note', { source_id: mountId, path: 'docs/home.md', markdown: '# x', base_hash: 'x' }],
      ['create_note', { source_id: mountId, parent: 'docs', title: 'x' }],
      ['create_folder', { source_id: mountId, parent: '', name: 'x' }],
      ['move_note', { source_id: mountId, from: 'docs/home.md', to: 'docs/x.md' }],
      ['copy_note', { source_id: mountId, from: 'docs/home.md', to_parent: '' }],
      ['delete_note', { source_id: mountId, path: 'docs/home.md' }],
      ['upload_file', { source_id: mountId, note: 'docs/home.md', name: 'x.svg', content_text: '<svg/>' }],
      ['list_changes', { source_id: mountId }],
      ['list_attachments', { source_id: mountId, path: 'docs/home.md' }],
      ['get_backlinks', { source_id: mountId, path: 'docs/home.md' }],
      ['get_history', { source_id: mountId, path: 'docs/home.md' }],
      ['read_version', { source_id: mountId, path: 'docs/home.md', commit: 'HEAD' }],
      ['get_sync_status', { source_id: mountId }],
      ['sync_source', { source_id: mountId }],
    ] as const) {
      const body = await mcp(name, args);
      if (!/"isError":true/.test(body) && (body.includes(mountId) || /Trilium|home\.md/.test(body))) shows.push(`MCP ${name} → ${body.slice(0, 100)}`);
      if (/Trilium/.test(body)) shows.push(`MCP ${name} leaks content`);
    }
    expect(shows).toEqual([]);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(root, 'projekte', 'wiki', 'docs', 'home.md'), 'utf8')).toBe('# Home\n\nTrilium und Outline.\n');
  });

  it('manual orders and encrypted folders name nothing from a hidden folder (AD-020)', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    const metas = [join(wiki, '.kaveyl-wiki.yml'), join(wiki, 'docs', '.kaveyl-wiki.yml'), join(wiki, 'geheim', '.kaveyl-wiki.yml')];
    writeFileSync(metas[0]!, 'order:\n  - geheim\n  - docs\n');
    writeFileSync(metas[1]!, 'order:\n  - home.md\nencrypted: age\n');
    writeFileSync(metas[2]!, 'order:\n  - lohn.md\nencrypted: age\n');
    try {
      const jan = await addUser('jan');
      await inject({ method: 'POST', url: `/api/acl/${mountId}`, payload: JSON.stringify({ target: 'folder', path: 'geheim', subject: 'user', subjectId: jan.id, level: 'none' }), headers: { 'content-type': 'application/json', cookie: admin } });
      const get = async (url: string, cookie: string) => (await inject({ method: 'GET', url, headers: { cookie } })).json() as unknown;
      expect(await get(`/api/order/${mountId}`, admin)).toEqual({ '': ['geheim', 'docs'], docs: ['home.md'], geheim: ['lohn.md'] });
      expect(await get(`/api/encrypted/${mountId}`, admin)).toEqual(['docs', 'geheim']);
      expect(await get(`/api/order/${mountId}`, jan.cookie)).toEqual({ '': ['docs'], docs: ['home.md'] });
      expect(await get(`/api/encrypted/${mountId}`, jan.cookie)).toEqual(['docs']);
    } finally {
      for (const f of metas) rmSync(f, { force: true });
    }
  });

  it('reordering keeps what the user cannot see at its place in the manual order', async () => {
    const wiki = join(root, 'projekte', 'wiki');
    const meta = join(wiki, '.kaveyl-wiki.yml');
    const json = (cookie: string) => ({ 'content-type': 'application/json', cookie });
    const ablage = await inject({ method: 'POST', url: `/api/notes/${mountId}`, payload: JSON.stringify({ parent: '', title: 'ablage', kind: 'dir' }), headers: json(admin) });
    expect(ablage.statusCode).toBe(200);
    writeFileSync(meta, 'order:\n  - docs\n  - geheim\n  - ablage\n  - weg\n');
    try {
      const ina = await addUser('ina');
      await inject({ method: 'POST', url: `/api/acl/${mountId}`, payload: JSON.stringify({ target: 'folder', path: 'geheim', subject: 'user', subjectId: ina.id, level: 'none' }), headers: json(admin) });
      const put = async (order: string[], cookie = ina.cookie) => {
        const res = await inject({ method: 'PUT', url: `/api/order/${mountId}`, payload: JSON.stringify({ folder: '', order }), headers: json(cookie) });
        expect(res.statusCode, res.body).toBe(200);
      };
      const stored = async () => ((await inject({ method: 'GET', url: `/api/order/${mountId}`, headers: { cookie: admin } })).json() as Record<string, string[]>)[''];
      // The hidden folder stays behind the entry it followed; a name that no longer exists goes.
      await put(['ablage', 'docs']);
      expect(await stored()).toEqual(['ablage', 'docs', 'geheim']);
      // A hidden name in the request does not move it.
      await put(['geheim', 'docs', 'ablage']);
      expect(await stored()).toEqual(['docs', 'geheim', 'ablage']);
      // „Alphabetisch sortieren“ resets only what the user sees.
      await put([]);
      expect(await stored()).toEqual(['geheim']);
      // Someone who sees everything resets everything.
      await put([], admin);
      expect(await stored()).toBeUndefined();
    } finally {
      rmSync(meta, { force: true });
    }
  });
});

describe('API description', () => {
  it('every /api/v1 route is in openapi.json and every described operation exists', async () => {
    const spec = (await inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as { paths: Record<string, Record<string, unknown>> };
    const asSpec = (url: string) => url.replace(/^\/api\/v1/, '').replace(/\/\*$/, '/{path}').replace(/:([a-zA-Z]+)/g, '{$1}');
    const registered = all()
      .filter((r) => r.url.startsWith('/api/v1/') && r.url !== '/api/v1/openapi.json')
      .map((r) => `${r.method.toLowerCase()} ${asSpec(r.url)}`)
      .sort();
    const described = Object.entries(spec.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`))
      .sort();
    expect(registered).toEqual(described);
  });
});
