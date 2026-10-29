import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, type DB } from '../db/db.js';
import { SecretStore } from '../secrets.js';
import { ConnectionStore, LEGACY_GITEA_SECRET } from './connections.js';
import { createRepo, deleteRepo, gitAuthorization, hostCloneUrl, hostFullName, listOwners, listRepos, setArchived, type HostAccess } from './hosts.js';
import { MountStore } from './model.js';

let db: DB;
let secrets: SecretStore;
let store: ConnectionStore;
let mounts: MountStore;

beforeEach(() => {
  db = openDb(':memory:');
  secrets = new SecretStore(db, randomBytes(32));
  store = new ConnectionStore(db, secrets);
  mounts = new MountStore(db);
});
afterEach(() => db.close());

describe('connections (AD-029)', () => {
  it('takes over the global Gitea and own tokens once, without re-encrypting', () => {
    secrets.put('gitea-token', LEGACY_GITEA_SECRET);
    const own = secrets.put('own-token');
    const viaGitea = mounts.create({ name: 'Wiki', type: 'remote', source: 'https://gitea.x/mara/wiki.git', credentialId: LEGACY_GITEA_SECRET });
    const viaToken = mounts.create({ name: 'Ext', type: 'remote', source: 'https://git.other.org/team/docs.git', credentialId: own });
    const local = mounts.create({ name: 'Ordner', type: 'local', source: '/projekte/x' });
    db.prepare("INSERT INTO repo_trash (full_name, clone_url, archived_at, delete_after) VALUES ('mara/alt', 'https://gitea.x/mara/alt.git', 'a', 'b')").run();

    expect(store.adoptLegacy('https://gitea.x/some/path')).toEqual({ created: 2, linked: 2 });
    expect(store.adoptLegacy('https://gitea.x')).toEqual({ created: 0, linked: 0 });

    const [git, gitea] = [store.list().find((c) => c.kind === 'git')!, store.list().find((c) => c.kind === 'gitea')!];
    expect(gitea).toMatchObject({ baseUrl: 'https://gitea.x', secretId: LEGACY_GITEA_SECRET, name: 'Gitea (gitea.x)' });
    expect(git).toMatchObject({ baseUrl: 'https://git.other.org', secretId: own });
    expect(mounts.get(viaGitea.id)!.connectionId).toBe(gitea.id);
    expect(mounts.get(viaToken.id)!.connectionId).toBe(git.id);
    expect(mounts.get(local.id)!.connectionId).toBeNull();
    expect(store.usage(gitea.id)).toEqual({ mounts: 1, trash: 1 });
    // Same header as before for the taken-over token.
    expect(store.gitAuthorization(git)).toBe('token own-token');
    expect(store.defaultGitea()?.id).toBe(gitea.id);
  });

  it('keeps the address while sources use it; token, name and user name change any time', () => {
    const c = store.create({ kind: 'gitlab', token: 'glpat-1' });
    expect(c).toMatchObject({ baseUrl: 'https://gitlab.com', name: 'GitLab (gitlab.com)' });
    const m = mounts.create({ name: 'Doku', type: 'remote', source: 'https://gitlab.com/g/doku.git', connectionId: c.id, credentialId: c.secretId });
    expect(() => store.update(c.id, { baseUrl: 'https://gitlab.example.org' })).toThrow(/nicht ändern/);
    const next = store.update(c.id, { name: 'Firma', token: 'glpat-2', username: 'mara' });
    expect(next.secretId).toBe(c.secretId);
    expect(store.token(next)).toBe('glpat-2');
    expect(store.gitAuthorization(next)).toBe(`Basic ${Buffer.from('mara:glpat-2').toString('base64')}`);
    expect(() => store.delete(c.id)).toThrow(/1 Quelle/);
    mounts.delete(m.id);
    // A repository of this connection in the repo trash also keeps the address.
    db.prepare("INSERT INTO repo_trash (full_name, clone_url, archived_at, delete_after, actor, connection_id) VALUES ('g/alt', 'https://gitlab.com/g/alt.git', 'x', 'y', null, ?)").run(c.id);
    expect(() => store.update(c.id, { baseUrl: 'https://gitlab.example.org' })).toThrow(/Repository-Papierkorb/);
    db.prepare("DELETE FROM repo_trash WHERE full_name = 'g/alt'").run();
    store.delete(c.id);
    expect(store.list()).toEqual([]);
    expect(secrets.get(c.secretId!)).toBeNull();
  });

  it('checks input: hosters need a token, addresses are plain https origins', () => {
    expect(() => store.create({ kind: 'github' })).toThrow(/Token/);
    expect(() => store.create({ kind: 'git', baseUrl: 'ssh://x' })).toThrow(/https/);
    expect(() => store.create({ kind: 'git', baseUrl: 'https://u:p@x.org' })).toThrow(/Zugangsdaten/);
    expect(store.create({ kind: 'git', baseUrl: 'https://x.org/a/b.git' })).toMatchObject({ baseUrl: 'https://x.org', secretId: null });
    expect(() => store.hostAccess(store.list()[0]!)).toThrow(/reine Git-Verbindung/);
  });

  it('builds the git Authorization header per kind', () => {
    const b = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
    expect(gitAuthorization('gitea', 't')).toBe('token t');
    expect(gitAuthorization('github', 't')).toBe(b('x-access-token:t'));
    expect(gitAuthorization('gitlab', 't')).toBe(b('oauth2:t'));
    expect(gitAuthorization('git', 't', 'bob')).toBe(b('bob:t'));
    expect(gitAuthorization('git', 't')).toBe('token t');
  });

  it('knows repository names and clone URLs on each host (GitLab with sub-groups)', () => {
    expect(hostFullName('github', 'https://github.com', 'https://github.com/mara/wiki.git')).toBe('mara/wiki');
    expect(hostFullName('github', 'https://github.com', 'https://github.com/a/b/c.git')).toBeNull();
    expect(hostFullName('gitlab', 'https://gitlab.com', 'https://gitlab.com/firma/team/wiki.git')).toBe('firma/team/wiki');
    expect(hostFullName('gitea', 'https://gitea.x', 'https://other.x/mara/wiki.git')).toBeNull();
    expect(hostCloneUrl('gitlab', 'https://gitlab.com/x', 'firma/team/wiki')).toBe('https://gitlab.com/firma/team/wiki.git');
    expect(() => hostCloneUrl('github', 'https://github.com', '../etc')).toThrow(/Ungültiger/);
  });
});

describe('GitHub and GitLab APIs (fake servers, never the real ones)', () => {
  let server: Server;
  let base: string;
  const calls: string[] = [];
  beforeEach(async () => {
    calls.length = 0;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ''} [${req.headers.authorization}]`);
        const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        const url = req.url!;
        // GitHub Enterprise layout (<host>/api/v3) — github.com itself uses api.github.com.
        if (url === '/api/v3/user') return json(200, { login: 'mara' });
        if (url.startsWith('/api/v3/user/orgs')) return json(200, [{ login: 'firma' }]);
        if (url.startsWith('/api/v3/user/repos') && req.method === 'GET')
          return json(200, [
            { full_name: 'mara/wiki', description: 'Notizen', clone_url: `${base}/mara/wiki.git`, default_branch: 'main', private: true, updated_at: 'x' },
            { full_name: 'firma/web', description: '', clone_url: `${base}/firma/web.git`, default_branch: 'master', private: false, updated_at: 'y' },
          ]);
        if (url === '/api/v3/orgs/firma/repos') return json(201, { full_name: 'firma/neu', clone_url: `${base}/firma/neu.git`, default_branch: 'main', private: true });
        if (url === '/api/v3/repos/mara/wiki') return req.method === 'DELETE' ? res.writeHead(204).end() : json(200, { full_name: 'mara/wiki', archived: true });
        if (url === '/api/v4/user') return json(200, { username: 'mara' });
        if (url.startsWith('/api/v4/groups')) return json(200, [{ full_path: 'firma/team', id: 42 }]);
        if (url.startsWith('/api/v4/projects?'))
          return json(200, [{ path_with_namespace: 'firma/team/wiki', description: null, http_url_to_repo: `${base}/firma/team/wiki.git`, default_branch: 'main', visibility: 'internal' }]);
        if (url === '/api/v4/projects' && req.method === 'POST') {
          const b = JSON.parse(body) as { path: string };
          if (b.path === 'vergeben') return json(400, { message: { name: ['has already been taken'] } });
          return json(201, { path_with_namespace: `firma/team/${b.path}`, http_url_to_repo: `${base}/firma/team/${b.path}.git`, default_branch: 'main', visibility: 'private' });
        }
        if (url.startsWith('/api/v4/projects/firma%2Fteam%2Fwiki')) return req.method === 'DELETE' ? json(202, { message: '202 Accepted' }) : json(201, {});
        json(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('GitHub: lists and filters repos, owners, creates in an org, archives and deletes', async () => {
    const a: HostAccess = { kind: 'github', base, token: 'ghp_x' };
    expect((await listRepos(a, '')).map((r) => r.fullName)).toEqual(['mara/wiki', 'firma/web']);
    expect((await listRepos(a, 'notiz')).map((r) => r.fullName)).toEqual(['mara/wiki']);
    expect(await listOwners(a)).toEqual([
      { name: 'mara', kind: 'user' },
      { name: 'firma', kind: 'org' },
    ]);
    expect((await createRepo(a, { owner: { name: 'firma', kind: 'org' }, name: 'neu', private: true })).fullName).toBe('firma/neu');
    await setArchived(a, 'mara/wiki', true);
    await deleteRepo(a, 'mara/wiki');
    expect(calls.every((c) => c.endsWith('[Bearer ghp_x]'))).toBe(true);
    expect(calls.slice(-3)).toEqual([
      'POST /api/v3/orgs/firma/repos {"name":"neu","description":"","private":true,"auto_init":true} [Bearer ghp_x]',
      'PATCH /api/v3/repos/mara/wiki {"archived":true} [Bearer ghp_x]',
      'DELETE /api/v3/repos/mara/wiki [Bearer ghp_x]',
    ]);
  });

  it('GitLab: projects with sub-groups, group owners with id, create, archive, delete, taken name', async () => {
    const a: HostAccess = { kind: 'gitlab', base, token: 'glpat' };
    expect(await listRepos(a, 'wi')).toEqual([
      { fullName: 'firma/team/wiki', description: '', cloneUrl: `${base}/firma/team/wiki.git`, defaultBranch: 'main', private: true, updatedAt: '' },
    ]);
    expect(await listOwners(a)).toEqual([
      { name: 'mara', kind: 'user' },
      { name: 'firma/team', kind: 'org', id: 42 },
    ]);
    const repo = await createRepo(a, { owner: { name: 'firma/team', kind: 'org', id: 42 }, name: 'neu', private: true });
    expect(repo.fullName).toBe('firma/team/neu');
    expect(calls.at(-1)).toContain('"namespace_id":42');
    await expect(createRepo(a, { owner: { name: 'mara', kind: 'user' }, name: 'vergeben', private: true })).rejects.toThrow(/vergeben/);
    await setArchived(a, 'firma/team/wiki', true);
    await setArchived(a, 'firma/team/wiki', false);
    await deleteRepo(a, 'firma/team/wiki');
    expect(calls.slice(-3).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'POST /api/v4/projects/firma%2Fteam%2Fwiki/archive',
      'POST /api/v4/projects/firma%2Fteam%2Fwiki/unarchive',
      'DELETE /api/v4/projects/firma%2Fteam%2Fwiki',
    ]);
  });
});
