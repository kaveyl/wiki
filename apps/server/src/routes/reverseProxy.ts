// Reverse-Proxy tab (AD-047…049): state only, nothing to set (TRUST_PROXY stays in the compose file, AD-031). The hint
// itself comes from the first onRequest hook in app.ts. Moved out of buildApp (code-001).
import type { FastifyInstance } from 'fastify';
import { normalizeIp } from '../auth/proxyAuth.js';
import { TRUST_OWN_NETWORK } from '../config.js';
import type { AppContext } from './context.js';

export function registerReverseProxyRoutes(server: FastifyInstance, ctx: AppContext) {
  const { config, proxyHint, requireAdmin } = ctx;
  server.get('/api/admin/reverse-proxy', async (req) => {
    requireAdmin(req);
    const socket = normalizeIp(req.socket.remoteAddress);
    const tp = config.trustProxy;
    return {
      trustProxy: tp === TRUST_OWN_NETWORK ? null : String(tp),
      socket,
      clientIp: normalizeIp(req.ip),
      forwarded: req.headers['x-forwarded-for'] !== undefined,
      viaTrustedProxy: normalizeIp(req.ip) !== socket,
      https: req.protocol === 'https',
      hint: proxyHint(),
    };
  });
}
