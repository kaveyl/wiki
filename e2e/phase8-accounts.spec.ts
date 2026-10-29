// Test track „Konten & E-Mail“ (AD-030) through the browser: login page (light, dark, phone),
// SMTP settings with test mail, inviting a user, sharing a note by e-mail (guest), „Passwort
// vergessen“, „Angemeldet bleiben“. Mails go to a fake SMTP server in this process.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { FakeSmtp } from '../apps/server/src/mail/fake-smtp';
import { openSettingsPage } from './settings-nav';
import { shot } from './shots';

const ADMIN = { email: 'e2e@example.test', password: 'E2E-Passwort-12345' };

test.describe.configure({ mode: 'serial' });

const smtp = new FakeSmtp();
let admin: Page;

async function login(page: Page, email: string, password: string, remember = false) {
  await page.goto('/');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort').fill(password);
  if (remember) await page.getByLabel('Angemeldet bleiben').check();
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
}

/** A fresh browser without a session (like a recipient opening the mail). */
async function stranger(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1360, height: 860 }, ...opts });
  return ctx.newPage();
}

const pathOf = (link: string) => link.replace(/^https?:\/\/[^/]+/, '');

/** Context menu → „Teilen“ ▸ an entry (owner 28.10.: sending by mail and giving access sit together). */
async function shareMenu(page: Page, item: string) {
  await page.getByRole('menuitem', { name: 'Teilen', exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.beforeAll(async ({ browser }) => {
  await smtp.start();
  admin = await browser.newPage();
  await login(admin, ADMIN.email, ADMIN.password);
});

test.afterAll(async () => {
  // Leave no mail server behind for the following specs.
  await admin.request.put('/api/admin/mail', { data: { host: '', fromAddress: '', publicUrl: '' } });
  await smtp.stop();
});

test('login page: brand design in light and dark, phone layout, password eye', async ({ browser }) => {
  const light = await stranger(browser, { colorScheme: 'light' });
  await light.goto('/');
  await expect(light.getByRole('button', { name: 'Anmelden' })).toBeDisabled();
  await expect(light.locator('img[src*="login-light"]')).toBeVisible();
  await expect(light.locator('img[src*="login-dark"]')).toHaveCount(0); // only the variant in effect is loaded (seo-002)
  await light.getByLabel('E-Mail').fill('e2e@example.test');
  await light.getByLabel('Passwort').fill('Geheim-Beispiel-1');
  await light.getByRole('button', { name: 'Eingabe anzeigen' }).click();
  await expect(light.getByLabel('Passwort')).toHaveAttribute('type', 'text');
  await light.getByRole('button', { name: 'Eingabe verbergen' }).click();
  await expect(light.getByLabel('Passwort')).toHaveAttribute('type', 'password');
  await light.getByLabel('Passwort').fill('');
  // A card in the middle on the grey of the sidebar, not the whole screen.
  const card = await light.getByTestId('auth-card').boundingBox();
  const view = light.viewportSize()!;
  expect(card!.width).toBeLessThan(view.width - 100);
  expect(Math.abs(card!.x + card!.width / 2 - view.width / 2)).toBeLessThan(2);
  await shot(light, '80-login-hell');
  // Wrong password: a clear message, nothing about whether the address exists.
  await light.getByLabel('Passwort').fill('Falsches-Passwort-1');
  await light.getByRole('button', { name: 'Anmelden' }).click();
  await expect(light.getByRole('alert')).toHaveText('E-Mail oder Passwort falsch');

  const dark = await stranger(browser, { colorScheme: 'dark' });
  await dark.goto('/');
  await expect(dark.locator('img[src*="login-dark"]')).toBeVisible();
  await expect(dark.locator('html')).toHaveClass(/dark/);
  await shot(dark, '81-login-dunkel');

  const phone = await stranger(browser, { viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await phone.goto('/');
  await expect(phone.getByRole('button', { name: 'Anmelden' })).toBeInViewport();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(phone, '82-login-handy');
  for (const p of [light, dark, phone]) await p.context().close();
});

test('„Passwort vergessen?“ without mail server explains what to do', async ({ browser }) => {
  const page = await stranger(browser);
  await page.goto('/');
  await page.getByRole('button', { name: 'Passwort vergessen?' }).click();
  await expect(page.getByText('E-Mail-Versand ist in dieser Kaveyl-Wiki-Installation nicht eingerichtet')).toBeVisible();
  await page.context().close();
});

test('admin sets up SMTP and sends a test mail', async () => {
  await admin.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(admin, 'E-Mail');
  await expect(admin.getByText('E-Mail-Versand ist nicht eingerichtet')).toBeVisible();
  // No preset for one provider (owner 21.10.) – for the test: the local fake server.
  await expect(admin.getByRole('button', { name: /Vorlage/ })).toHaveCount(0);
  await admin.getByLabel('SMTP-Server').fill('127.0.0.1');
  await admin.getByLabel('Port', { exact: true }).fill(String(smtp.port));
  await admin.getByLabel('Verschlüsselung').selectOption('none');
  await admin.getByLabel('Benutzer (SMTP-Login)').fill('smtp-login@example.test');
  await admin.getByLabel('Passwort / SMTP-Schlüssel').fill('xsmtpsib-nur-ein-test');
  await admin.getByLabel('Absender-Adresse').fill('wiki@example.test');
  await admin.getByLabel('Absender-Name').fill('Kaveyl Wiki Test');
  await admin.getByRole('button', { name: /Diese Adresse übernehmen/ }).click();
  await admin.getByRole('button', { name: 'Speichern' }).click();
  await expect(admin.getByText('Gespeichert. Jetzt am besten eine Testmail schicken.')).toBeVisible();
  await expect(admin.getByLabel('Passwort / SMTP-Schlüssel')).toHaveValue('');
  await admin.getByRole('button', { name: 'Testmail senden' }).click();
  await expect(admin.getByText(`Testmail an ${ADMIN.email} verschickt`)).toBeVisible();
  const mail = await smtp.waitFor(ADMIN.email);
  expect(mail.subject).toBe('Kaveyl Wiki: Testmail');
  await shot(admin, '83-email-einstellungen');
  await admin.keyboard.press('Escape');
});

test('admin invites a new user by mail; the person sets name and password', async ({ browser }) => {
  await admin.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(admin, 'Benutzer');
  // The form opens at the top of the list (owner 21.10.).
  await admin.getByRole('button', { name: 'Neuer Benutzer', exact: true }).click();
  const form = admin.getByRole('form', { name: 'Neuer Benutzer' });
  await expect(form.getByRole('radio', { name: 'Einladung per E-Mail' })).toBeChecked();
  await form.getByLabel('E-Mail (Anmeldung)').fill('nora@example.test');
  await form.getByLabel('Name (Commit-Autor)').fill('Nora Neu');
  await form.getByRole('button', { name: 'Einladung senden' }).click();
  await expect(admin.getByText('Einladung an nora@example.test verschickt')).toBeVisible();
  await admin.keyboard.press('Escape');

  const mail = await smtp.waitFor('nora@example.test');
  expect(mail.subject).toBe('E2E Admin lädt dich zu Kaveyl Wiki ein');
  const nora = await stranger(browser);
  await nora.goto(pathOf(FakeSmtp.link(mail, '#invite=')));
  await expect(nora.getByRole('heading', { name: 'Willkommen bei Kaveyl Wiki' })).toBeVisible();
  // The token left the address bar at once.
  expect(nora.url()).not.toContain('#invite=');
  await expect(nora.getByLabel('Dein Name')).toHaveValue('Nora Neu');
  await nora.getByLabel('Passwort', { exact: true }).fill('Noras-Passwort-2026');
  await nora.getByLabel('Passwort wiederholen').fill('Noras-Passwort-2026');
  await shot(nora, '84-einladung');
  await nora.getByRole('button', { name: 'Konto einrichten' }).click();
  await expect(nora.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
  // A normal user: the default level applies, the source is there.
  await expect(nora.locator('aside nav[aria-label="Quellen"] [data-mount]', { hasText: 'Notizen' })).toBeVisible();
  // Her own start page: steps for a user, nothing an admin sets up.
  const welcome = nora.getByTestId('welcome');
  await expect(welcome.getByText('Notizen finden', { exact: true })).toBeVisible();
  await expect(welcome.getByText('Favoriten merken', { exact: true })).toBeVisible();
  // No app to download (AD-061): the way for this browser only – Chromium on a computer.
  await expect(welcome.getByText('Kaveyl Wiki wie eine App benutzen', { exact: true })).toBeVisible();
  await expect(welcome).toContainText('herunterladen musst du nichts');
  await expect(welcome).toContainText('In Chrome oder Edge: das Installieren-Symbol rechts in der Adressleiste.');
  await expect(welcome).not.toContainText('Zum Home-Bildschirm');
  await expect(welcome.getByRole('button', { name: 'Quelle einbinden' })).toHaveCount(0);
  await expect(welcome.getByRole('button', { name: 'Mehr zu Backup' })).toHaveCount(0);
  await shot(nora, '02c-willkommen-benutzer');
  await nora.context().close();
});

test('a note shared by e-mail: the guest sees only that note', async ({ browser }) => {
  const tree = admin.locator('aside nav[aria-label="Quellen"]');
  await tree.locator('[data-node$=":plan/roadmap.md"]').click({ button: 'right' });
  await shareMenu(admin, 'Zugriff per E-Mail geben …');
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('E-Mail').fill('kunde@example.test');
  await dialog.getByLabel('Name (optional)').fill('Karl Kunde');
  await dialog.getByRole('button', { name: 'Einladen' }).click();
  await expect(dialog.getByRole('status')).toContainText('Einladung an kunde@example.test verschickt');
  await shot(admin, '85-notiz-teilen');
  await admin.keyboard.press('Escape');

  const mail = await smtp.waitFor('kunde@example.test');
  expect(mail.subject).toBe('E2E Admin hat die Notiz „roadmap“ mit dir geteilt');
  const guest = await stranger(browser);
  await guest.goto(pathOf(FakeSmtp.link(mail, '#invite=')));
  await expect(guest.getByText('hat die Notiz „roadmap“ mit dir geteilt')).toBeVisible();
  await guest.getByLabel('Passwort', { exact: true }).fill('Karls-Passwort-2026');
  await guest.getByLabel('Passwort wiederholen').fill('Karls-Passwort-2026');
  await guest.getByRole('button', { name: 'Konto einrichten' }).click();
  // Straight into the note; the tree holds just its folder and the note.
  await expect(guest.locator('.prose-note').filter({ visible: true })).toContainText('Roadmap');
  await expect(guest.locator('.prose-note').filter({ visible: true })).toHaveAttribute('contenteditable', 'false');
  const gtree = guest.locator('aside nav[aria-label="Quellen"]');
  // One toggle: the note's folder is open already, so close first, then open everything.
  const closeAll = guest.getByRole('button', { name: 'Alles zuklappen' });
  if (await closeAll.isVisible()) await closeAll.click();
  await guest.getByRole('button', { name: 'Alles aufklappen' }).click();
  await expect(gtree.locator('[data-node$=":plan/roadmap.md"]')).toBeVisible();
  await expect(gtree.locator('[data-node$=":trilium.md"]')).toHaveCount(0);
  await expect(gtree.locator('[data-node$=":plan/details.md"]')).toHaveCount(0);
  await shot(guest, '86-gast');
  // Guests have no API tokens: „KI & APIs“ shows only the AI page (one page, so no tab row).
  await guest.getByRole('button', { name: 'Einstellungen' }).click();
  await guest.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'KI & APIs', exact: true }).click();
  await expect(guest.getByText('Mein KI-Assistent')).toBeVisible();
  await expect(guest.getByRole('tab', { name: 'API-Tokens' })).toHaveCount(0);
  await guest.context().close();

  // The admin sees the guest in the user list.
  await admin.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(admin, 'Benutzer');
  await expect(admin.getByRole('list', { name: 'Benutzer' }).getByRole('listitem').filter({ hasText: 'Karl Kunde' })).toContainText('Gast');
  await admin.keyboard.press('Escape');
});

test('a folder shared by e-mail with „lesen & schreiben“: the guest edits everything inside, sees nothing outside (owner 21.10.)', async ({ browser }) => {
  const tree = admin.locator('aside nav[aria-label="Quellen"]');
  await tree.locator('[data-node$=":plan"]').click({ button: 'right' });
  await shareMenu(admin, 'Zugriff per E-Mail geben …');
  const dialog = admin.getByRole('dialog', { name: 'Zugriff auf „plan“ per E-Mail geben' });
  await expect(dialog).toContainText('Leserecht auf diesen Ordner mit allem darin');
  await dialog.getByRole('radio', { name: 'lesen & schreiben' }).check();
  await expect(dialog).toContainText('Lese- und Schreibrecht auf diesen Ordner mit allem darin');
  await dialog.getByLabel('E-Mail').fill('ordner@example.test');
  await dialog.getByRole('button', { name: 'Einladen' }).click();
  await expect(dialog.getByRole('status')).toContainText('sieht die Person als Gast nur „plan“ mit allem darin');
  await shot(admin, '85b-ordner-teilen');
  await admin.keyboard.press('Escape');

  const mail = await smtp.waitFor('ordner@example.test');
  expect(mail.subject).toBe('E2E Admin hat den Ordner „plan“ mit dir geteilt');
  expect(mail.text).toContain('Du darfst dort lesen und bearbeiten.');
  const guest = await stranger(browser);
  await guest.goto(pathOf(FakeSmtp.link(mail, '#invite=')));
  await expect(guest.getByText('hat den Ordner „plan“ mit dir geteilt, mit allem, was darin liegt')).toBeVisible();
  await guest.getByLabel('Dein Name').fill('Olaf Ordner');
  await guest.getByLabel('Passwort', { exact: true }).fill('Olafs-Passwort-2026');
  await guest.getByLabel('Passwort wiederholen').fill('Olafs-Passwort-2026');
  await guest.getByRole('button', { name: 'Konto einrichten' }).click();
  // The folder is shown open in the tree; nothing outside it.
  const gtree = guest.locator('aside nav[aria-label="Quellen"]');
  await expect(gtree.locator('[data-node$=":plan/roadmap.md"]')).toBeVisible();
  await expect(gtree.locator('[data-node$=":trilium.md"]')).toHaveCount(0);
  await gtree.locator('[data-node$=":plan/roadmap.md"]').click();
  await expect(guest.locator('.prose-note').filter({ visible: true })).toHaveAttribute('contenteditable', 'true');
  await guest.context().close();
  // The rule is an ordinary one: „Person: lesen & schreiben“ on the folder, to see and remove under „Berechtigungen …“.
  await tree.locator('[data-node$=":plan"]').click({ button: 'right' });
  await admin.getByRole('menuitem', { name: 'Berechtigungen …' }).click();
  const acl = admin.getByRole('dialog', { name: /^Berechtigungen/ });
  await expect(acl).toContainText('Olaf Ordner');
  await admin.keyboard.press('Escape');
});

test('„Rechte“: who may what as a grid – the level right in the cell, one source, one person, cleaning up (owner 21.10.)', async () => {
  await openSettingsPage(admin, 'Rechte');
  const settings = admin.getByRole('dialog', { name: 'Einstellungen' });
  // The basic setting on top: the suite runs with „lesen & schreiben“ (phase1) – a yellow warning; „nichts sehen“ is calm.
  const base = settings.getByLabel('Ohne Freigabe dürfen Benutzer:');
  await expect(base).toHaveValue('write');
  await expect(settings.getByText(/^Jedes Konto außer Gästen darf ohne Freigabe/)).toBeVisible();
  await base.selectOption({ label: 'nichts sehen' });
  await expect(settings.getByText(/^Neue Konten sehen erst etwas/)).toBeVisible();
  const grid = settings.getByRole('table', { name: 'Rechte' });
  const olaf = grid.getByRole('row').filter({ hasText: 'Olaf Ordner' });
  // The shared folder is an exception further down; the cell itself: no access, nothing of his own.
  await expect(olaf.getByRole('button', { name: '+1 Ausnahme' })).toBeVisible();
  const cell = grid.getByLabel('Olaf Ordner in Notizen');
  await expect(cell).toHaveValue('none');
  // A guest is never offered „verwalten“.
  await expect(cell.locator('option')).toHaveText(['kein Zugriff', 'lesen', 'lesen & schreiben']);
  await cell.selectOption({ label: 'lesen' });
  await expect(cell).toHaveValue('read');
  await expect(grid.getByText('alles (Admin)').first()).toBeVisible();
  await shot(admin, '99b-rechte');
  // Phone: one card per person with the sources they may see, the rest one tap away.
  const size = admin.viewportSize()!;
  await admin.setViewportSize({ width: 390, height: 844 });
  const card = settings.getByRole('region', { name: 'Olaf Ordner' });
  await expect(card.getByLabel('Olaf Ordner in Notizen')).toHaveValue('read');
  await expect(card.getByRole('button', { name: /^Alle \d+ Quellen/ })).toBeVisible();
  await shot(admin, '99c-rechte-handy');
  await admin.setViewportSize(size);
  const ownRules = async () => {
    const o = (await (await admin.request.get('/api/admin/rights')).json()) as { rules: { target: string; subjectId: string | null }[]; users: { id: string; name: string }[] };
    const id = o.users.find((u) => u.name === 'Olaf Ordner')!.id;
    return o.rules.filter((r) => r.target === 'mount' && r.subjectId === id).length;
  };
  expect(await ownRules()).toBe(1);
  // Choosing what applies anyway takes the own rule away again.
  await cell.selectOption({ label: 'kein Zugriff' });
  await expect(cell).toHaveValue('none');
  await expect.poll(ownRules).toBe(0);
  // One source: everyone below each other.
  await grid.getByRole('columnheader').getByRole('button', { name: 'Notizen', exact: true }).click();
  await expect(settings.getByRole('list', { name: 'Rechte in Notizen' })).toContainText('Olaf Ordner');
  await settings.getByRole('button', { name: 'Alle Quellen' }).click();
  // One person: the exception under its source – removing it is the ordinary removal of the rule, after a question.
  await olaf.getByRole('button', { name: '+1 Ausnahme' }).click();
  const sources = settings.getByRole('list', { name: 'Quellen von Olaf Ordner' });
  await expect(sources).toContainText('Mit Zugriff (1)');
  await sources.getByRole('button', { name: 'Freigabe entfernen: plan' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect(sources).not.toContainText('Mit Zugriff');
  await settings.getByRole('button', { name: 'Alle Personen' }).click();
  // Cleaning up: what can probably go, or that there is nothing.
  await settings.getByRole('group', { name: 'Auswahl' }).getByRole('button', { name: /^Aufräumen/ }).click();
  await expect(settings.getByText(/vermutlich weg kann|Nichts aufzuräumen/)).toBeVisible();
  // Back to the suite's basic setting for the specs after this one.
  await settings.getByRole('group', { name: 'Auswahl' }).getByRole('button', { name: /^Alle \d/ }).click();
  await base.selectOption({ label: 'lesen & schreiben' });
  await expect(base).toHaveValue('write');
  // The user list says when each account was last active.
  await openSettingsPage(admin, 'Benutzer');
  await expect(admin.getByRole('list', { name: 'Benutzer' }).getByRole('listitem').filter({ hasText: 'ordner@example.test' })).toContainText('zuletzt aktiv');
  await admin.keyboard.press('Escape');
});

test('„Passwort vergessen?“: link by mail, new password, the old one no longer works', async ({ browser }) => {
  const page = await stranger(browser);
  await page.goto('/');
  await page.getByRole('button', { name: 'Passwort vergessen?' }).click();
  await page.getByLabel('E-Mail').fill('nora@example.test');
  await page.getByRole('button', { name: 'Link anfordern' }).click();
  await expect(page.getByRole('heading', { name: 'Bitte Postfach prüfen' })).toBeVisible();
  await shot(page, '87-passwort-vergessen');
  const mail = await smtp.waitFor('nora@example.test', (m) => m.subject.includes('zurücksetzen'));
  await page.goto(pathOf(FakeSmtp.link(mail, '#reset=')));
  await expect(page.getByRole('heading', { name: 'Neues Passwort festlegen' })).toBeVisible();
  await page.getByLabel('Neues Passwort').fill('zu-kurz');
  await expect(page.getByRole('button', { name: 'Passwort speichern' })).toBeDisabled();
  await page.getByLabel('Neues Passwort').fill('Noras-Neues-Passwort-77');
  await page.getByLabel('Passwort wiederholen').fill('Noras-Neues-Passwort-77');
  await shot(page, '88-neues-passwort');
  await page.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
  await smtp.waitFor('nora@example.test', (m) => m.subject.includes('wurde geändert'));
  // The same link does not work twice.
  await page.goto(pathOf(FakeSmtp.link(mail, '#reset=')));
  await expect(page.getByRole('heading', { name: 'Link nicht mehr gültig' })).toBeVisible();
  await page.context().close();

  const old = await stranger(browser);
  await old.goto('/');
  await old.getByLabel('E-Mail').fill('nora@example.test');
  await old.getByLabel('Passwort').fill('Noras-Passwort-2026');
  await old.getByRole('button', { name: 'Anmelden' }).click();
  await expect(old.getByRole('alert')).toHaveText('E-Mail oder Passwort falsch');
  await old.context().close();
});

test('„Angemeldet bleiben“ decides between a 30-day and a browser-session cookie', async ({ browser }) => {
  const short = await stranger(browser);
  await login(short, 'nora@example.test', 'Noras-Neues-Passwort-77');
  expect((await short.context().cookies()).find((c) => c.name === 'kw_session')!.expires).toBe(-1);
  await short.context().close();
  const long = await stranger(browser);
  await login(long, 'nora@example.test', 'Noras-Neues-Passwort-77', true);
  const expires = (await long.context().cookies()).find((c) => c.name === 'kw_session')!.expires;
  expect(expires * 1000 - Date.now()).toBeGreaterThan(29 * 86_400_000);
  // The choice is remembered on this device.
  await long.goto('/');
  await long.context().clearCookies();
  await long.reload();
  await expect(long.getByLabel('Angemeldet bleiben')).toBeChecked();
  await long.context().close();
});

test('several notes marked in the tree: sent by mail as files, exported as one ZIP; a Markdown file imported and deleted again (owner 28.10.)', async () => {
  // A fresh start of the app for this test, whatever earlier ones left open.
  await admin.goto('/');
  await expect(admin.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
  const tree = admin.locator('aside nav[aria-label="Quellen"]');
  const roadmap = tree.locator('[data-node$=":plan/roadmap.md"]');
  const details = tree.locator('[data-path^="plan/"][data-title="tagged"]');
  const plan = tree.locator('[data-node$=":plan"]');
  if ((await plan.getAttribute('aria-expanded')) !== 'true') await plan.locator('span').first().click();
  // A plain click opens; Ctrl+click marks – the open row joins in, as in a file explorer.
  await roadmap.click();
  await details.click({ modifiers: ['ControlOrMeta'] });
  await expect(tree.locator('[data-marked]')).toHaveCount(2);
  const bar = admin.getByRole('toolbar', { name: 'Auswahl' });
  await expect(bar).toContainText('2 markiert');
  await details.click({ button: 'right' });
  await expect(admin.getByRole('menu')).toContainText('2 markiert');
  await shot(admin, '89-mehrere-markiert');
  await admin.getByRole('menuitem', { name: 'Per Mail versenden …' }).click();
  const dialog = admin.getByRole('dialog', { name: '2 Notizen per Mail versenden' });
  await dialog.getByLabel('An').fill('partner@extern.test, zweite@extern.test');
  await shot(admin, '89b-per-mail-versenden');
  await dialog.getByRole('button', { name: 'Senden' }).click();
  await expect(admin.getByText('An 2 Adressen verschickt')).toBeVisible();
  const mail = await smtp.waitFor('partner@extern.test');
  expect(mail.subject).toBe('E2E Admin hat dir 2 Notizen aus Kaveyl Wiki geschickt');
  expect(mail.text).toContain('Antworten auf diese Mail gehen an E2E Admin.');
  expect(mail.raw).toMatch(/filename="?tagged\.(md|zip)"?/);
  expect(mail.raw).toMatch(/filename="?roadmap\.(md|zip)"?/);
  // Both as one ZIP from their common folder.
  const download = admin.waitForEvent('download');
  await bar.getByRole('button', { name: 'Aktionen' }).click();
  await admin.getByRole('menuitem', { name: 'Exportieren: Markdown (ZIP)' }).click();
  expect((await download).suggestedFilename()).toBe('plan.zip');
  // Esc in the tree clears the marks.
  await details.focus();
  await admin.keyboard.press('Escape');
  await expect(tree.locator('[data-marked]')).toHaveCount(0);
  await expect(bar).toHaveCount(0);

  // Import: a .md file from the computer becomes a note in the folder.
  await tree.locator('[data-node$=":plan"]').click({ button: 'right' });
  await admin.getByRole('menuitem', { name: 'Importieren', exact: true }).click();
  const chooser = admin.waitForEvent('filechooser');
  await admin.getByRole('menuitem', { name: 'Markdown-Dateien …' }).click();
  await (await chooser).setFiles([
    { name: 'Import Eins.md', mimeType: 'text/markdown', buffer: Buffer.from('---\ntags: [import]\n---\n# Import Eins\n\nAus einer Datei.\n') },
    { name: 'Import Zwei.md', mimeType: 'text/markdown', buffer: Buffer.from('# Import Zwei\n') },
  ]);
  await expect(admin.getByText('2 Notizen importiert')).toBeVisible();
  const one = tree.locator('[data-node$=":plan/Import Eins.md"]');
  const two = tree.locator('[data-node$=":plan/Import Zwei.md"]');
  await expect(one).toBeVisible();
  await one.click();
  await expect(admin.locator('.prose-note').filter({ visible: true })).toContainText('Aus einer Datei.');
  // On touch: „Auswählen“ shows boxes, a tap marks. Both imported notes go to the trash at once.
  await two.click({ button: 'right' });
  await admin.getByRole('menuitem', { name: 'Auswählen' }).click();
  await expect(two.locator('input[type="checkbox"]')).toBeChecked();
  await one.click();
  await expect(tree.locator('[data-marked]')).toHaveCount(2);
  await bar.getByRole('button', { name: 'Aktionen' }).click();
  await admin.getByRole('menuitem', { name: 'Löschen …' }).click();
  const del = admin.getByRole('dialog', { name: '2 Einträge löschen' });
  await del.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(admin.getByText('2 Einträge sind im Papierkorb')).toBeVisible();
  await expect(one).toHaveCount(0);
  await expect(two).toHaveCount(0);
  // Out of the trash again: later specs count what is in it.
  const mountId = (await plan.getAttribute('data-mount-of'))!;
  const trash = (await (await admin.request.get(`/api/trash/${mountId}`)).json()) as { items: { id: string }[] };
  for (const item of trash.items.filter((i) => JSON.stringify(i).includes('Import '))) {
    expect((await admin.request.post(`/api/trash/${mountId}/purge`, { data: { id: item.id } })).ok()).toBe(true);
  }

  // From another program (docs/PLAN-IMPORT.md): a real HedgeDoc export → preview → a new folder with the report.
  await tree.locator('[data-node$=":plan"]').click({ button: 'right' });
  await admin.getByRole('menuitem', { name: 'Importieren', exact: true }).click();
  await admin.getByRole('menuitem', { name: 'Aus anderem Programm …' }).click();
  const imp = admin.getByRole('dialog', { name: 'Aus anderem Programm importieren' });
  const zipChooser = admin.waitForEvent('filechooser');
  await imp.getByRole('button', { name: 'ZIP-Datei wählen …' }).click();
  // HedgeDoc names its download „archive.zip“ – the folder is then called after the program.
  await (await zipChooser).setFiles({ name: 'archive.zip', mimeType: 'application/zip', buffer: readFileSync(resolve(import.meta.dirname, '../apps/server/src/import/fixtures/hedgedoc-1.12.0.zip')) });
  await expect(imp.getByTestId('import-counts')).toContainText('60 Notizen · 0 Dateien · 0 Ordner');
  await expect(imp.getByLabel('Format')).toHaveValue('hedgedoc');
  await expect(imp.getByLabel('Neuer Ordner')).toHaveValue('Import aus HedgeDoc');
  // Pictures stay on the HedgeDoc server in its export: fetching them is offered (ticked).
  await expect(imp.getByRole('checkbox', { name: '4 Bilder vom alten Server holen (127.0.0.1:8097)' })).toBeChecked();
  await imp.getByText('Folien – sie erscheinen als normaler Text (1)').click();
  await expect(imp.getByText('Jahreshauptversammlung (Folien)')).toBeVisible();
  await shot(admin, '90-import-vorschau');
  await imp.getByRole('button', { name: 'Importieren', exact: true }).click();
  await expect(admin.getByText('Import fertig')).toBeVisible();
  await expect(tree.locator('[data-node$=":plan/Import aus HedgeDoc/Hinweisboxen.md"]')).toBeVisible();
  await expect(admin.locator('.prose-note').filter({ visible: true })).toContainText('Leere Notizen – nicht übernommen (1)');
  // The fixture's server is on this machine – never fetched from there, so the report names them.
  await expect(admin.locator('.prose-note').filter({ visible: true })).toContainText('Notizen mit Bildern, die sich vom alten Server nicht holen ließen – sie bleiben Web-Links (3)');
  // Out again: later specs count notes and the trash.
  expect((await admin.request.delete(`/api/notes/${mountId}/plan/Import aus HedgeDoc`, { data: {} })).ok()).toBe(true);
  const trash2 = (await (await admin.request.get(`/api/trash/${mountId}`)).json()) as { items: { id: string }[] };
  for (const item of trash2.items.filter((i) => JSON.stringify(i).includes('Import aus HedgeDoc'))) {
    expect((await admin.request.post(`/api/trash/${mountId}/purge`, { data: { id: item.id } })).ok()).toBe(true);
  }
});
