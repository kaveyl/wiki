import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { fileReferences } from './fileRefs.js';
import { PARSE_LIMIT } from './pool.js';

// A note over 256 KB is never parsed on the server (sec-006, owner 29.10.): no editor document, its links do not count.
let root: string;
let app: App;
let cookie: string;
let mountId: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-mdlimit-'));
  const wiki = join(root, 'projekte', 'wiki');
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, 'ziel.md'), '# Ziel\n');
  writeFileSync(join(wiki, 'klein.md'), '# Klein\n\n[Ziel](ziel.md)\n');
  mkdirSync(join(wiki, 'assets'));
  writeFileSync(join(wiki, 'assets', 'bild.png'), Buffer.from([1, 2, 3]));
  writeFileSync(join(wiki, 'gross.md'), `# Groß\n\n[Ziel](ziel.md) ![Bild](assets/bild.png)\n\n${'Viel Text in einem Absatz. '.repeat(Math.ceil(PARSE_LIMIT / 27))}\n`);
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  const res = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' } });
  cookie = `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
  const m = await app.server.inject({ method: 'POST', url: '/api/mounts', payload: JSON.stringify({ type: 'local', source: wiki, name: 'Wiki' }), headers: { 'content-type': 'application/json', cookie } });
  mountId = m.json().id;
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string) => app.server.inject({ method: 'GET', url, headers: { cookie } });

describe('notes over 256 KB on the server', () => {
  it('have no editor document, their links do not count, the editor cannot save them, the export shows the text', async () => {
    const small = (await get(`/api/notes/${mountId}/klein.md`)).json();
    expect(small.doc.content[0]).toMatchObject({ type: 'heading' });
    const big = (await get(`/api/notes/${mountId}/gross.md`)).json();
    expect(big.doc).toBeNull();
    expect(big.raw.length).toBeGreaterThan(PARSE_LIMIT);
    expect((await get(`/api/backlinks/${mountId}/ziel.md`)).json().map((b: { path: string }) => b.path)).toEqual(['klein.md']);
    const save = await app.server.inject({
      method: 'PUT',
      url: `/api/notes/${mountId}/gross.md`,
      payload: JSON.stringify({ doc: small.doc, baseHash: big.hash }),
      headers: { 'content-type': 'application/json', cookie },
    });
    expect([save.statusCode, save.json().error]).toEqual([400, expect.stringMatching(/zu groß oder zu verschachtelt/)]);
    const html = (await get(`/api/export/${mountId}/gross.md`)).body;
    expect(html).toContain('<pre class="unparsed">');
    // Saved as Markdown source it works as always.
    const raw = await app.server.inject({
      method: 'PUT',
      url: `/api/notes/${mountId}/gross.md`,
      payload: JSON.stringify({ raw: `${big.raw}\nNoch ein Satz.\n`, baseHash: big.hash }),
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(raw.statusCode, raw.body).toBe(200);
  });

  it('still count the files they show: a picture they use is never deleted as unused (code-001 0.2.7)', async () => {
    // „klein.md“ gives up the picture (encrypting does it this way); „gross.md“ still shows it.
    const del = await app.server.inject({
      method: 'DELETE',
      url: `/api/attachments/${mountId}/assets/bild.png?unlessLinkedBy=klein.md`,
      payload: '{}',
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(del.json()).toMatchObject({ ok: true, kept: true });
    expect((await get(`/api/attachments/${mountId}/gross.md`)).json().map((a: { path: string }) => a.path)).toEqual(['assets/bild.png']);
  });

  it('find file addresses without the parser in linear time', () => {
    expect(fileReferences('![a](assets/a.png) [b](b.md) [c](https://x.y/c.pdf) <img src="x/y.png" width="3">\n[d]: ./d.pdf\n[e](#top)')).toEqual(['assets/a.png', 'x/y.png', './d.pdf']);
    const started = Date.now();
    fileReferences(`${'](a '.repeat(64 * 1024)}${'<img '.repeat(50_000)}${'[x'.repeat(50_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
