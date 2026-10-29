// Phase 1 end-to-end: setup, local mount via wizard, tree, editor (slash commands, autosave,
// minimal diff), links, search with context actions, external edits, dark mode — and, when a
// Gitea token is available, a remote mount on the branch `e2e` of the test repository `<owner>/kaveyl-wiki-test` (never `main`).
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSettingsPage } from './settings-nav';
import { shot } from './shots';

const E2E_DIR = resolve(import.meta.dirname, '../.local/e2e');
const NOTES = join(E2E_DIR, 'projekte/notizen');

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test('first-run setup creates the admin', async () => {
  await page.goto('/');
  await expect(page.getByText('Kaveyl Wiki einrichten')).toBeVisible();
  // One-time code from the container log, also in <config>/setup-code (AD-043): a wrong one is refused.
  await page.getByLabel('Einrichtungscode').fill('AAAA-BBBB-CCCC');
  await page.getByLabel('Name', { exact: true }).fill('E2E Admin');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort', { exact: true }).fill('E2E-Passwort-12345');
  await page.getByLabel('Passwort wiederholen').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page.getByText('Einrichtungscode falsch')).toBeVisible();
  await page.getByLabel('Einrichtungscode').fill(readFileSync(join(E2E_DIR, 'config/setup-code'), 'utf8').trim());
  await shot(page, '01-setup');
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page.getByText('Noch keine Quelle eingebunden.')).toBeVisible();
  expect(existsSync(join(E2E_DIR, 'config/setup-code'))).toBe(false);
  // Welcome page instead of an empty main area: first steps for the admin, features with ways into settings/manual.
  const welcome = page.getByTestId('welcome');
  await expect(welcome.getByRole('heading', { name: /Willkommen bei Kaveyl Wiki/ })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Quelle einbinden' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Mehr zu Backup' })).toBeVisible();
  // Nothing set up yet: no step is ticked off (a fresh install has one account and no backup plan).
  await expect(welcome.getByText('(erledigt)')).toHaveCount(0);
  // A new installation: without a rule, users see nothing (AD-051). The later specs test rules on top of
  // „lesen & schreiben“ (the default of installations from before) – set it once here.
  expect(await (await page.request.get('/api/admin/acl-default')).json()).toEqual({ level: 'none' });
  expect((await page.request.put('/api/admin/acl-default', { data: { level: 'write' } })).ok()).toBe(true);
  await expect(welcome.getByRole('button', { name: 'Nicht mehr anzeigen' })).toHaveCount(0);
  await shot(page, '02b-willkommen');
  // Plain http straight to the server: the reverse proxy step is open and leads to its tab.
  await expect(welcome.getByText('Reverse-Proxy mit https einrichten')).toBeVisible();
  await welcome.getByRole('button', { name: 'Reverse-Proxy', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Einstellungen' }).getByRole('tab', { name: 'Reverse-Proxy', selected: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('mounts a local folder through the wizard', async () => {
  await page.locator('aside').getByRole('button', { name: 'Quelle einbinden' }).click();
  await page.getByRole('button', { name: 'Lokaler Ordner' }).click();
  await page.getByRole('button', { name: /projekte/ }).click();
  await expect(page.getByRole('button', { name: 'Diesen Ordner wählen' })).toBeEnabled();
  await shot(page, '03b-lokaler-ordner');
  await page.getByRole('button', { name: /notizen/ }).click();
  await page.getByRole('button', { name: 'Diesen Ordner wählen' }).click();
  await expect(page.getByText('6 von 6 Notizen ausgewählt')).toBeVisible();
  await shot(page, '03-wizard-selection');
  await page.getByRole('button', { name: 'Weiter' }).click();
  // A folder without Git: versions are offered and on by default (AD-071), no commit options of its own.
  const versions = page.getByRole('checkbox', { name: /Versionen führen/ });
  await expect(versions).toBeChecked();
  await expect(page.getByText('Änderungen automatisch committen')).toHaveCount(0);
  // This one stays a plain folder: later tests use its folder trash.
  await versions.uncheck();
  await page.getByLabel('Name in der Seitenleiste').fill('Notizen');
  await page.getByRole('button', { name: 'Icon der Quelle' }).click();
  await page.getByRole('tab', { name: 'Emoji' }).click();
  await page.getByRole('button', { name: 'Emoji 📒' }).click();
  await page.getByRole('button', { name: 'Einbinden' }).click();
  await expect(page.locator('aside nav[aria-label="Quellen"]').getByText('Notizen', { exact: true })).toBeVisible();
  // The first step is ticked off; the welcome page can be hidden and brought back.
  const welcome = page.getByTestId('welcome');
  await expect(welcome.getByText('Quelle einbinden (erledigt)')).toBeAttached();
  await welcome.getByRole('button', { name: 'Mehr zu KI-Assistent' }).click();
  await expect(page.getByRole('dialog', { name: 'Hilfe' })).toBeVisible();
  await page.keyboard.press('Escape');
  await welcome.getByRole('button', { name: 'Nicht mehr anzeigen' }).click();
  await expect(page.getByText('Wähle links eine Notiz oder suche danach.')).toBeVisible();
  // Hiding says where it comes back; the help tab brings it back as well as the button in the empty middle.
  await expect(page.getByText('Zurückholen: Einstellungen → Hilfe → „Willkommensseite wieder anzeigen“.')).toBeVisible();
  await openSettingsPage(page, 'Hilfe');
  await page.getByRole('button', { name: 'Willkommensseite wieder anzeigen' }).click();
  await expect(page.getByText('Wird angezeigt, solange keine Notiz offen ist', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: 'Nicht mehr anzeigen' }).click();
  await page.getByRole('button', { name: 'Willkommensseite anzeigen' }).click();
  await expect(welcome).toBeVisible();
});

test('shows the tree with file names, folder notes and no code files', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('Notizen', { exact: true }).click();
  const aside = page.locator('aside nav[aria-label="Quellen"]');
  // File names without .md, not the frontmatter title ("Trilium Ideen").
  await expect(aside.getByText('trilium', { exact: true })).toBeVisible();
  await expect(aside.getByText('Trilium Ideen')).toHaveCount(0);
  await expect(aside.getByText('plan', { exact: true })).toBeVisible();
  await expect(aside.getByText('code.ts')).toHaveCount(0);
  await expect(aside.getByText('src', { exact: true })).toHaveCount(0);
  await shot(page, '04-tree');
});

test('opening a note never changes the file', async () => {
  const before = readFileSync(join(NOTES, 'stand.md'), 'utf8');
  await page.locator('aside nav[aria-label="Quellen"]').getByText('stand', { exact: true }).click();
  await expect(page.locator('.prose-note').getByText('endet mit Liste')).toBeVisible();
  // Placing the cursor creates an editor transaction — that is what used to trigger the
  // trailing-paragraph normalization (and a blank-line diff) in notes ending with a list.
  await page.locator('.prose-note').getByText('Stand', { exact: true }).click();
  await page.locator('.prose-note').getByText('endet mit Liste').click();
  await page.waitForTimeout(1500); // longer than the autosave debounce
  await expect(page.getByText('Gespeichert', { exact: true }).filter({ visible: true })).toBeVisible();
  expect(readFileSync(join(NOTES, 'stand.md'), 'utf8')).toBe(before);
});

test('soft line breaks survive clicking, keys and leaving the note (no file change)', async () => {
  // Found in the live test with AGENTS.md: ProseMirror turned soft breaks in task items into
  // hard breaks after a DOM re-read, and leaving the note saved `\` line endings.
  const md = '# Agenten\n\n- [ ] Gitea-Token laden (`source x.env`, siehe Abschnitt 9)\n  — MUSS vor dem allerersten `git fetch` passieren.\n  Henne-Ei sonst.\n- [ ] Zweiter Punkt\n\nAbsatz mit\nweichem Umbruch.\n';
  writeFileSync(join(NOTES, 'agenten.md'), md);
  await expect(page.locator('aside nav[aria-label="Quellen"]').getByText('agenten', { exact: true })).toBeVisible();
  await page.locator('aside nav[aria-label="Quellen"]').getByText('agenten', { exact: true }).click();
  // Typing makes the browser change the DOM, which ProseMirror re-reads: a character typed
  // and deleted again must leave the file byte-identical (soft breaks stay soft).
  await page.locator('.prose-note p', { hasText: 'Henne-Ei sonst.' }).filter({ visible: true }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await page.locator('.prose-note p', { hasText: 'weichem Umbruch.' }).filter({ visible: true }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('y');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(1500);
  await page.locator('aside nav[aria-label="Quellen"]').getByText('stand', { exact: true }).click(); // leave the note
  await page.waitForTimeout(1500);
  expect(readFileSync(join(NOTES, 'agenten.md'), 'utf8')).toBe(md);

  // Shown like CommonMark, Wiki.js and Gitea (AD-036): one paragraph, the soft break reads as a space.
  await page.locator('aside nav[aria-label="Quellen"]').getByText('agenten', { exact: true }).click();
  const para = page.locator('.prose-note p', { hasText: 'weichem Umbruch.' }).filter({ visible: true }).first();
  await expect(para).toHaveText('Absatz mit weichem Umbruch.');
  await expect(para.locator('br')).toHaveCount(0);
  // The caret steps over the space as one character; typing on both sides keeps the newline in the file.
  await para.click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Absatz mit'.length; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('A');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('B');
  await expect.poll(() => readFileSync(join(NOTES, 'agenten.md'), 'utf8'), { timeout: 10_000 }).toContain('Absatz mitA\nBweichem Umbruch.');
  execFileSync('rm', [join(NOTES, 'agenten.md')]);
});

test('edits a note with a minimal diff and autosave', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('trilium', { exact: true }).click();
  const editor = page.locator('.prose-note');
  await expect(editor.getByText('Erster Absatz über Hierarchien.')).toBeVisible();
  await editor.getByText('Erster Absatz über Hierarchien.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Ergänzt im Browser.');
  await expect(page.getByText('Gespeichert', { exact: true }).filter({ visible: true })).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => readFileSync(join(NOTES, 'trilium.md'), 'utf8')).toBe(
    '---\ntitle: Trilium Ideen\ntags: pkm, wiki\n---\n\n# Ignoriert\n\n* Stern-Liste bleibt\n* unverändert\n\nErster Absatz über Hierarchien. Ergänzt im Browser.\n',
  );
  await shot(page, '05-editor');
});

test('inserts a checklist via slash command', async () => {
  const editor = page.locator('.prose-note');
  await editor.getByText('Ergänzt im Browser.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/check');
  await expect(page.getByRole('button', { name: /Checkliste.*Aufgaben zum Abhaken/ })).toBeVisible();
  await shot(page, '06-slash');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Aufgabe aus dem Slash-Menü');
  await expect.poll(() => readFileSync(join(NOTES, 'trilium.md'), 'utf8'), { timeout: 10_000 }).toContain('- [ ] Aufgabe aus dem Slash-Menü');
});

test('follows relative and Wiki.js-style links', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('plan', { exact: true }).click();
  await page.locator('aside nav[aria-label="Quellen"]').getByText('roadmap', { exact: true }).click();
  await page.locator('.prose-note').getByRole('link', { name: 'Wiki.js-Stil' }).click();
  await expect(page.locator('.prose-note').getByText('Detailseite.')).toBeVisible();
  await page.locator('aside nav[aria-label="Quellen"]').getByText('roadmap', { exact: true }).click();
  await page.locator('.prose-note').getByRole('link', { name: 'Trilium' }).click();
  await expect(page.locator('.prose-note').getByText('Stern-Liste bleibt')).toBeVisible();
});

test('instant search with grouping, new tab and reveal in tree', async () => {
  const search = page.getByLabel('Notizen durchsuchen');
  await search.fill('hierar');
  await expect(page.getByText('Inhalt', { exact: true })).toBeVisible();
  await search.fill('roadm');
  const hit = page.locator('div.mx-1').filter({ hasText: 'roadmap' }).first();
  await expect(hit).toBeVisible();
  await shot(page, '07-search');
  const tabsBefore = await page.locator('[data-tab]').count();
  await hit.click({ button: 'middle' });
  await expect(page.locator('[data-tab]')).toHaveCount(tabsBefore + 1);
  await hit.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Im Baum anzeigen' }).click();
  await expect(page.locator('[data-node$=":plan/roadmap.md"]')).toHaveClass(/bg-active/);
});

test('reloads a clean editor when the file changes on disk', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('details', { exact: true }).click();
  writeFileSync(join(NOTES, 'plan/details.md'), '# Details\n\nExtern geändert in VS Code.\n');
  await expect(page.locator('.prose-note').getByText('Extern geändert in VS Code.')).toBeVisible({ timeout: 10_000 });
});

test('creates a note from the tree context menu', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('plan', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Neue Notiz hier' }).click();
  await page.getByLabel('Titel').fill('Meeting: Kickoff');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.locator('aside nav[aria-label="Quellen"]').getByText('Meeting - Kickoff', { exact: true })).toBeVisible();
  // Shown and sorted by file name, case-insensitive: details < Meeting - Kickoff < roadmap.
  await expect(page.locator('aside [data-node*=":plan/"]')).toHaveText(['details', 'Meeting - Kickoff', 'roadmap']);
  expect(readFileSync(join(NOTES, 'plan/Meeting - Kickoff.md'), 'utf8')).toMatch(/^---\nid: [0-9A-Z]{26}\n---\n# Meeting: Kickoff\n$/);
});

test('renames and moves a note: name field plus folder dropdown, no free-text path', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('Meeting - Kickoff', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Umbenennen / verschieben' }).click();
  await expect(page.getByLabel('Dateiname')).toHaveValue('Meeting - Kickoff');
  await expect(page.getByRole('button', { name: 'Ordner wählen' })).toHaveText('Notizen › plan');
  await page.getByLabel('Dateiname').fill('Kickoff');
  await page.getByRole('button', { name: 'Ordner wählen' }).click();
  await expect(page.getByRole('option')).toHaveText(['Oberste Ebene', 'plan']);
  await page.getByRole('option', { name: 'Oberste Ebene' }).click();
  await shot(page, '17-move-dialog');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(readFileSync(join(NOTES, 'Kickoff.md'), 'utf8')).toMatch(/# Meeting: Kickoff\n$/);
  expect(() => readFileSync(join(NOTES, 'plan/Meeting - Kickoff.md'))).toThrow();
  // A folder is never offered as a target inside itself; the filter narrows the list.
  await page.locator('aside nav[aria-label="Quellen"]').getByText('plan', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Umbenennen / verschieben' }).click();
  await expect(page.getByLabel('Ordnername')).toHaveValue('plan');
  await page.getByRole('button', { name: 'Ordner wählen' }).click();
  await expect(page.getByRole('option')).toHaveText(['Oberste Ebene']);
  await page.getByLabel('Ordner suchen').fill('xyz');
  await expect(page.getByText('Kein Ordner gefunden')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Abbrechen' }).click();
});

test('shows a formatting toolbar and a selection menu (visible WYSIWYG)', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('trilium', { exact: true }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: /Fett/ })).toBeVisible();
  // Select a word and make it bold via the selection menu.
  await page.locator('.prose-note').getByText('Erster Absatz über Hierarchien.').dblclick();
  const bubble = page.locator('[data-tippy-root], .tiptap-bubble, div[style*="position"]').getByRole('button', { name: 'Kursiv', exact: true });
  await expect(bubble.first()).toBeVisible();
  await shot(page, '12-toolbar-bubble');
  await toolbar.getByRole('button', { name: /Fett/ }).click();
  await expect.poll(() => readFileSync(join(NOTES, 'trilium.md'), 'utf8'), { timeout: 10_000 }).toMatch(/\*\*\w+\*\*/);
});

test('table of contents on the right jumps to headings', async () => {
  await page.locator('aside nav[aria-label="Quellen"]').getByText('handbuch', { exact: true }).click();
  const toc = page.getByRole('navigation', { name: 'Inhaltsverzeichnis' });
  await expect(toc).toBeVisible();
  await expect(toc.getByRole('button')).toHaveText(['Handbuch', 'Einleitung', 'Installation', 'Docker', 'Betrieb']);
  await toc.getByRole('button', { name: 'Betrieb' }).click();
  await expect(page.locator('.prose-note h2', { hasText: 'Betrieb' })).toBeInViewport();
  await expect(toc.getByRole('button', { name: 'Betrieb' })).toHaveClass(/border-accent/);
  // The TOC stays visible while the note scrolls (sticky), and follows manual scrolling.
  await expect(toc).toBeInViewport();
  await page.waitForTimeout(1000); // let the click pin expire
  await page.locator('.prose-note h2', { hasText: 'Einleitung' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(toc.getByRole('button', { name: 'Einleitung' })).toHaveClass(/border-accent/, { timeout: 3000 });
  await expect(toc).toBeInViewport();
  await shot(page, '13-toc');
  await page.getByRole('button', { name: 'Inhaltsverzeichnis ein-/ausblenden' }).filter({ visible: true }).click();
  await expect(toc).toHaveCount(0);
  await page.getByRole('button', { name: 'Inhaltsverzeichnis ein-/ausblenden' }).filter({ visible: true }).click();
});

test('editor width: full width toggle and percent setting', async () => {
  const column = page.locator('.prose-note').filter({ visible: true }).locator('xpath=../..');
  await expect(column).toHaveCSS('max-width', '860px');
  await page.getByRole('button', { name: 'Volle Breite' }).filter({ visible: true }).click();
  await expect(column).toHaveCSS('max-width', '100%');
  await shot(page, '14-full-width');
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('button', { name: 'Darstellung' }).click();
  await page.getByRole('button', { name: /^Eigene/ }).click();
  await page.getByLabel('Editorbreite in Prozent').fill('70');
  await page.keyboard.press('Escape');
  await expect(column).toHaveCSS('max-width', '70%');
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('button', { name: 'Darstellung' }).click();
  await page.getByRole('button', { name: /^Normal/ }).click();
  await page.keyboard.press('Escape');
  await expect(column).toHaveCSS('max-width', '860px');
});

test('sync overview lists every source with its state', async () => {
  await page.getByRole('button', { name: /^Sync-Status/ }).click();
  await expect(page.getByText('Alle Quellen synchron')).toBeVisible();
  // A plain local folder has nothing to sync: one line below the list, its name opens the history.
  await expect(page.getByText('Lokale Ordner ohne Git – nichts zu synchronisieren')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verlauf von Notizen' })).toBeVisible();
  await shot(page, '15-sync');
  await page.keyboard.press('Escape');
});

test('switches to dark mode', async () => {
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('button', { name: 'Darstellung' }).click();
  await page.getByRole('button', { name: 'Dunkel' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.keyboard.press('Escape');
  await page.locator('aside nav[aria-label="Quellen"]').getByText('roadmap', { exact: true }).click();
  await shot(page, '08-dark');
});

const TOKEN = process.env.GITEA_TOKEN;
/** Token for git via the environment — command lines are visible in `ps`. */
const authEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: token ${TOKEN}` });
const GITEA = process.env.GITEA_API_URL ? new URL(process.env.GITEA_API_URL).origin : null;
/** Test repository with fictional data; the E2E suite only ever writes to TEST_BRANCH, `main` belongs to the Dev instance. */
/** Account of the token: GITEA_OWNER, else the first path part of GITEA_API_URL (the account page). */
const OWNER = process.env.GITEA_OWNER || (process.env.GITEA_API_URL ? new URL(process.env.GITEA_API_URL).pathname.split('/')[1] : '') || '';
const TEST_REPO = `${OWNER}/kaveyl-wiki-test`;
const TEST_BRANCH = 'e2e';

test('mounts the Gitea test branch, edits and pushes (never main)', async () => {
  test.skip(!TOKEN || !GITEA, 'GITEA_TOKEN/GITEA_API_URL nicht gesetzt');
  const lsMain = () => execFileSync('git', ['ls-remote', `${GITEA}/${TEST_REPO}.git`, 'refs/heads/main'], { env: authEnv() }).toString().split('\t')[0];
  const mainBefore = lsMain();

  // Gitea as a connection (AD-029): Settings → Quellen → Verbindungen.
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  const settings = page.getByRole('dialog', { name: 'Einstellungen' });
  await openSettingsPage(page, 'Verbindungen');
  await settings.getByRole('button', { name: 'Verbindung hinzufügen' }).click();
  const form = settings.getByRole('form', { name: 'Neue Verbindung' });
  await form.getByLabel('Adresse').fill(GITEA!);
  await form.getByLabel('Token').fill(TOKEN!);
  await form.getByRole('button', { name: 'Verbindung anlegen' }).click();
  const connection = settings.getByRole('region', { name: 'Verbindungen' }).getByRole('listitem').filter({ hasText: new URL(GITEA!).host });
  await expect(connection).toContainText('mit Token');
  await connection.getByRole('button', { name: 'Prüfen', exact: true }).click();
  await expect(connection).toContainText('angemeldet als');
  await openSettingsPage(page, 'Eingebundene Quellen');
  await settings.getByRole('button', { name: 'Quelle einbinden' }).click();

  await page.getByPlaceholder('Repository suchen …').fill('kaveyl-wiki-test');
  // First as if the repository were still empty (no commit, no branch): the step says so instead of a grey „Weiter“ (owner 26.10.).
  await page.route('**/api/sources/branches', (route) => route.fulfill({ json: [] }));
  await page.getByRole('button', { name: TEST_REPO }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Das Repository ist noch leer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  await page.unroute('**/api/sources/branches');
  await page.getByRole('button', { name: 'Erneut prüfen' }).click();
  await page.getByRole('radio', { name: TEST_BRANCH, exact: true }).check();
  await shot(page, '09-branch');
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.getByText(/Notizen ausgewählt/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Keine' }).click();
  await page.getByRole('checkbox').nth(1).click(); // first top-level folder (docs)
  await shot(page, '10-remote-selection');
  await page.getByRole('button', { name: 'Weiter' }).click();
  await page.getByLabel('Name in der Seitenleiste').fill('Team-Wiki (Test)');
  await page.getByRole('button', { name: 'Einbinden' }).click();
  await expect(page.getByRole('dialog', { name: 'Quelle einbinden' })).toHaveCount(0);
  await page.keyboard.press('Escape'); // the settings below

  const aside = page.locator('aside nav[aria-label="Quellen"]');
  await aside.getByText('Team-Wiki (Test)').click();
  await aside.getByText('docs', { exact: true }).click();
  await aside.getByText(/^home$/i).click();
  await expect(page.locator('.prose-note').getByText(/Willkommen/).first()).toBeVisible();
  await shot(page, '11-remote-tree');
  // Edit a note of its own (created and deleted again) — never the shared Home page.
  await aside.getByText('docs', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Neue Notiz hier' }).click();
  await page.getByLabel('Titel').fill('E2E Stempel');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  const heading = page.locator('.prose-note h1', { hasText: 'E2E Stempel' }).filter({ visible: true });
  await heading.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`E2E ${new Date().toISOString()}`);
  await expect(page.getByText('Gespeichert', { exact: true }).filter({ visible: true })).toBeVisible({ timeout: 10_000 });

  const remoteHead = () =>
    execFileSync('git', ['ls-remote', `${GITEA}/${TEST_REPO}.git`, `refs/heads/${TEST_BRANCH}`], { env: authEnv() })
      .toString()
      .split('\t')[0];
  const before = remoteHead();
  await expect.poll(remoteHead, { timeout: 30_000 }).not.toBe(before);
  const pushed = remoteHead();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Löschen' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click();
  await expect.poll(remoteHead, { timeout: 30_000 }).not.toBe(pushed);
  expect(lsMain()).toBe(mainBefore);
});

test('creates a new Gitea repository from the wizard (creation intercepted, nothing created on Gitea)', async () => {
  test.skip(!TOKEN || !GITEA, 'GITEA_TOKEN/GITEA_API_URL nicht gesetzt');
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/connections/*/repos', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON() as Record<string, unknown>;
    // Answer like the server would, pointing at the existing test repo so the wizard can go on.
    await route.fulfill({ json: { fullName: `${OWNER}/neues-wiki`, description: '', cloneUrl: `${GITEA}/${TEST_REPO}.git`, defaultBranch: 'main', private: true, updatedAt: '' } });
  });
  await page.getByRole('button', { name: 'Quelle einbinden' }).first().click();
  await page.getByRole('button', { name: 'Neues Repository' }).click();
  await expect(page.getByLabel('Besitzer')).toHaveValue(`user:${OWNER}`);
  await page.getByLabel('Repository-Name').fill('neues-wiki');
  await page.getByLabel('Beschreibung (optional)').fill('Testbeschreibung');
  await shot(page, '18-new-repo');
  await page.getByRole('button', { name: 'Anlegen und weiter' }).click();
  await expect(page.getByRole('radio', { name: TEST_BRANCH, exact: true })).toBeVisible({ timeout: 15_000 });
  expect(sent).toEqual({ owner: { name: OWNER, kind: 'user' }, name: 'neues-wiki', description: 'Testbeschreibung', private: true });
  await page.unroute('**/api/connections/*/repos');
  // Half-way through the wizard: closing asks first – in a Kaveyl Wiki window, not the browser's confirm().
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog', { name: 'Ungespeicherte Eingaben verwerfen?' }).getByRole('button', { name: 'Verwerfen' }).click();
  await expect(page.getByRole('dialog', { name: 'Quelle einbinden' })).toHaveCount(0);
});

test('moves a note with its image into another source', async () => {
  mkdirSync(join(NOTES, 'assets'), { recursive: true });
  writeFileSync(join(NOTES, 'assets/bild.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(NOTES, 'bildnotiz.md'), '# Bildnotiz\n\n![Bild](assets/bild.png)\n');
  await page.getByRole('button', { name: 'Quelle einbinden' }).first().click();
  await page.getByRole('button', { name: 'Lokaler Ordner' }).click();
  await page.getByRole('button', { name: /projekte/ }).click();
  await page.getByRole('button', { name: /archiv/ }).click();
  await page.getByRole('button', { name: 'Diesen Ordner wählen' }).click();
  await page.getByRole('button', { name: 'Weiter' }).click();
  // Plain folder: a test below gives it a Git of its own by hand.
  await page.getByRole('checkbox', { name: /Versionen führen/ }).uncheck();
  await page.getByLabel('Name in der Seitenleiste').fill('Archiv');
  await page.getByRole('button', { name: 'Einbinden' }).click();
  const aside = page.locator('aside nav[aria-label="Quellen"]');
  await expect(aside.getByText('Archiv', { exact: true })).toBeVisible();

  await aside.getByText('bildnotiz', { exact: true }).click();
  await expect(page.locator('.prose-note h1', { hasText: 'Bildnotiz' })).toBeVisible();
  await aside.getByText('bildnotiz', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Umbenennen / verschieben' }).click();
  await page.getByRole('button', { name: 'Ordner wählen' }).click();
  await page.getByLabel('Ordner suchen').fill('archiv');
  await expect(page.getByRole('option')).toHaveText(['Oberste Ebene', 'alt']);
  await page.getByRole('option', { name: 'alt' }).click();
  await expect(page.getByRole('button', { name: 'Ordner wählen' })).toHaveText('Archiv › alt');
  await expect(page.getByText('Die Git-Historie bleibt in Notizen')).toBeVisible();
  await shot(page, '19-move-across');
  await page.getByRole('button', { name: 'Verschieben' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  const ARCHIV = join(E2E_DIR, 'projekte/archiv');
  expect(readFileSync(join(ARCHIV, 'alt/bildnotiz.md'), 'utf8')).toBe('# Bildnotiz\n\n![Bild](assets/bild.png)\n');
  expect(readFileSync(join(ARCHIV, 'alt/assets/bild.png'))).toEqual(Buffer.from([137, 80, 78, 71]));
  expect(existsSync(join(NOTES, 'bildnotiz.md'))).toBe(false);
  expect(existsSync(join(NOTES, 'assets/bild.png'))).toBe(true);
  // The open tab follows the note into the other source and still shows it.
  // Breadcrumbs: source / folder / file name without .md.
  const crumbs = page.locator('main [title="Archiv / alt/bildnotiz.md"]').filter({ visible: true });
  await expect(crumbs).toHaveText(/^Archiv\s*\/\s*alt\s*\/\s*bildnotiz$/);
  await expect(page.locator('[data-tab="alt/bildnotiz.md"]')).toHaveText('bildnotiz');
  await expect(page.locator('.prose-note h1', { hasText: 'Bildnotiz' })).toBeVisible();
  await expect(page.getByText(/nicht gefunden/i)).toHaveCount(0);
});

test('shows backlinks and rewrites links when a note is renamed in the app', async () => {
  const aside = page.locator('aside nav[aria-label="Quellen"]');
  await aside.getByText('details', { exact: true }).click();
  const backlinks = page.getByRole('region', { name: 'Verlinkt von' });
  await expect(backlinks).toContainText('roadmap');
  await shot(page, '20-backlinks');

  await aside.getByText('details', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Umbenennen / verschieben' }).click();
  await page.getByLabel('Dateiname').fill('Detailseite');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  // Wiki.js-style link (absolute, without .md) keeps its style; the relative link stays untouched.
  await expect.poll(() => readFileSync(join(NOTES, 'plan/roadmap.md'), 'utf8')).toBe('# Roadmap\n\nSiehe [Trilium](../trilium.md) und [Wiki.js-Stil](/plan/Detailseite).\n');
  await expect(backlinks).toContainText('roadmap');
});

test('resolves a real sync conflict on the Gitea test branch in the three-way dialog', async () => {
  test.skip(!TOKEN || !GITEA, 'GITEA_TOKEN/GITEA_API_URL nicht gesetzt');
  const auth = ['-c', 'user.name=Extern', '-c', 'user.email=extern@x'];
  const clone = join(E2E_DIR, 'extern-clone');
  const g = (...args: string[]) => execFileSync('git', [...auth, '-C', clone, ...args], { env: authEnv() }).toString();
  const lsMain = () => execFileSync('git', [...auth, 'ls-remote', `${GITEA}/${TEST_REPO}.git`, 'refs/heads/main'], { env: authEnv() }).toString().split('\t')[0];
  const mainBefore = lsMain();
  execFileSync('git', [...auth, 'clone', '-q', '-b', TEST_BRANCH, `${GITEA}/${TEST_REPO}.git`, clone], { env: authEnv() });
  const pushFile = (content: string, msg: string) => {
    writeFileSync(join(clone, 'docs/konflikt.md'), content);
    g('add', '-A');
    if (g('status', '--porcelain').trim()) g('commit', '-q', '-m', msg);
    g('push', '-q', 'origin', `HEAD:refs/heads/${TEST_BRANCH}`);
  };
  pushFile('# Konflikt\n\nZeile.\n', 'E2E: Konflikt-Datei');

  await page.getByRole('button', { name: /^Sync-Status/ }).click();
  await page.getByRole('button', { name: 'Team-Wiki (Test) jetzt synchronisieren' }).click();
  await page.keyboard.press('Escape');
  const aside = page.locator('aside nav[aria-label="Quellen"]');
  await aside.getByText('konflikt', { exact: true }).click();
  await expect(page.locator('.prose-note').getByText('Zeile.')).toBeVisible();

  pushFile('# Konflikt\n\nZeile fremd.\n', 'E2E: fremde Änderung');
  await page.locator('.prose-note p', { hasText: 'Zeile.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Meine Ergänzung.');
  await expect(page.getByRole('button', { name: /Sync-Status: 1 Quelle braucht/ })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /^Sync-Status/ }).click();
  await page.getByRole('button', { name: 'Konflikt lösen' }).click();
  await expect(page.getByLabel('Meine Version')).toContainText('Zeile. Meine Ergänzung.');
  await expect(page.getByLabel('Fremde Version (Server)')).toContainText('Zeile fremd.');
  await expect(page.getByLabel('Zusammengeführter Text')).toHaveValue(/<<<<<<<[\s\S]*>>>>>>>/);
  await expect(page.getByRole('button', { name: 'Auflösen und synchronisieren' })).toBeDisabled();
  await shot(page, '23-conflict');
  await page.getByRole('radio', { name: 'Meine behalten' }).click();
  await page.getByRole('button', { name: 'Auflösen und synchronisieren' }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Sync-Status: Alle Quellen synchron' })).toBeVisible({ timeout: 30_000 });

  g('pull', '-q', 'origin', TEST_BRANCH);
  expect(readFileSync(join(clone, 'docs/konflikt.md'), 'utf8')).toBe('# Konflikt\n\nZeile. Meine Ergänzung.\n');
  expect(g('log', '-1', '--format=%s').trim()).toBe('merge: Konflikt aufgelöst (docs/konflikt.md) (Kaveyl Wiki)');
  expect(lsMain()).toBe(mainBefore);
});

test('runs the consistency check from the settings and lists problems per source', async () => {
  writeFileSync(join(NOTES, 'kaputt.md'), '# Kaputt\n\n[Nirgendwo](gibts/nicht.md)\n');
  await expect(page.locator('aside nav[aria-label="Quellen"]').getByText('kaputt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(page, 'Prüfung');
  await page.getByRole('button', { name: 'Jetzt prüfen' }).click();
  // One folded row per source with a count by kind; the details on demand.
  const notizen = page.getByRole('region', { name: 'Prüfbericht Notizen' });
  await expect(notizen).toContainText('1 Gebrochener Link');
  await expect(notizen).not.toContainText('„gibts/nicht.md“ führt ins Leere');
  await notizen.getByRole('button', { name: /Notizen/ }).click();
  await expect(notizen).toContainText('„gibts/nicht.md“ führt ins Leere');
  await shot(page, '24-fsck');
  await notizen.getByRole('button', { name: 'kaputt.md' }).click();
  await expect(page.locator('.prose-note h1', { hasText: 'Kaputt' })).toBeVisible();
});

test('shows the event log, keeps retention settings and makes a backup on demand', async () => {
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(page, 'Protokoll');
  const log = page.getByRole('list', { name: 'Protokoll' });
  await expect(log).toContainText('Ersteinrichtung: Administrator');
  await expect(log).toContainText('Quelle eingebunden: Notizen');
  await page.getByLabel('Kategorie').selectOption('sync');
  await expect(log).not.toContainText('Ersteinrichtung');
  await page.getByLabel('Kategorie').selectOption('');
  await openSettingsPage(page, 'Datenbank');
  await page.getByRole('button', { name: 'Jetzt sichern' }).click();
  await expect(page.getByRole('list', { name: 'Backups' })).toContainText(/manuell-\d{4}-\d{2}-\d{2}-\d{6}\.db/);
  await expect(page.getByRole('button', { name: 'Vorhandene Backups' })).toHaveAttribute('aria-expanded', 'true');
  await openSettingsPage(page, 'Protokoll');
  await expect(log).toContainText('Datenbank gesichert');
  // The same deletion rules as in „Aufräumen“ (code-010), each with its own button.
  await page.getByLabel('Normale Einträge aufbewahren', { exact: true }).fill('45');
  await page.getByRole('button', { name: 'Normale Einträge aufbewahren speichern' }).click();
  await expect(log).toContainText('Löschregeln geändert: logInfoDays 30 → 45');
  await shot(page, '25-log');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Sync-Status/ }).click();
  await page.getByRole('button', { name: 'Verlauf von Notizen' }).click();
  await expect(page.getByRole('dialog', { name: 'Verlauf: Notizen' })).toContainText('Quelle eingebunden: Notizen');
  await page.keyboard.press('Escape');
});

test('repository delete dialog: trash by default, delete now only after typing the name (nothing is sent)', async () => {
  test.skip(!TOKEN || !GITEA, 'GITEA_TOKEN/GITEA_API_URL nicht gesetzt');
  // Safety net: this test must never archive or delete the shared test repository.
  let blocked = 0;
  for (const pattern of ['**/api/repos/**', '**/api/gitea/repos/**'])
    await page.route(pattern, (route) => {
      blocked++;
      return route.abort();
    });
  await page.locator('aside nav[aria-label="Quellen"]').getByText('Team-Wiki (Test)', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Repository löschen …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Repository löschen' });
  await expect(dialog).toContainText(TEST_REPO);
  await expect(page.getByRole('radio', { name: 'In den Papierkorb (empfohlen)' })).toBeChecked();
  await page.getByRole('radio', { name: 'Sofort endgültig löschen' }).check();
  const go = page.getByRole('button', { name: 'Endgültig löschen' });
  await expect(go).toBeDisabled();
  await page.getByLabel(`Zum Bestätigen „${TEST_REPO}“ eingeben`).fill(`${OWNER}/kaveyl-wiki`);
  await expect(go).toBeDisabled();
  await shot(page, '26-repo-delete');
  await page.getByRole('button', { name: 'Abbrechen' }).click();
  expect(blocked).toBe(0);
  await page.unroute('**/api/repos/**');
  await page.unroute('**/api/gitea/repos/**');
  // Last test with the shared test repository: unmount it (files and repository stay), so the
  // pictures of later tests show only the neutral test notes (manual ships in the image, AD-043).
  const mounts = (await (await page.request.get('/api/mounts')).json()) as { id: string; name: string }[];
  const wiki = mounts.find((m) => m.name === 'Team-Wiki (Test)');
  if (wiki) expect((await page.request.delete(`/api/mounts/${wiki.id}`, { data: {} })).ok()).toBe(true);
});

// After the shared test repository is unmounted, so its pictures show only the test notes.
test('shows versions with diffs, restores one, and brings back a deleted note', async () => {
  // Warnings of earlier tests (e.g. the conflict) stay until closed – not in these pictures.
  const closers = page.locator('[role="status"][data-print="hide"]').getByRole('button', { name: 'Schließen' });
  for (let i = 0; i < 10 && (await closers.count()) > 0; i++) await closers.first().click();
  const ARCHIV = join(E2E_DIR, 'projekte/archiv');
  const g = (...args: string[]) => execFileSync('git', ['-C', ARCHIV, '-c', 'user.name=Tester', '-c', 'user.email=t@x', ...args]).toString();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(ARCHIV, 'versionen.md'), '# Versionen\n\nErste Fassung.\n');
  writeFileSync(join(ARCHIV, 'alt/geloescht.md'), '# Gelöscht\n\nKommt zurück.\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'Erste Fassung');
  writeFileSync(join(ARCHIV, 'versionen.md'), '# Versionen\n\nZweite Fassung.\n');
  execFileSync('rm', [join(ARCHIV, 'alt/geloescht.md')]);
  g('add', '-A');
  g('commit', '-q', '-m', 'Zweite Fassung, Notiz gelöscht');

  const aside = page.locator('aside nav[aria-label="Quellen"]');
  await aside.getByText('versionen', { exact: true }).click();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Versionen' }).click();
  const list = page.getByRole('listbox', { name: 'Versionen' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(page.getByLabel('Unterschiede')).toContainText('+Zweite Fassung.');
  await list.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: 'Unterschied zur aktuellen Fassung' }).click();
  await expect(page.getByLabel('Unterschiede')).toContainText('-Erste Fassung.');
  await shot(page, '21-history');
  // Speichern als (AD-039): the old version as a new note — a taken name is caught, any source works.
  await page.getByRole('button', { name: 'Speichern als …' }).click();
  const saveAs = page.getByRole('dialog', { name: 'Speichern als' });
  await expect(saveAs.getByLabel('Dateiname')).toHaveValue(/^versionen \(Version \d\d\.\d\d\.\d{4}\)$/);
  await expect(saveAs.getByRole('button', { name: 'Ordner wählen' })).toContainText('Archiv › Oberste Ebene');
  await saveAs.getByLabel('Dateiname').fill('versionen');
  await expect(saveAs).toContainText('„versionen.md“ gibt es in diesem Ordner schon');
  await expect(saveAs.getByRole('button', { name: 'Speichern', exact: true })).toBeDisabled();
  await saveAs.getByRole('button', { name: '„versionen (2)“ verwenden' }).click();
  await saveAs.getByRole('button', { name: 'Ordner wählen' }).click();
  await page.locator('[role="option"][data-mount="Notizen"]', { hasText: 'Oberste Ebene' }).click();
  await expect(saveAs.getByRole('button', { name: 'Ordner wählen' })).toContainText('Notizen › Oberste Ebene');
  await shot(page, '116-version-speichern-als');
  await saveAs.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect.poll(() => (existsSync(join(NOTES, 'versionen (2).md')) ? readFileSync(join(NOTES, 'versionen (2).md'), 'utf8') : '')).toContain('Erste Fassung.');
  await expect(page.locator('[data-tab="versionen (2).md"]')).toBeVisible();
  expect(readFileSync(join(ARCHIV, 'versionen.md'), 'utf8')).toContain('Zweite Fassung.');

  await aside.getByText('versionen', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Versionen' }).click();
  await list.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: 'Diese Version wiederherstellen' }).click();
  await expect.poll(() => readFileSync(join(ARCHIV, 'versionen.md'), 'utf8')).toBe('# Versionen\n\nErste Fassung.\n');
  await expect(page.locator('.prose-note').getByText('Erste Fassung.')).toBeVisible();

  await aside.getByText('Archiv', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Papierkorb' }).click();
  await expect(page.getByRole('dialog')).toContainText('alt/geloescht.md');
  await shot(page, '22-trash');
  await page.getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
  await expect.poll(() => (existsSync(join(ARCHIV, 'alt/geloescht.md')) ? readFileSync(join(ARCHIV, 'alt/geloescht.md'), 'utf8') : '')).toBe('# Gelöscht\n\nKommt zurück.\n');
  await expect(page.getByRole('dialog')).toContainText('Der Papierkorb ist leer.');
  await page.keyboard.press('Escape');
});
