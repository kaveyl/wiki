import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../db/db.js';
import { git } from '../git/git.js';
import { DEFAULT_RULES } from '../cleanup.js';
import { RepoTrash } from './repo-trash.js';
import { giteaFullName } from './sources.js';

let root: string;
let db: DB;
let server: Server;
let base: string;
const calls: string[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-trash-'));
  db = openDb(':memory:');
  calls.length = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url} ${raw}`.trim());
      if (req.headers.authorization !== 'token t0k') return res.writeHead(401).end();
      if (req.method === 'DELETE') return res.writeHead(204).end();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ full_name: 'mara/test', clone_url: '', archived: JSON.parse(raw || '{}').archived }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('repository trash', () => {
  it('archives for 30 days, restores, and deletes only after a bundle backup', async () => {
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
    await git(root, ['clone', '-q', remote, work]);
    writeFileSync(join(work, 'a.md'), '# A\n');
    await git(work, ['add', '-A']);
    await git(work, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'a']);
    await git(work, ['push', '-q', 'origin', 'HEAD:main']);

    const bundles = join(root, 'bundles');
    const trash = new RepoTrash(db, bundles, () => remote);
    const g = { base, token: 't0k' };
    const now = new Date('2026-10-05T12:00:00Z');
    const entry = await trash.trash(g, 'mara/test', 'admin', now);
    expect(entry.deleteAfter).toBe(new Date(now.getTime() + DEFAULT_RULES.repoTrashDays * 86_400_000).toISOString());
    expect(calls).toEqual(['PATCH /api/v1/repos/mara/test {"archived":true}']);
    expect(trash.due(new Date('2026-11-03T12:00:00Z'))).toEqual([]);
    expect(trash.due(new Date('2026-11-04T12:00:01Z')).map((r) => r.fullName)).toEqual(['mara/test']);

    await trash.restore(g, 'mara/test');
    expect(calls.at(-1)).toBe('PATCH /api/v1/repos/mara/test {"archived":false}');
    expect(trash.list()).toEqual([]);

    await trash.trash(g, 'mara/test', 'admin', now);
    const name = await trash.deleteNow(g, 'mara/test', now);
    expect(name).toMatch(/^mara__test-2026-10-05-\d\d-\d\d-\d\d\.bundle$/);
    expect(calls.at(-1)).toBe('DELETE /api/v1/repos/mara/test');
    expect(trash.list()).toEqual([]);
    const file = join(bundles, name);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The bundle restores the full repository.
    await git(root, ['clone', '-q', file, join(root, 'restored')]);
    expect(existsSync(join(root, 'restored', 'a.md'))).toBe(true);

    utimesSync(file, new Date('2026-08-01'), new Date('2026-08-01'));
    expect(await trash.pruneBundles(new Date('2026-10-05').getTime())).toEqual([name]);
  });

  it('follows the Löschregeln: days counted from archiving, 0 = never; old bundles go after their days', async () => {
    let days = { trash: 30, bundles: 30 };
    const trash = new RepoTrash(db, join(root, 'bundles'), undefined, () => days);
    const now = new Date('2026-10-11T10:00:00Z');
    await trash.trash({ base, token: 't0k' }, 'mara/test', null, now);
    expect(trash.list()[0]!.deleteAfter).toBe('2026-11-10T10:00:00.000Z');
    days = { trash: 5, bundles: 30 };
    // A changed rule also applies to entries already in the trash.
    expect(trash.list()[0]!.deleteAfter).toBe('2026-10-16T10:00:00.000Z');
    expect(trash.due(new Date('2026-10-17T00:00:00Z'))).toHaveLength(1);
    days = { trash: 0, bundles: 0 };
    expect(trash.list()[0]!.deleteAfter).toBe('');
    expect(trash.due(new Date('2030-01-01T00:00:00Z'))).toEqual([]);
    const file = join(root, 'bundles', 'alt.bundle');
    mkdirSync(join(root, 'bundles'), { recursive: true });
    writeFileSync(file, 'x');
    const old = (Date.now() - 100 * 86_400_000) / 1000;
    utimesSync(file, old, old);
    expect(await trash.pruneBundles()).toEqual([]);
    days = { trash: 0, bundles: 30 };
    expect(await trash.pruneBundles()).toEqual(['alt.bundle']);
  });

  it('only accepts owner/repo names on the configured Gitea', async () => {
    const trash = new RepoTrash(db, join(root, 'b'));
    await expect(trash.trash({ base, token: 't0k' }, '../etc', null)).rejects.toThrow(/Ungültiger Repository-Name/);
    for (const bad of ['mara/..', './x', 'a/b/c', 'mara']) await expect(trash.restore({ base, token: 't0k' }, bad)).rejects.toThrow(/Ungültiger Repository-Name/);
    expect(giteaFullName('https://gitea.x', 'https://gitea.x/mara/wiki.git')).toBe('mara/wiki');
    expect(giteaFullName('https://gitea.x', 'https://other.x/mara/wiki.git')).toBeNull();
    // A namesake on another server does not overwrite the trashed entry.
    db.prepare("INSERT INTO repo_trash (full_name, clone_url, archived_at, delete_after, actor, connection_id) VALUES ('mara/wiki', 'https://github.com/mara/wiki.git', 'x', 'y', null, null)").run();
    await expect(trash.trash({ base, token: 't0k' }, 'mara/wiki', null)).rejects.toThrow(/schon „mara\/wiki“ von https:\/\/github.com/);
    expect(calls).toEqual([]);
  });
});
