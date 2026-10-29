// The access checks (AD-020) on their own: a real Acl, the source and the index as small fakes – no buildApp.
import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db/db.js';
import type { Entry } from '../index/indexer.js';
import type { Mount } from '../mounts/model.js';
import { ForbiddenError, NotFoundError } from '../notes/service.js';
import { Acl, type Level } from './acl.js';
import { createAccess } from './access.js';

let db: DB;
let acl: Acl;
let mounts: Record<string, Partial<Mount>>;
let entries: Entry[];
const as = (id: string, isAdmin = false) => ({ user: { id, isAdmin, isGuest: false } }) as unknown as FastifyRequest;
const anna = as('anna');
const chef = as('chef', true);
const entry = (path: string, kind: 'file' | 'dir'): Entry =>
  ({ mountId: 'm', path, parent: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', name: path, kind }) as Entry;
const rule = (target: 'mount' | 'folder' | 'note', path: string, level: Level) => acl.addRule({ mountId: 'm', target, path, subject: 'all', subjectId: null, level });
const make = () =>
  createAccess({
    acl,
    manager: { get: (id: string) => (mounts[id] as Mount | undefined) ?? null },
    indexer: { all: () => entries },
  });

beforeEach(() => {
  db = openDb(':memory:');
  acl = new Acl(db, () => 'write');
  db.prepare("INSERT INTO mounts (id, name, type, source, created_at) VALUES ('m', 'Wiki', 'local', '/x', '')").run();
  db.prepare("INSERT INTO note_ids (mount_id, path, id) VALUES ('m', 'team/plan.md', 'N1'), ('m', 'team/geheim.md', 'N2'), ('m', 'start.md', 'N3')").run();
  mounts = { m: { id: 'm', name: 'Wiki', paused: false }, p: { id: 'p', name: 'Pause', paused: true } };
  entries = [entry('start.md', 'file'), entry('team', 'dir'), entry('team/plan.md', 'file')];
});

describe('access checks (acl/access.ts)', () => {
  it('access: no right → 404, too little → 403, unknown or paused source → 404', () => {
    const a = make();
    expect(a.access(anna, 'm', 'start.md', 'write').id).toBe('m');
    rule('note', 'start.md', 'read');
    expect(() => a.access(anna, 'm', 'start.md', 'write')).toThrow(ForbiddenError);
    expect(a.access(anna, 'm', 'start.md', 'read').id).toBe('m');
    rule('folder', 'team', 'none');
    expect(() => a.access(anna, 'm', 'team/plan.md', 'read')).toThrow(NotFoundError);
    expect(a.canRead(anna, 'm', 'team/plan.md')).toBe(false);
    expect(a.access(chef, 'm', 'team/plan.md', 'admin').id).toBe('m');
    expect(() => a.access(chef, 'nope', '', 'read')).toThrow(NotFoundError);
    expect(() => a.access(chef, 'p', '', 'read')).toThrow(NotFoundError);
    // A path without .md counts as a folder.
    expect(a.isDirPath('team')).toBe(true);
    expect(a.levelIn(anna, 'm', 'team')).toBe('none');
  });

  it('accessAll needs the right on everything below – also on notes the index does not list', () => {
    const a = make();
    expect(a.accessAll(anna, 'm', 'team', 'write').id).toBe('m');
    // team/geheim.md is not in the index; its rule alone closes the folder for deleting.
    rule('note', 'team/geheim.md', 'read');
    expect(() => a.accessAll(anna, 'm', 'team', 'write')).toThrow(ForbiddenError);
    expect(a.accessAll(anna, 'm', 'team', 'read').id).toBe('m');
    expect(a.accessAll(chef, 'm', 'team', 'write').id).toBe('m');
  });

  it('visibleEntries keeps the folders of a visible note and gives each entry its level', () => {
    rule('mount', '', 'none');
    rule('note', 'team/plan.md', 'read');
    const a = make();
    const seen = a.visibleEntries(anna, 'm').map((e) => [e.path, e.access]);
    // The folder itself is closed, but it holds a readable note: listed, as „read“.
    expect(seen).toEqual([
      ['team', 'read'],
      ['team/plan.md', 'read'],
    ]);
    expect(a.visibleEntries(chef, 'm')).toHaveLength(3);
  });

  it('a source is visible when its root is readable or a rule below might open something', () => {
    const a = make();
    expect(a.mountVisible(anna, 'm')).toBe(true);
    rule('mount', '', 'none');
    expect(a.mountVisible(anna, 'm')).toBe(false);
    expect(() => a.visibleMount(anna, 'm')).toThrow(NotFoundError);
    expect(a.visibleMount(chef, 'm').id).toBe('m');
    rule('folder', 'team', 'read');
    expect(a.mountVisible(anna, 'm')).toBe(true);
  });
});
