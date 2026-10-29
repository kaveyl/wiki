// ZIP archives of the backup module (AD-038): a source folder (without .git; its history as a bundle, AD-071) as one ZIP, with
// or without a password (AES-256, opens in 7-Zip/Keka/WinRAR; file names stay visible), and
// reading one back for the restore (random access, so a large archive is never loaded whole).
// SEE-DOC: DECISIONS.md AD-038

import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { configure, Reader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, type FileEntry } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

/** Never backed up: repository internals and dependency folders. */
const SKIP = new Set(['.git', 'node_modules']);
/** Already compressed: stored as they are (deflating them again only costs time). */
const STORED = /\.(png|jpe?g|gif|webp|avif|zip|gz|7z|mp4|mov|mp3|m4a|pdf|docx|xlsx|pptx|woff2?)$/i;

export class ArchiveError extends Error {
  /**
   * `backup-password`: no or the wrong backup password – the UI asks for the right one (AD-075). `backup-unencrypted`:
   * not encrypted although a password is set – the UI warns and opens it only when the admin says so.
   */
  constructor(
    message: string,
    readonly code?: 'backup-password' | 'backup-unencrypted',
  ) {
    super(message);
  }
}

export interface ZipResult {
  files: number;
  bytes: number;
}

/** Files below `root` (mount-relative POSIX paths), symlinks left out so nothing outside is read. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string) => {
    for (const e of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk(root, '');
  return out.sort();
}

/**
 * Writes `root` (and `extra` files) into `outFile` as a ZIP. `password` → AES-256 for every
 * entry. Streams file by file, so memory stays small for large sources.
 */
export async function zipFolder(
  root: string | null,
  outFile: string,
  opts: { password?: string | null; extra?: { name: string; file: string }[] } = {},
): Promise<ZipResult> {
  const out = createWriteStream(outFile, { mode: 0o600 });
  const zip = new ZipWriter(Writable.toWeb(out), opts.password ? { password: opts.password, encryptionStrength: 3 } : {});
  let files = 0;
  let bytes = 0;
  const add = async (name: string, file: string) => {
    const st = await stat(file);
    await zip.add(name, Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
      level: STORED.test(name) ? 0 : 6,
      lastModDate: st.mtime,
    });
    files++;
    bytes += st.size;
  };
  try {
    // An extra file replaces one of the same name in the folder (e.g. an older history bundle lying there).
    const extra = new Set((opts.extra ?? []).map((x) => x.name));
    if (root) for (const rel of await listFiles(root)) if (!extra.has(rel)) await add(rel, join(root, ...rel.split('/')));
    for (const x of opts.extra ?? []) await add(x.name, x.file);
    await zip.close();
  } catch (e) {
    out.destroy();
    throw e;
  }
  return { files, bytes };
}

/** Random access to a local file for the ZIP reader. */
export class FileReader extends Reader<FileHandle> {
  constructor(private readonly fh: FileHandle, size: number) {
    super(fh);
    this.size = size;
  }
  override async init() {}
  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, index);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  }
}

export interface ArchiveEntry {
  path: string;
  size: number;
  modified: string;
}

/** An opened archive: its file list, single files by path. Close after use. */
export class Archive {
  private constructor(
    private readonly fh: FileHandle,
    private readonly reader: ZipReader<unknown>,
    private readonly byPath: Map<string, FileEntry>,
    private readonly password: string | undefined,
  ) {}

  static async open(file: string, password?: string | null): Promise<Archive> {
    const size = (await stat(file)).size;
    const fh = await open(file, 'r');
    try {
      const reader = new ZipReader(new FileReader(fh, size));
      const entries = await reader.getEntries();
      const byPath = new Map<string, FileEntry>();
      for (const e of entries) {
        if (e.directory) continue;
        const p = cleanEntryPath(e.filename);
        if (p) byPath.set(p, e);
      }
      const archive = new Archive(fh, reader, byPath, password ?? undefined);
      const first = [...byPath.values()].find((e) => e.encrypted);
      if (first) {
        if (!password) throw new ArchiveError('Die Sicherung ist verschlüsselt – am Ziel ist kein Backup-Passwort (mehr) hinterlegt', 'backup-password');
        await archive.check(first);
      }
      // With a backup password every file must be encrypted with it (AES checks each one when it is read): an unencrypted
      // file in it – or an unencrypted archive – did not come from Kaveyl Wiki, someone may have put it there.
      if (password && [...byPath.values()].some((e) => !e.encrypted)) throw new ArchiveError('Die Sicherung ist nicht (vollständig) verschlüsselt, obwohl das Ziel ein Backup-Passwort hat – sie stammt nicht von Kaveyl Wiki oder wurde verändert', 'backup-unencrypted');
      return archive;
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
  }

  private async check(entry: FileEntry) {
    try {
      await entry.getData(new Uint8ArrayWriter(), { password: this.password, checkPasswordOnly: true });
    } catch (e) {
      if (/password/i.test(String((e as Error).message))) throw new ArchiveError('Backup-Passwort passt nicht zu dieser Sicherung', 'backup-password');
      throw e;
    }
  }

  entries(): ArchiveEntry[] {
    return [...this.byPath].map(([path, e]) => ({ path, size: e.uncompressedSize, modified: e.lastModDate.toISOString() })).sort((a, b) => a.path.localeCompare(b.path));
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  async read(path: string): Promise<Buffer> {
    const e = this.byPath.get(path);
    if (!e) throw new ArchiveError(`„${path}“ ist nicht in der Sicherung`);
    try {
      return Buffer.from(await e.getData(new Uint8ArrayWriter(), { password: this.password }));
    } catch (err) {
      if (/password/i.test(String((err as Error).message))) throw new ArchiveError('Backup-Passwort passt nicht zu dieser Sicherung', 'backup-password');
      throw err;
    }
  }

  /** One file onto the disk, streamed (a history bundle or a database can be large). */
  async extract(path: string, outFile: string): Promise<void> {
    const e = this.byPath.get(path);
    if (!e) throw new ArchiveError(`„${path}“ ist nicht in der Sicherung`);
    try {
      await e.getData(Writable.toWeb(createWriteStream(outFile, { mode: 0o600 })), { password: this.password });
    } catch (err) {
      if (/password/i.test(String((err as Error).message))) throw new ArchiveError('Backup-Passwort passt nicht zu dieser Sicherung', 'backup-password');
      throw err;
    }
  }

  /** Size of one file once unpacked (null: not in the archive). */
  size(path: string): number | null {
    return this.byPath.get(path)?.uncompressedSize ?? null;
  }

  async close() {
    await this.reader.close().catch(() => undefined);
    await this.fh.close().catch(() => undefined);
  }
}

/** Entry names as mount-relative paths; anything leading outside (../, absolute) is ignored. */
export function cleanEntryPath(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..' || p.includes('\0'))) return null;
  return posix.join(...parts);
}

/** Small ZIP in memory (tests). */
export async function zipBuffer(files: Record<string, string>, password?: string): Promise<Buffer> {
  const w = new Uint8ArrayWriter();
  const zip = new ZipWriter(w, password ? { password, encryptionStrength: 3 } : {});
  for (const [name, text] of Object.entries(files)) await zip.add(name, new Uint8ArrayReader(new TextEncoder().encode(text)));
  return Buffer.from(await zip.close());
}

export async function isFile(path: string): Promise<boolean> {
  return !!(await lstat(path).catch(() => null))?.isFile();
}
