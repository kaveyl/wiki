import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git/git.js';
import { PathError } from './model.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertInRoots, browseLocal, insideRepo, createGiteaRepo, GiteaError, listBranches, listGiteaOwners, markdownTree, selectionToGlobs } from './sources.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-src-'));
  for (const [p, c] of Object.entries({ 'docs/a.md': '#', 'docs/sub/b.md': '#', 'src/x.ts': '', 'README.md': '#', '.hidden/c.md': '#' })) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('mount wizard helpers', () => {
  it('builds a Markdown-only tree without empty or hidden folders', async () => {
    const tree = await markdownTree(root);
    expect(tree.notes).toBe(3);
    expect(tree.children!.map((c) => `${c.kind}:${c.path}:${c.notes}`)).toEqual(['dir:docs:2', 'file:README.md:1']);
  });

  it('turns a checkbox selection into globs', () => {
    expect(selectionToGlobs([])).toEqual(['**']);
    expect(selectionToGlobs([{ path: '', kind: 'dir' }])).toEqual(['**']);
    expect(
      selectionToGlobs([
        { path: 'docs', kind: 'dir' },
        { path: 'docs/sub/b.md', kind: 'file' },
        { path: 'README.md', kind: 'file' },
      ]),
    ).toEqual(['README.md', 'docs/**']);
  });

  it('lists branches of a repository', async () => {
    const bare = join(root, 'r.git');
    const work = join(root, 'w');
    await git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    await git(root, ['clone', '-q', bare, work]);
    writeFileSync(join(work, 'f.md'), '#');
    const env = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'x'], { env });
    await git(work, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:kaveyl-wiki-test']);
    expect(await listBranches(bare, {})).toEqual(['kaveyl-wiki-test', 'main']);
  });

  it('browses only inside the allowed roots', async () => {
    expect(() => assertInRoots([root], '/etc')).toThrow(PathError);
    expect(() => assertInRoots([root], join(root, '..'))).toThrow(PathError);
    const listing = await browseLocal([root], root);
    expect(listing.dirs.map((d) => d.name)).toEqual(['docs', 'src']);
    expect(listing.isRepo).toBe(false);
    // Roots that are not mounted (e.g. /docs without a volume) are not offered at all; mounted ones say whether the app can write.
    expect((await browseLocal([root, join(root, 'nicht-eingehaengt')], null)).dirs).toEqual([{ name: root, path: root, isRepo: false, writable: true }]);
  });

  it('a folder inside a Git work tree counts as Git — but never looking beyond its local root', () => {
    const docs = join(root, 'docs');
    expect(insideRepo(docs, [root])).toBe(false);
    mkdirSync(join(root, '.git'));
    expect(insideRepo(docs, [root])).toBe(true);
    // The root itself is a subfolder of that repository: above the root does not count.
    expect(insideRepo(docs, [docs])).toBe(false);
    expect(insideRepo(docs)).toBe(false);
  });
});

describe('Gitea: owners and new repositories (fake Gitea, never the real one)', () => {
  let server: Server;
  let base: string;
  const created: { path: string; auth?: string; body: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    created.length = 0;
    server = createServer((req, res) => {
      const send = (code: number, body: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers.authorization !== 'token t0k') return send(401, {});
      if (req.method === 'GET' && req.url === '/api/v1/user') return send(200, { login: 'mara' });
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/user/orgs')) return send(200, [{ username: 'team' }]);
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        if (body.name === 'vergeben') return send(409, {});
        created.push({ path: req.url!, auth: req.headers.authorization, body });
        const owner = req.url!.startsWith('/api/v1/orgs/') ? req.url!.split('/')[4] : 'mara';
        send(201, { full_name: `${owner}/${String(body.name)}`, clone_url: `${base}/${owner}/${String(body.name)}.git`, default_branch: 'main', private: body.private });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('lists the token user and its organisations', async () => {
    expect(await listGiteaOwners(base, 't0k')).toEqual([
      { name: 'mara', kind: 'user' },
      { name: 'team', kind: 'org' },
    ]);
  });

  it('creates a private repo with README on main, for the user or an organisation', async () => {
    const mine = await createGiteaRepo(base, 't0k', { owner: { name: 'mara', kind: 'user' }, name: 'notizen', private: true });
    expect(mine).toMatchObject({ fullName: 'mara/notizen', defaultBranch: 'main', private: true });
    await createGiteaRepo(base, 't0k', { owner: { name: 'team', kind: 'org' }, name: 'wiki', description: ' Team ', private: false });
    expect(created.map((c) => c.path)).toEqual(['/api/v1/user/repos', '/api/v1/orgs/team/repos']);
    expect(created[0]!.body).toMatchObject({ auto_init: true, default_branch: 'main', readme: 'Default', private: true });
    expect(created[1]!.body).toMatchObject({ description: 'Team', private: false });
  });

  it('rejects bad names locally and reports a taken name', async () => {
    await expect(createGiteaRepo(base, 't0k', { owner: { name: 'mara', kind: 'user' }, name: 'a/b', private: true })).rejects.toBeInstanceOf(PathError);
    await expect(createGiteaRepo(base, 't0k', { owner: { name: 'mara', kind: 'user' }, name: '.x', private: true })).rejects.toBeInstanceOf(PathError);
    const err = await createGiteaRepo(base, 't0k', { owner: { name: 'mara', kind: 'user' }, name: 'vergeben', private: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GiteaError);
    expect((err as GiteaError).status).toBe(409);
    expect(created).toHaveLength(0);
  });
});
