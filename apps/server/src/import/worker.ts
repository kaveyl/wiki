// The import conversion in its own process (convert.ts, bundled as import-worker.mjs, started with fork): gets a
// ConvertInput as the first message, answers once with the result or an error, then ends. A process, not a worker
// thread: running out of memory in a worker thread can take the whole server down with it (V8's fatal out-of-memory).
import { convertExport, type ConvertInput } from './convert.js';
import { webFetcher } from './remote.js';
import { ImportError } from './zip.js';

process.once('message', (input: ConvertInput) => {
  void (async () => {
    let reply: unknown;
    try {
      reply = { ok: await convertExport(input, webFetcher()) };
    } catch (e) {
      if (!(e instanceof ImportError)) console.error('import worker failed:', e);
      reply = { error: e instanceof ImportError ? { message: e.message, statusCode: e.statusCode } : null };
    }
    process.send!(reply, () => process.exit(0));
  })();
});
process.on('disconnect', () => process.exit(0));
