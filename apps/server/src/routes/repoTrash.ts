// Deleting repositories (admins): to the repository trash (archived for N days) or at once, restore, and the list
// of the repository trash. Moved out of buildApp (code-002); the wizard for new sources is in sources.ts.
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { PathError } from '../mounts/model.js';
import { hostCloneUrl } from '../mounts/hosts.js';
import type { AppContext } from './context.js';

export function registerRepoTrashRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, connections, manager, mountRef, repoAccess, repoTrash, requireAdmin, who } = ctx;
  // ── Deleting repositories (admin): trash = archived for 30 days, or delete now ─────────
  /** Mounts of a repository are unmounted first (an archived/deleted repo cannot sync). */
  const unmountRepo = async (req: FastifyRequest, g: ReturnType<typeof repoAccess>, fullName: string) => {
    const mounts = manager.findBySource([hostCloneUrl(g.kind, g.base, fullName)], null);
    for (const m of mounts) {
      await manager.remove(m.id);
      audit(req, 'mount-removed', `Quelle ausgehängt (Repository ${fullName} wird gelöscht): ${m.name}`, { mount: mountRef(m) });
    }
    return mounts.length;
  };
  const repoTrashList = async () => ({
    repos: repoTrash.list().map((r) => {
      const c = r.connectionId ? connections.get(r.connectionId) : null;
      return { ...r, connectionName: c?.name ?? null, kind: c?.kind ?? 'gitea' };
    }),
    bundles: await repoTrash.bundles(),
  });
  type RepoBody = { fullName: string; connectionId?: string | null; confirm?: string };
  const trashRepoNow = async (req: FastifyRequest, b: RepoBody) => {
    const g = repoAccess(b.connectionId);
    const fullName = String(b.fullName ?? '');
    hostCloneUrl(g.kind, g.base, fullName); // validates the name
    const unmounted = await unmountRepo(req, g, fullName);
    const entry = await repoTrash.trash(g, fullName, who(req));
    audit(req, 'repo-trashed', `Repository ${fullName} in den Papierkorb gelegt (archiviert, endgültige Löschung ${entry.deleteAfter ? `am ${entry.deleteAfter.slice(0, 10)}` : 'nur von Hand'})`, { level: 'warn' });
    return { entry, unmounted };
  };
  const restoreRepo = async (req: FastifyRequest, b: RepoBody) => {
    const fullName = String(b.fullName ?? '');
    const connectionId = b.connectionId ?? repoTrash.list().find((r) => r.fullName === fullName)?.connectionId;
    await repoTrash.restore(repoAccess(connectionId), fullName);
    audit(req, 'repo-restored', `Repository ${fullName} aus dem Papierkorb wiederhergestellt`);
    return { ok: true };
  };
  const deleteRepoNow = async (req: FastifyRequest, b: RepoBody) => {
    const fullName = String(b.fullName ?? '');
    // Typing the full name is the confirmation (like GitHub/Gitea) — protects against slips.
    if (String(b.confirm ?? '') !== fullName) throw new PathError('Bestätigung stimmt nicht mit dem Repository-Namen überein');
    const connectionId = b.connectionId ?? repoTrash.list().find((r) => r.fullName === fullName)?.connectionId;
    const g = repoAccess(connectionId);
    hostCloneUrl(g.kind, g.base, fullName);
    const unmounted = await unmountRepo(req, g, fullName);
    const bundle = await repoTrash.deleteNow(g, fullName);
    audit(req, 'repo-deleted', `Repository ${fullName} endgültig gelöscht (Sicherung: ${bundle})`, { level: 'warn' });
    return { bundle, unmounted };
  };
  for (const prefix of ['/api/repos', '/api/gitea/repos']) {
    server.post<{ Body: RepoBody }>(`${prefix}/trash`, async (req) => (requireAdmin(req), trashRepoNow(req, req.body)));
    server.post<{ Body: RepoBody }>(`${prefix}/restore`, async (req) => (requireAdmin(req), restoreRepo(req, req.body)));
    server.post<{ Body: RepoBody }>(`${prefix}/delete`, async (req) => (requireAdmin(req), deleteRepoNow(req, req.body)));
  }
  for (const path of ['/api/repo-trash', '/api/gitea/repo-trash']) server.get(path, async (req) => (requireAdmin(req), repoTrashList()));
}
