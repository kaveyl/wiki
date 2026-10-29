// Trash of deleted notes (AD-025): list, restore, purge. Moved out of buildApp (code-002).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PathError, cleanRelPath, type Mount } from '../mounts/model.js';
import { ForbiddenError, NotFoundError } from '../notes/service.js';
import { atLeast } from '../acl/acl.js';
import { restoreTargets } from '../notes/trash.js';
import type { AppContext } from './context.js';

export function registerTrashRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, audit, author, canRead, levelIn, manager, mountOr404, mountRef, notes, settings, trashDays, visibleMount } = ctx;
  // ── Trash of deleted notes (AD-025) ───────────────────────────────────────────────
  /** Git entries before this date are hidden: emptied by hand, or older than the retention. */
  const trashHideBefore = (mountId: string): Date | null => {
    const days = trashDays();
    const cleared = settings.get(`trash_cleared:${mountId}`);
    const marks = [days ? Date.now() - days * 86_400_000 : 0, cleared ? Date.parse(cleared) : 0].filter((t) => t > 0);
    return marks.length ? new Date(Math.max(...marks)) : null;
  };
  /** The trash entries the user may see, each with only the notes they may read. */
  const visibleTrash = async (req: FastifyRequest, mount: Mount) => {
    // In a Git source the trash is the history: a deletion still waiting for its commit is committed first, so it shows at once.
    if ((await notes.trashMode(mount)) === 'git') await manager.commitNow(mount);
    return (await notes.trash(mount, trashHideBefore(mount.id)))
      .map((t) => ({ ...t, files: t.files.filter((f) => canRead(req, mount.id, f)) }))
      .filter((t) => t.files.length > 0);
  };
  const trashItem = async (req: FastifyRequest, mount: Mount, id: string) => {
    const item = (await visibleTrash(req, mount)).find((t) => t.id === id);
    if (!item) throw new NotFoundError(id);
    return item;
  };

  server.get<{ Params: { mountId: string } }>('/api/trash/:mountId', async (req) => {
    const mount = visibleMount(req, req.params.mountId);
    return {
      mode: await notes.trashMode(mount),
      days: trashDays(),
      canEmpty: !mount.options.readonly && atLeast(levelIn(req, mount.id, '', true), 'admin'),
      items: await visibleTrash(req, mount),
    };
  });

  // `as`: restore under another name (a note: its new path; a folder entry: the new folder), with
  // `toMountId` also into another source (Speichern als, AD-039) — nothing is overwritten.
  server.post<{ Params: { mountId: string }; Body: { id: string; paths?: string[]; as?: string; toMountId?: string } }>('/api/trash/:mountId/restore', async (req) => {
    const item = await trashItem(req, visibleMount(req, req.params.mountId), String(req.body.id ?? ''));
    const paths = Array.isArray(req.body.paths) ? req.body.paths.map(String).filter((p) => item.files.includes(p)) : item.files;
    const as = typeof req.body.as === 'string' ? req.body.as.trim() : undefined;
    if (as !== undefined && !cleanRelPath(as)) throw new PathError('Bitte einen Namen angeben');
    const target = as !== undefined ? restoreTargets(item.path, paths, cleanRelPath(as), item.isDir && !Array.isArray(req.body.paths)) : (p: string) => p;
    let mount = mountOr404(req.params.mountId);
    let dst = as !== undefined && req.body.toMountId ? mountOr404(String(req.body.toMountId)) : mount;
    for (const p of paths) dst = access(req, dst.id, cleanRelPath(target(p)), 'write', false);
    // The folder trash of the source changes too (the files move out of it).
    if (dst.id !== mount.id && item.id.startsWith('folder:')) for (const p of paths) mount = access(req, mount.id, p, 'write', false);
    const res = await notes.restoreFromTrash(mount, item.id, paths, author(req), as, dst, (ref) => canRead(req, mount.id, ref));
    const where = dst.id !== mount.id ? ` nach „${dst.name}“` : '';
    audit(req, 'note-restored', `Aus dem Papierkorb geholt: ${as !== undefined ? `${paths.join(', ')} als ${res.paths.join(', ')}${where}` : res.paths.join(', ')}`, { mount: mountRef(dst) });
    return { ...res, mountId: dst.id };
  });

  server.post<{ Params: { mountId: string }; Body: { id: string } }>('/api/trash/:mountId/purge', async (req) => {
    const item = await trashItem(req, visibleMount(req, req.params.mountId), String(req.body.id ?? ''));
    let mount = mountOr404(req.params.mountId);
    // All files of the entry, also those the user cannot see: purging takes them all.
    const all = (await notes.trash(mount, trashHideBefore(mount.id))).find((t) => t.id === item.id)?.files ?? item.files;
    if (all.some((p) => !atLeast(levelIn(req, mount.id, p, false), 'write'))) throw new ForbiddenError('Der Eintrag enthält Notizen, auf die du keine Schreibrechte hast');
    for (const p of item.files) mount = access(req, mount.id, p, 'write', false);
    await notes.purgeFromTrash(mount, item.id);
    audit(req, 'trash-purged', `Endgültig gelöscht: ${item.path || item.files.join(', ')}`, { mount: mountRef(mount) });
    return { ok: true };
  });

  server.post<{ Params: { mountId: string } }>('/api/trash/:mountId/empty', async (req) => {
    const mount = access(req, req.params.mountId, '', 'admin', true);
    if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
    const removed = await notes.purgeTrash(mount, null);
    settings.set(`trash_cleared:${mount.id}`, new Date().toISOString());
    audit(req, 'trash-emptied', `Papierkorb geleert (${removed} endgültig gelöscht, Git-Einträge ausgeblendet)`, { mount: mountRef(mount) });
    return { removed };
  });
}
