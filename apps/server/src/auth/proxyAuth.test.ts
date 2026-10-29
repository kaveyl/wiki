import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath, defaultGateway, defaultGateway6, headerValue, normalizeIp, parseProxyConfig, PROXY_DEFAULTS, proxyIdentity, ProxyConfigError, readProxyConfig, validateProxyConfig } from './proxyAuth.js';

const base = PROXY_DEFAULTS.authentik;
const signOut = 'https://wiki.example.test/outpost.goauthentik.io/sign_out';

describe('auth proxy settings (AD-049)', () => {
  it('takes single addresses only, normalised; no ranges, no catch-all', () => {
    expect(validateProxyConfig({ enabled: true, proxies: ['192.168.7.40', ' ::ffff:10.0.0.2 ', '192.168.7.40', 'FD00::1'], logoutUrl: signOut }, base).proxies).toEqual(['192.168.7.40', '10.0.0.2', 'fd00::1']);
    expect(validateProxyConfig({ proxies: '192.168.7.40, 10.0.0.2\n10.0.0.3' as never }, base).proxies).toEqual(['192.168.7.40', '10.0.0.2', '10.0.0.3']);
    expect(() => validateProxyConfig({ proxies: ['192.168.7.0/24'] }, base)).toThrow(/keine Bereiche/);
    expect(() => validateProxyConfig({ proxies: ['0.0.0.0'] }, base)).toThrow(/nicht erlaubt/);
    expect(() => validateProxyConfig({ proxies: ['::'] }, base)).toThrow(/nicht erlaubt/);
    expect(() => validateProxyConfig({ proxies: ['proxy.lan'] }, base)).toThrow(/Keine gültige IP/);
    expect(() => validateProxyConfig({ proxies: ['fe80::1%eth0'] }, base)).toThrow(/Keine gültige IP/);
    // IPv6 written out still matches the short form the socket reports.
    expect(validateProxyConfig({ proxies: ['2001:DB8:0:0::1', 'fd00:0000::0040'] }, base).proxies).toEqual(['2001:db8::1', 'fd00::40']);
  });

  it('both Docker gateways are refused – IPv4 and IPv6, also written differently (code-006)', () => {
    const gateways = ['172.17.0.1', 'fd00:abcd::1'];
    expect(() => validateProxyConfig({ proxies: ['172.17.0.1'] }, base, gateways)).toThrow(ProxyConfigError);
    expect(() => validateProxyConfig({ proxies: ['FD00:ABCD:0::1'] }, base, gateways)).toThrow(ProxyConfigError);
    expect(() => validateProxyConfig({ proxies: ['::ffff:172.17.0.1'] }, base, gateways)).toThrow(ProxyConfigError);
    expect(validateProxyConfig({ proxies: ['172.18.0.5'] }, base, gateways).proxies).toEqual(['172.18.0.5']);
  });

  it('switched on without an address is refused (fail-closed)', () => {
    expect(() => validateProxyConfig({ enabled: true, proxies: [] }, base)).toThrow(/Mindestens eine Proxy-Adresse/);
    expect(validateProxyConfig({ enabled: false, proxies: [] }, base).enabled).toBe(false);
    // … and without a sign-out address: „Abmelden“ would sign in again at once (AD-058).
    expect(() => validateProxyConfig({ enabled: true, proxies: ['192.168.7.40'] }, base)).toThrow(/Abmelde-Adresse angeben/);
  });

  it('header names: lower case, and never one that carries something else', () => {
    expect(validateProxyConfig({ idHeader: 'X-Authentik-UID', emailHeader: 'Remote-Email' }, base)).toMatchObject({ idHeader: 'x-authentik-uid', emailHeader: 'remote-email' });
    for (const bad of ['Cookie', 'authorization', 'X-Forwarded-User', 'Host', 'x-real-ip', 'cf-access-authenticated-user-email', 'x-kaveyl-wiki-upload', 'a b', '']) {
      expect(() => validateProxyConfig({ idHeader: bad }, base), bad).toThrow();
    }
    expect(() => validateProxyConfig({ idHeader: 'remote-user', emailHeader: 'Remote-User' }, base)).toThrow(/verschiedene/);
    for (const browserOwn of ['sec-fetch-site', 'te', 'via', 'dnt', 'priority', 'cache-control', 'pragma', 'if-none-match', 'range', 'referer', 'x-real-ip']) {
      expect(() => validateProxyConfig({ idHeader: browserOwn }, base), browserOwn).toThrow();
    }
  });

  it('logout address: http(s) only, no credentials', () => {
    expect(validateProxyConfig({ logoutUrl: 'https://wiki.example.com/outpost.goauthentik.io/sign_out' }, base).logoutUrl).toBe('https://wiki.example.com/outpost.goauthentik.io/sign_out');
    expect(() => validateProxyConfig({ logoutUrl: 'javascript:alert(1)' }, base)).toThrow(/nur http/);
    expect(() => validateProxyConfig({ logoutUrl: 'wiki.example.com/out' }, base)).toThrow(/vollständige Adresse/);
    expect(() => validateProxyConfig({ logoutUrl: 'https://u:p@example.com/' }, base)).toThrow(/ohne Zugangsdaten/);
  });

  it('a broken stored value means: off, defaults', () => {
    expect(parseProxyConfig('authentik', '{not json')).toEqual(PROXY_DEFAULTS.authentik);
    expect(parseProxyConfig('authentik', JSON.stringify({ enabled: true, proxies: [] }))).toEqual(PROXY_DEFAULTS.authentik);
    expect(parseProxyConfig('authentik', undefined)).toEqual(PROXY_DEFAULTS.authentik);
    expect(PROXY_DEFAULTS.authentik).toMatchObject({ idHeader: 'x-authentik-uid', emailHeader: 'x-authentik-email', enabled: false });
  });

  it('a stored value that no longer passes the check: off for the sign-in, but shown as stored, with the reason', () => {
    const stored = { enabled: true, proxies: ['192.168.7.40', '0.0.0.0'], idHeader: 'x-wiki-user', emailHeader: 'x-wiki-mail', logoutUrl: 'https://p.example.test/logout', autoLinkByEmail: true };
    const r = readProxyConfig('authentik', JSON.stringify(stored));
    expect(r.config).toEqual(PROXY_DEFAULTS.authentik);
    expect(r.shown).toEqual({ ...stored, secretHash: '' });
    expect(r.problem).toBe('Diese Adresse ist nicht erlaubt: 0.0.0.0');
    // unreadable parts fall back to the defaults, field by field
    const odd = readProxyConfig('authentik', JSON.stringify({ enabled: 'ja', proxies: 'x', idHeader: 7, logoutUrl: 'https://p.example.test/' }));
    expect(odd.shown).toEqual({ ...PROXY_DEFAULTS.authentik, logoutUrl: 'https://p.example.test/' });
    expect(odd.config).toEqual(PROXY_DEFAULTS.authentik);
    expect(odd.problem).toBeTruthy();
    for (const broken of ['{not json', 'null', '[1]', '"x"']) {
      expect(readProxyConfig('authentik', broken), broken).toEqual({ config: PROXY_DEFAULTS.authentik, shown: PROXY_DEFAULTS.authentik, problem: 'Gespeicherter Wert ist nicht lesbar' });
    }
    expect(readProxyConfig('authentik', undefined)).toEqual({ config: PROXY_DEFAULTS.authentik, shown: PROXY_DEFAULTS.authentik, problem: null });
    const valid = readProxyConfig('authentik', JSON.stringify({ enabled: true, proxies: ['192.168.7.40'], logoutUrl: signOut }));
    expect(valid.problem).toBeNull();
    expect(valid.shown).toEqual(valid.config);
    expect(valid.config.enabled).toBe(true);
  });
});

describe('who the proxy names', () => {
  const cfg = validateProxyConfig({ enabled: true, proxies: ['192.168.7.40', 'fd00::40'], logoutUrl: signOut }, base);
  const h = { 'x-authentik-uid': 'abc123', 'x-authentik-email': 'anna@example.test' };

  it('only straight from a configured proxy (socket address, also IPv4-mapped)', () => {
    expect(proxyIdentity(cfg, '192.168.7.40', h)).toEqual({ subject: 'abc123', email: 'anna@example.test' });
    expect(proxyIdentity(cfg, '::ffff:192.168.7.40', h)).toEqual({ subject: 'abc123', email: 'anna@example.test' });
    expect(proxyIdentity(cfg, 'FD00::40', h)?.subject).toBe('abc123');
    expect(proxyIdentity(cfg, '192.168.7.41', h)).toBeNull();
    expect(proxyIdentity(cfg, undefined, h)).toBeNull();
    expect(proxyIdentity({ ...cfg, enabled: false }, '192.168.7.40', h)).toBeNull();
  });

  it('a header sent twice (browser + proxy) or with odd characters counts as missing', () => {
    expect(headerValue({ 'x-authentik-uid': 'abc, evil' }, 'x-authentik-uid')).toBeNull();
    expect(headerValue({ 'x-authentik-uid': ['a', 'b'] }, 'x-authentik-uid')).toBeNull();
    expect(headerValue({ 'x-authentik-uid': '  ' }, 'x-authentik-uid')).toBeNull();
    expect(headerValue({ 'x-authentik-uid': 'x'.repeat(513) }, 'x-authentik-uid')).toBeNull();
    expect(headerValue({ 'x-authentik-uid': ' abc ' }, 'x-authentik-uid')).toBe('abc');
  });

  it('normalises socket addresses', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp(undefined)).toBe('');
  });
});

it('canonical paths only: no dot segments, //, encoded / . \\ – umlauts and %25 are fine', () => {
  for (const bad of ['/api/mounts/../x', '/api/./x', '/api/x/..', '/api//x', '/api/x%2Fy', '/api/x%2e%2e/y', '/api/x%5Cy', '/api/x\\y']) expect(canonicalPath(bad), bad).toBe(false);
  for (const good of ['/api/mounts', '/api/notes/m/Gr%C3%B6%C3%9Fe%20100%25.md?x=1', '/api/notes/m/a.b/c..d.md', '/api/notes/m/.kaveyl-wiki.yml']) expect(canonicalPath(good), good).toBe(true);
});

it('reads the default gateway of the container (Docker bridge warning)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  const f = join(dir, 'route');
  writeFileSync(f, 'Iface\tDestination\tGateway\tFlags\nlo\t0000007F\t00000000\t0001\neth0\t00000000\t010011AC\t0003\n');
  expect(defaultGateway(f)).toBe('172.17.0.1');
  expect(defaultGateway(join(dir, 'missing'))).toBeNull();
});

describe('defaultGateway6', () => {
  it('reads the IPv6 default route; none without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw6-'));
    const file = join(dir, 'ipv6_route');
    writeFileSync(
      file,
      [
        'fd000000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0',
        '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fd000000000000000000000000000001 00000400 00000002 00000000 00000003     eth0',
      ].join('\n'),
    );
    expect(defaultGateway6(file)).toBe('fd00::1');
    writeFileSync(file, 'fd000000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0\n');
    expect(defaultGateway6(file)).toBeNull();
    expect(defaultGateway6(join(dir, 'fehlt'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
