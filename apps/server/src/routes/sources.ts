// Wizard for new sources (admins): branches of a remote repository, the tree to choose folders from (cloned once
// into the shared repo folder) and the local folder browser. Moved out of buildApp (code-002); the logic is in
// mounts/sources.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { git } from '../git/git.js';
import { repoDir, type Mount } from '../mounts/model.js';
import { browseLocal, createLocalFolder, validateSource, listBranches, markdownTree } from '../mounts/sources.js';
import { gitAuthorization, kindForUrl } from '../mounts/hosts.js';
import type { MountBody } from '../routes/context.js';
import type { AppContext } from './context.js';

export function registerSourceRoutes(server: FastifyInstance, ctx: AppContext) {
  const { config, connectionFor, connections, requireAdmin } = ctx;
  // ── Wizard for new sources: branches, folder tree, local folders ─────────────────────
  /** git options for a wizard call (branches, first clone) with the chosen connection. */
  const wizardGitOptions = (req: FastifyRequest, b: { connectionId?: string | null; credential?: MountBody['credential'] }, url: string) => {
    if (b.credential?.kind === 'token' && b.credential.token) return { authorization: gitAuthorization(kindForUrl(url), b.credential.token, b.credential.username) };
    const conn = connectionFor(req, b, url);
    const authorization = conn ? connections.gitAuthorization(conn) : undefined;
    return authorization ? { authorization } : {};
  };

  server.post<{ Body: { url: string; credential?: MountBody['credential']; connectionId?: string | null } }>('/api/sources/branches', async (req) => {
    requireAdmin(req);
    const url = validateSource('remote', String(req.body.url ?? ''), config.localRoots);
    return listBranches(url, wizardGitOptions(req, req.body, url));
  });

  server.post<{ Body: { type: 'remote' | 'local'; source: string; branch?: string; credential?: MountBody['credential']; connectionId?: string | null } }>(
    '/api/sources/tree',
    async (req) => {
      requireAdmin(req);
      const { type } = req.body;
      const source = validateSource(type, String(req.body.source ?? ''), config.localRoots);
      if (type === 'local') return markdownTree(source);
      // Clone into the shared repo folder; the mount created afterwards reuses it.
      const probe = { type, source, branch: req.body.branch ?? 'main', credentialId: null } as unknown as Mount;
      const dir = repoDir(probe, config.dataPath);
      const opts = wizardGitOptions(req, req.body, source);
      if (!existsSync(join(dir, '.git'))) {
        await git(config.dataPath, ['clone', '-q', '-b', probe.branch!, '--', source, dir], opts).catch((e: Error) => {
          throw Object.assign(new Error(`Klonen fehlgeschlagen: ${e.message.split('\n').pop()}`), { statusCode: 400 });
        });
      }
      return markdownTree(dir);
    },
  );

  server.get<{ Querystring: { path?: string } }>('/api/sources/local', async (req) => {
    requireAdmin(req);
    if (!config.localRoots.length) return { path: null, dirs: [], hint: 'Keine LOCAL_ROOTS konfiguriert' };
    return browseLocal(config.localRoots, req.query.path ?? null);
  });

  // „Neuer Ordner …“ in the local folder browser – no terminal needed for one folder per wiki.
  server.post<{ Body: { parent?: string; name?: string } }>('/api/sources/local/folder', async (req) => {
    requireAdmin(req);
    const path = await createLocalFolder(config.localRoots, String(req.body?.parent ?? ''), String(req.body?.name ?? ''));
    ctx.audit(req, 'local-folder-created', `Ordner für eine lokale Quelle angelegt: ${path}`);
    return { path };
  });
}
