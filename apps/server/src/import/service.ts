// Import from other programs (docs/PLAN-IMPORT.md): the uploaded ZIP waits in `<data>/tmp/import` until the person
// imports or cancels (at most 2 hours; left-overs go at the next start). Preview and import run the same conversion,
// so what the preview says is what gets written. One import at a time per instance – big exports are heavy work.
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ulid } from 'ulid';
import { runConversion, type ConvertInput, type Converted } from './convert.js';
import { FORMATS, formatById } from './formats/index.js';
import type { PictureFetcher } from './remote.js';
import type { FormatId } from './types.js';
import { IMPORT_LIMITS, ImportError } from './zip.js';

const MAX_AGE_MS = 2 * 60 * 60_000;
/** Recognising and converting; fetching pictures adds at most 10 minutes (remote.ts). */
const CONVERT_MS = 5 * 60_000;
const FETCH_MS = 11 * 60_000;
/** Free space that must stay on the data disk besides an upload. */
const DISK_RESERVE = 512 * 1024 * 1024;
const PARALLEL_UPLOADS = 2;

export const UNREAD = 'Einträge im ZIP, die nicht gelesen wurden (verschlüsselt, ungültiger Name oder zu groß)';

export interface Pending {
  token: string;
  userId: string;
  mountId: string;
  parent: string;
  fileName: string;
  file: string;
  at: number;
}

export interface Preview {
  token: string;
  format: FormatId;
  detected: FormatId;
  formats: { id: FormatId; label: string }[];
  name: string;
  notes: number;
  files: number;
  folders: number;
  warnings: { text: string; items: string[]; more: number }[];
  /** Pictures only on the old server (the dialog offers to fetch them). */
  remote: { count: number; servers: string[] };
}

/** Names that say nothing about the content (HedgeDoc's „archive.zip“, browser downloads). */
const GENERIC = /^(archive|export|download|backup|untitled|notes)(\s*\(\d+\))?$/i;

export class ImportService {
  private readonly pending = new Map<string, Pending>();
  private readonly uploading = new Set<string>();
  private running = false;

  constructor(
    private readonly dir: string,
    /** Tests: fetches pictures in the process (no bundled worker there). */
    private readonly fetcher?: PictureFetcher,
  ) {}

  /** Removes waiting uploads older than 2 hours (all of them at start). */
  async sweep(all = false) {
    const now = Date.now();
    for (const [token, p] of this.pending) if (all || now - p.at > MAX_AGE_MS) await this.drop(token);
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const n of names) {
      const file = join(this.dir, n);
      const st = await stat(file).catch(() => null);
      if (st && (all || now - st.mtimeMs > MAX_AGE_MS) && ![...this.pending.values()].some((p) => p.file === file)) await rm(file, { force: true });
    }
  }

  /**
   * Stores an upload (at most 500 MB) for `userId`; an earlier one of the same person is dropped. One upload per person
   * and two in all at a time, and only while the disk keeps some room besides it.
   */
  async receive(stream: Readable, input: Omit<Pending, 'token' | 'file' | 'at'>, expected = 0): Promise<Pending> {
    if (this.uploading.has(input.userId)) throw new ImportError('Es läuft schon ein Upload von dir – bitte warten, bis er fertig ist', 409);
    if (this.uploading.size >= PARALLEL_UPLOADS) throw new ImportError('Gerade laden schon andere hoch – bitte kurz warten', 409);
    this.uploading.add(input.userId);
    try {
      return await this.store(stream, input, expected);
    } finally {
      this.uploading.delete(input.userId);
    }
  }

  private async store(stream: Readable, input: Omit<Pending, 'token' | 'file' | 'at'>, expected: number): Promise<Pending> {
    await this.sweep();
    for (const [token, p] of this.pending) if (p.userId === input.userId) await this.drop(token);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const fs = await statfs(this.dir).catch(() => null);
    if (fs && fs.bavail * fs.bsize < Math.max(expected, 1) + DISK_RESERVE) throw new ImportError('Zu wenig freier Speicherplatz auf dem Server für diesen Upload', 413);
    const token = ulid();
    const file = join(this.dir, `${token}.zip`);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > IMPORT_LIMITS.upload) done(new ImportError('Die Datei ist größer als 500 MB', 413));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(stream, limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    } catch (e) {
      await rm(file, { force: true });
      throw e;
    }
    if (!size) {
      await rm(file, { force: true });
      throw new ImportError('Keine Datei angekommen');
    }
    const p: Pending = { ...input, token, file, at: Date.now() };
    this.pending.set(token, p);
    return p;
  }

  get(token: string, userId: string): Pending {
    const p = this.pending.get(token);
    if (!p || p.userId !== userId) throw new ImportError('Der Import ist abgelaufen – bitte die Datei noch einmal wählen');
    return p;
  }

  async drop(token: string) {
    const p = this.pending.get(token);
    this.pending.delete(token);
    if (p) await rm(p.file, { force: true });
  }

  /** Converts the upload in the worker (convert.ts): chosen (or detected) format, the plan as it would be written. */
  convert(p: Pending, format: string | undefined, opts: Omit<ConvertInput, 'file' | 'format'>): Promise<Converted> {
    return runConversion({ ...opts, file: p.file, format }, { timeoutMs: opts.fetch ? CONVERT_MS + FETCH_MS : CONVERT_MS, fetcher: this.fetcher });
  }

  /** What the dialog shows – as the only conversion of the instance, like the import itself. */
  async preview(p: Pending, format: string | undefined, opts: Omit<ConvertInput, 'file' | 'format' | 'fetch'>): Promise<Preview> {
    const c = await this.exclusive(() => this.convert(p, format, { ...opts, fetch: false }));
    return {
      token: p.token,
      format: c.format,
      detected: c.detected,
      formats: FORMATS.map((f) => ({ id: f.id, label: f.label })),
      name: folderName(p.fileName, c.rootName, formatById(c.format)!.label),
      notes: c.notes.length,
      files: c.files.length,
      folders: c.folders,
      remote: c.remote,
      warnings: [
        ...c.warnings.filter((w) => !w.remote).map((w) => {
          const items = [...w.notes, ...w.items];
          return { text: w.text, items: items.slice(0, 50), more: Math.max(0, items.length - 50) };
        }),
        ...(c.skipped.length ? [{ text: UNREAD, items: c.skipped.slice(0, 50), more: Math.max(0, c.skipped.length - 50) }] : []),
      ],
    };
  }

  /** Runs `work` as the only import of the instance. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.running) throw new ImportError('Gerade läuft schon ein Import – bitte kurz warten', 409);
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
    }
  }
}

/** Name of the new folder: the export's own folder or file name, else „Import aus <Programm>“. */
export function folderName(fileName: string, rootName: string | null, label: string): string {
  const stem = fileName.replace(/^.*[/\\]/, '').replace(/\.zip$/i, '').trim();
  for (const n of [rootName, stem]) if (n && !GENERIC.test(n)) return n;
  return `Import aus ${label}`;
}
