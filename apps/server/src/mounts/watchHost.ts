// The server's side of the watcher process (AD-054): the same `subscribe` as @parcel/watcher, but the watching happens in
// `watchChild` – a process that starts no children and so never sees the SIGCHLD that stopped the watcher for good when
// it ran inside the server. Started on the first subscription; when it ends (crash, a watcher error), every subscription
// gets an error – the MountManager then subscribes again (`rewatch`), which starts a fresh process.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import parcel from '@parcel/watcher';

export type WatchEvent = { path: string; type: 'create' | 'update' | 'delete' };
export type WatchCallback = (err: Error | null, events: WatchEvent[]) => void;
export type Subscription = { unsubscribe(): Promise<void> };

type FromChild =
  | { op: 'ready' }
  | { op: 'subscribed' | 'unsubscribed'; id: number }
  | { op: 'subscribe-failed'; id: number; error: string }
  | { op: 'events'; id: number; events: WatchEvent[] }
  | { op: 'fatal'; error: string };

// Next to the bundle (dist/watcher.mjs, in the image /app/watcher.mjs) or, unbundled (tests), the TypeScript source.
const here = dirname(fileURLToPath(import.meta.url));
const CHILD = [join(here, 'watcher.mjs'), join(here, 'watchChild.ts')].find((f) => existsSync(f));

let child: ChildProcess | null = null;
let fatal: string | null = null;
let nextId = 1;
const callbacks = new Map<number, WatchCallback>();
const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

function start(): ChildProcess {
  fatal = null;
  // No inherited flags (test runners, inspectors); the child talks only over IPC.
  const c = fork(CHILD!, [], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  c.on('message', (m: FromChild) => {
    if (m.op === 'events') callbacks.get(m.id)?.(null, m.events);
    else if (m.op === 'subscribed' || m.op === 'unsubscribed') {
      waiting.get(m.id)?.resolve();
      waiting.delete(m.id);
    } else if (m.op === 'subscribe-failed') {
      waiting.get(m.id)?.reject(new Error(m.error));
      waiting.delete(m.id);
      callbacks.delete(m.id);
    } else if (m.op === 'fatal') fatal = m.error;
  });
  c.on('exit', (code, signal) => {
    if (child === c) child = null;
    const err = new Error(fatal ?? `Prozess der Dateiüberwachung beendet (${signal ?? code})`);
    // A subscription still being made fails through its promise, not (also) through its callback.
    for (const [id, w] of waiting) {
      callbacks.delete(id);
      w.reject(err);
    }
    waiting.clear();
    const subscribed = [...callbacks.values()];
    callbacks.clear();
    for (const cb of subscribed) cb(err, []);
  });
  // Idle, never what keeps the server (or a test run) alive (only while an answer is due, see `request`); it ends by
  // itself when the server goes (`disconnect`).
  c.unref();
  c.channel?.unref();
  return c;
}

function request(c: ChildProcess, id: number, message: object): Promise<void> {
  // While an answer is due, the channel keeps the event loop alive – the server awaits its subscriptions at start-up,
  // with nothing else running yet (Dev 21.10.: without this, Node ended with an unsettled top-level await).
  c.channel?.ref();
  const done = () => {
    if (!waiting.size) c.channel?.unref();
  };
  return new Promise<void>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    c.send(message, (e) => {
      if (!e) return;
      waiting.delete(id);
      reject(e);
    });
  }).finally(done);
}

export async function subscribe(dir: string, cb: WatchCallback, opts: { ignore?: string[] } = {}): Promise<Subscription> {
  // Without the child script (should not happen) the watcher runs here, as before.
  if (!CHILD) return parcel.subscribe(dir, (err, events) => cb(err, events as WatchEvent[]), opts);
  child ??= start();
  const c = child;
  const id = nextId++;
  callbacks.set(id, cb);
  await request(c, id, { op: 'subscribe', id, dir, ignore: opts.ignore ?? [] });
  return {
    async unsubscribe() {
      if (!callbacks.delete(id) || child !== c) return;
      await request(c, id, { op: 'unsubscribe', id }).catch(() => undefined);
    },
  };
}

/** Process id of the watcher process, null while none runs (tests). */
export const watcherPid = (): number | null => child?.pid ?? null;

export default { subscribe };
