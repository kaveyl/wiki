// Mail delivery settings and test mail (SMTP, AD-030; admins). Moved out of buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import { type MailSettingsInput } from '../mail/mailer.js';
import type { AppContext } from './context.js';

export function registerMailRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, mailer, requireAdmin } = ctx;
  // ── E-Mail-Versand (SMTP, AD-030) ────────────────────────────────────────────────────
  server.get('/api/admin/mail', async (req) => {
    requireAdmin(req);
    return { ...mailer.settings(), configured: mailer.configured() };
  });

  server.put<{ Body: MailSettingsInput }>('/api/admin/mail', async (req) => {
    requireAdmin(req);
    const s = mailer.save(req.body ?? {});
    audit(req, 'mail-settings', `E-Mail-Versand geändert: ${s.host || '(kein Server)'}:${s.port}, Absender ${s.fromAddress || '–'}${req.body?.password !== undefined ? ', Passwort geändert' : ''}`);
    return { ...s, configured: mailer.configured() };
  });

  server.post<{ Body: { to?: string } }>('/api/admin/mail/test', async (req) => {
    requireAdmin(req);
    const to = String(req.body?.to ?? '').trim() || req.user!.email;
    await mailer.send({
      to,
      subject: 'Kaveyl Wiki: Testmail',
      text: `Hallo ${req.user!.displayName},\n\ndiese Testmail zeigt: der E-Mail-Versand von Kaveyl Wiki funktioniert. Links in Mails zeigen auf ${mailer.settings().publicUrl || '(öffentliche Adresse fehlt noch)'}.`,
    });
    audit(req, 'mail-test', 'Testmail verschickt');
    return { ok: true, to };
  });
}
