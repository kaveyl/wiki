// Personal API tokens (AD-023, AD-047): list, create (shown once), renew, delete. Admins also for everyone (owner 28.10.):
// a tab with all tokens, „Neuer Token für …“ – the person sees in their own list who made it. Moved out of buildApp (code-002).
// Only with the browser login: API tokens never reach these routes (app.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthError, TOKEN_SCOPES, type TokenInfo, type TokenScope } from '../auth/auth.js';
import { NotFoundError } from '../notes/service.js';
import type { AppContext } from './context.js';

type NewToken = { name: string; scopes: TokenScope[]; expiresDays?: number | null };

export function registerTokenRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, auth, notifier, requireAdmin } = ctx;
  const parse = (body: NewToken) => ({
    name: String(body?.name ?? ''),
    scopes: Array.isArray(body?.scopes) ? body.scopes.filter((s) => (TOKEN_SCOPES as readonly string[]).includes(s)) : [],
    days: body?.expiresDays ? Math.min(3650, Math.max(1, Math.round(Number(body.expiresDays)))) : null,
  });
  const describe = (info: TokenInfo) => `${info.name} (${info.scopes.join(', ')}, ${info.prefix}…)`;
  /** Who it is for, when an admin acts on someone else's token. */
  const forWhom = (req: FastifyRequest, userId: string) => (userId === req.user!.id ? '' : ` für ${auth.getUser(userId)?.username ?? userId}`);

  /** Security notification: a new token – for whom, when an admin made it for someone else. */
  const announce = (req: FastifyRequest, info: TokenInfo, days: number | null) => {
    const rights = info.scopes.join(', ') || '–';
    const person = info.createdBy ? auth.tokenInfo(info.id)?.user.username : undefined;
    const text = person
      ? `${req.user!.username} hat den API-Token „${info.name}“ für ${person} erstellt (Rechte: ${rights}, ${info.expiresAt ? `gültig bis ${info.expiresAt.slice(0, 10)}` : 'ohne Ablauf'}).`
      : `${req.user!.username} hat den API-Token „${info.name}“ erstellt (Rechte: ${rights}${days ? `, gültig ${days} Tage` : ', ohne Ablauf'}).`;
    notifier.dispatch({ event: 'security', title: 'Neuer API-Token', text });
  };

  // ── Own tokens (everyone) ───────────────────────────────────────────────────────────────────────────
  server.get('/api/tokens', async (req) => auth.listTokens(req.user!.id));

  server.post<{ Body: NewToken }>('/api/tokens', async (req) => {
    const { name, scopes, days } = parse(req.body);
    const { token, info } = auth.createToken(req.user!.id, name, scopes, days);
    audit(req, 'token-created', `API-Token erstellt: ${describe(info)}`);
    announce(req, info, days);
    return { token, info };
  });

  server.post<{ Params: { id: string } }>('/api/tokens/:id/renew', async (req) => {
    const res = auth.renewToken(req.user!.id, req.params.id, req.user!.id);
    if (!res) throw new NotFoundError(req.params.id);
    audit(req, 'token-renewed', `API-Token erneuert: ${describe(res.info)}`);
    // A renewed token is a new way in, like a new one (audit 28.10. sec-003).
    notifier.dispatch({ event: 'security', title: 'API-Token erneuert', text: `${req.user!.username} hat den API-Token „${res.info.name}“ erneuert.` });
    return res;
  });

  server.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    const info = auth.tokenInfo(req.params.id);
    if (!info || info.user.id !== req.user!.id || !auth.revokeToken(req.user!.id, req.params.id)) throw new NotFoundError(req.params.id);
    audit(req, 'token-revoked', `API-Token gelöscht: ${describe(info)}`);
    return { ok: true };
  });

  // ── Everyone's tokens (admins, owner 28.10.) ────────────────────────────────────────────────────────
  server.get('/api/admin/tokens', async (req) => {
    requireAdmin(req);
    return auth.listAllTokens();
  });

  server.post<{ Body: NewToken & { userId: string } }>('/api/admin/tokens', async (req) => {
    requireAdmin(req);
    const userId = String(req.body?.userId ?? '');
    if (!auth.getUser(userId)) throw new AuthError('Benutzer nicht gefunden');
    const { name, scopes, days } = parse(req.body);
    const { token, info } = auth.createToken(userId, name, scopes, days, req.user!.id);
    audit(req, 'token-created', `API-Token erstellt${forWhom(req, userId)}: ${describe(info)}`);
    announce(req, info, days);
    return { token, info };
  });

  server.post<{ Params: { id: string } }>('/api/admin/tokens/:id/renew', async (req) => {
    requireAdmin(req);
    const before = auth.tokenInfo(req.params.id);
    const res = before && auth.renewToken(null, req.params.id, req.user!.id);
    if (!before || !res) throw new NotFoundError(req.params.id);
    audit(req, 'token-renewed', `API-Token erneuert${forWhom(req, before.user.id)}: ${describe(res.info)}`);
    if (before.user.id !== req.user!.id)
      notifier.dispatch({ event: 'security', title: 'API-Token erneuert', text: `${req.user!.username} hat den API-Token „${res.info.name}“${forWhom(req, before.user.id)} erneuert.` });
    return res;
  });

  server.delete<{ Params: { id: string } }>('/api/admin/tokens/:id', async (req) => {
    requireAdmin(req);
    const info = auth.tokenInfo(req.params.id);
    if (!info || !auth.revokeToken(null, req.params.id)) throw new NotFoundError(req.params.id);
    audit(req, 'token-revoked', `API-Token gelöscht${forWhom(req, info.user.id)}: ${describe(info)}`);
    return { ok: true };
  });
}
