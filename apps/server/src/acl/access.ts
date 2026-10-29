// Access control (AD-020): the one check every note route makes, on top of the rules in acl.ts. Moved out of buildApp
// (code-001) – testable without a whole app (access.test.ts). Shared with the route modules through AppContext.
import type { FastifyRequest } from 'fastify';
import type { Indexer } from '../index/indexer.js';
import type { MountManager } from '../mounts/manager.js';
import { cleanRelPath, type Mount } from '../mounts/model.js';
import { ForbiddenError, NotFoundError } from '../notes/service.js';
import { atLeast, type Acl, type Level, type Principal } from './acl.js';

export interface AccessDeps {
  acl: Pick<Acl, 'level' | 'hasRulesBelow' | 'opensBelow' | 'rules'>;
  manager: Pick<MountManager, 'get'>;
  indexer: Pick<Indexer, 'all'>;
}

export type Access = ReturnType<typeof createAccess>;

export function createAccess({ acl, manager, indexer }: AccessDeps) {
  const mountOr404 = (id: string): Mount => {
    const m = manager.get(id);
    if (!m || m.paused) throw new NotFoundError(id);
    return m;
  };
  const principal = (req: FastifyRequest): Principal => ({ id: req.user!.id, isAdmin: !!req.user!.isAdmin, isGuest: !!req.user!.isGuest });
  const relOrRoot = (path: string) => (path ? cleanRelPath(path) : '');
  const isDirPath = (path: string) => !!path && !/\.md$/i.test(path);
  const levelIn = (req: FastifyRequest, mountId: string, path: string, isDir = isDirPath(path)): Level => acl.level(principal(req), mountId, relOrRoot(path), isDir);
  /** Mount of the request, if the user has at least `need` on `path` there: none → 404 (nothing is revealed), less → 403. */
  const access = (req: FastifyRequest, mountId: string, path: string, need: Level, isDir = isDirPath(path)): Mount => {
    const mount = mountOr404(mountId);
    const have = levelIn(req, mount.id, path, isDir);
    if (have === 'none') throw new NotFoundError(path || mountId);
    if (!atLeast(have, need)) throw new ForbiddenError(need === 'admin' ? 'Keine Berechtigung, Rechte zu verwalten' : 'Nur Leserecht');
    return mount;
  };
  const canRead = (req: FastifyRequest, mountId: string, path: string, isDir = false) => levelIn(req, mountId, path, isDir) !== 'none';
  /**
   * Like access(), for operations that take everything inside a folder along (delete, move to
   * another source): the user needs `need` on every note and folder below, also the hidden ones.
   * Whatever is below counts, not the name: a folder may end in „.md“ (audit sec2-010). Besides the indexed notes and
   * folders, the folders rules name – a closed folder may hold only files the index does not list (sec2-011).
   */
  const accessAll = (req: FastifyRequest, mountId: string, path: string, need: Level): Mount => {
    const mount = access(req, mountId, path, need);
    const dir = relOrRoot(path);
    if (!dir || !acl.hasRulesBelow(mount.id, dir)) return mount;
    const p = principal(req);
    const inside = [
      ...indexer.all(mount.id).filter((e) => e.path.startsWith(dir + '/')).map((e) => ({ path: e.path, isDir: e.kind === 'dir' })),
      ...acl.rules(mount.id).filter((r) => r.target !== 'mount' && r.path.startsWith(dir + '/')).map((r) => ({ path: r.path, isDir: r.target === 'folder' })),
    ];
    if (inside.some((e) => !atLeast(acl.level(p, mount.id, e.path, e.isDir), need)))
      throw new ForbiddenError('Der Ordner enthält Notizen, auf die du keine Schreibrechte hast');
    return mount;
  };
  /** A source is listed when its root is readable or a rule for this person opens something below (not someone else's). */
  const mountVisible = (req: FastifyRequest, mountId: string) => req.user!.isAdmin || canRead(req, mountId, '', true) || acl.opensBelow(principal(req), mountId, '');
  const visibleMount = (req: FastifyRequest, mountId: string): Mount => {
    const mount = mountOr404(mountId);
    if (!mountVisible(req, mount.id)) throw new NotFoundError(mountId);
    return mount;
  };
  /** Tree entries the user may see, each with its effective level; folders also when something inside is visible. */
  const visibleEntries = (req: FastifyRequest, mountId: string) => {
    const p = principal(req);
    const entries = indexer.all(mountId);
    const levels = new Map(entries.map((e) => [e.path, acl.level(p, mountId, e.path, e.kind === 'dir')]));
    const keep = new Set<string>();
    for (const e of entries) {
      if (levels.get(e.path) === 'none') continue;
      keep.add(e.path);
      if (e.kind === 'file') for (let d = e.parent; d && !keep.has(d); d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') keep.add(d);
    }
    return entries.filter((e) => keep.has(e.path)).map((e) => ({ ...e, access: levels.get(e.path) === 'none' ? 'read' : levels.get(e.path)! }));
  };
  return { mountOr404, principal, isDirPath, levelIn, access, canRead, accessAll, mountVisible, visibleMount, visibleEntries };
}
