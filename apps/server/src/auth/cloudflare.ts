// Cloudflare Access (PLAN.md §3, off by default): behind an Access application every request
// carries `Cf-Access-Jwt-Assertion`, an RS256 JWT signed by the team's keys. A valid token whose
// e-mail belongs to an active Kaveyl Wiki user signs that user in — no password prompt. Only the
// signature, issuer, audience and expiry are trusted; never the plain `Cf-Access-Authenticated-User-Email` header.
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

export interface AccessConfig {
  /** e.g. `meinteam.cloudflareaccess.com` */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  aud: string;
}

export type JwksFetcher = (url: string) => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class CloudflareAccess {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;

  private fetchJwks: JwksFetcher;

  constructor(fetchJwks?: JwksFetcher) {
    this.fetchJwks = fetchJwks ?? (async (url) => (await fetch(url, { signal: AbortSignal.timeout(5000) })).json() as never);
  }

  static normalizeTeam(domain: string): string {
    return domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  }

  private async key(team: string, kid: string): Promise<KeyObject | null> {
    // Keys rotate: reload at most every minute when an unknown kid shows up, otherwise hourly.
    const stale = Date.now() - this.fetchedAt > 3600_000;
    if (stale || (!this.keys.has(kid) && Date.now() - this.fetchedAt > 60_000)) {
      const { keys } = await this.fetchJwks(`https://${team}/cdn-cgi/access/certs`);
      this.keys = new Map(keys.filter((k) => k.kid && k.kty === 'RSA').map((k) => [k.kid!, createPublicKey({ key: k, format: 'jwk' })]));
      this.fetchedAt = Date.now();
    }
    return this.keys.get(kid) ?? null;
  }

  /** The verified e-mail of the token, or null (invalid, expired, wrong audience/issuer). */
  async verify(token: string, cfg: AccessConfig, now = Date.now()): Promise<string | null> {
    const team = CloudflareAccess.normalizeTeam(cfg.teamDomain);
    const parts = token.split('.');
    if (parts.length !== 3 || !team || !cfg.aud) return null;
    try {
      const header = JSON.parse(b64url(parts[0]!).toString('utf8')) as { alg?: string; kid?: string };
      if (header.alg !== 'RS256' || !header.kid) return null;
      const key = await this.key(team, header.kid);
      if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]!))) return null;
      const claims = JSON.parse(b64url(parts[1]!).toString('utf8')) as { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
      const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!auds.includes(cfg.aud)) return null;
      if (claims.iss !== `https://${team}`) return null;
      if (!claims.exp || claims.exp * 1000 < now - 30_000) return null;
      if (claims.nbf && claims.nbf * 1000 > now + 30_000) return null;
      return typeof claims.email === 'string' && claims.email.includes('@') ? claims.email.toLowerCase() : null;
    } catch {
      return null;
    }
  }
}
