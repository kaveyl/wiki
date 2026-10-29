// Update hint (AD-062, admins): what the last check of the public releases found, on/off, „Jetzt prüfen“.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';

export function registerUpdateRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, requireAdmin, updates } = ctx;

  server.get('/api/admin/updates', async (req) => {
    requireAdmin(req);
    return updates.state();
  });

  server.put<{ Body: { enabled?: unknown } }>('/api/admin/updates', async (req) => {
    requireAdmin(req);
    const on = req.body?.enabled === true;
    if (on !== updates.enabled()) {
      updates.setEnabled(on);
      audit(req, 'update-check', on ? 'Update-Hinweis eingeschaltet' : 'Update-Hinweis ausgeschaltet');
    }
    return updates.state();
  });

  server.post('/api/admin/updates/check', async (req) => {
    requireAdmin(req);
    return updates.check();
  });
}
