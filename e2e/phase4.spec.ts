// Phase 4 end-to-end: users and personal API tokens. Runs after phase1/phase3 (admin exists).
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitIndexed } from './indexed';
import { openSettingsPage } from './settings-nav';
import { shot } from './shots';


test.describe.configure({ mode: 'serial' });

async function mountIdOf(page: Page, name: string): Promise<string> {
  const mounts = (await (await page.request.get('/api/mounts')).json()) as { id: string; name: string }[];
  return mounts.find((m) => m.name === name)!.id;
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
}

test('admin creates a user; the user logs in, creates a read token and uses it', async ({ browser }) => {
  const admin = await browser.newPage();
  await login(admin, 'e2e@example.test', 'E2E-Passwort-12345');
  await admin.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(admin, 'Benutzer');
  // The form opens at the top of the list (owner 21.10.).
  await admin.getByRole('button', { name: 'Neuer Benutzer', exact: true }).click();
  const form = admin.getByRole('form', { name: 'Neuer Benutzer' });
  await form.getByLabel('E-Mail (Anmeldung)').fill('maria@example.test');
  await form.getByLabel('Name (Commit-Autor)').fill('Maria Muster');
  // No mail server in this suite: the invitation option is off, a start password is the way.
  await expect(form.getByRole('radio', { name: 'Einladung per E-Mail' })).toBeDisabled();
  await form.getByRole('textbox', { name: /^Startpasswort/ }).fill('Maria-Start-0001!');
  await form.getByRole('button', { name: 'Anlegen' }).click();
  const row = admin.getByRole('list', { name: 'Benutzer' }).getByRole('listitem').filter({ hasText: 'Maria Muster' });
  await expect(row).toContainText('muss Passwort ändern');
  await shot(admin, '43-benutzer');

  // First login: the start password must be replaced before anything else.
  const maria = await browser.newPage();
  await maria.goto('/');
  await maria.getByLabel('E-Mail').fill('maria@example.test');
  await maria.getByLabel('Passwort').fill('Maria-Start-0001!');
  await maria.getByRole('button', { name: 'Anmelden' }).click();
  await expect(maria.getByRole('heading', { name: 'Bitte ein neues Passwort festlegen' })).toBeVisible();
  await maria.getByLabel('Bisheriges Passwort').fill('Maria-Start-0001!');
  await maria.getByLabel('Neues Passwort').fill('Passwort12345678');
  await expect(maria.getByRole('list', { name: 'Anforderungen an das Passwort' })).toContainText('nicht leicht zu erraten – fehlt');
  await expect(maria.getByRole('button', { name: 'Passwort speichern' })).toBeDisabled();
  await maria.getByLabel('Neues Passwort').fill('Maria-Passwort-0001');
  await maria.getByLabel('Passwort wiederholen').fill('Maria-Passwort-0001');
  await shot(maria, '43b-passwort-pflicht');
  await maria.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(maria.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
  await maria.getByRole('button', { name: 'Einstellungen' }).click();
  await expect(maria.getByRole('button', { name: 'Benutzer & Rechte', exact: true })).toHaveCount(0);
  await openSettingsPage(maria, 'API-Tokens');
  const tf = maria.getByRole('form', { name: 'Neuer Token' });
  await tf.getByLabel('Name des Tokens').fill('Skript');
  await tf.getByRole('button', { name: 'Token erstellen' }).click();
  const token = (await maria.getByLabel('Token-Wert').textContent())!.trim();
  expect(token).toMatch(/^kw_/);
  await shot(maria, '44-api-tokens');
  const ctx = maria.context().request;
  const sources = await ctx.fetch('/api/v1/sources', { headers: { authorization: `Bearer ${token}`, cookie: '' } });
  expect(sources.status()).toBe(200);
  const write = await ctx.fetch('/api/v1/folders/x', { method: 'POST', headers: { authorization: `Bearer ${token}`, cookie: '', 'content-type': 'application/json' }, data: '{"name":"x"}' });
  expect(write.status()).toBe(403);
  // App routes (settings, sources …) only with the browser login (AD-047).
  expect((await ctx.fetch('/api/mounts', { headers: { authorization: `Bearer ${token}`, cookie: '' } })).status()).toBe(403);
  // A token with "MCP": the page shows the ready Claude Code command; /mcp answers with tools.
  await tf.getByLabel('Name des Tokens').fill('Claude');
  await tf.getByLabel('MCP').check();
  await tf.getByRole('button', { name: 'Token erstellen' }).click();
  await expect(maria.getByLabel('MCP-Befehl')).toContainText('claude mcp add --transport http kaveyl-wiki');
  await expect(maria.getByLabel('MCP-Konfiguration')).toContainText('"mcpServers"');
  const mcpToken = (await maria.getByLabel('Token-Wert').textContent())!.trim();
  const rpc = await ctx.fetch('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${mcpToken}`, cookie: '', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'Kolibri' } } }),
  });
  expect(rpc.status()).toBe(200);
  expect(((await rpc.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text).toContain('kolibri.md');
  await shot(maria, '59-mcp-token');

  // Locking the account ends the token and the session.
  await admin.getByRole('button', { name: 'maria sperren' }).click();
  expect((await ctx.fetch('/api/v1/sources', { headers: { authorization: `Bearer ${token}`, cookie: '' } })).status()).toBe(401);
  await maria.reload();
  await expect(maria.getByLabel('E-Mail')).toBeVisible();
  await admin.getByRole('button', { name: 'maria entsperren' }).click();
});

test('an account for an agent: start password without change, token made by the admin, renewed and deleted (owner 28.10.)', async ({ browser }) => {
  const admin = await browser.newPage();
  await login(admin, 'e2e@example.test', 'E2E-Passwort-12345');
  await admin.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(admin, 'Benutzer');
  await admin.getByRole('button', { name: 'Neuer Benutzer', exact: true }).click();
  const form = admin.getByRole('form', { name: 'Neuer Benutzer' });
  await form.getByLabel('E-Mail (Anmeldung)').fill('agent@example.test');
  await form.getByLabel('Name (Commit-Autor)').fill('Agent Claude');
  await form.getByRole('textbox', { name: /^Startpasswort/ }).fill('Agent-Start-0001!');
  const mustChange = form.getByRole('checkbox', { name: /Muss beim ersten Anmelden geändert werden/ });
  await expect(mustChange).toBeChecked();
  await mustChange.uncheck();
  await form.getByRole('button', { name: 'Anlegen' }).click();
  const row = admin.getByRole('list', { name: 'Benutzer' }).getByRole('listitem').filter({ hasText: 'Agent Claude' });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('muss Passwort ändern');

  // KI & APIs → Alle Tokens: standard size (AD-075, only the rights grid is wide); a token for the agent without signing in as it.
  await openSettingsPage(admin, 'Alle Tokens');
  const dialog = admin.getByRole('dialog', { name: 'Einstellungen' });
  expect((await dialog.boundingBox())!.width).toBeLessThan(900);
  const tf = dialog.getByRole('form', { name: 'Neuer Token' });
  await expect(tf.getByRole('button', { name: 'Token erstellen' })).toBeDisabled();
  await tf.getByLabel('Token für').selectOption({ label: 'Agent Claude (agent@example.test)' });
  await tf.getByLabel('Name des Tokens').fill('MCP');
  await tf.getByLabel('MCP').check();
  await expect(tf.getByLabel('verwalten')).toHaveCount(0);
  await tf.getByRole('button', { name: 'Token erstellen' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Neuer Token für Agent Claude' })).toBeVisible();
  await expect(dialog.getByLabel('MCP-Befehl')).toContainText('claude mcp add');
  const first = (await dialog.getByLabel('Token-Wert').textContent())!.trim();
  const list = dialog.getByRole('list', { name: 'Tokens aller Personen' });
  await expect(list.getByRole('listitem').filter({ hasText: 'Agent Claude' })).toContainText('angelegt von');
  await shot(admin, '44b-tokens-alle');
  const ctx = admin.context().request;
  const sources = (tok: string) => ctx.fetch('/api/v1/sources', { headers: { authorization: `Bearer ${tok}`, cookie: '' } }).then((r) => r.status());
  expect(await sources(first)).toBe(200);

  // Renew: a new value, the old one stops at once.
  await list.getByRole('button', { name: 'Token MCP erneuern' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Erneuern', exact: true }).click();
  await expect(dialog.getByLabel('Token-Wert')).not.toHaveText(first);
  const second = (await dialog.getByLabel('Token-Wert').textContent())!.trim();
  expect(await sources(first)).toBe(401);
  expect(await sources(second)).toBe(200);

  // The agent signs in without having to change the password and sees who made its token.
  const agent = await browser.newPage();
  await login(agent, 'agent@example.test', 'Agent-Start-0001!');
  await agent.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(agent, 'API-Tokens');
  await expect(agent.getByRole('list', { name: 'Tokens' }).getByRole('listitem').filter({ hasText: 'MCP' })).toContainText('angelegt von');
  await agent.close();

  // Delete (no longer „Widerrufen“): gone, the value stops working.
  await list.getByRole('button', { name: 'Token MCP löschen' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(list.getByRole('listitem').filter({ hasText: 'Agent Claude' })).toHaveCount(0);
  expect(await sources(second)).toBe(401);
});

test('presence: the admin sees that Maria has the note open and is typing', async ({ browser }) => {
  const admin = await browser.newPage();
  await login(admin, 'e2e@example.test', 'E2E-Passwort-12345');
  const maria = await browser.newPage();
  await login(maria, 'maria@example.test', 'Maria-Passwort-0001');
  const open = async (page: Page) => {
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('textbox', { name: 'Befehlspalette' })).toBeFocused();
    await page.keyboard.type('Kolibri');
    await page.getByRole('option', { name: /^kolibri/ }).first().click();
    await expect(page.locator('.prose-note').filter({ visible: true }).getByText('Suchwort')).toBeVisible();
  };
  await open(admin);
  await open(maria);
  await expect(admin.getByRole('status').filter({ hasText: 'Maria Muster hat die Notiz offen' })).toBeVisible({ timeout: 10_000 });
  await maria.locator('.prose-note').filter({ visible: true }).getByText('Suchwort').click();
  await maria.keyboard.press('End');
  await maria.keyboard.type(' (Maria)');
  await expect(admin.getByRole('status').filter({ hasText: 'Maria Muster bearbeitet gerade' })).toBeVisible({ timeout: 10_000 });
  await shot(admin, '45-praesenz');
  // Soft lock: the admin starts typing too – one question first; „Abbrechen“ drops the typed change.
  const adminNote = admin.locator('.prose-note').filter({ visible: true });
  const ask = admin.getByRole('alertdialog');
  await adminNote.getByText('Suchwort').click();
  await admin.keyboard.press('End');
  await admin.keyboard.type('X');
  await expect(ask).toContainText('Maria Muster bearbeitet diese Notiz gerade. Wenn ihr beide ändert');
  await shot(admin, '45b-weiche-sperre');
  await ask.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(ask).toHaveCount(0);
  await expect(adminNote.getByText('(Maria)')).toBeVisible();
  await expect(adminNote).not.toContainText('(Maria)X');
  // Asked again on the next try; „Trotzdem bearbeiten“ keeps the change and saves it, no second question.
  await adminNote.getByText('(Maria)').click();
  await admin.keyboard.press('End');
  await admin.keyboard.type('Y');
  await ask.getByRole('button', { name: 'Trotzdem bearbeiten' }).click();
  await expect(ask).toHaveCount(0);
  await admin.keyboard.type(' (Admin)');
  await expect(ask).toHaveCount(0);
  // Saved: Maria (no unsaved edits of her own) gets the admin's text – her cursor stays where it was.
  const mariaNote = maria.locator('.prose-note').filter({ visible: true });
  await expect(mariaNote).toBeFocused();
  await expect(mariaNote).toContainText('(Maria)Y (Admin)', { timeout: 10_000 });
  await expect(mariaNote).toBeFocused();
  // Maria leaves the note (closes its tab): the hint disappears. (Closing the whole browser tab
  // sends a beacon; if that is lost, the entry expires after 45 s.)
  await maria.getByRole('button', { name: 'Tab schließen' }).filter({ visible: true }).first().click();
  await expect(admin.getByRole('status').filter({ hasText: 'Maria Muster' })).toHaveCount(0, { timeout: 10_000 });
});

test('Beobachten: Maria follows a source – a dot and „Neu für dich“ when the admin changes a note, gone once she opens it', async ({ browser }) => {
  const maria = await browser.newPage();
  await login(maria, 'maria@example.test', 'Maria-Passwort-0001');
  const tree = maria.locator('aside nav[aria-label="Quellen"]');
  const source = tree.locator('[data-mount]', { hasText: 'Notizen' }).first();
  await source.click({ button: 'right' });
  await maria.getByRole('menuitem', { name: 'Quelle beobachten …' }).click();
  const dialog = maria.getByRole('dialog', { name: '„Notizen“ beobachten' });
  await expect(dialog.getByLabel('Punkt in der Seitenleiste')).toBeChecked();
  // No mail server and no Pushover in this suite: both offered, but not available.
  await expect(dialog.getByRole('checkbox', { name: /E-Mail/ })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: /Pushover/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Beobachten', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(source.getByRole('img', { name: 'Beobachtet' })).toBeVisible();
  // The admin changes a note (as from another place) – Maria's dot comes live.
  const admin = await browser.newPage();
  await login(admin, 'e2e@example.test', 'E2E-Passwort-12345');
  // A note Maria does not have open (an open note counts as read at once).
  const id = await mountIdOf(admin, 'Notizen');
  const n = (await (await admin.request.get(`/api/notes/${id}/bausteine.md`)).json()) as { hash: string; raw: string };
  expect((await admin.request.put(`/api/notes/${id}/bausteine.md`, { data: { raw: n.raw + '\nNeu vom Admin.\n', baseHash: n.hash } })).status()).toBe(200);
  await expect(source.getByRole('img', { name: 'Neu: geändert von E2E Admin' })).toBeVisible({ timeout: 10_000 });
  const fresh = maria.getByLabel('Neu für dich');
  await expect(fresh.getByRole('button', { name: /^bausteine/ })).toBeVisible();
  if ((await source.getAttribute('aria-expanded')) !== 'true') await source.click();
  await expect(tree.locator('[data-node$=":bausteine.md"]').getByRole('img', { name: 'Neu: geändert von E2E Admin' })).toBeVisible();
  await shot(maria, '120-beobachten');
  await fresh.getByRole('button', { name: /^bausteine/ }).click();
  await expect(maria.locator('.prose-note').filter({ visible: true })).toContainText('Neu vom Admin');
  await expect(fresh).toHaveCount(0);
  await expect(source.getByRole('img', { name: 'Beobachtet' })).toBeVisible();
  // Her own change makes no dot; she stops following.
  await maria.getByRole('button', { name: 'Tab schließen' }).filter({ visible: true }).first().click();
  await source.click({ button: 'right' });
  await maria.getByRole('menuitem', { name: 'Beobachten ändern …' }).click();
  await maria.getByRole('dialog', { name: '„Notizen“ beobachten' }).getByRole('button', { name: 'Nicht mehr beobachten' }).click();
  await expect(source.getByRole('img', { name: 'Beobachtet' })).toHaveCount(0);
  // How often messages come (AD-068): her own choice, kept; the admin's daily limit is named.
  await openSettingsPage(maria, 'Beobachten');
  const settings = maria.getByRole('dialog', { name: 'Einstellungen' });
  const often = settings.getByRole('radiogroup', { name: 'Wie oft?' });
  await expect(often.getByRole('radio', { name: /^Gebündelt/ })).toBeChecked();
  await often.getByRole('radio', { name: /^Einmal am Tag/ }).check();
  await expect(settings.getByText('Höchstens 100 Nachrichten am Tag (vom Admin festgelegt).', { exact: false })).toBeVisible();
  // Her own time for the summary.
  const time = settings.getByLabel('Uhrzeit der Zusammenfassung');
  await time.fill('18:30');
  await time.press('Enter');
  await expect(often.getByText('Um 18:30 Uhr eine Zusammenfassung', { exact: false })).toBeVisible();
  // Stored on the server (a reload here would also store the open tree, which the next test does not expect).
  await expect
    .poll(async () => (await (await maria.request.get('/api/watches')).json()) as { rhythm: string; dailyAt: string })
    .toMatchObject({ rhythm: 'daily', dailyAt: '18:30' });
  await often.getByRole('radio', { name: /^Gebündelt/ }).check();
  await expect(often.getByRole('radio', { name: /^Gebündelt/ })).toBeChecked();
  await admin.close();
  await maria.close();
});

test('permissions: group, rules in the dialog; Maria reads one source, writes one folder', async ({ browser }) => {
  const admin = await browser.newPage();
  await login(admin, 'e2e@example.test', 'E2E-Passwort-12345');
  await admin.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(admin, 'Gruppen');
  await admin.getByLabel('Name der neuen Gruppe').fill('Redaktion');
  await admin.getByRole('button', { name: 'Anlegen' }).click();
  await admin.getByRole('button', { name: /^Redaktion/ }).click();
  await admin.getByRole('checkbox', { name: 'Maria Muster' }).check();
  await expect(admin.getByRole('button', { name: /Redaktion · 1 Mitglied$/ })).toBeVisible();
  await admin.keyboard.press('Escape');

  const tree = admin.locator('aside nav[aria-label="Quellen"]');
  await tree.locator('[data-mount]', { hasText: 'Notizen' }).click({ button: 'right' });
  await admin.getByRole('menuitem', { name: 'Berechtigungen …' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Für', { exact: true }).selectOption({ label: 'Alle' });
  await dialog.getByLabel('Recht', { exact: true }).selectOption({ label: 'kein Zugriff' });
  await dialog.getByRole('button', { name: 'Hinzufügen' }).click();
  await dialog.getByLabel('Für', { exact: true }).selectOption({ label: 'Gruppe Redaktion (1)' });
  await dialog.getByLabel('Recht', { exact: true }).selectOption({ label: 'lesen' });
  await dialog.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Gruppe Redaktion' })).toBeVisible();
  await shot(admin, '46-berechtigungen');
  await admin.keyboard.press('Escape');
  await tree.locator('[data-node$=":plan"]').click({ button: 'right' });
  await admin.getByRole('menuitem', { name: 'Berechtigungen …' }).click();
  await expect(dialog.getByText('von Quelle').first()).toBeVisible();
  await dialog.getByLabel('Für', { exact: true }).selectOption({ label: 'Gruppe Redaktion (1)' });
  await dialog.getByLabel('Recht', { exact: true }).selectOption({ label: 'lesen & schreiben' });
  await dialog.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'lesen & schreiben' })).toBeVisible();
  await admin.keyboard.press('Escape');

  // Maria: everything in "Notizen" read-only, except the folder "plan".
  const maria = await browser.newPage();
  await login(maria, 'maria@example.test', 'Maria-Passwort-0001');
  const mtree = maria.locator('aside nav[aria-label="Quellen"]');
  const notizen = mtree.locator('[data-mount]', { hasText: 'Notizen' });
  if ((await notizen.getAttribute('aria-expanded')) !== 'true') await notizen.click();
  await mtree.getByText('trilium', { exact: true }).first().click();
  const editor = maria.locator('.prose-note').filter({ visible: true });
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await maria.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await expect(maria.getByRole('menuitem', { name: 'Löschen' })).toHaveCount(0);
  await maria.keyboard.press('Escape');
  await mtree.getByText('trilium', { exact: true }).first().click({ button: 'right' });
  await expect(maria.getByRole('menuitem', { name: 'Umbenennen / verschieben' })).toHaveCount(0);
  await maria.keyboard.press('Escape');
  if (!(await mtree.getByText('roadmap', { exact: true }).isVisible())) await mtree.locator('[data-node$=":plan"]').click();
  await mtree.getByText('roadmap', { exact: true }).first().click();
  await expect(maria.locator('.prose-note').filter({ visible: true })).toHaveAttribute('contenteditable', 'true');

  // Clean up for the following specs: the group goes with its rules, then the rule for everyone.
  await admin.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(admin, 'Gruppen');
  await admin.getByRole('button', { name: 'Gruppe Redaktion löschen' }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(admin.getByRole('button', { name: 'Gruppe Redaktion löschen' })).toHaveCount(0);
  await admin.keyboard.press('Escape');
  await tree.locator('[data-mount]', { hasText: 'Notizen' }).click({ button: 'right' });
  await admin.getByRole('menuitem', { name: 'Berechtigungen …' }).click();
  await dialog.getByRole('button', { name: 'Regel für Alle entfernen' }).click();
  await expect(dialog.getByText('Keine – es gilt, was von oben kommt.')).toBeVisible();
  await admin.keyboard.press('Escape');
});

test('encryption: a note and a folder are encrypted in the browser; files hold only age blocks', async ({ browser }) => {
  const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
  const read = (p: string) => (existsSync(join(NOTES, p)) ? readFileSync(join(NOTES, p), 'utf8') : '');
  const ageOpen = async (pass: string, raw: string) => {
    const age = await import('age-encryption');
    const d = new age.Decrypter();
    d.addPassphrase(pass);
    return d.decrypt(age.armor.decode(raw.slice(raw.indexOf('-----BEGIN'))), 'text');
  };
  writeFileSync(join(NOTES, 'geheimnis.md'), '# Geheimnis\n\nTresorwort Alpha.\n');
  mkdirSync(join(NOTES, 'tresor', 'assets'), { recursive: true });
  writeFileSync(join(NOTES, 'tresor', 'assets', 'punkt.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(join(NOTES, 'tresor', 'eins.md'), '# Eins\n\nTresorwort Beta.\n\n![punkt](assets/punkt.png)\n');

  const page = await browser.newPage();
  await login(page, 'e2e@example.test', 'E2E-Passwort-12345');
  const tree = page.locator('aside nav[aria-label="Quellen"]');
  // Files written directly reach the index through the watcher, which can lag under load: wait for the
  // server to list them, then reload, instead of hoping the live update arrives within a fixed time.
  await waitIndexed(page, 'Notizen', ['geheimnis.md', 'tresor/eins.md']);
  await page.reload();
  await expect(tree.getByText('geheimnis', { exact: true })).toBeVisible({ timeout: 15_000 });
  await tree.getByText('geheimnis', { exact: true }).click();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Verschlüsseln …' }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('kurz');
  await expect(page.getByText('Mindestens 8 Zeichen.')).toBeVisible();
  await page.getByLabel('Passphrase', { exact: true }).fill('tresor-pass-1');
  await page.getByLabel('Passphrase wiederholen').fill('tresor-pass-1');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => read('geheimnis.md'), { timeout: 15_000 }).toContain('encrypted: age');
  expect(read('geheimnis.md')).not.toContain('Tresorwort');
  expect(await ageOpen('tresor-pass-1', read('geheimnis.md'))).toContain('Tresorwort Alpha.');

  // Still unlocked in this session: edit, saved as a new age block.
  const editor = page.locator('.prose-note').filter({ visible: true });
  await expect(editor.getByText('Tresorwort Alpha.')).toBeVisible();
  await expect(page.getByText('verschlüsselt', { exact: true }).filter({ visible: true })).toBeVisible();
  await editor.getByText('Tresorwort Alpha.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Ergänzt.');
  await expect.poll(async () => ageOpen('tresor-pass-1', read('geheimnis.md')), { timeout: 15_000 }).toContain('Tresorwort Alpha. Ergänzt.');
  expect(read('geheimnis.md')).not.toContain('Ergänzt');

  // Lock: wrong passphrase is refused, the right one opens.
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Jetzt sperren' }).click();
  // The passphrase typed to unlock is not left in the field.
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveValue('');
  // The picture: the locked note, before a wrong try (no error message in the manual).
  await shot(page, '47-verschluesselt');
  await page.getByLabel('Passphrase', { exact: true }).fill('falsch-falsch');
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await expect(page.getByText('Passphrase falsch.')).toBeVisible();
  await page.getByLabel('Passphrase', { exact: true }).fill('tresor-pass-1');
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await expect(editor.getByText('Ergänzt.', { exact: false })).toBeVisible();

  // Search finds the title, never the encrypted content.
  const hits = await page.request.get('/api/search/full?q=Erg%C3%A4nzt');
  expect(((await hits.json()) as { hits: { path: string }[] }).hits.map((h) => h.path)).not.toContain('geheimnis.md');

  // Folder: all notes with one passphrase, the image becomes punkt.png.age; new notes start encrypted.
  await tree.locator('[data-node$=":tresor"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ordner verschlüsseln …' }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('ordner-pass-1');
  await page.getByLabel('Passphrase wiederholen').fill('ordner-pass-1');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => read('tresor/eins.md'), { timeout: 20_000 }).toContain('encrypted: age');
  expect(read('tresor/.kaveyl-wiki.yml')).toBe('encrypted: age\n');
  // The plain original goes once the note is saved with the encrypted copy.
  await expect.poll(() => existsSync(join(NOTES, 'tresor/assets/punkt.png')), { timeout: 10_000 }).toBe(false);
  expect(existsSync(join(NOTES, 'tresor/assets/punkt.png.age'))).toBe(true);
  expect(await ageOpen('ordner-pass-1', read('tresor/eins.md'))).toContain('![punkt](assets/punkt.png.age)');
  await expect(tree.locator('[data-node$=":tresor"] [aria-label="verschlüsselt"]')).toBeVisible();
  if (!(await tree.getByText('eins', { exact: true }).isVisible())) await tree.locator('[data-node$=":tresor"]').click();
  await tree.getByText('eins', { exact: true }).click();
  // The decrypted image is shown (unlocked via the folder).
  await expect(page.locator('.prose-note img[alt="punkt"]').filter({ visible: true })).toHaveJSProperty('naturalWidth', 1, { timeout: 10_000 });
  await tree.locator('[data-node$=":tresor"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Neue Notiz hier' }).click();
  await page.getByLabel('Titel').fill('Zwei');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.locator('.prose-note').filter({ visible: true })).toBeVisible();
  await page.locator('.prose-note').filter({ visible: true }).click();
  await page.keyboard.type('Tresorwort Gamma');
  await expect.poll(async () => (read('tresor/Zwei.md').includes('-----BEGIN') ? ageOpen('ordner-pass-1', read('tresor/Zwei.md')) : ''), { timeout: 15_000 }).toContain('Tresorwort Gamma');
  expect(read('tresor/Zwei.md')).not.toContain('Gamma');
});

test('Cloudflare Access settings: off by default, incomplete data is refused', async ({ browser }) => {
  const page = await browser.newPage();
  await login(page, 'e2e@example.test', 'E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(page, 'Cloudflare Access');
  const box = page.getByRole('checkbox', { name: 'Anmeldung über Cloudflare Access erlauben' });
  await expect(box).not.toBeChecked();
  await box.check();
  // The picture: the tab ready to fill in – before the refusal below (no error message in the manual).
  await shot(page, '48-cloudflare');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Team-Domain (z. B. team.cloudflareaccess.com) und AUD-Tag angeben')).toBeVisible();
});

test('SSO & Proxy: Authentik signs in a connected account only through the proxy address; sign-out address required; no Pangolin tab (AD-058)', async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const page = await browser.newPage();
  await login(page, 'e2e@example.test', 'E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(page, 'Authentik');
  const form = page.getByRole('form', { name: 'Authentik' });
  const box = form.getByRole('checkbox', { name: 'Anmeldung über Authentik erlauben' });
  await expect(box).not.toBeChecked();
  await expect(form.getByLabel('Header mit der Kennung')).toHaveValue('x-authentik-uid');
  await box.check();
  // Switched on, the sign-out address is required – suggested for this very domain.
  await expect(form.getByLabel('Abmelde-Adresse (Pflicht)')).toHaveValue(`${base}/outpost.goauthentik.io/sign_out`);
  await form.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(form.getByText(/Mindestens eine Proxy-Adresse angeben/)).toBeVisible();
  await expect(form.getByText(/Kam von 127\.0\.0\.1 – keine eingetragene Proxy-Adresse/)).toBeVisible();
  // In the suite the browser itself plays the proxy: the server sees 127.0.0.1, the header comes from the context.
  await form.getByLabel('Adresse des Proxys (Pflicht)').fill('127.0.0.1');
  await form.getByLabel('Abmelde-Adresse (Pflicht)').fill('');
  await form.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(form.getByText(/Abmelde-Adresse angeben/)).toBeVisible();
  await form.getByLabel('Abmelde-Adresse (Pflicht)').fill(`${base}/?abgemeldet-beim-proxy`);
  await form.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(form.getByText('Gespeichert.')).toBeVisible();
  await expect(form.getByText(/Kam von 127\.0\.0\.1 – einer eingetragenen Proxy-Adresse/)).toBeVisible();
  await shot(page, '48b-authentik');
  // 127.0.0.1 is allowed but flagged; the Docker gateway (here: the machine's default gateway) is refused with a help button.
  await expect(form.getByText(/Als Proxy-Adresse ist 127\.0\.0\.1 eingetragen – der Rechner selbst/)).toBeVisible();
  const gateway = ((await (await page.request.get('/api/admin/proxy-auth/authentik')).json()) as { request: { gateway: string | null } }).request.gateway;
  if (gateway) {
    await form.getByLabel('Adresse des Proxys (Pflicht)').fill(`127.0.0.1, ${gateway}`);
    await form.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(form.getByText(/ist das Docker-Gateway und als Proxy-Adresse nicht erlaubt/)).toBeVisible();
    await form.getByRole('button', { name: 'Warum? (Hilfe)' }).click();
    await expect(page.getByRole('dialog', { name: 'Hilfe' }).getByRole('heading', { name: 'Authentik', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Hilfe' })).toHaveCount(0);
    await form.getByLabel('Adresse des Proxys (Pflicht)').fill('127.0.0.1');
    await form.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(form.getByText('Gespeichert.')).toBeVisible();
  }
  await openSettingsPage(page, 'Reverse-Proxy');
  await expect(page.getByRole('dialog', { name: 'Einstellungen' }).getByRole('tab', { name: 'Pangolin' })).toHaveCount(0);
  await expect(page.getByText('Live-Verbindung steht.')).toBeVisible();
  await expect(page.getByText(/Diese Anfrage kam direkt von 127\.0\.0\.1/)).toBeVisible();
  await shot(page, '48c-reverse-proxy');
  // Without the header (not through the proxy) the account cannot be connected.
  await openSettingsPage(page, 'Konto');
  await expect(page.getByRole('button', { name: 'Mit Authentik verbinden' })).toBeDisabled();

  const header = { 'x-authentik-uid': 'e2e-authentik-uid', 'x-authentik-email': 'e2e@example.test' };
  const proxied = await (await browser.newContext({ extraHTTPHeaders: header })).newPage();
  // Not connected yet: the normal login appears.
  await login(proxied, 'e2e@example.test', 'E2E-Passwort-12345');
  await proxied.getByRole('button', { name: 'Einstellungen' }).click();
  await openSettingsPage(proxied, 'Konto');
  await proxied.getByRole('button', { name: 'Mit Authentik verbinden' }).click();
  await expect(proxied.getByText(/verbunden seit/)).toBeVisible();
  await shot(proxied, '98b-konto-proxy');

  // A new browser through the proxy is signed in without a password …
  const fresh = await (await browser.newContext({ extraHTTPHeaders: header })).newPage();
  await fresh.goto('/');
  await expect(fresh.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
  // … and „Abmelden“ goes on to the proxy's sign-out address.
  await fresh.getByRole('button', { name: /^Konto/ }).click();
  await fresh.getByRole('menuitem', { name: 'Abmelden' }).click();
  await expect(fresh).toHaveURL(/abgemeldet-beim-proxy/);
  // The same header from a browser that is not the proxy would be ignored – covered in proxySignIn.test.ts
  // (the suite has only one address); without the header it is the normal login.
  const direct = await browser.newPage();
  await direct.goto('/');
  await expect(direct.getByLabel('E-Mail')).toBeVisible();

  // Optional secret (sec-003): shown once; from then on only requests carrying it are signed in.
  await openSettingsPage(page, 'Authentik');
  await form.getByRole('button', { name: 'Geheimwert erzeugen …' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erzeugen', exact: true }).click();
  const secret = (await form.getByLabel('Geheimwert', { exact: true }).textContent())!.trim();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(form.getByText(`proxy_set_header X-Kaveyl-Wiki-Proxy-Secret "${secret}";`)).toBeVisible();
  await expect(form.getByText(/Gesetzt – ohne ihn meldet Authentik niemanden an/)).toBeVisible();
  const noSecret = await (await browser.newContext({ extraHTTPHeaders: header })).newPage();
  await noSecret.goto('/');
  await expect(noSecret.getByLabel('E-Mail')).toBeVisible();
  const withSecret = await (await browser.newContext({ extraHTTPHeaders: { ...header, 'x-kaveyl-wiki-proxy-secret': secret } })).newPage();
  await withSecret.goto('/');
  await expect(withSecret.locator('aside nav[aria-label="Quellen"]')).toBeVisible();
  await form.getByRole('button', { name: 'Entfernen …' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect(form.getByText(/Nicht gesetzt – es zählt allein die Adresse des Proxys/)).toBeVisible();
  for (const p of [noSecret, withSecret]) await p.context().close();

  // Clean up: disconnect, switch off.
  await proxied.getByRole('button', { name: 'Verbindung lösen' }).click();
  await proxied.getByRole('alertdialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(proxied.getByRole('button', { name: 'Mit Authentik verbinden' })).toBeVisible();
  await openSettingsPage(page, 'Authentik');
  await form.getByRole('checkbox', { name: 'Anmeldung über Authentik erlauben' }).uncheck();
  await form.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(form.getByText('Gespeichert.')).toBeVisible();
  for (const p of [proxied, fresh, direct]) await p.context().close();
});

test('auto-lock of encrypted notes is a per-user setting (Konto)', async ({ browser }) => {
  const page = await browser.newPage();
  await login(page, 'e2e@example.test', 'E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('button', { name: 'Konto' }).click();
  const select = page.getByLabel('Automatisch sperren nach');
  await expect(select).toHaveValue('15');
  await select.selectOption({ label: '30 Minuten' });
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('button', { name: 'Konto' }).click();
  await expect(page.getByLabel('Automatisch sperren nach')).toHaveValue('30');
});
