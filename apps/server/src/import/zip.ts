// An uploaded export (ZIP) for the import from other programs (docs/PLAN-IMPORT.md). Every entry is checked before
// anything is read: paths stay inside the import (zip slip), count and unpacked size are limited (zip bombs),
// encrypted entries and nested archives are not opened. Data is read only on demand and never beyond what the entry
// declares, so a lying size header cannot inflate it.
import { open, stat, type FileHandle } from 'node:fs/promises';
import { Writer, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { cleanEntryPath, FileReader } from '../backups/archive.js';

export const IMPORT_LIMITS = {
  /** Upload (the ZIP itself). Owner 28.10.: 500 MB. */
  upload: 500 * 1024 * 1024,
  entries: 20_000,
  /** All entries unpacked together. */
  unpacked: 2 * 1024 * 1024 * 1024,
  /** One note (as for the Markdown import). */
  note: 5 * 1024 * 1024,
  /** One other file (as for an attachment upload). */
  file: 200 * 1024 * 1024,
  /** All text read as notes together (the conversion holds it in memory). */
  text: 300 * 1024 * 1024,
};

export class ImportError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** One file of the export, read on demand. `path` is clean (no `..`, no leading `/`), without a common root folder. */
export interface SourceFile {
  path: string;
  size: number;
  modified: Date;
  /** The entry's own comment in the ZIP (Outline keeps the dates of a document there). */
  comment?: string;
  bytes(): Promise<Uint8Array>;
  /** UTF-8 text without BOM; null when the file is no text (binary or invalid UTF-8). */
  text(): Promise<string | null>;
}

/** Files that operating systems add to archives – never content. */
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Collects an entry's data and stops as soon as it grows beyond what the entry declared. */
class LimitedWriter extends Writer<Uint8Array> {
  private readonly parts: Uint8Array[] = [];
  private written = 0;
  constructor(private readonly max: number) {
    super();
  }
  override async writeUint8Array(array: Uint8Array) {
    this.written += array.length;
    if (this.written > this.max) throw new ImportError('Eine Datei im ZIP ist größer als angegeben – das ZIP ist beschädigt oder manipuliert');
    this.parts.push(array.slice());
  }
  override async getData(): Promise<Uint8Array> {
    return Buffer.concat(this.parts);
  }
}

export class ImportZip {
  private constructor(
    private readonly fh: FileHandle,
    readonly files: SourceFile[],
    /** The one folder everything was in (`Mein Export/…`), stripped from the paths. */
    readonly rootName: string | null,
    /** Entries left out on purpose (encrypted, invalid path, too big) – for the report. */
    readonly skipped: string[],
  ) {}

  static async open(file: string): Promise<ImportZip> {
    const size = (await stat(file)).size;
    const fh = await open(file, 'r');
    try {
      // The directory's own numbers first: reading hundreds of thousands of entries costs gigabytes before any count.
      const dir = await directorySize(fh, size);
      if (dir && (dir.entries > IMPORT_LIMITS.entries || dir.bytes > IMPORT_LIMITS.entries * 1200)) throw new ImportError(`Das ZIP enthält mehr als ${IMPORT_LIMITS.entries} Dateien`);
      let entries: FileEntry[];
      try {
        const all = await new ZipReader(new FileReader(fh, size), { filenameValidation: 'tolerant' }).getEntries();
        entries = all.filter((e): e is FileEntry => !e.directory);
      } catch {
        throw new ImportError('Die Datei ist kein lesbares ZIP-Archiv');
      }
      if (entries.length > IMPORT_LIMITS.entries) throw new ImportError(`Das ZIP enthält mehr als ${IMPORT_LIMITS.entries} Dateien`);
      const skipped: string[] = [];
      const kept: { path: string; entry: FileEntry }[] = [];
      let unpacked = 0;
      const seen = new Set<string>();
      for (const e of entries) {
        if (JUNK.test(e.filename.replace(/\\/g, '/'))) continue;
        const path = cleanEntryPath(e.filename);
        if (!path || seen.has(path)) {
          // Outline writes a file used twice in one folder twice under the same name – the first is enough.
          if (!path || !kept.some((k) => k.path === path && k.entry.uncompressedSize === e.uncompressedSize)) skipped.push(e.filename);
          continue;
        }
        if (e.encrypted) {
          skipped.push(path);
          continue;
        }
        const max = /\.(md|markdown)$/i.test(path) ? IMPORT_LIMITS.note : IMPORT_LIMITS.file;
        if (e.uncompressedSize > max) {
          skipped.push(path);
          continue;
        }
        unpacked += e.uncompressedSize;
        if (unpacked > IMPORT_LIMITS.unpacked) throw new ImportError('Das ZIP ist entpackt größer als 2 GB');
        seen.add(path);
        kept.push({ path, entry: e });
      }
      // A single top folder around everything (most zipped folders) is no part of the content.
      const first = kept[0]?.path.split('/')[0];
      const wrapped = !!first && kept.every((k) => k.path.startsWith(`${first}/`));
      const asText = new Set<string>();
      let textBytes = 0;
      const files = kept.map(({ path, entry }): SourceFile => {
        const bytes = () => entry.getData!(new LimitedWriter(entry.uncompressedSize));
        return {
          path: wrapped ? path.slice(first!.length + 1) : path,
          size: entry.uncompressedSize,
          modified: entry.lastModDate,
          comment: typeof entry.comment === 'string' ? entry.comment.slice(0, 1000) : undefined,
          bytes,
          // Text is what a converter reads as a note: at most 5 MB each (also `.html`), 300 MB together.
          text: async () => {
            if (entry.uncompressedSize > IMPORT_LIMITS.note) return null;
            if (!asText.has(path)) {
              asText.add(path);
              textBytes += entry.uncompressedSize;
              if (textBytes > IMPORT_LIMITS.text) throw new ImportError('Die Notizen im ZIP sind zusammen größer als 300 MB');
            }
            const data = await bytes();
            if (data.includes(0)) return null;
            try {
              return UTF8.decode(data).replace(/^﻿/, '');
            } catch {
              return null;
            }
          },
        };
      });
      return new ImportZip(fh, files, wrapped ? first! : null, skipped);
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
  }

  async close() {
    await this.fh.close().catch(() => undefined);
  }
}

/**
 * Entry count and directory size from the ZIP's end record (ZIP64 too), read without zip.js; null when there is none
 * (zip.js then says the file is no ZIP).
 */
async function directorySize(fh: FileHandle, size: number): Promise<{ entries: number; bytes: number } | null> {
  const tail = Math.min(size, 22 + 65_535);
  const buf = Buffer.alloc(tail);
  await fh.read(buf, 0, tail, size - tail);
  let at = -1;
  for (let i = tail - 22; i >= 0; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      at = i;
      break;
    }
  if (at < 0) return null;
  let entries = buf.readUInt16LE(at + 10);
  let bytes = buf.readUInt32LE(at + 12);
  if ((entries === 0xffff || bytes === 0xffffffff) && at >= 20 && buf.readUInt32LE(at - 20) === 0x07064b50) {
    const where = Number(buf.readBigUInt64LE(at - 20 + 8));
    const rec = Buffer.alloc(56);
    if (where + 56 <= size) {
      await fh.read(rec, 0, 56, where);
      if (rec.readUInt32LE(0) === 0x06064b50) {
        entries = Number(rec.readBigUInt64LE(32));
        bytes = Number(rec.readBigUInt64LE(40));
      }
    }
  }
  return { entries, bytes };
}
