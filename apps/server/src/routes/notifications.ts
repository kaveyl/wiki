// Notification settings and tests (AD-035, admins). Moved out of buildApp (code-002); sending is in notify/.
import type { FastifyInstance } from 'fastify';
import { validEmail } from '../auth/auth.js';
import { type Channel } from '../notify/notifier.js';
import { PathError } from '../mounts/model.js';
import type { AppContext } from './context.js';

export function registerNotificationRoutes(server: FastifyInstance, ctx: AppContext) {
  const { audit, auth, follows, notifier, requireAdmin } = ctx;
  // ── Benachrichtigungen (AD-035) ──────────────────────────────────────────────────────
  const notifyOverview = () => ({
    rules: notifier.rules(),
    pushover: notifier.pushover(),
    channels: notifier.channels(),
    recipients: auth.listUsers().filter((u) => u.isAdmin && !u.disabled && validEmail(u.email)).map((u) => u.email),
    // Beobachten (AD-068): at most this many messages per person and day.
    followPerDay: follows.perDay(),
  });

  server.get('/api/admin/notify', async (req) => {
    requireAdmin(req);
    return notifyOverview();
  });

  server.put<{ Body: { rules?: unknown; pushover?: { token?: string; userKey?: string; device?: string }; followPerDay?: number } }>('/api/admin/notify', async (req) => {
    requireAdmin(req);
    const b = req.body ?? {};
    const changed: string[] = [];
    if (b.pushover) {
      const p = b.pushover;
      notifier.savePushover({ token: p.token, userKey: p.userKey, device: p.device });
      if (p.token !== undefined) changed.push(p.token ? 'Pushover-Token geändert' : 'Pushover-Token entfernt');
      if (p.userKey !== undefined) changed.push(p.userKey ? 'Pushover-User-Key geändert' : 'Pushover-User-Key entfernt');
      if (p.device !== undefined) changed.push(`Pushover-Gerät: ${p.device.trim() || 'alle'}`);
    }
    if (b.rules !== undefined) {
      const r = notifier.saveRules(b.rules);
      const on = (Object.entries(r) as [string, Record<Channel, boolean>][])
        .map(([e, c]) => `${e}: ${[c.mail && 'E-Mail', c.pushover && 'Pushover'].filter(Boolean).join('+') || 'aus'}`)
        .join(', ');
      changed.push(`Ereignisse ${on}`);
    }
    if (b.followPerDay !== undefined) {
      const n = Number(b.followPerDay);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new PathError('Höchstens je Person und Tag: 1 bis 1000');
      follows.setPerDay(n);
      changed.push(`Beobachten: höchstens ${n} Nachrichten je Person und Tag`);
    }
    if (changed.length) audit(req, 'notify-settings', `Benachrichtigungen geändert: ${changed.join('; ')}`);
    return notifyOverview();
  });

  server.post<{ Body: { channel?: string } }>('/api/admin/notify/test', async (req, reply) => {
    requireAdmin(req);
    const channel: Channel = req.body?.channel === 'pushover' ? 'pushover' : 'mail';
    if (channel === 'mail' && !validEmail(req.user!.email)) return reply.code(400).send({ error: 'Dein Konto hat noch keine echte E-Mail-Adresse (Einstellungen → Konto)' });
    try {
      await notifier.test(channel, channel === 'mail' ? { email: req.user!.email, displayName: req.user!.displayName } : undefined);
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
    audit(req, 'notify-test', `Testnachricht per ${channel === 'mail' ? 'E-Mail' : 'Pushover'} verschickt`);
    return { ok: true };
  });
}
