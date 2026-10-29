// The conversion of an uploaded export – recognise, convert, (fetch pictures,) plan – as one step that runs in its own
// process (worker.ts, bundled as import-worker.mjs): parsing large or hostile Markdown can take minutes and much memory,
// and the server must keep answering everyone else meanwhile. The process has a memory and a time limit; when it hits
// one, the import is refused cleanly. A process, not a worker thread (sec-006, 29.10.): a worker thread that runs out of
// memory can end the whole server. Unbundled (tests) the same function runs in the process.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { buildPlan } from './build.js';
import { detectFormat, formatById } from './formats/index.js';
import { fetchRemote, type PictureFetcher } from './remote.js';
import type { FormatId, PlannedNote, Warning } from './types.js';
import { IMPORT_LIMITS, ImportError, ImportZip } from './zip.js';

export interface ConvertInput {
  file: string;
  format?: string;
  folderNote: string;
  /** Lower-case file extensions that may not be uploaded (AD-069). */
  blocked: string[];
  /** Fetch the pictures that are only on the old server (remote.ts). */
  fetch: boolean;
}

/** A file of the plan: from the ZIP (`entry` = its path there) or fetched (`data`). */
export interface ConvertedFile {
  path: string;
  entry?: string;
  data?: Uint8Array;
}

export interface Converted {
  format: FormatId;
  detected: FormatId;
  rootName: string | null;
  skipped: string[];
  notes: PlannedNote[];
  files: ConvertedFile[];
  folders: number;
  warnings: Warning[];
  remote: { count: number; servers: string[] };
}

const TOO_BIG = 'Das Umwandeln dauerte zu lange oder brauchte zu viel Speicher – der Export ist zu groß oder zu verschachtelt';
const FAILED = 'Das Umwandeln des Exports ist fehlgeschlagen';

export async function convertExport(input: ConvertInput, fetcher?: PictureFetcher): Promise<Converted> {
  const zip = await ImportZip.open(input.file);
  try {
    const detected = await detectFormat(zip.files);
    if (!detected) throw new ImportError('Im ZIP ist keine Markdown-Datei – dieses Format kann Kaveyl Wiki nicht importieren');
    const chosen = (input.format && formatById(input.format)) || formatById(detected)!;
    const draft = await chosen.convert(zip.files);
    // Trilium builds notes from its `!!!meta.json` alone – the ZIP's entry count does not bound them.
    if (draft.notes.length + draft.files.length > IMPORT_LIMITS.entries) throw new ImportError(`Der Import ergäbe mehr als ${IMPORT_LIMITS.entries} Notizen und Dateien`);
    if (input.fetch && fetcher && draft.remote?.length) await fetchRemote(draft, fetcher);
    const plan = buildPlan(draft, { folderNote: input.folderNote, blocked: new Set(input.blocked) });
    const own = new Set(zip.files);
    const files = await Promise.all(plan.files.map(async (f): Promise<ConvertedFile> => (own.has(f.source) ? { path: f.path, entry: f.source.path } : { path: f.path, data: await f.source.bytes() })));
    return { format: chosen.id, detected, rootName: zip.rootName, skipped: zip.skipped, notes: plan.notes, files, folders: plan.folders, warnings: plan.warnings, remote: plan.remote };
  } finally {
    await zip.close();
  }
}

/** Next to the bundle (dist/import-worker.mjs, in the image /app/import-worker.mjs). */
export const BUNDLED_WORKER = join(dirname(fileURLToPath(import.meta.url)), 'import-worker.mjs');

export interface RunOptions {
  timeoutMs: number;
  /** In the process only (tests); the worker fetches from the network itself. */
  fetcher?: PictureFetcher;
  /** The worker script; default the bundled one if there is one, else the conversion runs in the process. */
  worker?: string | null;
  memoryMb?: number;
}

export function runConversion(input: ConvertInput, opts: RunOptions): Promise<Converted> {
  const script = opts.worker === undefined ? (existsSync(BUNDLED_WORKER) ? BUNDLED_WORKER : null) : opts.worker;
  if (!script) return convertExport(input, opts.fetcher);
  return new Promise((resolve, reject) => {
    // The server's environment without its secrets (KAVEYL_WIKI_SECRET_KEY and the like) – proxies etc. stay for fetching pictures.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/SECRET|TOKEN|PASSWORD|PASSWD|_KEY$/i.test(k)));
    const worker = fork(script, [], { execArgv: [`--max-old-space-size=${opts.memoryMb ?? 1024}`], env, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.kill('SIGKILL');
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new ImportError(TOO_BIG, 422))), opts.timeoutMs);
    worker.on('message', (m: { ok?: Converted; error?: { message: string; statusCode: number } | null }) =>
      finish(() => (m.ok ? resolve(m.ok) : reject(m.error ? new ImportError(m.error.message, m.error.statusCode) : new ImportError(FAILED, 422)))),
    );
    worker.on('error', () => finish(() => reject(new ImportError(FAILED, 422))));
    // Out of memory ends the process (V8 aborts it: a signal) – only that process. A plain exit without an answer: failed.
    worker.on('exit', (_code, signal) => finish(() => reject(new ImportError(signal ? TOO_BIG : FAILED, 422))));
    worker.send(input);
  });
}
