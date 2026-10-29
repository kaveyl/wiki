// Reading and writing notes inside mounts. All file access goes through absPath() (no
// traversal) and every write is atomic. Saving from the editor uses the diff-minimal
// Markdown writer; a stale baseHash is a conflict, never a silent overwrite.
// SEE-DOC: docs/PLAN.md §2.8, §2.9

import { randomBytes } from 'node:crypto';
import { copyFile, constants as fsc, lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import {
  formatLink,
  noteCandidates,
  noteMeta,
  readFrontmatter,
  resolveHref,
  setFrontmatterKeys,
  splitFrontmatter,
  type FrontmatterValue,
  type PMNode,
  isExternal,
  parseTags,
  renameInTags,
  tagKey,
  listedAttachments,
} from '@kaveyl-wiki/core';
import { ulid } from 'ulid';
import { readTemplate, renderTemplate } from './templates.js';
import { inEncryptedFolder, renameInOrder } from './order.js';
import { isAgeBody, isEncryptedNote } from './encryption.js';
import { isServable } from './attachments.js';
import { fileNameFor } from './names.js';
export { fileNameFor } from './names.js';
import type { Author } from '../git/sync.js';
import { sha1, walk, type Indexer } from '../index/indexer.js';
import { fileReferences } from '../markdown/fileRefs.js';
import { markdown } from '../markdown/pool.js';
import type { MountManager } from '../mounts/manager.js';
import { absPath, cleanRelPath, contentRoot, fileFilter, PathError, throughSymlink, type Mount } from '../mounts/model.js';
import { deletedNotes, fileAt, fileBytesAt, fileHistory, repoPrefix, textDiff, type Version } from '../git/history.js';
import { folderItems, folderTrashFile, gitItems, moveToTrash, purgeFolderItem, purgeFolderTrash, restoreFromFolder, restoreTargets, TRASH_DIR, type TrashItem } from './trash.js';
import { dirSize } from '../cleanup.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface Move {
  from: string;
  to: string;
}

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class ConflictError extends Error {
  constructor(
    readonly currentHash: string | null,
    readonly currentRaw: string | null,
  ) {
    super('Die Notiz wurde inzwischen anderswo geändert');
  }
}

export interface NoteDocument {
  mountId: string;
  path: string;
  raw: string;
  hash: string;
  /** Only when asked for (`read(…, { doc: true })`); null: too large or too nested for the parser (sec-006). */
  doc: PMNode | null;
  title: string;
  /** UI read-only mode (mount option or `readonly: true` in frontmatter). */
  readonly: boolean;
  frontmatter: Record<string, unknown>;
}

/** How long an editor's save to a just-moved path still lands at the new place. */
const FOLLOW_MOVE_MS = 10 * 60_000;

export class NoteService {
  /** Recent moves within a source (`mountId\0from` → to): an open editor keeps saving to the old path for a moment. */
  private readonly moved = new Map<string, { to: string; at: number }>();

  constructor(
    private readonly manager: MountManager,
    private readonly dataPath: string,
    private readonly indexer: Indexer,
  ) {}

  /**
   * `doc`: the editor's document too (the app's editor) – parsed in the worker; null for a note too large or too nested
   * for it (sec-006), which the app then shows as Markdown source.
   */
  async read(mount: Mount, path: string, opts: { doc?: boolean } = {}): Promise<NoteDocument> {
    const rel = this.notePath(mount, path);
    const raw = await this.readRaw(mount, rel);
    if (raw === null) throw new NotFoundError(rel);
    const meta = noteMeta(raw, posix.basename(rel));
    return {
      mountId: mount.id,
      path: rel,
      raw,
      hash: sha1(raw),
      doc: opts.doc ? await markdown.doc(raw) : null,
      title: meta.title,
      readonly: mount.options.readonly || meta.readonly,
      frontmatter: meta.frontmatter,
    };
  }

  /** Saves an editor document. Returns the new hash (unchanged files are not rewritten). */
  /**
   * Saves the rich editor's document. `followMove` (the app's editor; tells whether the user may write there): when
   * someone just moved the note, the save lands at its new place, as long as nothing else changed it (same hash) –
   * the result names the new `path`.
   */
  async saveDoc(mount: Mount, path: string, doc: PMNode, baseHash: string, author: Author, opts: { followMove?: (to: string) => boolean } = {}): Promise<{ hash: string; changed: boolean; path?: string }> {
    const moved = opts.followMove ? await this.movedTo(mount, path, opts.followMove) : null;
    if (moved) return { ...(await this.locked(mount, moved, () => this.saveDocNow(mount, moved, doc, baseHash, author))), path: moved };
    return this.locked(mount, path, () => this.saveDocNow(mount, path, doc, baseHash, author));
  }

  private async saveDocNow(mount: Mount, path: string, doc: PMNode, baseHash: string, author: Author): Promise<{ hash: string; changed: boolean }> {
    this.assertWritable(mount);
    const rel = this.notePath(mount, path);
    const current = await this.readRaw(mount, rel);
    if (current === null) throw new NotFoundError(rel);
    if (sha1(current) !== baseHash) throw new ConflictError(sha1(current), current);
    // The server never sees plaintext of an encrypted note, so it cannot merge a document into it.
    if (isEncryptedNote(current) || (await inEncryptedFolder(mount, this.dataPath, rel))) throw new ForbiddenError('Verschlüsselte Notiz: wird nur im Browser verschlüsselt gespeichert');
    const next = await markdown.save(current, doc);
    if (next === null) throw new PathError('Diese Notiz ist zu groß oder zu verschachtelt für den Editor – bitte als Markdown-Quelltext bearbeiten');
    return this.writeIfChanged(mount, rel, current, next, author);
  }

  /**
   * Saves raw Markdown from the source editor (or an encrypted note from the browser). Guard
   * against accidental plaintext: an encrypted note (or one in an encrypted folder) only accepts
   * an age block, unless the browser explicitly removes the encryption (`allowPlain`).
   */
  async saveRaw(mount: Mount, path: string, raw: string, baseHash: string, author: Author, opts: { allowPlain?: boolean; followMove?: (to: string) => boolean } = {}): Promise<{ hash: string; changed: boolean; path?: string }> {
    const moved = opts.followMove ? await this.movedTo(mount, path, opts.followMove) : null;
    if (moved) return { ...(await this.locked(mount, moved, () => this.saveRawNow(mount, moved, raw, baseHash, author, opts))), path: moved };
    return this.locked(mount, path, () => this.saveRawNow(mount, path, raw, baseHash, author, opts));
  }

  /** Where a note that is gone from `path` was moved to a moment ago (only when it is really gone and the new one exists). */
  private async movedTo(mount: Mount, path: string, mayWrite: (to: string) => boolean): Promise<string | null> {
    let rel = cleanRelPath(path);
    if ((await this.readRaw(mount, rel).catch(() => null)) !== null) return null;
    for (let hop = 0; hop < 5; hop++) {
      const m = this.moved.get(`${mount.id}\0${rel}`);
      if (!m || Date.now() - m.at > FOLLOW_MOVE_MS) break;
      rel = m.to;
    }
    return rel !== cleanRelPath(path) && mayWrite(rel) && (await this.readRaw(mount, rel).catch(() => null)) !== null ? rel : null;
  }

  private async saveRawNow(mount: Mount, path: string, raw: string, baseHash: string, author: Author, opts: { allowPlain?: boolean } = {}): Promise<{ hash: string; changed: boolean }> {
    this.assertWritable(mount);
    const rel = this.notePath(mount, path);
    const current = await this.readRaw(mount, rel);
    if (current === null) throw new NotFoundError(rel);
    if (sha1(current) !== baseHash) throw new ConflictError(sha1(current), current);
    if (isEncryptedNote(raw)) {
      if (!isAgeBody(raw)) throw new PathError('Verschlüsselte Notiz: Inhalt ist kein age-Block');
    } else if (!opts.allowPlain && (isEncryptedNote(current) || (await inEncryptedFolder(mount, this.dataPath, rel)))) {
      throw new ForbiddenError('Verschlüsselte Notiz: Klartext wird nicht gespeichert');
    }
    return this.writeIfChanged(mount, rel, current, raw, author);
  }

  /**
   * Changes app-managed frontmatter keys (tags, icon) without touching the body or other keys.
   * Tags keep the file's style: a YAML list stays a list, otherwise Wiki.js' comma string.
   */
  async setMeta(mount: Mount, path: string, changes: { tags?: string[]; icon?: string | null; readonly?: boolean }, baseHash: string, author: Author): Promise<{ hash: string; changed: boolean }> {
    return this.locked(mount, path, () => this.setMetaNow(mount, path, changes, baseHash, author));
  }

  private async setMetaNow(mount: Mount, path: string, changes: { tags?: string[]; icon?: string | null; readonly?: boolean }, baseHash: string, author: Author): Promise<{ hash: string; changed: boolean }> {
    this.assertWritable(mount);
    const rel = this.notePath(mount, path);
    const current = await this.readRaw(mount, rel);
    if (current === null) throw new NotFoundError(rel);
    if (sha1(current) !== baseHash) throw new ConflictError(sha1(current), current);
    const fm = readFrontmatter(splitFrontmatter(current).frontmatter);
    const keys: Record<string, FrontmatterValue> = {};
    if (changes.tags) {
      const tags = [...new Set(changes.tags.map((t) => t.trim().replace(/^#/, '').replace(/,/g, ' ')).filter(Boolean))].slice(0, 50);
      keys.tags = !tags.length ? undefined : Array.isArray(fm.tags) ? tags : tags.join(', ');
    }
    if (changes.icon !== undefined) keys.icon = changes.icon?.trim().slice(0, 100) || undefined;
    if (changes.readonly !== undefined) keys.readonly = changes.readonly ? true : undefined;
    if (!Object.keys(keys).length) return { hash: sha1(current), changed: false };
    return this.writeIfChanged(mount, rel, current, setFrontmatterKeys(current, keys), author);
  }

  /**
   * Renames a tag in the given notes (AD-040): case-insensitive, merges into `to` when a note has
   * both, keeps each file's style (`tags: a, b` stays a string, a list stays a list). One commit
   * message for all. Returns the notes that changed.
   */
  async renameTag(mount: Mount, paths: string[], from: string, to: string, author: Author): Promise<string[]> {
    this.assertWritable(mount);
    const target = to.trim().replace(/^#/, '').replace(/,/g, ' ').trim();
    if (!target) throw new PathError('Bitte einen neuen Namen angeben');
    const changed: string[] = [];
    for (const path of paths) {
      const rel = this.notePath(mount, path);
      const done = await this.locked(mount, rel, async () => {
        const current = await this.readRaw(mount, rel);
        if (current === null) return false;
        const fm = readFrontmatter(splitFrontmatter(current).frontmatter);
        const tags = parseTags(fm.tags);
        if (!tags.some((t) => tagKey(t) === tagKey(from))) return false;
        const next = renameInTags(tags, from, target);
        const res = await this.writeIfChanged(mount, rel, current, setFrontmatterKeys(current, { tags: Array.isArray(fm.tags) ? next : next.join(', ') }), author, `docs: Tag #${from} → #${target} (Kaveyl Wiki)`);
        return res.changed;
      });
      if (done) changed.push(rel);
    }
    return changed;
  }

  /** Creates a note (or a folder with its folder note) below `parent`. Returns the new path. */
  /** `body`: Markdown below the heading (e.g. an AI answer saved as a note); not in encrypted folders. */
  async create(mount: Mount, parent: string, title: string, kind: 'file' | 'dir', author: Author, template?: string, body?: string): Promise<string> {
    this.assertWritable(mount);
    const base = fileNameFor(title);
    const parentRel = cleanRelPath(parent);
    const parentAbs = absPath(mount, this.dataPath, parentRel);
    await mkdir(parentAbs, { recursive: true });
    // In an encrypted folder a new note starts empty and encrypted: no title in the frontmatter (AD-048,
    // the file name says it), the browser writes the first age block (no plaintext ever reaches Git).
    const encrypted = await inEncryptedFolder(mount, this.dataPath, parentRel ? `${parentRel}/new.md` : 'new.md');
    const heading = encrypted
      ? setFrontmatterKeys('', { encrypted: 'age' })
      : template
        ? renderTemplate(await readTemplate(mount, this.dataPath, template), { title: title.trim() || 'Neue Notiz', user: author.name })
        : `# ${title.trim() || 'Neue Notiz'}\n${body?.trim() ? `\n${body.trim()}\n` : ''}`;
    if (encrypted && body?.trim()) throw new ForbiddenError('In einem verschlüsselten Ordner lässt sich kein Klartext ablegen – Antwort kopieren und in eine Notiz einfügen');
    // Notes created in the app carry their id from the start (rename-safe, docs/PLAN.md §2.2).
    // A template's own id (if any) is replaced, so every note gets a fresh one.
    const content = mount.options.writeMetadata ? setFrontmatterKeys(heading, { id: ulid() }) : template && !encrypted ? setFrontmatterKeys(heading, { id: undefined }) : heading;
    let rel: string;
    if (kind === 'dir') {
      const dirRel = await uniquePath(mount, this.dataPath, parentRel, base, '');
      await mkdir(absPath(mount, this.dataPath, dirRel));
      rel = `${dirRel}/${mount.options.folderNote}`;
    } else {
      rel = await uniquePath(mount, this.dataPath, parentRel, base, '.md');
    }
    if (!fileFilter(mount)(rel)) throw new ForbiddenError('Der Mount-Filter würde diese Notiz ausblenden');
    await writeFile(absPath(mount, this.dataPath, rel), content, { flag: 'wx' });
    await this.manager.touched(mount, [rel], author, `docs: ${rel} angelegt (Kaveyl Wiki)`);
    return kind === 'dir' ? posix.dirname(rel) : rel;
  }

  /**
   * Import of a Markdown file from the computer (owner 28.10.): the file as it is under its own name, never over an
   * existing note (`Name 2.md`). A fresh id like a copy; plain text never into an encrypted folder.
   */
  async importNote(mount: Mount, parent: string, fileName: string, raw: string, author: Author): Promise<string> {
    this.assertWritable(mount);
    if (raw.includes('\0')) throw new PathError('Keine Textdatei – nur Markdown-Dateien (.md) lassen sich importieren');
    const parentRel = cleanRelPath(parent);
    // Marked as encrypted, but plain text inside: never (audit 28.10. sec-001) – same rule as saving.
    if (isEncryptedNote(raw) && !isAgeBody(raw)) throw new PathError('Verschlüsselte Notiz: Inhalt ist kein age-Block');
    if (!isEncryptedNote(raw) && (await inEncryptedFolder(mount, this.dataPath, parentRel ? `${parentRel}/new.md` : 'new.md')))
      throw new ForbiddenError('Ziel ist ein verschlüsselter Ordner – die Notiz zuerst verschlüsseln');
    await mkdir(absPath(mount, this.dataPath, parentRel), { recursive: true });
    const rel = await uniquePath(mount, this.dataPath, parentRel, fileNameFor(fileName.replace(/\.(md|markdown)$/i, '')), '.md');
    if (!fileFilter(mount)(rel)) throw new ForbiddenError('Der Mount-Filter würde diese Notiz ausblenden');
    const content = mount.options.writeMetadata ? setFrontmatterKeys(raw, { id: ulid() }) : setFrontmatterKeys(raw, { id: undefined });
    await writeFile(absPath(mount, this.dataPath, rel), content, { flag: 'wx' });
    await this.manager.touched(mount, [rel], author, `docs: ${rel} importiert (Kaveyl Wiki)`);
    return rel;
  }

  /**
   * Import from another program (docs/PLAN-IMPORT.md): everything into a new folder `name` below `parent`, never over
   * existing notes, one commit. Not into encrypted folders; notes marked as encrypted and what the mount filter would
   * hide stay out (`skipped`). `report(folder, skipped)` = text of the report note written last into the folder.
   */
  async writeImport(
    mount: Mount,
    parent: string,
    name: string,
    notes: { path: string; content: string }[],
    files: { path: string; data(): Promise<Uint8Array> }[],
    author: Author,
    message: string,
    report: { name: string; text(folder: string, skipped: string[]): string; check?(folder: string): void },
  ): Promise<{ folder: string; written: string[]; skipped: string[] }> {
    this.assertWritable(mount);
    const parentRel = cleanRelPath(parent);
    if (await inEncryptedFolder(mount, this.dataPath, parentRel ? `${parentRel}/new.md` : 'new.md')) throw new ForbiddenError('Ziel ist ein verschlüsselter Ordner – dorthin lässt sich nichts importieren');
    await mkdir(absPath(mount, this.dataPath, parentRel), { recursive: true });
    const folder = await uniquePath(mount, this.dataPath, parentRel, fileNameFor(name), '');
    report.check?.(folder);
    await mkdir(absPath(mount, this.dataPath, folder));
    // All or nothing: a write that fails halfway (a broken entry in the ZIP, a full disk) takes the new folder away again.
    return this.manager.whileWriting(mount, folder, () =>
      this.fillImport(mount, folder, notes, files, author, message, report).catch(async (e: unknown) => {
        await rm(absPath(mount, this.dataPath, folder), { recursive: true, force: true });
        throw e;
      }),
    );
  }

  private async fillImport(
    mount: Mount,
    folder: string,
    notes: { path: string; content: string }[],
    files: { path: string; data(): Promise<Uint8Array> }[],
    author: Author,
    message: string,
    report: { name: string; text(folder: string, skipped: string[]): string },
  ): Promise<{ folder: string; written: string[]; skipped: string[] }> {
    const allow = fileFilter(mount);
    const written: string[] = [];
    const skipped: string[] = [];
    const put = async (path: string, data: string | Uint8Array) => {
      const rel = `${folder}/${cleanRelPath(path)}`;
      if (/\.md$/i.test(rel) && !allow(rel)) return void skipped.push(path);
      const abs = absPath(mount, this.dataPath, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, data, { flag: 'wx' });
      written.push(rel);
    };
    for (const n of notes) {
      if (isEncryptedNote(n.content)) {
        skipped.push(n.path);
        continue;
      }
      await put(n.path, setFrontmatterKeys(n.content, { id: mount.options.writeMetadata ? ulid() : undefined }));
    }
    for (const f of files) await put(f.path, await f.data());
    await put(report.name, report.text(folder, skipped));
    await this.manager.touched(mount, written, author, message);
    return { folder, written, skipped };
  }

  /** Plain notes must not land in an encrypted folder (they would sit there unencrypted). */
  private async assertNoPlainIntoEncrypted(src: Mount, fromRel: string, dst: Mount, toRel: string, isDir: boolean) {
    if (!(await inEncryptedFolder(dst, this.dataPath, toRel))) return;
    const encrypted = isDir ? await inEncryptedFolder(src, this.dataPath, `${fromRel}/x.md`) : isEncryptedNote((await this.readRaw(src, fromRel)) ?? '');
    if (!encrypted) throw new ForbiddenError(isDir ? 'Ziel ist ein verschlüsselter Ordner – den Ordner zuerst verschlüsseln' : 'Ziel ist ein verschlüsselter Ordner – die Notiz zuerst verschlüsseln');
  }

  /** Renames or moves a note or folder within the mount. Returns the new path. `readable` limits the files that come along. */
  async move(mount: Mount, from: string, to: string, author: Author, readable?: (ref: string) => boolean): Promise<string> {
    this.assertWritable(mount);
    const fromRel = cleanRelPath(from);
    const toRel = cleanRelPath(to);
    if (!fromRel || !toRel) throw new PathError('Ungültiger Pfad');
    if (toRel === fromRel) return toRel;
    if (toRel.startsWith(fromRel + '/')) throw new PathError('Ordner kann nicht in sich selbst verschoben werden');
    const src = absPath(mount, this.dataPath, fromRel);
    const dst = absPath(mount, this.dataPath, toRel);
    const st = await lstat(src).catch(() => null);
    if (st) await this.assertNoPlainIntoEncrypted(mount, fromRel, mount, toRel, st.isDirectory());
    if (!st) throw new NotFoundError(fromRel);
    if (await lstat(dst).catch(() => null)) throw new ConflictError(null, null);
    if (st.isFile() && !fileFilter(mount)(toRel)) throw new ForbiddenError('Der Mount-Filter würde die Notiz ausblenden');
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
    // An encrypted note into another folder: the server cannot rewrite the links inside its age block, so the files it
    // lists (encrypted attachments) are copied to the same place next to it – the old ones stay for other notes.
    const along: string[] = [];
    if (st.isFile() && posix.dirname(fromRel) !== posix.dirname(toRel)) {
      const raw = (await this.readRaw(mount, toRel)) ?? '';
      if (isEncryptedNote(raw)) along.push(...(await this.bringAlong(mount, fromRel, raw, mount, toRel, undefined, readable)).written);
    }
    await this.manager.touched(mount, [fromRel, toRel, ...along], author, `docs: ${fromRel} → ${toRel} verschoben (Kaveyl Wiki)`);
    // Rewrite links to the moved notes (and the moved notes' own relative links) right away,
    // so they land in the same commit batch (docs/PLAN.md §2.5).
    const moves: Move[] = [];
    if (st.isDirectory()) {
      await walk(dst, toRel, (f) => {
        if (fileFilter(mount)(f)) moves.push({ from: fromRel + f.slice(toRel.length), to: f });
      });
    } else moves.push({ from: fromRel, to: toRel });
    const now = Date.now();
    for (const [k, v] of this.moved) if (now - v.at > FOLLOW_MOVE_MS) this.moved.delete(k);
    for (const m of moves) this.moved.set(`${mount.id}\0${m.from}`, { to: m.to, at: now });
    await this.repairLinks(mount, moves, author, st.isDirectory() ? [{ from: fromRel, to: toRel }] : []);
    await renameInOrder(this.manager, this.dataPath, mount, fromRel, toRel, author).catch(() => undefined);
    return toRel;
  }

  /**
   * Rewrites links broken by renames: links pointing at a moved note, and relative links
   * inside moved notes. Each link keeps its file's style (relative/absolute, with or
   * without `.md`, folder link, anchor, encoding). Links that still work, external links and
   * links that were already broken are left alone. `dirMoves` maps whole folders (so files
   * that are not notes, e.g. images, are found at their new place).
   * With `dryRun` nothing is written; the result tells how many links would change.
   * With `onlyMoved` only the files at the `to` side are rewritten (used for copies).
   */
  async repairLinks(
    mount: Mount,
    moves: Move[],
    author: Author,
    dirMoves: Move[] = [],
    opts: { dryRun?: boolean; message?: string; onlyMoved?: boolean } = {},
  ): Promise<{ files: string[]; links: number }> {
    if (mount.options.readonly || (!moves.length && !dirMoves.length)) return { files: [], links: 0 };
    const folderNote = mount.options.folderNote;
    const visible = fileFilter(mount);
    const newOf = new Map(moves.map((m) => [m.from, m.to]));
    const oldOf = new Map(moves.map((m) => [m.to, m.from]));
    const viaDir = (p: string, dir: (m: Move) => [string, string]) => {
      for (const m of dirMoves) {
        const [a, b] = dir(m);
        if (p === a || p.startsWith(a + '/')) return b + p.slice(a.length);
      }
      return null;
    };
    const mapNew = (p: string) => newOf.get(p) ?? viaDir(p, (m) => [m.from, m.to]);
    const mapOld = (p: string) => oldOf.get(p) ?? viaDir(p, (m) => [m.to, m.from]) ?? p;
    const isFile = async (p: string) => !!(await lstat(absPath(mount, this.dataPath, p)).catch(() => null))?.isFile();
    // Which file does `path` (as written in a link) mean? The path itself or a note candidate.
    const candidatesOf = (path: string) => [...new Set([path, ...noteCandidates(path, folderNote)].filter(Boolean))];
    const target = async (path: string, inOldWorld: boolean): Promise<{ file: string; folder: boolean } | null> => {
      for (const c of candidatesOf(path)) {
        const folder = c !== path && !/\.md$/i.test(path) && c.endsWith(folderNote) && c !== `${path}.md`;
        const moved = inOldWorld ? mapNew(c) : null;
        if (moved && (await isFile(moved))) return { file: moved, folder };
        if (await isFile(c)) return { file: c, folder };
      }
      return null;
    };

    // `onlyMoved` (copies): only the new files are fixed; links elsewhere keep the originals.
    const sources = new Set(
      opts.onlyMoved ? [] : this.indexer.linkSources(mount.id, [...moves.flatMap((m) => this.indexer.linkKeys(mount, m.from)), ...dirMoves.map((m) => m.from)]),
    );
    for (const m of moves) sources.add(m.to);
    const files: string[] = [];
    let links = 0;
    for (const src of sources) {
      if (!visible(src)) continue;
      // Read, edit and write under the file's lock: a save in between must not be overwritten.
      await this.locked(mount, src, async () => {
        const raw = await this.readRaw(mount, src).catch(() => null);
        if (raw === null) return;
        const oldSrc = mapOld(src);
        const edits: { start: number; end: number; text: string }[] = [];
        // A note too large or too nested for the parser (sec-006) keeps its links as they are.
        for (const l of (await markdown.links(raw)) ?? []) {
          const before = resolveHref(l.href, oldSrc);
          if (!before) continue;
          const meant = await target(before.path, true);
          if (!meant) continue; // was already broken (or points outside) — fsck reports it
          const now = resolveHref(l.href, src);
          const reached = now ? await target(now.path, false) : null;
          if (reached?.file === meant.file) continue;
          if (!(await isFile(meant.file))) continue;
          edits.push({ start: l.start, end: l.end, text: formatLink(l.raw, src, meant.file, folderNote, before.anchor, meant.folder) });
        }
        if (!edits.length) return;
        links += edits.length;
        files.push(src);
        if (opts.dryRun) return;
        let next = raw;
        for (const e of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
        await atomicWrite(absPath(mount, this.dataPath, src), next);
      });
    }
    if (files.length && !opts.dryRun) {
      await this.manager.touched(mount, files, author, opts.message);
      this.manager.announce(mount, files);
    }
    return { files, links };
  }

  /**
   * Moves a note or the notes of a folder into another mount: copy everything first, then
   * delete the notes in the source — a failure in between leaves a duplicate, never a loss.
   * Local files the notes reference (images, PDFs …) are copied along and stay in the
   * source, since other notes may still use them (the link index arrives in Phase 2).
   * Git history stays in the source repository; each side commits through touched().
   * Linked files come along only if `readable` and servable (as in bringAlong()).
   */
  /**
   * `rules.before` runs after all checks, before the first file is copied; `rules.placed` once the copies are in `dst`
   * and indexed – both before anything goes at the old place (rules follow, sec2-014/015).
   */
  async moveAcross(
    src: Mount,
    dst: Mount,
    from: string,
    to: string,
    author: Author,
    readable: (ref: string) => boolean = () => true,
    rules: { before(path: string): void; placed(): void } = { before: () => undefined, placed: () => undefined },
  ): Promise<{ path: string; warnings: string[] }> {
    this.assertWritable(src);
    this.assertWritable(dst);
    const fromRel = cleanRelPath(from);
    const toRel = cleanRelPath(to);
    if (!fromRel || !toRel) throw new PathError('Ungültiger Pfad');
    const srcAbs = absPath(src, this.dataPath, fromRel);
    const st = await lstat(srcAbs).catch(() => null);
    if (!st) throw new NotFoundError(fromRel);
    if (await lstat(absPath(dst, this.dataPath, toRel)).catch(() => null)) throw new ConflictError(null, null);
    await this.assertNoPlainIntoEncrypted(src, fromRel, dst, toRel, st.isDirectory());

    const visible = fileFilter(src);
    const notes: string[] = [];
    /**
     * Files of a moved folder that belong to it without a readable link: its settings (`.kaveyl-wiki.yml`, e.g. the
     * encryption mark) and encrypted attachments (`assets/….age`) of notes sealed before they listed their files.
     * Everything else that is no note (code, other files) stays.
     */
    const folderFiles: string[] = [];
    const belongs = (f: string) => posix.basename(f) === '.kaveyl-wiki.yml' || (f.endsWith('.age') && f.split('/').slice(0, -1).includes('assets'));
    if (st.isFile()) {
      if (!visible(fromRel)) throw new ForbiddenError('not a note');
      notes.push(fromRel);
    } else if (st.isDirectory()) {
      await walk(srcAbs, fromRel, (f) => {
        if (visible(f)) notes.push(f);
        else if (belongs(f)) folderFiles.push(f);
      });
    } else throw new ForbiddenError('not a note');
    // Every source path maps into the target relative to the moved root (file: its folder).
    const base = st.isFile() ? posix.dirname(fromRel) : fromRel;
    const targetBase = st.isFile() ? posix.dirname(toRel) : toRel;
    const mapPath = (rel: string): string | null => {
      const inside = base === '.' ? rel : posix.relative(base, rel);
      if (inside.startsWith('..')) return null;
      return cleanRelPath(targetBase === '.' ? inside : `${targetBase}/${inside}`);
    };
    const copies = new Map<string, string>(); // source rel → target rel
    for (const n of notes) copies.set(n, st.isFile() ? toRel : mapPath(n)!);
    for (const f of folderFiles) copies.set(f, mapPath(f)!);
    const dstVisible = fileFilter(dst);
    for (const n of notes) {
      const t = copies.get(n)!;
      if (!dstVisible(t)) throw new ForbiddenError(`Der Filter der Ziel-Quelle würde „${t}“ ausblenden`);
    }

    const warnings: string[] = [];
    for (const n of notes) {
      const raw = await readFile(absPath(src, this.dataPath, n), 'utf8');
      for (const ref of await localReferences(raw, n)) {
        if (copies.has(ref) || visible(ref)) continue; // notes are moved themselves or stay put
        if (!readable(ref) || !isServable(ref)) continue; // as in bringAlong()
        const refAbs = absPath(src, this.dataPath, ref);
        if (!(await lstat(refAbs).catch(() => null))?.isFile()) continue;
        const target = mapPath(ref);
        if (!target) {
          warnings.push(`„${ref}“ liegt außerhalb des verschobenen Bereichs und wurde nicht mitkopiert`);
          continue;
        }
        if (await lstat(absPath(dst, this.dataPath, target)).catch(() => null)) {
          warnings.push(`„${target}“ existiert im Ziel bereits und wurde nicht überschrieben`);
          continue;
        }
        copies.set(ref, target);
      }
    }

    rules.before(toRel);
    for (const [s, t] of copies) {
      const out = absPath(dst, this.dataPath, t);
      await mkdir(dirname(out), { recursive: true });
      await copyFile(absPath(src, this.dataPath, s), out, fsc.COPYFILE_EXCL);
    }
    await this.manager.touched(dst, [toRel, ...[...copies.values()].filter((t) => t !== toRel)], author, `docs: ${toRel} aus „${src.name}“ hierher verschoben (Kaveyl Wiki)`);
    rules.placed();
    for (const n of notes) await unlink(absPath(src, this.dataPath, n));
    // The folder's settings went along. Files inside a moved folder (its images) go too, unless a note that stays
    // links to them; files outside it and other files stay – notes elsewhere may still link to them.
    for (const f of folderFiles) if (posix.basename(f) === '.kaveyl-wiki.yml') await unlink(absPath(src, this.dataPath, f));
    if (st.isDirectory()) {
      const gone = new Set(notes);
      const stillLinked = new Set(this.indexer.allLinks(src.id).filter((l) => !gone.has(l.src)).map((l) => l.target));
      for (const f of copies.keys()) {
        if (gone.has(f) || !f.startsWith(fromRel + '/') || stillLinked.has(f)) continue;
        await unlink(absPath(src, this.dataPath, f)).catch(() => undefined);
      }
    }
    if (st.isDirectory()) await removeEmptyDirs(srcAbs);
    await this.manager.touched(src, [fromRel], author, `docs: ${fromRel} nach „${dst.name}“ verschoben (Kaveyl Wiki)`);
    this.manager.announce(src, notes);
    return { path: toRel, warnings };
  }

  /**
   * Copies a note or a folder into `toParent` of `dst` (same or another mount). The copy gets
   * the source's name, or „name (Kopie)“ / „name (Kopie 2)“ … when that is taken. A folder is
   * copied with everything in it (also `.kaveyl-wiki.yml`, images); a note takes the local files it
   * references along (skipped when the target already has a file there). Every copied note gets
   * a fresh `id` (ACL rules and links follow ids), and links inside the copies are rewritten so
   * they still reach the same notes — links elsewhere keep pointing at the originals.
   * `canRead` filters out files the user may not read (ACL below the copied folder).
   */
  async copy(
    src: Mount,
    dst: Mount,
    from: string,
    toParent: string,
    author: Author,
    canRead: (rel: string) => boolean = () => true,
  ): Promise<{ path: string; warnings: string[] }> {
    this.assertWritable(dst);
    const fromRel = cleanRelPath(from);
    const parentRel = toParent ? cleanRelPath(toParent) : '';
    if (!fromRel) throw new PathError('Ungültiger Pfad');
    const srcAbs = absPath(src, this.dataPath, fromRel);
    const st = await lstat(srcAbs).catch(() => null);
    if (!st || !(st.isFile() || st.isDirectory())) throw new NotFoundError(fromRel);
    const visible = fileFilter(src);
    if (st.isFile() && !visible(fromRel)) throw new ForbiddenError('not a note');
    const name = posix.basename(fromRel);
    const ext = st.isFile() ? posix.extname(name) : '';
    const stem = ext ? name.slice(0, -ext.length) : name;
    let toRel = '';
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? name : `${stem} (Kopie${i === 2 ? '' : ` ${i - 1}`})${ext}`;
      toRel = parentRel ? `${parentRel}/${candidate}` : candidate;
      if (!(await lstat(absPath(dst, this.dataPath, toRel)).catch(() => null))) break;
    }
    await this.assertNoPlainIntoEncrypted(src, fromRel, dst, toRel, st.isDirectory());

    const copies = new Map<string, string>(); // source rel → target rel
    const warnings: string[] = [];
    let hidden = 0;
    let skipped = 0;
    if (st.isDirectory()) {
      const files: string[] = [];
      await walk(srcAbs, fromRel, (f) => files.push(f));
      for (const f of files) {
        if (!canRead(f)) {
          if (visible(f)) hidden++; // images and attachments in hidden folders stay behind too
          continue;
        }
        // Only what makes up the notes (owner 2026-10-16): notes, folder settings, images and attachments –
        // no code, configuration or other dotfiles that happen to lie in the folder.
        if (!visible(f) && posix.basename(f) !== '.kaveyl-wiki.yml' && !isServable(f)) {
          skipped++;
          continue;
        }
        copies.set(f, `${toRel}${f.slice(fromRel.length)}`);
      }
    } else {
      copies.set(fromRel, toRel);
      const raw = await readFile(srcAbs, 'utf8');
      const base = posix.dirname(fromRel);
      const targetBase = posix.dirname(toRel);
      for (const ref of await localReferences(raw, fromRel)) {
        if (visible(ref)) continue; // linked notes are not copied along
        if (!canRead(ref) || !isServable(ref)) continue; // as in bringAlong()
        if (!(await lstat(absPath(src, this.dataPath, ref)).catch(() => null))?.isFile()) continue;
        const inside = base === '.' ? ref : posix.relative(base, ref);
        if (inside.startsWith('..')) {
          if (src.id !== dst.id) warnings.push(`„${ref}“ liegt außerhalb des Ordners der Notiz und wurde nicht mitkopiert`);
          continue;
        }
        const target = cleanRelPath(targetBase === '.' ? inside : `${targetBase}/${inside}`);
        if (src.id === dst.id && target === ref) continue; // same place: the copy uses the same file
        if (await lstat(absPath(dst, this.dataPath, target)).catch(() => null)) {
          warnings.push(`„${target}“ existiert im Ziel bereits und wurde nicht überschrieben`);
          continue;
        }
        copies.set(ref, target);
      }
    }
    if (hidden) warnings.push(`${hidden} Notiz(en) ohne Leserecht wurden nicht mitkopiert`);
    if (skipped) warnings.push(`${skipped} andere Datei(en) wurden nicht mitkopiert – nur Notizen, Bilder und Anhänge`);
    const dstVisible = fileFilter(dst);
    for (const [s, t] of copies) {
      if (visible(s) && !dstVisible(t)) throw new ForbiddenError(`Der Filter der Ziel-Quelle würde „${t}“ ausblenden`);
    }

    for (const [s, t] of copies) {
      const out = absPath(dst, this.dataPath, t);
      await mkdir(dirname(out), { recursive: true });
      if (!visible(s)) {
        await copyFile(absPath(src, this.dataPath, s), out, fsc.COPYFILE_EXCL);
        continue;
      }
      // A note: fresh id (or none, when the target writes no metadata).
      const raw = await readFile(absPath(src, this.dataPath, s), 'utf8');
      const next = dst.options.writeMetadata ? setFrontmatterKeys(raw, { id: ulid() }) : setFrontmatterKeys(raw, { id: undefined });
      await writeFile(out, next, { flag: 'wx' });
    }
    if (st.isDirectory()) await mkdir(absPath(dst, this.dataPath, toRel), { recursive: true });
    await this.manager.touched(dst, [toRel, ...[...copies.values()].filter((t) => t !== toRel)], author, `docs: ${toRel} kopiert (Kaveyl Wiki)`);
    // Relative links inside the copies: same mount → point at the same notes again (or at the
    // copied ones inside a copied folder); another mount → only links within the copy work.
    if (src.id === dst.id) {
      const moves = [...copies].map(([from, to]) => ({ from, to }));
      await this.repairLinks(dst, moves, author, st.isDirectory() ? [{ from: fromRel, to: toRel }] : [], { onlyMoved: true });
    }
    return { path: toRel, warnings };
  }

  /**
   * Speichern als (AD-039): writes `raw` — a note's content from elsewhere (an old version, the
   * trash, a backup) whose place was `src`/`fromRel` — as the new note `dst`/`to` (`.md` is added).
   * Nothing is overwritten (ConflictError). The note gets a fresh id, the files it links to come
   * along like with copy(), and within the same source its relative links are rewritten so they
   * reach the same files. `missing(ref)` supplies linked files that are gone from the source.
   * `readable(ref)`: only these linked files come along (`raw` from the browser may point anywhere).
   */
  async saveNoteAs(
    src: Mount | null,
    fromRel: string,
    raw: string,
    dst: Mount,
    to: string,
    author: Author,
    message: string,
    missing?: (ref: string) => Promise<Buffer | null>,
    readable?: (ref: string) => boolean,
  ): Promise<{ path: string; warnings: string[] }> {
    this.assertWritable(dst);
    const toRel = this.newNotePath(dst, to);
    const abs = absPath(dst, this.dataPath, toRel);
    if (await lstat(abs).catch(() => null)) throw new ConflictError(null, null);
    if (!isEncryptedNote(raw) && (await inEncryptedFolder(dst, this.dataPath, toRel))) {
      throw new ForbiddenError('Ziel ist ein verschlüsselter Ordner – dort lässt sich keine unverschlüsselte Notiz ablegen');
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, dst.options.writeMetadata ? setFrontmatterKeys(raw, { id: ulid() }) : setFrontmatterKeys(raw, { id: undefined }), { flag: 'wx' });
    const along = await this.bringAlong(src, cleanRelPath(fromRel), raw, dst, toRel, missing, readable);
    await this.manager.touched(dst, [toRel, ...along.written], author, message);
    if (src?.id === dst.id) await this.repairLinks(dst, [{ from: cleanRelPath(fromRel), to: toRel }, ...along.moves], author, [], { onlyMoved: true });
    return { path: toRel, warnings: along.warnings };
  }

  /** Path of a new note: cleaned, `.md` added, visible in the source (else ForbiddenError). */
  private newNotePath(mount: Mount, to: string): string {
    let rel = cleanRelPath(to.trim());
    if (!rel || rel.endsWith('/')) throw new PathError('Bitte einen Dateinamen angeben');
    if (!/\.md$/i.test(rel)) rel = `${rel}.md`;
    if (!fileFilter(mount)(rel)) throw new ForbiddenError(`Der Filter der Quelle würde „${rel}“ ausblenden`);
    return rel;
  }

  /**
   * Files a note from `src`/`fromRel`, now at `dst`/`toRel`, links to (images, attachments — not
   * notes): those inside its folder are copied to the same place next to the new note; files gone
   * from the source come from `missing` (a version, a backup). Existing files are never replaced.
   * Not committed — the caller commits `written`; `moves` feed repairLinks().
   */
  private async bringAlong(src: Mount | null, fromRel: string, raw: string, dst: Mount, toRel: string, missing?: (ref: string) => Promise<Buffer | null>, readable?: (ref: string) => boolean) {
    const isNote = fileFilter(src ?? dst);
    const base = posix.dirname(fromRel);
    const targetBase = posix.dirname(toRel);
    const written: string[] = [];
    const moves: Move[] = [];
    const warnings: string[] = [];
    for (const ref of await localReferences(raw, fromRel)) {
      if (isNote(ref)) continue; // linked notes are not copied along
      // Only what the user may read and /api/files would serve (not .env or code).
      if ((readable && !readable(ref)) || !isServable(ref)) continue;
      const inside = base === '.' ? ref : posix.relative(base, ref);
      if (inside.startsWith('..')) {
        if (src?.id !== dst.id) warnings.push(`„${ref}“ liegt außerhalb des Ordners der Notiz und wurde nicht mitkopiert`);
        continue;
      }
      const target = cleanRelPath(targetBase === '.' ? inside : `${targetBase}/${inside}`);
      const here = src && (await lstat(absPath(src, this.dataPath, ref)).catch(() => null))?.isFile() ? absPath(src, this.dataPath, ref) : null;
      if (src?.id === dst.id && target === ref && here) continue; // same place: the note uses the same file
      const out = absPath(dst, this.dataPath, target);
      if (await lstat(out).catch(() => null)) {
        if (target !== ref || src?.id !== dst.id) warnings.push(`„${target}“ existiert im Ziel bereits und wurde nicht überschrieben`);
        continue;
      }
      const data = here ? null : missing ? await missing(ref).catch(() => null) : null;
      if (!here && !data) {
        warnings.push(`„${ref}“ gibt es nicht mehr und wurde nicht mitkopiert`);
        continue;
      }
      await mkdir(dirname(out), { recursive: true });
      if (here) await copyFile(here, out, fsc.COPYFILE_EXCL);
      else await writeFile(out, data!, { flag: 'wx' });
      written.push(target);
      if (target !== ref) moves.push({ from: ref, to: target });
    }
    return { written, moves, warnings };
  }

  /**
   * Writes files restored from a backup (AD-038): each atomically, existing ones replaced (Git keeps
   * the old state), nothing deleted. `freshIds`: notes get a new id (a copy next to the original).
   * Plain notes are not written into an encrypted folder; those are returned as skipped.
   */
  async writeRestored(mount: Mount, files: { rel: string; data: Buffer }[], author: Author, message: string, opts: { freshIds?: boolean } = {}): Promise<{ written: string[]; skipped: string[] }> {
    this.assertWritable(mount);
    const written: string[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const rel = cleanRelPath(f.rel);
      if (!rel) continue;
      let data: Buffer | string = f.data;
      if (/\.md$/i.test(rel)) {
        const text = f.data.toString('utf8');
        if (!isEncryptedNote(text) && (await inEncryptedFolder(mount, this.dataPath, rel))) {
          skipped.push(rel);
          continue;
        }
        if (opts.freshIds && /^---\r?\n/.test(text)) data = mount.options.writeMetadata ? setFrontmatterKeys(text, { id: ulid() }) : setFrontmatterKeys(text, { id: undefined });
      }
      const abs = absPath(mount, this.dataPath, rel);
      await mkdir(dirname(abs), { recursive: true });
      await atomicWrite(abs, data);
      written.push(rel);
    }
    if (written.length) await this.manager.touched(mount, written, author, message);
    return { written, skipped };
  }

  /** Versions of a note from git (empty when the mount is not a git repository). */
  async history(mount: Mount, path: string): Promise<{ git: boolean; versions: Version[] }> {
    const rel = this.notePath(mount, path);
    const root = contentRoot(mount, this.dataPath);
    if ((await repoPrefix(root)) === null) return { git: false, versions: [] };
    return { git: true, versions: await fileHistory(root, rel) };
  }

  /** Content of a note in a given version (`versionPath` = its path in that commit). */
  async version(mount: Mount, commit: string, versionPath: string): Promise<string> {
    // Only notes (Markdown, inside the mount filter, no dotfiles) – not .env or code from the history.
    const raw = await fileAt(contentRoot(mount, this.dataPath), commit, this.notePath(mount, versionPath));
    if (raw === null) throw new NotFoundError(versionPath);
    return raw;
  }

  /** Unified diff from one version to another; `to: null` means the current file. */
  async diff(mount: Mount, path: string, from: { commit: string; path: string } | null, to: { commit: string; path: string } | null): Promise<string> {
    const before = from ? await this.version(mount, from.commit, from.path) : '';
    const after = to ? await this.version(mount, to.commit, to.path) : ((await this.readRaw(mount, this.notePath(mount, path))) ?? '');
    return textDiff(before, after);
  }

  /**
   * Restores an old version as a new change (history is never rewritten). `baseHash`
   * guards against overwriting edits made in the meantime, like a normal save.
   */
  async restoreVersion(mount: Mount, path: string, commit: string, versionPath: string, baseHash: string, author: Author): Promise<{ hash: string }> {
    return this.locked(mount, path, () => this.restoreVersionNow(mount, path, commit, versionPath, baseHash, author));
  }

  private async restoreVersionNow(mount: Mount, path: string, commit: string, versionPath: string, baseHash: string, author: Author): Promise<{ hash: string }> {
    this.assertWritable(mount);
    const rel = this.notePath(mount, path);
    const current = await this.readRaw(mount, rel);
    if (current === null) throw new NotFoundError(rel);
    if (sha1(current) !== baseHash) throw new ConflictError(sha1(current), current);
    const old = await this.version(mount, commit, versionPath);
    // Same rule as saveRaw: a version from before the encryption would put plaintext back into Git, the index and the AI.
    if (!isEncryptedNote(old) && (isEncryptedNote(current) || (await inEncryptedFolder(mount, this.dataPath, rel)))) {
      throw new ForbiddenError('Diese Version ist unverschlüsselt – sie lässt sich nicht in die verschlüsselte Notiz zurückholen. „Speichern als“ legt sie außerhalb eines verschlüsselten Ordners ab.');
    }
    const result = await this.writeIfChanged(mount, rel, current, old, author, `docs: ${rel} auf Version ${commit.slice(0, 7)} zurückgesetzt (Kaveyl Wiki)`);
    return { hash: result.hash };
  }

  /**
   * Where deleting puts notes (AD-025): with auto-commit in a repository the git history is
   * the trash; otherwise Kaveyl Wiki moves them into `.kaveyl-wiki/trash/` of the source.
   */
  async trashMode(mount: Mount): Promise<'git' | 'folder'> {
    return mount.options.autoCommit && (await repoPrefix(contentRoot(mount, this.dataPath))) !== null ? 'git' : 'folder';
  }

  /**
   * Trash of a source, newest first: the folder trash and notes deleted in git history that
   * do not exist anymore. Git entries from before `hideBefore` are left out (emptied/expired).
   */
  async trash(mount: Mount, hideBefore: Date | null = null): Promise<TrashItem[]> {
    const root = contentRoot(mount, this.dataPath);
    const visible = fileFilter(mount);
    const present = new Set<string>();
    await walk(root, '', (f) => present.add(f));
    const fromGit = gitItems((await deletedNotes(root, (p) => present.has(p))).filter((d) => visible(d.path) && (!hideBefore || new Date(d.date) >= hideBefore)));
    return [...(await folderItems(root)), ...fromGit].sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Brings notes of a trash entry back at their old place (all, or only `paths`), or with `as`
   * under another name so nothing in the way is overwritten (`restoreTargets`). Git entries get
   * the content they had before deletion as a new change. A note restored under another name
   * gets a fresh `id` when it carries one — the original may still exist (ids must be unique).
   * `readable(ref)`: only these linked files of `mount` come along (see saveNoteAs).
   */
  async restoreFromTrash(
    mount: Mount,
    id: string,
    paths: string[] | undefined,
    author: Author,
    as?: string,
    dst: Mount = mount,
    readable?: (ref: string) => boolean,
  ): Promise<{ paths: string[]; warnings: string[] }> {
    this.assertWritable(dst);
    const root = contentRoot(mount, this.dataPath);
    const only = paths?.map(cleanRelPath);
    const item = (await this.trash(mount)).find((t) => t.id === id);
    if (!item) throw new NotFoundError(id);
    const files = only ? item.files.filter((f) => only.includes(f)) : item.files;
    if (!files.length) throw new NotFoundError(id);
    let target = (f: string) => f;
    if (as !== undefined) {
      const dest = cleanRelPath(as.trim());
      if (!dest) throw new PathError('Bitte einen Namen angeben');
      const map = restoreTargets(item.path, files, dest, item.isDir && !only);
      target = (f) => cleanRelPath(map(f));
      const visible = fileFilter(dst);
      for (const f of files) {
        const t = target(f);
        if (!t || !visible(t)) throw new ForbiddenError(`Der Filter der Quelle würde „${t}“ ausblenden`);
      }
    }
    // Plain notes never land in an encrypted folder – also not at their old place, if the folder was encrypted since.
    const isNote = fileFilter(dst);
    const gitCommit = id.startsWith('git:') ? id.slice('git:'.length) : '';
    for (const f of files) {
      const t = target(f);
      if (!isNote(t) || !(await inEncryptedFolder(dst, this.dataPath, t))) continue;
      const data = id.startsWith('folder:') ? await folderTrashFile(root, id.slice('folder:'.length), f) : gitCommit ? await fileAt(root, gitCommit, f, true) : null;
      if (data !== null && !isEncryptedNote(data.toString())) {
        throw new ForbiddenError(`„${t}“ läge unverschlüsselt in einem verschlüsselten Ordner – mit „Speichern als“ woanders wiederherstellen`);
      }
    }
    let restored: string[];
    if (id.startsWith('folder:')) {
      const res = await restoreFromFolder(root, id.slice('folder:'.length), files, target, contentRoot(dst, this.dataPath));
      if (res.conflicts.length) throw new ConflictError(null, null);
      restored = res.restored;
    } else {
      const commit = id.startsWith('git:') ? id.slice('git:'.length) : '';
      if (!commit) throw new NotFoundError(id);
      const raws = await Promise.all(files.map(async (f) => [f, await fileAt(root, commit, f, true)] as const));
      for (const [f] of raws) if (await lstat(absPath(dst, this.dataPath, target(f))).catch(() => null)) throw new ConflictError(null, null);
      restored = [];
      for (const [f, raw] of raws) {
        if (raw === null) continue;
        const abs = absPath(dst, this.dataPath, target(f));
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, raw, { flag: 'wx' });
        restored.push(target(f));
      }
    }
    if (!restored.length) throw new NotFoundError(id);
    const along = { written: [] as string[], moves: [] as Move[], warnings: [] as string[] };
    if (as !== undefined) {
      for (const p of restored) {
        const abs = absPath(dst, this.dataPath, p);
        const raw = await readFile(abs, 'utf8').catch(() => null);
        if (raw === null || isEncryptedNote(raw)) continue;
        if (readFrontmatter(splitFrontmatter(raw).frontmatter).id !== undefined) await writeFile(abs, setFrontmatterKeys(raw, { id: ulid() }));
      }
      // One note under a new name: what it links to comes along (from before the deletion if gone).
      if (files.length === 1 && restored.length === 1) {
        const raw = await readFile(absPath(dst, this.dataPath, restored[0]!), 'utf8').catch(() => '');
        const commit = id.startsWith('git:') ? id.slice('git:'.length) : '';
        const missing = commit ? (ref: string) => fileBytesAt(root, commit, ref, true) : undefined;
        Object.assign(along, await this.bringAlong(mount, files[0]!, raw, dst, restored[0]!, missing, readable));
      }
    }
    const what = as !== undefined ? `${files.join(', ')} als ${restored.join(', ')}` : restored.join(', ');
    const from = dst.id !== mount.id ? ` aus „${mount.name}“` : '';
    await this.manager.touched(dst, [...restored, ...along.written], author, `docs: ${what}${from} wiederhergestellt (Kaveyl Wiki)`);
    if (as !== undefined && dst.id === mount.id) {
      const moves = files.map((f) => ({ from: f, to: target(f) })).filter((m) => m.from !== m.to && restored.includes(m.to));
      await this.repairLinks(dst, [...moves, ...along.moves], author, [], { onlyMoved: true });
    }
    return { paths: restored, warnings: along.warnings };
  }

  /** Deletes a folder-trash entry for good (git entries can only be hidden, by the caller). */
  async purgeFromTrash(mount: Mount, id: string): Promise<void> {
    this.assertWritable(mount);
    if (!id.startsWith('folder:') || !(await purgeFolderItem(contentRoot(mount, this.dataPath), id.slice('folder:'.length)))) throw new NotFoundError(id);
  }

  /** What the folder trash (`.kaveyl-wiki/trash`) of a source holds: entries and bytes (Löschregeln). */
  async folderTrashUsage(mount: Mount): Promise<{ entries: number; size: number }> {
    const root = contentRoot(mount, this.dataPath);
    const size = throughSymlink(root, TRASH_DIR) ? 0 : await dirSize(join(root, ...TRASH_DIR.split('/'))); // never through a link (AD-047)
    return { entries: (await folderItems(root)).length, size };
  }

  /** Deletes folder-trash entries older than `cutoff` (all with `null`); returns how many. */
  async purgeTrash(mount: Mount, cutoff: Date | null): Promise<number> {
    return purgeFolderTrash(contentRoot(mount, this.dataPath), cutoff);
  }

  /** Whether a new note at `rel` would land in an encrypted folder (plaintext may not go there). */
  inEncryptedFolder(mount: Mount, rel: string): Promise<boolean> {
    return inEncryptedFolder(mount, this.dataPath, rel);
  }

  /**
   * Deletes a note, or the notes inside a folder, into the trash (AD-025). Only visible
   * Markdown files are removed; other files (code, assets) stay, so deleting a folder in a
   * code repo never removes code.
   */
  async delete(mount: Mount, path: string, author: Author): Promise<void> {
    this.assertWritable(mount);
    const rel = cleanRelPath(path);
    if (!rel) throw new PathError('Mount-Wurzel kann nicht gelöscht werden');
    const abs = absPath(mount, this.dataPath, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st) throw new NotFoundError(rel);
    const visible = fileFilter(mount);
    const files: string[] = [];
    if (st.isFile()) {
      if (!visible(rel)) throw new ForbiddenError('not a note');
      files.push(rel);
    } else if (st.isDirectory()) {
      await walk(abs, rel, (f) => {
        if (visible(f)) files.push(f);
      });
    }
    const gitTrash = (await this.trashMode(mount)) === 'git';
    // The git trash only knows what is in the history: a note still waiting for its commit (e.g. created moments
    // ago) goes in first, else it would be gone for good (owner 27.10.).
    if (gitTrash && files.length) await this.manager.commitPendingNow(mount);
    // An empty folder leaves nothing for the trash: it is simply removed.
    if (files.length && !gitTrash) await moveToTrash(contentRoot(mount, this.dataPath), rel, st.isDirectory(), files, author.name);
    else for (const f of files) await unlink(absPath(mount, this.dataPath, f));
    if (st.isDirectory()) await removeEmptyDirs(abs);
    await this.manager.touched(mount, [rel], author, `docs: ${rel} gelöscht (Kaveyl Wiki)`);
    // …and the deletion is committed at once, so the trash shows it right away (not only after the commit pause).
    if (gitTrash && files.length) await this.manager.commitPendingNow(mount);
    // Whoever has one of them open learns it at once (team test 23.10.), not only when saving.
    this.manager.announce(mount, files);
  }

  /** Saves of one file run one after the other: the hash check and the write must not interleave. */
  private locked<T>(mount: Mount, path: string, fn: () => Promise<T>): Promise<T> {
    return this.manager.locked(mount, path, fn);
  }

  private async writeIfChanged(mount: Mount, rel: string, current: string, next: string, author: Author, message?: string) {
    if (next === current) return { hash: sha1(current), changed: false };
    await atomicWrite(absPath(mount, this.dataPath, rel), next);
    await this.manager.touched(mount, [rel], author, message);
    // Everyone else with the note open sees it at once (the saving editor recognizes its own hash).
    this.manager.announce(mount, [rel]);
    return { hash: sha1(next), changed: true };
  }

  private async readRaw(mount: Mount, rel: string): Promise<string | null> {
    const abs = absPath(mount, this.dataPath, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) return null;
    try {
      // Non-UTF-8 files would be corrupted by a round-trip through the editor.
      return UTF8.decode(await readFile(abs));
    } catch (e) {
      if (e instanceof TypeError) throw new ForbiddenError('Datei ist kein gültiges UTF-8 und kann nicht bearbeitet werden');
      throw e;
    }
  }

  private notePath(mount: Mount, path: string): string {
    const rel = cleanRelPath(path);
    if (!fileFilter(mount)(rel)) throw new NotFoundError(rel);
    return rel;
  }

  private assertWritable(mount: Mount) {
    if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  }
}


async function uniquePath(mount: Mount, dataPath: string, parent: string, base: string, ext: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base} ${i}${ext}`;
    const rel = parent ? `${parent}/${name}` : name;
    if (!(await lstat(absPath(mount, dataPath, rel)).catch(() => null))) return rel;
  }
}

export async function atomicWrite(abs: string, content: string | Uint8Array) {
  const tmp = join(dirname(abs), `.kaveyl-wiki-tmp-${randomBytes(6).toString('hex')}`);
  const mode = (await lstat(abs).catch(() => null))?.mode;
  await writeFile(tmp, content, { mode: mode !== undefined ? mode & 0o777 : 0o644 });
  try {
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function removeEmptyDirs(abs: string): Promise<boolean> {
  const items = await readdir(abs, { withFileTypes: true }).catch(() => null);
  if (!items) return false;
  let empty = true;
  for (const item of items) {
    if (item.isDirectory() && !item.isSymbolicLink()) {
      if (!(await removeEmptyDirs(join(abs, item.name)))) empty = false;
    } else {
      empty = false;
    }
  }
  if (empty) await rmdir(abs).catch(() => (empty = false));
  return empty;
}

/**
 * Local files a note points to (images, links, reference definitions), as paths relative to
 * the mount root. External URLs, absolute paths and anchors are ignored.
 */
export async function localReferences(raw: string, notePath: string): Promise<string[]> {
  const out = new Set<string>();
  const dir = posix.dirname(notePath);
  const add = (href: string) => {
    const url = href.split(/[?#]/)[0]!;
    // Web addresses (also without https://, „www.…“) are no files next to the note.
    if (!url || isExternal(url) || url.startsWith('/')) return;
    let decoded = url;
    try {
      decoded = decodeURI(url);
    } catch {
      /* keep as written */
    }
    const rel = posix.normalize(dir === '.' ? decoded : `${dir}/${decoded}`);
    if (!rel.startsWith('..')) out.add(rel);
  };
  // Encrypted note: the body is unreadable here, the browser lists the files in the frontmatter (core/encrypted.ts).
  if (isEncryptedNote(raw)) {
    for (const href of listedAttachments(raw) ?? []) add(href);
    return [...out];
  }
  // Markdown links, images, definitions and `<img src>` (resized images) – parsed in the worker; for a note too large or
  // too nested for it (sec-006) its file addresses found without the parser, so what it shows is never left behind.
  for (const href of (await markdown.links(raw))?.map((l) => l.href) ?? fileReferences(raw)) add(href);
  return [...out];
}
