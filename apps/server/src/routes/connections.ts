// Connections to hosters and Git servers (AD-029): list, add, change, test, remove; their repositories and owners,
// creating a repository; the former Gitea settings and routes. Moved out of buildApp (code-002).
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { PathError } from '../mounts/model.js';
import { type Connection, type ConnectionInput } from '../mounts/connections.js';
import { createRepo, HOST_LABEL, isHostKind, listOwners, listRepos, whoAmI, type HostOwner } from '../mounts/hosts.js';
import type { AppContext } from './context.js';

export function registerConnectionRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, connectionOr404, connections, giteaConnection, requireAdmin } = ctx;
  // ── Connections (AD-029) ──────────────────────────────────────────────────────────
  const publicConnection = (c: Connection) => {
    const { secretId, ...rest } = c;
    return { ...rest, hasToken: !!secretId, ...connections.usage(c.id) };
  };
  const connectionBody = (b: Partial<ConnectionInput>): Partial<ConnectionInput> => ({
    ...(b.kind !== undefined ? { kind: b.kind } : {}),
    ...(b.name !== undefined ? { name: String(b.name) } : {}),
    ...(b.baseUrl !== undefined ? { baseUrl: String(b.baseUrl) } : {}),
    ...(b.username !== undefined ? { username: b.username === null ? null : String(b.username) } : {}),
    ...(b.token ? { token: String(b.token) } : {}),
  });

  server.get('/api/connections', async (req) => {
    requireAdmin(req);
    return connections.list().map(publicConnection);
  });

  server.post<{ Body: ConnectionInput }>('/api/connections', async (req) => {
    requireAdmin(req);
    const c = connections.create(connectionBody(req.body) as ConnectionInput);
    audit(req, 'connection-added', `Verbindung angelegt: ${c.name} (${HOST_LABEL[c.kind]}, ${c.baseUrl}${c.secretId ? ', mit Token' : ''})`);
    return publicConnection(c);
  });

  server.patch<{ Params: { id: string }; Body: Partial<ConnectionInput> }>('/api/connections/:id', async (req) => {
    requireAdmin(req);
    const { kind: _ignored, ...patch } = connectionBody(req.body);
    const c = connections.update(connectionOr404(req.params.id).id, patch);
    audit(req, 'connection-changed', `Verbindung geändert: ${c.name} (${Object.keys(patch).map((k) => (k === 'token' ? 'neuer Token' : k)).join(', ')})`);
    return publicConnection(c);
  });

  server.delete<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
    requireAdmin(req);
    const c = connectionOr404(req.params.id);
    connections.delete(c.id);
    audit(req, 'connection-removed', `Verbindung gelöscht: ${c.name}`);
    return { ok: true };
  });

  /** Checks a connection: hosters by asking who the token belongs to, plain Git cannot be checked without a URL. */
  server.post<{ Params: { id: string } }>('/api/connections/:id/check', async (req) => {
    requireAdmin(req);
    const c = connectionOr404(req.params.id);
    if (!isHostKind(c.kind)) return { ok: true, detail: 'Reine Git-Verbindung – geprüft wird beim Laden der Branches' };
    try {
      return { ok: true, detail: `angemeldet als ${await whoAmI(connections.hostAccess(c))}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  });

  const reposOf = (c: Connection, q: string) => listRepos(connections.hostAccess(c), q);
  const ownersOf = (c: Connection) => listOwners(connections.hostAccess(c));
  const createRepoOn = async (req: FastifyRequest, c: Connection, b: { owner: HostOwner; name: string; description?: string; private?: boolean }) => {
    const owner =
      b.owner?.kind === 'org' || b.owner?.kind === 'user'
        ? { kind: b.owner.kind, name: String(b.owner.name), ...(Number.isInteger(b.owner.id) ? { id: Number(b.owner.id) } : {}) }
        : null;
    if (!owner) throw new PathError('Besitzer fehlt');
    const repo = await createRepo(connections.hostAccess(c), { owner, name: String(b.name ?? ''), description: b.description, private: b.private !== false });
    audit(req, 'repo-created', `${HOST_LABEL[c.kind]}-Repository angelegt: ${repo.fullName}${repo.private ? ' (privat)' : ''}`);
    return repo;
  };

  server.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/connections/:id/repos', async (req) => {
    requireAdmin(req);
    return reposOf(connectionOr404(req.params.id), req.query.q ?? '');
  });
  server.get<{ Params: { id: string } }>('/api/connections/:id/owners', async (req) => {
    requireAdmin(req);
    return ownersOf(connectionOr404(req.params.id));
  });
  server.post<{ Params: { id: string }; Body: { owner: HostOwner; name: string; description?: string; private?: boolean } }>('/api/connections/:id/repos', async (req) => {
    requireAdmin(req);
    return createRepoOn(req, connectionOr404(req.params.id), req.body);
  });

  // Former "Settings → Gitea" and Gitea routes: the first Gitea connection (AD-029; live test, scripts).
  server.get('/api/settings/gitea', async (req) => {
    requireAdmin(req);
    const c = connections.defaultGitea();
    return { baseUrl: c?.baseUrl ?? null, configured: !!c?.secretId };
  });
  server.put<{ Body: { baseUrl: string; token?: string } }>('/api/settings/gitea', async (req) => {
    requireAdmin(req);
    const current = connections.defaultGitea();
    const c = current
      ? connections.update(current.id, { baseUrl: String(req.body.baseUrl), ...(req.body.token ? { token: req.body.token } : {}) })
      : connections.create({ kind: 'gitea', baseUrl: String(req.body.baseUrl), token: req.body.token });
    audit(req, 'gitea-settings', `Gitea-Zugang geändert: ${c.baseUrl}${req.body.token ? ' (neuer Token gesetzt)' : ''}`);
    return { baseUrl: c.baseUrl, configured: !!c.secretId };
  });
  server.get<{ Querystring: { q?: string } }>('/api/sources/gitea/repos', async (req) => {
    requireAdmin(req);
    return reposOf(giteaConnection(), req.query.q ?? '');
  });
  server.get('/api/sources/gitea/owners', async (req) => {
    requireAdmin(req);
    return ownersOf(giteaConnection());
  });
  server.post<{ Body: { owner: HostOwner; name: string; description?: string; private?: boolean } }>('/api/sources/gitea/repos', async (req) => {
    requireAdmin(req);
    return createRepoOn(req, giteaConnection(), req.body);
  });
}
