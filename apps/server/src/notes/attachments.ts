// Attachments (images, PDFs, office files …) stored in `assets/` next to the note and linked
// with a normal relative Markdown link, so they also work in Gitea/VS Code (docs/PLAN.md §2.6).
// SEE-DOC: HANDBOOK.md#bekannte-besonderheiten--stolperfallen

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Author } from '../git/sync.js';
import type { MountManager } from '../mounts/manager.js';
import { absPath, cleanRelPath, type Mount } from '../mounts/model.js';
import { ForbiddenError, localReferences } from './service.js';
import { isEncryptedNote } from './encryption.js';
import { inEncryptedFolder } from './order.js';

/** Every age file starts like this (binary format; the armored form is only used for note texts). */
const AGE_HEADER = Buffer.from('age-encryption.org/v1\n');

/** Upper bound for an upload body; the effective limit is the admin setting (default DEFAULT_ATTACHMENT_MAX_MB). */
export const UPLOAD_HARD_LIMIT = 200 * 1024 * 1024;

export const DEFAULT_ATTACHMENT_MAX_MB = 20;

/**
 * Executables and scripts that a click could run on a client – not stored unless the admin changes the list
 * (Einstellungen → Anhänge, setting `upload_blocklist`; owner 25.10.: a list instead of fixed blocks). A list the admin
 * saved stays as it is when this one grows; „Standardliste“ takes the new one (owner 26.10.: js … command added, sec-005).
 */
export const DEFAULT_BLOCKED: readonly string[] = [
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'ps1', 'psm1', 'vbs', 'vbe',
  'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg', 'app', 'apk', 'deb', 'rpm',
  // Windows Script Host like .vbs, app packages, disk images that bypass the download mark, help files, shortcuts, shell scripts.
  'js', 'jse', 'msix', 'appx', 'iso', 'img', 'chm', 'url', 'sh', 'command',
];
export const BLOCKLIST_KEY = 'upload_blocklist';

/** File endings as the admin types them („.EXE, bat ps1“) → clean, unique, sorted; `md` never (notes are not attachments). */
export function normalizeBlocklist(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[\s,;]+/);
  const out = new Set<string>();
  for (const p of parts) {
    const ext = p.trim().toLowerCase().replace(/^\*?\.+/, '');
    if (!ext || ext === 'md') continue;
    if (!/^[a-z0-9][a-z0-9+_-]{0,15}$/.test(ext)) throw new AttachmentError(`Keine gültige Dateiendung: ${p.trim()}`);
    out.add(ext);
  }
  return [...out].sort();
}

/** The admin's list from the settings, else the default. */
export function blockedTypes(stored: string | null): ReadonlySet<string> {
  if (stored === null) return new Set(DEFAULT_BLOCKED);
  try {
    return new Set(normalizeBlocklist(JSON.parse(stored)));
  } catch {
    return new Set(DEFAULT_BLOCKED);
  }
}

export { ASSETS_DIR, INLINE_TYPES, attachmentName, extensionOf, isAttachmentPath, isServable } from './names.js';
import { ASSETS_DIR, INLINE_TYPES, attachmentName, extensionOf, isAttachmentPath } from './names.js';

export class AttachmentError extends Error {}




/** Link target as written into the note: relative, with characters Markdown needs encoded. */
export function attachmentHref(name: string): string {
  return `${ASSETS_DIR}/${encodeURI(name)}`;
}

export interface StoredAttachment {
  /** Mount-relative path of the stored file. */
  path: string;
  /** Link target relative to the note (`assets/…`). */
  href: string;
  name: string;
  size: number;
  image: boolean;
}

export async function storeAttachment(
  manager: MountManager,
  dataPath: string,
  mount: Mount,
  notePath: string,
  originalName: string,
  data: Buffer,
  maxBytes: number,
  author: Author,
  blocked: ReadonlySet<string> = new Set(DEFAULT_BLOCKED),
): Promise<StoredAttachment> {
  if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  const note = cleanRelPath(notePath);
  if (!note.endsWith('.md')) throw new AttachmentError('Anhänge gehören zu einer Notiz');
  const noteSt = await lstat(absPath(mount, dataPath, note)).catch(() => null);
  if (!noteSt?.isFile()) throw new AttachmentError('Notiz nicht gefunden');
  if (data.length === 0) throw new AttachmentError('Die Datei ist leer');
  if (data.length > maxBytes) throw new AttachmentError(`Die Datei ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB (Einstellungen → Anhänge)`);
  // Encrypted note (or folder): the browser encrypts attachments before the upload – never store a plain file there.
  const encrypted = isEncryptedNote(await readFile(absPath(mount, dataPath, note), 'utf8')) || (await inEncryptedFolder(mount, dataPath, note));
  if (encrypted && !data.subarray(0, AGE_HEADER.length).equals(AGE_HEADER)) {
    throw new ForbiddenError('Verschlüsselte Notiz: Anhänge werden nur verschlüsselt gespeichert – Notiz entsperren und die Datei erneut hinzufügen');
  }

  const name = attachmentName(originalName);
  const ext = extensionOf(name);
  if (blocked.has(ext)) throw new AttachmentError(`Dateien vom Typ .${ext} können nicht angehängt werden (gesperrt unter Einstellungen → Anhänge)`);
  if (ext === 'md') throw new AttachmentError('Markdown-Dateien bitte als Notiz anlegen');

  const dir = posix.join(posix.dirname(note) === '.' ? '' : posix.dirname(note), ASSETS_DIR);
  await mkdir(absPath(mount, dataPath, dir), { recursive: true });
  // Double extensions stay together: the second drawing is `zeichnung-2.excalidraw.svg`, not `zeichnung.excalidraw-2.svg`
  // (which would no longer count as a drawing).
  const dot = /\.excalidraw\.svg$/i.test(name) ? name.length - '.excalidraw.svg'.length : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = dot > 0 ? name.slice(dot) : '';
  // Same name again → numbered copy, never an overwrite.
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${suffix}`;
    const rel = `${dir}/${candidate}`;
    try {
      await writeFile(absPath(mount, dataPath, rel), data, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    await manager.touched(mount, [rel], author, `Anhang ${candidate} hinzugefügt`);
    return { path: rel, href: attachmentHref(candidate), name: candidate, size: data.length, image: ext in INLINE_TYPES && ext !== 'pdf' };
  }
  throw new AttachmentError('Zu viele Dateien mit diesem Namen');
}

export interface AttachmentInfo {
  path: string;
  name: string;
  size: number | null;
  /** 'image' | 'pdf' | 'file' — what the UI can preview. */
  kind: 'image' | 'pdf' | 'file';
}

/** Local non-note files a note links to (its attachments), with size; missing ones have size null. */
export async function listAttachments(dataPath: string, mount: Mount, raw: string, notePath: string): Promise<AttachmentInfo[]> {
  const out: AttachmentInfo[] = [];
  for (const rel of await localReferences(raw, notePath)) {
    const ext = extensionOf(rel);
    if (!ext || ext === 'md') continue;
    const st = await lstat(absPath(mount, dataPath, rel)).catch(() => null);
    if (st && !st.isFile()) continue;
    out.push({ path: rel, name: posix.basename(rel), size: st ? st.size : null, kind: ext === 'pdf' ? 'pdf' : ext in INLINE_TYPES ? 'image' : 'file' });
  }
  return out;
}

/** Files inside an `assets/` folder count as attachments (served as download, checked by fsck). */
/**
 * Writes a new version of an existing attachment in place (e.g. an edited Excalidraw drawing,
 * PLAN §6): same file, same extension, only inside `assets/`; the old version stays in git.
 */
export async function replaceAttachment(
  manager: MountManager,
  dataPath: string,
  mount: Mount,
  rel: string,
  data: Buffer,
  maxBytes: number,
  author: Author,
  blocked: ReadonlySet<string> = new Set(DEFAULT_BLOCKED),
): Promise<StoredAttachment> {
  if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  const clean = cleanRelPath(rel);
  if (!isAttachmentPath(clean)) throw new AttachmentError('Nur Anhänge in assets/ lassen sich ersetzen');
  const ext = extensionOf(clean);
  if (ext === 'md' || blocked.has(ext)) throw new AttachmentError('Dieser Dateityp lässt sich nicht ersetzen');
  const abs = absPath(mount, dataPath, clean);
  if (!(await lstat(abs).catch(() => null))?.isFile()) throw new AttachmentError('Anhang nicht gefunden');
  if (data.length === 0) throw new AttachmentError('Die Datei ist leer');
  if (data.length > maxBytes) throw new AttachmentError(`Die Datei ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB (Einstellungen → Anhänge)`);
  // Same temp-name pattern as notes: the watcher ignores it.
  const tmp = posix.join(posix.dirname(abs.split('\\').join('/')), `.kaveyl-wiki-tmp-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, data);
  await rename(tmp, abs);
  const name = posix.basename(clean);
  await manager.touched(mount, [clean], author, `Anhang ${name} aktualisiert`);
  return { path: clean, href: attachmentHref(name), name, size: data.length, image: ext in INLINE_TYPES && ext !== 'pdf' };
}


