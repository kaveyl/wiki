// Löschregeln (Einstellungen → Aufräumen), restoring from the trash under another name, large
// images (scaled down on upload, capped height, full-size view) and the in-app help (owner
// 2026-10-11). Runs after the other specs in the same seeded workspace (admin + "Notizen").
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { waitIndexed } from './indexed';
import { openSettingsPage } from './settings-nav';
import { neutralize } from './shots';

const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
const SHOTS = resolve(import.meta.dirname, '../.local/e2e-shots');
/** Screenshot for the manual — after the notes of earlier steps are gone (ok notes close after 4 s). */
const shot = async (page: Page, name: string) => {
  await expect(page.locator('[role="status"][data-print="hide"] > *')).toHaveCount(0, { timeout: 8000 }).catch(() => undefined);
  const restore = await neutralize(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await restore();
};

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail', { exact: true }).fill('e2e@example.test');
  await page.getByLabel('Passwort', { exact: true }).fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(tree().getByText('Notizen', { exact: true }).first()).toBeVisible();
});

const tree = () => page.locator('aside nav[aria-label="Quellen"]');
const settings = () => page.getByRole('dialog', { name: 'Einstellungen' });
const help = () => page.getByRole('dialog', { name: 'Hilfe' });

const openSettings = (tab: string) => openSettingsPage(page, tab);

async function closeAll() {
  for (let i = 0; i < 4 && (await page.getByRole('dialog').count()); i++) await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('Einstellungen → Aufräumen: every rule with its default and what it holds now; rules saved and applied', async () => {
  await openSettings('Aufräumen');
  const panel = settings();
  for (const title of ['Protokoll', 'Papierkorb der Notizen', 'KI-Chats', 'Datenbank-Sicherungen', 'Gelöschte Repositories', 'Lokale Kopien der Repositories', 'Feste Regeln']) {
    await expect(panel.getByRole('region', { name: title })).toBeVisible();
  }
  await expect(panel.getByLabel('Unbenutzte Chats aufbewahren', { exact: true })).toHaveValue('90');
  await expect(panel.getByLabel('Gelöschte Notizen aufbewahren', { exact: true })).toHaveValue('30');
  await expect(panel.getByLabel('Tägliche Sicherungen behalten', { exact: true })).toHaveValue('7');
  await expect(panel.getByLabel('Verwaiste Kopien aufbewahren', { exact: true })).toHaveValue('30');
  // Out of range: refused with the allowed range, nothing saved.
  await panel.getByLabel('Tägliche Sicherungen behalten', { exact: true }).fill('0');
  await panel.getByRole('button', { name: 'Tägliche Sicherungen behalten speichern' }).click();
  await expect(panel).toContainText('Erlaubt: 1 bis 90');
  await panel.getByLabel('Tägliche Sicherungen behalten', { exact: true }).fill('10');
  await panel.getByRole('button', { name: 'Tägliche Sicherungen behalten speichern' }).click();
  await expect(panel.getByRole('button', { name: 'Tägliche Sicherungen behalten speichern' })).toBeDisabled();
  await expect(panel).toContainText('Standard: 7.');
  // The same rule shows up in Backup → Datenbank.
  await openSettings('Datenbank');
  await expect(settings().getByLabel('Tägliche Sicherungen behalten', { exact: true })).toHaveValue('10');
  await settings().getByLabel('Tägliche Sicherungen behalten', { exact: true }).fill('7');
  await settings().getByRole('button', { name: 'Tägliche Sicherungen behalten speichern' }).click();
  await expect(settings().getByRole('button', { name: 'Tägliche Sicherungen behalten speichern' })).toBeDisabled();
  await openSettings('Aufräumen');
  await expect(settings().getByLabel('Tägliche Sicherungen behalten', { exact: true })).toHaveValue('7');
  await settings().getByRole('button', { name: 'Jetzt aufräumen' }).click();
  await expect(page.getByText(/Aufgeräumt|Nichts war fällig/).first()).toBeVisible();
  await shot(page, '90-einstellungen-aufraeumen');
  // The help for this tab explains the rules.
  await settings().getByRole('button', { name: 'Hilfe zu diesem Fenster' }).click();
  await expect(help().getByRole('heading', { name: 'Aufräumen', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help()).toHaveCount(0);
  await expect(settings()).toBeVisible();
});

test('settings tabs: own rules where they belong, image size for uploads, screenshots', async () => {
  // The trash has no tab of its own any more: its rule and explanation sit in Aufräumen (AD-035).
  await openSettings('Aufräumen');
  await expect(settings().getByRole('region', { name: 'Papierkorb der Notizen' })).toContainText('„Speichern als“');
  // DB-Backup: the list starts folded with a summary; what the database holds is in the help.
  await openSettings('Datenbank');
  const files = settings().getByRole('button', { name: 'Vorhandene Backups' });
  await expect(files).toHaveAttribute('aria-expanded', 'false');
  await expect(files).toContainText(/\d+ Dateie?n? · [\d.,]+ [KMG]?B/);
  await expect(settings().getByRole('list', { name: 'Backups' })).toHaveCount(0);
  await shot(page, '106-einstellungen-db-backup');
  await files.click();
  await expect(settings().getByRole('list', { name: 'Backups' })).toContainText(/(Täglich|Von Hand) \(\d+\)/);
  await settings().getByRole('button', { name: 'Was steht in der Datenbank?' }).click();
  await expect(help().getByRole('heading', { name: 'Was steht in der Datenbank?', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(help()).toHaveCount(0);
  await openSettings('Anhänge');
  const select = settings().getByLabel('Große Bilder beim Einfügen verkleinern', { exact: true });
  await expect(select).toHaveValue('2400');
  await select.selectOption('1600');
  await expect(select).toHaveValue('1600');
  await select.selectOption('2400');
  await expect(select).toHaveValue('2400');
  // Blocked file endings: a list, prefilled with the executables; saved as typed, back to the default list (owner 25.10.).
  const blocked = settings().getByLabel('Gesperrte Dateiendungen', { exact: true }).first();
  await expect(blocked).toHaveValue(/(^|, )exe(,|$)/);
  await blocked.fill('.BAT ps1');
  await settings().getByRole('button', { name: 'Speichern', exact: true }).last().click();
  await expect(blocked).toHaveValue('bat, ps1');
  await settings().getByRole('button', { name: 'Standardliste', exact: true }).click();
  await expect(blocked).toHaveValue(/(^|, )exe(,|$)/);
  await shot(page, '95-einstellungen-anhaenge');
  await openSettings('KI');
  await expect(settings().getByLabel('Unbenutzte Chats aufbewahren', { exact: true })).toHaveValue('90');
  await openSettings('Quellen');
  await settings().getByRole('tab', { name: 'Eingebundene Quellen' }).click();
  await expect(settings().getByLabel('Im Repository-Papierkorb lassen', { exact: true })).toHaveValue('30');
  await expect(settings().getByLabel('Verwaiste lokale Kopien aufbewahren', { exact: true })).toHaveValue('30');
  await openSettings('Gruppen');
  await shot(page, '99-einstellungen-gruppen');
  await openSettings('Konto');
  await shot(page, '98-einstellungen-konto');
  // F1 in a settings tab: the help for exactly this tab.
  await page.keyboard.press('F1');
  await expect(help().getByRole('heading', { name: 'Konto', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await closeAll();
});

test('a source keeps its AI chats for its own time (Quelle bearbeiten → „KI-Chats aufbewahren“)', async () => {
  await tree().getByText('Notizen', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quelle bearbeiten …' }).click();
  const dialog = page.getByRole('dialog', { name: /bearbeiten/ });
  const select = dialog.getByLabel('KI-Chats aufbewahren', { exact: true });
  await expect(select).toHaveValue('-1');
  await expect(select.locator('option').first()).toHaveText('Wie in Einstellungen → KI (90 Tage)');
  await select.selectOption('7');
  await select.scrollIntoViewIfNeeded();
  await shot(page, '103-quelle-bearbeiten');
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const mounts = (await (await page.request.get('/api/mounts')).json()) as { name: string; options: { aiChatDays?: number } }[];
  expect(mounts.find((m) => m.name === 'Notizen')!.options.aiChatDays).toBe(7);
  // Back to the general rule.
  await tree().getByText('Notizen', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Quelle bearbeiten …' }).click();
  await page.getByRole('dialog', { name: /bearbeiten/ }).getByLabel('KI-Chats aufbewahren', { exact: true }).selectOption('-1');
  await page.getByRole('dialog', { name: /bearbeiten/ }).getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = (await (await page.request.get('/api/mounts')).json()) as { name: string; options: { aiChatDays?: number } }[];
  expect(after.find((m) => m.name === 'Notizen')!.options.aiChatDays).toBe(-1);
});

test('trash: restoring onto a taken name offers another name; nothing is overwritten', async () => {
  writeFileSync(join(NOTES, 'entwurf.md'), '# Entwurf\n\nAlte Fassung.\n');
  await expect(tree().getByText('entwurf', { exact: true }).first()).toBeVisible();
  await tree().getByText('entwurf', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Löschen', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect.poll(() => existsSync(join(NOTES, 'entwurf.md'))).toBe(false);
  // Meanwhile a new note took the name.
  writeFileSync(join(NOTES, 'entwurf.md'), '# Entwurf\n\nNeue Fassung.\n');
  await page.locator('aside').getByRole('button', { name: 'Papierkorb', exact: true }).click();
  const trash = page.getByRole('dialog', { name: 'Papierkorb' });
  await trash.getByLabel('Quelle', { exact: true }).selectOption({ label: 'Notizen' });
  await expect(trash).toContainText('entwurf.md');
  await trash.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
  const asDialog = page.getByRole('dialog', { name: 'Speichern als' });
  await expect(asDialog).toContainText('liegt inzwischen eine andere Datei');
  await expect(asDialog.getByLabel('Dateiname')).toHaveValue('entwurf (wiederhergestellt)');
  await shot(page, '93-unter-anderem-namen');
  await asDialog.getByRole('button', { name: 'Wiederherstellen' }).click();
  await expect.poll(() => (existsSync(join(NOTES, 'entwurf (wiederhergestellt).md')) ? readFileSync(join(NOTES, 'entwurf (wiederhergestellt).md'), 'utf8') : '')).toContain('Alte Fassung');
  expect(readFileSync(join(NOTES, 'entwurf.md'), 'utf8')).toContain('Neue Fassung');
  await expect(page.locator('[data-tab="entwurf (wiederhergestellt).md"]')).toBeVisible();
  await closeAll();
});

test('large images: scaled down on upload, capped in the note, shown big with the magnifier', async () => {
  await tree().getByText('stand', { exact: true }).first().click();
  const editor = page.locator('.prose-note[contenteditable="true"]').filter({ visible: true });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  // A 4000 × 3000 picture, far over the default 2400 px.
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 4000;
    c.height = 3000;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 4000, 3000);
    grad.addColorStop(0, '#4f46e5');
    grad.addColorStop(1, '#f59e0b');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4000, 3000);
    g.fillStyle = '#fff';
    g.font = 'bold 320px sans-serif';
    g.fillText('Großes Foto', 400, 1600);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true }).getByRole('button', { name: /Datei oder Bild anhängen/ }).click();
  await (await chooser).setFiles({ name: 'urlaub.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  await expect(page.getByText('Bild verkleinert').first()).toBeVisible();
  await expect(page.getByText(/4000×3000 → 2400×1800/).first()).toBeVisible();
  await expect.poll(() => (existsSync(join(NOTES, 'assets')) ? readdirSync(join(NOTES, 'assets')) : []).filter((f) => f.startsWith('urlaub'))).toEqual(['urlaub.webp']);
  const img = editor.locator('.note-image img[alt="urlaub"]');
  await expect(img).toBeVisible();
  // Loaded once near the visible part of the note (loadWhenNear), then without the placeholder.
  await expect(img).toHaveJSProperty('complete', true);
  await expect(editor.locator('.note-image:has(img[alt="urlaub"])')).not.toHaveClass(/is-pending/);
  // Never taller than about two thirds of the window.
  const box = (await img.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(860 * 0.66);
  await img.hover();
  await editor.locator('.note-image', { has: page.locator('img[alt="urlaub"]') }).getByRole('button', { name: 'Bild groß anzeigen' }).click();
  const lightbox = page.getByRole('dialog', { name: 'Bild: urlaub' });
  await expect(lightbox).toBeVisible();
  await shot(page, '94-bild-gross');
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  // The note file holds a plain Markdown image.
  await expect.poll(() => readFileSync(join(NOTES, 'stand.md'), 'utf8')).toContain('![urlaub](assets/urlaub.webp)');
});

test('help: the manual inside Kaveyl Wiki – chapters, search, links, from the editor and the command palette', async () => {
  // Long walk through the help with three pictures (each waits for toasts to close).
  test.setTimeout(120_000);
  // Settings → Hilfe: what Kaveyl Wiki is (paragraphs, no numbered list) and where help is.
  await openSettings('Hilfe');
  await expect(settings()).toContainText('Was ist Kaveyl Wiki?');
  await expect(settings()).not.toContainText('zehn Sätzen');
  await expect(settings().getByRole('region', { name: 'Was ist Kaveyl Wiki?' }).locator('p')).toHaveCount(4);
  await expect(settings().getByRole('region', { name: 'Was ist Kaveyl Wiki?' }).locator('li, ol')).toHaveCount(0);
  // The installed version, so admins and users can say which Kaveyl Wiki they run.
  await expect(settings().getByRole('region', { name: 'Version' })).toContainText(/Kaveyl Wiki \S+/);
  // Licences in plain sight (AD-064): own licence, source code, third-party notices – each a link that opens in a new tab.
  const version = settings().getByRole('region', { name: 'Version' });
  for (const [name, href] of [['GNU AGPL-3.0', '/LICENSE.txt'], ['Quellcode', 'https://github.com/kaveyl/wiki'], ['Lizenzen der verwendeten Komponenten', '/THIRD-PARTY-NOTICES.txt']] as const) {
    await expect(version.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
    await expect(version.getByRole('link', { name, exact: true })).toHaveAttribute('target', '_blank');
  }
  expect((await page.request.get('/LICENSE.txt')).ok()).toBe(true);
  const notices = await page.request.get('/THIRD-PARTY-NOTICES.txt');
  expect(notices.ok()).toBe(true);
  expect(await notices.text()).toContain('THIRD-PARTY NOTICES – Kaveyl Wiki');
  // The example agent the manual offers comes with the app (owner 25.10.: also without GitHub).
  for (const f of ['agent.mjs', 'README.md']) expect((await page.request.get(`/hilfe/beispiele/incident-agent/${f}`)).ok(), f).toBe(true);
  await shot(page, '92-einstellungen-hilfe');
  await settings().getByRole('region', { name: 'Einstieg' }).getByRole('button', { name: 'Markdown-Spickzettel', exact: true }).click();
  await expect(help().getByRole('heading', { name: 'Markdown-Spickzettel' })).toBeVisible();
  await expect(help().getByRole('navigation', { name: 'Kapitel' }).getByRole('button', { name: 'Bearbeiten', exact: true })).toHaveAttribute('aria-current', 'true');
  // Search finds sections across chapters.
  await help().getByLabel('Hilfe durchsuchen', { exact: true }).fill('Löschregeln');
  const results = help().getByRole('navigation', { name: 'Suchergebnisse' });
  await results.getByRole('button', { name: /^Löschregeln/ }).first().click();
  await expect(help().getByRole('heading', { name: 'Löschregeln', exact: true })).toBeVisible();
  // The term and the results stay to try the next hit (owner 25.10.); the open one is marked; × empties the search.
  await expect(help().getByLabel('Hilfe durchsuchen', { exact: true })).toHaveValue('Löschregeln');
  await expect(results.getByRole('button', { name: /^Löschregeln/ }).first()).toHaveAttribute('aria-current', 'true');
  await help().getByRole('button', { name: 'Suche leeren' }).click();
  await expect(help().getByLabel('Hilfe durchsuchen', { exact: true })).toHaveValue('');
  await help().getByRole('navigation', { name: 'Kapitel' }).getByRole('button', { name: 'Hilfe in Kaveyl Wiki', exact: true }).click();
  await expect(help().getByRole('heading', { name: 'Hilfe in Kaveyl Wiki', exact: true })).toBeVisible();
  await expect(help().locator('[data-help-content] img[src*="/hilfe/handbuch/"]').first()).toBeAttached();
  // Lines wrapped in the manual's source read as one paragraph (no line break inside a sentence).
  await expect(help().locator('[data-help-content] .ProseMirror')).toContainText('Referenz für API und MCP. So kommst du hin:');
  await shot(page, '91-hilfe');
  // A link inside the text jumps to another chapter and section. Its address is the help's own – never the open note's,
  // which an anchor alone resolved against (owner 21.10.) – and opened in a new tab it shows the help at that spot.
  const inText = help().locator('[data-help-content] a', { hasText: 'Markdown-Spickzettel' }).first();
  await expect(inText).toHaveAttribute('href', '/?hilfe=markdown-spickzettel');
  await inText.click();
  await expect(help().getByRole('heading', { name: 'Markdown-Spickzettel', exact: true })).toBeInViewport();
  // Quick clicks (a double click to the browser) stay in the help too – they used to open a new tab (owner 21.10.).
  const tabs = page.context().pages().length;
  await help().getByRole('navigation', { name: 'Kapitel' }).getByRole('button', { name: 'Hilfe in Kaveyl Wiki', exact: true }).click();
  await inText.dblclick();
  await expect(help().getByRole('heading', { name: 'Markdown-Spickzettel', exact: true })).toBeInViewport();
  expect(page.context().pages()).toHaveLength(tabs);
  // A new tab: a context of its own with the same sign-in (a page from browser.newPage() cannot open a second one).
  const tab = await page.context().browser()!.newContext({ storageState: await page.context().storageState(), baseURL: test.info().project.use.baseURL, locale: 'de-DE' });
  const fresh = await tab.newPage();
  await fresh.goto('/?hilfe=markdown-spickzettel');
  await expect(fresh.getByRole('dialog', { name: 'Hilfe' }).getByRole('heading', { name: 'Markdown-Spickzettel', exact: true })).toBeVisible();
  await expect(fresh).not.toHaveURL(/hilfe=/);
  await tab.close();
  // Pictures open large.
  await help().getByRole('navigation', { name: 'Kapitel' }).getByRole('button', { name: 'Anmelden und Oberfläche', exact: true }).click();
  const picture = help().locator('[data-help-content] img[src*="/hilfe/handbuch/01-anmelden"]');
  await picture.click();
  await expect(page.getByRole('dialog', { name: /^Bild/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /^Bild/ })).toHaveCount(0);
  await expect(help()).toBeVisible();
  // The × and a click on the picture close it too – the help dialog let no click out of itself (owner 21.10.).
  await picture.click();
  const large = page.getByRole('dialog', { name: /^Bild/ });
  await expect(large.getByRole('button', { name: 'Schließen' })).toBeFocused();
  await large.getByRole('button', { name: 'Schließen' }).click();
  await expect(large).toHaveCount(0);
  await picture.click();
  await large.locator('img').click();
  await expect(large).toHaveCount(0);
  await expect(help()).toBeVisible();
  // The API reference is the second document.
  await help().getByRole('tab', { name: 'API & MCP' }).click();
  await expect(help().locator('[data-help-content] h2').first()).toBeVisible();
  await closeAll();

  // From the editor toolbar and the command palette.
  await tree().getByText('roadmap', { exact: true }).first().click();
  await page.getByRole('button', { name: /Hilfe zum Editor/ }).first().click();
  await expect(help().getByRole('heading', { name: 'Bearbeiten', exact: true })).toBeVisible();
  await closeAll();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'Befehlspalette' })).toBeFocused();
  await page.keyboard.type('>Tastenkürzel');
  await page.getByRole('option', { name: /Hilfe: Tastenkürzel/ }).click();
  await expect(help().getByRole('heading', { name: 'Tastenkürzel', exact: true })).toBeVisible();
  await closeAll();
  // Dialogs carry their own „?“: the KI-Freigabe explains releases.
  await tree().getByText('Notizen', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Berechtigungen …' }).click();
  await page.getByRole('dialog', { name: /^Berechtigungen/ }).getByRole('button', { name: 'Hilfe zu diesem Fenster' }).click();
  await expect(help().getByRole('heading', { name: 'Berechtigungen', exact: true })).toBeVisible();
  await closeAll();
  // A note's context menu, for the menu overview in the manual.
  await tree().getByText('roadmap', { exact: true }).first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Umbenennen / verschieben' })).toBeVisible();
  await shot(page, '101-menue-notiz');
  await page.keyboard.press('Escape');
});

test('settings menu: main entries with tabs; notifications by e-mail and Pushover per event', async () => {
  await openSettings('Aufräumen');
  const areas = settings().getByRole('navigation', { name: 'Bereiche' }).getByRole('button');
  await expect(areas).toHaveText(['Quellen', 'Anhänge', 'Werkzeuge', 'Backup', 'Benutzer & Rechte', 'SSO & Proxy', 'Benachrichtigungen', 'KI & APIs', 'Darstellung', 'Konto', 'Hilfe']);
  await expect(settings().getByRole('tablist', { name: 'Werkzeuge' }).getByRole('tab')).toHaveText(['Aufräumen', 'Protokoll', 'Prüfung']);
  // Tabs stay in one row (Webhooks next to Eingebundene Quellen, not below).
  await openSettings('Verbindungen');
  await expect(settings().getByRole('tablist', { name: 'Quellen' }).getByRole('tab')).toHaveText(['Verbindungen', 'Eingebundene Quellen', 'Webhooks']);
  const top = async (name: string) => (await settings().getByRole('tab', { name, exact: true }).boundingBox())!.y;
  expect(await top('Webhooks')).toBe(await top('Verbindungen'));
  // The help stays in one place on every page (title bar, with or without tabs), and the tab row has nothing to scroll
  // up/down – nor sideways where the dialog is full width (design-005: „SSO & Proxy“ was 38 px too wide).
  const helpAt = async () => (await settings().getByRole('button', { name: 'Hilfe zu diesem Fenster' }).boundingBox())!;
  const first = await helpAt();
  for (const area of ['Anhänge', 'Werkzeuge', 'Backup', 'SSO & Proxy', 'KI & APIs', 'Darstellung', 'Konto']) {
    await settings().getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: area, exact: true }).click();
    const at = await helpAt();
    expect([area, at.x, at.y]).toEqual([area, first.x, first.y]);
    for (const tabs of await settings().getByRole('tablist').all()) {
      expect(await tabs.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
      expect([area, await tabs.evaluate((el) => el.scrollWidth - el.clientWidth)]).toEqual([area, 0]);
    }
  }
  await openSettings('E-Mail');
  await expect(settings().getByRole('tablist', { name: 'Benachrichtigungen' }).getByRole('tab')).toHaveText(['E-Mail', 'Pushover', 'Ereignisse', 'Updates']);
  // A group remembers its last tab.
  await openSettings('Prüfung');
  await settings().getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Konto', exact: true }).click();
  await settings().getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: 'Werkzeuge', exact: true }).click();
  await expect(settings().getByRole('tab', { name: 'Prüfung' })).toHaveAttribute('aria-selected', 'true');

  // Ereignisse: nothing chosen yet – nightly run, backup and security are on from the start, the rest off; e-mail is
  // not set up in this workspace → hint with a way there.
  await openSettings('Ereignisse');
  const table = settings().getByRole('table', { name: 'Ereignisse' });
  for (const name of ['Sync-Probleme per E-Mail', 'Sync-Probleme per Pushover']) await expect(table.getByRole('checkbox', { name })).not.toBeChecked();
  for (const name of ['Nachtlauf per Pushover', 'Backup per E-Mail', 'Sicherheit per E-Mail']) await expect(table.getByRole('checkbox', { name })).toBeChecked();
  await table.getByRole('checkbox', { name: 'Sync-Probleme per Pushover' }).check();
  await expect(table.getByRole('checkbox', { name: 'Sync-Probleme per Pushover' })).toBeChecked();
  await expect(settings()).toContainText('Pushover: noch nicht bereit');
  const rules = ((await (await page.request.get('/api/admin/notify')).json()) as { rules: { sync: { pushover: boolean }; nightly: { pushover: boolean } } }).rules;
  expect([rules.sync.pushover, rules.nightly.pushover]).toEqual([true, true]);
  await shot(page, '104-einstellungen-benachrichtigungen');
  await settings().getByRole('button', { name: 'Pushover einrichten' }).click();
  await expect(settings().getByRole('tab', { name: 'Pushover' })).toHaveAttribute('aria-selected', 'true');

  // Pushover: wrong key refused, right shape saved (never shown again), delivery problem named.
  await settings().getByLabel('API-Token der Anwendung').fill('zu-kurz');
  await settings().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(settings().getByRole('status')).toContainText('API-Token: 30 Zeichen');
  await settings().getByLabel('API-Token der Anwendung').fill('a'.repeat(30));
  await settings().getByLabel('User-Key (oder Gruppen-Key)').fill('u'.repeat(30));
  await settings().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(settings().getByRole('status')).toContainText('Gespeichert. Jetzt am besten eine Testnachricht senden.');
  await expect(settings()).toContainText('Pushover ist eingerichtet');
  await expect(settings().getByLabel('API-Token der Anwendung')).toHaveValue('');
  expect(JSON.stringify(await (await page.request.get('/api/admin/notify')).json())).not.toContain('a'.repeat(30));
  await shot(page, '105-einstellungen-pushover');
  // The E2E server points Pushover at a closed local port: never the real service.
  await settings().getByRole('button', { name: 'Testnachricht senden' }).click();
  await expect(settings().getByRole('status')).toContainText('Pushover nicht erreichbar (connect ECONNREFUSED');
  await settings().getByRole('button', { name: 'Zugang entfernen' }).click();
  await expect(settings()).toContainText('Pushover ist nicht eingerichtet');

  // Help per tab: #### anchors open the right place.
  await page.keyboard.press('F1');
  await expect(help().getByRole('heading', { name: 'Pushover', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(help()).toHaveCount(0);

  // Back to nothing chosen, for whatever runs next.
  expect((await page.request.put('/api/admin/notify', { data: { rules: { nightly: { pushover: false } } } })).ok()).toBe(true);
  await closeAll();
});

test('updates: a new release at the top right (closable per release), in the help and under Benachrichtigungen → Updates', async () => {
  test.setTimeout(90_000);
  // A fake GitHub release list on the local port the E2E server asks instead of the real one (playwright.config.ts).
  let release: Record<string, string> | null = null;
  const publish = (version: string, name = `Kaveyl Wiki ${version}`) =>
    (release = { tag_name: `v${version}`, name, html_url: `https://github.com/kaveyl/wiki/releases/tag/v${version}`, published_at: '2026-11-02T09:00:00Z' });
  const gh = createServer((_req, res) => {
    res.statusCode = release ? 200 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(release ?? { message: 'Not Found' }));
  });
  await new Promise<void>((r) => gh.listen(47820, '127.0.0.1', r));
  const badge = (name: string) => page.getByRole('link', { name, exact: true });
  try {
    await openSettings('Updates');
    await expect(settings().getByRole('checkbox', { name: 'Bei Updates benachrichtigen' })).toBeChecked();
    // No public release yet: nothing to show.
    await settings().getByRole('button', { name: 'Jetzt prüfen', exact: true }).click();
    await expect(settings()).toContainText('noch keine veröffentlicht');
    // Far above the running version (package.json), so the test does not age with each release.
    publish('9.0.0');
    await settings().getByRole('button', { name: 'Jetzt prüfen', exact: true }).click();
    await expect(settings().getByRole('link', { name: '9.0.0', exact: true })).toHaveAttribute('href', 'https://github.com/kaveyl/wiki/releases/tag/v9.0.0');
    // Only the dialog: the test notes behind it stay out of the manual.
    const box = (await settings().boundingBox())!;
    const restoreShot = await neutralize(page);
    await page.screenshot({ path: join(SHOTS, '120-einstellungen-updates.png'), clip: box });
    await restoreShot();
    // The help: right at the top, the running version and the new one.
    await openSettings('Hilfe');
    const version = settings().getByRole('region', { name: 'Version' });
    await expect(version).toContainText('Version 9.0.0 ist erschienen');
    await expect(version.getByRole('link', { name: 'Release-Notizen auf GitHub' })).toHaveAttribute('target', '_blank');
    await closeAll();
    // Top right next to help and settings; opens the release page in a new tab.
    await expect(badge('Neue Version 9.0.0')).toHaveAttribute('href', 'https://github.com/kaveyl/wiki/releases/tag/v9.0.0');
    await expect(badge('Neue Version 9.0.0')).toHaveAttribute('target', '_blank');
    const at = (await badge('Neue Version 9.0.0').boundingBox())!;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // no focus ring from closing the dialog
    const restore = await neutralize(page);
    await page.screenshot({ path: join(SHOTS, '121-update-hinweis.png'), clip: { x: at.x - 260, y: 0, width: 1360 - (at.x - 260), height: 120 } });
    await restore();
    // × closes it for this release – the help still has it; the next release (here a security update, red) shows again.
    await page.getByRole('button', { name: 'Hinweis auf Version 9.0.0 ausblenden' }).click();
    await expect(badge('Neue Version 9.0.0')).toHaveCount(0);
    await openSettings('Hilfe');
    await expect(settings().getByRole('region', { name: 'Version' })).toContainText('Version 9.0.0 ist erschienen');
    publish('9.0.1', 'Kaveyl Wiki 9.0.1 – Sicherheitsupdate');
    await openSettings('Updates');
    await settings().getByRole('button', { name: 'Jetzt prüfen', exact: true }).click();
    await expect(settings()).toContainText('Sicherheitsupdate');
    await closeAll();
    await expect(badge('Sicherheitsupdate 9.0.1')).toBeVisible();
    // Switched off: no hint anywhere, no more checks.
    await openSettings('Updates');
    // The box follows the server's answer, so click and wait instead of uncheck()/check().
    await settings().getByRole('checkbox', { name: 'Bei Updates benachrichtigen' }).click();
    await expect(settings().getByRole('checkbox', { name: 'Bei Updates benachrichtigen' })).not.toBeChecked();
    await expect(settings().getByRole('button', { name: 'Jetzt prüfen', exact: true })).toHaveCount(0);
    await openSettings('Hilfe');
    await expect(settings().getByRole('region', { name: 'Version' })).not.toContainText('erschienen');
    await closeAll(); // the open dialog hides the rest of the page from the accessibility tree
    await expect(badge('Sicherheitsupdate 9.0.1')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Einstellungen', exact: true })).toBeVisible();
    await openSettings('Updates');
    await settings().getByRole('checkbox', { name: 'Bei Updates benachrichtigen' }).click();
    await expect(settings().getByRole('checkbox', { name: 'Bei Updates benachrichtigen' })).toBeChecked();
    await expect(settings().getByRole('button', { name: 'Jetzt prüfen', exact: true })).toBeVisible();
    await closeAll();
    await expect(badge('Sicherheitsupdate 9.0.1')).toBeVisible();
  } finally {
    // Nothing left for the specs after this one (their pictures): no release, hint gone.
    release = null;
    await page.request.post('/api/admin/updates/check', { data: {} });
    await page.request.put('/api/admin/updates', { data: { enabled: true } });
    await new Promise<void>((r) => gh.close(() => r()));
    await closeAll();
  }
  await page.reload();
  await expect(page.getByRole('link', { name: /Neue Version|Sicherheitsupdate/ })).toHaveCount(0);
});

test('input windows inside Kaveyl Wiki (never the browser): link and formula from the slash menu', async () => {
  // A native prompt()/confirm() would fail the test.
  const native: string[] = [];
  page.on('dialog', (d) => (native.push(d.message()), void d.dismiss()));
  await tree().getByText('stand', { exact: true }).first().click();
  const editor = page.locator('.prose-note[contenteditable="true"]').filter({ visible: true });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/link');
  await page.getByRole('button', { name: /URL oder Pfad zu einer Notiz/ }).click();
  const link = page.getByRole('dialog', { name: 'Link einfügen' });
  await expect(link.getByLabel('Link-Ziel')).toBeFocused();
  await expect(link.getByRole('button', { name: 'Einfügen' })).toBeDisabled();
  await link.getByLabel('Link-Ziel').fill('https://example.org/doku');
  await link.getByLabel('Linktext').fill('Doku');
  await shot(page, '107-link-einfuegen');
  await page.keyboard.press('Enter');
  await expect(link).toHaveCount(0);
  await expect.poll(() => readFileSync(join(NOTES, 'stand.md'), 'utf8'), { timeout: 10_000 }).toContain('[Doku](https://example.org/doku)');
  // Esc cancels: only the „/…“ goes, the settings or note stay as they were.
  await page.keyboard.type('/formel');
  await page.getByRole('button', { name: /Formel im Text/ }).click();
  const formula = page.getByRole('dialog', { name: 'Formel (LaTeX)' });
  await expect(formula.getByLabel('LaTeX')).toHaveValue('x^2');
  await page.keyboard.press('Escape');
  await expect(formula).toHaveCount(0);
  await expect(editor).toBeVisible();
  expect(native).toEqual([]);
  page.removeAllListeners('dialog');
});

test('links: www.… without https:// opens the web page; right-click shows Kaveyl Wiki’s link menu, not the bubble', async () => {
  // Never the real Google: answer any request there locally.
  await page.context().route('https://www.google.de/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google (Test)</title>ok' }));
  // A link written elsewhere without scheme.
  writeFileSync(join(NOTES, 'weblinks.md'), '# Weblinks\n\nSuche bei [Google](www.google.de) oder [Notiz](stand.md).\n');
  await waitIndexed(page, 'Notizen', ['weblinks.md']);
  await expect(tree().getByText('weblinks', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await tree().getByText('weblinks', { exact: true }).first().click();
  const editor = page.locator('.prose-note[contenteditable="true"]').filter({ visible: true });
  const google = editor.getByRole('link', { name: 'Google' });
  const popup = page.context().waitForEvent('page');
  await google.click();
  const opened = await popup;
  expect(opened.url()).toBe('https://www.google.de/');
  await opened.close();
  // Right-click on the link: Kaveyl Wiki's menu; no formatting bubble beside it.
  await google.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Link' });
  await expect(menu).toContainText('https://www.google.de');
  await expect(menu.getByRole('menuitem')).toHaveText(['Im Browser öffnen', 'Link kopieren', 'Link bearbeiten …', 'Link entfernen']);
  await expect(page.getByRole('button', { name: 'Fett' })).toHaveCount(0);
  await shot(page, '108-link-menue');
  // Edit: a bare address typed into the window is saved with https://.
  await menu.getByRole('menuitem', { name: 'Link bearbeiten …' }).click();
  const edit = page.getByRole('dialog', { name: 'Link bearbeiten' });
  await expect(edit.getByLabel('Link-Ziel')).toHaveValue('www.google.de');
  await edit.getByLabel('Link-Ziel').fill('www.google.de/suche');
  await page.keyboard.press('Enter');
  await expect.poll(() => readFileSync(join(NOTES, 'weblinks.md'), 'utf8'), { timeout: 10_000 }).toContain('[Google](https://www.google.de/suche)');
  // A link to a note offers a new tab; „Link entfernen“ keeps the text.
  await editor.getByRole('link', { name: 'Notiz' }).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Link' }).getByRole('menuitem', { name: 'In neuem Tab öffnen' })).toBeVisible();
  await page.getByRole('menu', { name: 'Link' }).getByRole('menuitem', { name: 'Link entfernen' }).click();
  await expect.poll(() => readFileSync(join(NOTES, 'weblinks.md'), 'utf8'), { timeout: 10_000 }).toContain('oder Notiz.');
  await page.context().unroute('https://www.google.de/**');
});
