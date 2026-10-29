import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, gitInvocation, GitTimeoutError, UnsafeRepoError } from './git.js';

describe('git invocation', () => {
  it('never puts the token on the command line (visible in ps), only in the environment', () => {
    const call = gitInvocation(['fetch', 'origin'], { authorization: 'token GEHEIM123' });
    expect(call.args.join(' ')).not.toContain('GEHEIM123');
    expect(call.env).toMatchObject({ GIT_CONFIG_COUNT: '6', GIT_CONFIG_KEY_5: 'http.extraHeader', GIT_CONFIG_VALUE_5: 'Authorization: token GEHEIM123', GIT_TERMINAL_PROMPT: '0' });
    expect(JSON.stringify(gitInvocation(['status']).env)).not.toContain('http.extraHeader');
  });

  it('every call: folders of another owner are accepted, but no hook or monitor of the repository runs (AD-071)', async () => {
    expect(gitInvocation(['status']).env).toMatchObject({
      GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'core.fsmonitor', GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'commit.gpgSign', GIT_CONFIG_VALUE_3: 'false',
    });
    const dir = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-hook-'));
    try {
      await git(dir, ['init', '-q', '-b', 'main']);
      const { writeFile, chmod, stat } = await import('node:fs/promises');
      await writeFile(join(dir, '.git/hooks/post-commit'), `#!/bin/sh\ntouch "${join(dir, 'HOOK-RAN')}"\n`);
      await chmod(join(dir, '.git/hooks/post-commit'), 0o755);
      await writeFile(join(dir, 'a.md'), '# A\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-q', '-m', 'x'], { env: { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' } });
      expect(await stat(join(dir, 'HOOK-RAN')).catch(() => null)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a repository whose own config could start a program (filter, textconv, include …) is refused until the entry is gone (sec-001)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-cfg-'));
    const { writeFile, stat } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    const id = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' };
    try {
      await git(dir, ['init', '-q', '-b', 'main']);
      await writeFile(join(dir, 'a.md'), '# A\n');
      await git(dir, ['add', '-A']);
      // Written by someone with access to the shared folder, not through Kaveyl Wiki (plain git, no wrapper).
      for (const [key, value] of [['filter.boese.clean', `touch ${join(dir, 'RAN')}; cat`], ['include.path', '/tmp/x'], ['diff.bild.textconv', 'touch RAN'], ['core.worktree', '/config']] as [string, string][]) {
        execFileSync('git', ['config', key, value], { cwd: dir });
        if (key.startsWith('filter')) await writeFile(join(dir, '.gitattributes'), '*.md filter=boese\n');
        const err = await git(dir, ['add', '-A']).catch((e: unknown) => e);
        expect(err, key).toBeInstanceOf(UnsafeRepoError);
        expect((err as Error).message).toContain(key.toLowerCase());
        execFileSync('git', ['config', '--unset', key], { cwd: dir });
      }
      expect(await stat(join(dir, 'RAN')).catch(() => null)).toBeNull();
      // A `.git` file pointing to another directory: that one's settings count – checked anew on every call.
      const other = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-cfg2-'));
      try {
        execFileSync('git', ['init', '-q', '--bare', other]);
        execFileSync('git', ['config', '--file', join(other, 'config'), 'filter.boese.clean', 'touch RAN']);
        await git(dir, ['status']);
        await rm(join(dir, '.git'), { recursive: true });
        await writeFile(join(dir, '.git'), `gitdir: ${other}\n`);
        expect(await git(dir, ['status']).catch((e: unknown) => e)).toBeInstanceOf(UnsafeRepoError);
      } finally {
        await rm(other, { recursive: true, force: true });
      }
      await rm(join(dir, '.git'), { force: true });
      await git(dir, ['init', '-q', '-b', 'main']);
      // Signing asked for by the repository is switched off, not refused.
      execFileSync('git', ['config', 'commit.gpgSign', 'true'], { cwd: dir });
      execFileSync('git', ['config', 'gpg.program', `touch ${join(dir, 'RAN')}`], { cwd: dir });
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-q', '-m', 'x'], { env: id });
      expect(await stat(join(dir, 'RAN')).catch(() => null)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reading commands take no optional index lock (a parallel commit failed with index.lock exists)', () => {
    expect(gitInvocation(['status', '--porcelain']).env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('drops git config inherited from the server environment (would send a token to any remote)', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: token FREMD', GIT_CONFIG_PARAMETERS: "'x.y=z'" });
    try {
      const env = gitInvocation(['fetch']).env;
      expect(JSON.stringify(env)).not.toContain('FREMD');
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env.GIT_CONFIG_COUNT).toBe('5');
      expect(JSON.stringify(gitInvocation(['fetch'], { authorization: 'token EIGEN' }).env)).not.toContain('FREMD');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    }
  });

  it('network commands stop stalled HTTP transfers (low speed limit), local ones are left alone', () => {
    for (const cmd of ['fetch', 'push', 'clone', 'ls-remote']) expect(gitInvocation([cmd]).env).toMatchObject({ GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' });
    expect(gitInvocation(['status']).env.GIT_HTTP_LOW_SPEED_LIMIT).toBeUndefined();
  });

  it('a git server that accepts and never answers ends in a time-limit error and frees the queue', async () => {
    const sockets: Socket[] = [];
    const server = createServer((s) => void sockets.push(s)).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-timeout-'));
    try {
      const started = Date.now();
      // Same chaining as the per-repository queue (`serial`): the next job runs once the hung one gave up.
      const hung = git(dir, ['ls-remote', '--heads', '--', `http://127.0.0.1:${port}/x.git`], { timeoutMs: 300 });
      const next = hung.then(
        () => 'resolved',
        () => 'next job runs',
      );
      const err = await hung.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitTimeoutError);
      expect((err as Error).message).toMatch(/^Git-Server antwortet nicht – git ls-remote nach \d+ s abgebrochen \(Zeitlimit\)$/);
      expect(await next).toBe('next job runs');
      expect(Date.now() - started).toBeLessThan(8000);
      expect(await git(dir, ['--version'])).toMatch(/^git version/);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
