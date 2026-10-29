// Activity log (AD-013): the list each user may see; its retention is a deletion rule (routes/cleanup.ts). Moved out of buildApp (code-001).
import type { FastifyInstance } from 'fastify';
import { entryFor, errorFor, systemFor, type Category } from '../activity.js';
import { NotFoundError } from '../notes/service.js';
import type { AppContext } from './context.js';

export function registerActivityRoutes(server: FastifyInstance, ctx: AppContext) {
  const { activity, auth, canRead, manager, mountVisible, requireAdmin, visibleMount } = ctx;
  server.get<{ Querystring: { mountId?: string; category?: string; problems?: string; before?: string; limit?: string; userId?: string } }>('/api/activity', async (req) => {
    const q = req.query;
    // What one person did (admins): log entries under their user name, commits under their name.
    let actors: string[] | undefined;
    if (q.userId) {
      requireAdmin(req);
      const u = auth.listUsers().find((x) => x.id === q.userId);
      if (!u) throw new NotFoundError(q.userId);
      actors = [...new Set([u.username, u.displayName].filter(Boolean))];
    }
    const category = ['sync', 'error', 'audit', 'system'].includes(q.category ?? '') ? (q.category as Category) : undefined;
    if (category === 'audit') requireAdmin(req);
    if (q.mountId && !req.user!.isAdmin) visibleMount(req, q.mountId);
    const entries = activity.list({
      mountId: q.mountId || undefined,
      category,
      problems: q.problems === 'true',
      before: q.before ? Number(q.before) : undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      includeAudit: !!req.user?.isAdmin,
      actors,
    });
    // Others see entries of the sources they can see (and general ones), note paths only where they may read them
    // and errors only as a general text (sec-004), housekeeping of the server not at all (sec2-004); in a source that
    // is gone no path counts as readable.
    if (req.user!.isAdmin) return entries;
    return entries.flatMap((raw) => {
      const e = systemFor(errorFor(raw));
      if (!e) return [];
      const id = e.mountId;
      if (!id) return [e];
      const live = !!manager.get(id);
      if (live && !mountVisible(req, id)) return [];
      const shown = entryFor(e, (p) => live && canRead(req, id, p));
      return shown ? [shown] : [];
    });
  });
}
