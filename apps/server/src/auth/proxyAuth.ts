// Sign-in through an auth proxy in front of Kaveyl Wiki (AD-049): Authentik (forward auth / proxy outpost; Pangolin
// removed with AD-058 – no sign-out address). The proxy names the signed-in person in request headers – which anyone can send who reaches
// Kaveyl Wiki directly. So a header only counts when the request comes straight from one of the proxy addresses the
// admin entered: the socket address, never X-Forwarded-For / req.ip / TRUST_PROXY. Everything else is ignored and
// the normal login appears (fail-closed). Only accounts their owner connected once (fixed provider id) sign in;
// optionally normal users by e-mail. No account is ever created.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { PROXY_PROVIDERS, type ProxyAuthSettings, type ProxyField, type ProxyProvider } from '@kaveyl-wiki/core';

// Shared with the web app (code-006).
export { PROXY_LABEL, PROXY_PROVIDERS, type ProxyField, type ProxyProvider } from '@kaveyl-wiki/core';

export interface ProxyAuthConfig extends ProxyAuthSettings {
  /**
   * SHA-256 (hex) of the shared secret the proxy must send in PROXY_SECRET_HEADER (sec-003); '' = none. Never leaves
   * the server – the tab only learns whether one is set. Set only through its own route, never through the form.
   */
  secretHash: string;
}

/** Header with the shared secret (sec-003): set by the proxy, so a path that forgot to clear the identity headers still signs no one in. */
export const PROXY_SECRET_HEADER = 'x-kaveyl-wiki-proxy-secret';

/** Provider defaults (checked against the provider docs 2026-10-16). */
export const PROXY_DEFAULTS: Record<ProxyProvider, ProxyAuthConfig> = {
  authentik: { enabled: false, proxies: [], idHeader: 'x-authentik-uid', emailHeader: 'x-authentik-email', logoutUrl: '', autoLinkByEmail: false, secretHash: '' },
};

/** Headers that carry something else and must never be read as an identity. */
const RESERVED_HEADERS = new RegExp(
  `^(cookie|authorization|proxy-authorization|host|forwarded|x-forwarded-.*|x-real-ip|cf-access-.*|cf-connecting-ip|content-.*|connection|keep-alive|upgrade|transfer-encoding|te|trailer|via|origin|referer|user-agent|accept.*|sec-.*|dnt|priority|cache-control|pragma|if-.*|range|x-kaveyl-wiki-.*)$`,
);

export const isProxyProvider = (v: unknown): v is ProxyProvider => typeof v === 'string' && (PROXY_PROVIDERS as readonly string[]).includes(v);

/** Socket addresses come as `::ffff:a.b.c.d` on a dual-stack listener – compare them as plain IPv4. */
export function normalizeIp(addr: string | undefined): string {
  const a = (addr ?? '').trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped ? mapped[1]! : a;
}

/** A stored secret hash: SHA-256 in hex. */
const isSecretHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** A refused value of one field of the form. */
export class ProxyFieldError extends Error {
  constructor(
    message: string,
    readonly field: ProxyField,
  ) {
    super(message);
  }
}

/** A refusal the manual explains: the form shows a help button to the provider's section. */
export class ProxyConfigError extends ProxyFieldError {}

export const isLoopback = (ip: string) => ip === '::1' || ip.startsWith('127.');

/**
 * Validates and normalises what the admin entered; throws a message for the form. `gateways`: the container's Docker
 * gateways – refused (owner 2026-10-16, sec-002): whoever comes through them would count as the proxy.
 */
export function validateProxyConfig(input: Partial<Record<keyof ProxyAuthConfig, unknown>>, base: ProxyAuthConfig, gateways: string[] = []): ProxyAuthConfig {
  const enabled = input.enabled === undefined ? base.enabled : input.enabled === true;
  const rawProxies = input.proxies === undefined ? base.proxies : Array.isArray(input.proxies) ? input.proxies : String(input.proxies).split(/[\s,]+/);
  const proxies: string[] = [];
  for (const raw of rawProxies.map((p) => String(p).trim()).filter(Boolean)) {
    if (raw.includes('/')) throw new ProxyFieldError(`Nur einzelne Adressen, keine Bereiche: ${raw}`, 'proxies');
    let ip = normalizeIp(raw);
    const kind = isIP(ip);
    if (!kind) throw new ProxyFieldError(`Keine gültige IP-Adresse: ${raw}`, 'proxies');
    // The socket reports IPv6 in the short form – store it that way, or a written-out address never matches.
    if (kind === 6) {
      try {
        ip = normalizeIp(new URL(`http://[${ip}]/`).hostname.slice(1, -1));
      } catch {
        throw new ProxyFieldError(`Keine gültige IP-Adresse: ${raw}`, 'proxies'); // e.g. with a zone id (fe80::1%eth0)
      }
    }
    if (ip === '0.0.0.0' || ip === '::' || ip === '255.255.255.255') throw new ProxyFieldError(`Diese Adresse ist nicht erlaubt: ${raw}`, 'proxies');
    if (gateways.includes(ip))
      throw new ProxyConfigError(
        `${ip} ist das Docker-Gateway und als Proxy-Adresse nicht erlaubt: Über diese Adresse kommen auch andere Programme und Container dieses Rechners, je nach Einrichtung jede Anfrage aus dem eigenen Netz – Kaveyl Wiki würde ihnen allen glauben, wen sie anmelden. Den Proxy ins selbe Docker-Netz wie Kaveyl Wiki hängen und die Adresse des Proxy-Containers eintragen.`,
        'proxies',
      );
    if (!proxies.includes(ip)) proxies.push(ip);
  }
  if (proxies.length > 20) throw new ProxyFieldError('Höchstens 20 Proxy-Adressen', 'proxies');
  const header = (v: unknown, fallback: string, label: string, field: ProxyField) => {
    const h = (v === undefined ? fallback : String(v)).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(h)) throw new ProxyFieldError(`${label}: nur Buchstaben, Ziffern und Bindestriche`, field);
    if (RESERVED_HEADERS.test(h)) throw new ProxyFieldError(`${label}: „${h}“ trägt etwas anderes und ist hier nicht erlaubt`, field);
    return h;
  };
  const idHeader = header(input.idHeader, base.idHeader, 'Header mit der Kennung', 'idHeader');
  const emailHeader = header(input.emailHeader, base.emailHeader, 'Header mit der E-Mail-Adresse', 'emailHeader');
  if (idHeader === emailHeader) throw new ProxyFieldError('Kennung und E-Mail brauchen zwei verschiedene Header', 'emailHeader');
  const logoutUrl = (input.logoutUrl === undefined ? base.logoutUrl : String(input.logoutUrl)).trim();
  if (logoutUrl) {
    let u: URL;
    try {
      u = new URL(logoutUrl);
    } catch {
      throw new ProxyFieldError('Abmelde-Adresse: vollständige Adresse mit https:// angeben', 'logoutUrl');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ProxyFieldError('Abmelde-Adresse: nur http(s)', 'logoutUrl');
    if (u.username || u.password) throw new ProxyFieldError('Abmelde-Adresse ohne Zugangsdaten angeben', 'logoutUrl');
  }
  const autoLinkByEmail = input.autoLinkByEmail === undefined ? base.autoLinkByEmail : input.autoLinkByEmail === true;
  if (enabled && !proxies.length) throw new ProxyFieldError('Mindestens eine Proxy-Adresse angeben – ohne sie wird niemand über den Proxy angemeldet', 'proxies');
  // Without it „Abmelden“ would sign the person in again at once (AD-058).
  if (enabled && !logoutUrl) throw new ProxyFieldError('Abmelde-Adresse angeben – ohne sie meldet „Abmelden“ sofort wieder an', 'logoutUrl');
  // Only a well-formed stored hash counts; the admin form never sends one (the route strips it).
  const secretHash = isSecretHash(input.secretHash) ? input.secretHash : base.secretHash;
  return { enabled, proxies, idHeader, emailHeader, logoutUrl, autoLinkByEmail, secretHash };
}

export interface StoredProxyConfig {
  /** What counts for the sign-in: a stored value that fails the check gives the defaults, switched off (fail-closed). */
  config: ProxyAuthConfig;
  /** What the tab shows: the stored values as far as readable – so correcting one field keeps the others. */
  shown: ProxyAuthConfig;
  /** Why the stored value fails the check (e.g. after the check became stricter); null when it passes. */
  problem: string | null;
}

/** Reads the stored config (settings value = JSON); see StoredProxyConfig. */
export function readProxyConfig(provider: ProxyProvider, stored: string | undefined, gateways: string[] = []): StoredProxyConfig {
  const base = PROXY_DEFAULTS[provider];
  if (!stored) return { config: { ...base }, shown: { ...base }, problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: { ...base }, shown: { ...base }, problem: 'Gespeicherter Wert ist nicht lesbar' };
  const input = raw as Record<string, unknown>;
  try {
    const config = validateProxyConfig(input, base, gateways);
    return { config, shown: config, problem: null };
  } catch (e) {
    const str = (k: 'idHeader' | 'emailHeader' | 'logoutUrl') => (typeof input[k] === 'string' ? (input[k] as string) : base[k]);
    const bool = (k: 'enabled' | 'autoLinkByEmail') => (typeof input[k] === 'boolean' ? (input[k] as boolean) : base[k]);
    const shown: ProxyAuthConfig = {
      enabled: bool('enabled'),
      proxies: Array.isArray(input.proxies) ? input.proxies.filter((p): p is string => typeof p === 'string') : [...base.proxies],
      idHeader: str('idHeader'),
      emailHeader: str('emailHeader'),
      logoutUrl: str('logoutUrl'),
      autoLinkByEmail: bool('autoLinkByEmail'),
      secretHash: isSecretHash(input.secretHash) ? input.secretHash : '',
    };
    return { config: { ...base }, shown, problem: (e as Error).message };
  }
}

/** The config that counts for the sign-in; broken or missing values give the defaults, switched off. */
export function parseProxyConfig(provider: ProxyProvider, stored: string | undefined, gateways: string[] = []): ProxyAuthConfig {
  return readProxyConfig(provider, stored, gateways).config;
}

export const hashProxySecret = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');

/** No secret set → true; else exactly one value whose hash matches (compared in constant time). */
export function proxySecretOk(cfg: ProxyAuthConfig, headers: Record<string, string | string[] | undefined>): boolean {
  if (!cfg.secretHash) return true;
  // Proxies set up for the old app still send its header name (AD-053).
  const v = headerValue(headers, PROXY_SECRET_HEADER);
  if (!v) return false;
  return timingSafeEqual(Buffer.from(hashProxySecret(v), 'hex'), Buffer.from(cfg.secretHash, 'hex'));
}

/**
 * The value of a header, if exactly one non-empty value came. Node joins repeated headers with ", " – a comma
 * therefore means "sent twice" (e.g. once by the browser, once by the proxy) and is refused: which one would count?
 */
export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name];
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 512 && !/[,\r\n\0]/.test(s) ? s : null;
}

/**
 * A proxy may map a path with dot segments, // or an encoded / . \ to another location than Kaveyl Wiki's router does
 * (e.g. an exception without sign-in) – no new sign-in from such paths (veto 2026-10-16). The app never sends them.
 */
export const canonicalPath = (rawUrl: string) => !/\/\/|\/\.{1,2}(\/|$)|%2f|%2e|%5c|\\/i.test(rawUrl.split('?')[0]!);

/** What the proxy told about the person – only when the request came straight from a configured proxy address. */
export function proxyIdentity(cfg: ProxyAuthConfig, socketAddress: string | undefined, headers: Record<string, string | string[] | undefined>): { subject: string | null; email: string | null } | null {
  if (!cfg.enabled || !cfg.proxies.includes(normalizeIp(socketAddress)) || !proxySecretOk(cfg, headers)) return null;
  return { subject: headerValue(headers, cfg.idHeader), email: headerValue(headers, cfg.emailHeader) };
}

/**
 * The container's default gateway (Docker bridge): requests forwarded by Docker's userland proxy or NAT can come from
 * there for *every* client – trusting it would mean trusting everyone (refused as a proxy address, sec-002).
 */
export function defaultGateway(routeFile = '/proc/net/route'): string | null {
  try {
    for (const line of readFileSync(routeFile, 'utf8').split('\n').slice(1)) {
      const [, dest, gw] = line.trim().split(/\s+/);
      if (dest === '00000000' && gw && gw !== '00000000') {
        const n = parseInt(gw, 16);
        return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
      }
    }
  } catch {
    /* not Linux / no procfs */
  }
  return null;
}

/** The IPv6 default gateway (Docker network with IPv6, rootless) from /proc/net/ipv6_route; null if none. */
export function defaultGateway6(routeFile = '/proc/net/ipv6_route'): string | null {
  try {
    for (const line of readFileSync(routeFile, 'utf8').split('\n')) {
      const [dest, prefix, , , hop] = line.trim().split(/\s+/);
      if (dest === '0'.repeat(32) && prefix === '00' && hop && /^[0-9a-f]{32}$/.test(hop) && hop !== '0'.repeat(32)) {
        const full = hop.match(/.{4}/g)!.join(':');
        return normalizeIp(new URL(`http://[${full}]/`).hostname.slice(1, -1));
      }
    }
  } catch {
    /* no IPv6 / no procfs */
  }
  return null;
}
