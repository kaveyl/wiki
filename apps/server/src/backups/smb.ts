// SMB access for backup targets (AD-038) through the `smbclient` program. Files go through
// stdin/stdout (`put -` / `get … -`), the password only through the child's environment
// (PASSWD; never an argument — those are visible to everyone via `ps`). Only full paths are
// used: a failed `cd` would not stop smbclient and the next command would hit the share root.
// Tests point SMBCLIENT at a wrapper that runs smbclient inside the Samba test container.
// SEE-DOC: DECISIONS.md AD-038

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export class SmbError extends Error {}

export interface SmbLocation {
  host: string;
  port: number | null;
  share: string;
  /** Folder inside the share, POSIX, '' = share root. */
  dir: string;
}

export interface SmbAuth {
  username: string;
  password: string;
  domain?: string | null;
}

/** Characters smbclient's command line cannot carry safely inside quotes. */
export const UNSAFE = /["\u0000-\u001f;]/;

/** `\\server\freigabe\pfad`, `//server/freigabe/pfad` or `smb://server[:port]/freigabe/pfad`. */
export function parseSmbLocation(input: string): SmbLocation {
  let s = input.trim().replace(/\\/g, '/');
  let port: number | null = null;
  if (/^smb:\/\//i.test(s)) s = `//${s.slice(6)}`;
  if (!s.startsWith('//')) throw new SmbError('Adresse im Format \\\\server\\freigabe oder //server/freigabe/ordner angeben');
  const parts = s.slice(2).split('/').filter(Boolean);
  if (parts.length < 2) throw new SmbError('Server und Freigabe angeben, z. B. \\\\nas\\backup');
  let host = parts[0]!;
  const m = /^(.+):(\d{1,5})$/.exec(host);
  if (m) {
    host = m[1]!;
    port = Number(m[2]);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new SmbError(`Servername „${host}“ ist ungültig`);
  const [share, ...dir] = parts.slice(1);
  for (const p of [share!, ...dir]) {
    if (UNSAFE.test(p) || p === '..' || p === '.') throw new SmbError(`Ungültiger Teil im Pfad: „${p}“`);
  }
  return { host, port, share: share!, dir: dir.join('/') };
}

export function formatSmbLocation(l: SmbLocation): string {
  return `\\\\${l.host}${l.port ? `:${l.port}` : ''}\\${l.share}${l.dir ? `\\${l.dir.split('/').join('\\')}` : ''}`;
}

/** Plain-language message for smbclient's NT_STATUS codes and connection errors. */
export function smbMessage(output: string, loc: SmbLocation): string {
  const s = output;
  if (/NT_STATUS_LOGON_FAILURE|NT_STATUS_WRONG_PASSWORD|NT_STATUS_NO_SUCH_USER/.test(s)) return 'Anmeldung abgelehnt – Benutzername oder Passwort stimmt nicht';
  if (/NT_STATUS_ACCOUNT_(DISABLED|LOCKED_OUT)|NT_STATUS_PASSWORD_EXPIRED/.test(s)) return 'Das Konto ist gesperrt, deaktiviert oder sein Passwort abgelaufen';
  if (/NT_STATUS_BAD_NETWORK_NAME/.test(s)) return `Die Freigabe „${loc.share}“ gibt es auf ${loc.host} nicht`;
  if (/NT_STATUS_ACCESS_DENIED/.test(s)) return 'Zugriff verweigert – das Konto darf in diesem Ordner nicht schreiben';
  if (/NT_STATUS_OBJECT_PATH_NOT_FOUND|NT_STATUS_OBJECT_NAME_NOT_FOUND/.test(s)) return `Ordner „${loc.dir || '/'}“ nicht gefunden oder nicht anlegbar`;
  if (/NT_STATUS_DISK_FULL/.test(s)) return 'Auf der Freigabe ist kein Platz mehr';
  if (/NT_STATUS_HOST_UNREACHABLE|NT_STATUS_NETWORK_UNREACHABLE|NT_STATUS_CONNECTION_REFUSED|NT_STATUS_IO_TIMEOUT|NT_STATUS_UNSUCCESSFUL|Connection to .* failed|NT_STATUS_RESOURCE_NAME_NOT_FOUND/.test(s))
    return `Server „${loc.host}${loc.port ? `:${loc.port}` : ''}“ nicht erreichbar`;
  if (/NT_STATUS_NOT_SUPPORTED|protocol negotiation failed/i.test(s)) return 'Der Server spricht kein passendes SMB (mindestens SMB2 nötig)';
  const code = /NT_STATUS_[A-Z_]+/.exec(s)?.[0];
  return code ? `SMB-Fehler ${code}` : `SMB-Fehler: ${s.trim().split('\n').pop()?.slice(0, 200) || 'unbekannt'}`;
}

const q = (p: string) => {
  if (UNSAFE.test(p)) throw new SmbError(`Ungültiger Dateiname „${p}“`);
  return `"${p}"`;
};

export class SmbClient {
  constructor(
    private readonly loc: SmbLocation,
    private readonly auth: SmbAuth,
    private readonly bin = process.env.SMBCLIENT || 'smbclient',
  ) {}

  /** Path inside the share for a path relative to the target folder. */
  private full(rel: string): string {
    return [this.loc.dir, rel].filter(Boolean).join('/');
  }

  /**
   * Runs smbclient commands. `stdin`/`stdout` stream a file; the result is the text output.
   * Fails on a non-zero exit or an NT_STATUS error in the output (unless `tolerate` matches).
   */
  private run(commands: string, io: { stdin?: string; stdout?: string; tolerate?: RegExp; timeoutMs?: number } = {}): Promise<string> {
    const args = [`//${this.loc.host}/${this.loc.share}`, '-U', this.auth.username || 'guest'];
    if (this.auth.domain) args.push('-W', this.auth.domain);
    if (this.loc.port) args.push('-p', String(this.loc.port));
    args.push('-c', commands);
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PASSWD: this.auth.password, LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let text = '';
      let done = false;
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(e);
      };
      const timer = setTimeout(() => fail(new SmbError(`Zeitüberschreitung bei ${this.loc.host}`)), io.timeoutMs ?? 60_000);
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(new SmbError(e.code === 'ENOENT' ? 'Das Programm smbclient fehlt (im Kaveyl-Wiki-Image enthalten; außerhalb davon installieren)' : e.message));
      });
      child.stderr.on('data', (d) => (text += String(d)));
      const out = io.stdout ? pipeline(child.stdout, createWriteStream(io.stdout, { mode: 0o600 })) : Promise.resolve(child.stdout.on('data', (d) => (text += String(d))));
      if (io.stdin) pipeline(createReadStream(io.stdin), child.stdin).catch((e) => fail(e as Error));
      else child.stdin.end();
      child.on('close', (code) => {
        clearTimeout(timer);
        void out
          .catch(() => undefined)
          .then(() => {
            if (done) return;
            done = true;
            const status = text.split('\n').filter((l) => /NT_STATUS_|failed/.test(l));
            const errors = status.filter((l) => !(io.tolerate && io.tolerate.test(l)));
            // smbclient exits with 1 also for a tolerated status (`del` of a file that is already gone) – that is no error.
            if (errors.length || (code !== 0 && !status.length)) reject(new SmbError(smbMessage(errors.join('\n') || text, this.loc)));
            else resolve(text);
          });
      });
    });
  }

  /** Creates the folders on the way to `relDir` (existing ones are fine). */
  async ensureDir(relDir: string): Promise<void> {
    const parts = this.full(relDir).split('/').filter(Boolean);
    if (!parts.length) return;
    const cmds = parts.map((_, i) => `mkdir ${q(parts.slice(0, i + 1).join('/'))}`).join('; ');
    await this.run(cmds, { tolerate: /NT_STATUS_OBJECT_NAME_COLLISION/ });
  }

  /** Under a temporary name first, then renamed: a cut-off upload never looks like a finished archive (Durchsuchen). */
  async put(localFile: string, rel: string): Promise<void> {
    const part = `${this.full(rel)}.part`;
    await this.run(`del ${q(part)}`, { tolerate: /NT_STATUS_NO_SUCH_FILE|NT_STATUS_OBJECT_NAME_NOT_FOUND/ });
    await this.run(`put - ${q(part)}`, { stdin: localFile, timeoutMs: 6 * 3600_000 });
    await this.run(`rename ${q(part)} ${q(this.full(rel))}`);
  }

  async get(rel: string, localFile: string): Promise<void> {
    await this.run(`get ${q(this.full(rel))} -`, { stdout: localFile, timeoutMs: 6 * 3600_000 });
  }

  async remove(rel: string): Promise<void> {
    await this.run(`del ${q(this.full(rel))}`, { tolerate: /NT_STATUS_NO_SUCH_FILE|NT_STATUS_OBJECT_NAME_NOT_FOUND/ });
  }

  /**
   * Entries of a folder (relative to the target folder; `mask` like „*.zip“). A missing or empty folder is an empty
   * list. Parsed from smbclient's `ls` lines: „  name   A   1234  Thu Oct 29 02:00:01 2026“.
   */
  async ls(relDir: string, mask = '*'): Promise<{ name: string; dir: boolean; size: number }[]> {
    const dir = this.full(relDir);
    // A listed name with „failed“ in it is no error – only lines that are no entry count.
    const out = await this.run(`ls ${q(dir ? `${dir}/${mask}` : mask)}`, { tolerate: /NT_STATUS_NO_SUCH_FILE|NT_STATUS_OBJECT_NAME_NOT_FOUND|NT_STATUS_OBJECT_PATH_NOT_FOUND|^ {2}.+\s[A-Z]+\s+\d+\s+\w{3} \w{3} / });
    return parseSmbList(out);
  }

  /** Free bytes on the share (from the "blocks available" line), null if not reported. */
  async free(): Promise<number | null> {
    const out = await this.run('du');
    const m = /(\d+) blocks of size (\d+)\. (\d+) blocks available/.exec(out);
    return m ? Number(m[3]) * Number(m[2]) : null;
  }
}

/** smbclient `ls` output → entries (without „.“ and „..“). */
export function parseSmbList(out: string): { name: string; dir: boolean; size: number }[] {
  const entries: { name: string; dir: boolean; size: number }[] = [];
  for (const line of out.split('\n')) {
    // Attributes as smbclient prints them (D, A, N, H, R, S – some servers also lower case letters).
    const m = /^ {2}(.+?)\s+([A-Za-z]+)\s+(\d+)\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\s*$/.exec(line);
    if (!m || m[1] === '.' || m[1] === '..') continue;
    entries.push({ name: m[1]!, dir: m[2]!.toUpperCase().includes('D'), size: Number(m[3]) });
  }
  return entries;
}
