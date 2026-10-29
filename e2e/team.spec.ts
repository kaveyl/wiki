// Two people on the same notes (team test 23.10., scenarios b0, b1, b2, b7 – before only against a throwaway instance):
// a foreign save while the cursor stands in the editor, typing at the same moment, moving, renaming and deleting a
// note someone has open. Own source „Team“ (local folder) and two accounts; both are removed at the end.
// Soft lock and presence: phase4 („presence …“); „Zusammenführen“: phase3.
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test.describe.configure({ mode: 'serial' });

const TEAM_DIR = resolve(import.meta.dirname, '../.local/e2e/projekte/team');
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

type Person = { id: string; name: string; ctx: BrowserContext; api: APIRequestContext };
let admin: BrowserContext;
let mountId: string;
let lena: Person;
let paul: Person;

async function account(browser: Browser, key: string, name: string): Promise<Person> {
  const r = await admin.request.post('/api/admin/users', { data: { email: `${key}@example.test`, displayName: name, password: 'Start-Passwort-0001' } });
  expect(r.ok()).toBe(true);
  const { id } = (await r.json()) as { id: string };
  const ctx = await browser.newContext({ locale: 'de-DE', viewport: { width: 1360, height: 860 } });
  await ctx.request.post('/api/login', { data: { email: `${key}@example.test`, password: 'Start-Passwort-0001' } });
  await ctx.request.post('/api/account/password', { data: { current: 'Start-Passwort-0001', next: `${name.replace(' ', '-')}-Passwort-0001` } });
  await ctx.request.post('/api/login', { data: { email: `${key}@example.test`, password: `${name.replace(' ', '-')}-Passwort-0001` } });
  expect((await admin.request.post(`/api/acl/${mountId}`, { data: { target: 'mount', subject: 'user', subjectId: id, level: 'write' } })).ok()).toBe(true);
  return { id, name, ctx, api: ctx.request };
}

/** A new note in the team source, written by Paul. */
async function note(title: string, body: string): Promise<string> {
  const r = await paul.api.post(`/api/notes/${mountId}`, { data: { parent: '', title, body } });
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { path: string }).path;
}
async function read(path: string, who = paul) {
  const r = await who.api.get(`/api/notes/${mountId}/${enc(path)}`);
  return r.ok() ? ((await r.json()) as { raw: string; hash: string }) : null;
}
/** Paul saves through the app's API – like a second browser, without its editor in the way. */
async function paulSaves(path: string, change: (raw: string) => string) {
  const cur = (await read(path))!;
  const r = await paul.api.put(`/api/notes/${mountId}/${enc(path)}`, { data: { raw: change(cur.raw), baseHash: cur.hash } });
  expect(r.ok()).toBe(true);
}
async function openNote(who: Person, path: string): Promise<Page> {
  const page = who.ctx.pages()[0] ?? (await who.ctx.newPage());
  await page.goto(`/n/${mountId}/${enc(path)}`);
  await expect(editor(page)).toBeVisible();
  return page;
}
const editor = (page: Page) => page.locator('.prose-note').filter({ visible: true });
async function typeAtEnd(page: Page, text: string) {
  await editor(page).locator('p').last().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(TEAM_DIR, { recursive: true });
  admin = await browser.newContext();
  await admin.request.post('/api/login', { data: { email: 'e2e@example.test', password: 'E2E-Passwort-12345' } });
  const m = await admin.request.post('/api/mounts', { data: { type: 'local', source: TEAM_DIR, name: 'Team', versions: true } });
  expect(m.ok()).toBe(true);
  mountId = ((await m.json()) as { id: string }).id;
  lena = await account(browser, 'lena', 'Lena Lang');
  paul = await account(browser, 'paul', 'Paul Probst');
});

test.afterAll(async () => {
  for (const p of [lena, paul]) {
    await p?.ctx.close();
    if (p) await admin.request.delete(`/api/admin/users/${p.id}`, { data: {} });
  }
  if (mountId) await admin.request.delete(`/api/mounts/${mountId}`, { data: {} });
  await admin.close();
});

test('a save by someone else while the cursor stands in the editor: focus stays, the next key lands where it was', async () => {
  const P = await note('Fokus', '# Fokus\n\nErster Absatz.\n\nZweiter Absatz.\n');
  const page = await openNote(lena, P);
  await editor(page).getByText('Erster Absatz.').click();
  await page.keyboard.press('End');
  await expect(editor(page)).toBeFocused();
  await paulSaves(P, (raw) => raw + '\nVon Paul.\n');
  await expect(editor(page)).toContainText('Von Paul', { timeout: 10_000 });
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('X');
  await expect.poll(async () => (await read(P))!.raw, { timeout: 10_000 }).toContain('Erster Absatz.X');
  // Text inserted above the cursor: the next key still lands after „Absatz.X“.
  await paulSaves(P, (raw) => raw.replace('# Fokus\n', '# Fokus\n\nNeu oben von Paul.\n'));
  await expect(editor(page)).toContainText('Neu oben von Paul', { timeout: 10_000 });
  await page.keyboard.type('Y');
  await expect.poll(async () => (await read(P))!.raw, { timeout: 10_000 }).toContain('Erster Absatz.XY');
  const raw = (await read(P))!.raw;
  expect(raw).toContain('Neu oben von Paul.');
  expect(raw).toContain('Von Paul.');
});

test('two people type at the same moment: asked both ways, one gets the notice, „Meine Version speichern“ reaches the other live', async () => {
  const P = await note('Gemeinsam', '# Gemeinsam\n\nErster Absatz.\n');
  const l = await openNote(lena, P);
  const p = await openNote(paul, P);
  await typeAtEnd(l, ' Lena1');
  await expect(p.getByRole('status').filter({ hasText: 'Lena Lang bearbeitet gerade' })).toBeVisible({ timeout: 10_000 });
  await expect(editor(p)).toContainText('Lena1', { timeout: 10_000 });
  // Paul starts typing: asked once, „Trotzdem bearbeiten“ puts the cursor back and his text reaches Lena.
  await typeAtEnd(p, 'P');
  const askP = p.getByRole('alertdialog');
  await expect(askP).toContainText('Lena Lang bearbeitet diese Notiz gerade');
  await askP.getByRole('button', { name: 'Trotzdem bearbeiten' }).click();
  await expect(askP).toHaveCount(0);
  await expect(editor(p)).toBeFocused();
  await p.keyboard.type('aul1');
  await expect(editor(l)).toContainText('Paul1', { timeout: 10_000 });
  await expect.poll(async () => (await read(P))!.raw, { timeout: 10_000 }).toContain('Lena1Paul1');
  // Now Lena is asked – Paul is editing.
  await typeAtEnd(l, ' ');
  const askL = l.getByRole('alertdialog');
  await expect(askL).toContainText('Paul Probst bearbeitet diese Notiz gerade');
  await askL.getByRole('button', { name: 'Trotzdem bearbeiten' }).click();
  await expect(askL).toHaveCount(0);
  await expect(editor(l)).toBeFocused();
  // Both at once: one of them saved, the other gets the notice – nothing is overwritten silently.
  await Promise.all([l.keyboard.type('Lena2'), typeAtEnd(p, ' Paul2')]);
  const notice = (page: Page) => page.getByRole('alert').filter({ hasText: 'außerhalb geändert' });
  await expect.poll(async () => (await notice(l).isVisible()) || (await notice(p).isVisible()), { timeout: 15_000 }).toBe(true);
  const [loser, other, mine] = (await notice(l).isVisible()) ? [l, p, 'Lena2'] : [p, l, 'Paul2'];
  await loser.getByRole('button', { name: 'Unterschiede ansehen' }).click();
  const diff = loser.getByRole('dialog', { name: 'Unterschiede zur fremden Version' });
  await expect(diff).toContainText(mine);
  await diff.getByRole('button', { name: 'Schließen', exact: true }).last().click();
  await loser.getByRole('button', { name: 'Meine Version speichern' }).click();
  await expect.poll(async () => (await read(P))!.raw, { timeout: 10_000 }).toContain(mine);
  await expect(editor(other)).toContainText(mine, { timeout: 10_000 });
  await expect(notice(loser)).toHaveCount(0);
  await p.close();
});

test('moved while open: the tab follows, typing goes on at the new place, links to it are repaired', async () => {
  const P = await note('Umzug', '# Umzug\n\nInhalt.\n');
  const ref = await note('Verweis', '# Verweis\n\n[Zum Umzug](Umzug.md)\n');
  const page = await openNote(lena, P);
  expect((await paul.api.post(`/api/notes/${mountId}/move`, { data: { from: P, to: 'Archiv/Umzug alt.md' } })).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Pfad der Notiz' })).toContainText('Archiv/Umzug alt', { timeout: 10_000 });
  await expect(page.getByRole('alert').filter({ hasText: 'gelöscht oder verschoben' })).toHaveCount(0);
  await typeAtEnd(page, ' Lena nach Umzug');
  await expect.poll(async () => (await read('Archiv/Umzug alt.md'))?.raw, { timeout: 10_000 }).toContain('Lena nach Umzug');
  expect(await read(P)).toBeNull();
  expect((await read(ref))!.raw).toContain('Archiv/Umzug%20alt.md');
});

test('renamed while someone types: the unsaved text lands in the renamed note, the old one does not come back', async () => {
  const P = await note('Tippen', '# Tippen\n\nInhalt.\n');
  const page = await openNote(lena, P);
  await typeAtEnd(page, ' Ungespeichert');
  expect((await paul.api.post(`/api/notes/${mountId}/move`, { data: { from: P, to: 'Tippen umbenannt.md' } })).ok()).toBe(true);
  await expect.poll(async () => (await read('Tippen umbenannt.md'))?.raw, { timeout: 10_000 }).toContain('Ungespeichert');
  await page.waitForTimeout(1500);
  expect(await read(P)).toBeNull();
  await expect(page.getByRole('button', { name: 'Pfad der Notiz' })).toContainText('Tippen umbenannt');
});

test('deleted while open: shown at once; „Als neue Notiz speichern …“ keeps what was typed afterwards', async () => {
  const P = await note('Löschfall', '# Löschfall\n\nWichtiger Inhalt.\n');
  const page = await openNote(lena, P);
  expect((await paul.api.delete(`/api/notes/${mountId}/${enc(P)}`, { data: {} })).ok()).toBe(true);
  const gone = page.getByRole('alert').filter({ hasText: 'gelöscht oder verschoben' });
  await expect(gone).toBeVisible({ timeout: 15_000 });
  await typeAtEnd(page, ' Nach dem Löschen getippt');
  await page.waitForTimeout(1500);
  expect(await read(P)).toBeNull();
  await gone.getByRole('button', { name: 'Als neue Notiz speichern …' }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect.poll(async () => (await read(P))?.raw, { timeout: 10_000 }).toContain('Nach dem Löschen getippt');
  expect((await read(P))!.raw).toContain('Wichtiger Inhalt.');
});

test('the versions name who wrote what – saves in the app never pass for changes from outside', async () => {
  expect((await admin.request.post(`/api/mounts/${mountId}/commit-now`, { data: {} })).ok()).toBe(true);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: TEAM_DIR, encoding: 'utf8' }).trim();
  await expect.poll(() => git('status', '--porcelain'), { timeout: 10_000 }).toBe('');
  const versions = async (path: string) => {
    const r = await admin.request.get(`/api/history/${mountId}/${enc(path)}`);
    return ((await r.json()) as { versions: { author: string; coAuthors?: string[] }[] }).versions;
  };
  const authors = (v: { author: string; coAuthors?: string[] }[]) => new Set(v.flatMap((x) => [x.author, ...(x.coAuthors ?? [])]));
  // Created and moved by Paul, typed into by Lena after the move.
  expect(authors(await versions('Archiv/Umzug alt.md'))).toEqual(new Set(['Paul Probst', 'Lena Lang']));
  expect(authors(await versions('Gemeinsam.md'))).toEqual(new Set(['Paul Probst', 'Lena Lang']));
  expect(git('log', '--format=%s')).not.toContain('außerhalb von Kaveyl Wiki');
  expect(git('log', '--format=%an')).not.toContain('Kaveyl Wiki');
});
