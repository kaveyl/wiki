// Attachments of notes (docs/PLAN.md §2.6): upload, replace, list; size limit and image size (admins). Moved out
// of buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import { lstat, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PathError, absPath, cleanRelPath } from '../mounts/model.js';
import { NotFoundError } from '../notes/service.js';
import { AttachmentError, BLOCKLIST_KEY, DEFAULT_BLOCKED, isAttachmentPath, listAttachments, normalizeBlocklist, replaceAttachment, storeAttachment, UPLOAD_HARD_LIMIT } from '../notes/attachments.js';
import type { AppContext } from './context.js';

export function registerAttachmentRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, attachmentMaxMb, audit, author, config, indexer, manager, mountRef, notes, requireAdmin, settings, uploadBlocked } = ctx;
  // ── Attachments (docs/PLAN.md §2.6) ──────────────────────────────────────────────
  const DEFAULT_IMAGE_MAX_PX = 2400;
  server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_HARD_LIMIT }, (_req, body, done) => done(null, body));

  server.post<{ Params: { mountId: string }; Querystring: { note?: string; name?: string; replace?: string }; Body: Buffer }>(
    '/api/attachments/:mountId',
    { bodyLimit: UPLOAD_HARD_LIMIT },
    async (req) => {
      const mount = access(req, req.params.mountId, String(req.query.note ?? ''), 'write', false);
      if (!Buffer.isBuffer(req.body)) throw new AttachmentError('Erwartet: Dateiinhalt (application/octet-stream)');
      if (req.query.replace) {
        // A new version of an existing attachment (edited drawing): write access there, too.
        access(req, mount.id, String(req.query.replace), 'write', false);
        const stored = await replaceAttachment(manager, config.dataPath, mount, String(req.query.replace), req.body, attachmentMaxMb() * 1024 * 1024, author(req), uploadBlocked());
        audit(req, 'attachment-replaced', `Anhang aktualisiert: ${stored.path} (${Math.round(stored.size / 1024)} KB)`, { mount: mountRef(mount) });
        return stored;
      }
      const stored = await storeAttachment(manager, config.dataPath, mount, String(req.query.note ?? ''), String(req.query.name ?? ''), req.body, attachmentMaxMb() * 1024 * 1024, author(req), uploadBlocked());
      audit(req, 'attachment-added', `Anhang: ${stored.path} (${Math.round(stored.size / 1024)} KB)`, { mount: mountRef(mount) });
      return stored;
    },
  );

  /**
   * Removes an attachment file (e.g. after it was replaced by its encrypted `.age` copy). Only inside `assets/`.
   * `?unlessLinkedBy=<note>`: kept when another note than that one still links to it (shared images).
   */
  server.delete<{ Params: { mountId: string; '*': string }; Querystring: { unlessLinkedBy?: string } }>('/api/attachments/:mountId/*', async (req) => {
    const rel = cleanRelPath(req.params['*']);
    const mount = access(req, req.params.mountId, rel, 'write', false);
    if (!isAttachmentPath(rel) || /\.md$/i.test(rel)) throw new PathError('Nur Anhänge in assets/ lassen sich so löschen');
    const abs = absPath(mount, config.dataPath, rel);
    if (!(await lstat(abs).catch(() => null))?.isFile()) throw new NotFoundError(rel);
    if (req.query.unlessLinkedBy !== undefined) {
      const self = cleanRelPath(req.query.unlessLinkedBy);
      if (indexer.allLinks(mount.id).some((l) => l.target === rel && l.src !== self)) return { ok: true, kept: true };
    }
    await rm(abs);
    // An assets/ folder left empty goes too (Git keeps no empty folders anyway).
    await rmdir(dirname(abs)).catch(() => undefined);
    await manager.touched(mount, [rel], author(req), `Anhang entfernt: ${rel}`);
    audit(req, 'attachment-removed', `Anhang entfernt: ${rel}`, { mount: mountRef(mount) });
    return { ok: true };
  });

  server.get<{ Params: { mountId: string; '*': string } }>('/api/attachments/:mountId/*', async (req) => {
    const mount = access(req, req.params.mountId, req.params['*'], 'read', false);
    const note = await notes.read(mount, req.params['*']);
    return listAttachments(config.dataPath, mount, note.raw, note.path);
  });

  /**
   * Large photos and screenshots are scaled down in the browser before upload (owner 2026-10-11):
   * longest side in pixels, 0 = keep originals. Every uploader needs it, so it is readable for all.
   */
  const imageMaxPx = () => {
    const v = Number(settings.get('image_max_px') ?? DEFAULT_IMAGE_MAX_PX);
    return Number.isFinite(v) && (v === 0 || (v >= 800 && v <= 8000)) ? Math.round(v) : DEFAULT_IMAGE_MAX_PX;
  };

  server.get('/api/attachment-settings', async () => ({ maxMb: attachmentMaxMb(), imageMaxPx: imageMaxPx() }));

  // Admins: size, image size and the blocked file endings (owner 25.10.: a list, prefilled with the executables).
  const adminView = () => ({ maxMb: attachmentMaxMb(), imageMaxPx: imageMaxPx(), blocked: [...uploadBlocked()].sort(), blockedDefault: [...DEFAULT_BLOCKED].sort() });

  server.get('/api/admin/attachments', async (req) => {
    requireAdmin(req);
    return adminView();
  });

  server.put<{ Body: { maxMb?: number; imageMaxPx?: number; blocked?: unknown } }>('/api/admin/attachments', async (req) => {
    requireAdmin(req);
    if (req.body.maxMb !== undefined) {
      const v = Math.round(Number(req.body.maxMb));
      if (!Number.isFinite(v) || v < 1 || v > UPLOAD_HARD_LIMIT / 1024 / 1024) throw new PathError(`Erlaubt sind 1 bis ${UPLOAD_HARD_LIMIT / 1024 / 1024} MB`);
      settings.set('attachment_max_mb', String(v));
      audit(req, 'attachments-changed', `Größenlimit für Anhänge: ${v} MB`);
    }
    if (req.body.imageMaxPx !== undefined) {
      const px = Math.round(Number(req.body.imageMaxPx));
      if (!Number.isFinite(px) || (px !== 0 && (px < 800 || px > 8000))) throw new PathError('Erlaubt sind 0 (Originale behalten) oder 800 bis 8000 Pixel');
      settings.set('image_max_px', String(px));
      audit(req, 'attachments-changed', px ? `Große Bilder beim Einfügen auf ${px} Pixel verkleinern` : 'Bilder beim Einfügen nicht verkleinern');
    }
    if (req.body.blocked !== undefined) {
      let list: string[];
      try {
        list = normalizeBlocklist(req.body.blocked);
      } catch (e) {
        throw new PathError((e as Error).message);
      }
      settings.set(BLOCKLIST_KEY, JSON.stringify(list));
      audit(req, 'attachments-changed', list.length ? `Gesperrte Dateiendungen: ${list.join(', ')}` : 'Keine Dateiendungen gesperrt');
    }
    return adminView();
  });
}
