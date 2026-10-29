// Runtime configuration from environment variables (see .env.example).
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  version: string;
  /** Clones of remote mounts live under <dataPath>/repos. */
  dataPath: string;
  /** SQLite database and secret key. */
  configPath: string;
  /** Host folders that local mounts may point into (container paths). */
  localRoots: string[];
  /** Seconds between periodic fetches of remote mounts. */
  syncIntervalSec: number;
  /** Seconds of inactivity before pending edits of a remote mount are committed and pushed. */
  /**
   * Test-only override of every mount's commit pause (`commitIdleSec`) and the maximum wait;
   * null in production. Env: COMMIT_IDLE_OVERRIDE_SEC.
   */
  commitDelaySec: number | null;
  /** Directory with the built web app (served as static files when present). */
  webRoot: string;
  /** Folder for local backup targets (`/backup` in the container, AD-038); null = none. */
  backupRoot: string | null;
  /**
   * Which reverse proxies may name the client IP (X-Forwarded-For): their addresses/ranges, `true` (anyone – only when
   * nothing reaches Kaveyl Wiki except through the proxy) or `false`. Env TRUST_PROXY; default the own network (AD-047).
   */
  trustProxy: boolean | string;
}

/** Default of TRUST_PROXY (AD-047): the own network (loopback, private ranges). */
export const TRUST_OWN_NETWORK = 'loopback, uniquelocal';

/** Names @fastify/proxy-addr accepts besides addresses. */
const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** One TRUST_PROXY entry as @fastify/proxy-addr accepts it: a name, an IP, IP/prefix or (IPv4) IP/netmask. */
function validProxyEntry(e: string): boolean {
  if (PROXY_NAMES.has(e)) return true;
  const slash = e.lastIndexOf('/');
  const kind = isIP(slash === -1 ? e : e.slice(0, slash));
  if (!kind) return false;
  if (slash === -1) return true;
  const range = e.slice(slash + 1);
  if (/^\d+$/.test(range)) return Number(range) > 0 && Number(range) <= (kind === 6 ? 128 : 32);
  if (kind !== 4 || isIP(range) !== 4) return false;
  const host = 2 ** 32 - 1 - range.split('.').reduce((a, b) => a * 256 + Number(b), 0);
  return host < 2 ** 32 - 1 && Number.isInteger(Math.log2(host + 1)); // contiguous, not 0.0.0.0
}

/**
 * TRUST_PROXY: "true" / "false" (alone) or addresses and ranges, separated by commas, spaces or line breaks; `#` starts
 * a comment up to the end of the line (compose block one per line). Empty = own network (loopback, private ranges).
 * A bad entry stops the start with an error naming it.
 */
export function parseTrustProxy(v: string | undefined): boolean | string {
  const entries = (v ?? '')
    .split('\n')
    .map((line) => line.replace(/#.*/, ''))
    .join(' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!entries.length) return TRUST_OWN_NETWORK;
  if (entries.length === 1 && (entries[0] === 'true' || entries[0] === 'false')) return entries[0] === 'true';
  const bad = entries.find((e) => !validProxyEntry(e));
  if (bad !== undefined) {
    throw new Error(
      `TRUST_PROXY: invalid entry "${bad}" – expected IP addresses or ranges (e.g. 192.168.1.10, 192.168.1.0/24), ` +
        'loopback, linklocal or uniquelocal; true/false only alone',
    );
  }
  return entries.join(', ');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    port: num(env.PORT, 8000),
    host: env.HOST ?? '0.0.0.0',
    version: env.KAVEYL_WIKI_VERSION ?? 'dev',
    dataPath: resolve(env.DATA_PATH ?? './.local/data'),
    configPath: resolve(env.CONFIG_PATH ?? './.local/config'),
    localRoots: (env.LOCAL_ROOTS ?? '')
      .split(':')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => resolve(p)),
    syncIntervalSec: num(env.SYNC_INTERVAL_SEC, 300),
    commitDelaySec: env.COMMIT_IDLE_OVERRIDE_SEC ? num(env.COMMIT_IDLE_OVERRIDE_SEC, 0) : null,
    webRoot: resolve(env.WEB_ROOT ?? './apps/web/dist'),
    backupRoot: env.BACKUP_ROOT === '' ? null : resolve(env.BACKUP_ROOT ?? './.local/backup'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
