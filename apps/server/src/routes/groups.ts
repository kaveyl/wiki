// Groups and their members (AD-020) and Cloudflare Access (admins). Moved out of buildApp (code-002); the
// rules themselves are in acl/acl.ts.
import type { FastifyInstance } from 'fastify';
import { PathError } from '../mounts/model.js';
import { NotFoundError } from '../notes/service.js';
import { CloudflareAccess } from '../auth/cloudflare.js';
import type { AppContext } from './context.js';

export function registerGroupRoutes(server: FastifyInstance, ctx: AppContext) {
  const { acl, audit, requireAdmin, settings } = ctx;
  // ── Groups, access rules and the default level (AD-020) ─────────────────────────────
  server.get('/api/admin/groups', async (req) => {
    requireAdmin(req);
    return acl.groups();
  });

  server.post<{ Body: { name: string } }>('/api/admin/groups', async (req) => {
    requireAdmin(req);
    const g = acl.createGroup(String(req.body.name ?? ''));
    audit(req, 'group-created', `Gruppe angelegt: ${g.name}`);
    return g;
  });

  server.patch<{ Params: { id: string }; Body: { name?: string; members?: string[] } }>('/api/admin/groups/:id', async (req) => {
    requireAdmin(req);
    if (typeof req.body.name === 'string') acl.renameGroup(req.params.id, req.body.name);
    if (Array.isArray(req.body.members)) acl.setMembers(req.params.id, req.body.members.map(String));
    const g = acl.groups().find((x) => x.id === req.params.id);
    if (!g) throw new NotFoundError(req.params.id);
    audit(req, 'group-changed', `Gruppe geändert: ${g.name} (${g.members.length} Mitglieder)`);
    return g;
  });

  server.delete<{ Params: { id: string } }>('/api/admin/groups/:id', async (req) => {
    requireAdmin(req);
    const g = acl.groups().find((x) => x.id === req.params.id);
    if (!g) throw new NotFoundError(req.params.id);
    acl.deleteGroup(g.id);
    audit(req, 'group-deleted', `Gruppe gelöscht: ${g.name} (ihre Regeln wurden entfernt)`);
    return { ok: true };
  });

  server.get('/api/admin/cloudflare', async (req) => {
    requireAdmin(req);
    return { enabled: settings.get('cf_access_enabled') === '1', teamDomain: settings.get('cf_access_team') ?? '', aud: settings.get('cf_access_aud') ?? '' };
  });

  server.put<{ Body: { enabled?: boolean; teamDomain?: string; aud?: string } }>('/api/admin/cloudflare', async (req) => {
    requireAdmin(req);
    const teamDomain = CloudflareAccess.normalizeTeam(String(req.body.teamDomain ?? ''));
    const aud = String(req.body.aud ?? '').trim();
    const enabled = req.body.enabled === true;
    if (enabled && (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(teamDomain) || !/^[A-Za-z0-9]{16,128}$/.test(aud))) throw new PathError('Team-Domain (z. B. team.cloudflareaccess.com) und AUD-Tag angeben');
    settings.set('cf_access_enabled', enabled ? '1' : '0');
    settings.set('cf_access_team', teamDomain);
    settings.set('cf_access_aud', aud);
    audit(req, 'cloudflare-changed', `Cloudflare Access ${enabled ? `an (${teamDomain})` : 'aus'}`);
    return { enabled, teamDomain, aud };
  });
}
