// Pictures an export does not contain (HedgeDoc keeps them on its server): on request the import fetches them from
// the old server and puts them next to the notes. Only what the program itself serves as an upload is fetched –
// `GET <server>/uploads/<name>.<picture or pdf>`, no redirects, no loopback or link-local address (the own network –
// the Docker host too – stays reachable on purpose: the old server is usually there), bounded in size, time and number.
// A server that does not answer is given up after the first try; whatever could not be fetched stays a web link and is
// named in the report.
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { posix } from 'node:path';
import type { Draft, DraftFile, RemotePicture } from './types.js';
import type { SourceFile } from './zip.js';
import { outsideCode, relHref } from './text.js';

/**
 * All fetched files wait in memory until they are written – hence the total of 200 MB (one import at a time). 30 s per
 * file, 10 minutes for all; a server that breaks off three downloads in a row is given up like one that does not answer.
 */
export const REMOTE_LIMITS = { count: 2000, each: 50 * 1024 * 1024, total: 200 * 1024 * 1024, timeoutMs: 30_000, totalMs: 10 * 60_000, parallel: 4, strikes: 3 };

const PATH = /^\/uploads\/[^/?#]+\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?|pdf)$/i;
const TYPE = /^(image\/|application\/pdf\b)/i;

/** Fetches one file within `timeoutMs`; throws `RemoteError` (`server: true` = the server is not reachable, give it up). */
export type PictureFetcher = (url: string, timeoutMs?: number) => Promise<Uint8Array>;

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly server = false,
    /** Too slow or broken off – three of these in a row and the server is given up. */
    readonly strike = false,
  ) {
    super(message);
  }
}

/** Loopback, link-local and the like – never fetched (the old server is somewhere in the network, not here). */
const LOCAL = new BlockList();
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('0.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL.addSubnet('224.0.0.0', 4, 'ipv4');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addAddress('::', 'ipv6');
LOCAL.addSubnet('fe80::', 10, 'ipv6');
LOCAL.addSubnet('ff00::', 8, 'ipv6');

function isLocal(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return LOCAL.check(mapped, 'ipv4');
  return LOCAL.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** Whether `url` is something the import may fetch at all (scheme, path, no credentials). */
export function fetchable(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && PATH.test(u.pathname);
  } catch {
    return false;
  }
}

/** The real fetcher. `allowLocal` only for tests against a server on this machine. */
export function webFetcher({ allowLocal = false } = {}): PictureFetcher {
  return async (url, timeoutMs = REMOTE_LIMITS.timeoutMs) => {
    if (!fetchable(url)) throw new RemoteError('not an upload');
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((a) => a.map((x) => x.address), () => [] as string[]);
    if (!addresses.length) throw new RemoteError('unknown server', true);
    if (!allowLocal && addresses.some(isLocal)) throw new RemoteError('address on this machine', true);
    let res: Response;
    try {
      res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, timeoutMs)), headers: { 'user-agent': 'Kaveyl Wiki import' } });
    } catch {
      throw new RemoteError('server not reachable', true);
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new RemoteError(`HTTP ${res.status}`);
    }
    if (!TYPE.test(res.headers.get('content-type') ?? '') || Number(res.headers.get('content-length')) > REMOTE_LIMITS.each) {
      await res.body?.cancel();
      throw new RemoteError('no picture or too big');
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > REMOTE_LIMITS.each) throw new RemoteError('too big');
        parts.push(chunk);
      }
    } catch (e) {
      throw e instanceof RemoteError ? e : new RemoteError('download broke off', false, true);
    }
    return Buffer.concat(parts);
  };
}

/**
 * Fetches `draft.remote` with `fetcher`: each file that arrives goes into `assets/` next to the first note showing it,
 * and the notes link there; the rest stays in `draft.remote` (`remoteTried` says the report should name them as failed).
 */
export async function fetchRemote(draft: Draft, fetcher: PictureFetcher): Promise<void> {
  const pictures = draft.remote ?? [];
  const taken = new Set([...draft.notes.map((n) => n.from.toLowerCase()), ...draft.files.map((f) => f.from.toLowerCase())]);
  const deadServers = new Set<string>();
  const strikes = new Map<string, number>();
  const until = Date.now() + REMOTE_LIMITS.totalMs;
  const failed: typeof pictures = [];
  const got: (RemotePicture & { data: Uint8Array })[] = [];
  let total = 0;
  let next = 0;
  const work = async () => {
    while (next < pictures.length) {
      const pic = pictures[next++]!;
      const server = new URL(pic.url).host;
      const left = until - Date.now();
      if (next > REMOTE_LIMITS.count || deadServers.has(server) || total > REMOTE_LIMITS.total || left <= 0) {
        failed.push(pic);
        continue;
      }
      try {
        const data = await fetcher(pic.url, Math.min(REMOTE_LIMITS.timeoutMs, left));
        strikes.delete(server);
        total += data.length;
        if (total > REMOTE_LIMITS.total) failed.push(pic);
        else got.push({ ...pic, data });
      } catch (e) {
        const strike = e instanceof RemoteError && e.strike ? (strikes.get(server) ?? 0) + 1 : 0;
        strikes.set(server, strike);
        if ((e instanceof RemoteError && e.server) || strike >= REMOTE_LIMITS.strikes) deadServers.add(server);
        failed.push(pic);
      }
    }
  };
  await Promise.all(Array.from({ length: REMOTE_LIMITS.parallel }, work));

  // In the order of the export, so names and places do not depend on which download finished first.
  got.sort((a, b) => pictures.findIndex((p) => p.url === a.url) - pictures.findIndex((p) => p.url === b.url));
  const notes = new Map(draft.notes.map((n) => [n.from, n]));
  for (const pic of got) {
    const first = pic.notes[0]!;
    const original = decodeURIComponent(posix.basename(new URL(pic.url).pathname));
    const base = safeName(pic.title ? `${pic.title.replace(/\.\w{2,5}$/, '').slice(0, 80)}${posix.extname(original)}` : original);
    const dir = posix.join(posix.dirname(first), 'assets');
    let from = posix.join(dir, base);
    for (let i = 2; taken.has(from.toLowerCase()); i++) from = posix.join(dir, base.replace(/(\.[^.]*)?$/, ` ${i}$1`));
    taken.add(from.toLowerCase());
    const file: DraftFile = { from, dir: from.split('/').slice(0, -1).filter((s) => s !== '.'), name: posix.basename(from), source: memoryFile(from, pic.data) };
    draft.files.push(file);
    for (const at of pic.notes) {
      const note = notes.get(at);
      if (!note) continue;
      const rel = relHref(at, from);
      note.content = outsideCode(note.content, (part) => part.split(pic.url).join(rel), false);
    }
  }
  failed.sort((a, b) => pictures.indexOf(a) - pictures.indexOf(b));
  draft.remote = failed;
  draft.remoteTried = true;
}

const safeName = (name: string) => name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '') || 'bild';

function memoryFile(path: string, data: Uint8Array): SourceFile {
  return { path, size: data.length, modified: new Date(), bytes: async () => data, text: async () => null };
}
