// Access rules (AD-020): the default level, who can be picked in the permissions dialog, rules per source, folder
// or note. Moved out of buildApp (code-002); the checks themselves are in acl/.
import { statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { PathError, absPath, cleanRelPath } from '../mounts/model.js';
import { NotFoundError } from '../notes/service.js';
import { AclError, type Level, type Target } from '../acl/acl.js';
import type { AppContext } from './context.js';

export function registerAclRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, acl, audit, auth, config, levelIn, manager, mountRef, requireAdmin, settings } = ctx;
  // ── Access rules (AD-020): default level, who can be picked, rules per target ───────────────────────
  server.get('/api/admin/acl-default', async (req) => {
    requireAdmin(req);
    return { level: acl.defaultLevel() };
  });

  server.put<{ Body: { level: string } }>('/api/admin/acl-default', async (req) => {
    requireAdmin(req);
    const level = String(req.body.level);
    if (!['none', 'read', 'write'].includes(level)) throw new PathError('Erlaubt: none, read, write');
    settings.set('acl_default', level);
    acl.invalidate();
    audit(req, 'acl-default-changed', `Standardrecht ohne Regel: ${level}`);
    return { level };
  });

  /** Names for the permissions dialog (anyone who may manage some rules needs to pick people). Guests (AD-030) only
   *  see themselves and their own groups, not every account (sec-009). */
  server.get('/api/acl-subjects', async (req) => {
    const guest = req.user!.isGuest ? req.user!.id : null;
    return {
      users: auth.listUsers().filter((u) => !u.disabled && (!guest || u.id === guest)).map((u) => ({ id: u.id, name: u.displayName || u.username, username: u.username, ...(u.isGuest ? { guest: true } : {}) })),
      groups: acl.groups().filter((g) => !guest || g.members.includes(guest)).map((g) => ({ id: g.id, name: g.name, size: g.members.length })),
    };
  });

  /**
   * Settings → Benutzer & Rechte → Rechte (owner 21.10.): every rule of every source, who it is for, and what each
   * account may at the top of each source and why – the grid of people × sources, and cleaning up. Admins only.
   */
  server.get('/api/admin/rights', async (req) => {
    requireAdmin(req);
    const mounts = manager.list();
    const users = auth.listUsers();
    const groups = acl.groups();
    const rules = mounts.flatMap((m) =>
      acl.rules(m.id).map((r) => ({
        id: r.id,
        mountId: r.mountId,
        target: r.target,
        path: r.path,
        subject: r.subject,
        subjectId: r.subjectId,
        level: r.level,
        ...(r.orphan || (r.target === 'folder' && !folderExists(m, r.path)) ? { orphan: true } : {}),
      })),
    );
    return {
      defaultLevel: acl.defaultLevel(),
      mounts: mounts.map((m) => ({ id: m.id, name: m.name })),
      users: users.map((u) => ({
        id: u.id,
        name: u.displayName || u.username,
        email: u.email,
        isAdmin: u.isAdmin,
        isGuest: !!u.isGuest,
        disabled: !!u.disabled,
        lastSeenAt: u.lastSeenAt ?? null,
        groups: groups.filter((g) => g.members.includes(u.id)).map((g) => g.id),
        // What they may at the top of each source (rules further down are in `rules`)…
        sources: Object.fromEntries(mounts.map((m) => [m.id, acl.level({ id: u.id, isAdmin: u.isAdmin, isGuest: !!u.isGuest }, m.id, '', true)])),
        // …and why: their own rule there, and what would apply without it (the grid shows it, owner 21.10.).
        why: u.isAdmin ? {} : Object.fromEntries(mounts.map((m) => [m.id, acl.explainTop({ id: u.id, isAdmin: false, isGuest: !!u.isGuest }, m.id)])),
      })),
      groups: groups.map((g) => ({ id: g.id, name: g.name, members: g.members })),
      rules,
    };
  });

  const folderExists = (mount: Parameters<typeof absPath>[0], path: string) => {
    try {
      return statSync(absPath(mount, config.dataPath, path)).isDirectory();
    } catch {
      return false;
    }
  };

  const TARGETS = ['mount', 'folder', 'note'] as const;
  const targetOf = (t: unknown): Target => {
    if (!(TARGETS as readonly unknown[]).includes(t)) throw new AclError('Unbekanntes Ziel');
    return t as Target;
  };
  /** Rules on a target and those inherited from above, for whoever may manage it (`admin` there). */
  server.get<{ Params: { mountId: string }; Querystring: { target?: string; path?: string } }>('/api/acl/:mountId', async (req) => {
    const target = targetOf(req.query.target);
    const path = target === 'mount' ? '' : cleanRelPath(String(req.query.path ?? ''));
    const mount = access(req, req.params.mountId, path, 'admin', target !== 'note');
    const ancestors = (r: { target: Target; path: string }) =>
      r.target === 'mount' || (r.target === 'folder' && path !== r.path && (path + '/').startsWith(r.path + '/'));
    return {
      rules: acl.rulesAt(mount.id, target, path),
      inherited: target === 'mount' ? [] : acl.rules(mount.id).filter((r) => !r.orphan && ancestors(r) && !(target === 'folder' && r.target === 'folder' && r.path === path)),
      // Folder rules hang on the path: renamed or deleted outside, they wait unseen – shown here (still in force,
      // they apply again to a folder of that name).
      orphans: target === 'mount' ? acl.rules(mount.id).flatMap((r) => (r.orphan ? [r] : r.target === 'folder' && !folderExists(mount, r.path) ? [{ ...r, orphan: true, folderMissing: true }] : [])) : [],
      mine: levelIn(req, mount.id, path, target !== 'note'),
    };
  });

  server.post<{ Params: { mountId: string }; Body: { target: string; path?: string; subject: string; subjectId?: string | null; level: string } }>('/api/acl/:mountId', async (req) => {
    const target = targetOf(req.body.target);
    const path = target === 'mount' ? '' : cleanRelPath(String(req.body.path ?? ''));
    const mount = access(req, req.params.mountId, path, 'admin', target !== 'note');
    const rule = acl.addRule({ mountId: mount.id, target, path, subject: req.body.subject as 'all', subjectId: req.body.subjectId ?? null, level: req.body.level as Level });
    audit(req, 'acl-changed', `Recht gesetzt: ${mount.name}/${path || '(Quelle)'} — ${rule.subject}${rule.subjectId ? ` ${rule.subjectId}` : ''}: ${rule.level}`, { mount: mountRef(mount) });
    return rule;
  });

  server.delete<{ Params: { id: string } }>('/api/acl/rule/:id', async (req) => {
    const rule = acl.rule(req.params.id);
    if (!rule) throw new NotFoundError(req.params.id);
    // Orphaned rules (target gone) can be cleaned up by whoever manages the source.
    const mount = rule.orphan ? access(req, rule.mountId, '', 'admin', true) : access(req, rule.mountId, rule.path, 'admin', rule.target !== 'note');
    acl.removeRule(rule.id);
    audit(req, 'acl-changed', `Recht entfernt: ${mount.name}/${rule.path || '(Quelle)'} — ${rule.subject}: ${rule.level}`, { mount: mountRef(mount) });
    return { ok: true };
  });
}
