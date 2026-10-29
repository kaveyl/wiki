// What changed in the sources, and who did it (agents, „Beobachten“, event webhooks – AD-066).
// Every change the index sees lands here once: from the app, REST, MCP (with the person behind it) and from outside
// (watcher, Git sync – no person). In memory only, as a ring buffer: a consumer keeps its cursor and asks for what came
// after it. A cursor of another server start, or one that fell out of the buffer, gets `reset` – the consumer then
// looks at the sources itself once (nothing is lost silently).
import { randomBytes } from 'node:crypto';
import type { IndexChange } from './index/indexer.js';
import type { Author } from './git/sync.js';

export type ChangeVia = 'app' | 'api' | 'mcp' | 'extern';
export type ChangeKind = 'created' | 'changed' | 'deleted' | 'moved';

export interface Change {
  seq: number;
  at: string;
  mountId: string;
  /** Mount-relative path (the new one for a move). */
  path: string;
  kind: ChangeKind;
  /** Old path of a move. */
  from?: string;
  /** The person behind it (as the server knows it – not what someone typed); null from outside (Git, other programs). */
  by: { id: string; name: string } | null;
  via: ChangeVia;
}

export interface ChangePage {
  cursor: string;
  /** The cursor was from an earlier server start or too old: look at the sources once, then go on from `cursor`. */
  reset: boolean;
  changes: Change[];
}

/** Changes kept for consumers that ask from time to time. */
const KEEP = 5000;

export class ChangeFeed {
  private readonly boot = randomBytes(4).toString('hex');
  private seq = 0;
  private readonly buffer: Change[] = [];
  private readonly listeners = new Set<(changes: Change[]) => void>();

  constructor(private readonly max = KEEP) {}

  /** Records what the index saw change in a mount; `by` is the commit author of an app edit, null from outside. */
  record(mountId: string, change: IndexChange, by: Author | null): Change[] {
    const at = new Date().toISOString();
    const who = by?.userId ? { id: by.userId, name: by.name } : null;
    const via: ChangeVia = by ? (by.via ?? 'app') : 'extern';
    const out: Change[] = [];
    const push = (path: string, kind: ChangeKind, from?: string) => out.push({ seq: ++this.seq, at, mountId, path, kind, ...(from ? { from } : {}), by: who, via });
    for (const p of change.added) push(p, 'created');
    for (const p of change.updated) push(p, 'changed');
    for (const p of change.removed) push(p, 'deleted');
    for (const r of change.renamed) push(r.to, 'moved', r.from);
    if (!out.length) return out;
    this.buffer.push(...out);
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
    for (const fn of this.listeners) {
      try {
        fn(out);
      } catch {
        // A consumer's fault never stops saving.
      }
    }
    return out;
  }

  cursor(): string {
    return `${this.boot}-${this.seq}`;
  }

  /** Changes after `cursor` that pass `keep`; without a cursor only the current one (the starting point). */
  since(cursor: string | undefined, keep: (c: Change) => boolean): ChangePage {
    if (!cursor) return { cursor: this.cursor(), reset: false, changes: [] };
    const [boot, n] = cursor.split('-');
    const after = Number(n);
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (boot !== this.boot || !Number.isInteger(after) || after < 0 || after > this.seq) return { cursor: this.cursor(), reset: true, changes: [] };
    const lost = after < oldest - 1;
    return { cursor: this.cursor(), reset: lost, changes: this.buffer.filter((c) => c.seq > after && keep(c)) };
  }

  /** Like since(), but waits up to `ms` for a first matching change (long polling); ends early when `signal` aborts. */
  async wait(cursor: string | undefined, keep: (c: Change) => boolean, ms: number, signal?: AbortSignal): Promise<ChangePage> {
    const now = this.since(cursor, keep);
    if (!cursor || now.reset || now.changes.length || ms <= 0) return now;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', done);
        resolve(this.since(cursor, keep));
      };
      const off = this.on((changes) => changes.some(keep) && done());
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** Called with every batch of new changes (watches, webhooks). */
  on(fn: (changes: Change[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
