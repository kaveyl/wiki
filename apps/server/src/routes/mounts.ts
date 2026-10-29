// Sources (mounts): list, add, change, remove; status, commit now, link repair after renames, conflicts and their
// resolution, sync now (one or all) and the order. Moved out of buildApp (code-002); the source logic is in mounts/.
import { type FastifyInstance } from 'fastify';
import { AGE_ARMOR_BEGIN, isAgeBody, isEncryptedNote } from '../notes/encryption.js';
import { PathError, type MountInput } from '../mounts/model.js';
import { cleanOptions, validateSource, selectionToGlobs } from '../mounts/sources.js';
import { assertVersionsPossible } from '../mounts/versions.js';
import { ForbiddenError, NotFoundError } from '../notes/service.js';
import { atLeast } from '../acl/acl.js';
import type { MountBody } from '../routes/context.js';
import type { AppContext } from './context.js';

export function registerMountRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, audit, author, canRead, config, conflictRel, connectionFor, connectionOr404, fitting, levelIn, manager, mountFor, mountOr404, mountRef, mountVisible, notes, offeredRepair, pendingRepairs, publicMount, record, requireAdmin, syncDetailFor, syncResultFor, visibleMount, who } = ctx;
  // ── Sources: list, add, change, remove, status, commit now, link repair, conflicts, sync, order ─────
  server.get('/api/mounts', async (req) => manager.list().filter((m) => mountVisible(req, m.id)).map((m) => mountFor(req, m)));

  server.post<{ Body: MountBody }>('/api/mounts', async (req) => {
    requireAdmin(req);
    const b = req.body;
    if (b.type !== 'remote' && b.type !== 'local') throw new PathError('type muss remote oder local sein');
    const source = validateSource(b.type, String(b.source ?? ''), config.localRoots);
    const input: MountInput = {
      name: String(b.name ?? '').trim() || source.split('/').filter(Boolean).pop()!.replace(/\.git$/, ''),
      type: b.type,
      source,
      branch: b.type === 'remote' ? (b.branch ?? 'main') : null,
      subpath: b.subpath ?? '',
      include: b.selection ? selectionToGlobs(b.selection) : b.include,
      exclude: b.exclude,
      icon: b.icon ?? null,
      options: cleanOptions(b.options),
    };
    if (b.type === 'remote') {
      const conn = connectionFor(req, b, source);
      if (conn) {
        input.connectionId = conn.id;
        input.credentialId = conn.secretId;
      }
    }
    // Checked before the source exists – otherwise a failed `git init` would leave it half set up.
    if (b.type === 'local' && b.versions) await assertVersionsPossible(source);
    let created = await manager.create(input);
    if (b.type === 'local' && b.versions) {
      try {
        created = (await manager.enableVersions(created, author(req))).mount;
      } catch (e) {
        await manager.remove(created.id); // no half set-up source (the folder's own files stay)
        throw e;
      }
    }
    audit(req, 'mount-added', `Quelle eingebunden: ${created.name} (${created.type === 'remote' ? `${created.source} @ ${created.branch}` : created.source})`, { mount: mountRef(created) });
    return mountFor(req, created);
  });

  server.patch<{ Params: { id: string }; Body: MountBody }>('/api/mounts/:id', async (req) => {
    requireAdmin(req);
    const b = req.body;
    const patch: Partial<MountInput> = {};
    for (const k of ['name', 'subpath', 'include', 'exclude', 'icon', 'position', 'paused', 'options'] as const) {
      if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = k === 'options' ? cleanOptions(b.options) : b[k];
    }
    if (b.selection) patch.include = selectionToGlobs(b.selection);
    if (b.connectionId !== undefined) {
      // Switch the access data of a source (e.g. a new account) — the address must fit.
      const mount = mountOr404(req.params.id);
      if (mount.type !== 'remote') throw new PathError('Nur Repositories haben eine Verbindung');
      const conn = b.connectionId ? fitting(connectionOr404(b.connectionId), mount.source) : null;
      patch.connectionId = conn?.id ?? null;
      patch.credentialId = conn?.secretId ?? null;
    }
    const updated = await manager.update(req.params.id, patch);
    audit(req, 'mount-changed', `Quelle geändert: ${updated.name} (${Object.keys(patch).join(', ')})`, { mount: mountRef(updated) });
    return mountFor(req, updated);
  });

  // A local folder gets its own Git for versions (AD-071); a folder unpacked from a backup gets its history back.
  server.post<{ Params: { id: string } }>('/api/mounts/:id/versions', async (req) => {
    requireAdmin(req);
    const { mount, restored } = await manager.enableVersions(mountOr404(req.params.id), author(req));
    audit(req, 'mount-changed', `Versionen eingeschaltet: ${mount.name}${restored ? ' (Verlauf aus der Sicherung)' : ''}`, { mount: mountRef(mount) });
    return { mount: mountFor(req, mount), restored };
  });

  server.delete<{ Params: { id: string } }>('/api/mounts/:id', async (req) => {
    requireAdmin(req);
    const gone = manager.get(req.params.id);
    await manager.remove(req.params.id);
    if (gone) audit(req, 'mount-removed', `Quelle ausgehängt: ${gone.name} (Dateien bleiben unverändert)`, { mount: mountRef(gone) });
    return { ok: true };
  });

  server.get('/api/status', async (req) => {
    const mounts = manager.list().filter((m) => !m.paused && mountVisible(req, m.id));
    return Promise.all(
      mounts.map(async (m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        /** Syncing needs write on the source (AD-020). */
        canSync: atLeast(levelIn(req, m.id, '', true), 'write'),
        autoCommit: m.options.autoCommit,
        commitIdleSec: m.options.commitIdleSec,
        syncStatus: m.syncStatus,
        syncDetail: syncDetailFor(req, m),
        syncedAt: m.syncedAt,
        linkRepairs: await offeredRepair(m),
        ...(await manager.status(m)),
      })),
    );
  });

  // "Leaving the note" / Ctrl+S: commit pending app edits now (and push). No-op without edits.
  // Only brings forward the commit the pause timer makes anyway (after a save, also by users
  // who may write single notes only). With something to commit, the push that follows fetches and
  // rebases onto foreign changes first (manager.sync); with nothing pending it does nothing.
  server.post<{ Params: { id: string } }>('/api/mounts/:id/commit-now', async (req) => {
    const mount = visibleMount(req, req.params.id);
    if (mount.options.autoCommit) await manager.commitNow(mount);
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>('/api/mounts/:id/repair-links', async (req) => {
    const mount = access(req, req.params.id, '', 'write', true);
    const moves = pendingRepairs.get(mount.id) ?? [];
    pendingRepairs.delete(mount.id);
    const r = await notes.repairLinks(mount, moves, author(req));
    if (r.links) record({ category: 'sync', action: 'links-repaired', actor: who(req), mount: mountRef(mount), message: `${r.links} Link${r.links === 1 ? '' : 's'} in ${r.files.length} Datei${r.files.length === 1 ? '' : 'en'} repariert`, detail: { files: r.files, paths: r.files } });
    return r;
  });

  server.get<{ Params: { id: string } }>('/api/mounts/:id/conflict', async (req) => {
    const mount = access(req, req.params.id, '', 'write', true);
    const files = await manager.conflict(mount);
    // Resolved only as a whole: who may not read every conflicted file sees none of them.
    if (!req.user!.isAdmin && files.some((f) => { const rel = conflictRel(mount, f.path); return rel === null || !canRead(req, mount.id, rel); }))
      throw new ForbiddenError('Der Konflikt betrifft auch Dateien, auf die du keinen Zugriff hast – ein Administrator muss ihn auflösen');
    return { files };
  });

  server.post<{ Params: { id: string }; Body: { resolutions: { path: string; content: string | null }[] } }>('/api/mounts/:id/conflict/resolve', async (req) => {
    const mount = access(req, req.params.id, '', 'write', true);
    if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
    const resolutions = (req.body.resolutions ?? []).map((r) => ({ path: String(r.path), content: r.content === null ? null : String(r.content) }));
    for (const r of resolutions) if (r.path.split('/').some((seg) => seg === '..' || seg === '.git' || !seg)) throw new PathError('Ungültiger Pfad');
    // Like every note route (AD-020): write access to each file taken.
    if (!req.user!.isAdmin) {
      for (const r of resolutions) {
        const rel = conflictRel(mount, r.path);
        if (rel === null) throw new NotFoundError(r.path);
        access(req, mount.id, rel, 'write', false);
      }
    }
    // An encrypted note can only be taken as a whole: a merged or hand-edited age block can never be decrypted again.
    for (const r of resolutions) {
      if (r.content !== null && (isEncryptedNote(r.content) || r.content.includes(AGE_ARMOR_BEGIN)) && !(isEncryptedNote(r.content) && isAgeBody(r.content))) {
        throw new ForbiddenError(`„${r.path}“ ist verschlüsselt – hier nur „Meine“ oder „Fremde“ Version ganz übernehmen, nicht zusammenführen`);
      }
    }
    const result = await manager.resolveConflict(mount, resolutions, author(req));
    return { result: syncResultFor(req, mount, result), mount: mountFor(req, manager.get(mount.id)!) };
  });

  // Syncing needs `write` on the whole source (AD-020); „Alle synchronisieren“ takes those.
  server.post('/api/sync-all', async (req) => {
    const mine = manager.list().filter((m) => atLeast(levelIn(req, m.id, '', true), 'write'));
    await manager.syncAll(mine, true);
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>('/api/mounts/:id/sync', async (req) => {
    const mount = access(req, req.params.id, '', 'write', true);
    const result = await manager.syncNow(mount);
    return { result: syncResultFor(req, mount, result), mount: mountFor(req, manager.get(mount.id)!) };
  });

  server.post<{ Body: { ids: string[] } }>('/api/mounts/reorder', async (req) => {
    requireAdmin(req);
    for (const [position, id] of (req.body.ids ?? []).entries()) await manager.update(id, { position });
    return manager.list().map(publicMount);
  });
}
