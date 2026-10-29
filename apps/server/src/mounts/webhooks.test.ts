// Push webhooks at the hosters (AD-033) against fake servers — never the real Gitea/GitHub/GitLab.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { installWebhooks, removeWebhooks, webhookStatus, type HostAccess } from './hosts.js';

const URL_ = 'https://wiki.example.org/api/webhooks/git';

describe('webhooks at the hosters (fake servers)', () => {
  let server: Server;
  let base: string;
  const calls: string[] = [];
  // Hooks per API path, as the fake hosters hold them.
  let hooks: Record<string, { id: number; url?: string; active?: boolean; config?: { url: string } }[]>;
  beforeEach(async () => {
    calls.length = 0;
    hooks = {
      '/api/v1/user/hooks': [],
      '/api/v1/repos/mara/wiki/hooks': [{ id: 1, config: { url: URL_ } }],
      '/api/v1/repos/firma/web/hooks': [],
      '/api/v3/repos/mara/wiki/hooks': [{ id: 2, config: { url: 'https://anderswo.example/hook' } }],
      '/api/v4/projects/firma%2Fteam%2Fwiki/hooks': [],
    };
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ''}`);
        const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        if (req.url === '/api/v1/user') return json(200, { login: 'mara' });
        // …/hooks/<id>: change (PATCH, GitLab PUT) or delete one hook.
        const one = /^(.*\/hooks)\/(\d+)$/.exec(req.url!);
        if (one) {
          const list = hooks[one[1]!];
          const i = list?.findIndex((h) => h.id === Number(one[2])) ?? -1;
          if (!list || i < 0) return json(404, {});
          if (req.method === 'DELETE') return (list.splice(i, 1), res.writeHead(204).end());
          list[i] = { id: list[i]!.id, ...(JSON.parse(body) as object) };
          return json(200, list[i]);
        }
        const list = hooks[req.url!];
        if (!list) return json(404, {});
        if (req.method === 'GET') return json(200, list);
        const b = JSON.parse(body) as { url?: string; config?: { url: string } };
        list.push({ id: list.length + 10, ...b });
        json(201, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const BODY = (secret: string) => `{"type":"gitea","name":"Kaveyl Wiki","active":true,"events":["push"],"branch_filter":"*","config":{"url":"${URL_}","content_type":"json","secret":"${secret}","http_method":"post"}}`;

  it('Gitea: the admin chooses account hook or one per repository; a hook added by hand at the repository counts (owner 25.10.)', async () => {
    const a: HostAccess = { kind: 'gitea', base, token: 't' };
    // mara/wiki has a hook of ours (e.g. added by hand), firma/web (another owner) none, the account none.
    const before = await webhookStatus(a, URL_, ['mara/wiki', 'firma/web']);
    // Only the hooks that exist are listed (owner 26.10.); firma/web has none.
    expect(before.hooks).toEqual([{ scope: 'repo', name: 'mara/wiki', at: URL_, current: true, active: true }]);
    expect(before.uncovered).toEqual(['firma/web']);
    expect(before.account).toBe('mara');
    expect(before.plans).toEqual({
      repos: [{ scope: 'repo', name: 'firma/web', action: 'create' }],
      // The account hook covers mara's repositories – their own hook of ours would double every push, so it goes.
      account: [
        { scope: 'account', name: 'mara', action: 'create' },
        { scope: 'repo', name: 'mara/wiki', action: 'remove' },
        { scope: 'repo', name: 'firma/web', action: 'create' },
      ],
      remove: [{ scope: 'repo', name: 'mara/wiki', action: 'remove' }],
    });
    const acc = await installWebhooks(a, URL_, 'geheim', ['mara/wiki', 'firma/web'], 'account');
    expect(acc.changes).toEqual({ created: ['mara', 'firma/web'], moved: [], removed: ['mara/wiki'] });
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([
      `POST /api/v1/user/hooks ${BODY('geheim')}`,
      'DELETE /api/v1/repos/mara/wiki/hooks/1',
      `POST /api/v1/repos/firma/web/hooks ${BODY('geheim')}`,
    ]);
    // mara/wiki has no hook of its own any more – no line for it, the account hook reaches it.
    expect(acc.hooks).toEqual([
      { scope: 'account', name: 'mara', at: URL_, current: true, active: true },
      { scope: 'repo', name: 'firma/web', at: URL_, current: true, active: true },
    ]);
    expect(acc.uncovered).toEqual([]);
    // Again: nothing to do, nothing sent.
    calls.length = 0;
    expect((await installWebhooks(a, URL_, 'geheim', ['mara/wiki', 'firma/web'], 'account')).changes).toEqual({ created: [], moved: [], removed: [] });
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    // The other way: a hook per repository, the account hook goes.
    const per = await installWebhooks(a, URL_, 'geheim', ['mara/wiki', 'firma/web'], 'repos');
    expect(per.changes).toEqual({ created: ['mara/wiki'], moved: [], removed: ['mara'] });
    expect(per.hooks.map((h) => `${h.scope} ${h.name}`)).toEqual(['repo mara/wiki', 'repo firma/web']);
  });

  it('both hooks at once: both listed, the repository one as double; each can be removed on its own (owner 26.10.)', async () => {
    const a: HostAccess = { kind: 'gitea', base, token: 't' };
    hooks['/api/v1/user/hooks'] = [{ id: 5, config: { url: URL_ } }];
    const st = await webhookStatus(a, URL_, ['mara/wiki']);
    expect(st.hooks).toEqual([
      { scope: 'account', name: 'mara', at: URL_, current: true, active: true },
      { scope: 'repo', name: 'mara/wiki', at: URL_, current: true, active: true, double: true },
    ]);
    expect(st.plans.remove.map((s) => s.name)).toEqual(['mara', 'mara/wiki']);
    // Only the repository hook goes; the account hook stays.
    const one = await removeWebhooks(a, URL_, ['mara/wiki'], { scope: 'repo', name: 'mara/wiki' });
    expect(one.changes).toEqual({ created: [], moved: [], removed: ['mara/wiki'] });
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /api/v1/repos/mara/wiki/hooks/1']);
    expect(one.hooks.map((h) => `${h.scope} ${h.name}`)).toEqual(['account mara']);
    // A place without a hook of ours: nothing happens.
    expect((await removeWebhooks(a, URL_, ['mara/wiki'], { scope: 'repo', name: 'mara/wiki' })).changes.removed).toEqual([]);
    // Then the account hook alone: nothing left, the repository syncs every 5 minutes again.
    const none = await removeWebhooks(a, URL_, ['mara/wiki'], { scope: 'account', name: 'mara' });
    expect(none.hooks).toEqual([]);
    expect(none.uncovered).toEqual(['mara/wiki']);
  });

  it('a hook switched off at the hoster is listed as such', async () => {
    hooks['/api/v1/repos/mara/wiki/hooks'] = [{ id: 1, active: false, config: { url: URL_ } }];
    const st = await webhookStatus({ kind: 'gitea', base, token: 't' }, URL_, ['mara/wiki']);
    expect(st.hooks).toEqual([{ scope: 'repo', name: 'mara/wiki', at: URL_, current: true, active: false }]);
  });

  it('a hook of ours at an earlier (known) address is moved, not doubled; „Entfernen“ deletes ours only (owner 25.10.)', async () => {
    const a: HostAccess = { kind: 'gitea', base, token: 't' };
    hooks['/api/v1/user/hooks'] = [
      { id: 7, config: { url: 'https://alt.example.org/api/webhooks/git' } },
      { id: 8, config: { url: 'https://ci.example.org/build' } },
    ];
    // This instance used alt.example.org before (code-004: only then is the hook its own).
    const KNOWN = ['https://alt.example.org/api/webhooks/git'];
    const before = await webhookStatus(a, URL_, ['firma/web'], KNOWN);
    expect(before.hooks).toEqual([{ scope: 'account', name: 'mara', at: 'https://alt.example.org/api/webhooks/git', current: false, active: true }]);
    expect(before.plans.account![0]).toEqual({ scope: 'account', name: 'mara', action: 'move', from: 'https://alt.example.org/api/webhooks/git' });
    const after = await installWebhooks(a, URL_, 'geheim', ['firma/web'], 'account', KNOWN);
    expect(after.changes).toEqual({ created: ['firma/web'], moved: ['mara'], removed: [] });
    expect(calls.filter((c) => c.startsWith('PATCH'))).toEqual([`PATCH /api/v1/user/hooks/7 ${BODY('geheim')}`]);
    expect(hooks['/api/v1/user/hooks']!.map((h) => h.config?.url)).toEqual([URL_, 'https://ci.example.org/build']);
    // Nothing left to do: a second click changes nothing – the answer says so.
    expect((await installWebhooks(a, URL_, 'geheim', ['firma/web'], 'account', KNOWN)).changes).toEqual({ created: [], moved: [], removed: [] });
    const removed = await removeWebhooks(a, URL_, ['firma/web'], undefined, KNOWN);
    expect(removed.changes.removed).toEqual(['mara', 'firma/web']);
    expect(hooks['/api/v1/user/hooks']!.map((h) => h.config?.url)).toEqual(['https://ci.example.org/build']);
    expect(removed.hooks).toEqual([]);
    expect(removed.uncovered).toEqual(['firma/web']);
    expect(removed.plans.remove).toEqual([]);
  });

  // Dev and Prod on one Gitea account (code-004, owner 26.10.): the other instance's hooks are shown, never touched.
  const PROD = 'https://prod.example.org/api/webhooks/git';

  it('another instance\'s account hook: listed as foreign, in no plan; both ways of setting up and „Entfernen“ leave it (code-004)', async () => {
    const a: HostAccess = { kind: 'gitea', base, token: 't' };
    hooks['/api/v1/user/hooks'] = [{ id: 7, config: { url: PROD } }];
    hooks['/api/v1/repos/mara/wiki/hooks'] = [];
    const before = await webhookStatus(a, URL_, ['mara/wiki']);
    expect(before.hooks).toEqual([{ scope: 'account', name: 'mara', at: PROD, current: false, active: true, foreign: true }]);
    // The foreign account hook reaches mara/wiki – but not for this instance.
    expect(before.uncovered).toEqual(['mara/wiki']);
    expect(before.plans).toEqual({
      repos: [{ scope: 'repo', name: 'mara/wiki', action: 'create' }],
      // The account way creates an own account hook next to the foreign one.
      account: [{ scope: 'account', name: 'mara', action: 'create' }],
      remove: [],
    });
    expect((await removeWebhooks(a, URL_, ['mara/wiki'])).changes).toEqual({ created: [], moved: [], removed: [] });
    expect((await removeWebhooks(a, URL_, ['mara/wiki'], { scope: 'account', name: 'mara' })).changes.removed).toEqual([]);
    const per = await installWebhooks(a, URL_, 'geheim', ['mara/wiki'], 'repos');
    expect(per.changes).toEqual({ created: ['mara/wiki'], moved: [], removed: [] });
    // Own repository hook next to the foreign account hook: not „double“ (Prod's hook does not call this instance).
    expect(per.hooks).toEqual([
      { scope: 'account', name: 'mara', at: PROD, current: false, active: true, foreign: true },
      { scope: 'repo', name: 'mara/wiki', at: URL_, current: true, active: true },
    ]);
    const acc = await installWebhooks(a, URL_, 'geheim', ['mara/wiki'], 'account');
    expect(acc.changes).toEqual({ created: ['mara'], moved: [], removed: ['mara/wiki'] });
    expect(hooks['/api/v1/user/hooks']!.map((h) => h.config?.url)).toEqual([PROD, URL_]);
    expect(acc.hooks.map((h) => `${h.scope} ${h.at}${h.foreign ? ' foreign' : ''}`)).toEqual([`account ${URL_}`, `account ${PROD} foreign`]);
    // „Alle entfernen“ and the account's own button delete only this instance's account hook.
    const gone = await removeWebhooks(a, URL_, ['mara/wiki'], { scope: 'account', name: 'mara' });
    expect(gone.changes.removed).toEqual(['mara']);
    expect(hooks['/api/v1/user/hooks']).toEqual([{ id: 7, config: { url: PROD } }]);
    expect(calls.filter((c) => c.startsWith('PATCH') || c.startsWith('PUT') || c.includes('/user/hooks/7'))).toEqual([]);
  });

  it('another instance\'s repository hook: foreign, the repository counts as without hook; setting up adds an own one next to it (code-004)', async () => {
    const a: HostAccess = { kind: 'gitea', base, token: 't' };
    hooks['/api/v1/repos/firma/web/hooks'] = [{ id: 3, config: { url: PROD } }];
    const before = await webhookStatus(a, URL_, ['firma/web']);
    expect(before.hooks).toEqual([{ scope: 'repo', name: 'firma/web', at: PROD, current: false, active: true, foreign: true }]);
    expect(before.uncovered).toEqual(['firma/web']);
    expect(before.plans.repos).toEqual([{ scope: 'repo', name: 'firma/web', action: 'create' }]);
    expect(before.plans.account).toEqual([
      { scope: 'account', name: 'mara', action: 'create' },
      { scope: 'repo', name: 'firma/web', action: 'create' },
    ]);
    expect(before.plans.remove).toEqual([]);
    const after = await installWebhooks(a, URL_, 'geheim', ['firma/web'], 'repos');
    expect(after.changes).toEqual({ created: ['firma/web'], moved: [], removed: [] });
    expect(hooks['/api/v1/repos/firma/web/hooks']!.map((h) => h.config?.url)).toEqual([PROD, URL_]);
    // „Entfernen“ at that place deletes only the own hook.
    const removed = await removeWebhooks(a, URL_, ['firma/web'], { scope: 'repo', name: 'firma/web' });
    expect(removed.changes.removed).toEqual(['firma/web']);
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /api/v1/repos/firma/web/hooks/11']);
    expect(hooks['/api/v1/repos/firma/web/hooks']).toEqual([{ id: 3, config: { url: PROD } }]);
  });

  it('own earlier address and another instance at one place: only the own one is moved (code-004)', async () => {
    const a: HostAccess = { kind: 'gitea', base, token: 't' };
    const OLD = 'http://192.168.1.20:8093/api/webhooks/git/';
    hooks['/api/v1/repos/firma/web/hooks'] = [
      { id: 3, config: { url: PROD } },
      { id: 4, config: { url: OLD } },
    ];
    // Known without the trailing slash: the same address.
    const st = await webhookStatus(a, URL_, ['firma/web'], ['http://192.168.1.20:8093/api/webhooks/git']);
    expect(st.plans.repos).toEqual([{ scope: 'repo', name: 'firma/web', action: 'move', from: OLD }]);
    const after = await installWebhooks(a, URL_, 'geheim', ['firma/web'], 'repos', ['http://192.168.1.20:8093/api/webhooks/git']);
    expect(after.changes.moved).toEqual(['firma/web']);
    expect(calls.filter((c) => c.startsWith('PATCH')).map((c) => c.split(' ')[1])).toEqual(['/api/v1/repos/firma/web/hooks/4']);
    expect(hooks['/api/v1/repos/firma/web/hooks']!.map((h) => h.config?.url)).toEqual([PROD, URL_]);
  });

  it('Gitea without account hooks (older version): every repository gets its own, no choice', async () => {
    delete hooks['/api/v1/user/hooks'];
    const status = await webhookStatus({ kind: 'gitea', base, token: 't' }, URL_, ['mara/wiki']);
    expect(status.hooks).toEqual([{ scope: 'repo', name: 'mara/wiki', at: URL_, current: true, active: true }]);
    expect(status.account).toBeUndefined();
    expect(status.plans.account).toBeUndefined();
  });

  it('GitHub and GitLab: one hook per repository, in their own format', async () => {
    await installWebhooks({ kind: 'github', base, token: 'g' }, URL_, 'geheim', ['mara/wiki']);
    await installWebhooks({ kind: 'gitlab', base, token: 'l' }, URL_, 'geheim', ['firma/team/wiki']);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      `POST /api/v3/repos/mara/wiki/hooks {"name":"web","active":true,"events":["push"],"config":{"url":"${URL_}","content_type":"json","secret":"geheim","insecure_ssl":"0"}}`,
      `POST /api/v4/projects/firma%2Fteam%2Fwiki/hooks {"name":"Kaveyl Wiki","url":"${URL_}","token":"geheim","push_events":true,"enable_ssl_verification":true}`,
    ]);
  });
});
