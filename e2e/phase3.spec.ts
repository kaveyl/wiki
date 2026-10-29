// Phase 3 end-to-end: editor comfort (callouts, collapsible blocks, code highlighting, …).
// Runs after phase1.spec.ts in the same seeded workspace (admin + local mount "Notizen").
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { shot } from './shots';

const E2E_DIR = resolve(import.meta.dirname, '../.local/e2e');
const NOTES = join(E2E_DIR, 'projekte/notizen');
const read = (name: string) => readFileSync(join(NOTES, name), 'utf8');

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

/** Opens a note by its name in the tree (file name without .md). */
async function openNote(name: string) {
  await expect(tree().getByText(name, { exact: true }).first()).toBeVisible();
  await tree().getByText(name, { exact: true }).first().click();
  await expect(page.locator('.prose-note').filter({ visible: true })).toBeVisible();
}

const editor = () => page.locator('.prose-note').filter({ visible: true });
const saved = () => expect(page.getByText('Gespeichert', { exact: true }).filter({ visible: true })).toBeVisible({ timeout: 10_000 });

const BLOCKS =
  '# Bausteine\n\n> [!WARNING]\n> Vorsicht, **heiß**.\n\n<details>\n<summary>Mehr anzeigen</summary>\n\nVersteckter Inhalt.\n\n</details>\n\n```ts\nconst answer: number = 42;\n```\n\nEnde.\n';

test('renders callouts, collapsible blocks and highlighted code without changing the file', async () => {
  writeFileSync(join(NOTES, 'bausteine.md'), BLOCKS);
  await openNote('bausteine');
  await expect(editor().locator('.callout[data-callout="WARNING"]')).toContainText('Vorsicht, heiß.');
  const details = editor().locator('[data-type="details"]');
  await expect(details.locator('summary')).toHaveText('Mehr anzeigen');
  await expect(details.getByText('Versteckter Inhalt.')).toBeHidden();
  await details.locator('> button').click();
  await expect(details.getByText('Versteckter Inhalt.')).toBeVisible();
  await expect(editor().locator('pre .hljs-keyword').first()).toHaveText('const');
  await shot(page, '30-callout-details-code');
  await editor().getByText('Ende.').click();
  await page.waitForTimeout(1500);
  await saved();
  // Folding/unfolding is view state only — the file stays byte-identical.
  expect(read('bausteine.md')).toBe(BLOCKS);
});

test('inserts a callout via slash command and changes its kind in the toolbar', async () => {
  await editor().getByText('Ende.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Neuer Hinweis');
  await page.keyboard.press('Home');
  await page.keyboard.type('/tipp');
  await expect(page.getByRole('button', { name: /Hinweis-Box: Tipp/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('> [!TIP]\n> Neuer Hinweis');
  const toolbar = page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true });
  await toolbar.getByLabel('Art der Hinweis-Box').selectOption('CAUTION');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('> [!CAUTION]\n> Neuer Hinweis');
  // The untouched blocks above keep their bytes.
  expect(read('bausteine.md').startsWith(BLOCKS.replace(/\n$/, ''))).toBe(true);
});

test('sets the language of a code block from the toolbar', async () => {
  await editor().locator('pre').click();
  const toolbar = page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true });
  await toolbar.getByLabel('Sprache des Codeblocks').selectOption('javascript');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('```javascript\nconst answer: number = 42;\n```');
});

test('attaches a PDF and an image from the toolbar; both are listed below the note', async () => {
  await editor().getByText('Ende.').click();
  await page.keyboard.press('End');
  const toolbar = page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true });
  const chooser = page.waitForEvent('filechooser');
  await toolbar.getByRole('button', { name: /Datei oder Bild anhängen/ }).click();
  await (await chooser).setFiles([
    { name: 'Angebot 2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
    {
      name: 'punkt.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    },
  ]);
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('[Angebot-2026.pdf](assets/Angebot-2026.pdf)');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('![punkt](assets/punkt.png)');
  expect(readFileSync(join(NOTES, 'assets/Angebot-2026.pdf'), 'utf8')).toBe('%PDF-1.4\n%%EOF\n');
  const list = page.getByRole('region', { name: 'Anhänge' }).filter({ visible: true });
  await expect(list.getByText('Angebot-2026.pdf')).toBeVisible({ timeout: 10_000 });
  await expect(list.getByText('punkt.png')).toBeVisible();
  await expect(editor().locator('img[alt="punkt"]')).toHaveJSProperty('naturalWidth', 1);
  await shot(page, '31-attachments');
});

test('links a note via [[ autocomplete as a relative Markdown link', async () => {
  await editor().getByText('Neuer Hinweis').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Siehe [[Roadm');
  const list = page.getByRole('listbox', { name: 'Notiz verlinken' });
  await expect(list.getByRole('option', { name: /^roadmap/ })).toBeVisible();
  await shot(page, '32-note-link');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('Siehe [Roadmap](plan/roadmap.md)');
});

test('slash menu offers file upload and a Mermaid diagram', async () => {
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  // Registered early: Playwright enables file-chooser interception asynchronously.
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('/datei');
  await expect(page.getByRole('button', { name: /Datei oder Bild.*Hochladen/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await (await chooser).setFiles([{ name: 'notiz daten.csv', mimeType: 'text/csv', buffer: Buffer.from('a;b\n1;2\n') }]);
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('[notiz-daten.csv](assets/notiz-daten.csv)');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/mermaid');
  await expect(page.getByRole('button', { name: /Diagramm \(Mermaid\)/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('```mermaid\nflowchart LR');
  // Clicking into text after working in a code block moves the cursor there.
  await editor().getByText('Siehe').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (Klick)');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('Siehe [Roadmap](plan/roadmap.md) (Klick)');
});

test('slash menu scrolls along with the keyboard selection', async () => {
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const list = page.locator('div.max-h-80').filter({ has: page.getByRole('button', { name: /Text/ }) });
  await expect(list).toBeVisible();
  // ArrowUp from the first entry wraps to the last one, which is far below the visible area.
  await page.keyboard.press('ArrowUp');
  await expect(list.locator('button').last()).toBeInViewport();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect(list.locator('button').nth(2)).toBeInViewport();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
});

test('slash menu: filters across spaces, Enter without a match is a line break, a formula lands at the slash', async () => {
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/Überschrift 2');
  await expect(page.getByRole('button', { name: /Überschrift 2/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Zwischentitel');
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('## Zwischentitel');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Pfad /etc/hosts ist da');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Neue Zeile');
  // (The note may end in a callout: then the lines are quoted „> …“.)
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toMatch(/Pfad \/etc\/hosts ist da\n>?\n(> )?Neue Zeile/);
  // The input window takes the focus away; the formula still goes where the slash was.
  await page.keyboard.press('Enter');
  await page.keyboard.type('/formel');
  await page.getByRole('button', { name: /Formel \(eigene Zeile\)/ }).click();
  const formula = page.getByRole('dialog', { name: 'Formel (LaTeX)' });
  await formula.getByLabel('LaTeX').fill('e^{i\\pi}+1=0');
  await page.keyboard.press('Enter');
  await expect(formula).toHaveCount(0);
  await expect.poll(() => read('bausteine.md'), { timeout: 10_000 }).toContain('e^{i\\pi}+1=0');
  const md = read('bausteine.md');
  expect(md.indexOf('e^{i\\pi}+1=0')).toBeGreaterThan(md.indexOf('Neue Zeile'));
});

test('command palette (Ctrl+K) opens notes and runs commands', async () => {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette.getByLabel('Befehlspalette')).toBeFocused();
  await page.keyboard.type('Roadmap');
  await expect(palette.getByRole('option', { name: /^roadmap/ }).first()).toBeVisible();
  await shot(page, '33-palette');
  await page.keyboard.press('Enter');
  await expect(page.locator('.prose-note').filter({ visible: true }).getByRole('heading', { name: 'Roadmap' })).toBeVisible();
  // Commands only, with ">" prefix.
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'Befehlspalette' })).toBeFocused();
  await page.keyboard.type('>dunkel');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'Befehlspalette' })).toBeFocused();
  await page.keyboard.type('>hell');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('search page with operators and filter controls', async () => {
  writeFileSync(join(NOTES, 'plan/tagged.md'), '---\ntags: [phase3, suche]\n---\n# Getaggt\n\nSuchwort Kolibri im Plan.\n');
  writeFileSync(join(NOTES, 'kolibri.md'), '# Kolibri\n\nSuchwort Kolibri ohne Tag.\n');
  await expect(tree().getByText('tagged', { exact: true }).first()).toBeAttached({ timeout: 10_000 });
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'Befehlspalette' })).toBeFocused();
  await page.keyboard.type('kolibri');
  await page.getByRole('dialog').getByRole('option', { name: /Alle Ergebnisse/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Suche' });
  await expect(dialog.getByText('2 Treffer')).toBeVisible();
  await dialog.getByLabel('Tag').fill('phase3');
  await expect(dialog.getByLabel('Suchanfrage')).toHaveValue('kolibri tag:phase3');
  await expect(dialog.getByText('1 Treffer')).toBeVisible();
  await expect(dialog.getByText('#suche')).toBeVisible();
  await dialog.getByLabel('Suchanfrage').fill('kolibri -plan');
  await expect(dialog.getByRole('button', { name: /^tagged/ })).toBeHidden();
  await expect(dialog.getByText('1 Treffer')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^kolibri/ })).toBeVisible();
  await shot(page, '34-search-page');
  await dialog.getByRole('button', { name: /^kolibri/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.prose-note').filter({ visible: true }).getByText('Suchwort Kolibri ohne Tag.')).toBeVisible();
});

test('tags: add and remove in the note, browse all tags, filter by tag', async () => {
  await openNote('trilium');
  const bar = page.getByLabel('Tags').filter({ visible: true });
  await expect(bar.getByText('pkm')).toBeVisible();
  await bar.getByRole('button', { name: 'Tag', exact: true }).click();
  await page.getByLabel('Neuer Tag').fill('ideen');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('trilium.md'), { timeout: 10_000 }).toContain('tags: pkm, wiki, ideen\n');
  await bar.getByRole('button', { name: 'Tag wiki entfernen' }).click();
  await expect.poll(() => read('trilium.md'), { timeout: 10_000 }).toContain('tags: pkm, ideen\n');
  // Typing right after a tag change must not run into a conflict.
  await editor().getByText('Stern-Liste bleibt').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (getaggt)');
  await saved();
  expect(read('trilium.md')).toContain('Stern-Liste bleibt (getaggt)');
  await expect(page.getByText('außerhalb geändert')).toHaveCount(0);
  await shot(page, '35-tags');
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  const tagsDialog = page.getByRole('dialog', { name: 'Tags' });
  await expect(tagsDialog.getByRole('button', { name: /ideen/ })).toBeVisible();
  await tagsDialog.getByRole('button', { name: /ideen/ }).click();
  const search = page.getByRole('dialog', { name: 'Suche' });
  await expect(search.getByLabel('Suchanfrage')).toHaveValue('tag:ideen');
  await expect(search.getByRole('button', { name: /^trilium/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('colored tags: right-click → Farbe, saved in .kaveyl-wiki.yml; rename merges into another tag (AD-040)', async () => {
  await openNote('trilium');
  const bar = page.getByLabel('Tags').filter({ visible: true });
  const chip = bar.locator('[data-tag-color]', { hasText: 'ideen' });
  await chip.click({ button: 'right' });
  const color = page.getByRole('menuitem', { name: 'Farbe', exact: true });
  await color.hover();
  await page.waitForTimeout(150);
  await color.hover();
  await expect(page.getByRole('menuitem', { name: 'Rot', exact: true })).toBeVisible();
  await shot(page, '117-tag-farbe');
  await page.getByRole('menuitem', { name: 'Rot', exact: true }).click();
  await expect.poll(() => { try { return read('.kaveyl-wiki.yml'); } catch { return ''; } }, { timeout: 10_000 }).toContain('tagColors:\n  ideen: red\n');
  await expect(chip).toHaveAttribute('data-tag-color', 'red');

  // The tag list shows the color; renaming into an existing tag merges both, the color moves along.
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  const tagsDialog = page.getByRole('dialog', { name: 'Tags' });
  await expect(tagsDialog.getByRole('button', { name: /ideen/ })).toHaveAttribute('data-tag-color', 'red');
  await tagsDialog.getByRole('button', { name: /ideen/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Umbenennen / zusammenführen …' }).click();
  const ask = page.getByRole('dialog', { name: '#ideen umbenennen' });
  await ask.getByLabel('Neuer Name').fill('pkm');
  await ask.getByRole('button', { name: 'Umbenennen' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Zusammenführen' }).click();
  await expect.poll(() => read('trilium.md'), { timeout: 10_000 }).toContain('tags: pkm\n');
  await expect.poll(() => read('.kaveyl-wiki.yml'), { timeout: 10_000 }).toContain('tagColors:\n  pkm: red\n');
  await expect(tagsDialog.getByRole('button', { name: /ideen/ })).toHaveCount(0);
  await expect(tagsDialog.getByRole('button', { name: /pkm/ })).toHaveAttribute('data-tag-color', 'red');
  await shot(page, '118-tag-liste');
  await page.keyboard.press('Escape');
  await expect(bar.locator('[data-tag-color]', { hasText: 'pkm' })).toHaveAttribute('data-tag-color', 'red');
});

test('hovering a note link shows a preview card', async () => {
  await openNote('roadmap');
  await editor().getByRole('link', { name: 'Trilium' }).hover();
  const card = page.getByRole('tooltip', { name: /^Vorschau: / });
  await expect(card).toBeVisible();
  await expect(card.getByText('trilium', { exact: true })).toBeVisible();
  await expect(card).toContainText('Erster Absatz über Hierarchien');
  await shot(page, '36-link-preview');
  await page.mouse.move(5, 5);
  await expect(card).toBeHidden();
});

test('favorites, recently opened and recently changed in the sidebar', async () => {
  await openNote('Detailseite');
  await page.getByRole('button', { name: 'Zu Favoriten' }).filter({ visible: true }).click();
  const aside = page.locator('aside');
  await expect(aside.getByText('Favoriten')).toBeVisible();
  await openNote('kolibri');
  await expect(aside.getByText('Zuletzt')).toBeVisible();
  await aside.getByRole('button', { name: 'geändert' }).click();
  writeFileSync(join(NOTES, 'frisch.md'), '# Frisch geändert\n');
  await expect(aside.getByText('frisch', { exact: true }).first()).toBeVisible({ timeout: 40_000 });
  await aside.getByRole('button', { name: 'geöffnet' }).click();
  // Favorites survive a reload (stored per user on the server).
  await page.reload();
  await expect(aside.getByText('Favoriten')).toBeVisible();
  const favs = aside.locator('div', { has: page.getByText('Favoriten', { exact: true }) }).first();
  await expect(favs.getByText('Detailseite', { exact: true }).first()).toBeVisible();
  // Rows name their source: the same folder structure often recurs across repos.
  await expect(favs.locator('[title^="Notizen / "]').first()).toContainText('(Notizen)');
  // Picking „geändert“ on the collapsed „Zuletzt“ section unfolds it again.
  const recent = aside.locator('div.mb-1', { has: page.getByText('Zuletzt', { exact: true }) });
  await recent.getByText('Zuletzt', { exact: true }).click();
  await expect(recent.getByText('kolibri', { exact: true })).toBeHidden();
  await recent.getByRole('button', { name: 'geändert' }).click();
  await expect(recent.getByText('frisch', { exact: true }).first()).toBeVisible();
  await recent.getByRole('button', { name: 'geöffnet' }).click();
  // Favoriten and Zuletzt in view – the sidebar may have scrolled with the tree.
  await aside.getByText('Favoriten', { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, '37-favoriten');
});

test('icon from the note header and write protection toggle', async () => {
  await openNote('roadmap');
  await page.getByRole('button', { name: 'Icon der Notiz' }).filter({ visible: true }).click();
  await page.getByRole('button', { name: 'Symbol rocket' }).click();
  await expect.poll(() => read('plan/roadmap.md'), { timeout: 10_000 }).toContain('icon: lucide:rocket');
  // The own icon also shows under „Zuletzt · geöffnet“, which only remembers the path (owner 2026-10-16).
  const recent = page.locator('aside div.mb-1', { has: page.getByText('Zuletzt', { exact: true }) });
  await recent.getByRole('button', { name: 'geöffnet' }).click();
  await expect(recent.locator('[title$=" / plan/roadmap.md"] svg.lucide-rocket')).toBeVisible();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Schreibschutz setzen' }).click();
  await expect.poll(() => read('plan/roadmap.md'), { timeout: 10_000 }).toContain('readonly: true');
  await expect(page.getByRole('button', { name: /Nur lesen/ }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Schreibschutz aufheben' }).click();
  await expect.poll(() => read('plan/roadmap.md'), { timeout: 10_000 }).not.toContain('readonly');
  await expect(page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true })).toBeVisible();
});

test('split view: a second note on the right or left, swap and close', async () => {
  await openNote('kolibri');
  await tree().getByText('roadmap', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rechts daneben öffnen' }).click();
  const editors = page.locator('.prose-note').filter({ visible: true });
  await expect(editors).toHaveCount(2);
  await expect(editors.nth(0).getByRole('heading', { name: 'Kolibri' })).toBeVisible();
  await expect(editors.nth(1).getByRole('heading', { name: 'Roadmap' })).toBeVisible();
  await shot(page, '38-split');
  // Both halves edit independently.
  await editors.nth(1).getByText('Siehe').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Rechts.');
  await expect.poll(() => read('plan/roadmap.md'), { timeout: 10_000 }).toContain('Rechts.');
  await page.getByRole('button', { name: 'Geteilte Ansicht schließen' }).click();
  await expect(editors).toHaveCount(1);

  // The halves in screen order (the editors stay in tab order in the DOM).
  const halves = () =>
    editors.evaluateAll((els) =>
      els
        .map((e) => ({ x: e.getBoundingClientRect().left, h: e.querySelector('h1')?.textContent?.trim() ?? '' }))
        .sort((a, b) => a.x - b.x)
        .map((e) => e.h),
    );
  // A note just opened with a click (it replaces the current tab) and then "Rechts daneben
  // öffnen" on the same note: the previously opened note goes to the left, this one to the right.
  await openNote('kolibri');
  await openNote('roadmap');
  await expect(editors).toHaveCount(1);
  await tree().getByText('roadmap', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rechts daneben öffnen' }).click();
  await expect(editors).toHaveCount(2);
  await expect.poll(halves).toEqual(['Kolibri', 'Roadmap']);
  await page.getByRole('button', { name: 'Geteilte Ansicht schließen' }).click();
  await expect(editors).toHaveCount(1);
  // "Links daneben öffnen" puts the chosen note on the left, the current one on the right.
  await openNote('kolibri');
  await tree().getByText('roadmap', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Links daneben öffnen' }).click();
  await expect(editors).toHaveCount(2);
  await expect.poll(halves).toEqual(['Roadmap', 'Kolibri']);
  await page.getByRole('button', { name: 'Geteilte Ansicht schließen' }).click();
  await expect(editors).toHaveCount(1);
});

test('hoisting: only one folder in the sidebar until the focus is lifted', async () => {
  await tree().getByText('plan', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Nur diesen Ordner zeigen/ }).click();
  await expect(tree().getByText('Fokus: plan')).toBeVisible();
  await expect(tree().getByText('roadmap', { exact: true })).toBeVisible();
  await expect(tree().getByText('kolibri', { exact: true })).toHaveCount(0);
  await expect(tree().getByText('Archiv', { exact: true })).toHaveCount(0);
  await shot(page, '39-fokus');
  await page.getByRole('button', { name: 'Fokus aufheben' }).click();
  await expect(tree().getByText('kolibri', { exact: true })).toBeVisible();
});

test('templates: save a note as template, create a new note from it with variables', async () => {
  await openNote('kolibri');
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Als Vorlage speichern' }).click();
  const named = page.getByRole('dialog', { name: 'Als Vorlage speichern' });
  await named.getByLabel('Name der Vorlage').fill('Besprechung');
  await named.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect.poll(() => { try { return read('.kaveyl-wiki/templates/Besprechung.md'); } catch { return ''; } }, { timeout: 10_000 }).toContain('Suchwort Kolibri');
  writeFileSync(join(NOTES, '.kaveyl-wiki/templates/Tagebuch.md'), '# {{title}} – {{weekday}}, {{date}}\n\n## Erledigt\n\n- [ ] \n');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'Befehlspalette' })).toBeFocused();
  await page.keyboard.type('>neue notiz');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Neue Notiz' });
  await dialog.getByLabel('Titel').fill('Tag eins');
  await dialog.getByLabel('Vorlage').selectOption({ label: 'Tagebuch' }); // by file name (AD-022)
  await shot(page, '40-vorlage');
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await expect(editor().getByRole('heading', { level: 1 })).toContainText(`Tag eins – `);
  await expect(editor().getByRole('heading', { level: 1 })).toContainText(date);
  await expect(editor().getByRole('heading', { name: 'Erledigt' })).toBeVisible();
});

test('emoji via ":" autocomplete and the toolbar picker; format painter copies marks', async () => {
  await openNote('kolibri');
  await editor().getByText('Suchwort Kolibri ohne Tag.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Fertig :hake');
  await expect(page.getByRole('listbox', { name: 'Emoji' }).getByRole('option').first()).toHaveText('✅');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' 10:30 Uhr');
  await expect.poll(() => read('kolibri.md'), { timeout: 10_000 }).toContain('Suchwort Kolibri ohne Tag. Fertig ✅ 10:30 Uhr');
  const toolbar = page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true });
  await toolbar.getByRole('button', { name: 'Emoji einfügen' }).click();
  await page.getByLabel('Emoji suchen').fill('rakete');
  await page.getByRole('button', { name: 'Emoji rakete' }).click();
  await expect.poll(() => read('kolibri.md'), { timeout: 10_000 }).toContain('Uhr🚀');
  // Format painter: the marks of "fett" (bold) go onto "normal", selected with the keyboard.
  writeFileSync(join(NOTES, 'format.md'), '# Format\n\n**fett** und normal\n');
  await openNote('format');
  await editor().locator('strong').dblclick();
  await toolbar.getByRole('button', { name: 'Format übertragen' }).click();
  await editor().getByText('und normal').click();
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.up('Shift');
  await expect.poll(() => read('format.md'), { timeout: 10_000 }).toBe('# Format\n\n**fett** und **normal**\n');
});

test('renders KaTeX math and a Mermaid diagram; opening never changes the file', async () => {
  const md = '# Formeln\n\nEnergie $E = mc^2$ und Preis $5 und $10.\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n\n```mermaid\nflowchart LR\n  A --> B\n```\n';
  writeFileSync(join(NOTES, 'formeln.md'), md);
  await openNote('formeln');
  await expect(editor().locator('.math-inline .katex')).toHaveCount(1);
  await expect(editor().locator('.math-block .katex-display')).toBeVisible();
  await expect(editor().locator('.mermaid-preview svg')).toBeVisible({ timeout: 15_000 });
  await shot(page, '41-formeln-diagramm');
  await editor().getByText('Energie').click();
  await page.waitForTimeout(1500);
  expect(read('formeln.md')).toBe(md);
  // Editing a formula: double click → prompt.
  await editor().locator('.math-block').dblclick();
  const edit = page.getByRole('dialog', { name: 'Formel bearbeiten' });
  await edit.getByLabel('LaTeX').fill('a^2 + b^2 = c^2');
  await edit.getByRole('button', { name: 'Übernehmen' }).click();
  await expect.poll(() => read('formeln.md'), { timeout: 10_000 }).toContain('$$\na^2 + b^2 = c^2\n$$');
});

test('drag & drop in the tree: into a folder and manual order (.kaveyl-wiki.yml)', async () => {
  const row = (t: string) => tree().locator('[data-node]', { hasText: t }).first();
  // Into the folder "plan" (middle of the row).
  await row('format').dragTo(row('plan'), { targetPosition: { x: 60, y: 14 } });
  await expect.poll(() => { try { return read('plan/format.md'); } catch { return ''; } }, { timeout: 10_000 }).toContain('# Format');
  // Manual order inside "plan": tagged to the top (upper edge of the first row).
  const names = async () => (await tree().locator('[data-node]').allInnerTexts()).map((t) => t.trim());
  const first = (await names()).find((n) => ['Detailseite', 'format', 'tagged', 'roadmap', 'kolibri'].includes(n))!;
  await row('tagged').dragTo(row(first), { targetPosition: { x: 60, y: 2 } });
  await expect.poll(() => { try { return read('plan/.kaveyl-wiki.yml'); } catch { return ''; } }, { timeout: 10_000 }).toMatch(/^order:\n {2}- tagged\.md\n/);
  await expect.poll(async () => { const n = await names(); return n.indexOf('tagged') < n.indexOf(first); }).toBe(true);
  // Rows low in the window (zone must come from the row, not the page): trilium above bausteine at root.
  await row('trilium').dragTo(row('bausteine'), { targetPosition: { x: 60, y: 2 } });
  await expect.poll(() => { try { return read('.kaveyl-wiki.yml'); } catch { return ''; } }, { timeout: 10_000 }).toMatch(/- trilium\.md\n\s+- bausteine\.md/);
  // The picture shows the order in the tree: the folder „plan“ with „tagged“ on top.
  await row('tagged').scrollIntoViewIfNeeded();
  await shot(page, '42-baum-sortierung');
});

test('details written on one line (<details><summary>…) survive opening and clicking unchanged', async () => {
  const md = '# HTML und Fußnoten\n\n<details><summary>Aufklappen</summary>\n\nVersteckter Text.\n\n</details>\n\nText mit Fußnote[^1].\n\n[^1]: Die Fußnote.\n';
  writeFileSync(join(NOTES, 'fussnoten.md'), md);
  await openNote('fussnoten');
  await editor().getByText('Text mit Fußnote').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(1500);
  await openNote('kolibri');
  await page.waitForTimeout(1000);
  expect(read('fussnoten.md')).toBe(md);
});

test('collapsible block: Enter stays inside, Enter on an empty last line leaves it, Shift+Enter breaks the line', async () => {
  writeFileSync(join(NOTES, 'aufklappbar.md'), '# Aufklappbar\n\nStart\n');
  await expect(tree().getByText('aufklappbar', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openNote('aufklappbar');
  // Right after opening, the editor may still settle (and drop a click): click until the cursor is in „Start“.
  const cursorIn = () =>
    page.evaluate(() => {
      const view = [...document.querySelectorAll('.ProseMirror')].find((d) => (d as HTMLElement).offsetParent) as unknown as { editor: { state: { selection: { $from: { parent: { textContent: string } } } } } };
      return view.editor.state.selection.$from.parent.textContent;
    });
  await expect
    .poll(async () => {
      await editor().getByText('Start').click();
      return cursorIn();
    })
    .toBe('Start');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/aufklapp');
  await expect(page.getByRole('button', { name: /^Aufklappbarer Block Ü/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Titel');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Zeile eins');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Zeile zwei');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('gleicher Absatz');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Danach');
  await expect.poll(() => read('aufklappbar.md'), { timeout: 10_000 }).toContain('Danach');
  const md = read('aufklappbar.md');
  const end = md.indexOf('</details>');
  expect(md.indexOf('Start')).toBeLessThan(md.indexOf('<details>'));
  expect(md).toContain('<summary>Titel</summary>');
  expect(md.indexOf('Zeile eins')).toBeGreaterThan(md.indexOf('<summary>'));
  expect(md.indexOf('Zeile eins')).toBeLessThan(end);
  expect(md.indexOf('gleicher Absatz')).toBeLessThan(end);
  expect(md).toMatch(/Zeile zwei(\\|  )?\ngleicher Absatz/);
  expect(md.indexOf('Danach')).toBeGreaterThan(end);
});

test('selection menu: the marked paragraph becomes a heading and back (owner 25.10.)', async () => {
  writeFileSync(join(NOTES, 'auswahl-ueberschrift.md'), '# Auswahl\n\nKapitel eins\n\n- Punkt\n');
  await expect(tree().getByText('auswahl-ueberschrift', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openNote('auswahl-ueberschrift');
  const cursorIn = () =>
    page.evaluate(() => {
      const view = [...document.querySelectorAll('.ProseMirror')].find((d) => (d as HTMLElement).offsetParent) as unknown as { editor: { state: { selection: { $from: { parent: { textContent: string } } } } } };
      return view.editor.state.selection.$from.parent.textContent;
    });
  // Right after opening the editor may still settle: click until the cursor is in the line, then mark it by keyboard.
  const mark = async (text: string) => {
    await expect
      .poll(async () => {
        await editor().getByText(text).click();
        return cursorIn();
      })
      .toBe(text);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
  };
  const h2 = page.getByRole('button', { name: 'Überschrift 2', exact: true });
  await mark('Kapitel eins');
  await h2.click();
  await expect(editor().locator('h2', { hasText: 'Kapitel eins' })).toBeVisible();
  await mark('Kapitel eins');
  await expect(h2).toHaveAttribute('aria-pressed', 'true');
  await h2.click();
  await expect(editor().locator('p', { hasText: 'Kapitel eins' })).toBeVisible();
  // In a list item a heading may not stand: the buttons are off there.
  await mark('Punkt');
  await expect(page.getByRole('button', { name: 'Überschrift 1', exact: true })).toBeDisabled();
});

test('changed outside while typing: „Zusammenführen“ keeps both at different places, refuses the same place', async () => {
  writeFileSync(join(NOTES, 'zusammen.md'), '# Zusammen\n\nAbsatz eins.\n\nAbsatz zwei.\n');
  await openNote('zusammen');
  const banner = page.getByRole('alert').filter({ hasText: 'außerhalb geändert' });
  await editor().getByText('Absatz eins.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Ich');
  writeFileSync(join(NOTES, 'zusammen.md'), read('zusammen.md').replace('Absatz zwei.', 'Absatz zwei. Extern'));
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await shot(page, '21b-zusammenfuehren');
  await banner.getByRole('button', { name: 'Zusammenführen', exact: true }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => read('zusammen.md'), { timeout: 10_000 }).toContain('Absatz eins. Ich\n\nAbsatz zwei. Extern');
  await expect(editor()).toContainText('Absatz zwei. Extern');
  // The same paragraph on both sides: nothing changes, the notice stays for choosing a version.
  await expect(editor()).toBeFocused();
  await page.keyboard.type('!');
  writeFileSync(join(NOTES, 'zusammen.md'), read('zusammen.md').replace('Absatz eins. Ich', 'Absatz eins. Anders'));
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await banner.getByRole('button', { name: 'Zusammenführen', exact: true }).click();
  await expect(page.getByText('Ihr habt dieselbe Stelle geändert', { exact: false }).first()).toBeVisible();
  expect(read('zusammen.md')).toContain('Absatz eins. Anders');
  await banner.getByRole('button', { name: 'Meine Version speichern' }).click();
  await expect.poll(() => read('zusammen.md'), { timeout: 10_000 }).toContain('Absatz eins. Ich!');
});
