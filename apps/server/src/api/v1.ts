// Public REST API v1 (AD-023): stable, versioned routes under /api/v1 on top of the shared
// operations layer (ops.ts). Auth: `Authorization: Bearer kw_…` (scopes read/write) or the
// browser session. Breaking changes only in a new version (/api/v2). Schema: openapi.ts.
import type { FastifyInstance } from 'fastify';
import { fileContent, type Ops } from './ops.js';
import { openapi } from './openapi.js';

type P = { sourceId: string; '*': string };

export function registerApiV1(server: FastifyInstance, ops: Ops) {
  server.get('/api/v1/openapi.json', async () => openapi);

  server.get('/api/v1/sources', async (req) => ops.sources(req));

  // Long polling (AD-066): the request ends early when the client goes away.
  server.get<{ Querystring: { source?: string; path?: string; after?: string; wait?: string; own?: string } }>('/api/v1/changes', async (req, reply) => {
    const gone = new AbortController();
    // Not req.raw: its „close“ comes once the request is read, not when the client hangs up.
    reply.raw.once('close', () => gone.abort());
    return ops.changes(req, { source: req.query.source, path: req.query.path, after: req.query.after, wait: Number(req.query.wait) || 0, includeOwn: req.query.own === 'true' }, gone.signal);
  });

  server.get<{ Params: { sourceId: string }; Querystring: { path?: string; depth?: string } }>('/api/v1/tree/:sourceId', async (req) =>
    ops.tree(req, req.params.sourceId, req.query.path ?? '', req.query.depth ? Number(req.query.depth) || undefined : undefined),
  );

  server.get<{ Querystring: { q?: string; limit?: string; source?: string } }>('/api/v1/search', async (req) =>
    ops.search(req, String(req.query.q ?? ''), Number(req.query.limit ?? 20) || 20, req.query.source || undefined),
  );

  server.post<{ Params: { sourceId: string }; Body: { parent?: string; name: string } }>('/api/v1/folders/:sourceId', async (req) =>
    ops.createFolder(req, 'api', req.params.sourceId, String(req.body?.parent ?? ''), String(req.body?.name ?? '')),
  );

  server.post<{ Params: { sourceId: string }; Body: { note?: string; name?: string; contentBase64?: unknown; contentText?: unknown } }>('/api/v1/attachments/:sourceId', async (req) =>
    ops.upload(req, 'api', req.params.sourceId, String(req.body?.note ?? ''), String(req.body?.name ?? ''), fileContent(req.body?.contentBase64, req.body?.contentText)),
  );

  server.get<{ Params: P }>('/api/v1/attachments/:sourceId/*', async (req) => ops.attachments(req, req.params.sourceId, req.params['*']));

  server.get<{ Querystring: { source?: string } }>('/api/v1/status', async (req) => ops.status(req, req.query.source || undefined));

  server.post<{ Params: { sourceId: string } }>('/api/v1/sync/:sourceId', async (req) => ops.sync(req, req.params.sourceId));

  server.get<{ Params: P }>('/api/v1/notes/:sourceId/*', async (req) => ops.read(req, req.params.sourceId, req.params['*']));

  server.put<{ Params: P; Body: { markdown: string; baseHash: string } }>('/api/v1/notes/:sourceId/*', async (req) =>
    ops.write(req, 'api', req.params.sourceId, req.params['*'], req.body?.markdown, req.body?.baseHash),
  );

  server.post<{ Params: { sourceId: string }; Body: { parent?: string; title: string; markdown?: string } }>('/api/v1/notes/:sourceId', async (req) =>
    ops.create(req, 'api', req.params.sourceId, String(req.body?.parent ?? ''), String(req.body?.title ?? ''), req.body?.markdown),
  );

  server.delete<{ Params: P }>('/api/v1/notes/:sourceId/*', async (req) => ops.remove(req, 'api', req.params.sourceId, req.params['*']));

  server.post<{ Params: { sourceId: string }; Body: { from: string; to: string; toSourceId?: string } }>('/api/v1/move/:sourceId', async (req) =>
    ops.move(req, 'api', req.params.sourceId, String(req.body?.from ?? ''), String(req.body?.to ?? ''), req.body?.toSourceId || undefined),
  );

  server.post<{ Params: { sourceId: string }; Body: { from: string; toParent?: string; toSourceId?: string } }>('/api/v1/copy/:sourceId', async (req) =>
    ops.copy(req, 'api', req.params.sourceId, String(req.body?.from ?? ''), String(req.body?.toParent ?? ''), req.body?.toSourceId || undefined),
  );

  server.get<{ Params: P }>('/api/v1/backlinks/:sourceId/*', async (req) => ops.backlinks(req, req.params.sourceId, req.params['*']));

  server.get<{ Params: P }>('/api/v1/history/:sourceId/*', async (req) => ops.history(req, req.params.sourceId, req.params['*']));

  server.get<{ Params: P; Querystring: { commit?: string } }>('/api/v1/version/:sourceId/*', async (req) =>
    ops.version(req, req.params.sourceId, req.params['*'], String(req.query.commit ?? '')),
  );
}
