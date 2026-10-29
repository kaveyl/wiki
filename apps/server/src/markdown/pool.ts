// Markdown on the server in child processes with a time and memory limit (sec-006 of the review of 0.2.6). micromark,
// remark's parser, is quadratic for nested lists (64 KB of „1. 1. a“ lines ≈ 12 s, 256 KB ≈ 3 min; a three-level list
// of 256 KB ≈ 10 s) and, with GFM, for many `]` in one paragraph (128 KB of `a] ` ≈ 30 s); deep nesting needs hundreds
// of MB (40 KB of `> > >` > 256 MB). Parsed in the main thread, one note from anyone who may write would stall the
// server for everyone; in a worker thread, running out of memory still ends the whole process. So: notes over 256 KB
// are not parsed at all (owner 29.10.), the rest in a child process with 10 s and 256 MB per note (a slow NAS needs
// seconds for a large ordinary note); opening and saving go ahead of background work. What takes longer, runs out of
// memory or overflows counts as not parsed: its links to notes do not count (its files do, fileRefs.ts), the editor
// shows it as Markdown source, and it is not tried again while its text stays the same. Unbundled (unit tests) the jobs run in the process;
// so they do when the child cannot start (said in the log) – never „every note unparsed“.
// SEE-DOC: HANDBOOK.md Stolperfallen „Markdown-Parser quadratisch“

import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalLink, PMNode } from '@kaveyl-wiki/core';
import type { Root } from 'mdast';
import { runJob, type Job, type JobResult } from './jobs.js';

/** Notes larger than this are never parsed on the server (characters ≈ bytes). */
export const PARSE_LIMIT = 256 * 1024;

/** Next to the bundle (dist/markdown-worker.mjs, in the image /app/markdown-worker.mjs). */
export const BUNDLED_MARKDOWN_WORKER = join(dirname(fileURLToPath(import.meta.url)), 'markdown-worker.mjs');

interface Pending {
  id: number;
  job: Job;
  urgent?: boolean;
  resolve(value: unknown): void;
}

interface Slot {
  child: ChildProcess | null;
  /** The child said it is ready (it started) – a death after that is a job's, never a reason to parse in the process. */
  ready: boolean;
  current: (Pending & { timer: NodeJS.Timeout }) | null;
}

export interface PoolOptions {
  /** The script of the child; default the bundled one if there is one, else the jobs run in the process. */
  worker?: string | null;
  size?: number;
  timeoutMs?: number;
  memoryMb?: number;
}

const GAVE_UP = Symbol('gave up');
/** The child could not start: run the job in the process instead. */
const IN_PROCESS = Symbol('in process');

export class MarkdownPool {
  private script: string | null;
  private readonly slots: Slot[];
  private readonly queue: Pending[] = [];
  /** Texts the parser gave up on – not tried again (by hash, the newest few hundred). */
  private readonly hopeless = new Set<string>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly opts: PoolOptions = {}) {
    this.script = opts.worker === undefined ? (existsSync(BUNDLED_MARKDOWN_WORKER) ? BUNDLED_MARKDOWN_WORKER : null) : opts.worker;
    this.slots = Array.from({ length: opts.size ?? 2 }, () => ({ child: null, ready: false, current: null }));
  }

  /** Local links, images and definitions (core extractLinks); null = not parsed. */
  links(raw: string): Promise<LocalLink[] | null> {
    return this.run({ op: 'links', raw }, raw);
  }

  /** The editor document (core loadMarkdown); null = not parsed. */
  doc(raw: string): Promise<PMNode | null> {
    return this.run({ op: 'doc', raw }, raw, true);
  }

  /** `raw` with the editor's document written into it (core saveMarkdown); null = not parsed. */
  save(raw: string, doc: PMNode): Promise<string | null> {
    return this.run({ op: 'save', raw, doc }, raw, true);
  }

  /** The mdast tree of a note body; null = not parsed. */
  tree(body: string): Promise<Root | null> {
    return this.run({ op: 'tree', body }, body);
  }

  /** `urgent`: someone waits for it (opening, saving) – ahead of background work like rebuilding the index. */
  private async run<O extends Job['op']>(job: Job & { op: O }, text: string, urgent = false): Promise<JobResult[O] | null> {
    if (text.length > PARSE_LIMIT) return null;
    const key = createHash('sha1').update(text).digest('base64');
    if (this.hopeless.has(key)) return null;
    if (!this.script || this.closed) {
      try {
        return runJob(job) as JobResult[O];
      } catch {
        return null;
      }
    }
    const value = await new Promise<unknown>((resolve) => {
      const pending = { id: this.nextId++, job, resolve };
      // Urgent ones in their own order, before the first one that is not.
      const at = urgent ? this.queue.findIndex((p) => !p.urgent) : -1;
      if (at >= 0) this.queue.splice(at, 0, { ...pending, urgent });
      else this.queue.push({ ...pending, urgent });
      this.dispatch();
    });
    if (value === IN_PROCESS) return this.run(job, text, urgent);
    if (value === GAVE_UP) {
      if (this.hopeless.size >= 500) this.hopeless.delete(this.hopeless.values().next().value!);
      this.hopeless.add(key);
      return null;
    }
    return value as JobResult[O] | null;
  }

  private dispatch() {
    if (!this.script) {
      for (const p of this.queue.splice(0)) p.resolve(IN_PROCESS);
      return;
    }
    for (const slot of this.slots) {
      if (slot.current || !this.queue.length) continue;
      const next = this.queue.shift()!;
      const child = (slot.child ??= this.spawn(slot));
      const timer = setTimeout(() => this.finish(slot, GAVE_UP, true), this.opts.timeoutMs ?? 10_000);
      timer.unref();
      slot.current = { ...next, timer };
      this.idle(child, false);
      child.send({ id: next.id, job: next.job });
    }
  }

  private spawn(slot: Slot): ChildProcess {
    // `advanced`: structured clone like a worker thread (the trees are plain objects); its output goes to the server's.
    const child = fork(this.script!, [], {
      execArgv: [`--max-old-space-size=${this.opts.memoryMb ?? 256}`],
      // It needs nothing of the server's environment (KAVEYL_WIKI_SECRET_KEY and the like stay out).
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    slot.ready = false;
    child.on('message', (m: { ready?: true; id: number; ok: boolean; value?: unknown }) => {
      if (m.ready) {
        slot.ready = true;
        return;
      }
      if (slot.current?.id === m.id) this.finish(slot, m.ok ? m.value : null, false);
    });
    child.on('error', (e) => this.lost(slot, child, e.message));
    // Out of memory or killed: only this note, the next one gets a fresh child.
    child.on('exit', (code, signal) => this.lost(slot, child, `exit ${code ?? signal}`));
    // Idle, it keeps nobody alive (tests, shutdown); while it works, the job's own promise does.
    this.idle(child, true);
    return child;
  }

  /** An idle child must not keep the server process running; a busy one may. */
  private idle(child: ChildProcess, idle: boolean) {
    const channel = child.channel as { ref?: () => void; unref?: () => void } | null | undefined;
    if (idle) {
      child.unref();
      channel?.unref?.();
    } else {
      child.ref();
      channel?.ref?.();
    }
  }

  /** The child ended (or never started): a job it had gives up; one that never said it is ready means: no child at all. */
  private lost(slot: Slot, child: ChildProcess, why: string) {
    if (slot.child !== child) return;
    slot.child = null;
    if (!slot.ready && !this.closed) {
      console.error(`markdown worker did not start, parsing in the process: ${why}`);
      this.script = null;
      const job = slot.current;
      slot.current = null;
      if (job) {
        clearTimeout(job.timer);
        job.resolve(IN_PROCESS);
      }
      this.dispatch();
      return;
    }
    this.finish(slot, GAVE_UP, false);
  }

  private finish(slot: Slot, value: unknown, kill: boolean) {
    const done = slot.current;
    if (!done) return;
    clearTimeout(done.timer);
    slot.current = null;
    if (kill && slot.child) {
      const c = slot.child;
      slot.child = null;
      c.kill('SIGKILL');
    } else if (slot.child) this.idle(slot.child, true);
    done.resolve(value);
    if (!this.closed) this.dispatch();
  }

  /** Ends the children (tests); what was waiting counts as not parsed, later jobs run in the process. */
  async close() {
    this.closed = true;
    for (const slot of this.slots) {
      if (slot.current) this.finish(slot, null, false);
      const c = slot.child;
      slot.child = null;
      c?.kill('SIGKILL');
    }
    for (const p of this.queue.splice(0)) p.resolve(null);
  }
}

/** The one pool of the server process. */
export const markdown = new MarkdownPool();
