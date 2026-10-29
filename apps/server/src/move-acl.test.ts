// Moving a folder takes everything in it along: rights count for all of it, whatever the folder is called and whatever
// files it holds (audit sec2-010, sec2-011); folder rules follow the folder.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';

let root: string;
let wiki: string;
let app: App;
let admin: string;
let eva: string;
let mountId: string;
const inject = (method: 'GET' | 'POST', url: string, cookie: string, body?: unknown) =>
  app.server.inject({ method, url, ...(body === undefined ? { headers: { cookie } } : { payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } }) });
const session = (res: { cookies: { name: string; value: string }[] }) => `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-move-acl-'));
  wiki = join(root, 'projekte', 'wiki');
  mkdirSync(join(wiki, 'offen', 'ordner.md', 'zu'), { recursive: true });
  mkdirSync(join(wiki, 'offen', 'nurpdf', 'zu'), { recursive: true });
  writeFileSync(join(wiki, 'offen', 'ordner.md', 'a.md'), '# A\n');
  writeFileSync(join(wiki, 'offen', 'ordner.md', 'zu', 'geheim.md'), '# Geheim\n');
  writeFileSync(join(wiki, 'offen', 'nurpdf', 'a.md'), '# A\n');
  writeFileSync(join(wiki, 'offen', 'nurpdf', 'zu', 'bericht.pdf'), '%PDF-1.4\n');
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  admin = session(await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123' } }));
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
  mountId = ((await inject('POST', '/api/mounts', admin, { type: 'local', source: wiki, name: 'Wiki' })).json() as { id: string }).id;
  const created = (await inject('POST', '/api/admin/users', admin, { email: 'eva@example.test', username: 'eva', password: 'Eva-Passwort-0001-lang' })).json() as { id: string };
  app.db.prepare('UPDATE users SET must_change_password = 0').run();
  for (const path of ['offen/ordner.md/zu', 'offen/nurpdf/zu'])
    expect((await inject('POST', `/api/acl/${mountId}`, admin, { target: 'folder', path, subject: 'user', subjectId: created.id, level: 'none' })).statusCode).toBe(200);
  eva = session(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Eva-Passwort-0001-lang' } }));
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it('a closed subfolder holding only files the index does not list stops the move (sec2-011)', async () => {
  expect((await inject('POST', `/api/notes/${mountId}/move`, eva, { from: 'offen/nurpdf', to: 'offen/nurpdf2' })).statusCode).toBe(403);
  expect(existsSync(join(wiki, 'offen/nurpdf/zu/bericht.pdf'))).toBe(true);
});

it('a folder whose name ends in „.md“ is checked as a folder; its rules follow it (sec2-010)', async () => {
  expect((await inject('GET', `/api/notes/${mountId}/offen/ordner.md/zu/geheim.md`, eva)).statusCode).toBe(404);
  expect((await inject('POST', `/api/notes/${mountId}/move`, eva, { from: 'offen/ordner.md', to: 'offen/neu.md' })).statusCode).toBe(403);
  expect(existsSync(join(wiki, 'offen/ordner.md/zu/geheim.md'))).toBe(true);
  // The admin may move it – the closed folder stays closed at its new place.
  expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'offen/ordner.md', to: 'offen/neu.md' })).statusCode).toBe(200);
  expect(existsSync(join(wiki, 'offen/neu.md/zu/geheim.md'))).toBe(true);
  expect((await inject('GET', `/api/notes/${mountId}/offen/neu.md/zu/geheim.md`, eva)).statusCode).toBe(404);
});

it('to another source: files left behind stay protected, the rules hold at both places (sec2-012)', async () => {
  mkdirSync(join(root, 'projekte', 'ziel'), { recursive: true });
  const target = ((await inject('POST', '/api/mounts', admin, { type: 'local', source: join(root, 'projekte', 'ziel'), name: 'Ziel' })).json() as { id: string }).id;
  expect((await inject('GET', `/api/files/${mountId}/offen/nurpdf/zu/bericht.pdf`, eva)).statusCode).toBe(404);
  const moved = await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'offen/nurpdf', to: 'nurpdf', toMountId: target });
  expect(moved.statusCode).toBe(200);
  // Only notes go along: the PDF stays in the old source – and closed for Eva.
  expect(existsSync(join(wiki, 'offen/nurpdf/zu/bericht.pdf'))).toBe(true);
  expect((await inject('GET', `/api/files/${mountId}/offen/nurpdf/zu/bericht.pdf`, eva)).statusCode).toBe(404);
  // …and the rule now also stands at the new place.
  const rules = (await inject('GET', `/api/acl/${target}?target=folder&path=nurpdf/zu`, admin)).json() as { rules: { level: string }[] };
  expect(rules.rules).toEqual([expect.objectContaining({ level: 'none' })]);
});

it('to another source: a note rule follows its note – alone and inside a moved folder (sec2-013)', async () => {
  mkdirSync(join(root, 'projekte', 'ziel'), { recursive: true });
  writeFileSync(join(wiki, 'offen', 'privat.md'), '# Privat\n');
  writeFileSync(join(wiki, 'offen', 'nurpdf', 'tagebuch.md'), '# Tagebuch\n');
  const end = Date.now() + 5000;
  while (!(await inject('GET', `/api/tree/${mountId}`, admin)).body.includes('offen/nurpdf/tagebuch.md') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const target = ((await inject('POST', '/api/mounts', admin, { type: 'local', source: join(root, 'projekte', 'ziel'), name: 'Ziel' })).json() as { id: string }).id;
  const evaId = (app.db.prepare("SELECT id FROM users WHERE username = 'eva'").get() as { id: string }).id;
  for (const path of ['offen/privat.md', 'offen/nurpdf/tagebuch.md'])
    expect((await inject('POST', `/api/acl/${mountId}`, admin, { target: 'note', path, subject: 'user', subjectId: evaId, level: 'none' })).statusCode).toBe(200);
  expect((await inject('GET', `/api/notes/${mountId}/offen/privat.md`, eva)).statusCode).toBe(404);
  expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'offen/privat.md', to: 'privat.md', toMountId: target })).statusCode).toBe(200);
  expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'offen/nurpdf', to: 'nurpdf', toMountId: target })).statusCode).toBe(200);
  expect((await inject('GET', `/api/notes/${target}/privat.md`, eva)).statusCode).toBe(404);
  expect((await inject('GET', `/api/notes/${target}/nurpdf/tagebuch.md`, eva)).statusCode).toBe(404);
  expect((await inject('GET', `/api/notes/${target}/privat.md`, admin)).statusCode).toBe(200);
  // As note rules they keep following the note – also when it is renamed in its new source.
  expect((await inject('POST', `/api/notes/${target}/move`, admin, { from: 'privat.md', to: 'geheimer.md' })).statusCode).toBe(200);
  expect((await inject('GET', `/api/notes/${target}/geheimer.md`, eva)).statusCode).toBe(404);
});

it('to another source: the copy is closed even when the move fails half-way (sec2-014)', async () => {
  mkdirSync(join(root, 'projekte', 'ziel'), { recursive: true });
  mkdirSync(join(wiki, 'fest'), { recursive: true });
  writeFileSync(join(wiki, 'fest', 'notiz.md'), '# Fest\n');
  writeFileSync(join(wiki, 'fest', 'privat.md'), '# Privat\n');
  const end = Date.now() + 5000;
  while (!(await inject('GET', `/api/tree/${mountId}`, admin)).body.includes('fest/privat.md') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const target = ((await inject('POST', '/api/mounts', admin, { type: 'local', source: join(root, 'projekte', 'ziel'), name: 'Ziel' })).json() as { id: string }).id;
  const evaId = (app.db.prepare("SELECT id FROM users WHERE username = 'eva'").get() as { id: string }).id;
  expect((await inject('POST', `/api/acl/${mountId}`, admin, { target: 'folder', path: 'fest', subject: 'user', subjectId: evaId, level: 'none' })).statusCode).toBe(200);
  // Bob may read the folder, but not this one note.
  const bob = (await inject('POST', '/api/admin/users', admin, { email: 'bob@example.test', username: 'bob', password: 'Bob-Passwort-0001-lang' })).json() as { id: string };
  app.db.prepare('UPDATE users SET must_change_password = 0').run();
  expect((await inject('POST', `/api/acl/${mountId}`, admin, { target: 'note', path: 'fest/privat.md', subject: 'user', subjectId: bob.id, level: 'none' })).statusCode).toBe(200);
  const bobCookie = session(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'bob@example.test', password: 'Bob-Passwort-0001-lang' } }));
  expect((await inject('GET', `/api/notes/${mountId}/fest/privat.md`, bobCookie)).statusCode).toBe(404);
  // Removing at the old place fails: the folder there is read-only.
  chmodSync(join(wiki, 'fest'), 0o555);
  try {
    expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'fest', to: 'fest', toMountId: target })).statusCode).toBe(500);
  } finally {
    chmodSync(join(wiki, 'fest'), 0o755);
  }
  expect(existsSync(join(root, 'projekte', 'ziel', 'fest', 'notiz.md'))).toBe(true);
  expect((await inject('GET', `/api/notes/${target}/fest/notiz.md`, eva)).statusCode).toBe(404);
  expect((await inject('GET', `/api/notes/${mountId}/fest/notiz.md`, eva)).statusCode).toBe(404);
  // The note rule holds at both places too – the original keeps it, the copy has it (sec2-015).
  expect((await inject('GET', `/api/notes/${mountId}/fest/privat.md`, bobCookie)).statusCode).toBe(404);
  expect((await inject('GET', `/api/notes/${target}/fest/privat.md`, bobCookie)).statusCode).toBe(404);
  expect((await inject('GET', `/api/notes/${target}/fest/notiz.md`, bobCookie)).statusCode).toBe(200);
});

it('to another source: when copying itself fails, what was copied is closed already (sec2-016)', async () => {
  mkdirSync(join(root, 'projekte', 'ziel'), { recursive: true });
  mkdirSync(join(wiki, 'fz'), { recursive: true });
  writeFileSync(join(wiki, 'fz', 'notiz.md'), '# Notiz\n');
  writeFileSync(join(wiki, 'fz', '.kaveyl-wiki.yml'), 'sort: name\n');
  const end = Date.now() + 5000;
  while (!(await inject('GET', `/api/tree/${mountId}`, admin)).body.includes('fz/notiz.md') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const target = ((await inject('POST', '/api/mounts', admin, { type: 'local', source: join(root, 'projekte', 'ziel'), name: 'Ziel' })).json() as { id: string }).id;
  const evaId = (app.db.prepare("SELECT id FROM users WHERE username = 'eva'").get() as { id: string }).id;
  expect((await inject('POST', `/api/acl/${mountId}`, admin, { target: 'note', path: 'fz/notiz.md', subject: 'user', subjectId: evaId, level: 'none' })).statusCode).toBe(200);
  // The folder settings come after the notes and cannot be read: copying stops half-way.
  chmodSync(join(wiki, 'fz', '.kaveyl-wiki.yml'), 0o000);
  try {
    expect((await inject('POST', `/api/notes/${mountId}/move`, admin, { from: 'fz', to: 'fz', toMountId: target })).statusCode).toBe(500);
  } finally {
    chmodSync(join(wiki, 'fz', '.kaveyl-wiki.yml'), 0o644);
  }
  expect(existsSync(join(root, 'projekte', 'ziel', 'fz', 'notiz.md'))).toBe(true);
  expect((await inject('GET', `/api/notes/${target}/fz/notiz.md`, eva)).statusCode).toBe(404);
  expect((await inject('GET', `/api/notes/${mountId}/fz/notiz.md`, eva)).statusCode).toBe(404);
  // …as a note rule the admin sees (and can change) in the note's permissions – not hidden on a bare path (sec2-017).
  const dialog = (await inject('GET', `/api/acl/${target}?target=note&path=fz/notiz.md`, admin)).json() as { rules: { level: string }[] };
  expect(dialog.rules).toEqual([expect.objectContaining({ level: 'none' })]);
});
