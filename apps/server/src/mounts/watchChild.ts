// The file watcher in a process of its own (AD-054). @parcel/watcher gives up for good when its `poll` is interrupted
// by a signal („Unable to poll: Interrupted system call“) – and every git command the server runs ends with a SIGCHLD
// to the server process. This process starts no children, so nothing interrupts it. Run by `watchHost.ts`; plain
// TypeScript that Node runs as is (tests) and esbuild bundles to dist/watcher.mjs. It imports nothing of the server.
import watcher from '@parcel/watcher';

type ToChild = { op: 'subscribe'; id: number; dir: string; ignore: string[] } | { op: 'unsubscribe'; id: number };

const subscriptions = new Map<number, watcher.AsyncSubscription>();
let failed = false;

const send = (message: object, then: () => void = () => {}) => {
  if (process.connected) process.send!(message, then);
  else then();
};

// The server is gone (or restarts us): nothing left to watch for.
process.on('disconnect', () => process.exit(0));

process.on('message', (message: ToChild) => {
  if (message.op === 'subscribe') {
    const { id, dir, ignore } = message;
    watcher
      .subscribe(
        dir,
        (err, events) => {
          if (failed) return;
          if (err) {
            // One failure stops the watcher's thread for every subscription: report it and end, the host starts a fresh
            // process (a new process also has a fresh native backend – no subscription can land on a dead one).
            failed = true;
            send({ op: 'fatal', error: err.message }, () => process.exit(1));
            return;
          }
          send({ op: 'events', id, events: events.map((e) => ({ path: e.path, type: e.type })) });
        },
        { ignore },
      )
      .then(
        (subscription) => {
          subscriptions.set(id, subscription);
          send({ op: 'subscribed', id });
        },
        (e: unknown) => send({ op: 'subscribe-failed', id, error: e instanceof Error ? e.message : String(e) }),
      );
  } else if (message.op === 'unsubscribe') {
    const subscription = subscriptions.get(message.id);
    subscriptions.delete(message.id);
    void (subscription?.unsubscribe() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => send({ op: 'unsubscribed', id: message.id }));
  }
});

send({ op: 'ready' });
