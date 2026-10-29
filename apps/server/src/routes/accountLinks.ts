// „Passwort vergessen“ and invitation links (public; the token in the link is the authorization), and
// sharing a note by e-mail. Moved out of buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../auth/auth.js';
import { cleanRelPath } from '../mounts/model.js';
import { ForbiddenError } from '../notes/service.js';
import type { AppContext } from './context.js';
import { requestLang } from '../i18n/index.js';

export function registerAccountLinkRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, accountMail, audit, auth, mailer, mountRef, newAdmin, setSessionCookie } = ctx;
  // ── Passwort vergessen and invitation links (public; the token is the authorization) ──
  server.post<{ Body: { email: string } }>('/api/password/forgot', async (req) => {
    await accountMail.requestReset(String(req.body?.email ?? ''), req.ip);
    // Same answer whether the address exists or not.
    return { ok: true, mail: mailer.configured() };
  });

  server.post<{ Body: { token: string } }>('/api/invite/info', async (req) => {
    const info = accountMail.info(String(req.body?.token ?? ''));
    if (!info) throw new AuthError('Der Link ist ungültig oder abgelaufen');
    return info;
  });

  server.post<{ Body: { token: string; password: string } }>('/api/password/reset', async (req, reply) => {
    const user = await accountMail.resetPassword(String(req.body?.token ?? ''), String(req.body?.password ?? ''), req.ip);
    const { token } = auth.createSession(user.id, false);
    setSessionCookie(reply, token);
    return { user };
  });

  server.post<{ Body: { token: string; password: string; displayName?: string } }>('/api/invite/accept', async (req, reply) => {
    const { user, note, folder } = await accountMail.accept(String(req.body?.token ?? ''), { password: String(req.body?.password ?? ''), displayName: req.body?.displayName }, req.ip);
    if (user.isAdmin) newAdmin(user.username, 'Einladung angenommen');
    const { token } = auth.createSession(user.id, false);
    setSessionCookie(reply, token);
    return { user: auth.getUser(user.id), note, folder };
  });

  /** Share a note, a folder or a whole source by e-mail (read, or read and write; new people get a guest account) — needs `admin` there. */
  server.post<{ Body: { mountId: string; target?: string; path?: string; level?: string; email: string; displayName?: string; more?: unknown } }>('/api/share', async (req) => {
    if (req.user!.isGuest) throw new ForbiddenError('Gäste können niemanden einladen');
    const target = req.body?.target ?? 'note';
    if (target !== 'note' && target !== 'folder' && target !== 'mount') throw new AuthError('Unbekanntes Ziel');
    const path = target === 'mount' ? '' : cleanRelPath(String(req.body?.path ?? ''));
    const level = req.body?.level === 'write' ? 'write' : req.body?.level === undefined || req.body.level === 'read' ? 'read' : null;
    if (!level) throw new AuthError('Unbekannte Stufe');
    const mount = access(req, String(req.body?.mountId ?? ''), path, 'admin', target !== 'note');
    // Several marked in the tree (owner 28.10.): notes and folders of the same source, `admin` on each.
    const more = (Array.isArray(req.body?.more) ? req.body.more : []).slice(0, 200).map((m: { target?: unknown; path?: unknown }) => {
      const t = m?.target === 'folder' ? 'folder' : 'note';
      const p = cleanRelPath(String(m?.path ?? ''));
      if (!p || target === 'mount') throw new AuthError('Unbekanntes Ziel');
      access(req, mount.id, p, 'admin', t === 'folder');
      return { target: t as 'note' | 'folder', path: p };
    });
    const result = await accountMail.share({ email: String(req.body?.email ?? ''), mountId: mount.id, target, path, level, displayName: req.body?.displayName, more }, req.user!, requestLang(req));
    const what = more.length ? `${more.length + 1} Einträge` : { note: 'Notiz', folder: 'Ordner', mount: 'Quelle' }[target];
    const where = [path, ...more.map((m) => m.path)].filter(Boolean).join(', ');
    audit(
      req,
      'share',
      `${what} geteilt per E-Mail (${level === 'write' ? 'lesen & schreiben' : 'lesen'}): ${mount.name}${where ? '/' + where : ''}${result.existing ? ' (bestehendes Konto)' : ' (Einladung, Gast)'}`,
      { mount: mountRef(mount) },
    );
    return result;
  });
}
