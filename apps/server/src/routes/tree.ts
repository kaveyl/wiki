// The tree of a source (only what the user may see), a note's history and one of its versions. Moved out of
// buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import { cleanRelPath, contentRoot } from '../mounts/model.js';
import { fileBytesAt } from '../git/history.js';
import type { AppContext } from './context.js';

export function registerTreeRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, audit, author, canRead, config, mountRef, notes, visibleEntries, visibleMount } = ctx;
  // ── Tree, notes, search ───────────────────────────────────────────────────────────
  server.get<{ Params: { mountId: string } }>('/api/tree/:mountId', async (req) => {
    visibleMount(req, req.params.mountId);
    return visibleEntries(req, req.params.mountId);
  });

  server.get<{ Params: { mountId: string; '*': string } }>('/api/history/:mountId/*', async (req) => {
    return notes.history(access(req, req.params.mountId, req.params['*'], 'read'), req.params['*']);
  });

  server.get<{ Params: { mountId: string }; Querystring: { commit?: string; path?: string } }>('/api/version/:mountId', async (req) => {
    const path = String(req.query.path ?? '');
    return { raw: await notes.version(access(req, req.params.mountId, path, 'read', false), String(req.query.commit ?? ''), path) };
  });

  server.get<{ Params: { mountId: string; '*': string }; Querystring: { from?: string; fromPath?: string; to?: string; toPath?: string } }>(
    '/api/diff/:mountId/*',
    async (req) => {
      const q = req.query;
      const from = q.from ? { commit: q.from, path: q.fromPath ?? req.params['*'] } : null;
      const to = q.to ? { commit: q.to, path: q.toPath ?? req.params['*'] } : null;
      const mount = access(req, req.params.mountId, req.params['*'], 'read', false);
      for (const side of [from, to]) if (side && side.path !== req.params['*']) access(req, mount.id, side.path, 'read', false);
      return { diff: await notes.diff(mount, req.params['*'], from, to) };
    },
  );

  server.post<{ Params: { mountId: string }; Body: { path: string; commit: string; versionPath: string; baseHash: string } }>(
    '/api/history/:mountId/restore',
    async (req) => {
      const b = req.body;
      const mount = access(req, req.params.mountId, String(b.path ?? ''), 'write', false);
      if (String(b.versionPath ?? '') !== String(b.path ?? '')) access(req, mount.id, String(b.versionPath ?? ''), 'read', false);
      const res = await notes.restoreVersion(mount, String(b.path), String(b.commit), String(b.versionPath), String(b.baseHash), author(req));
      audit(req, 'version-restored', `Version ${String(b.commit).slice(0, 7)} wiederhergestellt: ${String(b.path)}`, { mount: mountRef(mount) });
      return res;
    },
  );

  /** Speichern als (AD-039): an old version as a new note, in any folder the user may write to. */
  server.post<{ Params: { mountId: string }; Body: { commit: string; versionPath: string; to: string; toMountId?: string } }>(
    '/api/history/:mountId/save-as',
    async (req) => {
      const b = req.body;
      const versionPath = String(b.versionPath ?? '');
      const mount = access(req, req.params.mountId, versionPath, 'read', false);
      const commit = String(b.commit ?? '');
      const raw = await notes.version(mount, commit, versionPath);
      const dst = access(req, String(b.toMountId || mount.id), cleanRelPath(String(b.to ?? '')), 'write', false);
      const root = contentRoot(mount, config.dataPath);
      const label = `Version ${commit.slice(0, 7)}`;
      const res = await notes.saveNoteAs(
        mount,
        versionPath,
        raw,
        dst,
        String(b.to ?? ''),
        author(req),
        `docs: ${versionPath} (${label}) gespeichert als ${String(b.to)} (Kaveyl Wiki)`,
        (ref) => fileBytesAt(root, commit, ref),
        (ref) => canRead(req, mount.id, ref),
      );
      audit(req, 'version-saved-as', `${label} von ${mount.name}/${versionPath} gespeichert als ${dst.name}/${res.path}`, { mount: mountRef(dst) });
      return { mountId: dst.id, ...res };
    },
  );
}
