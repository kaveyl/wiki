// Outside changes reach the index even while the app keeps saving another note: the watcher's
// debounce (300 ms of quiet) used to be postponed by every app save, for as long as typing went on.
import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

it('indexes a file written from outside within seconds during steady app saves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-watch-'));
  const notes = join(root, 'projekte', 'n');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'a.md'), '# A\n');
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 1, webRoot: join(root, 'x') };
  const app = await buildApp(config, { logger: false, nightlyFsck: false });
  try {
    await app.manager.start();
    const setup = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'a@example.test', password: 'Sehr-geheim-Passwort-123' } });
    const cookie = `kw_session=${setup.cookies.find((c) => c.name === 'kw_session')!.value}`;
    const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.server.inject({ method, url, payload, headers: { cookie } });
    const mount = (await inject('POST', '/api/mounts', { type: 'local', source: notes, name: 'N' })).json() as { id: string };
    // Someone typing: a save every ~100 ms.
    let typing = true;
    const saver = (async () => {
      for (let i = 0; typing; i++) {
        const cur = (await inject('GET', `/api/notes/${mount.id}/a.md`)).json() as { hash: string };
        await inject('PUT', `/api/notes/${mount.id}/a.md`, { raw: `# A\n\n${i}\n`, baseHash: cur.hash });
        await new Promise((r) => setTimeout(r, 80));
      }
    })();
    for (const name of ['von-aussen-1.md', 'von-aussen-2.md']) {
      writeFileSync(join(notes, name), '# Von außen\n');
      await expect
        .poll(async () => JSON.stringify((await inject('GET', `/api/tree/${mount.id}`)).json()).includes(`"${name}"`), { timeout: 4000, interval: 100 })
        .toBe(true);
    }
    typing = false;
    await saver;
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
