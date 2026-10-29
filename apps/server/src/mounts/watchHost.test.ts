// The watcher process (AD-054) seen from a process that does nothing else – like the server at start-up, which awaits
// its subscriptions before it listens. Dev 21.10.: the IPC channel was unref'd, nothing kept the event loop alive
// and Node ended with „unsettled top-level await“ (restart loop).
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

it('a subscription keeps the process alive until the watcher process answers; afterwards it may end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-watchhost-'));
  try {
    const host = pathToFileURL(join(import.meta.dirname, 'watchHost.ts')).href;
    const script = `const { subscribe } = await import(${JSON.stringify(host)});
const s = await subscribe(${JSON.stringify(dir)}, () => {});
console.log('abonniert');
await s.unsubscribe();
console.log('fertig');`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 15_000 });
    // Ends by itself (the test would time out otherwise) – the idle watcher process never holds the server.
    expect(stdout.trim().split('\n')).toEqual(['abonniert', 'fertig']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
