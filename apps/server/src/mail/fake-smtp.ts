// Test helper (unit tests and E2E): a tiny SMTP server on 127.0.0.1 that keeps every mail in
// memory, so the real Mailer/nodemailer path is exercised without a real mail provider. Not used by the app.

import { createServer, type Server, type Socket } from 'node:net';

export interface CapturedMail {
  from: string;
  to: string[];
  /** Raw message (headers + body, transfer-encoded as sent). */
  raw: string;
  subject: string;
  /** Decoded plain-text part (quoted-printable / base64 undone, soft breaks joined). */
  text: string;
}

function decodeQP(s: string): string {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(src[i]!, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeHeader(v: string): string {
  // Whitespace between two encoded words is not part of the text (RFC 2047).
  return v
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([QB])\?([^?]*)\?=/gi, (_, enc: string, data: string) => (enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : decodeQP(data.replace(/_/g, ' '))));
}

/** The text/plain part of a (possibly multipart) message. */
export function plainText(raw: string): string {
  const parts = raw.split(/\r?\n--[^\r\n]+\r?\n/);
  const part = parts.find((p) => /content-type:\s*text\/plain/i.test(p.split(/\r?\n\r?\n/)[0] ?? '')) ?? raw;
  const [head = '', ...rest] = part.split(/\r?\n\r?\n/);
  const body = rest.join('\n\n').replace(/\r?\n--[^\r\n]*--\s*$/, '');
  if (/content-transfer-encoding:\s*base64/i.test(head)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) return decodeQP(body);
  return body;
}

export class FakeSmtp {
  readonly mails: CapturedMail[] = [];
  private server: Server | null = null;
  port = 0;

  async start(port = 0): Promise<number> {
    this.server = createServer((socket) => this.session(socket));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Newest mail to `to` (case-insensitive), waiting a little because sending is asynchronous. */
  async waitFor(to: string, predicate: (m: CapturedMail) => boolean = () => true, timeoutMs = 5000): Promise<CapturedMail> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = [...this.mails].reverse().find((m) => m.to.some((t) => t.toLowerCase() === to.toLowerCase()) && predicate(m));
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`Keine Mail an ${to} (bisher: ${this.mails.map((m) => `${m.to.join(',')}: ${m.subject}`).join(' | ') || 'keine'})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** First link in a mail's text that contains `marker` (e.g. '#reset='). */
  static link(mail: CapturedMail, marker: string): string {
    const m = mail.text.match(new RegExp(`https?://\\S*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\S*`));
    if (!m) throw new Error(`Kein Link mit ${marker} in: ${mail.text}`);
    return m[0];
  }

  private session(socket: Socket) {
    let buf = '';
    let data: string[] | null = null;
    let from = '';
    let to: string[] = [];
    const say = (line: string) => socket.write(line + '\r\n');
    say('220 fake-smtp ready');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            const raw = data.join('\r\n');
            const subject = decodeHeader(/^subject:\s*(.*(?:\r\n[ \t].*)*)/im.exec(raw)?.[1]?.replace(/\r\n[ \t]/g, ' ') ?? '');
            this.mails.push({ from, to, raw, subject, text: plainText(raw) });
            data = null;
            say('250 OK queued');
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') {
          socket.write('250-fake-smtp\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        } else if (cmd === 'AUTH') say('235 Authentication successful');
        else if (cmd === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          say('250 OK');
        } else if (cmd === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          say('250 OK');
        } else if (cmd === 'DATA') {
          data = [];
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'QUIT') {
          say('221 Bye');
          socket.end();
        } else if (cmd === 'RSET' || cmd === 'NOOP') say('250 OK');
        else say('502 Command not implemented');
      }
    });
    socket.on('error', () => undefined);
  }
}
