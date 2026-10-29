import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db/db.js';
import { Acl, type Level } from './acl.js';

let db: DB;
let acl: Acl;
let def: Level;
const anna = { id: 'anna', isAdmin: false };
const bob = { id: 'bob', isAdmin: false };
const admin = { id: 'chef', isAdmin: true };

beforeEach(() => {
  db = openDb(':memory:');
  def = 'write';
  acl = new Acl(db, () => def);
  for (const u of ['anna', 'bob', 'chef']) db.prepare("INSERT INTO users (id, username, display_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, 'x', '')").run(u, u, u, `${u}@example.test`);
  db.prepare("INSERT INTO mounts (id, name, type, source, created_at) VALUES ('m', 'Wiki', 'local', '/x', '')").run();
  db.prepare("INSERT INTO note_ids (mount_id, path, id) VALUES ('m', 'team/plan.md', 'N1'), ('m', 'team/geheim/lohn.md', 'N2'), ('m', 'start.md', 'N3')").run();
});

const rule = (target: 'mount' | 'folder' | 'note', path: string, subject: 'all' | 'group' | 'user', subjectId: string | null, level: Level) =>
  acl.addRule({ mountId: 'm', target, path, subject, subjectId, level });

describe('ACL evaluation (AD-020)', () => {
  it('a closed source opens up only through rules for this person, never through someone else\'s (checklist 20.10.)', () => {
    def = 'none';
    expect(acl.hasRulesBelow('m', '')).toBe(false);
    rule('note', 'team/plan.md', 'user', 'anna', 'read');
    // A rule for Anna is below the root: she sees the source, Bob must not even learn its name.
    expect(acl.hasRulesBelow('m', '')).toBe(true);
    expect(acl.opensBelow(anna, 'm', '')).toBe(true);
    expect(acl.opensBelow(bob, 'm', '')).toBe(false);
    // A rule that closes something for Bob opens nothing either.
    rule('folder', 'team', 'user', 'bob', 'none');
    expect(acl.opensBelow(bob, 'm', '')).toBe(false);
    rule('folder', 'team/geheim', 'all', null, 'read');
    expect(acl.opensBelow(bob, 'm', '')).toBe(false); // still closed for Bob by his own „none“ on team
    expect(acl.opensBelow(anna, 'm', 'team')).toBe(true);
  });

  it('uses the default level without rules; admins always get admin', () => {
    expect(acl.level(anna, 'm', 'start.md')).toBe('write');
    def = 'read';
    expect(acl.level(anna, 'm', 'start.md')).toBe('read');
    rule('mount', '', 'all', null, 'none');
    expect(acl.level(admin, 'm', 'start.md')).toBe('admin');
  });

  it('the most specific level wins; user before group before all', () => {
    const team = acl.createGroup('Team');
    acl.setMembers(team.id, ['anna']);
    rule('mount', '', 'all', null, 'none');
    rule('folder', 'team', 'group', team.id, 'write');
    expect(acl.level(anna, 'm', 'start.md')).toBe('none');
    expect(acl.level(bob, 'm', 'start.md')).toBe('none');
    expect(acl.level(anna, 'm', 'team/plan.md')).toBe('write');
    expect(acl.level(bob, 'm', 'team/plan.md')).toBe('none');
    // A deeper rule for everyone opens one note for Bob too.
    rule('note', 'team/plan.md', 'all', null, 'read');
    expect(acl.level(bob, 'm', 'team/plan.md')).toBe('read');
    // On the same level a user rule beats the group rule.
    rule('note', 'team/plan.md', 'user', 'anna', 'admin');
    expect(acl.level(anna, 'm', 'team/plan.md')).toBe('admin');
    expect(acl.level(anna, 'm', 'team', true)).toBe('write');
  });

  it('an explicit none for the user or one of their groups always wins', () => {
    const team = acl.createGroup('Team');
    acl.setMembers(team.id, ['anna', 'bob']);
    rule('folder', 'team/geheim', 'user', 'bob', 'none');
    rule('note', 'team/geheim/lohn.md', 'group', team.id, 'write');
    expect(acl.level(anna, 'm', 'team/geheim/lohn.md')).toBe('write');
    expect(acl.level(bob, 'm', 'team/geheim/lohn.md')).toBe('none');
    expect(acl.level(bob, 'm', 'team/plan.md')).toBe('write');
  });

  it('one rule per target and subject; note rules follow the note id; folder rules follow moves', () => {
    const a = rule('folder', 'team', 'user', 'anna', 'read');
    const b = rule('folder', 'team', 'user', 'anna', 'write');
    expect(b.id).toBe(a.id);
    expect(acl.rulesAt('m', 'folder', 'team')).toHaveLength(1);
    rule('note', 'team/plan.md', 'user', 'bob', 'none');
    db.prepare("UPDATE note_ids SET path = 'archiv/plan.md' WHERE id = 'N1'").run();
    acl.invalidate('m');
    expect(acl.level(bob, 'm', 'archiv/plan.md')).toBe('none');
    acl.moved('m', 'team', 'projekte/team');
    expect(acl.rulesAt('m', 'folder', 'projekte/team')).toHaveLength(1);
    db.prepare("DELETE FROM note_ids WHERE id = 'N1'").run();
    acl.invalidate('m');
    expect(acl.rules('m').find((r) => r.target === 'note')!.orphan).toBe(true);
  });

  it('deleting a group removes its rules; validation errors', () => {
    const g = acl.createGroup('Gäste');
    rule('mount', '', 'group', g.id, 'read');
    expect(() => acl.createGroup('gäste')).toThrow(/gibt es schon/);
    acl.deleteGroup(g.id);
    expect(acl.rules('m')).toHaveLength(0);
    expect(() => rule('note', 'fehlt.md', 'all', null, 'read')).toThrow(/Notiz nicht gefunden/);
    expect(() => rule('mount', '', 'user', 'niemand', 'read')).toThrow(/Benutzer nicht gefunden/);
    expect(() => rule('mount', '', 'all', null, 'super' as Level)).toThrow(/Stufe/);
  });

  it('guests (AD-030): no default level, no rules for „Alle“ — only their own and their groups\' rules', () => {
    const gast = { id: 'gast', isAdmin: false, isGuest: true };
    db.prepare("INSERT INTO users (id, username, display_name, email, password_hash, created_at, is_guest) VALUES ('gast', 'gast', 'Gast', 'gast@example.test', 'x', '', 1)").run();
    expect(acl.level(gast, 'm', 'start.md')).toBe('none');
    rule('mount', '', 'all', null, 'write');
    expect(acl.level(anna, 'm', 'start.md')).toBe('write');
    expect(acl.level(gast, 'm', 'start.md')).toBe('none');
    rule('note', 'team/plan.md', 'user', 'gast', 'read');
    expect(acl.level(gast, 'm', 'team/plan.md')).toBe('read');
    expect(acl.level(gast, 'm', 'team/geheim/lohn.md')).toBe('none');
    const kunden = acl.createGroup('Kunden');
    acl.setMembers(kunden.id, ['gast']);
    rule('folder', 'team/geheim', 'group', kunden.id, 'read');
    expect(acl.level(gast, 'm', 'team/geheim/lohn.md')).toBe('read');
  });

  it('guests never get „verwalten“ (AD-048): such a rule cannot be set and an existing one works like „schreiben“', () => {
    const gast = { id: 'gast', isAdmin: false, isGuest: true };
    db.prepare("INSERT INTO users (id, username, display_name, email, password_hash, created_at, is_guest) VALUES ('gast', 'gast', 'Gast', 'gast@example.test', 'x', '', 1)").run();
    expect(() => rule('note', 'team/plan.md', 'user', 'gast', 'admin')).toThrow(/Gäste/);
    expect(acl.rules('m')).toHaveLength(0);
    // Rules from before (or from the time the account was no guest yet) stay, but are capped.
    db.prepare("INSERT INTO acl_rules (id, mount_id, target, path, note_id, subject, subject_id, level, created_at) VALUES ('R1', 'm', 'note', '', 'N1', 'user', 'gast', 'admin', '')").run();
    acl.invalidate('m');
    expect(acl.level(gast, 'm', 'team/plan.md')).toBe('write');
    // A group may still manage: its normal members keep „verwalten“, guests in it get „schreiben“.
    const team = acl.createGroup('Team');
    acl.setMembers(team.id, ['anna', 'gast']);
    rule('folder', 'team/geheim', 'group', team.id, 'admin');
    expect(acl.level(anna, 'm', 'team/geheim/lohn.md')).toBe('admin');
    expect(acl.level(gast, 'm', 'team/geheim/lohn.md')).toBe('write');
    expect(acl.level(gast, 'm', 'team/geheim', true)).toBe('write');
    expect(acl.level(gast, 'm', 'start.md')).toBe('none');
  });
});
