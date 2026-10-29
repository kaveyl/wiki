// Notes themselves: read, save, create, move, copy, save as, delete; folder order, encryption marks, templates, presence;
// HTML/Markdown export and the link checks of the editor. Moved out of buildApp (code-002).
import { lstat, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isExternal, linkCandidates, resolveHref, splitFrontmatter, type PMNode } from '@kaveyl-wiki/core';
import { atLeast } from '../acl/acl.js';
import { walk } from '../index/indexer.js';
import { isAgeBody, isEncryptedNote } from '../notes/encryption.js';
import { PathError, absPath, cleanRelPath, fileFilter, type Mount } from '../mounts/model.js';
import { NotFoundError } from '../notes/service.js';
import { exportFolder, exportMarkdown, exportNote, type ExportDeps } from '../notes/export.js';
import { listTemplates, saveAsTemplate } from '../notes/templates.js';
import { readEncryptedFolders, readOrders, setFolderEncrypted, writeOrder } from '../notes/order.js';
import type { AppContext } from './context.js';

/** Largest Markdown file an import takes. */
const MAX_IMPORT = 5 * 1024 * 1024;
/** Most notes and folders in one export of a selection. */
const MAX_PICK = 500;

/** The folder that holds all picked paths (a note counts with its folder, a folder with its parent). */
export function commonFolder(paths: string[]): string {
  const dirs = paths.map((p) => posix.dirname(p).split('/').filter((x) => x && x !== '.'));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
  return first.slice(0, n).join('/');
}

export function registerNoteRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, audit, author, canRead, config, download, indexer, levelIn, manager, mountRef, notes, ops, presence, visibleEntries, visibleMount } = ctx;
  // ── HTML export and print view (Phase 6, AD-027) ──────────────────────────────────
  const exportDeps = (req: FastifyRequest, mount: Mount): ExportDeps => ({
    dataPath: config.dataPath,
    canRead: (p) => canRead(req, mount.id, p),
    readNote: async (m, p) => readFile(absPath(m, config.dataPath, p), 'utf8').catch(() => null),
  });
  server.get<{ Params: { mountId: string; '*': string }; Querystring: { inline?: string; format?: string } }>('/api/export/:mountId/*', async (req, reply) => {
    const rel = req.params['*'] ? cleanRelPath(req.params['*']) : '';
    if (req.query.format === 'md') {
      // Markdown: the files themselves (+ the pictures and files they use) as ZIP; a note without any as its .md.
      const mount = /\.md$/i.test(rel) ? access(req, req.params.mountId, rel, 'read', false) : visibleMount(req, req.params.mountId);
      const notesHere = visibleEntries(req, mount.id)
        .filter((e) => e.kind === 'file')
        .map((e) => e.path);
      const { name, zip, count, only } = await exportMarkdown(mount, rel, notesHere, exportDeps(req, mount));
      if (!count) throw new NotFoundError(rel || mount.id);
      audit(req, 'exported', `Markdown-Export: ${mount.name}${rel ? ` / ${rel}` : ''} (${count} Notiz${count === 1 ? '' : 'en'})`, { mount: mountRef(mount) });
      if (only) return reply.header('content-type', 'text/markdown; charset=utf-8').header('x-content-type-options', 'nosniff').header('content-disposition', download(name, 'md')).send(Buffer.from(only));
      return reply.header('content-type', 'application/zip').header('content-disposition', download(name, 'zip')).send(Buffer.from(zip));
    }
    if (/\.md$/i.test(rel)) {
      const mount = access(req, req.params.mountId, rel, 'read', false);
      const { name, html } = await exportNote(mount, rel, exportDeps(req, mount));
      // Never scripts; inline styles and inlined images only. No sandbox: the app prints it in a frame.
      reply.header('content-security-policy', "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'").header('x-content-type-options', 'nosniff');
      reply.header('content-type', 'text/html; charset=utf-8');
      if (req.query.inline !== '1') reply.header('content-disposition', download(name, 'html'));
      return html;
    }
    const mount = visibleMount(req, req.params.mountId);
    const notesHere = visibleEntries(req, mount.id)
      .filter((e) => e.kind === 'file')
      .map((e) => e.path);
    const { name, zip, count } = await exportFolder(mount, rel, notesHere, exportDeps(req, mount));
    if (!count) throw new NotFoundError(rel || mount.id);
    audit(req, 'exported', `HTML-Export: ${mount.name}${rel ? ` / ${rel}` : ''} (${count} Notizen)`, { mount: mountRef(mount) });
    return reply.header('content-type', 'application/zip').header('content-disposition', download(name, 'zip')).send(Buffer.from(zip));
  });

  /**
   * Several notes and folders marked in the tree as one ZIP (owner 28.10.): their common folder as the ZIP's root, only
   * what was picked. POST: a long selection would not fit into a URL (audit 28.10. code-004).
   */
  server.post<{ Params: { mountId: string }; Body: { paths?: unknown; format?: string } }>('/api/export-pick/:mountId', async (req, reply) => {
    const raw = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (raw.length > MAX_PICK) throw new PathError(`Höchstens ${MAX_PICK} Einträge auf einmal`);
    const pick = [...new Set(raw.map((p) => cleanRelPath(String(p))).filter(Boolean))];
    if (!pick.length) throw new PathError('Keine Notiz gewählt');
    const mount = visibleMount(req, req.params.mountId);
    const notesHere = visibleEntries(req, mount.id)
      .filter((e) => e.kind === 'file' && pick.some((p) => e.path === p || e.path.startsWith(`${p}/`)))
      .map((e) => e.path);
    const base = commonFolder(pick);
    const md = req.body?.format === 'md';
    const { name, zip, count } = md ? await exportMarkdown(mount, base, notesHere, exportDeps(req, mount)) : await exportFolder(mount, base, notesHere, exportDeps(req, mount));
    if (!count) throw new NotFoundError(pick[0]!);
    audit(req, 'exported', `${md ? 'Markdown' : 'HTML'}-Export: ${mount.name}, Auswahl (${count} Notiz${count === 1 ? '' : 'en'})`, { mount: mountRef(mount) });
    return reply.header('content-type', 'application/zip').header('content-disposition', download(name, 'zip')).send(Buffer.from(zip));
  });

  // Which links of a note lead nowhere (shown in the note while writing; the same rule as the check, fsck.ts: linkCandidates).
  // A target the user may not read counts as missing: its existence is not revealed.
  server.post<{ Params: { mountId: string; '*': string }; Body: { hrefs?: unknown } }>('/api/link-check/:mountId/*', async (req) => {
    const from = cleanRelPath(req.params['*']);
    const mount = access(req, req.params.mountId, from, 'read', false);
    const hrefs = Array.isArray(req.body?.hrefs) ? [...new Set(req.body.hrefs.filter((h): h is string => typeof h === 'string'))].slice(0, 500) : [];
    const broken: string[] = [];
    for (const href of hrefs) {
      if (isExternal(href) || href.startsWith('#')) continue;
      const t = resolveHref(href, from);
      if (!t) continue;
      let ok = false;
      // The editor asks about links only (images are not marked), hence kind 'link'.
      for (const c of linkCandidates(t.path, 'link', mount.options.folderNote)) {
        // Paths Kaveyl Wiki never serves (.git …) are refused by canRead/absPath: those count as missing.
        const st = await Promise.resolve()
          .then(() => (canRead(req, mount.id, c) ? lstat(absPath(mount, config.dataPath, c)) : null))
          .catch(() => null);
        if (st?.isFile()) {
          ok = true;
          break;
        }
      }
      if (!ok) broken.push(href);
    }
    return { broken };
  });

  server.get<{ Params: { mountId: string; '*': string } }>('/api/backlinks/:mountId/*', async (req) => {
    const mount = access(req, req.params.mountId, req.params['*'], 'read', false);
    return indexer.backlinks(mount, cleanRelPath(req.params['*'])).filter((b) => canRead(req, mount.id, b.path));
  });

  server.get<{ Params: { mountId: string; '*': string } }>('/api/notes/:mountId/*', async (req) => {
    const mount = access(req, req.params.mountId, req.params['*'], 'read', false);
    return { ...(await notes.read(mount, req.params['*'], { doc: true })), access: levelIn(req, mount.id, req.params['*'], false) };
  });

  server.put<{ Params: { mountId: string; '*': string }; Body: { doc?: PMNode; raw?: string; baseHash: string; allowPlain?: boolean } }>(
    '/api/notes/:mountId/*',
    async (req) => {
      const mount = access(req, req.params.mountId, req.params['*'], 'write', false);
      const { doc, raw, baseHash } = req.body;
      if (typeof baseHash !== 'string') throw new PathError('baseHash fehlt');
      // Moved by someone a moment ago: the save follows only where this user may write, too.
      const mayWriteAt = (to: string) => atLeast(levelIn(req, mount.id, to, false), 'write');
      if (typeof raw === 'string') {
        const res = await notes.saveRaw(mount, req.params['*'], raw, baseHash, author(req), { allowPlain: req.body.allowPlain === true, followMove: mayWriteAt });
        if (req.body.allowPlain === true && res.changed) audit(req, 'note-decrypted', `Verschlüsselung entfernt: ${req.params['*']}`, { mount: mountRef(mount) });
        return res;
      }
      if (doc?.type !== 'doc') throw new PathError('doc fehlt');
      return notes.saveDoc(mount, req.params['*'], doc, baseHash, author(req), { followMove: mayWriteAt });
    },
  );

  server.post<{ Params: { mountId: string }; Body: { parent?: string; title: string; kind?: 'file' | 'dir'; template?: string; body?: string } }>('/api/notes/:mountId', async (req) => {
    const mount = access(req, req.params.mountId, String(req.body.parent ?? ''), 'write', true);
    const template = typeof req.body.template === 'string' && req.body.template ? req.body.template : undefined;
    const body = typeof req.body.body === 'string' ? req.body.body.slice(0, 500_000) : undefined;
    const path = await notes.create(mount, req.body.parent ?? '', String(req.body.title ?? ''), req.body.kind === 'dir' ? 'dir' : 'file', author(req), template, body);
    return { path };
  });

  /** Markdown files from the computer into a folder (Importieren → Markdown-Dateien, owner 28.10.); each call one file. */
  server.post<{ Params: { mountId: string }; Body: { parent?: string; name?: string; raw?: string } }>('/api/notes/:mountId/import', async (req) => {
    const parent = cleanRelPath(String(req.body?.parent ?? ''));
    const mount = access(req, req.params.mountId, parent, 'write', true);
    const name = String(req.body?.name ?? '');
    if (!/\.(md|markdown)$/i.test(name)) throw new PathError('Nur Markdown-Dateien (.md) lassen sich importieren');
    if (typeof req.body?.raw !== 'string') throw new PathError('Inhalt fehlt');
    if (Buffer.byteLength(req.body.raw) > MAX_IMPORT) throw new PathError('Die Datei ist zu groß (höchstens 5 MB)');
    const path = await notes.importNote(mount, parent, name, req.body.raw, author(req));
    return { path };
  });

  /** Heartbeat of an open note (every ~20 s, and `open: false` when leaving). */
  server.post<{ Body: { mountId: string; path: string; open?: boolean; editing?: boolean } }>('/api/presence', async (req) => {
    const path = String(req.body.path ?? '');
    if (!path || path.length > 1000) throw new PathError('path fehlt');
    const mount = access(req, String(req.body.mountId ?? ''), path, 'read', false);
    return presence.beat(mount.id, path, { id: req.user!.id, name: req.user!.displayName }, req.body.open !== false, !!req.body.editing);
  });

  /** What the user sees in the tree ('' = root): orders and encrypted folders name nothing beyond it (AD-020). */
  const seenPaths = (req: FastifyRequest, mountId: string) => new Set(['', ...visibleEntries(req, mountId).map((e) => e.path)]);

  server.get<{ Params: { mountId: string } }>('/api/order/:mountId', async (req) => {
    const mount = visibleMount(req, req.params.mountId);
    const seen = seenPaths(req, mount.id);
    const orders = Object.entries(await readOrders(mount, config.dataPath)).filter(([folder]) => seen.has(folder));
    return Object.fromEntries(orders.map(([folder, names]) => [folder, names.filter((n) => seen.has(folder ? `${folder}/${n}` : n))]));
  });

  server.put<{ Params: { mountId: string }; Body: { folder?: string; order: string[] } }>('/api/order/:mountId', async (req) => {
    const mount = access(req, req.params.mountId, String(req.body.folder ?? ''), 'write', true);
    if (!Array.isArray(req.body.order)) throw new PathError('order: Liste erwartet');
    // Entries the user cannot see keep their place (AD-020): known to the index, but not in the user's tree.
    const seen = seenPaths(req, mount.id);
    const known = new Set(indexer.all(mount.id).map((e) => e.path));
    const hidden = (path: string) => known.has(path) && !seen.has(path);
    await writeOrder(manager, config.dataPath, mount, String(req.body.folder ?? ''), req.body.order.slice(0, 2000), author(req), undefined, hidden);
    return { ok: true };
  });

  // Encrypted folders (PLAN.md §3d): marked in `.kaveyl-wiki.yml`, the notes are encrypted in the browser.
  server.get<{ Params: { mountId: string } }>('/api/encrypted/:mountId', async (req) => {
    const mount = visibleMount(req, req.params.mountId);
    const seen = seenPaths(req, mount.id);
    return (await readEncryptedFolders(mount, config.dataPath)).filter((folder) => seen.has(folder));
  });

  server.put<{ Params: { mountId: string }; Body: { folder: string; encrypted: boolean } }>('/api/encrypted/:mountId', async (req) => {
    const folder = String(req.body.folder ?? '');
    const mount = access(req, req.params.mountId, folder, 'write', true);
    await setFolderEncrypted(manager, config.dataPath, mount, folder, req.body.encrypted === true, author(req));
    audit(req, req.body.encrypted ? 'folder-encrypted' : 'folder-decrypted', `${req.body.encrypted ? 'Ordner verschlüsselt' : 'Verschlüsselung aufgehoben'}: ${folder}`, { mount: mountRef(mount) });
    return { ok: true };
  });

  /**
   * The notes of a folder as they are on disk (not the index, which can lag): which are encrypted and which have a
   * body. The browser encrypts or decrypts exactly these and checks a passphrase against one with content.
   */
  server.get<{ Params: { mountId: string }; Querystring: { folder?: string } }>('/api/encrypted/:mountId/notes', async (req) => {
    const folder = cleanRelPath(String(req.query.folder ?? ''));
    const mount = access(req, req.params.mountId, folder, 'read', true);
    const isNote = fileFilter(mount);
    const paths: string[] = [];
    await walk(absPath(mount, config.dataPath, folder), folder, (f) => {
      if (isNote(f) && canRead(req, mount.id, f)) paths.push(f);
    });
    const out: { path: string; encrypted: boolean; empty: boolean }[] = [];
    for (const p of paths.sort()) {
      const raw = await readFile(absPath(mount, config.dataPath, p), 'utf8').catch(() => null);
      if (raw === null) continue;
      out.push({ path: p, encrypted: isEncryptedNote(raw), empty: !splitFrontmatter(raw).body.trim() });
    }
    return out;
  });

  server.get<{ Params: { mountId: string } }>('/api/templates/:mountId', async (req) => listTemplates(visibleMount(req, req.params.mountId), config.dataPath));

  server.post<{ Params: { mountId: string }; Body: { from: string; title?: string } }>('/api/templates/:mountId', async (req) => {
    // Templates are shared by the whole source: write on its root.
    const mount = access(req, req.params.mountId, '', 'write', true);
    access(req, mount.id, String(req.body.from ?? ''), 'read', false);
    const note = await notes.read(mount, String(req.body.from ?? ''));
    return saveAsTemplate(manager, config.dataPath, mount, note.raw, String(req.body.title || note.title), author(req));
  });

  // Move, copy: the same operations as REST/MCP (code-002) – only the answer names `mountId`.
  server.post<{ Params: { mountId: string }; Body: { from: string; to: string; toMountId?: string } }>('/api/notes/:mountId/move', async (req) => {
    const { sourceId, ...moved } = await ops.move(req, 'app', req.params.mountId, String(req.body.from ?? ''), String(req.body.to ?? ''), req.body.toMountId || undefined);
    return { mountId: sourceId, ...moved };
  });

  /** Copies a note or folder into `toParent` (of `toMountId`, default the same source). */
  server.post<{ Params: { mountId: string }; Body: { from: string; toParent?: string; toMountId?: string } }>('/api/notes/:mountId/copy', async (req) => {
    const { sourceId, ...copied } = await ops.copy(req, 'app', req.params.mountId, String(req.body.from ?? ''), String(req.body.toParent ?? ''), req.body.toMountId || undefined);
    return { mountId: sourceId, ...copied };
  });

  /** Speichern als (AD-039): the editor's text of a note gone outside meanwhile (conflict banner) as a new note. */
  server.post<{ Params: { mountId: string }; Body: { from: string; raw: string; to: string; toMountId?: string } }>('/api/notes/:mountId/save-as', async (req) => {
    const from = cleanRelPath(String(req.body.from ?? ''));
    const raw = String(req.body.raw ?? '');
    if (!from) throw new PathError('path fehlt');
    const mount = access(req, req.params.mountId, from, 'read', false);
    const dst = access(req, String(req.body.toMountId || mount.id), cleanRelPath(String(req.body.to ?? '')), 'write', false);
    // Same guard as saving: what claims to be encrypted must be an age block.
    if (isEncryptedNote(raw) && !isAgeBody(raw)) throw new PathError('Verschlüsselte Notiz: Inhalt ist kein age-Block');
    const res = await notes.saveNoteAs(mount, from, raw, dst, String(req.body.to ?? ''), author(req), `docs: ${from} gespeichert als ${String(req.body.to)} (Kaveyl Wiki)`, undefined, (ref) =>
      canRead(req, mount.id, ref),
    );
    audit(req, 'saved-as', `Gespeichert als: ${mount.name}/${from} → ${dst.name}/${res.path}`, { mount: mountRef(dst) });
    return { mountId: dst.id, ...res };
  });

  /** Delete a note or folder (trash or commit, AD-025) – through the operations layer, same checks as REST/MCP. */
  server.delete<{ Params: { mountId: string; '*': string } }>('/api/notes/:mountId/*', async (req) => {
    return ops.remove(req, 'app', req.params.mountId, req.params['*']);
  });
}
