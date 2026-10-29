// „Teilen → Per Mail versenden …“ (owner 28.10.): one or more notes as .md attachments to any address – for people
// without an account, so no links. Whoever may read a note may send it (they could download it anyway); guests not,
// encrypted notes never (the server does not know their content). One mail per recipient, a limit against mass mail.
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { AuthError, normEmail, validEmail } from '../auth/auth.js';
import { MailError } from '../mail/mailer.js';
import { userLang, requestLang } from '../i18n/index.js';
import { absPath, cleanRelPath, PathError } from '../mounts/model.js';
import { exportMarkdown } from '../notes/export.js';
import { isEncryptedNote } from '../notes/encryption.js';
import { ForbiddenError } from '../notes/service.js';
import type { AppContext } from './context.js';

const HOUR = 60 * 60_000;
const MAX_TO = 10;
const MAX_NOTES = 50;
const MAX_BYTES = 10 * 1024 * 1024;
const PER_USER = 30;
const PER_INSTANCE = 200;

export function registerMailNoteRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, audit, canRead, config, db, mailer, mountRef } = ctx;
  /**
   * Recipients per person and hour (each address counts), and for the whole instance (audit 28.10. sec-003). A request
   * that does not fit counts nothing (code-005). In memory: a restart starts over.
   */
  const sentAt = new Map<string, number[]>();
  const fits = (key: string, n: number, max: number) => {
    const t = Date.now();
    const list = (sentAt.get(key) ?? []).filter((x) => t - x < HOUR);
    sentAt.set(key, list);
    return list.length + n <= max;
  };
  const count = (key: string, n: number) => sentAt.get(key)!.push(...Array<number>(n).fill(Date.now()));
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  server.post<{ Body: { mountId?: string; paths?: unknown; to?: unknown } }>('/api/mail-notes', async (req) => {
    const user = req.user!;
    if (user.isGuest) throw new ForbiddenError('Gäste können keine Notizen per Mail versenden');
    if (!mailer.configured()) throw new AuthError(user.isAdmin ? 'E-Mail-Versand ist nicht eingerichtet (Einstellungen → Benachrichtigungen → E-Mail)' : 'E-Mail-Versand ist nicht eingerichtet – bitte den Administrator fragen');
    const to = [...new Set((Array.isArray(req.body?.to) ? req.body.to : []).map((a) => normEmail(String(a))))];
    if (!to.length) throw new AuthError('Bitte mindestens eine E-Mail-Adresse angeben');
    if (to.length > MAX_TO) throw new AuthError(`Höchstens ${MAX_TO} Empfänger auf einmal`);
    const bad = to.find((a) => !validEmail(a));
    if (bad) throw new AuthError(`Keine gültige E-Mail-Adresse: ${bad}`);
    const paths = [...new Set((Array.isArray(req.body?.paths) ? req.body.paths : []).map((p) => cleanRelPath(String(p))).filter(Boolean))];
    if (!paths.length) throw new PathError('Keine Notiz gewählt');
    if (paths.length > MAX_NOTES) throw new PathError(`Höchstens ${MAX_NOTES} Notizen auf einmal`);

    const mountId = String(req.body?.mountId ?? '');
    const files: { filename: string; content: Buffer; contentType: string }[] = [];
    const titles: string[] = [];
    const taken = new Set<string>();
    let bytes = 0;
    for (const path of paths) {
      if (!/\.md$/i.test(path)) throw new PathError('Nur Notizen lassen sich per Mail versenden, keine Ordner');
      const mount = access(req, mountId, path, 'read', false);
      const raw = await readFile(absPath(mount, config.dataPath, path), 'utf8').catch(() => null);
      if (raw === null) throw new PathError(`Notiz nicht gefunden: ${path}`);
      if (isEncryptedNote(raw)) throw new ForbiddenError('Verschlüsselte Notizen lassen sich nicht per Mail versenden');
      // The same file as „Herunterladen“: the .md, with pictures or files a ZIP.
      const out = await exportMarkdown(mount, path, [], {
        dataPath: config.dataPath,
        canRead: (p) => canRead(req, mount.id, p),
        readNote: async (m, p) => readFile(absPath(m, config.dataPath, p), 'utf8').catch(() => null),
      });
      const ext = out.only ? 'md' : 'zip';
      let filename = `${out.name}.${ext}`;
      for (let i = 2; taken.has(filename.toLowerCase()); i++) filename = `${out.name} ${i}.${ext}`;
      taken.add(filename.toLowerCase());
      const content = Buffer.from(out.only ?? out.zip);
      bytes += content.length;
      if (bytes > MAX_BYTES) throw new PathError('Zu groß für eine Mail (höchstens 10 MB) – bitte weniger Notizen wählen');
      files.push({ filename, content, contentType: out.only ? 'text/markdown; charset=utf-8' : 'application/zip' });
      titles.push(out.name);
    }
    if (!fits(user.id, to.length, PER_USER) || !fits('*', to.length, PER_INSTANCE)) throw new AuthError('Zu viele Mails in kurzer Zeit – bitte später noch einmal');
    count(user.id, to.length);
    count('*', to.length);

    // Names a person chose: short in subject and text (audit 28.10. sec-003).
    const sender = short(user.displayName || user.username, 60);
    const one = titles.length === 1;
    const list = titles.map((n) => `„${short(n, 80)}“`).join(', ');
    const subject = one ? `${sender} hat dir „${short(titles[0]!, 80)}“ aus Kaveyl Wiki geschickt` : `${sender} hat dir ${titles.length} Notizen aus Kaveyl Wiki geschickt`;
    // Whole sentences per paragraph, so that each one translates (mailer: line by line).
    const text = [
      'Hallo,',
      one ? `${sender} hat dir die Notiz „${short(titles[0]!, 80)}“ aus Kaveyl Wiki geschickt.` : `${sender} hat dir ${titles.length} Notizen aus Kaveyl Wiki geschickt: ${list}.`,
      one
        ? 'Sie hängt als Markdown-Datei (.md) an, mit Bildern oder Dateien als ZIP. Markdown lässt sich mit jedem Texteditor öffnen.'
        : 'Sie hängen als Markdown-Dateien (.md) an, mit Bildern oder Dateien als ZIP. Markdown lässt sich mit jedem Texteditor öffnen.',
      ...(validEmail(user.email) ? [`Antworten auf diese Mail gehen an ${sender}.`] : []),
    ].join('\n\n');
    const lang = userLang(db, user.id) ?? requestLang(req);
    const mount = access(req, mountId, paths[0]!, 'read', false);
    const sent: string[] = [];
    try {
      for (const address of to) {
        await mailer.send({
          to: address,
          lang: mailer.langOf(address) ?? lang,
          subject,
          text,
          attachments: files,
          ...(validEmail(user.email) ? { replyTo: { name: sender.replace(/[\r\n"<>]/g, ''), address: user.email } } : {}),
        });
        sent.push(address);
      }
    } catch (e) {
      // The SMTP server's answer can name its login or hosts: in full only for admins and in the log (sec-005).
      audit(req, 'note-mail-failed', `Versand abgebrochen nach ${sent.length} von ${to.length}: ${e instanceof Error ? e.message : String(e)}`, { mount: mountRef(mount) });
      if (!user.isAdmin && e instanceof MailError) throw new MailError('Versand fehlgeschlagen – bitte den Administrator fragen');
      throw e;
    } finally {
      // Whatever went out is in the log, also when sending broke off halfway (audit 28.10. sec-002).
      if (sent.length) audit(req, 'note-mailed', `Per Mail verschickt an ${sent.join(', ')}: ${mount.name} / ${paths.join(', ')}`, { mount: mountRef(mount) });
    }
    return { sent: sent.length, notes: titles.length };
  });
}
