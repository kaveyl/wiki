// Encrypted notes and folders (AD-021): the cases the review of 13.10. found broken – a typo never unlocks an
// empty note, edits and tags survive reloads and changes from outside, a folder is encrypted completely, files
// travel with a moved note and come back as plain files when the encryption is removed.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitIndexed } from './indexed';

test.describe.configure({ mode: 'serial' });

const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
const read = (p: string) => (existsSync(join(NOTES, p)) ? readFileSync(join(NOTES, p), 'utf8') : '');
const has = (p: string) => existsSync(join(NOTES, p));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function ageOpen(pass: string, raw: string) {
  if (!raw.includes('-----BEGIN')) return '';
  const age = await import('age-encryption');
  const d = new age.Decrypter();
  d.addPassphrase(pass);
  return d.decrypt(age.armor.decode(raw.slice(raw.indexOf('-----BEGIN'))), 'text');
}

async function ageSeal(pass: string, text: string) {
  const age = await import('age-encryption');
  const e = new age.Encrypter();
  e.setPassphrase(pass);
  e.setScryptWorkFactor(12);
  return age.armor.encode(await e.encrypt(text));
}

let page: Page;
const tree = () => page.locator('aside nav[aria-label="Quellen"]');
const editor = () => page.locator('.prose-note[contenteditable="true"]').filter({ visible: true });
const image = (alt: string) => page.locator(`.prose-note img[alt="${alt}"]`).filter({ visible: true });
const node = (path: string) => tree().locator(`[data-node$=":${path}"]`).first();

/** Opens a note in the tree, unfolding its folders as needed (after a reload the tree remembers open folders a moment later). */
async function open(path: string) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const folder = node(parts.slice(0, i).join('/'));
    const child = node(parts.slice(0, i + 1).join('/'));
    await expect(folder).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      if (!(await child.isVisible())) await folder.click();
      await expect(child).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
  }
  await node(path).click();
}

async function moreActions(item: string) {
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** The passphrase dialog (an open encrypted note has an unlock field with the same name behind it). */
async function newPassphrase(pass: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Passphrase', { exact: true }).fill(pass);
  await dialog.getByLabel('Passphrase wiederholen').fill(pass);
  await dialog.getByRole('button', { name: 'OK' }).click();
}

/** The unlock field of the note shown. */
const unlockField = () => page.getByLabel('Passphrase', { exact: true }).filter({ visible: true });

test.beforeAll(async ({ browser }) => {
  mkdirSync(join(NOTES, 'kiste', 'assets'), { recursive: true });
  writeFileSync(join(NOTES, 'kiste', 'assets', 'bild.png'), PNG);
  writeFileSync(join(NOTES, 'kiste', 'a.md'), '# A\n\nKistenwort Eins.\n\n![bild](assets/bild.png)\n');
  mkdirSync(join(NOTES, 'bilder', 'assets'), { recursive: true });
  writeFileSync(join(NOTES, 'bilder', 'assets', 'p.png'), PNG);
  writeFileSync(join(NOTES, 'bilder', 'foto.md'), '# Foto\n\nBildwort.\n\n![p](assets/p.png "Mit Titel")\n');
  writeFileSync(join(NOTES, 'bilder', 'andere.md'), '# Andere\n\n![p](assets/p.png)\n');
  page = await browser.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(tree()).toBeVisible();
  await waitIndexed(page, 'Notizen', ['kiste/a.md', 'bilder/foto.md', 'bilder/andere.md']);
  await page.reload();
  await expect(node('kiste')).toBeVisible({ timeout: 15_000 });
});

test('folder: encrypted completely (also notes arriving later); a typo never unlocks an empty note', async () => {
  await node('kiste').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ordner verschlüsseln …' }).click();
  await newPassphrase('kiste-pass-1');
  // Done (until then notes put into the folder are encrypted by the same run).
  await expect(page.getByText('Ordner „kiste“ verschlüsselt')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => read('kiste/a.md'), { timeout: 20_000 }).toContain('encrypted: age');
  expect(read('kiste/a.md')).not.toContain('Kistenwort');
  await expect.poll(() => has('kiste/assets/bild.png'), { timeout: 10_000 }).toBe(false);
  expect(has('kiste/assets/bild.png.age')).toBe(true);
  // The files it uses stay findable for moving, copying and the consistency check.
  expect(read('kiste/a.md')).toContain('assets/bild.png.age');

  // A plain note put into the folder from outside: the folder offers to finish, the note itself too.
  writeFileSync(join(NOTES, 'kiste', 'spaet.md'), '# Spät\n\nSpätwort.\n');
  writeFileSync(join(NOTES, 'kiste', 'offen.md'), '# Offen\n\nOffenwort.\n');
  await waitIndexed(page, 'Notizen', ['kiste/spaet.md', 'kiste/offen.md']);
  await open('kiste/offen.md');
  await expect(page.getByText('liegt unverschlüsselt im verschlüsselten Ordner')).toBeVisible();
  await page.getByRole('button', { name: 'Jetzt verschlüsseln' }).click();
  await expect.poll(async () => ageOpen('kiste-pass-1', read('kiste/offen.md')), { timeout: 15_000 }).toContain('Offenwort.');
  await node('kiste').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Ordner fertig verschlüsseln \(1 offen\)/ }).click();
  await expect.poll(async () => ageOpen('kiste-pass-1', read('kiste/spaet.md')), { timeout: 15_000 }).toContain('Spätwort.');

  // A new note starts empty; after a reload (locked) a mistyped passphrase is refused, not taken for the folder.
  await node('kiste').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Neue Notiz hier' }).click();
  await page.getByLabel('Titel').fill('Leer');
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(editor()).toBeVisible();
  await expect.poll(() => read('kiste/Leer.md'), { timeout: 10_000 }).toContain('encrypted: age');
  await page.reload();
  await open('kiste/Leer.md');
  await unlockField().fill('vertippt-123');
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await expect(page.getByText('Passphrase falsch.')).toBeVisible();
  await unlockField().fill('kiste-pass-1');
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await editor().click();
  await page.keyboard.type('Leerwort');
  await expect.poll(async () => ageOpen('kiste-pass-1', read('kiste/Leer.md')), { timeout: 15_000 }).toContain('Leerwort');
});

test('edits survive switching to Markdown and back; a tag is not undone by the next edit', async () => {
  await open('kiste/a.md');
  await editor().getByText('Kistenwort Eins.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Neu.');
  await expect.poll(async () => ageOpen('kiste-pass-1', read('kiste/a.md')), { timeout: 15_000 }).toContain('Kistenwort Eins. Neu.');
  await page.getByTitle('Markdown-Quelltext').filter({ visible: true }).click();
  await expect(page.getByText('Kistenwort Eins. Neu.').filter({ visible: true })).toBeVisible();
  await page.getByTitle('Visueller Editor').filter({ visible: true }).click();
  await expect(editor().getByText('Kistenwort Eins. Neu.')).toBeVisible();

  const bar = page.getByLabel('Tags').filter({ visible: true });
  await bar.getByRole('button', { name: 'Tag', exact: true }).click();
  await page.getByLabel('Neuer Tag').fill('kiste');
  await page.keyboard.press('Enter');
  await expect.poll(() => read('kiste/a.md'), { timeout: 10_000 }).toMatch(/tags:.*kiste/);
  await editor().getByText('Kistenwort Eins. Neu.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Mehr.');
  await expect.poll(async () => ageOpen('kiste-pass-1', read('kiste/a.md')), { timeout: 15_000 }).toContain('Neu. Mehr.');
  expect(read('kiste/a.md')).toMatch(/tags:.*kiste/);
  await expect(page.getByText('außerhalb geändert')).toHaveCount(0);
});

test('a change from outside shows up in the open note, and editing goes on from there', async () => {
  await open('kiste/a.md');
  const raw = read('kiste/a.md');
  writeFileSync(join(NOTES, 'kiste', 'a.md'), raw.slice(0, raw.indexOf('-----BEGIN')) + (await ageSeal('kiste-pass-1', '# A\n\nVon außen geändert.\n')));
  await expect(editor().getByText('Von außen geändert.')).toBeVisible({ timeout: 20_000 });
  await editor().getByText('Von außen geändert.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Danach.');
  await expect.poll(async () => ageOpen('kiste-pass-1', read('kiste/a.md')), { timeout: 15_000 }).toContain('Von außen geändert. Danach.');
  await expect(page.getByText('außerhalb geändert')).toHaveCount(0);
});

test('a note with a shared image: encrypted copy, moved along, plain again after removing the encryption', async () => {
  await open('bilder/foto.md');
  await moreActions('Verschlüsseln …');
  await newPassphrase('foto-pass-1');
  await expect.poll(() => read('bilder/foto.md'), { timeout: 15_000 }).toContain('encrypted: age');
  // The image with a title is encrypted too; the original stays because another note still shows it.
  expect(await ageOpen('foto-pass-1', read('bilder/foto.md'))).toContain('![p](assets/p.png.age "Mit Titel")');
  expect(has('bilder/assets/p.png.age')).toBe(true);
  expect(has('bilder/assets/p.png')).toBe(true);
  await expect(image('p')).toHaveJSProperty('naturalWidth', 1, { timeout: 10_000 });

  // Moved into another folder: the encrypted image goes along.
  const mounts = (await (await page.request.get('/api/mounts')).json()) as { id: string; name: string }[];
  const id = mounts.find((m) => m.name === 'Notizen')!.id;
  expect((await page.request.post(`/api/notes/${id}/move`, { data: { from: 'bilder/foto.md', to: 'ziel/foto.md' } })).ok()).toBe(true);
  expect(has('ziel/assets/p.png.age')).toBe(true);
  await waitIndexed(page, 'Notizen', ['ziel/foto.md']);
  await page.reload();
  await open('ziel/foto.md');
  await unlockField().fill('foto-pass-1');
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await expect(image('p')).toHaveJSProperty('naturalWidth', 1, { timeout: 10_000 });

  // Removing the encryption brings the image back as a plain file – it still shows after a reload.
  await moreActions('Verschlüsselung entfernen …');
  // Saved twice: first the text, then with the links to the plain files.
  await expect.poll(() => read('ziel/foto.md'), { timeout: 15_000 }).toContain('![p](assets/p.png "Mit Titel")');
  expect(read('ziel/foto.md')).not.toContain('encrypted: age');
  expect(has('ziel/assets/p.png')).toBe(true);
  await expect.poll(() => has('ziel/assets/p.png.age'), { timeout: 10_000 }).toBe(false);
  await page.reload();
  await open('ziel/foto.md');
  await expect(image('p')).toHaveJSProperty('naturalWidth', 1, { timeout: 10_000 });
});
