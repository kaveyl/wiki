// Backup (AD-038): targets with „Testen“ (folder, SMB with wrong and right password), a plan with
// the keep table, „Jetzt sichern“, browsing an archive, restoring by comparison (one section
// taken over) and as a copy from the note's menu. Runs last on purpose (it adds notes).
// SMB needs the Samba test container (scripts/smb-test.sh up); without it that part is skipped.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitIndexed } from './indexed';
import { openSettingsPage } from './settings-nav';
import { neutralize } from './shots';

const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
const BACKUP = resolve(import.meta.dirname, '../.local/e2e/backup');
const SHOTS = resolve(import.meta.dirname, '../.local/e2e-shots');
const shot = async (page: Page, name: string) => {
  await expect(page.locator('[role="status"][data-print="hide"] > *')).toHaveCount(0, { timeout: 8000 }).catch(() => undefined);
  const restore = await neutralize(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await restore();
};
const smbUp = (() => {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'kaveyl-wiki-smbtest'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
})();

test.describe.configure({ mode: 'serial' });

let page: Page;
const tree = () => page.locator('aside nav[aria-label="Quellen"]');
const settings = () => page.getByRole('dialog', { name: 'Einstellungen' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail', { exact: true }).fill('e2e@example.test');
  await page.getByLabel('Passwort', { exact: true }).fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(tree().getByText('Notizen', { exact: true }).first()).toBeVisible();
});

async function closeAll() {
  for (let i = 0; i < 5 && (await page.getByRole('dialog').count()); i++) await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('Backup → Ziele: SMB with a wrong and a right password, a local folder; tested before saving', async () => {
  await openSettingsPage(page, 'Ziele');
  const panel = settings().getByRole('region', { name: 'Backup-Ziele' });
  await expect(panel).toContainText('Noch kein Ziel.');
  if (smbUp) {
    await panel.getByRole('button', { name: 'Ziel hinzufügen' }).click();
    const form = panel.getByRole('form', { name: 'Neues Ziel' });
    await form.getByLabel('Adresse der Freigabe').fill('\\\\localhost\\backup\\e2e');
    await form.getByLabel('Benutzername').fill('kwtest');
    await form.getByLabel('Passwort', { exact: true }).fill('falsch');
    await form.getByRole('button', { name: 'Testen', exact: true }).click();
    await expect(form).toContainText('Anmeldung abgelehnt – Benutzername oder Passwort stimmt nicht');
    await form.getByLabel('Passwort', { exact: true }).fill('kwtest-Pass1');
    await form.getByLabel('Name (optional)').fill('NAS');
    await form.getByLabel('Sicherungen mit einem Backup-Passwort verschlüsseln').check();
    await form.getByLabel('Backup-Passwort', { exact: true }).fill('Backup-Passwort-1');
    await form.getByLabel('Backup-Passwort wiederholen').fill('Backup-Passwort-1');
    await form.getByRole('button', { name: 'Testen und anlegen' }).click();
    await expect(panel.getByRole('list', { name: 'Ziele' })).toContainText('NAS');
    await expect(panel.getByRole('list', { name: 'Ziele' })).toContainText('verschlüsselt');
  }
  await panel.getByRole('button', { name: 'Ziel hinzufügen' }).click();
  const form = panel.getByRole('form', { name: 'Neues Ziel' });
  await form.getByRole('radio', { name: 'Lokaler Ordner' }).click();
  await form.getByLabel('Unterordner (optional)').fill('kaveyl-wiki');
  await form.getByLabel('Name (optional)').fill('Backup-Ordner');
  await form.getByRole('button', { name: 'Testen und anlegen' }).click();
  const list = panel.getByRole('list', { name: 'Ziele' });
  await expect(list).toContainText('Backup-Ordner');
  await list.getByRole('listitem').filter({ hasText: 'Backup-Ordner' }).getByRole('button', { name: 'Testen' }).click();
  await expect(list).toContainText('Test erfolgreich');
  // In the test the folder is not a mounted host folder – the test says so.
  await expect(list).toContainText('kein eingehängter Host-Ordner');
  await shot(page, '112-backup-ziele');
});

test('Backup → Zeitpläne: table of rhythms with how many to keep; „Jetzt sichern“ writes one ZIP per source', async () => {
  await openSettingsPage(page, 'Zeitpläne');
  const panel = settings().getByRole('region', { name: 'Zeitpläne' });
  await panel.getByRole('button', { name: 'Zeitplan hinzufügen' }).click();
  const form = panel.getByRole('form', { name: 'Neuer Zeitplan' });
  await form.getByLabel('Ziel').selectOption({ label: 'Backup-Ordner' });
  await expect(form.getByLabel('Täglich behalten')).toHaveValue('7');
  await expect(form.getByLabel('Wöchentlich behalten')).toHaveValue('4');
  await form.getByLabel('Monatlich behalten').fill('6');
  await expect(form).toContainText('reichen etwa 6 Monate zurück');
  // Unencrypted target + database: the key stays at home, the form says so.
  await expect(form).toContainText('Gespeicherte Zugangsdaten wie Tokens und Passwörter kommen deshalb nicht mit in die Sicherung.');
  await shot(page, '113-backup-zeitplan');
  await form.getByRole('button', { name: 'Zeitplan anlegen' }).click();
  const list = panel.getByRole('list', { name: 'Zeitpläne' });
  await expect(list).toContainText('Täglich (7 behalten) · Wöchentlich (4 behalten) · Monatlich (6 behalten)');
  await expect(list).toContainText('Nächste Sicherung');
  // A note of its own for the comparison below (earlier specs rename and move the seeded ones).
  writeFileSync(join(NOTES, 'vergleich.md'), '# Vergleich\n\nErster Absatz.\n\nZweiter Absatz.\n');
  await waitIndexed(page, 'Notizen', ['vergleich.md']);
  await expect(tree().getByText('vergleich', { exact: true })).toBeVisible({ timeout: 15_000 });
  await list.getByRole('button', { name: 'Jetzt sichern' }).first().click();
  await openSettingsPage(page, 'Sicherungen');
  const files = settings().getByRole('region', { name: 'Sicherungen', exact: true });
  await expect(files.getByRole('region', { name: 'Sicherungen Notizen' })).toBeVisible({ timeout: 20_000 });
  await expect(files.getByRole('region', { name: 'Sicherungen Kaveyl-Wiki-Datenbank' })).toBeVisible();
  expect(readdirSync(join(BACKUP, 'kaveyl-wiki', 'Notizen')).some((f) => /^Notizen_\d{4}-\d\d-\d\d_\d{6}\.zip$/.test(f))).toBe(true);
  await files.getByRole('button', { name: 'Verlauf' }).click();
  await expect(files.getByRole('list', { name: 'Läufe' })).toContainText('erfolgreich');
  await shot(page, '114-backup-sicherungen');
});

test('welcome page: „Leute einladen“ and „Backup festlegen“ are ticked off once there are more accounts and a plan', async ({ browser }) => {
  // Own context with an empty main area; the tabs and prefs of the shared E2E account are put back afterwards.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.request.post('/api/login', { data: { email: 'e2e@example.test', password: 'E2E-Passwort-12345' } });
  const KEYS = ['workspace', 'prefs'];
  const before = await Promise.all(KEYS.map(async (k) => (await p.request.get(`/api/state/${k}`)).json()));
  await p.request.put('/api/state/workspace', { data: { ...before[0], tabs: [], activeId: null, splitId: null } });
  await p.request.put('/api/state/prefs', { data: { ...before[1], hideWelcome: false } });
  try {
    await p.goto('/');
    const welcome = p.getByTestId('welcome');
    await expect(welcome.getByText('Backup festlegen (erledigt)')).toBeAttached();
    await expect(welcome.getByText('Leute einladen (erledigt)')).toBeAttached();
    await expect(welcome.getByRole('button', { name: 'Backup einrichten' })).toHaveCount(0);
  } finally {
    for (const [i, k] of KEYS.entries()) await p.request.put(`/api/state/${k}`, { data: before[i] });
    await ctx.close();
  }
});

test('restore by comparing: one changed section taken over from the backup, the rest stays', async () => {
  const file = join(NOTES, 'vergleich.md');
  const before = readFileSync(file, 'utf8');
  writeFileSync(file, before.replace('Erster Absatz.', 'Erster Absatz – aus Versehen überschrieben.') + '\nNeuer Absatz von heute.\n');
  const files = settings().getByRole('region', { name: 'Sicherungen', exact: true });
  await files.getByRole('region', { name: 'Sicherungen Notizen' }).getByRole('button', { name: 'Öffnen' }).first().click();
  const browser = page.getByRole('dialog', { name: /^Sicherung vom .* – Notizen$/ });
  await browser.getByRole('tree', { name: 'Inhalt der Sicherung' }).getByRole('button', { name: 'vergleich', exact: true }).click();
  await expect(browser.getByLabel('Wiederherstellen')).toContainText('jetzt: geändert');
  await browser.getByRole('button', { name: 'Vergleichen …' }).click();
  const compare = page.getByRole('dialog', { name: 'Vergleichen: vergleich' });
  const changes = compare.getByTestId('change');
  await expect(changes).toHaveCount(2);
  await expect(changes.first()).toContainText('Erster Absatz.');
  await expect(changes.first()).toContainText('aus Versehen überschrieben');
  await changes.first().getByRole('button', { name: 'Aus der Sicherung übernehmen' }).click();
  await expect(compare).toContainText('1 von 2 Abschnitten aus der Sicherung übernommen');
  await page.mouse.move(5, 5);
  await shot(page, '115-backup-vergleich');
  await compare.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(compare).toHaveCount(0);
  const now = readFileSync(file, 'utf8');
  expect(now).toContain('Erster Absatz.');
  expect(now).not.toContain('aus Versehen');
  expect(now).toContain('Neuer Absatz von heute.');
});

test('„Aus Backup wiederherstellen …“ on a note: the archive opens there, restored as a copy next to it', async () => {
  await closeAll();
  await tree().getByText('roadmap', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Aus Backup wiederherstellen …' }).click();
  const files = settings().getByRole('region', { name: 'Sicherungen', exact: true });
  await expect(files.getByLabel('Quelle')).toHaveValue(/.+/);
  await expect(files).toContainText('Gesucht: „roadmap“');
  await files.getByRole('region', { name: 'Sicherungen Notizen' }).getByRole('button', { name: 'Öffnen' }).first().click();
  const browser = page.getByRole('dialog', { name: /^Sicherung vom .* – Notizen$/ });
  await expect(browser.getByLabel('Wiederherstellen')).toContainText('plan/roadmap.md');
  await browser.getByRole('button', { name: 'Speichern als …', exact: true }).click();
  const saveAs = page.getByRole('dialog', { name: 'Speichern als' });
  await expect(saveAs.getByLabel('Dateiname')).toHaveValue(/^roadmap \(Sicherung \d\d\.\d\d\.\d{4}\)$/);
  await expect(saveAs.getByRole('button', { name: 'Ordner wählen' })).toContainText('Notizen › plan');
  await saveAs.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(browser.getByLabel('Wiederherstellen')).toContainText(/Als „plan\/roadmap \(Sicherung \d\d\.\d\d\.\d{4}\)\.md“ gespeichert/);
  expect(readdirSync(join(NOTES, 'plan')).some((f) => /^roadmap \(Sicherung \d\d\.\d\d\.\d{4}\)\.md$/.test(f))).toBe(true);
  await closeAll();
});

test('source menu → Backup: „Jetzt sichern“ and the way to the plans', async () => {
  await tree().getByText('Notizen', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Backup' }).hover();
  await page.waitForTimeout(150);
  await page.getByRole('menuitem', { name: 'Backup' }).hover();
  await page.getByRole('menuitem', { name: 'Jetzt sichern' }).click();
  await expect(page.getByText(/„Notizen“ wird gesichert/)).toBeVisible();
  await tree().getByText('Notizen', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Backup' }).hover();
  await page.waitForTimeout(150);
  await page.getByRole('menuitem', { name: 'Backup' }).hover();
  await page.getByRole('menuitem', { name: 'Zeitpläne …' }).click();
  await expect(settings().getByRole('tab', { name: 'Zeitpläne', selected: true })).toBeVisible();
  await closeAll();
});

test('SMB: an encrypted backup to the share, opened and browsed again', async () => {
  test.skip(!smbUp, 'Samba-Testcontainer läuft nicht (scripts/smb-test.sh up)');
  await openSettingsPage(page, 'Zeitpläne');
  const panel = settings().getByRole('region', { name: 'Zeitpläne' });
  await panel.getByRole('button', { name: 'Zeitplan hinzufügen' }).click();
  const form = panel.getByRole('form', { name: 'Neuer Zeitplan' });
  await form.getByLabel('Ziel').selectOption({ label: 'NAS (verschlüsselt)' });
  await form.getByLabel('Name (optional)').fill('Notizen aufs NAS');
  await form.getByLabel('Ausgewählte Quellen').check();
  await form.getByLabel('Notizen', { exact: true }).check();
  await form.getByLabel('Auch die Kaveyl-Wiki-Datenbank (Benutzer, Rechte, Einstellungen, Quellen)').uncheck();
  await form.getByRole('button', { name: 'Zeitplan anlegen' }).click();
  const row = panel.getByRole('list', { name: 'Zeitpläne' }).getByRole('listitem').filter({ hasText: 'Notizen aufs NAS' });
  await row.getByRole('button', { name: 'Jetzt sichern' }).click();
  await openSettingsPage(page, 'Sicherungen');
  const files = settings().getByRole('region', { name: 'Sicherungen', exact: true });
  const nas = files.getByRole('region', { name: 'Sicherungen Notizen' }).getByRole('listitem').filter({ hasText: 'NAS' });
  await expect(nas.first()).toBeVisible({ timeout: 20_000 });
  await expect(nas.first().getByLabel('verschlüsselt')).toBeVisible();
  await nas.first().getByRole('button', { name: 'Öffnen' }).click();
  const browser = page.getByRole('dialog', { name: /^Sicherung vom .* – Notizen$/ });
  await expect(browser.getByRole('tree', { name: 'Inhalt der Sicherung' })).toContainText('trilium');
  await closeAll();
  expect(existsSync(join(BACKUP, 'kaveyl-wiki'))).toBe(true);
});

test('target with its plan deleted in one step, found again when added again, the whole source restored (AD-075)', async () => {
  await openSettingsPage(page, 'Ziele');
  const panel = settings().getByRole('region', { name: 'Backup-Ziele' });
  const list = panel.getByRole('list', { name: 'Ziele' });
  await list.getByRole('button', { name: 'Backup-Ordner entfernen' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('den Zeitplan „Sicherung nach Backup-Ordner“, der es nutzt, mit löschen?');
  await ask.getByRole('button', { name: 'Ziel und Zeitplan löschen' }).click();
  await expect(list.getByText('Backup-Ordner', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ziel hinzufügen' }).click();
  const form = panel.getByRole('form', { name: 'Neues Ziel' });
  await form.getByRole('radio', { name: 'Lokaler Ordner' }).click();
  await form.getByLabel('Unterordner (optional)').fill('kaveyl-wiki');
  await form.getByLabel('Name (optional)').fill('Backup-Ordner');
  await form.getByRole('button', { name: 'Testen und anlegen' }).click();
  const again = list.getByRole('listitem').filter({ hasText: 'Backup-Ordner' });
  await expect(again).toContainText(/Sicherungen, die dort schon lagen, stehen jetzt in der Liste/);
  await again.getByRole('button', { name: 'Durchsuchen' }).click();
  await expect(again).toContainText(/Nichts Neues – die \d+ Sicherungen dort stehen schon in der Liste/);

  await openSettingsPage(page, 'Sicherungen');
  const files = settings().getByRole('region', { name: 'Sicherungen', exact: true });
  const row = files.getByRole('region', { name: 'Sicherungen Notizen' }).getByRole('listitem').filter({ hasText: 'Backup-Ordner' }).first();
  await row.getByRole('button', { name: 'Zurückspielen' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Die ganze Quelle „Notizen“');
  await confirm.getByRole('button', { name: 'Zurückspielen' }).click();
  await expect(page.getByText(/„Notizen“ zurückgespielt \(\d+ Dateien\)/)).toBeVisible({ timeout: 20_000 });
  await closeAll();
});
