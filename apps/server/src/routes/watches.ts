// „Beobachten“ (AD-066): what the signed-in person follows, what is new for them, their own Pushover key.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FailureLimit, validEmail } from '../auth/auth.js';
import { cleanRelPath, PathError } from '../mounts/model.js';
import { NotifyError } from '../notify/notifier.js';
import { isDailyAt, RHYTHMS, type Rhythm } from '../follows.js';
import type { AppContext } from './context.js';

export function registerWatchRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, follows, mailer, notifier } = ctx;

  const channels = (req: FastifyRequest) => ({
    mail: mailer.configured() && validEmail(req.user!.email),
    pushover: notifier.personalPushover(req.user!.id),
  });

  // How often messages come (AD-068): the person's rhythm and the admin's daily limit.
  const timing = (userId: string) => ({ rhythm: follows.rhythm(userId), dailyAt: follows.dailyAt(userId), perDay: follows.perDay() });

  server.get('/api/watches', async (req) => ({ watches: follows.list(req.user!.id), unread: follows.unread(req.user!.id), channels: channels(req), ...timing(req.user!.id) }));

  server.put<{ Body: { mountId?: string; path?: string; isDir?: boolean; badge?: boolean; mail?: boolean; pushover?: boolean } }>('/api/watches', async (req) => {
    const b = req.body ?? {};
    const path = b.path ? cleanRelPath(String(b.path)) : '';
    const isDir = !path || !!b.isDir;
    // Only what one may read can be followed (404 otherwise, nothing revealed).
    const mount = access(req, String(b.mountId ?? ''), path, 'read', isDir);
    const ch = channels(req);
    if (b.mail && !ch.mail) throw new PathError('E-Mail-Versand ist nicht eingerichtet oder dein Konto hat keine E-Mail-Adresse');
    if (b.pushover && !(ch.pushover.available && ch.pushover.userKeySet)) throw new PathError('Für Pushover zuerst unter Mein Konto deinen Pushover-User-Key eintragen');
    follows.set(req.user!.id, { mountId: mount.id, path, isDir, badge: !!b.badge, mail: !!b.mail, pushover: !!b.pushover });
    return { watches: follows.list(req.user!.id), unread: follows.unread(req.user!.id), channels: ch, ...timing(req.user!.id) };
  });

  server.put<{ Body: { rhythm?: string; dailyAt?: string } }>('/api/account/watch-rhythm', async (req) => {
    const { rhythm, dailyAt } = req.body ?? {};
    if (rhythm !== undefined && !RHYTHMS.includes(rhythm as Rhythm)) throw new PathError('Unbekannter Rhythmus');
    if (dailyAt !== undefined && !isDailyAt(dailyAt)) throw new PathError('Uhrzeit bitte als HH:MM, z. B. 07:00');
    if (rhythm !== undefined) follows.setRhythm(req.user!.id, rhythm as Rhythm);
    if (dailyAt !== undefined) follows.setDailyAt(req.user!.id, dailyAt);
    return timing(req.user!.id);
  });

  server.post<{ Body: { mountId?: string; path?: string } }>('/api/watches/read', async (req) => {
    follows.markRead(req.user!.id, String(req.body?.mountId ?? ''), req.body?.path ? cleanRelPath(String(req.body.path)) : '');
    return { ok: true };
  });

  server.get('/api/account/pushover', async (req) => notifier.personalPushover(req.user!.id));

  server.put<{ Body: { userKey?: string } }>('/api/account/pushover', async (req) => {
    try {
      return notifier.savePersonalPushover(req.user!.id, String(req.body?.userKey ?? ''));
    } catch (e) {
      if (e instanceof NotifyError) throw new PathError(e.message);
      throw e;
    }
  });

  // Each test uses one message of the instance's Pushover quota (the admin's application token): a few per hour and
  // account (sec-002). Guests the same – they may use Pushover for what was shared, and are invited one by one.
  const pushoverTests = new FailureLimit(3, 60 * 60_000);

  server.post('/api/account/pushover/test', async (req, reply) => {
    if (!pushoverTests.hit(req.user!.id)) return reply.code(429).send({ error: 'Zu viele Testnachrichten – höchstens 3 pro Stunde, bitte später noch einmal' });
    try {
      await notifier.pushoverToPerson(req.user!.id, 'Kaveyl Wiki: Test', 'Pushover für „Beobachten“ funktioniert.');
      return { ok: true };
    } catch (e) {
      if (e instanceof NotifyError) throw new PathError(e.message);
      throw e;
    }
  });
}
