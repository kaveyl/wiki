// The Markdown process (pool.ts, bundled as markdown-worker.mjs, started with fork): one job per message, answered with
// its id. A process of its own, not a worker thread: running out of memory in a worker thread can take the whole server
// down with it (V8's fatal out-of-memory), in a child process only the child.
import { runJob, type Job } from './jobs.js';

process.on('message', (m: { id: number; job: Job }) => {
  let reply: { id: number; ok: boolean; value?: unknown };
  try {
    reply = { id: m.id, ok: true, value: runJob(m.job) };
  } catch {
    // Deep nesting overflows the parser's stack (RangeError) – that note counts as not parsed.
    reply = { id: m.id, ok: false };
  }
  process.send!(reply);
});
// The server went away: so does this process.
process.on('disconnect', () => process.exit(0));
// Started: only a death before this counts as „does not start“ (pool.ts) – one during a job is that job's.
process.send!({ ready: true });
