import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { Archive, zipBuffer, zipFolder } from './archive.js';
import { lastSlot, nextSlot, runsOn, toDelete } from './schedule.js';
import { parseSmbList, parseSmbLocation, smbMessage } from './smb.js';
import { archiveTime } from './service.js';
import { isText } from './text.js';

describe('schedule', () => {
  const keep = (k: Partial<{ daily: number; weekly: number; monthly: number; yearly: number }>) => ({ daily: 0, weekly: 0, monthly: 0, yearly: 0, ...k });

  it('runs on the days of the finest chosen rhythm', () => {
    const sunday = new Date(2026, 9, 11);
    const monday = new Date(2026, 9, 12);
    const first = new Date(2026, 10, 1);
    expect(runsOn(monday, keep({ daily: 7 }))).toBe(true);
    expect(runsOn(monday, keep({ weekly: 4 }))).toBe(false);
    expect(runsOn(sunday, keep({ weekly: 4 }))).toBe(true);
    expect(runsOn(first, keep({ monthly: 12 }))).toBe(true);
    expect(runsOn(new Date(2026, 0, 1), keep({ yearly: 3 }))).toBe(true);
    expect(runsOn(first, keep({ yearly: 3 }))).toBe(false);
  });

  it('finds the last and next slot, also across days', () => {
    const at = new Date(2026, 9, 12, 1, 0); // Monday 01:00
    expect(lastSlot(keep({ daily: 1 }), '02:00', at)).toEqual(new Date(2026, 9, 11, 2, 0));
    expect(nextSlot(keep({ daily: 1 }), '02:00', at)).toEqual(new Date(2026, 9, 12, 2, 0));
    expect(lastSlot(keep({ weekly: 1 }), '02:00', at)).toEqual(new Date(2026, 9, 11, 2, 0));
    expect(nextSlot(keep({ weekly: 1 }), '02:00', at)).toEqual(new Date(2026, 9, 18, 2, 0));
    expect(nextSlot(keep({ monthly: 1 }), '23:30', at)).toEqual(new Date(2026, 10, 1, 23, 30));
    expect(lastSlot(keep({}), '02:00', at)).toBeNull();
  });

  it('keeps the newest per day, week, month and year like restic', () => {
    // One archive a day at 02:00 for 70 days, newest first: 2026-10-11 … 2026-08-03.
    const archives = Array.from({ length: 70 }, (_, i) => ({ id: `a${i}`, createdAt: new Date(2026, 9, 11 - i, 2).toISOString() }));
    const gone = new Set(toDelete(archives, keep({ daily: 7, weekly: 4, monthly: 3 })));
    const kept = archives.filter((a) => !gone.has(a.id)).map((a) => a.createdAt.slice(0, 10));
    const localDay = (i: number) => {
      const d = new Date(2026, 9, 11 - i, 2);
      return new Date(d.getTime()).toISOString().slice(0, 10);
    };
    // 7 days, then the Sundays of 3 earlier weeks (week of the 11th is already in), then month ends.
    expect(kept.slice(0, 7)).toEqual([0, 1, 2, 3, 4, 5, 6].map(localDay));
    expect(kept).toContain(localDay(7)); // Sunday 4.10. = newest of its ISO week
    expect(kept).toContain(localDay(41)); // 31.8. = newest of August
    expect(kept.length).toBe(7 + 3 + 2); // 4 weeks (1 already kept), 3 months (October already kept)
    // Only one rhythm, keep 1 → just the newest.
    expect(toDelete(archives, keep({ weekly: 1 })).length).toBe(69);
    expect(toDelete([], keep({ daily: 1 }))).toEqual([]);
  });
});

describe('archive', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-zip-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('zips a folder without .git, with and without password, and reads it back', async () => {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'a', 'assets'), { recursive: true });
    mkdirSync(join(src, '.git'), { recursive: true });
    writeFileSync(join(src, 'a', 'Notiz äö.md'), '# Notiz\n\nText\n');
    writeFileSync(join(src, 'a', 'assets', 'bild.png'), Buffer.from([1, 2, 3, 0, 4]));
    writeFileSync(join(src, '.git', 'HEAD'), 'ref');
    for (const password of [null, 'Backup-Passwort-1']) {
      const out = join(dir, `${password ? 'enc' : 'plain'}.zip`);
      const res = await zipFolder(src, out, { password });
      expect(res.files).toBe(2);
      const a = await Archive.open(out, password);
      expect(a.entries().map((e) => e.path)).toEqual(['a/assets/bild.png', 'a/Notiz äö.md']);
      expect((await a.read('a/Notiz äö.md')).toString()).toBe('# Notiz\n\nText\n');
      expect([...(await a.read('a/assets/bild.png'))]).toEqual([1, 2, 3, 0, 4]);
      await a.close();
    }
    await expect(Archive.open(join(dir, 'enc.zip'), null)).rejects.toThrow(/verschlüsselt/);
    await expect(Archive.open(join(dir, 'enc.zip'), 'falsch-falsch')).rejects.toThrow(/passt nicht/);
  });

  it('refuses archives with entries that would lead outside', async () => {
    writeFileSync(join(dir, 'evil.zip'), await zipBuffer({ '../../x.md': 'böse', 'ok.md': 'gut' }));
    await expect(Archive.open(join(dir, 'evil.zip'))).rejects.toThrow();
  });

  it('tells text from binary files', () => {
    expect(isText('a.md', Buffer.from('# x'))).toBe(true);
    expect(isText('a.png', Buffer.from([0x89, 0x50, 0, 1]))).toBe(false);
  });
});

describe('smb', () => {
  it('reads every common way to write a share address', () => {
    expect(parseSmbLocation('\\\\nas\\backup\\kaveyl-wiki\\wiki')).toEqual({ host: 'nas', port: null, share: 'backup', dir: 'kaveyl-wiki/wiki' });
    expect(parseSmbLocation('//192.168.1.5/daten')).toEqual({ host: '192.168.1.5', port: null, share: 'daten', dir: '' });
    expect(parseSmbLocation('smb://nas.local:1445/backup/x')).toEqual({ host: 'nas.local', port: 1445, share: 'backup', dir: 'x' });
    expect(() => parseSmbLocation('nas/backup')).toThrow(/Format/);
    expect(() => parseSmbLocation('\\\\nas')).toThrow(/Freigabe/);
    expect(() => parseSmbLocation('//nas/backup/a";del x')).toThrow(/Ungültig/);
  });

  it('turns NT_STATUS codes into plain messages', () => {
    const loc = parseSmbLocation('//nas/backup');
    expect(smbMessage('session setup failed: NT_STATUS_LOGON_FAILURE', loc)).toMatch(/Passwort stimmt nicht/);
    expect(smbMessage('tree connect failed: NT_STATUS_BAD_NETWORK_NAME', loc)).toMatch(/Freigabe „backup“/);
    expect(smbMessage('do_connect: Connection to nas failed (Error NT_STATUS_HOST_UNREACHABLE)', loc)).toMatch(/nicht erreichbar/);
  });

  it('reads smbclient listings, also names with spaces and „failed“', () => {
    const out = [
      '  .                                   D        0  Wed Oct 28 23:22:49 2026',
      '  ..                                  D        0  Wed Oct 28 23:22:49 2026',
      '  Team Wiki                           D        0  Wed Oct 28 23:22:49 2026',
      '  failed_2026-10-28_020000.zip        A     1234  Thu Oct  1 02:00:01 2026',
      '',
      '\t\t65245764 blocks of size 1024. 3843012 blocks available',
    ].join('\n');
    expect(parseSmbList(out)).toEqual([
      { name: 'Team Wiki', dir: true, size: 0 },
      { name: 'failed_2026-10-28_020000.zip', dir: false, size: 1234 },
    ]);
  });
});

describe('archive names', () => {
  it('reads the time from what a run writes, nothing else', () => {
    expect(archiveTime('Team Wiki', 'Team Wiki_2026-10-28_021503.zip')).toEqual(new Date(2026, 9, 28, 2, 15, 3));
    expect(archiveTime('Wiki', 'Wiki_2026-10-28_021503-2.zip')).toEqual(new Date(2026, 9, 28, 2, 15, 3));
    expect(archiveTime('Wiki', 'Andere_2026-10-28_021503.zip')).toBeNull();
    expect(archiveTime('Wiki', 'Wiki_2026-02-30_021503.zip')).toBeNull();
    expect(archiveTime('Wiki', 'Wiki_2026-10-28_021503.zip.part')).toBeNull();
    expect(archiveTime('Wiki', 'Wiki-Kopie.zip')).toBeNull();
  });
});

// ── Through the HTTP API ──────────────────────────────────────────────────────────────
let root: string;
let app: App;
let cookie: string;
const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } });

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, status = 200): Promise<T> {
  const res = await app.server.inject({ method, url, ...(body !== undefined || method !== 'GET' ? json(body ?? {}) : { headers: { cookie } }) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(status);
  return res.json() as T;
}

let cfg: Parameters<typeof buildApp>[0];

describe('backups through the API', () => {
  let wiki: string;
  let mountId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-backup-'));
    wiki = join(root, 'projekte', 'wiki');
    mkdirSync(join(wiki, 'docs', 'assets'), { recursive: true });
    writeFileSync(join(wiki, 'docs', 'home.md'), '# Home\n\nErster Stand.\n\n![Bild](assets/bild.png)\n');
    writeFileSync(join(wiki, 'docs', 'assets', 'bild.png'), Buffer.from([1, 2, 3]));
    mkdirSync(join(root, 'backup'));
    const config = (cfg = {
      ...loadConfig({}),
      dataPath: join(root, 'data'),
      configPath: join(root, 'config'),
      localRoots: [join(root, 'projekte')],
      syncIntervalSec: 0,
      commitDelaySec: 0,
      webRoot: join(root, 'no-web'),
      backupRoot: join(root, 'backup'),
    });
    app = await buildApp(config, { logger: false, nightlyFsck: false });
    await app.manager.start();
    const res = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' } });
    cookie = `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
    mountId = (await api<{ id: string }>('POST', '/api/mounts', { type: 'local', source: wiki, name: 'Wiki' })).id;
  });

  afterEach(async () => {
    await app.backups.idle();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('tests a local target, backs up, restores (overwrite, copy) and keeps per plan', async () => {
    const tested = await api<{ ok: boolean; warnings: string[] }>('POST', '/api/backup/targets/test', { kind: 'local', location: 'kaveyl-wiki' });
    expect(tested.ok).toBe(true);
    expect(tested.warnings.join(' ')).toMatch(/kein eingehängter Host-Ordner/);
    await api('POST', '/api/backup/targets/test', { kind: 'local', location: '../etc' }, 400);
    const target = await api<{ id: string; encrypted: boolean }>('POST', '/api/backup/targets', { kind: 'local', location: 'kaveyl-wiki', name: 'Lokal' });
    const plan = await api<{ id: string; nextRun: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], includeDb: true, keep: { daily: 2 }, time: '02:00' });
    expect(plan.nextRun).toBeTruthy();

    // „Jetzt sichern“ runs in the background.
    await api('POST', `/api/backup/plans/${plan.id}/run`, {});
    await app.backups.idle();
    const { runs } = await api<{ runs: { status: string; archives: number }[] }>('GET', '/api/backup/runs');
    expect(runs[0]).toMatchObject({ status: 'ok', archives: 2 });
    const files = await api<{ id: string; mountId: string | null; path: string; encrypted: boolean }[]>('GET', '/api/backup/files');
    expect(files.map((f) => f.path.split('/')[0]).sort()).toEqual(['Wiki', 'kaveyl-wiki-datenbank']);
    const wikiFile = files.find((f) => f.mountId === mountId)!;
    expect(existsSync(join(root, 'backup', 'kaveyl-wiki', wikiFile.path))).toBe(true);
    // Unencrypted target: the database goes without the key.
    const dbFile = files.find((f) => !f.mountId)!;
    const dbZip = await Archive.open(join(root, 'backup', 'kaveyl-wiki', dbFile.path));
    expect(dbZip.entries().map((e) => e.path)).toEqual(['kaveyl-wiki.db']);
    await dbZip.close();

    // Browse and compare.
    const entries = await api<{ path: string }[]>('GET', `/api/backup/files/${wikiFile.id}/entries`);
    expect(entries.map((e) => e.path)).toEqual(['docs/assets/bild.png', 'docs/home.md']);
    expect(await api('GET', `/api/backup/files/${wikiFile.id}/entry?path=docs/home.md`)).toEqual({ text: expect.stringContaining('Erster Stand') });
    // „Datei“ (download) gets the file itself, also a text file.
    const file = await app.server.inject({ method: 'GET', url: `/api/backup/files/${wikiFile.id}/entry?path=docs/home.md&download=1`, headers: { cookie } });
    expect(file.headers['content-disposition']).toBe("attachment; filename*=UTF-8''home.md");
    expect(file.body).toContain('Erster Stand');

    // Overwrite: the note comes back; a deleted attachment it links to as well.
    writeFileSync(join(wiki, 'docs', 'home.md'), '# Home\n\nVerdorben.\n');
    rmSync(join(wiki, 'docs', 'assets', 'bild.png'));
    const over = await api<{ paths: string[] }>('POST', `/api/backup/files/${wikiFile.id}/restore`, { path: 'docs/home.md', mode: 'overwrite' });
    expect(over.paths).toEqual(['docs/home.md', 'docs/assets/bild.png']);
    expect(readFileSync(join(wiki, 'docs', 'home.md'), 'utf8')).toContain('Erster Stand');
    expect(existsSync(join(wiki, 'docs', 'assets', 'bild.png'))).toBe(true);

    // Copy of a note and of the whole source.
    const copy = await api<{ root: string }>('POST', `/api/backup/files/${wikiFile.id}/restore`, { path: 'docs/home.md', mode: 'copy' });
    expect(copy.root).toMatch(/^docs\/home \(Sicherung \d\d\.\d\d\.\d{4}\)\.md$/);
    expect(readFileSync(join(wiki, copy.root), 'utf8')).toContain('Erster Stand');
    const all = await api<{ root: string; paths: string[] }>('POST', `/api/backup/files/${wikiFile.id}/restore`, { path: '', mode: 'copy' });
    expect(all.root).toMatch(/^Sicherung \d\d\.\d\d\.\d{4}$/);
    expect(all.paths).toContain(`${all.root}/docs/home.md`);
    // The database is only for download.
    await api('POST', `/api/backup/files/${dbFile.id}/restore`, { path: '', mode: 'copy' }, 400);

    // Speichern als (AD-039): chosen source, folder and name; the image comes from the archive.
    const other = join(root, 'projekte', 'anderes');
    mkdirSync(other);
    const otherId = (await api<{ id: string }>('POST', '/api/mounts', { type: 'local', source: other, name: 'Anderes' })).id;
    const saved = await api<{ paths: string[]; mountId: string; warnings: string[] }>('POST', `/api/backup/files/${wikiFile.id}/restore`, {
      path: 'docs/home.md',
      mode: 'copy',
      to: { mountId: otherId, path: 'alt/home' },
    });
    expect(saved).toMatchObject({ paths: ['alt/home.md'], mountId: otherId, warnings: [] });
    expect(readFileSync(join(other, 'alt', 'home.md'), 'utf8')).toContain('Erster Stand');
    expect(readFileSync(join(other, 'alt', 'assets', 'bild.png'))).toEqual(Buffer.from([1, 2, 3]));
    await api('POST', `/api/backup/files/${wikiFile.id}/restore`, { path: 'docs/home.md', mode: 'copy', to: { mountId: otherId, path: 'alt/home' } }, 409);
    const folder = await api<{ paths: string[] }>('POST', `/api/backup/files/${wikiFile.id}/restore`, { path: 'docs', mode: 'copy', to: { mountId: otherId, path: 'docs alt' } });
    expect(folder.paths.sort()).toEqual(['docs alt/assets/bild.png', 'docs alt/home.md']);
    await api('POST', `/api/backup/files/${wikiFile.id}/restore`, { path: 'docs', mode: 'copy', to: { mountId: otherId, path: 'docs alt' } }, 409);

    // Two more runs: „täglich, 2 behalten“ keeps the newest of each of the last 2 days – same day → 1.
    for (let i = 0; i < 2; i++) await app.backups.enqueue(plan.id, { trigger: 'manual', mountId });
    const after = (await api<{ mountId: string | null }[]>('GET', `/api/backup/files?mountId=${mountId}`)).length;
    expect(after).toBe(1);
    expect(readdirSync(join(root, 'backup', 'kaveyl-wiki', 'Wiki'))).toHaveLength(1);

    // A target in use cannot go; the plan first.
    await api('DELETE', `/api/backup/targets/${target.id}`, undefined, 400);
    await api('DELETE', `/api/backup/plans/${plan.id}`);
    await api('DELETE', `/api/backup/targets/${target.id}`);
  });

  it('a local folder with versions carries its history; unpacked elsewhere, „Versionen einschalten“ brings it back (AD-071)', async () => {
    const on = await api<{ mount: { options: { autoCommit: boolean } }; restored: boolean }>('POST', `/api/mounts/${mountId}/versions`, {});
    expect(on).toMatchObject({ mount: { options: { autoCommit: true } }, restored: false });
    const note = await api<{ raw: string; hash: string }>('GET', `/api/notes/${mountId}/docs/home.md`);
    await api('PUT', `/api/notes/${mountId}/docs/home.md`, { raw: note.raw.replace('Erster Stand.', 'Zweiter Stand.'), baseHash: note.hash });
    await api('POST', `/api/mounts/${mountId}/commit-now`, {});
    const log = (dir: string) => execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    const backedUp = log(wiki);
    expect(backedUp).toHaveLength(2);

    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'kaveyl-wiki', name: 'Lokal' });
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], includeDb: false, keep: { daily: 2 }, time: '02:00' });
    await api('POST', `/api/backup/plans/${plan.id}/run`, {});
    await app.backups.idle();
    const file = (await api<{ id: string; mountId: string | null; path: string }[]>('GET', '/api/backup/files')).find((f) => f.mountId === mountId)!;
    const zip = await Archive.open(join(root, 'backup', 'kaveyl-wiki', file.path));
    expect(zip.entries().map((e) => e.path)).toContain('.kaveyl-wiki-history.bundle');
    // Not a file to pick, and a whole-source restore leaves it out.
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${file.id}/entries`)).map((e) => e.path)).toEqual(['docs/assets/bild.png', 'docs/home.md']);
    const all = await api<{ paths: string[] }>('POST', `/api/backup/files/${file.id}/restore`, { path: '', mode: 'copy' });
    expect(all.paths.some((p) => p.includes('history.bundle'))).toBe(false);

    // A new server: the ZIP unpacked into a new folder, one note changed since; mounted with versions.
    const fresh = join(root, 'projekte', 'neu');
    for (const e of zip.entries()) {
      mkdirSync(join(fresh, e.path, '..'), { recursive: true });
      writeFileSync(join(fresh, e.path), await zip.read(e.path));
    }
    await zip.close();
    writeFileSync(join(fresh, 'docs', 'home.md'), '# Home\n\nDritter Stand.\n');
    const back = await api<{ id: string; options: { autoCommit: boolean } }>('POST', '/api/mounts', { type: 'local', source: fresh, name: 'Neu', versions: true });
    expect(back.options.autoCommit).toBe(true);
    expect(log(fresh)).toEqual(['docs: Versionen aus der Sicherung übernommen (Kaveyl Wiki)', ...backedUp]);
    expect(existsSync(join(fresh, '.kaveyl-wiki-history.bundle'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: fresh, encoding: 'utf8' })).toBe('');
    const { versions } = await api<{ versions: { commit: string }[] }>('GET', `/api/history/${back.id}/docs/home.md`);
    expect(versions).toHaveLength(3);

    // New server with the database from before: the source is known with versions on; unpacking the ZIP is enough –
    // at the start the folder gets its Git back by itself.
    rmSync(join(fresh, '.git'), { recursive: true, force: true });
    const again = await Archive.open(join(root, 'backup', 'kaveyl-wiki', file.path));
    writeFileSync(join(fresh, '.kaveyl-wiki-history.bundle'), await again.read('.kaveyl-wiki-history.bundle'));
    await again.close();
    await app.close();
    app = await buildApp(cfg, { logger: false, nightlyFsck: false });
    await app.manager.start();
    expect(log(fresh).slice(1)).toEqual(backedUp);
    expect(existsSync(join(fresh, '.kaveyl-wiki-history.bundle'))).toBe(false);
  });

  it('encrypts with the backup password, adds the key, and keeps old archives readable after a password change', async () => {
    const target = await api<{ id: string; encrypted: boolean }>('POST', '/api/backup/targets', { kind: 'local', location: '', archivePassword: 'Erstes-Passwort-1' });
    expect(target.encrypted).toBe(true);
    expect(JSON.stringify(await api('GET', '/api/backup/targets'))).not.toContain('Erstes-Passwort');
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: ['*'], includeDb: true, keep: { weekly: 4 } });
    await app.backups.enqueue(plan.id, { trigger: 'manual' });
    const files = await api<{ id: string; mountId: string | null; path: string; encrypted: boolean }[]>('GET', '/api/backup/files');
    expect(files.every((f) => f.encrypted)).toBe(true);
    const dbFile = files.find((f) => !f.mountId)!;
    const z = await Archive.open(join(root, 'backup', dbFile.path), 'Erstes-Passwort-1');
    expect(z.entries().map((e) => e.path)).toEqual(['kaveyl-wiki.db', 'secret.key']);
    await z.close();
    await api('PUT', `/api/backup/targets/${target.id}`, { archivePassword: 'Zweites-Passwort-2' });
    const wikiFile = files.find((f) => f.mountId === mountId)!;
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${wikiFile.id}/entries`)).length).toBe(2);
    await api('PUT', `/api/backup/targets/${target.id}`, { archivePassword: 'kurz' }, 400);
  });

  it('runs a due plan once per slot and only when a rhythm is chosen', async () => {
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'x' });
    await api('POST', '/api/backup/plans', { targetId: target.id, keep: {} }, 400);
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], keep: { daily: 3 }, time: '02:00' });
    // Created now → the first run is the next slot, not right away.
    expect(await app.backups.tick()).toEqual([]);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(2, 5, 0, 0);
    expect(await app.backups.tick(tomorrow)).toEqual([plan.id]);
    expect(await app.backups.tick(tomorrow)).toEqual([]);
    await app.backups.idle();
    expect((await api<{ runs: { trigger: string; status: string }[] }>('GET', '/api/backup/runs')).runs[0]).toMatchObject({ trigger: 'plan', status: 'ok' });
  });

  it('reports a failing run in the log', async () => {
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'weg' });
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], keep: { daily: 1 } });
    rmSync(wiki, { recursive: true, force: true });
    const run = await app.backups.enqueue(plan.id, { trigger: 'manual' });
    expect(run.status).toBe('error');
    expect(run.message).toMatch(/Wiki/);
  });

  it('ends a planned run as failed when even its temporary folder cannot be made', async () => {
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'x' });
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], keep: { daily: 3 }, time: '02:00' });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(2, 5, 0, 0);
    const saved = process.env.TMPDIR;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    process.env.TMPDIR = join(root, 'fehlt'); // mkdtemp fails like on a full disk
    try {
      expect(await app.backups.tick(tomorrow)).toEqual([plan.id]);
      await app.backups.idle();
      await new Promise((r) => setImmediate(r));
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    const { runs } = await api<{ runs: { trigger: string; status: string; message: string }[] }>('GET', '/api/backup/runs');
    expect(runs[0]).toMatchObject({ trigger: 'plan', status: 'error', message: expect.stringMatching(/ENOENT/) });
  });

  it('deletes a target with its plan in one step, then finds the archives again when it is added again (AD-075)', async () => {
    const target = await api<{ id: string; scan: { added: number } }>('POST', '/api/backup/targets', { kind: 'local', location: 'nas', name: 'NAS' });
    expect(target.scan).toEqual({ added: 0, found: 0, unmatched: [] });
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: ['*'], includeDb: true, keep: { daily: 3 } });
    await app.backups.enqueue(plan.id, { trigger: 'manual' });
    const before = await api<{ mountId: string | null; path: string; createdAt: string; size: number }[]>('GET', '/api/backup/files');
    expect(before).toHaveLength(2);
    // An archive of a source that is no longer there, and things that are no archive of Kaveyl Wiki.
    mkdirSync(join(root, 'backup', 'nas', 'Altes Wiki'));
    writeFileSync(join(root, 'backup', 'nas', 'Altes Wiki', 'Altes Wiki_2026-09-01_020000.zip'), await zipBuffer({ 'a.md': '# A\n' }));
    writeFileSync(join(root, 'backup', 'nas', 'Altes Wiki', 'notizen.zip'), 'x');
    writeFileSync(join(root, 'backup', 'nas', 'lose.zip'), 'x');

    await api('DELETE', `/api/backup/targets/${target.id}`, undefined, 400);
    await api('DELETE', `/api/backup/targets/${target.id}?plans=1`);
    expect(await api('GET', '/api/backup/plans')).toEqual([]);
    expect(await api('GET', '/api/backup/files')).toEqual([]);

    // The same target again: the archives are found, each with its source, the database and the folder without one.
    const again = await api<{ id: string; scan: { added: number; found: number; unmatched: string[] } }>('POST', '/api/backup/targets', { kind: 'local', location: 'nas', name: 'NAS' });
    expect(again.scan).toEqual({ added: 3, found: 3, unmatched: ['Altes Wiki'] });
    const found = await api<{ id: string; mountId: string | null; label: string; path: string; createdAt: string; size: number; planId: string | null }[]>('GET', '/api/backup/files');
    for (const b of before) expect(found).toContainEqual(expect.objectContaining({ mountId: b.mountId, path: b.path, size: b.size, planId: null }));
    const wiki = found.find((f) => f.mountId === mountId)!;
    expect(Math.abs(Date.parse(wiki.createdAt) - Date.parse(before.find((b) => b.mountId === mountId)!.createdAt))).toBeLessThan(1000);
    const orphan = found.find((f) => f.label === 'Altes Wiki')!;
    expect(orphan.mountId).toBe('ordner:Altes Wiki');
    // Found again: nothing new.
    expect(await api('POST', `/api/backup/targets/${again.id}/scan`, {})).toEqual({ added: 0, found: 3, unmatched: ['Altes Wiki'] });

    // Without its source: open and „Speichern als“ into another one; overwriting has no place to go.
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${orphan.id}/entries`)).map((e) => e.path)).toEqual(['a.md']);
    await api('POST', `/api/backup/files/${orphan.id}/restore`, { path: '', mode: 'overwrite' }, 400);
    const copy = await api<{ paths: string[] }>('POST', `/api/backup/files/${orphan.id}/restore`, { path: '', mode: 'copy', to: { mountId, path: 'Altes Wiki' } });
    expect(copy.paths).toEqual(['Altes Wiki/a.md']);
    // A source of that name added later: the next search gives it its archives.
    const old = join(root, 'projekte', 'altes');
    mkdirSync(old);
    const oldId = (await api<{ id: string }>('POST', '/api/mounts', { type: 'local', source: old, name: 'Altes Wiki' })).id;
    expect(await api('POST', `/api/backup/targets/${again.id}/scan`, {})).toEqual({ added: 0, found: 3, unmatched: [] });
    expect((await api<{ id: string }[]>('GET', `/api/backup/files?mountId=${oldId}`)).map((f) => f.id)).toEqual([orphan.id]);
    // A found archive belongs to no plan: a new plan's runs never delete it.
    const plan2 = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: again.id, sources: [mountId], keep: { daily: 1 } });
    await app.backups.enqueue(plan2.id, { trigger: 'manual' });
    expect(await api<unknown[]>('GET', `/api/backup/files?mountId=${mountId}`)).toHaveLength(2);
  });

  it('asks for the backup password of an archive the target does not open (AD-075)', async () => {
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'enc', archivePassword: 'Altes-Passwort-1' });
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], keep: { daily: 3 } });
    await app.backups.enqueue(plan.id, { trigger: 'manual' });
    await api('DELETE', `/api/backup/targets/${target.id}?plans=1`);
    // Added again without the password: listed, but it does not open.
    const again = await api<{ id: string; scan: { added: number } }>('POST', '/api/backup/targets', { kind: 'local', location: 'enc' });
    expect(again.scan.added).toBe(1);
    const [file] = await api<{ id: string; encrypted: boolean }[]>('GET', '/api/backup/files');
    expect(file!.encrypted).toBe(false);
    const res = await app.server.inject({ method: 'GET', url: `/api/backup/files/${file!.id}/entries`, headers: { cookie } });
    expect([res.statusCode, res.json().error, res.json().code]).toEqual([400, expect.stringMatching(/verschlüsselt/), 'backup-password']);
    await api('POST', `/api/backup/files/${file!.id}/password`, { password: 'Falsches-Passwort' }, 400);
    expect(await api('POST', `/api/backup/files/${file!.id}/password`, { password: 'Altes-Passwort-1' })).toEqual({ updated: 1 });
    expect((await api<{ id: string; encrypted: boolean }[]>('GET', '/api/backup/files'))[0]!.encrypted).toBe(true);
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${file!.id}/entries`)).map((e) => e.path)).toEqual(['docs/assets/bild.png', 'docs/home.md']);
    // The password stays only as long as the archive is listed.
    await api('DELETE', `/api/backup/files/${file!.id}`);
    expect((app.db.prepare('SELECT count(*) n FROM secrets').get() as { n: number }).n).toBe(0);
  });

  it('a password typed for one found archive does not lock out another one with a different password (code-002 0.2.7)', async () => {
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'zwei' });
    mkdirSync(join(root, 'backup', 'zwei', 'Wiki'), { recursive: true });
    writeFileSync(join(root, 'backup', 'zwei', 'Wiki', 'Wiki_2026-09-01_020000.zip'), await zipBuffer({ 'a.md': '# A\n' }, 'Passwort-Eins-1'));
    writeFileSync(join(root, 'backup', 'zwei', 'Wiki', 'Wiki_2026-09-02_020000.zip'), await zipBuffer({ 'b.md': '# B\n' }, 'Passwort-Zwei-2'));
    expect((await api<{ added: number }>('POST', `/api/backup/targets/${target.id}/scan`, {})).added).toBe(2);
    const files = await api<{ id: string; path: string }[]>('GET', '/api/backup/files');
    const one = files.find((f) => f.path.endsWith('09-01_020000.zip'))!;
    const two = files.find((f) => f.path.endsWith('09-02_020000.zip'))!;
    expect(await api('POST', `/api/backup/files/${one.id}/password`, { password: 'Passwort-Eins-1' })).toEqual({ updated: 1 });
    expect(await api('POST', `/api/backup/files/${two.id}/password`, { password: 'Passwort-Zwei-2' })).toEqual({ updated: 1 });
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${one.id}/entries`)).map((e) => e.path)).toEqual(['a.md']);
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${two.id}/entries`)).map((e) => e.path)).toEqual(['b.md']);
  });

  it('refuses an unencrypted or partly encrypted archive on an encrypted target unless the admin opens it on purpose (sec-002 0.2.7)', async () => {
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'enc2', archivePassword: 'Ziel-Passwort-1' });
    mkdirSync(join(root, 'backup', 'enc2', 'Wiki'), { recursive: true });
    // Planted (or from before the password): one plain archive, one with an encrypted and a plain file.
    writeFileSync(join(root, 'backup', 'enc2', 'Wiki', 'Wiki_2026-09-01_020000.zip'), await zipBuffer({ 'docs/home.md': '# Untergeschoben\n' }));
    const mixed = await zipBuffer({ 'docs/home.md': '# Echt\n' }, 'Ziel-Passwort-1');
    writeFileSync(join(root, 'backup', 'enc2', 'Wiki', 'Wiki_2026-09-02_020000.zip'), mixed);
    expect((await api<{ added: number }>('POST', `/api/backup/targets/${target.id}/scan`, {})).added).toBe(2);
    const files = await api<{ id: string; path: string }[]>('GET', '/api/backup/files');
    const plain = files.find((f) => f.path.endsWith('09-01_020000.zip'))!;
    const res = await app.server.inject({ method: 'GET', url: `/api/backup/files/${plain.id}/entries`, headers: { cookie } });
    expect([res.statusCode, res.json().code]).toEqual([400, 'backup-unencrypted']);
    await api('POST', `/api/backup/files/${plain.id}/restore`, { path: '', mode: 'overwrite' }, 400);
    expect(readFileSync(join(wiki, 'docs', 'home.md'), 'utf8')).toContain('Erster Stand');
    // The admin's decision: opened without a password from now on.
    expect(await api('POST', `/api/backup/files/${plain.id}/password`, { none: true })).toEqual({ updated: 1 });
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${plain.id}/entries`)).map((e) => e.path)).toEqual(['docs/home.md']);
    // The encrypted one opens with the target's password as before.
    const enc = files.find((f) => f.path.endsWith('09-02_020000.zip'))!;
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${enc.id}/entries`)).map((e) => e.path)).toEqual(['docs/home.md']);
  });

  it('brings a whole source back over its old place – a local folder with versions also gets its history (AD-075)', async () => {
    await api('POST', `/api/mounts/${mountId}/versions`, {});
    const note = await api<{ raw: string; hash: string }>('GET', `/api/notes/${mountId}/docs/home.md`);
    await api('PUT', `/api/notes/${mountId}/docs/home.md`, { raw: note.raw.replace('Erster Stand.', 'Zweiter Stand.'), baseHash: note.hash });
    await api('POST', `/api/mounts/${mountId}/commit-now`, {});
    const log = (dir: string) => execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    const backedUp = log(wiki);
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'x' });
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], keep: { daily: 3 } });
    await app.backups.enqueue(plan.id, { trigger: 'manual' });
    const [file] = await api<{ id: string }[]>('GET', '/api/backup/files');

    // A new server with the database from before: the folder is gone (the source says „Ordner nicht gefunden“).
    await app.close();
    rmSync(wiki, { recursive: true, force: true });
    app = await buildApp(cfg, { logger: false, nightlyFsck: false });
    await app.manager.start();
    expect((await api<{ id: string; syncStatus: string }[]>('GET', '/api/mounts')).find((m) => m.id === mountId)!.syncStatus).toBe('error');
    const back = await api<{ paths: string[]; history: boolean }>('POST', `/api/backup/files/${file!.id}/restore`, { path: '', mode: 'overwrite' });
    expect(back.paths.sort()).toEqual(['docs/assets/bild.png', 'docs/home.md']);
    expect(back.history).toBe(true);
    expect(readFileSync(join(wiki, 'docs', 'home.md'), 'utf8')).toContain('Zweiter Stand');
    expect(log(wiki).slice(-backedUp.length)).toEqual(backedUp);
    expect(existsSync(join(wiki, '.kaveyl-wiki-history.bundle'))).toBe(false);
    expect((await api<{ id: string; syncStatus: string }[]>('GET', '/api/mounts')).find((m) => m.id === mountId)!.syncStatus).toBe('ok');
    expect((await api<{ versions: unknown[] }>('GET', `/api/history/${mountId}/docs/home.md`)).versions.length).toBeGreaterThanOrEqual(2);
    // Again over a folder that has its versions: the files come back as a new version, the history stays as it is.
    const n = log(wiki).length;
    const again = await api<{ history: boolean }>('POST', `/api/backup/files/${file!.id}/restore`, { path: '', mode: 'overwrite' });
    expect(again.history).toBe(false);
    await api('POST', `/api/mounts/${mountId}/commit-now`, {});
    expect(log(wiki).length).toBe(n);
  });

  it('takes the history over without following a link lying in the folder (sec-003 0.2.7)', async () => {
    await api('POST', `/api/mounts/${mountId}/versions`, {});
    const target = await api<{ id: string }>('POST', '/api/backup/targets', { kind: 'local', location: 'y' });
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, sources: [mountId], keep: { daily: 3 } });
    await app.backups.enqueue(plan.id, { trigger: 'manual' });
    const [file] = await api<{ id: string }[]>('GET', '/api/backup/files');
    // Someone who may write in the folder removes its Git and lays a link where the history will go.
    const victim = join(root, 'opfer.txt');
    writeFileSync(victim, 'unverändert');
    rmSync(join(wiki, '.git'), { recursive: true, force: true });
    symlinkSync(victim, join(wiki, '.kaveyl-wiki-history.bundle'));
    const back = await api<{ history: boolean }>('POST', `/api/backup/files/${file!.id}/restore`, { path: '', mode: 'overwrite' });
    expect(back.history).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('unverändert');
    expect(existsSync(join(wiki, '.git'))).toBe(true);
  });

  it('is for admins only', async () => {
    await api('POST', '/api/admin/users', { email: 'bob@example.test', username: 'bob', password: 'Start-Passwort-0001' });
    const login = await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'bob@example.test', password: 'Start-Passwort-0001' } });
    const bob = `kw_session=${login.cookies.find((c) => c.name === 'kw_session')!.value}`;
    expect((await app.server.inject({ method: 'GET', url: '/api/backup/targets', headers: { cookie: bob } })).statusCode).toBe(403);
  });
});

// SMB against the Samba test container (scripts/smb-test.sh up); skipped when it is not running.
const smbUp = (() => {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'kaveyl-wiki-smbtest'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
})();

describe.skipIf(!smbUp)('backups to SMB (Samba test container)', () => {
  beforeEach(async () => {
    process.env.SMBCLIENT = join(__dirname, '..', '..', '..', '..', 'e2e', 'smb', 'smbclient');
    root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-backup-smb-'));
    const wiki = join(root, 'projekte', 'wiki');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, 'a.md'), '# A\n');
    const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web'), backupRoot: null };
    app = await buildApp(config, { logger: false, nightlyFsck: false });
    await app.manager.start();
    const res = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' } });
    cookie = `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
    await api('POST', '/api/mounts', { type: 'local', source: wiki, name: 'Wiki' });
  });

  afterEach(async () => {
    await app.backups.idle();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.SMBCLIENT;
  });

  it('tests the share with clear errors, backs up, browses and deletes', async () => {
    const base = { kind: 'smb', location: `\\\\localhost\\backup\\unit-${Date.now()}`, username: 'kwtest' };
    expect((await app.server.inject({ method: 'POST', url: '/api/backup/targets/test', ...json({ ...base, password: 'falsch' }) })).json()).toEqual({ error: expect.stringMatching(/Passwort stimmt nicht/) });
    expect((await app.server.inject({ method: 'POST', url: '/api/backup/targets/test', ...json({ ...base, location: '//localhost/gibtsnicht', password: 'kwtest-Pass1' }) })).json()).toEqual({
      error: expect.stringMatching(/Freigabe „gibtsnicht“/),
    });
    const ok = await api<{ ok: boolean; free: number }>('POST', '/api/backup/targets/test', { ...base, password: 'kwtest-Pass1' });
    expect(ok.ok).toBe(true);
    expect(ok.free).toBeGreaterThan(0);
    const target = await api<{ id: string; passwordSet: boolean }>('POST', '/api/backup/targets', { ...base, password: 'kwtest-Pass1', archivePassword: 'Backup-Passwort-1' });
    expect(target.passwordSet).toBe(true);
    expect(JSON.stringify(await api('GET', '/api/backup/targets'))).not.toContain('kwtest-Pass1');
    // A test of the saved target without retyping the password uses the stored one.
    expect((await api<{ ok: boolean }>('POST', '/api/backup/targets/test', { ...base, id: target.id })).ok).toBe(true);
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, keep: { daily: 1 } });
    const run = await app.backups.enqueue(plan.id, { trigger: 'manual' });
    expect(run).toMatchObject({ status: 'ok', archives: 1 });
    const [file] = await api<{ id: string }[]>('GET', '/api/backup/files');
    expect((await api<{ path: string }[]>('GET', `/api/backup/files/${file!.id}/entries`)).map((e) => e.path)).toEqual(['a.md']);
    const dl = await app.server.inject({ method: 'GET', url: `/api/backup/files/${file!.id}/download`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe('PK');
    await api('DELETE', `/api/backup/files/${file!.id}`);
    expect(await api('GET', '/api/backup/files')).toEqual([]);
  });

  it('finds the archives on a share again and deletes one that is already gone there (AD-075)', async () => {
    const location = `\\\\localhost\\backup\\scan-${Date.now()}`;
    const base = { kind: 'smb', location, username: 'kwtest', password: 'kwtest-Pass1' };
    const target = await api<{ id: string }>('POST', '/api/backup/targets', base);
    const plan = await api<{ id: string }>('POST', '/api/backup/plans', { targetId: target.id, includeDb: true, keep: { daily: 3 } });
    expect(await app.backups.enqueue(plan.id, { trigger: 'manual' })).toMatchObject({ status: 'ok', archives: 2 });
    const before = (await api<{ path: string }[]>('GET', '/api/backup/files')).map((f) => f.path).sort();
    await api('DELETE', `/api/backup/targets/${target.id}?plans=1`);
    const again = await api<{ id: string; scan: { added: number; found: number; unmatched: string[] } }>('POST', '/api/backup/targets', base);
    expect(again.scan).toEqual({ added: 2, found: 2, unmatched: [] });
    const files = await api<{ id: string; path: string; mountId: string | null }[]>('GET', '/api/backup/files');
    expect(files.map((f) => f.path).sort()).toEqual(before);
    // Deleted by hand on the share: deleting it in the list still works.
    const wiki = files.find((f) => f.mountId)!;
    execFileSync(process.env.SMBCLIENT!, ['//localhost/backup', '-U', 'kwtest', '-c', `del "${location.split('\\').pop()}/${wiki.path}"`], { env: { ...process.env, PASSWD: 'kwtest-Pass1' } });
    await api('DELETE', `/api/backup/files/${wiki.id}`);
    expect(await api<unknown[]>('GET', '/api/backup/files')).toHaveLength(1);
  });
});
