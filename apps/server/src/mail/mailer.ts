// Outgoing mail over SMTP, configured by an admin in the settings (AD-030).
// The SMTP password lives in the SecretStore and never reaches the frontend. Links in mails are
// built only from the configured public address — never from the request's Host header.

import nodemailer from 'nodemailer';
import type { SecretStore } from '../secrets.js';
import { SOURCE_LANG, type Lang } from '@kaveyl-wiki/core';
import { fallbackLang, tr, translateLines, translateMessage } from '../i18n/index.js';
import { MAIL_LOGO_PNG } from './logo.js';

const SECRET_ID = 'smtp';

export type SmtpSecurity = 'starttls' | 'tls' | 'none';

export interface MailSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  fromAddress: string;
  fromName: string;
  /** Address of Kaveyl Wiki as seen by recipients, e.g. https://wiki.example.org — base of every link. */
  publicUrl: string;
  passwordSet: boolean;
}

export interface MailSettingsInput extends Partial<Omit<MailSettings, 'passwordSet'>> {
  /** New password/SMTP key; empty string removes it, undefined keeps it. */
  password?: string;
}

export interface Mail {
  to: string;
  subject: string;
  /** Plain-text body; the HTML part is generated from it (paragraphs, one button for `action`). */
  text: string;
  action?: { label: string; url: string };
  /** Language of the mail (AD-046); default: the recipient's account language, else German. */
  lang?: Lang;
  /** Files to attach (a note sent by mail, owner 28.10.). */
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  /** Where answers go (the person who sent a note), not to the instance's sender address. */
  replyTo?: { name: string; address: string };
}

interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class MailError extends Error {}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The app logo as a PNG inside the mail (`cid:`): mail clients block SVG and images loaded from elsewhere, but show
 * embedded ones. Generated from apps/web/src/logo.ts (scripts/make-icons.mjs).
 */
const LOGO_CID = 'logo@kaveyl-wiki';
const LOGO = `<img src="cid:${LOGO_CID}" width="26" height="26" alt="" style="display:inline-block;width:26px;height:26px;border:0;vertical-align:-6px;margin-right:8px">`;
const logoAttachment = () => ({ filename: 'kaveyl-wiki.png', content: Buffer.from(MAIL_LOGO_PNG, 'base64'), contentType: 'image/png', cid: LOGO_CID, contentDisposition: 'inline' as const });

/** Minimal branded HTML: logo row, paragraphs, an optional button, the link again as text. */
export function mailHtml(mail: Mail, lang: Lang = SOURCE_LANG): string {
  const paras = mail.text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = mail.action
    ? `<p style="margin:22px 0"><a href="${esc(mail.action.url)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${esc(mail.action.label)}</a></p>` +
      `<p style="margin:0 0 14px;font-size:12px;color:#6b6b66">${esc(tr(lang, 'Falls der Knopf nicht funktioniert: {url}', { url: mail.action.url }))}</p>`
    : '';
  return `<!doctype html><html lang="${lang}"><body style="margin:0;background:#f5f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2f2f2c">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<div style="font-size:20px;font-weight:700;margin-bottom:18px">${LOGO}Kaveyl Wiki</div>
<div style="background:#fff;border:1px solid #e6e6e3;border-radius:12px;padding:22px 22px 8px;font-size:15px;line-height:1.5">${paras}${button}</div>
<p style="font-size:12px;color:#72716e;margin-top:16px">${esc(tr(lang, 'Diese Nachricht wurde automatisch von Kaveyl Wiki verschickt.'))}</p>
</div></body></html>`;
}

export class Mailer {
  /** Language of a recipient by address (their account's choice); set by the app. */
  langOf: (email: string) => Lang | undefined = () => undefined;

  constructor(
    private readonly kv: KV,
    private readonly secrets: SecretStore,
    /** Tests: replace the transport (e.g. to point at a local fake SMTP server without TLS). */
    private readonly transportOptions: (s: MailSettings, password: string | null) => object = defaultTransport,
  ) {}

  settings(): MailSettings {
    const k = this.kv;
    return {
      host: k.get('smtp_host') ?? '',
      port: Number(k.get('smtp_port') ?? 587) || 587,
      security: (k.get('smtp_security') as SmtpSecurity) || 'starttls',
      user: k.get('smtp_user') ?? '',
      fromAddress: k.get('smtp_from') ?? '',
      fromName: k.get('smtp_from_name') ?? 'Kaveyl Wiki',
      publicUrl: k.get('public_url') ?? '',
      passwordSet: this.secrets.get(SECRET_ID) !== null,
    };
  }

  save(input: MailSettingsInput): MailSettings {
    const k = this.kv;
    if (input.host !== undefined) k.set('smtp_host', input.host.trim());
    if (input.port !== undefined) {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError('Port: 1–65535');
      k.set('smtp_port', String(port));
    }
    if (input.security !== undefined) {
      if (!['starttls', 'tls', 'none'].includes(input.security)) throw new MailError('Unbekannte Verschlüsselung');
      k.set('smtp_security', input.security);
    }
    if (input.user !== undefined) k.set('smtp_user', input.user.trim());
    if (input.fromAddress !== undefined) {
      const a = input.fromAddress.trim();
      if (a && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)) throw new MailError('Absender: bitte eine gültige E-Mail-Adresse');
      k.set('smtp_from', a);
    }
    if (input.fromName !== undefined) k.set('smtp_from_name', input.fromName.replace(/[\r\n"<>]/g, '').trim().slice(0, 80));
    if (input.publicUrl !== undefined) k.set('public_url', cleanPublicUrl(input.publicUrl));
    if (input.password !== undefined) {
      if (input.password) this.secrets.put(input.password, SECRET_ID);
      else this.secrets.delete(SECRET_ID);
    }
    return this.settings();
  }

  /** Ready to send: server, sender and the public address for links are set. */
  configured(): boolean {
    const s = this.settings();
    return !!(s.host && s.fromAddress && s.publicUrl);
  }

  /** Absolute link into the app, e.g. link('#reset=…'). */
  link(path: string): string {
    const base = this.settings().publicUrl;
    if (!base) throw new MailError('Öffentliche Adresse von Kaveyl Wiki fehlt (Einstellungen → Benachrichtigungen → E-Mail)');
    return `${base}/${path.replace(/^\//, '')}`;
  }

  async send(original: Mail): Promise<void> {
    // The texts are written in German; the recipient gets them in their language.
    const lang = original.lang ?? this.langOf(original.to) ?? fallbackLang();
    const mail: Mail = {
      ...original,
      subject: translateMessage(lang, original.subject),
      // A whole text as one message, else paragraph by paragraph (mails put together from known sentences).
      text: translateLines(lang, original.text),
      action: original.action && { ...original.action, label: translateMessage(lang, original.action.label) },
    };
    const s = this.settings();
    if (!s.host || !s.fromAddress) throw new MailError('E-Mail-Versand ist nicht eingerichtet');
    const transport = nodemailer.createTransport(this.transportOptions(s, this.secrets.get(SECRET_ID)));
    try {
      await transport.sendMail({
        from: { name: s.fromName || 'Kaveyl Wiki', address: s.fromAddress },
        to: mail.to,
        subject: mail.subject,
        text: mail.action ? `${mail.text}\n\n${mail.action.label}: ${mail.action.url}` : mail.text,
        html: mailHtml(mail, lang),
        attachments: [logoAttachment(), ...(mail.attachments ?? [])],
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      });
    } catch (e) {
      // SMTP replies can echo the login name, never the password; still keep it short.
      throw new MailError(`Versand fehlgeschlagen: ${e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : String(e)}`);
    } finally {
      transport.close();
    }
  }
}

function defaultTransport(s: MailSettings, password: string | null): object {
  return {
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

/** „wiki.example.org/“ → „https://wiki.example.org“; only http(s), no path tricks, no credentials. */
export function cleanPublicUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    throw new MailError('Öffentliche Adresse: bitte eine gültige URL, z. B. https://wiki.example.org');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new MailError('Öffentliche Adresse: nur http(s)://host[:port][/pfad]');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}
