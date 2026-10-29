// Sign-in through an auth proxy (AD-049) in one place (code-002): the stored setting per provider, the sign-in of a
// request (called by the auth hook in app.ts), the provider tabs for admins and the own account's connections.
// The rules themselves (which address and which headers count) are in proxyAuth.ts.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountProxy, ProxyAuthState, ProxyRequestInfo } from '@kaveyl-wiki/core';
import type { ActivityInput } from '../activity.js';
import { PathError } from '../mounts/model.js';
import { NotFoundError } from '../notes/service.js';
import type { AuthService } from './auth.js';
import {
  canonicalPath,
  hashProxySecret,
  isLoopback,
  isProxyProvider,
  normalizeIp,
  PROXY_LABEL,
  PROXY_PROVIDERS,
  PROXY_SECRET_HEADER,
  ProxyConfigError,
  ProxyFieldError,
  proxyIdentity,
  proxySecretOk,
  readProxyConfig,
  validateProxyConfig,
  type ProxyAuthConfig,
  type ProxyProvider,
  type StoredProxyConfig,
} from './proxyAuth.js';

export interface ProxyAuthDeps {
  auth: AuthService;
  settings: { get(key: string): string | null; set(key: string, value: string): void };
  /** The container's Docker gateways – never accepted as a proxy address (sec-002). */
  gateways: string[];
  record(e: ActivityInput): void;
  audit(req: FastifyRequest, action: string, message: string, extra?: Partial<ActivityInput>): void;
  requireAdmin(req: FastifyRequest): void;
  sessionCookie(req: FastifyRequest): string | undefined;
  setSessionCookie(reply: FastifyReply, token: string): void;
  clearSessionCookie(reply: FastifyReply): void;
}

export type ProxyAuth = ReturnType<typeof createProxyAuth>;

export function createProxyAuth(d: ProxyAuthDeps) {
  /** Read per request – parsed again only when the stored value changed; a value failing the check is logged once. */
  const states = new Map<ProxyProvider, { stored: string | undefined; state: StoredProxyConfig }>();
  const state = (p: ProxyProvider) => {
    const stored = d.settings.get(`proxy_auth_${p}`) ?? undefined;
    const hit = states.get(p);
    if (hit && hit.stored === stored) return hit.state;
    const state = readProxyConfig(p, stored, d.gateways);
    states.set(p, { stored, state });
    if (state.problem) d.record({ category: 'system', level: 'warn', action: 'proxy-auth-invalid', message: `${PROXY_LABEL[p]}: gespeicherte Einstellung ungültig – Anmeldung über den Proxy ist aus: ${state.problem}` });
    return state;
  };
  const config = (p: ProxyProvider) => state(p).config;
  for (const p of PROXY_PROVIDERS) state(p); // at start: an invalid stored value shows up in the log right away
  /** Unknown ids are logged once per 10 minutes each – every request of such a visitor carries them. */
  const unknownSeen = new Map<string, number>();
  /**
   * Sign-in through an auth proxy (AD-049). A session the proxy made lasts only while the proxy keeps naming the same
   * person (else it ends – signing out at the proxy signs out here too); accounts sign in only when connected.
   */
  const signIn = (req: FastifyRequest, reply: FastifyReply) => {
    const token = d.sessionCookie(req);
    const canonical = canonicalPath(req.url);
    if (req.user) {
      const bound = d.auth.sessionProxy(token);
      if (!bound) return;
      const at = bound.indexOf(':');
      const provider = bound.slice(0, at);
      const id = isProxyProvider(provider) ? proxyIdentity(config(provider), req.socket.remoteAddress, req.headers) : null;
      // Same id from the proxy, and still connected to this very account.
      if (id?.subject === bound.slice(at + 1) && d.auth.userForProxy(provider, id.subject)?.id === req.user.id) return;
      d.auth.deleteSession(token);
      d.clearSessionCookie(reply);
      d.record({ category: 'audit', action: 'logout-proxy', actor: req.user.username, message: `Proxy-Sitzung beendet (Proxy nennt die Person nicht mehr): ${req.user.username}`, detail: { ip: req.ip } });
      req.user = null;
    }
    if (!canonical) return;
    for (const provider of PROXY_PROVIDERS) {
      const cfg = config(provider);
      const id = proxyIdentity(cfg, req.socket.remoteAddress, req.headers);
      if (!id?.subject) continue;
      let user = d.auth.userForProxy(provider, id.subject);
      if (!user && cfg.autoLinkByEmail && id.email) {
        // Optional for normal users (never admins): the first visit through the proxy connects by e-mail.
        const byMail = d.auth.userByEmail(id.email);
        if (byMail && !byMail.disabled && !byMail.isAdmin && !d.auth.proxyLinks(byMail.id).some((l) => l.provider === provider)) {
          try {
            d.auth.linkProxy(byMail.id, provider, id.subject, true);
            user = byMail;
            d.record({ category: 'audit', action: 'proxy-linked-auto', actor: byMail.username, message: `${PROXY_LABEL[provider]}: Konto über die E-Mail verbunden: ${byMail.username}`, detail: { ip: req.ip } });
          } catch {
            /* id belongs to another account – stays unknown */
          }
        }
      }
      if (!user) {
        const key = `${provider}:${id.subject}`;
        if ((unknownSeen.get(key) ?? 0) < Date.now() - 600_000) {
          if (unknownSeen.size > 1000) unknownSeen.clear();
          unknownSeen.set(key, Date.now());
          d.record({ category: 'audit', level: 'warn', action: 'login-proxy-unknown', message: `${PROXY_LABEL[provider]}: Anmeldung ohne verbundenes Konto – normale Anmeldung angezeigt`, detail: { ip: req.ip } });
        }
        continue;
      }
      // For the browser session only: the proxy signs in again whenever needed.
      const { token: t } = d.auth.createSession(user.id, false, `${provider}:${id.subject}`);
      d.setSessionCookie(reply, t);
      req.user = d.auth.getUser(user.id);
      d.record({ category: 'audit', action: 'login-proxy', actor: user.username, message: `Anmeldung über ${PROXY_LABEL[provider]}: ${user.username}`, detail: { ip: req.ip } });
      return;
    }
  };
  /** What this request looks like to the proxy check – the setup help of the tabs. */
  const requestInfo = (req: FastifyRequest, provider: ProxyProvider): ProxyRequestInfo => {
    const { config: cfg, shown } = state(provider);
    const socket = normalizeIp(req.socket.remoteAddress);
    const trusted = cfg.proxies.includes(socket);
    const gateway = d.gateways[0] ?? null;
    // Values only from a trusted address (and with the secret, if set) – from anywhere else they are just what someone typed.
    const id = proxyIdentity({ ...cfg, enabled: true }, req.socket.remoteAddress, req.headers);
    return {
      socket,
      trusted,
      // The header names the tab shows (stored ones, even when the stored value fails the check).
      idHeaderSeen: req.headers[shown.idHeader] !== undefined,
      emailHeaderSeen: req.headers[shown.emailHeader] !== undefined,
      subject: trusted ? (id?.subject ?? null) : null,
      email: trusted ? (id?.email ?? null) : null,
      gateway,
      socketIsGateway: d.gateways.includes(socket),
      // Shared secret (sec-003): did one come, and does it match? (Never the value itself.)
      secretSeen: req.headers[PROXY_SECRET_HEADER] !== undefined,
      // Against the stored setting: also when it fails the check, a correct secret is shown as correct (code-001).
      secretOk: !!shown.secretHash && proxySecretOk(shown, req.headers),
    };
  };

  /** What the tab gets: never the secret's hash, only whether one is set; loopback stays allowed but is flagged. */
  const tabState = (req: FastifyRequest, provider: ProxyProvider, shown: ProxyAuthConfig, problem: string | null): ProxyAuthState => {
    const { secretHash, ...config } = shown;
    return {
      config,
      problem,
      secretSet: !!secretHash,
      loopback: shown.proxies.filter(isLoopback),
      request: requestInfo(req, provider),
      linked: d.auth.proxyLinks().filter((l) => l.provider === provider).length,
    };
  };
  return { state, config, signIn, requestInfo, tabState };
}

/** Routes of the provider tabs (admins) and of the own account's connections. */
export function registerProxyAuth(server: FastifyInstance, proxy: ProxyAuth, d: ProxyAuthDeps) {
  server.get<{ Params: { provider: string } }>('/api/admin/proxy-auth/:provider', async (req) => {
    d.requireAdmin(req);
    if (!isProxyProvider(req.params.provider)) throw new NotFoundError('Nicht gefunden');
    const provider = req.params.provider;
    const { shown, problem } = proxy.state(provider);
    return proxy.tabState(req, provider, shown, problem);
  });

  server.put<{ Params: { provider: string }; Body: Record<string, unknown> }>('/api/admin/proxy-auth/:provider', async (req, reply) => {
    d.requireAdmin(req);
    if (!isProxyProvider(req.params.provider)) throw new NotFoundError('Nicht gefunden');
    const provider = req.params.provider;
    let cfg;
    try {
      // Fields not sent keep their stored value (also when that value failed the check – it is checked again here).
      // The secret has its own routes – the form can neither set nor clear it.
      const { secretHash: _ignored, ...body } = req.body ?? {};
      cfg = validateProxyConfig(body, proxy.state(provider).shown, d.gateways);
    } catch (e) {
      // The form shows the message at the field; for this refusal also a help button (the provider's section explains it).
      if (e instanceof ProxyFieldError) return reply.code(400).send({ error: e.message, field: e.field, ...(e instanceof ProxyConfigError && { help: provider }) });
      throw new PathError((e as Error).message);
    }
    d.settings.set(`proxy_auth_${provider}`, JSON.stringify(cfg));
    d.audit(req, 'proxy-auth-changed', `${PROXY_LABEL[provider]}: ${cfg.enabled ? `an (Proxy ${cfg.proxies.join(', ')})` : 'aus'}`);
    return proxy.tabState(req, provider, cfg, null);
  });

  /**
   * Shared secret (sec-003): Kaveyl Wiki makes it, keeps only its hash and shows it once. From then on the proxy must send
   * it in X-Kaveyl-Wiki-Proxy-Secret – a path that forgets to clear the identity headers signs no one in.
   */
  server.post<{ Params: { provider: string } }>('/api/admin/proxy-auth/:provider/secret', async (req) => {
    d.requireAdmin(req);
    if (!isProxyProvider(req.params.provider)) throw new NotFoundError('Nicht gefunden');
    const provider = req.params.provider;
    const { shown, problem } = proxy.state(provider);
    const secret = randomBytes(32).toString('base64url');
    const next = { ...shown, secretHash: hashProxySecret(secret) };
    d.settings.set(`proxy_auth_${provider}`, JSON.stringify(next));
    d.auth.endAllProxySessions(provider); // also those holding only the live connection open (veto check 2026-10-16)
    d.audit(req, 'proxy-auth-secret', `${PROXY_LABEL[provider]}: Geheimwert für den Proxy neu erzeugt`);
    return { secret, state: proxy.tabState(req, provider, next, problem) };
  });

  server.delete<{ Params: { provider: string } }>('/api/admin/proxy-auth/:provider/secret', async (req) => {
    d.requireAdmin(req);
    if (!isProxyProvider(req.params.provider)) throw new NotFoundError('Nicht gefunden');
    const provider = req.params.provider;
    const { shown, problem } = proxy.state(provider);
    const next = { ...shown, secretHash: '' };
    d.settings.set(`proxy_auth_${provider}`, JSON.stringify(next));
    d.auth.endAllProxySessions(provider);
    d.audit(req, 'proxy-auth-secret-removed', `${PROXY_LABEL[provider]}: Geheimwert für den Proxy entfernt`, { level: 'warn' });
    return proxy.tabState(req, provider, next, problem);
  });

  /** The own account and the auth proxies: connected?, can it be connected from here? */
  server.get('/api/account/proxy', async (req): Promise<AccountProxy[]> => {
    const links = d.auth.proxyLinks(req.user!.id);
    return PROXY_PROVIDERS.map((provider) => {
      const cfg = proxy.config(provider);
      const id = proxyIdentity(cfg, req.socket.remoteAddress, req.headers);
      return { provider, label: PROXY_LABEL[provider], enabled: cfg.enabled, linkedAt: links.find((l) => l.provider === provider)?.createdAt ?? null, available: !!id?.subject };
    }).filter((p) => p.enabled || p.linkedAt);
  });

  /** Connect the own account: the id the trusted proxy sends with this very request is remembered. */
  server.post<{ Params: { provider: string } }>('/api/account/proxy/:provider', async (req) => {
    if (!isProxyProvider(req.params.provider)) throw new NotFoundError('Nicht gefunden');
    const provider = req.params.provider;
    const id = proxyIdentity(proxy.config(provider), req.socket.remoteAddress, req.headers);
    if (!id?.subject) throw new PathError(`Diese Anfrage kam nicht über ${PROXY_LABEL[provider]} – Kaveyl Wiki über die Adresse öffnen, die ${PROXY_LABEL[provider]} schützt, und dort angemeldet verbinden`);
    d.auth.linkProxy(req.user!.id, provider, id.subject);
    d.audit(req, 'proxy-linked', `${PROXY_LABEL[provider]}: Konto verbunden`);
    return { ok: true };
  });

  server.delete<{ Params: { provider: string } }>('/api/account/proxy/:provider', async (req) => {
    if (!isProxyProvider(req.params.provider)) throw new NotFoundError('Nicht gefunden');
    if (d.auth.unlinkProxy(req.user!.id, req.params.provider)) d.audit(req, 'proxy-unlinked', `${PROXY_LABEL[req.params.provider]}: Verbindung gelöst`);
    return { ok: true };
  });

  server.delete<{ Params: { id: string; provider: string } }>('/api/admin/users/:id/proxy/:provider', async (req) => {
    d.requireAdmin(req);
    if (!isProxyProvider(req.params.provider)) throw new NotFoundError('Nicht gefunden');
    const user = d.auth.getUser(req.params.id);
    if (!user) throw new NotFoundError('Benutzer nicht gefunden');
    if (d.auth.unlinkProxy(user.id, req.params.provider)) d.audit(req, 'proxy-unlinked', `${PROXY_LABEL[req.params.provider]}: Verbindung von ${user.username} gelöst`);
    return { ok: true };
  });
}
