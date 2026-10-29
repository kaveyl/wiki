// User administration in the AuthService: order of the list; who commits name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../db/db.js';
import { AuthService, commitAuthor } from './auth.js';

let root: string;
let db: DB;
let auth: AuthService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-users-'));
  db = openDb(join(root, 'kaveyl-wiki.db'));
  auth = new AuthService(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const add = (name: string, extra: { isAdmin?: boolean; isGuest?: boolean } = {}) =>
  auth.createUser({ email: `${name}@example.test`, username: name, password: 'Start-Passwort-0001', ...extra });

describe('user list', () => {
  it('admins first, then users, then guests – each in the order they were created, not by name', async () => {
    await add('zora');
    await add('gast-b', { isGuest: true });
    await add('anton', { isAdmin: true });
    await add('bert');
    await add('gast-a', { isGuest: true });
    await add('yvonne', { isAdmin: true });
    expect(auth.listUsers().map((u) => u.username)).toEqual(['anton', 'yvonne', 'zora', 'bert', 'gast-b', 'gast-a']);
  });
});

describe('commit author', () => {
  it('the display name and an address made from the id – never the real e-mail', async () => {
    const u = await auth.createUser({ email: 'maria.muster@example.test', username: 'maria', displayName: 'Maria Muster', password: 'Start-Passwort-0001' });
    const a = commitAuthor(u);
    expect(a).toEqual({ name: 'Maria Muster', email: `${u.id.toLowerCase()}@users.kaveyl-wiki.invalid` });
    expect(JSON.stringify(a)).not.toContain('example.test');
  });
});

describe('default level without a rule (AD-051)', () => {
  const level = (d: DB) => (d.prepare("SELECT value FROM settings WHERE key = 'acl_default'").get() as { value: string } | undefined)?.value ?? null;

  it('a new installation stores nothing – „kein Zugriff“ applies', () => {
    expect(level(db)).toBeNull();
  });

  it('an installation from before with accounts keeps „lesen & schreiben“; one that chose a level keeps it', async () => {
    await add('anton', { isAdmin: true });
    db.pragma('user_version = 16');
    db.close();
    db = openDb(join(root, 'kaveyl-wiki.db'));
    expect(level(db)).toBe('write');
    db.prepare("UPDATE settings SET value = 'read' WHERE key = 'acl_default'").run();
    db.pragma('user_version = 16');
    db.close();
    db = openDb(join(root, 'kaveyl-wiki.db'));
    expect(level(db)).toBe('read');
  });
});

describe('Pangolin leftovers (AD-058)', () => {
  it('migration v20 removes its setting and the accounts’ connections, nothing else', async () => {
    const anna = await add('anna');
    db.prepare("INSERT INTO settings (key, value) VALUES ('proxy_auth_pangolin', '{}'), ('proxy_auth_authentik', '{}')").run();
    db.prepare("INSERT INTO proxy_links (user_id, provider, subject, created_at) VALUES (?, 'pangolin', 'p-anna', '2026-10-20'), (?, 'authentik', 'a-anna', '2026-10-20')").run(anna.id, anna.id);
    db.pragma('user_version = 19');
    db.close();
    db = openDb(join(root, 'kaveyl-wiki.db'));
    expect(db.prepare("SELECT key FROM settings WHERE key LIKE 'proxy_auth_%'").all()).toEqual([{ key: 'proxy_auth_authentik' }]);
    expect(db.prepare('SELECT provider FROM proxy_links').all()).toEqual([{ provider: 'authentik' }]);
  });
});

describe('display names (sec-004)', () => {
  it('control characters and line breaks are taken out when the name is set – creating (also by accepting an invitation), changing', async () => {
    const u = await auth.createUser({ email: 'eve@example.test', username: 'eve', displayName: ' Eve\nCo-authored-by: Chefin <chefin@firma.example>\u0007 ', password: 'Start-Passwort-0001' });
    expect(u.displayName).toBe('Eve Co-authored-by: Chefin <chefin@firma.example>');
    expect(auth.updateUser(u.id, { displayName: 'Eva\r\n\tMuster' }).displayName).toBe('Eva Muster');
    // Only control characters: like an empty name, the old one stays.
    expect(auth.updateUser(u.id, { displayName: '\n\u0000' }).displayName).toBe('Eva Muster');
    expect((await auth.createUser({ email: 'leer@example.test', username: 'leer', displayName: '\r\n', password: 'Start-Passwort-0001' })).displayName).toBe('leer');
  });

  it('invisible format characters are taken out (a name cannot pose as another one); emoji sequences stay', async () => {
    const { id } = await auth.createUser({ email: 'eve@example.test', username: 'eve', displayName: 'Eve', password: 'Start-Passwort-0001' });
    // „Anna“ followed by a right-to-left override and a reversed text, zero-width space, word joiner, BOM, soft hyphen.
    expect(auth.updateUser(id, { displayName: 'Anna\u202e nimdA\u202c\u200b\u2060\ufeff\u00ad' }).displayName).toBe('Anna nimdA');
    expect(auth.updateUser(id, { displayName: '\u2066Maria\u2069 \u200eChen\u200f' }).displayName).toBe('Maria Chen');
    // Family emoji (zero-width joiner) and the Persian zero-width non-joiner stay as typed.
    expect(auth.updateUser(id, { displayName: 'Team 👩\u200d👩\u200d👧' }).displayName).toBe('Team 👩\u200d👩\u200d👧');
    expect(auth.updateUser(id, { displayName: 'می\u200cخواهم' }).displayName).toBe('می\u200cخواهم');
  });
});
