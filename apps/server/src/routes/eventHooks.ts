// Event webhooks (AD-066): admins set them up – each runs with the rights of one person. The secret is shown once.
import type { FastifyInstance } from 'fastify';
import type { HookInput } from '../hooks.js';
import type { AppContext } from './context.js';

export function registerEventHookRoutes(server: FastifyInstance, ctx: AppContext) {
  const { eventHooks, requireAdmin, audit } = ctx;

  server.get('/api/admin/event-hooks', async (req) => {
    requireAdmin(req);
    return eventHooks.list();
  });

  server.post<{ Body: HookInput }>('/api/admin/event-hooks', async (req) => {
    requireAdmin(req);
    const res = eventHooks.create(req.body ?? {});
    audit(req, 'event-hook-added', `Ereignis-Webhook angelegt: ${res.hook.name} (${new URL(res.hook.url).host})`);
    return res;
  });

  server.patch<{ Params: { id: string }; Body: HookInput }>('/api/admin/event-hooks/:id', async (req) => {
    requireAdmin(req);
    const hook = eventHooks.update(req.params.id, req.body ?? {});
    audit(req, 'event-hook-changed', `Ereignis-Webhook geändert: ${hook.name}${hook.active ? '' : ' (aus)'}`);
    return hook;
  });

  server.delete<{ Params: { id: string } }>('/api/admin/event-hooks/:id', async (req) => {
    requireAdmin(req);
    const hook = eventHooks.get(req.params.id);
    eventHooks.remove(req.params.id);
    if (hook) audit(req, 'event-hook-removed', `Ereignis-Webhook gelöscht: ${hook.name}`);
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>('/api/admin/event-hooks/:id/secret', async (req) => {
    requireAdmin(req);
    const secret = eventHooks.newSecret(req.params.id);
    audit(req, 'event-hook-secret', `Ereignis-Webhook: neues Geheimnis für ${eventHooks.get(req.params.id)?.name ?? req.params.id}`);
    return { secret };
  });

  server.post<{ Params: { id: string } }>('/api/admin/event-hooks/:id/test', async (req) => {
    requireAdmin(req);
    return { status: await eventHooks.test(req.params.id) };
  });
}
