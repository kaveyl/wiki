// Per-user UI state (tabs, layout): one JSON value per key and account. Moved out of buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';

export function registerUserStateRoutes(server: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  // ── Per-user UI state (tabs, layout) ──────────────────────────────────────────────
  server.get<{ Params: { key: string } }>('/api/state/:key', async (req) => {
    const row = db.prepare('SELECT value_json FROM user_state WHERE user_id = ? AND key = ?').get(req.user!.id, req.params.key) as
      | { value_json: string }
      | undefined;
    return row ? JSON.parse(row.value_json) : null;
  });

  server.put<{ Params: { key: string }; Body: unknown }>('/api/state/:key', async (req) => {
    db.prepare('INSERT INTO user_state (user_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value_json = excluded.value_json').run(
      req.user!.id,
      req.params.key,
      JSON.stringify(req.body ?? null),
    );
    return { ok: true };
  });
}
