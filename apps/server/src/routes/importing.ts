// Import from other programs (docs/PLAN-IMPORT.md): upload the export (ZIP) → preview → import into a new folder.
// Who may: write access where the folder is created, no guests, never into an encrypted folder. The ZIP comes as a
// stream (up to 500 MB, application/zip) and is read from the disk, never as a whole into memory.
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cleanRelPath, PathError } from '../mounts/model.js';
import { ForbiddenError } from '../notes/service.js';
import { inEncryptedFolder } from '../notes/order.js';
import { requestLang, translateMessage } from '../i18n/index.js';
import { REPORT_NAME } from '../import/build.js';
import { formatById } from '../import/formats/index.js';
import { reportText } from '../import/report.js';
import type { PictureFetcher } from '../import/remote.js';
import { folderName, ImportService } from '../import/service.js';
import { IMPORT_LIMITS, ImportError, ImportZip } from '../import/zip.js';
import type { AppContext } from './context.js';

export function registerImportRoutes(server: FastifyInstance, ctx: AppContext, importFetcher?: PictureFetcher) {
  const { access, accessAll, audit, author, config, mountRef, notes, uploadBlocked } = ctx;
  const imports = new ImportService(join(config.dataPath, 'tmp', 'import'), importFetcher);
  void imports.sweep(true);
  // Uploads nobody imports or cancels go after 2 hours – also when nobody uploads again.
  const sweeper = setInterval(() => void imports.sweep(), 60 * 60_000).unref();
  server.addHook('onClose', async () => clearInterval(sweeper));

  // The ZIP stays a stream; the size limit is counted while it is written to the disk.
  server.addContentTypeParser('application/zip', (_req, payload, done) => done(null, payload));

  /** Write access at the target, no guest, not encrypted, not read-only – checked at upload and again at import. */
  const target = async (req: FastifyRequest, mountId: string, parent: string) => {
    if (req.user!.isGuest) throw new ForbiddenError('Gäste können nichts importieren');
    const mount = access(req, mountId, parent, 'write', true);
    if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
    if (await inEncryptedFolder(mount, config.dataPath, parent ? `${parent}/new.md` : 'new.md')) throw new ForbiddenError('Ziel ist ein verschlüsselter Ordner – dorthin lässt sich nichts importieren');
    return mount;
  };
  const buildOpts = (folderNote: string) => ({ folderNote, blocked: [...uploadBlocked()] });
  /** The suggested folder name („Import aus HedgeDoc“) in the person's language – it becomes a folder, no message. */
  const translatedName = <T extends { name: string }>(req: FastifyRequest, preview: T): T => ({ ...preview, name: translateMessage(requestLang(req), preview.name) });

  server.post<{ Params: { mountId: string }; Querystring: { parent?: string; name?: string; format?: string } }>('/api/import/:mountId/upload', async (req) => {
    const parent = cleanRelPath(String(req.query.parent ?? ''));
    const mount = await target(req, req.params.mountId, parent);
    if (!req.body || typeof (req.body as Readable).pipe !== 'function') throw new PathError('Erwartet: ZIP-Datei (application/zip)');
    // Known too big from the start: a clean answer before anything is read (the stream limit below cuts off the rest).
    if (Number(req.headers['content-length']) > IMPORT_LIMITS.upload) throw new ImportError('Die Datei ist größer als 500 MB', 413);
    const fileName = String(req.query.name ?? 'export.zip').slice(0, 255);
    const p = await imports.receive(req.body as Readable, { userId: req.user!.id, mountId: mount.id, parent, fileName }, Number(req.headers['content-length']) || 0);
    try {
      return translatedName(req, await imports.preview(p, req.query.format, buildOpts(mount.options.folderNote)));
    } catch (e) {
      await imports.drop(p.token);
      throw e;
    }
  });

  /** The preview again in another format (the person changed it in the dialog). */
  server.post<{ Body: { token?: string; format?: string } }>('/api/import/preview', async (req) => {
    const p = imports.get(String(req.body?.token ?? ''), req.user!.id);
    const mount = await target(req, p.mountId, p.parent);
    return translatedName(req, await imports.preview(p, req.body?.format, buildOpts(mount.options.folderNote)));
  });

  /** `pictures: true` = fetch the pictures that are only on the old server (HedgeDoc), see import/remote.ts. */
  server.post<{ Body: { token?: string; format?: string; name?: string; pictures?: boolean } }>('/api/import/run', async (req) => {
    const p = imports.get(String(req.body?.token ?? ''), req.user!.id);
    const mount = await target(req, p.mountId, p.parent);
    const lang = requestLang(req);
    const by = req.user!.displayName;
    const result = await imports.exclusive(async () => {
      const c = await imports.convert(p, req.body?.format, { ...buildOpts(mount.options.folderNote), fetch: req.body?.pictures === true });
      const label = formatById(c.format)!.label;
      const name = String(req.body?.name ?? '').trim().slice(0, 200) || translateMessage(lang, folderName(p.fileName, c.rootName, label));
      // Files from the ZIP are read only now, one by one, while they are written.
      const zip = await ImportZip.open(p.file);
      try {
        const inZip = new Map(zip.files.map((f) => [f.path, f]));
        const files = c.files.map((f) => ({ path: f.path, data: async () => f.data ?? (await inZip.get(f.entry!)!.bytes()) }));
        const out = await notes
          .writeImport(mount, p.parent, name, c.notes, files, author(req), `docs: Import aus ${label} (Kaveyl Wiki)`, {
            name: REPORT_NAME,
            text: (_folder, skipped) =>
              reportText({ lang, format: label, fileName: p.fileName, by, at: new Date(), notes: c.notes.length, files: c.files.length, folders: c.folders, warnings: c.warnings, skipped, unread: c.skipped }),
            // Rules on the new folder or below it (left from a folder of that name) apply to the import too.
            check: (folder) => void accessAll(req, mount.id, folder, 'write'),
          })
          .catch((e: unknown) => {
            if (e instanceof ImportError || e instanceof ForbiddenError || e instanceof PathError) throw e;
            // The folder is gone again (writeImport); the cause goes to the log, not to the person.
            req.log.warn({ err: e }, 'import failed while writing');
            throw new ImportError('Der Import brach beim Schreiben ab (beschädigte Datei im ZIP?) – es wurde nichts übernommen', 422);
          });
        return { ...out, label, notes: c.notes.length, files: c.files.length };
      } finally {
        await zip.close();
      }
    });
    await imports.drop(p.token);
    audit(req, 'imported', `Import aus ${result.label}: ${mount.name} / ${result.folder} (${result.notes} Notizen, ${result.files} Dateien)`, { mount: mountRef(mount) });
    return { folder: result.folder, report: `${result.folder}/${REPORT_NAME}`, notes: result.notes, files: result.files, skipped: result.skipped.length };
  });

  server.delete<{ Params: { token: string } }>('/api/import/:token', async (req) => {
    imports.get(req.params.token, req.user!.id);
    await imports.drop(req.params.token);
    return { ok: true };
  });
}
