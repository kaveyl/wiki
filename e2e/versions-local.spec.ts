// Local folders with versions (AD-071): „Neuer Ordner …“ in the wizard, an empty folder taken as a whole, „Versionen
// führen“ on by default, versions of a note; „Versionen einschalten …“ for a folder mounted without; changes from
// outside become versions as well. Own folders below projekte/, both sources are removed at the end.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shot } from './shots';

test.describe.configure({ mode: 'serial' });

const PROJECTS = resolve(import.meta.dirname, '../.local/e2e/projekte');
const PLAIN = resolve(PROJECTS, 'ohne-versionen');
const log = (dir: string) => execFileSync('git', ['log', '--format=%an|%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');

let ctx: BrowserContext;
let page: Page;
const mounts: string[] = [];

test.beforeAll(async ({ browser }) => {
  mkdirSync(PLAIN, { recursive: true });
  writeFileSync(resolve(PLAIN, 'alt.md'), '# Alt\n\nVorher da.\n');
  ctx = await browser.newContext({ locale: 'de-DE' });
  await ctx.request.post('/api/login', { data: { email: 'e2e@example.test', password: 'E2E-Passwort-12345' } });
  page = await ctx.newPage();
});

test.afterAll(async () => {
  for (const id of mounts) await ctx.request.delete(`/api/mounts/${id}`, { data: {} });
  await ctx.close();
});

test('a new folder from the wizard, mounted with versions: every save becomes a version', async () => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: 'Quelle einbinden' }).click();
  await page.getByRole('button', { name: 'Lokaler Ordner' }).click();
  await page.getByRole('button', { name: /projekte/ }).click();
  await page.getByRole('button', { name: 'Neuer Ordner …' }).click();
  await page.getByRole('dialog', { name: 'Neuer Ordner' }).getByLabel('Name des Ordners').fill('Annas Wiki');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByText(/projekte\/Annas Wiki$/)).toBeVisible();
  // The same name again is refused with a plain message.
  await page.getByRole('button', { name: 'Übergeordneter Ordner' }).click();
  await page.getByRole('button', { name: 'Neuer Ordner …' }).click();
  await page.getByRole('dialog', { name: 'Neuer Ordner' }).getByLabel('Name des Ordners').fill('Annas Wiki');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByText('Den Ordner „Annas Wiki“ gibt es dort schon')).toBeVisible();
  await page.getByRole('button', { name: /Annas Wiki/ }).click();
  await page.getByRole('button', { name: 'Diesen Ordner wählen' }).click();
  // Empty: taken as a whole (before, Weiter stayed grey).
  await expect(page.getByText('Noch keine Notizen – der Ordner wird ganz eingebunden')).toBeVisible();
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.getByRole('checkbox', { name: /Versionen führen/ })).toBeChecked();
  await expect(page.getByText('Wann deine Änderungen nach Git schreiben?')).toBeVisible();
  await shot(page, '122-lokaler-ordner-versionen');
  const created = page.waitForResponse((r) => r.url().endsWith('/api/mounts') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Einbinden' }).click();
  const mount = (await (await created).json()) as { id: string; include: string[]; options: { autoCommit: boolean } };
  mounts.push(mount.id);
  expect(mount.include).toEqual(['**']);
  expect(mount.options.autoCommit).toBe(true);
  const dir = resolve(PROJECTS, 'Annas Wiki');
  expect(log(dir)).toEqual(['E2E Admin|docs: Versionen eingeschaltet (Kaveyl Wiki)']);

  // Two saves → two versions in the note's menu.
  const note = await ctx.request.post(`/api/notes/${mount.id}`, { data: { parent: '', title: 'Tagebuch', body: '# Tagebuch\n\nErster Tag.\n' } });
  const path = ((await note.json()) as { path: string }).path;
  await ctx.request.post(`/api/mounts/${mount.id}/commit-now`, { data: {} });
  const cur = (await (await ctx.request.get(`/api/notes/${mount.id}/${encodeURIComponent(path)}`)).json()) as { raw: string; hash: string };
  await ctx.request.put(`/api/notes/${mount.id}/${encodeURIComponent(path)}`, { data: { raw: cur.raw + '\nZweiter Tag.\n', baseHash: cur.hash } });
  await ctx.request.post(`/api/mounts/${mount.id}/commit-now`, { data: {} });
  await page.goto(`/n/${mount.id}/${encodeURIComponent(path)}`);
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Versionen' }).click();
  await expect(page.getByRole('listbox', { name: 'Versionen' }).getByRole('option')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // Changed from outside (another program on the same folder): a version too, by „Kaveyl Wiki“.
  writeFileSync(resolve(dir, path), cur.raw + '\nZweiter Tag.\n\nVon außen.\n');
  await expect.poll(() => log(dir)[0], { timeout: 15_000 }).toBe(`Kaveyl Wiki|docs: ${path} außerhalb von Kaveyl Wiki geändert`);
});

test('a new folder deleted at once: the question names no note, the trash has it right away (owner 27.10.)', async () => {
  const [id] = mounts;
  const dir = resolve(PROJECTS, 'Annas Wiki');
  // A folder made in the app holds only its folder page – it is the folder, not a note in it.
  await ctx.request.post(`/api/notes/${id}`, { data: { parent: '', title: 'test', kind: 'dir' } });
  await page.goto('/');
  // The source sits further down, maybe folded.
  const source = page.locator(`aside nav[aria-label="Quellen"] [data-mount="${id}"]`);
  await source.scrollIntoViewIfNeeded();
  if ((await source.getAttribute('aria-expanded')) !== 'true') await source.click();
  const row = page.locator(`aside [data-node="${id}:test"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Löschen', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ordner löschen' });
  await expect(ask).toContainText('test wirklich löschen?');
  await ask.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(page.getByText('„test“ ist im Papierkorb')).toBeVisible();
  // Committed at once, not after the pause: the history has the deletion, the trash shows it.
  expect(log(dir)[0]).toBe('E2E Admin|docs: test gelöscht (Kaveyl Wiki)');
  await page.locator('aside').getByRole('button', { name: 'Papierkorb', exact: true }).click();
  const trash = page.getByRole('dialog', { name: 'Papierkorb' });
  await trash.getByLabel('Quelle').selectOption({ label: 'Annas Wiki' });
  await expect(trash).toContainText('test');
  await trash.getByRole('button', { name: 'Wiederherstellen', exact: true }).first().click();
  await expect.poll(() => existsSync(resolve(dir, 'test/index.md'))).toBe(true);
  await page.keyboard.press('Escape');
});

test('a folder mounted without versions gets them with „Versionen einschalten …“', async () => {
  const res = await ctx.request.post('/api/mounts', { data: { type: 'local', source: PLAIN, name: 'Ohne Versionen' } });
  const { id } = (await res.json()) as { id: string };
  mounts.push(id);
  await page.goto('/');
  const aside = page.locator('aside nav[aria-label="Quellen"]');
  await aside.getByText('Ohne Versionen', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quelle bearbeiten …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mount „Ohne Versionen“ bearbeiten' });
  await expect(dialog.getByText('Lokaler Ordner ohne Git: Änderungen werden direkt in die Dateien gespeichert – ohne Versionen.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Versionen einschalten …' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Versionen für „Ohne Versionen“ einschalten?');
  await ask.getByRole('button', { name: 'Versionen einschalten' }).click();
  await expect(dialog.getByRole('checkbox', { name: /Änderungen automatisch committen/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  expect(log(PLAIN)).toEqual(['E2E Admin|docs: Versionen eingeschaltet (Kaveyl Wiki)']);
  const after = (await (await ctx.request.get('/api/mounts')).json()) as { id: string; options: { autoCommit: boolean } }[];
  expect(after.find((m) => m.id === id)?.options.autoCommit).toBe(true);
});
