// Health check, session, first setup, sign-in with its brakes (per address and per e-mail), sign-out and changing
// the own password. Moved out of buildApp (code-002); the request auth hook stays in app.ts.
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { RESTORE_DIR, RESTORE_LIMIT, RestoreError, stageDbRestore } from '../backups/dbRestore.js';
import { FailureLimit } from '../auth/auth.js';
import { PROXY_PROVIDERS, proxyIdentity } from '../auth/proxyAuth.js';
import { removeSetupCode, setupCodeMatches } from '../auth/setupCode.js';
import { COOKIE, sessionCookie } from '../auth/session.js';
import type { AppContext } from './context.js';

export function registerSessionRoutes(server: FastifyInstance, ctx: AppContext) {
  const { accountMail, audit, auth, config, gitVersion, mailer, proxy, record, restart, setSessionCookie, settings, setup, setupFailures } = ctx;
  // ── Health & session ──────────────────────────────────────────────────────────────
  // Versions only for the signed in and from inside the container (healthcheck, deploy.sh) – the socket peer, not
  // X-Forwarded-For; everyone else learns only that it is up (sec-008).
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  server.get('/health', async (req) =>
    req.user || LOOPBACK.has(req.socket.remoteAddress ?? '') ? { status: 'ok', version: config.version, git: gitVersion } : { status: 'ok' },
  );

  server.get('/api/session', async (req) => {
    const setupRequired = !auth.hasUsers();
    // Version only for the signed in, like /health (sec-016).
    return {
      user: req.user,
      setupRequired,
      setupCode: setupRequired && !!setup.code,
      ...(setupRequired && setup.restoring && { restoring: true }),
      ...(req.user && { version: config.version }),
      mail: mailer.configured(),
    };
  });

  server.post<{ Body: { email: string; password: string; displayName?: string; code?: string } }>('/api/setup', async (req, reply) => {
    if (auth.hasUsers()) return reply.code(409).send({ error: 'Setup bereits abgeschlossen' });
    if (setup.restoring) return reply.code(409).send({ error: 'Eine Datenbank aus der Sicherung wird übernommen – Kaveyl Wiki startet neu' });
    if (setup.code) {
      if (setupFailures.blocked('setup')) return reply.code(429).send({ error: 'Zu viele Versuche – bitte eine Minute warten' });
      if (!setupCodeMatches(setup.code, req.body?.code)) {
        setupFailures.fail('setup');
        record({ category: 'audit', level: 'warn', action: 'setup-code-wrong', actor: null, message: 'Ersteinrichtung: falscher Einrichtungscode', detail: { ip: req.ip } });
        return reply.code(403).send({ error: 'Einrichtungscode falsch – er steht im Log des Containers (docker logs)' });
      }
    }
    const user = await auth.createUser({ email: String(req.body?.email ?? ''), displayName: req.body?.displayName, password: String(req.body?.password ?? ''), isAdmin: true });
    record({ category: 'audit', action: 'setup', actor: user.username, message: `Ersteinrichtung: Administrator „${user.username}“ angelegt`, detail: { ip: req.ip } });
    if (setup.code) {
      removeSetupCode(config.configPath);
      setup.code = null;
    }
    const { token, expires } = auth.createSession(user.id);
    setSessionCookie(reply, token, expires);
    return { user };
  });

  // Database back from a backup instead of a new administrator (AD-075): only before the first account, with the setup
  // code. The file comes as a stream (counted against the limit while written); code and backup password as headers
  // (URI-encoded), the body is the file. Checked, staged, then the process ends and Docker starts it again.
  server.addContentTypeParser('application/x-sqlite3', (_req, payload, done) => done(null, payload));
  let receiving = false;
  server.post('/api/setup/restore', async (req, reply) => {
    if (auth.hasUsers()) return reply.code(409).send({ error: 'Setup bereits abgeschlossen' });
    // Binary like the other uploads: the custom header forces a CORS preflight (CSRF, app.ts).
    if (req.headers['x-kaveyl-wiki-upload'] !== '1') return reply.code(415).send({ error: 'Upload-Kennung fehlt' });
    if (setup.restoring) return reply.code(409).send({ error: 'Eine Datenbank aus der Sicherung wird übernommen – Kaveyl Wiki startet neu' });
    const header = (name: string) => {
      const v = req.headers[name];
      try {
        return typeof v === 'string' && v ? decodeURIComponent(v) : null;
      } catch {
        return null;
      }
    };
    if (setup.code) {
      if (setupFailures.blocked('setup')) return reply.code(429).send({ error: 'Zu viele Versuche – bitte eine Minute warten' });
      if (!setupCodeMatches(setup.code, header('x-setup-code'))) {
        setupFailures.fail('setup');
        record({ category: 'audit', level: 'warn', action: 'setup-code-wrong', actor: null, message: 'Ersteinrichtung: falscher Einrichtungscode', detail: { ip: req.ip } });
        return reply.code(403).send({ error: 'Einrichtungscode falsch – er steht im Log des Containers (docker logs)' });
      }
    }
    if (!req.body || typeof (req.body as Readable).pipe !== 'function') return reply.code(400).send({ error: 'Erwartet: die ZIP-Datei einer Datenbank-Sicherung oder kaveyl-wiki.db' });
    if (Number(req.headers['content-length']) > RESTORE_LIMIT) return reply.code(413).send({ error: 'Die Datei ist zu groß' });
    if (receiving) return reply.code(409).send({ error: 'Es wird schon eine Sicherung hochgeladen' });
    receiving = true;
    const dir = join(config.configPath, RESTORE_DIR);
    const upload = join(dir, 'upload');
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          done(size > RESTORE_LIMIT ? new RestoreError('Die Datei ist zu groß') : null, chunk);
        },
      });
      await pipeline(req.body as Readable, limit, createWriteStream(upload, { mode: 0o600 }));
      const info = await stageDbRestore(upload, config.configPath, header('x-backup-password'));
      setup.restoring = true;
      record({
        category: 'audit',
        action: 'setup-restore',
        actor: null,
        message: `Ersteinrichtung: Datenbank-Sicherung hochgeladen und geprüft (${info.users} Konto/Konten, Datenbank v${info.version}) – Neustart`,
        detail: { ip: req.ip },
      });
      // Answer first, then end: the page waits for the server to come back.
      if (restart) setTimeout(restart, 500).unref();
      return { ...info, restart: !!restart };
    } catch (e) {
      await rm(upload, { force: true });
      throw e;
    } finally {
      receiving = false;
    }
  });

  // Guessing passwords: after 10 failures for an address or 30 from one IP within 15 minutes, a pause.
  const loginFailsPerEmail = new FailureLimit(10, 15 * 60_000);
  const loginFailsPerIp = new FailureLimit(30, 15 * 60_000);
  server.post<{ Body: { email?: string; username?: string; password: string; remember?: boolean } }>('/api/login', async (req, reply) => {
    // `username` is still accepted as the field name (older clients); its value must be the e-mail.
    const email = String(req.body?.email ?? req.body?.username ?? '');
    const key = email.trim().toLowerCase();
    if (loginFailsPerEmail.blocked(key) || loginFailsPerIp.blocked(req.ip)) {
      return reply.code(429).send({ error: 'Zu viele Fehlversuche – bitte in einigen Minuten noch einmal' });
    }
    const user = await auth.checkLogin(email, String(req.body?.password ?? ''));
    if (user === 'locked') {
      // The right password: no guessing, so no failure counted – but no session either.
      loginFailsPerEmail.clear(key);
      const known = auth.userByEmail(email);
      record({ category: 'audit', level: 'warn', action: 'login-locked', actor: known?.username ?? null, message: `Anmeldung abgelehnt – Konto „${known?.username ?? '?'}“ ist gesperrt`, detail: { ip: req.ip } });
      return reply.code(403).send({ error: 'Dieses Konto ist gesperrt – bitte wende dich an einen Administrator' });
    }
    if (!user) {
      loginFailsPerEmail.fail(key);
      loginFailsPerIp.fail(req.ip);
      if (loginFailsPerEmail.blocked(key) || loginFailsPerIp.blocked(req.ip)) {
        const known = auth.userByEmail(email);
        record({ category: 'audit', level: 'warn', action: 'login-throttled', actor: known?.username ?? null, message: `Anmeldung gebremst nach zu vielen Fehlversuchen${known ? ` für „${known.username}“` : ''}`, detail: { ip: req.ip } });
      }
      // Only an existing account is logged — the field might contain a mistyped password.
      const known = auth.userByEmail(email);
      record({ category: 'audit', level: 'warn', action: 'login-failed', actor: known?.username ?? null, message: known ? `Anmeldung fehlgeschlagen für „${known.username}“` : 'Anmeldung fehlgeschlagen (unbekannte E-Mail)', detail: { ip: req.ip } });
      return reply.code(401).send({ error: 'E-Mail oder Passwort falsch' });
    }
    loginFailsPerEmail.clear(key);
    record({ category: 'audit', action: 'login', actor: user.username, message: `Angemeldet: ${user.username}${user.mustChangePassword ? ' (muss Passwort ändern)' : ''}`, detail: { ip: req.ip } });
    const remember = req.body?.remember !== false;
    const { token, expires } = auth.createSession(user.id, remember);
    setSessionCookie(reply, token, remember ? expires : undefined);
    return { user };
  });

  server.post('/api/logout', async (req, reply) => {
    if (req.user) audit(req, 'logout', `Abgemeldet: ${req.user.username}`);
    auth.deleteSession(sessionCookie(req));
    reply.clearCookie(COOKIE, { path: '/' });
    // Came through an auth proxy (AD-049): sign out there too, or the next request signs in again. Only the address the
    // admin entered – never one from the request (no open redirect).
    for (const provider of PROXY_PROVIDERS) {
      const cfg = proxy.config(provider);
      if (cfg.logoutUrl && proxyIdentity(cfg, req.socket.remoteAddress, req.headers)) return { ok: true, redirect: cfg.logoutUrl };
    }
    // Behind Cloudflare Access (AD-058): its own sign-out on this very domain ends the Access session – otherwise the next
    // request would sign in again with the Access token Cloudflare adds to every request (review 21.10.).
    if (settings.get('cf_access_enabled') === '1' && typeof req.headers['cf-access-jwt-assertion'] === 'string') return { ok: true, redirect: '/cdn-cgi/access/logout' };
    return { ok: true };
  });

  server.post<{ Body: { current: string; next: string } }>('/api/account/password', async (req, reply) => {
    const ok = await auth.changePassword(req.user!.id, String(req.body?.current ?? ''), String(req.body?.next ?? ''), sessionCookie(req));
    if (!ok) {
      audit(req, 'password-change-failed', 'Passwortänderung abgelehnt (aktuelles Passwort falsch)', { level: 'warn' });
      return reply.code(403).send({ error: 'Aktuelles Passwort ist falsch' });
    }
    audit(req, 'password-changed', 'Passwort geändert, andere Sitzungen beendet');
    void accountMail.passwordChanged(req.user!);
    return { ok: true, user: auth.getUser(req.user!.id) };
  });
}
