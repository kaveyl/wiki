import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CloudflareAccess } from './cloudflare.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (claims: Record<string, unknown>, kid = 'k1', key = privateKey) => {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
};
const cfg = { teamDomain: 'https://Team.cloudflareaccess.com/', aud: 'AUD1' };
const good = { aud: ['AUD1'], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600, email: 'Maria@Example.test' };

describe('Cloudflare Access JWT', () => {
  it('accepts a valid token and returns the e-mail; rejects everything else', async () => {
    const urls: string[] = [];
    const cf = new CloudflareAccess(async (url) => {
      urls.push(url);
      return { keys: [jwk] };
    });
    expect(await cf.verify(token(good), cfg)).toBe('maria@example.test');
    expect(urls).toEqual(['https://team.cloudflareaccess.com/cdn-cgi/access/certs']);
    expect(await cf.verify(token({ ...good, aud: ['ANDERE'] }), cfg)).toBeNull();
    expect(await cf.verify(token({ ...good, iss: 'https://boese.example' }), cfg)).toBeNull();
    expect(await cf.verify(token({ ...good, exp: Math.floor(Date.now() / 1000) - 120 }), cfg)).toBeNull();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(await cf.verify(token(good, 'k1', other), cfg)).toBeNull();
    expect(await cf.verify(token(good, 'unbekannt'), cfg)).toBeNull();
    expect(await cf.verify('kein.jwt', cfg)).toBeNull();
    expect(await cf.verify(token(good), { ...cfg, aud: '' })).toBeNull();
  });
});
