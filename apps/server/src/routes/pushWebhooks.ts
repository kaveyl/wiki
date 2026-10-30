// Settings of the push webhooks (AD-033): address, secret, what arrived, set up at the hoster. Moved out of
// buildApp (code-002); the incoming webhook is in gitWebhook.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PathError } from '../mounts/model.js';
import { type Connection } from '../mounts/connections.js';
import { HOST_LABEL, installWebhooks, isHostKind, removeWebhooks, webhookStatus, type HookChanges } from '../mounts/hosts.js';
import { isLocalAddress } from '../ai/providers.js';
import type { AppContext } from './context.js';
import { trimSlashes } from '../text.js';

export function registerPushWebhookRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, connectionOr404, connections, db, hostedRepoOf, mailer, manager, requireAdmin, settings, webhookSeen } = ctx;
  // ── Push webhooks (AD-033) ────────────────────────────────────────────────────────────
  // The address hosters call: the admin's own webhook address (owner 25.10.: FQDN or IP, the path stays fixed), else the
  // public address from Einstellungen → Benachrichtigungen → E-Mail, else the one the admin uses right now.
  // `lan`: only reachable inside the own network (github.com/gitlab.com cannot call it).
  const BASE_KEY = 'webhook_base_url';
  const webhookSource = (): 'webhook' | 'public' | 'browser' => (settings.get(BASE_KEY) ? 'webhook' : mailer.settings().publicUrl ? 'public' : 'browser');
  const webhookUrl = (req: FastifyRequest) => {
    const base = settings.get(BASE_KEY) || mailer.settings().publicUrl || `${req.protocol}://${req.headers.host ?? 'localhost'}`;
    return `${trimSlashes(base)}/api/webhooks/git`;
  };
  /** „http://192.168.1.20:8093/“ → its origin; anything with a path, query, credentials or another scheme is refused. */
  const cleanBase = (input: string): string => {
    const wrong = new PathError('Bitte nur die Adresse mit http:// oder https://, z. B. http://192.168.1.20:8093 – ohne Pfad');
    let u: URL;
    try {
      u = new URL(input.trim());
    } catch {
      throw wrong;
    }
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || u.pathname.replace(/\/+$/, '') !== '') throw wrong;
    return u.origin;
  };
  /** One log line per kind of change (whole sentences, so they translate). */
  const logChanges = (req: FastifyRequest, c: Connection, url: string, ch: HookChanges) => {
    const host = HOST_LABEL[c.kind as keyof typeof HOST_LABEL];
    if (ch.created.length) audit(req, 'webhook-installed', `Webhook bei ${host} angelegt: ${ch.created.join(', ')}`);
    if (ch.moved.length) audit(req, 'webhook-installed', `Webhook bei ${host} auf ${url} umgestellt: ${ch.moved.join(', ')}`);
    if (ch.removed.length) audit(req, 'webhook-removed', `Webhook bei ${host} entfernt: ${ch.removed.join(', ')}`);
  };
  // Addresses this instance's hooks used (owner 26.10., code-004): only hooks at these or the current address count as its
  // own – a hook at another address with the same path belongs to another Kaveyl Wiki instance and is never touched.
  // Remembered whenever a hook at the current address is there (set up, moved, or found on a check, also one added by hand).
  const KNOWN_KEY = 'webhook_known_urls';
  const knownUrls = (): string[] => {
    try {
      const list = JSON.parse(settings.get(KNOWN_KEY) ?? '[]') as unknown;
      return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string') : [];
    } catch {
      return [];
    }
  };
  const rememberUrl = <T extends { hooks: { current: boolean; foreign?: boolean }[] }>(url: string, status: T): T => {
    const known = knownUrls();
    if (status.hooks.some((h) => h.current && !h.foreign) && !known.includes(url)) settings.set(KNOWN_KEY, JSON.stringify([...known, url]));
    return status;
  };
  const cloudHost = (c: Connection) => ['https://github.com', 'https://gitlab.com'].includes(new URL(c.baseUrl).origin);
  const reposOfConnection = (c: Connection) => [...new Set(manager.list().flatMap((m) => (hostedRepoOf(m)?.connectionId === c.id ? [hostedRepoOf(m)!.fullName] : [])))];

  server.get('/api/settings/webhook', async (req) => {
    requireAdmin(req);
    const url = webhookUrl(req);
    const recent = db
      .prepare("SELECT at, level, action, message FROM activity WHERE action IN ('webhook-received', 'webhook-rejected') ORDER BY at DESC LIMIT 10")
      .all() as { at: string; level: string; action: string; message: string }[];
    return {
      path: '/api/webhooks/git',
      url,
      base: settings.get(BASE_KEY) ?? '',
      source: webhookSource(),
      secret: settings.get('webhook_secret'),
      publicUrlSet: !!mailer.settings().publicUrl,
      lan: isLocalAddress(url),
      recent,
    };
  });

  server.put<{ Body: { base?: string } }>('/api/settings/webhook', async (req) => {
    requireAdmin(req);
    const raw = String(req.body?.base ?? '').trim();
    if (raw) {
      const base = cleanBase(raw);
      settings.set(BASE_KEY, base);
      audit(req, 'webhook-address', `Webhook-Adresse: ${base}`);
    } else {
      settings.delete(BASE_KEY);
      audit(req, 'webhook-address', 'Webhook-Adresse: wieder die öffentliche Adresse');
    }
    const url = webhookUrl(req);
    return { url, base: settings.get(BASE_KEY) ?? '', source: webhookSource(), lan: isLocalAddress(url) };
  });

  server.get<{ Params: { id: string } }>('/api/connections/:id/webhook', async (req) => {
    requireAdmin(req);
    const c = connectionOr404(req.params.id);
    const url = webhookUrl(req);
    const repos = reposOfConnection(c);
    const seen = webhookSeen();
    const lastReceived = manager.list().filter((m) => hostedRepoOf(m)?.connectionId === c.id && seen[m.id]).map((m) => seen[m.id]!).sort().at(-1) ?? null;
    const base = { url, repos, lastReceived, unreachable: isHostKind(c.kind) && cloudHost(c) && isLocalAddress(url) };
    if (!isHostKind(c.kind) || !c.secretId) return { ...base, supported: false, hooks: [], uncovered: [], plans: { repos: [], remove: [] } };
    return { ...base, supported: true, ...rememberUrl(url, await webhookStatus(connections.hostAccess(c), url, repos, knownUrls())) };
  });

  // `way` (Gitea, owner 25.10.): `account` = one hook on the account for its own repositories, `repos` = one per added repository.
  server.post<{ Params: { id: string }; Body: { way?: string } }>('/api/connections/:id/webhook', async (req) => {
    requireAdmin(req);
    const c = connectionOr404(req.params.id);
    if (!isHostKind(c.kind) || !c.secretId) throw new PathError('Für diese Verbindung kann Kaveyl Wiki keinen Webhook anlegen – bitte von Hand (Einstellungen → Quellen → Webhooks)');
    const url = webhookUrl(req);
    if (cloudHost(c) && isLocalAddress(url))
      throw new PathError(`${HOST_LABEL[c.kind]} erreicht ${url} nicht (Adresse im eigenen Netz). Eine öffentliche Adresse unter Einstellungen → Quellen → Webhooks eintragen.`);
    const way = req.body?.way === 'account' ? 'account' : 'repos';
    const status = rememberUrl(url, await installWebhooks(connections.hostAccess(c), url, settings.get('webhook_secret')!, reposOfConnection(c), way, knownUrls()));
    logChanges(req, c, url, status.changes);
    return { ...status, url, repos: reposOfConnection(c) };
  });

  // Removes this instance's hooks of this connection (current or earlier own address), e.g. after a move or to go back to syncing every 5 minutes;
  // with `scope` and `name` only that one (owner 26.10.).
  server.delete<{ Params: { id: string }; Querystring: { scope?: string; name?: string } }>('/api/connections/:id/webhook', async (req) => {
    requireAdmin(req);
    const c = connectionOr404(req.params.id);
    if (!isHostKind(c.kind) || !c.secretId) throw new PathError('Für diese Verbindung kann Kaveyl Wiki keinen Webhook verwalten – bitte von Hand beim Anbieter');
    const url = webhookUrl(req);
    const { scope, name } = req.query;
    const only = (scope === 'account' || scope === 'repo') && name ? { scope: scope as 'account' | 'repo', name } : undefined;
    const status = rememberUrl(url, await removeWebhooks(connections.hostAccess(c), url, reposOfConnection(c), only, knownUrls()));
    logChanges(req, c, url, status.changes);
    return { ...status, url, repos: reposOfConnection(c) };
  });
}
