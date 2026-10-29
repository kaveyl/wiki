// Shutdown (docker stop/restart sends SIGTERM, kills after 10 s): pending edits must be committed
// and pushed, even while a browser is connected (live events, keep-alive requests).
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { git } from './git/git.js';

const EXT_ENV = { GIT_AUTHOR_NAME: 'Ext', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'Ext', GIT_COMMITTER_EMAIL: 'e@x' };
let root: string;
let app: App;
let closed = false;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-shutdown-'));
  closed = false;
});

afterEach(async () => {
  if (!closed) await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('closes within seconds with a browser connected and pushes the last edit first', async () => {
  const remote = join(root, 'remote.git');
  const ext = join(root, 'ext');
  await git(root, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(root, ['clone', '-q', remote, ext]);
  mkdirSync(join(ext, 'docs'), { recursive: true });
  writeFileSync(join(ext, 'docs', 'inbox.md'), '# Inbox\n\nErster Punkt.\n');
  await git(ext, ['add', '-A']);
  await git(ext, ['commit', '-q', '-m', 'init'], { env: EXT_ENV });
  await git(ext, ['push', '-q', 'origin', 'main']);

  // Production-like: commits wait for a pause in editing (no override).
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, commitDelaySec: null, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  await app.server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123' }) });
  const cookie = setup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const mount = await app.manager.create({ name: 'Docs', type: 'remote', source: remote, branch: 'main', subpath: 'docs' });

  // A browser: live events over a websocket, and an edit.
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events`, { headers: { cookie } });
  await new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject)));
  const note = (await (await fetch(`${base}/api/notes/${mount.id}/inbox.md`, { headers: { cookie } })).json()) as { hash: string };
  const saved = await fetch(`${base}/api/notes/${mount.id}/inbox.md`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: '# Inbox\n\nErster Punkt. (Neustart-Test)\n', baseHash: note.hash }),
  });
  expect(saved.status).toBe(200);

  const started = Date.now();
  await app.close();
  closed = true;
  expect(Date.now() - started).toBeLessThan(5000);
  ws.terminate();
  const pushed = await git(root, ['--git-dir', remote, 'show', 'main:docs/inbox.md']);
  expect(pushed).toContain('(Neustart-Test)');
}, 30_000);
