import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { historyBundle, initVersions } from './versions.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('historyBundle (AD-071)', () => {
  it('backs up the history only of folders whose versions Kaveyl Wiki keeps – a Git of your own stays out (sec-004)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-versions-'));
    const own = join(dir, 'eigen');
    const kept = join(dir, 'versionen');
    for (const d of [own, kept]) {
      execFileSync('mkdir', ['-p', d]);
      writeFileSync(join(d, 'a.md'), '# A\n');
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: own });
    execFileSync('git', ['add', '-A'], { cwd: own });
    execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@x', 'commit', '-q', '-m', 'x'], { cwd: own });
    expect(await historyBundle(own, join(dir, 'eigen.bundle'))).toBe(false);
    expect(existsSync(join(dir, 'eigen.bundle'))).toBe(false);
    await initVersions(kept, { name: 'Anna', email: 'anna@x' });
    expect(await historyBundle(kept, join(dir, 'versionen.bundle'))).toBe(true);
    expect(execFileSync('git', ['config', '--get', 'core.fileMode'], { cwd: kept, encoding: 'utf8' }).trim()).toBe('false');
  });
});
