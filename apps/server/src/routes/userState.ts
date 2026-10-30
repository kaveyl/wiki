// Per-user UI state (tabs, layout): one JSON value per key and account. Moved out of buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import { PathError } from '../mounts/model.js';
import type { AppContext } from './context.js';

/**
 * The keys the web app keeps, each at most 1 MB: any key and the general 20 MB per request let every account fill the
 * database without end (CodeQL triage 29.10., #24/#25). Older, unknown keys read as nothing.
 */
const KEYS = new Set(['workspace', 'prefs', 'personal', 'ai']);
const MAX_BYTES = 1024 * 1024;

export function registerUserStateRoutes(server: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  // ── Per-user UI state (tabs, layout) ──────────────────────────────────────────────
  server.get<{ Params: { key: string } }>('/api/state/:key', async (req) => {
    if (!KEYS.has(req.params.key)) return null;
    const row = db.prepare('SELECT value_json FROM user_state WHERE user_id = ? AND key = ?').get(req.user!.id, req.params.key) as
      | { value_json: string }
      | undefined;
    return row ? JSON.parse(row.value_json) : null;
  });

  server.put<{ Params: { key: string }; Body: unknown }>('/api/state/:key', { bodyLimit: MAX_BYTES }, async (req) => {
    if (!KEYS.has(req.params.key)) throw new PathError('Unbekannter Schlüssel');
    db.prepare('INSERT INTO user_state (user_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value_json = excluded.value_json').run(
      req.user!.id,
      req.params.key,
      JSON.stringify(req.body ?? null),
    );
    return { ok: true };
  });
}
