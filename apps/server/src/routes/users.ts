// Accounts (admins, Phase 4): list, create or invite, change, delete (AD-051), reset the password. Personal API tokens
// are in tokens.ts. Moved out of buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../auth/auth.js';
import type { AppContext } from './context.js';
import { requestLang } from '../i18n/index.js';

export function registerUserRoutes(server: FastifyInstance, ctx: AppContext) {
  const { accountMail, acl, audit, auth, eventHooks, newAdmin, notifier, requireAdmin } = ctx;
  // ── Users (admins, Phase 4) ──────────────────────────────────────────────────────
  server.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const links = auth.proxyLinks();
    return auth.listUsers().map((u) => ({ ...u, proxyLinks: links.filter((l) => l.userId === u.id).map((l) => l.provider) }));
  });

  /** New account: by invitation mail (the person sets the password) or with a start password – to be changed at the first
   * login unless the admin unticks it (owner 28.10.: accounts for agents, or a password the person may keep). */
  server.post<{ Body: { email: string; username?: string; displayName?: string; password?: string; isAdmin?: boolean; isGuest?: boolean; invite?: boolean; mustChange?: boolean } }>('/api/admin/users', async (req) => {
    requireAdmin(req);
    const b = req.body ?? ({} as typeof req.body);
    const role = b.isAdmin ? ' (Admin)' : b.isGuest ? ' (Gast)' : '';
    if (b.invite) {
      await accountMail.inviteUser({ email: String(b.email ?? ''), displayName: b.displayName, isAdmin: !!b.isAdmin, isGuest: !!b.isGuest }, req.user!, requestLang(req));
      audit(req, 'user-invited', `Einladung verschickt${role}`);
      return { invited: true };
    }
    const user = await auth.createUser({ email: String(b.email ?? ''), username: b.username, displayName: b.displayName, password: String(b.password ?? ''), isAdmin: !!b.isAdmin, isGuest: !!b.isGuest, mustChange: b.mustChange !== false });
    audit(req, 'user-created', `Benutzer angelegt: ${user.username}${role}`);
    if (user.isAdmin) newAdmin(user.username, `angelegt von ${req.user!.username}`);
    return user;
  });

  server.patch<{ Params: { id: string }; Body: { displayName?: string; email?: string; isAdmin?: boolean; isGuest?: boolean; disabled?: boolean } }>('/api/admin/users/:id', async (req) => {
    requireAdmin(req);
    if (req.params.id === req.user!.id && (req.body.disabled || req.body.isAdmin === false || req.body.isGuest)) throw new AuthError('Das eigene Konto kann nicht gesperrt oder herabgestuft werden');
    const wasAdmin = !!auth.getUser(req.params.id)?.isAdmin;
    const user = auth.updateUser(req.params.id, req.body);
    acl.invalidate();
    if (user.isAdmin && !wasAdmin) newAdmin(user.username, `ernannt von ${req.user!.username}`);
    audit(req, 'user-changed', `Benutzer geändert: ${user.username}${user.isAdmin ? ' (Admin)' : ''}${user.isGuest ? ' (Gast)' : ''}${user.disabled ? ' (gesperrt)' : ''}`);
    return user;
  });

  server.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    requireAdmin(req);
    // Webhooks in the person's name go with the account (foreign key); their secrets are kept apart, by webhook id.
    const hooks = eventHooks.list().filter((h) => h.userId === req.params.id);
    auth.deleteUser(req.params.id, req.user!.id);
    acl.forgetUser(req.params.id);
    // Secrets have no foreign key: the personal Pushover user key and the webhook secrets would stay behind.
    notifier.savePersonalPushover(req.params.id, '');
    for (const h of hooks) eventHooks.remove(h.id);
    // Without the name: the log forgets the person (their earlier entries are anonymised too).
    audit(req, 'user-deleted', 'Benutzer gelöscht, seine Einträge im Protokoll anonymisiert');
    return { ok: true };
  });

  server.post<{ Params: { id: string }; Body: { password: string; mustChange?: boolean } }>('/api/admin/users/:id/password', async (req) => {
    requireAdmin(req);
    await auth.setPassword(req.params.id, String(req.body.password ?? ''), req.body.mustChange !== false);
    audit(req, 'user-password-reset', `Passwort zurückgesetzt: ${auth.getUser(req.params.id)?.username ?? req.params.id}`);
    return { ok: true };
  });
}
