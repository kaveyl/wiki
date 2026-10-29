// UX additions after Phase 3 (pinned tabs, favorites menu, manual order, icons, images).
// Runs after the other specs in the same seeded workspace (admin + local mount "Notizen").
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join, resolve } from 'node:path';
import { waitIndexed } from './indexed';
import { openSettingsPage } from './settings-nav';
import { shot } from './shots';

const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
const read = (name: string) => (existsSync(join(NOTES, name)) ? readFileSync(join(NOTES, name), 'utf8') : '');

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(tree().getByText('Notizen', { exact: true }).first()).toBeVisible();
});

const tree = () => page.locator('aside nav[aria-label="Quellen"]');
const tabs = () => page.locator('[data-tab]');

/** Opens a note by its name in the tree (file name without .md). */
async function openNote(name: string) {
  await expect(tree().getByText(name, { exact: true }).first()).toBeVisible();
  await tree().getByText(name, { exact: true }).first().click();
  await expect(page.locator('.prose-note').filter({ visible: true })).toBeVisible();
}

test('a pinned tab moves left and is not replaced when another note opens', async () => {
  await openNote('roadmap');
  const open = await tabs().evaluateAll((els) => els.map((e) => e.getAttribute('data-tab')));
  for (const path of open) if (path !== 'plan/roadmap.md') await page.locator(`[data-tab="${path}"]`).first().click({ button: 'middle' });
  await expect(tabs()).toHaveCount(1);
  await openNote('trilium');
  // A plain click replaces the active tab's note …
  await expect(tabs()).toHaveCount(1);
  await page.locator('[data-tab="trilium.md"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Tab anheften' }).click();
  await expect(page.locator('[data-tab="trilium.md"]')).toHaveAttribute('data-pinned', '');
  // … but not a pinned one: the next note gets its own tab after the pinned ones.
  await openNote('roadmap');
  await expect(tabs()).toHaveCount(2);
  await expect(tabs().nth(0)).toHaveAttribute('data-tab', 'trilium.md');
  await expect(tabs().nth(1)).toHaveAttribute('data-tab', 'plan/roadmap.md');
  // Middle click and "close others" leave the pinned tab alone.
  await tabs().nth(0).click({ button: 'middle' });
  await expect(tabs()).toHaveCount(2);
  await tabs().nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Andere Tabs schließen' }).click();
  await expect(tabs()).toHaveCount(2);
  // Pinning a later tab moves it in front of the unpinned ones.
  // Middle click opens in a new tab (Ctrl+click marks in the tree since 28.10.).
  await tree().getByText('Detailseite', { exact: true }).first().click({ button: 'middle' });
  await expect(tabs()).toHaveCount(3);
  await expect(tabs().nth(2)).toHaveAttribute('data-tab', /^plan\/(D|d)etail/);
  await page.locator('[data-tab^="plan/"][data-tab*="etail"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Tab anheften' }).click();
  await expect(tabs().nth(1)).toHaveAttribute('data-tab', /^plan\/(D|d)etail/);
  await shot(page, '50-angeheftet');
  // Survives a reload (workspace is stored on the server).
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator('[data-tab="trilium.md"]')).toHaveAttribute('data-pinned', '');
  await page.getByRole('button', { name: 'Tab lösen' }).first().click();
  await expect(page.locator('[data-pinned]')).toHaveCount(1);
});

test('favorites: a folder without folder note, context menu in the favorites list removes it', async () => {
  const aside = page.locator('aside');
  await tree().getByText('plan', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Zu Favoriten' }).click();
  const favs = aside.locator('div.mb-1', { has: page.getByText('Favoriten', { exact: true }) });
  const row = favs.locator('[title="Notizen / plan"]');
  await expect(row).toBeVisible();
  // Clicking shows the folder unfolded in the tree (there is nothing to open).
  await tree().getByText('plan', { exact: true }).first().click();
  await expect(tree().getByText('roadmap', { exact: true })).toBeHidden();
  await row.click();
  await expect(tree().getByText('roadmap', { exact: true })).toBeVisible();
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'In neuem Tab öffnen' })).toBeHidden();
  await shot(page, '51-favoriten-menue');
  await page.getByRole('menuitem', { name: 'Aus Favoriten entfernen' }).click();
  await expect(row).toBeHidden();
  // Notes in the list get the full menu.
  const note = favs.locator('[title^="Notizen / plan/"]').first();
  await note.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rechts daneben öffnen' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('manual order: sources by drag & drop and menu, notes up/down, back to alphabetical', async () => {
  const header = (name: string) => tree().locator('[data-mount]', { hasText: name }).first();
  const mountNames = async () => (await tree().locator('[data-mount] [data-mount-name]').allInnerTexts()).map((t) => t.trim());
  const before = await mountNames();
  // "Archiv" is not first (with the Gitea test source, another source may sit above it).
  const a = before.indexOf('Archiv');
  expect(a).toBeGreaterThan(0);
  const above = before[a - 1]!;
  await header('Archiv').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Anordnen' }).click();
  await page.getByRole('menuitem', { name: 'Quelle nach oben' }).click();
  const swapped = [...before];
  [swapped[a - 1], swapped[a]] = [before[a]!, above];
  await expect.poll(mountNames).toEqual(swapped);
  // Drag the source that was above onto the upper edge of "Archiv": back where it was.
  await header(above).dragTo(header('Archiv'), { targetPosition: { x: 60, y: 2 } });
  await expect.poll(mountNames).toEqual(before);
  await page.reload();
  await expect.poll(mountNames).toEqual(before);

  // Notes: one place up via the context menu (written to .kaveyl-wiki.yml of the folder).
  const row = (t: string) => tree().locator('[data-node]', { hasText: t }).first();
  const names = async () => (await tree().locator('[data-node]').allInnerTexts()).map((t) => t.trim());
  if (!(await row('roadmap').isVisible())) await row('plan').click();
  const plan = async () => (await names()).filter((n) => ['Detailseite', 'format', 'tagged', 'roadmap'].includes(n));
  const start = await plan();
  const i = start.indexOf('roadmap');
  await row('roadmap').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Anordnen' }).click();
  await expect(page.getByRole('menuitem', { name: i > 0 ? 'Nach oben' : 'Nach unten' })).toBeVisible();
  await shot(page, '52-sortierung');
  await page.getByRole('menuitem', { name: i > 0 ? 'Nach oben' : 'Nach unten' }).click();
  const moved = [...start];
  moved.splice(i, 1);
  moved.splice(i > 0 ? i - 1 : 1, 0, 'roadmap');
  await expect.poll(plan).toEqual(moved);
  await expect.poll(() => read('plan/.kaveyl-wiki.yml')).toContain('- roadmap.md');
  // Back to alphabetical for the folder: the order key (and here the whole file) goes away.
  await row('plan').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Anordnen' }).click();
  await page.getByRole('menuitem', { name: 'Inhalt alphabetisch sortieren' }).click();
  await expect.poll(() => existsSync(join(NOTES, 'plan/.kaveyl-wiki.yml'))).toBe(false);
  await expect.poll(plan).toEqual([...start].sort((a, b) => a.localeCompare(b, 'de')));
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('icons: all Lucide symbols by category and search, uploaded custom icons', async () => {
  await openNote('kolibri');
  const iconButton = page.getByRole('button', { name: 'Icon der Notiz' }).filter({ visible: true });
  await iconButton.click();
  // Category "Wetter" loads the full set; an icon outside the common set.
  await page.getByLabel('Kategorie').selectOption({ label: 'Wetter' });
  await page.getByRole('button', { name: 'Symbol cloud-sun', exact: true }).click();
  await expect.poll(() => read('kolibri.md'), { timeout: 10_000 }).toContain('icon: lucide:cloud-sun');
  const row = tree().locator('[data-node$=":kolibri.md"]');
  await expect(row.locator('svg.lucide-cloud-sun')).toBeVisible();
  // Search (names and tags are English).
  await iconButton.click();
  await page.getByLabel('Symbol suchen').fill('bird');
  await expect(page.getByRole('button', { name: 'Symbol bird', exact: true })).toBeVisible();
  await shot(page, '53-icon-suche');
  await page.keyboard.press('Escape');

  // Own icon: upload picks it right away; shown in the tree as an image, also after a reload.
  await iconButton.click();
  await page.getByRole('tab', { name: 'Eigene' }).click();
  await page.getByLabel('Icon-Datei').setInputFiles({ name: 'kolibri-logo.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => read('kolibri.md'), { timeout: 10_000 }).toMatch(/icon: custom:[0-9a-f]{12}/);
  await expect(row.locator('img')).toBeVisible();
  await page.reload();
  await expect(tree().locator('[data-node$=":kolibri.md"] img')).toBeVisible();
  // The picture: the own icon in the list – before the refused file below (no error message in the manual).
  await page.getByRole('button', { name: 'Icon der Notiz' }).filter({ visible: true }).click();
  await page.getByRole('tab', { name: 'Eigene' }).click();
  await expect(page.getByRole('button', { name: 'Eigenes Icon kolibri-logo' })).toBeVisible();
  await shot(page, '54-eigene-icons');
  // Not an image: rejected with a message.
  await page.getByLabel('Icon-Datei').setInputFiles({ name: 'boese.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<html>kein svg</html>') });
  await expect(page.getByText('Erlaubt sind PNG, WebP, JPEG, GIF und SVG')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Eigenes Icon kolibri-logo' })).toBeVisible();
  await page.getByRole('button', { name: 'Kein Icon' }).click();
  await expect.poll(() => read('kolibri.md'), { timeout: 10_000 }).not.toContain('icon:');
});

test('images: align left/center/right, preset widths, drag the corner, back to original', async () => {
  writeFileSync(join(NOTES, 'assets/diagramm.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#4f46e5"/></svg>');
  writeFileSync(join(NOTES, 'bildgroesse.md'), '# Bildgröße\n\n![Diagramm](assets/diagramm.svg)\n\nText danach.\n');
  await openNote('bildgroesse');
  const image = page.locator('.prose-note .note-image').filter({ visible: true });
  await expect(image.locator('img')).toHaveJSProperty('naturalWidth', 400);
  await image.locator('img').click();
  await page.getByRole('button', { name: 'Zentriert' }).click();
  await expect.poll(() => read('bildgroesse.md'), { timeout: 10_000 }).toContain('<div align="center">\n\n![Diagramm](assets/diagramm.svg)\n\n</div>\n\nText danach.');
  // Presets are relative to the image itself (400 px), not to the text column.
  await page.getByRole('button', { name: '50 % der Originalgröße' }).click();
  await expect.poll(() => read('bildgroesse.md'), { timeout: 10_000 }).toContain('<img src="assets/diagramm.svg" alt="Diagramm" width="200">');
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(200);
  await expect(page.getByRole('button', { name: '50 % der Originalgröße' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '25 % der Originalgröße' }).click();
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBe(100);
  await page.getByRole('button', { name: 'Spaltenbreite' }).click();
  await expect.poll(() => read('bildgroesse.md'), { timeout: 10_000 }).toContain('width="100%"');
  await expect.poll(async () => Math.round((await image.boundingBox())!.width)).toBeGreaterThan(600);
  await page.getByRole('button', { name: '75 % der Originalgröße' }).click();
  await expect.poll(() => read('bildgroesse.md'), { timeout: 10_000 }).toContain('width="300"');
  await shot(page, '55-bild-zentriert');
  // Corner handle: drag 120 px to the left → a pixel width.
  const before = (await image.boundingBox())!;
  await image.hover();
  const handle = image.locator('.note-image-handle');
  const h = (await handle.boundingBox())!;
  const [cx, cy] = [h.x + h.width / 2, h.y + h.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy, { steps: 4 });
  await page.mouse.move(cx - 120, cy, { steps: 4 });
  await page.mouse.up();
  const width = Math.round(before.width - 120);
  await expect.poll(() => read('bildgroesse.md'), { timeout: 10_000 }).toMatch(new RegExp(`width="(${width - 2}|${width - 1}|${width}|${width + 1}|${width + 2})"`));
  await image.locator('img').click();
  await page.getByRole('button', { name: 'Rechts' }).click();
  await expect.poll(() => read('bildgroesse.md'), { timeout: 10_000 }).toContain('<div align="right">');
  await page.getByRole('button', { name: 'Links', exact: true }).click();
  await page.getByRole('button', { name: 'Originalgröße', exact: true }).click();
  await expect.poll(() => read('bildgroesse.md'), { timeout: 10_000 }).toBe('# Bildgröße\n\n![Diagramm](assets/diagramm.svg)\n\nText danach.\n');
});

test('code blocks: the detected language is shown and adopted with one click; source icons', async () => {
  writeFileSync(join(NOTES, 'codeerkennung.md'), '# Codeerkennung\n\n```\nservices:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n```\n');
  await waitIndexed(page, 'Notizen', ['codeerkennung.md']);
  await expect(tree().getByText('codeerkennung', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await openNote('codeerkennung');
  await page.locator('.prose-note pre').filter({ visible: true }).getByText('services:').click();
  const select = page.getByLabel('Sprache des Codeblocks').filter({ visible: true });
  await expect(select.locator('option').first()).toHaveText('Automatisch: yaml');
  await shot(page, '56-code-erkennung');
  await page.getByRole('button', { name: 'übernehmen' }).filter({ visible: true }).click();
  await expect.poll(() => read('codeerkennung.md'), { timeout: 10_000 }).toContain('```yaml\nservices:');
  await expect(select.locator('option[value="powershell"]')).toHaveCount(1);
  // The kind is always shown right of the name: the versioned test folder "Archiv" is a local folder with Git.
  const archiv = tree().locator('[data-mount]', { hasText: 'Archiv' });
  await expect(archiv.getByRole('img', { name: 'Lokaler Ordner mit Git' })).toBeVisible();
  await expect(tree().locator('[data-mount]', { hasText: 'Notizen' }).first().getByRole('img', { name: 'Lokaler Ordner', exact: true })).toBeVisible();
  await expect(archiv.getByText('Archiv', { exact: true })).toHaveAttribute('title', /^Lokaler Ordner in einem Git-Repository/);
});

test('copy, cut and paste notes in the tree (menu and Ctrl+C/V), also into another source', async () => {
  const ARCHIV = resolve(NOTES, '../archiv');
  // Menu: copy a note into a folder.
  await tree().getByText('trilium', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Kopieren/ }).click();
  await tree().getByText('plan', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Einfügen „trilium“/ }).click();
  await expect.poll(() => read('plan/trilium.md'), { timeout: 10_000 }).toContain('Erster Absatz über Hierarchien.');
  expect(read('trilium.md')).toContain('Erster Absatz über Hierarchien.');
  // The file is there before the server answers; wait until the app shows the copy, so the next click is not undone.
  await expect(tree().locator('[data-node$=":plan/trilium.md"]').first()).toHaveClass(/bg-active/, { timeout: 15_000 });
  // Keyboard: select the note in the tree, Ctrl+C, Ctrl+V → copy next to it (the top-level one,
  // not the copy in "plan" if that folder is open).
  await tree().locator('[data-node$=":trilium.md"]').first().click();
  // The click opens the note, and the editor takes the focus a moment later: wait for it, then
  // put the focus back on the tree — otherwise Ctrl+C may land in the editor.
  await expect(page.locator('.prose-note[contenteditable="true"]').filter({ visible: true })).toBeVisible();
  await tree().focus();
  await expect(tree()).toBeFocused();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(() => read('trilium (Kopie).md'), { timeout: 10_000 }).toContain('Erster Absatz');
  await expect(tree().getByText('trilium (Kopie)', { exact: true })).toBeVisible();
  // Cut + paste on another source moves it there.
  await tree().getByText('trilium (Kopie)', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ausschneiden' }).click();
  await shot(page, '57-kopieren-einfuegen');
  await tree().locator('[data-mount]', { hasText: 'Archiv' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Einfügen „trilium \(Kopie\)“/ }).click();
  await expect.poll(() => existsSync(join(ARCHIV, 'trilium (Kopie).md')), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => existsSync(join(NOTES, 'trilium (Kopie).md')), { timeout: 10_000 }).toBe(false);
  // Done when the app shows the moved note at its new place (it opens „Archiv“ for that) – not
  // only when the file is there; the next test starts by closing everything. The request also rewrites links and
  // queues the commits: under load it answers after the file is gone, so wait as long as for the file above.
  await expect(tree().locator('[data-node$=":trilium (Kopie).md"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(tree().locator('[data-node$=":trilium (Kopie).md"]')).toBeVisible();
  // The row can show up before the answer (the tree reloads on the file event); the app opens „Archiv“
  // with the answer, together with this message – later it would reopen the tree the next test closes.
  await expect(page.getByText('Verschoben nach Archiv', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});

test('expand and collapse: everything, per source and per folder; "+" makes notes and folders', async () => {
  const sidebar = page.locator('aside');
  await sidebar.getByRole('button', { name: 'Alles zuklappen' }).click();
  await expect(tree().getByText('roadmap', { exact: true })).toHaveCount(0);
  await expect(tree().getByText('plan', { exact: true })).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'Alles aufklappen' }).click();
  await expect(tree().getByText('roadmap', { exact: true }).first()).toBeVisible();
  await shot(page, '58-alles-aufgeklappt');
  // Buttons in the row on hover (no context menu entries any more).
  const header = tree().locator('[data-mount]', { hasText: 'Notizen' }).first();
  await header.hover();
  await header.getByRole('button', { name: 'Alle Ordner zuklappen' }).click();
  await expect(tree().getByText('roadmap', { exact: true })).toHaveCount(0);
  const plan = tree().locator('[data-node]', { hasText: 'plan' }).first();
  await expect(plan).toBeVisible();
  await plan.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /darunter (auf|zu)klappen/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await plan.hover();
  // Same toolbar on every folder, also without sub-folders: there the toggle opens/closes the folder.
  await expect(plan.getByRole('button', { name: /Alles darunter (auf|zu)klappen/ })).toBeVisible();
  await plan.getByRole('button', { name: 'Neu …' }).click();
  await expect(page.getByRole('menuitem', { name: 'Neue Notiz' })).toBeVisible();
  await shot(page, '59-ordner-neu');
  await page.getByRole('menuitem', { name: 'Neuer Ordner' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').first().fill('Unterordner');
  await dialog.getByRole('textbox').first().press('Enter');
  await expect.poll(() => existsSync(join(NOTES, 'plan/Unterordner'))).toBe(true);
  await expect(tree().getByText('Unterordner', { exact: true }).first()).toBeVisible();
  // Now "plan" has a sub-folder. Alt+click on the arrow closes it all …
  await plan.hover();
  await expect(plan.getByRole('button', { name: /Alles darunter (auf|zu)klappen/ })).toBeVisible();
  await plan.locator('span').first().click({ modifiers: ['Alt'] });
  await expect(tree().getByText('Unterordner', { exact: true })).toHaveCount(0);
  // … the toggle opens everything below again.
  await plan.hover();
  await plan.getByRole('button', { name: 'Alles darunter aufklappen' }).click();
  await expect(tree().getByText('Unterordner', { exact: true }).first()).toBeVisible();
});

test('trash: a deleted folder comes back from the sidebar trash; emptying asks first', async () => {
  const del = async () => {
    await tree().locator('[data-node]', { hasText: 'Unterordner' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Löschen', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Papierkorb');
    await page.getByRole('dialog').getByRole('button', { name: 'Löschen', exact: true }).click();
    await expect.poll(() => existsSync(join(NOTES, 'plan/Unterordner'))).toBe(false);
  };
  await del();
  // Source without auto-commit: kept in .kaveyl-wiki/trash of the folder.
  expect(existsSync(join(NOTES, '.kaveyl-wiki/trash'))).toBe(true);
  await page.locator('aside').getByRole('button', { name: 'Papierkorb', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Papierkorb' });
  await dialog.getByLabel('Quelle').selectOption({ label: 'Notizen' });
  await expect(dialog).toContainText('plan/Unterordner (1 Notiz)');
  await shot(page, '60-papierkorb');
  await dialog.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
  await expect.poll(() => existsSync(join(NOTES, 'plan/Unterordner/index.md'))).toBe(true);
  await expect(dialog).toContainText('Der Papierkorb ist leer.');
  await page.keyboard.press('Escape');

  await del();
  await page.locator('aside').getByRole('button', { name: 'Papierkorb', exact: true }).click();
  await dialog.getByLabel('Quelle').selectOption({ label: 'Notizen' });
  await dialog.getByRole('button', { name: 'Papierkorb leeren' }).click();
  await dialog.getByRole('button', { name: 'Ja, leeren' }).click();
  await expect(dialog).toContainText('Der Papierkorb ist leer.');
  await expect.poll(() => readdirSync(join(NOTES, '.kaveyl-wiki/trash')).filter((f) => f !== '.gitignore')).toEqual([]);
  await page.keyboard.press('Escape');
});

test('dialogs: a click beside closes nothing, Esc only the top one, "Zurück" to Settings, unsaved input asks, focus returns', async () => {
  const dialogs = page.getByRole('dialog');
  const settingsButton = page.getByRole('button', { name: 'Einstellungen' }).first();
  await settingsButton.click();
  const settings = page.getByRole('dialog', { name: 'Einstellungen' });
  await expect(settings).toBeVisible();
  // Source icons are symbols, never their "lucide:…" name as text.
  await expect(settings).not.toContainText('lucide:');
  await page.mouse.click(page.viewportSize()!.width - 5, page.viewportSize()!.height / 2);
  await expect(settings).toBeVisible();
  // The wizard opens on top of the settings; "Zurück" and Esc go back there.
  await openSettingsPage(page, 'Eingebundene Quellen');
  await settings.getByRole('button', { name: 'Quelle einbinden' }).click();
  const wizard = page.getByRole('dialog', { name: 'Quelle einbinden' });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: 'Zurück' }).click();
  await expect(wizard).toHaveCount(0);
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Quelle einbinden' }).click();
  await expect(wizard).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(wizard).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Quelle einbinden' })).toBeFocused();
  // Repository trash: one sentence, a plain empty state, details folded away (tab „Eingebundene Quellen“).
  await settings.getByRole('tab', { name: 'Eingebundene Quellen' }).click();
  const repoTrash = settings.getByRole('region', { name: 'Gelöschte Repositories' });
  await expect(repoTrash).toContainText('Keine gelöschten Repositories');
  await expect(repoTrash.getByText('Technische Details')).toBeVisible();
  await expect(repoTrash.getByText('/config/backups/repos', { exact: false }).first()).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(dialogs).toHaveCount(0);
  await expect(settingsButton).toBeFocused();

  // Typed a name: Esc asks first; "no" keeps the dialog and the input.
  const plan = tree().locator('[data-node]', { hasText: 'plan' }).first();
  await plan.hover();
  await plan.getByRole('button', { name: 'Neu …' }).click();
  await page.getByRole('menuitem', { name: 'Neue Notiz' }).click();
  const create = page.getByRole('dialog', { name: 'Neue Notiz' });
  await create.getByRole('textbox').first().fill('nicht speichern');
  // Esc asks in a Kaveyl Wiki window; Esc again (or „Weiter bearbeiten“) keeps the input and the dialog.
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog', { name: 'Ungespeicherte Eingaben verwerfen?' });
  await expect(ask).toBeVisible();
  await shot(page, '87-rueckfrage');
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(create).toBeVisible();
  await expect(create.getByRole('textbox').first()).toHaveValue('nicht speichern');
  await create.getByRole('button', { name: 'Schließen' }).click();
  await ask.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  await expect(create).toBeVisible();
  await create.getByRole('button', { name: 'Schließen' }).click();
  await ask.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(create).toHaveCount(0);
  expect(existsSync(join(NOTES, 'plan/nicht speichern.md'))).toBe(false);
});

test('dialogs from the tree menu: the field gets the focus, Esc returns it to the row', async () => {
  const plan = tree().locator('[data-node]', { hasText: 'plan' }).first();
  const create = page.getByRole('dialog', { name: 'Neue Notiz' });
  const title = create.getByRole('textbox').first();
  const openCreate = async () => {
    await plan.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Neue Notiz hier', exact: true }).click();
    await expect(create).toBeVisible();
  };
  // The menu is still open while the dialog mounts – typing must land in the title field anyway.
  await openCreate();
  await expect(title).toBeFocused();
  await page.keyboard.type('abc');
  await expect(title).toHaveValue('abc');
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog', { name: 'Ungespeicherte Eingaben verwerfen?' }).getByRole('button', { name: 'Verwerfen' }).click();
  await expect(create).toHaveCount(0);
  // Untouched: Esc closes at once and the focus is back on the row (the menu item is gone by then).
  await openCreate();
  await expect(title).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(create).toHaveCount(0);
  await expect(plan).toBeFocused();
  expect(existsSync(join(NOTES, 'plan/abc.md'))).toBe(false);
});

test('connections: GitHub/GitLab/Git in Settings → Quellen, used by the wizard; address fixed while in use (no network)', async () => {
  await page.getByRole('button', { name: 'Einstellungen' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Einstellungen' });
  await openSettingsPage(page, 'Verbindungen');
  const panel = settings.getByRole('region', { name: 'Verbindungen' });
  // Webhook state (AD-033) – the hoster calls are answered here, nothing reaches github.com; the row asks once it appears.
  const hook = { url: 'http://127.0.0.1:18093/api/webhooks/git', repos: ['alex/wiki'], supported: true, unreachable: true };
  // The hooks „at the hoster“: one on the repository, one on the account (Gitea).
  const at = { repo: false, account: false };
  // `account`: answer like Gitea with account hooks (the admin chooses the way); `ways` records what was chosen, `deletes` the DELETE queries.
  let account = false;
  const ways: string[] = [];
  const deletes: string[] = [];
  const status = () => {
    const place = (scope: 'account' | 'repo', name: string) => ({ scope, name, action: 'remove' });
    return {
      ...hook,
      ...(account ? { account: 'alex' } : {}),
      hooks: [
        ...(at.account ? [{ scope: 'account', name: 'alex', at: hook.url, current: true, active: true }] : []),
        ...(at.repo ? [{ scope: 'repo', name: 'alex/wiki', at: hook.url, current: true, active: true, ...(at.account ? { double: true } : {}) }] : []),
      ],
      uncovered: at.repo || at.account ? [] : ['alex/wiki'],
      plans: {
        repos: [...(at.repo ? [] : [{ scope: 'repo', name: 'alex/wiki', action: 'create' }]), ...(at.account ? [place('account', 'alex')] : [])],
        ...(account ? { account: [...(at.account ? [] : [{ scope: 'account', name: 'alex', action: 'create' }]), ...(at.repo ? [place('repo', 'alex/wiki')] : [])] } : {}),
        remove: [...(at.account ? [place('account', 'alex')] : []), ...(at.repo ? [place('repo', 'alex/wiki')] : [])],
      },
    };
  };
  await page.route('**/api/connections/*/webhook*', (route) => {
    const req = route.request();
    const before = { ...at };
    if (req.method() === 'POST') {
      const way = (req.postDataJSON() as { way: string }).way;
      ways.push(way);
      if (way === 'account') Object.assign(at, { account: true, repo: false });
      else Object.assign(at, { repo: true, account: false });
    }
    if (req.method() === 'DELETE') {
      const q = new URL(req.url()).searchParams;
      deletes.push(q.toString());
      if (!q.get('scope') || q.get('scope') === 'repo') at.repo = false;
      if (!q.get('scope') || q.get('scope') === 'account') at.account = false;
    }
    const name = { repo: 'alex/wiki', account: 'alex' } as const;
    const keys = ['account', 'repo'] as const;
    const changes =
      req.method() === 'GET'
        ? {}
        : {
            changes: {
              created: keys.filter((k) => !before[k] && at[k]).map((k) => name[k]),
              moved: [],
              removed: keys.filter((k) => before[k] && !at[k]).map((k) => name[k]),
            },
          };
    return route.fulfill({ json: { ...status(), ...changes } });
  });
  // GitHub needs a token; the address defaults to github.com.
  await panel.getByRole('button', { name: 'Verbindung hinzufügen' }).click();
  const form = panel.getByRole('form', { name: 'Neue Verbindung' });
  await form.getByRole('radio', { name: 'GitHub' }).click();
  await expect(form.getByLabel('Adresse')).toHaveValue('https://github.com');
  await expect(form.getByRole('button', { name: 'Verbindung anlegen' })).toBeDisabled();
  await form.getByLabel('Token').fill('ghp_e2e_nicht_echt');
  await form.getByRole('button', { name: 'Verbindung anlegen' }).click();
  const github = panel.getByRole('listitem').filter({ hasText: 'GitHub (github.com)' });
  await expect(github).toContainText('mit Token · 0 Quellen');
  await expect(github).toContainText('Kein Webhook eingerichtet – Abgleich alle 5 Min.');
  await github.getByRole('button', { name: 'Webhook prüfen' }).click();
  // Only hooks that exist are listed (owner 26.10.): none – no line per repository, nothing to remove.
  await expect(github).not.toContainText('alex/wiki');
  await expect(github.getByRole('button', { name: /entfernen/i })).toHaveCount(0);
  await expect(github).toContainText('GitHub erreicht http://127.0.0.1:18093/api/webhooks/git nicht');
  // The question names what happens (owner 25.10.), the answer what happened.
  await github.getByRole('button', { name: 'Webhook einrichten' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Webhook bei GitHub – das passiert:');
  await expect(ask).toContainText('alex/wiki: anlegen');
  await ask.getByRole('button', { name: 'Einrichten' }).click();
  await expect(github).toContainText('Webhook am Repository alex/wiki');
  await expect(github).toContainText('Angelegt: alex/wiki');
  // All set: the button says so, and a click asks nothing – it says there is nothing to do.
  await expect(github.getByRole('button', { name: 'Webhook eingerichtet' })).toBeVisible();
  await github.getByRole('button', { name: 'Webhook eingerichtet' }).click();
  await expect(github).toContainText('Nichts zu tun – alles war schon so eingerichtet.');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  // One hook: its own button removes it; afterwards the row says there is no webhook and lists nothing.
  await expect(github.getByRole('button', { name: 'Alle entfernen' })).toHaveCount(0);
  await github.getByRole('button', { name: 'Webhook am Repository alex/wiki entfernen' }).click();
  const del = page.getByRole('alertdialog');
  await expect(del).toContainText('Webhook bei GitHub entfernen – das passiert:');
  await expect(del).toContainText('alex/wiki: entfernen');
  await expect(del).toContainText('Danach holt Kaveyl Wiki Änderungen wieder alle 5 Minuten.');
  await del.getByRole('button', { name: 'Entfernen' }).click();
  await expect(github).toContainText('Entfernt: alex/wiki');
  await expect(github).toContainText('Kein Webhook eingerichtet – Abgleich alle 5 Min.');
  await expect(github).not.toContainText('Webhook am Repository');
  await expect(github.getByRole('button', { name: /entfernen/i })).toHaveCount(0);
  // With account hooks (Gitea) the question offers both ways and says what the account hook covers (owner 25.10.).
  account = true;
  await github.getByRole('button', { name: 'Webhook prüfen' }).click();
  await github.getByRole('button', { name: 'Webhook einrichten' }).click();
  const choose = page.getByRole('alertdialog');
  await expect(choose).toContainText('Webhook bei GitHub – wofür?');
  await expect(choose.getByRole('radio', { name: /Nur die eingebundenen Repositories/ })).toBeChecked();
  await expect(choose).toContainText('Konto alex: anlegen');
  await expect(choose).toContainText('Gilt für alle Repositories von alex, auch künftige');
  await choose.getByRole('radio', { name: /Dein ganzes Konto alex/ }).check();
  await choose.getByRole('button', { name: 'Einrichten' }).click();
  // The account hook is one line – no tick at the repository, where there is none (owner 26.10.).
  await expect(github).toContainText('Webhook am Konto alex – meldet Pushes aus allen deinen Repositories');
  await expect(github).not.toContainText('Webhook am Repository');
  expect(ways).toEqual(['repos', 'account']);
  // A repository hook added by hand at the hoster shows up when the window comes back – both lines, marked double.
  at.repo = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(github).toContainText('Webhook am Repository alex/wiki – jeder Push kommt doppelt an');
  await expect(github.getByRole('button', { name: 'Alle entfernen' })).toBeVisible();
  // Its own button removes just that one; the question says the other stays.
  await github.getByRole('button', { name: 'Webhook am Repository alex/wiki entfernen' }).click();
  const one = page.getByRole('alertdialog');
  await expect(one).toContainText('alex/wiki: entfernen');
  await expect(one).not.toContainText('Konto alex: entfernen');
  await expect(one).toContainText('Die anderen Webhooks bleiben.');
  await one.getByRole('button', { name: 'Entfernen' }).click();
  await expect(github).toContainText('Entfernt: alex/wiki');
  await expect(github).toContainText('Webhook am Konto alex');
  await expect(github).not.toContainText('Webhook am Repository');
  expect(deletes).toEqual(['scope=repo&name=alex%2Fwiki', 'scope=repo&name=alex%2Fwiki']);
  await page.unroute('**/api/connections/*/webhook*');
  // Plain Git without token, with user name field.
  await panel.getByRole('button', { name: 'Verbindung hinzufügen' }).click();
  await form.getByRole('radio', { name: 'Git (allgemein)' }).click();
  await form.getByLabel('Adresse').fill('https://git.example.org/team/doku.git');
  await form.getByLabel('Benutzername (optional)').fill('alex');
  await form.getByRole('button', { name: 'Verbindung anlegen' }).click();
  const plain = panel.getByRole('listitem').filter({ hasText: 'git.example.org' });
  await expect(plain).toContainText('https://git.example.org · alex · ohne Token');
  await shot(page, '70-verbindungen');
  // Rename; the token is never shown, only replaced.
  await plain.getByRole('button', { name: /bearbeiten/ }).click();
  const editForm = plain.getByRole('form');
  await expect(editForm.getByLabel('Token')).toHaveValue('');
  await editForm.getByLabel('Name (optional)', { exact: true }).fill('Firmen-Git');
  await editForm.getByRole('button', { name: 'Speichern' }).click();
  await expect(panel.getByRole('listitem').filter({ hasText: 'Firmen-Git' })).toBeVisible();

  // The wizard: GitHub tab offers the connection; a Git URL on a known host offers the fitting one.
  await openSettingsPage(page, 'Eingebundene Quellen');
  await settings.getByRole('button', { name: 'Quelle einbinden' }).click();
  const wizard = page.getByRole('dialog', { name: 'Quelle einbinden' });
  await wizard.getByRole('button', { name: 'GitLab', exact: true }).click();
  await expect(wizard.getByRole('form', { name: 'Neue Verbindung' })).toBeVisible();
  await expect(wizard.getByLabel('Adresse')).toHaveValue('https://gitlab.com');
  await wizard.getByRole('button', { name: 'Git-URL', exact: true }).click();
  await wizard.getByLabel('Clone-URL (HTTPS)').fill('https://git.example.org/team/doku.git');
  await expect(wizard.getByLabel('Anmeldung').locator('option:checked')).toHaveText('Verbindung „Firmen-Git“');
  await wizard.getByLabel('Anmeldung').selectOption({ label: 'Neuer Token …' });
  await expect(wizard.getByLabel('Token')).toBeVisible();
  await wizard.getByRole('button', { name: 'Zurück' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Verwerfen' }).click();
  await expect(wizard).toHaveCount(0);

  // Delete both again (nothing uses them).
  await openSettingsPage(page, 'Verbindungen');
  for (const row of [github, panel.getByRole('listitem').filter({ hasText: 'Firmen-Git' })]) {
    await row.getByRole('button', { name: /löschen/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
    await expect(row).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
});

test('Settings → Webhooks: address, secret, how per hoster, and what arrived (AD-033)', async () => {
  const { secret } = (await (await page.request.get('/api/settings/webhook')).json()) as { secret: string };
  const body = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: 'https://gitea.example.org/alex/notizen.git' } });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  const res = await page.request.post('/api/webhooks/git', { data: body, headers: { 'content-type': 'application/json', 'x-gitea-signature': sig } });
  expect(res.ok()).toBe(true);
  await page.getByRole('button', { name: 'Einstellungen' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Einstellungen' });
  await openSettingsPage(page, 'Webhooks');
  await expect(settings.getByText('alle 5 Minuten')).toBeVisible();
  await expect(settings.locator('code', { hasText: '/api/webhooks/git' })).toBeVisible();
  // Own address for webhooks (owner 25.10.): FQDN or IP, the path is added; empty = the public address again.
  const address = settings.getByLabel('Adresse, unter der der Anbieter Kaveyl Wiki erreicht');
  await address.fill('http://192.168.1.20:8093');
  await address.press('Enter');
  await expect(settings.locator('code', { hasText: 'http://192.168.1.20:8093/api/webhooks/git' })).toBeVisible();
  await address.fill('ftp://falsch');
  await address.press('Enter');
  await expect(settings.getByRole('status').filter({ hasText: 'nur die Adresse mit http://' })).toBeVisible();
  await address.fill('');
  await address.press('Enter');
  await expect(settings.locator('code', { hasText: 'http://192.168.1.20:8093/api/webhooks/git' })).toHaveCount(0);
  await settings.locator('summary', { hasText: /^Gitea$/ }).click();
  await expect(settings.getByText('Für alle eigenen Repositories:')).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Zuletzt empfangen' })).toContainText('Webhook von Gitea: alex/notizen (main) → keine passende Quelle');
  await shot(page, '89-webhooks');
  await page.keyboard.press('Escape');
});

test('links that lead nowhere: marked red while writing, „Notiz anlegen“ creates the target, then the mark goes', async () => {
  writeFileSync(join(NOTES, 'linkprobe.md'), '# Linkprobe\n\n[Da](plan/roadmap.md) und [Weg](neu-aus-link.md)\n');
  await expect(tree().getByText('linkprobe', { exact: true })).toBeVisible();
  await tree().getByText('linkprobe', { exact: true }).click();
  const editor = page.locator('.prose-note').filter({ visible: true });
  const broken = editor.locator('a:has(.link-broken)');
  await expect(broken).toHaveText('Weg');
  await expect(editor.locator('a', { hasText: 'Da' })).toBeVisible();
  await expect(editor.locator('a:has(.link-broken)', { hasText: 'Da' })).toHaveCount(0);
  await shot(page, '110-link-ins-leere');
  // A click shows what is wrong and offers to create the note (instead of opening an empty tab).
  await broken.click();
  const menu = page.getByRole('menu', { name: 'Link' });
  await expect(menu).toContainText('Ziel fehlt');
  await menu.getByRole('menuitem', { name: 'Notiz anlegen' }).click();
  await expect.poll(() => read('neu-aus-link.md')).toContain('# neu-aus-link');
  await expect(tabs().filter({ hasText: 'neu-aus-link' })).toBeVisible();
  await tabs().filter({ hasText: 'linkprobe' }).click();
  await expect(editor.locator('a:has(.link-broken)')).toHaveCount(0);
  // The file itself never changes for the mark.
  expect(read('linkprobe.md')).toBe('# Linkprobe\n\n[Da](plan/roadmap.md) und [Weg](neu-aus-link.md)\n');
  // A middle click opens the target in exactly one new tab (it once opened two).
  const roadmap = page.locator('[data-tab="plan/roadmap.md"]');
  for (let n = await roadmap.count(); n > 0; n--) await roadmap.first().click({ button: 'middle' });
  await expect(roadmap).toHaveCount(0);
  await editor.locator('a', { hasText: 'Da' }).click({ button: 'middle' });
  await expect(roadmap).toHaveCount(1);
  await page.waitForTimeout(800);
  await expect(roadmap).toHaveCount(1);
  // The link's preview card does not stay behind in the corner (it once covered the sidebar buttons).
  await expect(page.getByRole('tooltip', { name: /^Vorschau: / })).toHaveCount(0);
});

test('font sizes: Darstellung → Schriftgröße, four sliders that act at once, back to 100 %', async () => {
  await openSettingsPage(page, 'Schriftgröße');
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' });
  const px = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const note = page.locator('.prose-note').filter({ visible: true }).first();
  const row = tree().locator('.text-tree').first();
  const before = { html: await px(page.locator('html')), note: await px(note), row: await px(row) };
  expect(before).toEqual({ html: 16, note: 16, row: 13 });
  await dialog.getByLabel('Schriftgröße Notiztext').fill('130');
  await dialog.getByLabel('Schriftgröße Seitenleiste').fill('120');
  await dialog.getByLabel('Schriftgröße Oberfläche').fill('110');
  await dialog.getByLabel('Schriftgröße Code').fill('90');
  // Live: the app behind the dialog follows at once (interface × sidebar for the tree).
  await expect.poll(() => px(note)).toBeCloseTo(20.8, 1);
  await expect.poll(() => px(page.locator('html'))).toBeCloseTo(17.6, 1);
  await expect.poll(() => px(row)).toBeCloseTo(13 * 1.1 * 1.2, 1);
  await expect(dialog.getByRole('region', { name: 'Code' }).locator('pre')).toHaveCSS('font-size', '11.7px');
  await shot(page, '109-einstellungen-schriftgroesse');
  // Saved for the account.
  await expect
    .poll(async () => ((await (await page.request.get('/api/state/prefs')).json()) as { fontScale?: Record<string, number> } | null)?.fontScale)
    .toEqual({ ui: 110, tree: 120, doc: 130, mono: 90 });
  await dialog.getByRole('button', { name: 'Alle auf 100 % zurücksetzen' }).click();
  await expect.poll(() => px(note)).toBe(16);
  await expect.poll(() => px(page.locator('html'))).toBe(16);
  await page.keyboard.press('Escape');
});

test('sidebar width: the divider follows a finger (folding phone, open), the mouse and the arrow keys', async ({ browser }) => {
  // Owner find 29.10.: Chrome on a Galaxy Z Fold (inner screen ≈ 880 px, desktop layout) – the divider only knew the mouse.
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 884, height: 1000 } });
  const touch = await ctx.newPage();
  await touch.goto('/');
  await touch.getByLabel('E-Mail').fill('e2e@example.test');
  await touch.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await touch.getByRole('button', { name: 'Anmelden' }).click();
  await expect(touch.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
  const aside = touch.locator('aside[aria-label="Seitenleiste"]');
  const divider = touch.getByRole('separator', { name: 'Breite der Seitenleiste' });
  const width = async () => (await aside.boundingBox())!.width;
  const start = await width();
  // Real touch events through CDP: the finger lands 6 px beside the 4 px line (the wider grip) and moves right.
  const box = (await divider.boundingBox())!;
  const y = box.y + 300;
  const cdp = await ctx.newCDPSession(touch);
  const finger = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  let x = box.x + box.width + 6;
  await finger('touchStart', x);
  for (let i = 0; i < 8; i++) await finger('touchMove', (x += 10));
  await finger('touchEnd', x);
  await expect.poll(width).toBeGreaterThan(start + 60);
  // Mouse still works.
  const m = (await divider.boundingBox())!;
  await touch.mouse.move(m.x + 2, m.y + 300);
  await touch.mouse.down();
  await touch.mouse.move(m.x - 60, m.y + 300, { steps: 5 });
  await touch.mouse.up();
  await expect.poll(width).toBeLessThan(start + 40);
  // Keyboard: focus the divider, arrows move it in 16 px steps; back to the width from before.
  await divider.focus();
  await touch.keyboard.press('ArrowRight');
  const afterKey = await width();
  await touch.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(afterKey - 16);
  const now = Number(await divider.getAttribute('aria-valuenow'));
  const steps = Math.round((now - start) / 16);
  for (let i = 0; i < Math.abs(steps); i++) await touch.keyboard.press(steps > 0 ? 'ArrowLeft' : 'ArrowRight');
  await ctx.close();
});
