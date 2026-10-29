// Thin wrapper around the system `git` CLI.
// Credentials are passed per invocation as http.extraHeader via GIT_CONFIG_* environment
// variables (not visible in `ps`), never written to .git/config or the remote URL
// (other users of the machine could read a command line with ps). Error messages never include the header.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

export interface GitOptions {
  /** Value for the HTTP Authorization header, e.g. `token <secret>`. Never logged. */
  authorization?: string;
  /** Extra environment (e.g. GIT_AUTHOR_NAME). */
  env?: Record<string, string>;
  /** Non-zero exit codes that still count as success (e.g. 1 for `diff` with differences). */
  okCodes?: number[];
  /** Hard time limit in ms (0 = none). Default: only network commands, see networkTimeout(). */
  timeoutMs?: number;
}

/** Commands that talk to a remote; only these get a time limit (a hung server blocks the repository queue). */
const NETWORK = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote']);

/**
 * Hard limit per network command. The low speed limit (gitInvocation) already ends stalled HTTP
 * transfers after a minute; this one also covers what it misses (connect/TLS hang, SSH remotes, a
 * trickle above 1 KB/s). A wiki fetch/push is incremental: 2 min is generous. A clone carries the
 * whole history: 5 min.
 */
export function networkTimeout(args: string[]): number {
  if (!NETWORK.has(args[0] ?? '')) return 0;
  return args[0] === 'clone' ? 5 * 60_000 : 2 * 60_000;
}

/** Grace period between SIGTERM and SIGKILL when a git call ran out of time. */
const KILL_GRACE_MS = 5_000;

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
  }
}

/** A git call that ran out of time and was stopped (server not answering). */
export class GitTimeoutError extends GitError {
  constructor(args: string[], ms: number) {
    super(args, null, '');
    this.message = `Git-Server antwortet nicht – git ${args[0]} nach ${Math.max(1, Math.round(ms / 1000))} s abgebrochen (Zeitlimit)`;
  }
}

/**
 * Set for every git call (AD-071). Local folders under /docs may belong to another user than the app (NAS shares):
 * git would refuse them („dubious ownership“) – the admin chose them, so every folder counts as safe. In exchange
 * nothing from a repository's own configuration may start a program: no hooks, no file-system monitor.
 */
const HARDENING: [string, string][] = [
  ['safe.directory', '*'],
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['commit.gpgSign', 'false'],
  ['tag.gpgSign', 'false'],
];

/**
 * Entries of a repository's own configuration that make git start a program or look elsewhere – named freely, so the
 * environment cannot switch them off. Whoever may write into a shared folder could put them into its `.git/config`;
 * git does not run there while one of them is set (UnsafeRepoError).
 */
const RISKY = /^(include|includeif|filter)\.|^diff\.(external|[^.]+\.(textconv|command))$|^merge\.[^.]+\.driver$|^core\.(worktree|alternaterefscommand|sshcommand|gitproxy|askpass)$|^extensions\.worktreeconfig$/;

/** git refuses to work in a repository whose own configuration could start a program (see RISKY). */
export class UnsafeRepoError extends Error {
  constructor(
    readonly dir: string,
    readonly keys: string[],
  ) {
    super(
      keys.length
        ? `Die Git-Einstellungen dieses Ordners enthalten ${keys.map((k) => `„${k}“`).join(', ')} – damit könnte Git Programme starten. Kaveyl Wiki arbeitet dort nicht mit Git, bis der Eintrag entfernt ist.`
        : 'Die Git-Einstellungen dieses Ordners lassen sich nicht lesen – Kaveyl Wiki arbeitet dort nicht mit Git, bis das geklärt ist.',
    );
  }
}

/** Config files whose content was found safe (by content: a date or size can be set back over a share). */
const safeConfig = new Map<string, string>();

function rawGit(cwd: string, args: string[], input?: Buffer): Promise<string | null> {
  return new Promise((done) => {
    const child = execFile('git', args, { cwd, env: gitInvocation(args).env }, (error, stdout) => done(error ? null : stdout));
    if (input) child.stdin?.end(input);
  });
}

/**
 * Checks the own configuration of the repository at `cwd` (if any) before git runs there. Where it lies is asked anew
 * every time – a `.git` file pointing elsewhere must not lead past the check; one that cannot be read counts as unsafe.
 */
async function assertSafeRepo(cwd: string): Promise<void> {
  const dir = (await rawGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!dir) return; // not (yet) a repository
  const config = resolvePath(dir, 'config');
  let text: Buffer;
  try {
    text = await readFile(config);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // no own settings
    throw new UnsafeRepoError(cwd, []);
  }
  const stamp = createHash('sha256').update(text).digest('hex');
  if (safeConfig.get(config) === stamp) return;
  // Exactly the bytes hashed above – a file swapped in between must not be remembered as safe.
  const names = await rawGit(cwd, ['config', '--file', '-', '--no-includes', '--name-only', '--list'], text);
  if (names === null) throw new UnsafeRepoError(cwd, []);
  const risky = names.split('\n').map((n) => n.trim().toLowerCase()).filter((n) => n && RISKY.test(n));
  if (risky.length) throw new UnsafeRepoError(cwd, [...new Set(risky)]);
  safeConfig.set(config, stamp);
}

/**
 * Arguments and environment for one git call. The Authorization header goes in through
 * GIT_CONFIG_* environment variables, not `-c` arguments: command lines are visible to
 * every user on the host (`ps`), a process environment only to the same user and root.
 */
export function gitInvocation(args: string[], options: GitOptions = {}): { args: string[]; env: Record<string, string | undefined> } {
  const pairs = [...HARDENING, ...(options.authorization ? [['http.extraHeader', `Authorization: ${options.authorization}`]] : [])];
  const config: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => Object.assign(config, { [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value }));
  // Config injected through the environment of the server process (e.g. a shell that exported
  // a token this way) must never reach git calls for other remotes: drop it, set only our own.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k)));
  // GIT_OPTIONAL_LOCKS=0: reading commands (`git status` of the sync indicator runs outside the
  // per-repository queue) must not take index.lock — it made a parallel commit fail.
  // Network commands: abort an HTTP transfer that stays below 1000 B/s for 60 s (environment, like the header).
  const slow = NETWORK.has(args[0] ?? '') ? { GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60' } : {};
  return { args, env: { ...inherited, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...slow, ...options.env, ...config } };
}

export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  await assertSafeRepo(cwd);
  const call = gitInvocation(args, options);
  const limit = options.timeoutMs ?? networkTimeout(args);
  if (limit > 0) return gitLimited(cwd, call, options, limit);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      call.args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: call.env,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : null;
        if (error && !(code !== null && options.okCodes?.includes(code))) reject(new GitError(args, code, stderr));
        else resolve(stdout);
      },
    );
  });
}

/**
 * git() with a hard time limit. Runs in its own process group (execFile cannot): the remote helper
 * (git-remote-https) survives a killed git, keeps stderr open and the call waiting — so the whole
 * group gets SIGTERM, then SIGKILL.
 */
function gitLimited(cwd: string, call: ReturnType<typeof gitInvocation>, options: GitOptions, limit: number): Promise<string> {
  const { args } = call;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: call.env, detached: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // group already gone
      }
    };
    const stop = (e: Error) => {
      if (failure) return;
      failure = e;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop(new GitTimeoutError(args, limit)), limit);
    timer.unref();
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) stop(new GitError(args, null, 'stdout maxBuffer length exceeded'));
      else out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => void err.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new GitError(args, null, e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 && !(code !== null && options.okCodes?.includes(code))) reject(new GitError(args, code, Buffer.concat(err).toString()));
      else resolve(Buffer.concat(out).toString());
    });
  });
}

/** Like git(), but stdout as bytes (file contents from history: images, attachments). */
export async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  await assertSafeRepo(cwd);
  const call = gitInvocation(args);
  return new Promise((resolve, reject) => {
    execFile('git', call.args, { cwd, maxBuffer: 256 * 1024 * 1024, env: call.env, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new GitError(args, typeof error.code === 'number' ? error.code : null, String(stderr)));
      else resolve(stdout);
    });
  });
}

/** Runs git and returns false instead of throwing on a non-zero exit code. */
export async function gitOk(cwd: string, args: string[], options: GitOptions = {}): Promise<boolean> {
  try {
    await git(cwd, args, options);
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}
