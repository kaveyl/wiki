// Phase 6: Excalidraw drawings, HTML export, print view.
// Runs after phase1–5 in the same seeded workspace (admin + local mount "Notizen").
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SHOTS, shot } from './shots';

const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
const read = (name: string) => (existsSync(join(NOTES, name)) ? readFileSync(join(NOTES, name), 'utf8') : '');

test.describe.configure({ mode: 'serial' });

let page: Page;
let mountId: string;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(tree().getByText('Notizen', { exact: true }).first()).toBeVisible();
  mountId = ((await (await page.request.get('/api/mounts')).json()) as { id: string; name: string }[]).find((m) => m.name === 'Notizen')!.id;
});

const tree = () => page.locator('aside nav[aria-label="Quellen"]');
const editor = () => page.locator('.prose-note').filter({ visible: true }).first();

/** Draws a shape with Excalidraw's keyboard tool (r = rectangle, o = ellipse) by dragging. */
async function draw(tool: string, from: [number, number], to: [number, number]) {
  const canvas = page.getByTestId('excalidraw');
  await expect(canvas.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  const box = (await canvas.boundingBox())!;
  // Focus the canvas on an empty spot (not on Excalidraw's own buttons at the edges).
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await page.keyboard.press(tool);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

test('Excalidraw: draw via /zeichnung, saved as SVG with scene in assets/, edited again by double click', async () => {
  const res = await page.request.post(`/api/notes/${mountId}`, { data: { parent: '', title: 'Skizzen' } });
  expect(res.ok()).toBe(true);
  await expect(tree().getByText('Skizzen', { exact: true })).toBeVisible();
  await tree().getByText('Skizzen', { exact: true }).click();
  await editor().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/zeichnung');
  await page.getByRole('button', { name: /Zeichnung \(Excalidraw\)/ }).click();
  await expect(page.getByRole('dialog', { name: 'Neue Zeichnung' })).toBeVisible();
  await draw('r', [220, 160], [460, 320]);
  await shot(page, '65-zeichnung');
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => read('assets/zeichnung.excalidraw.svg')).toContain('<svg');
  // The scene is embedded: Excalidraw (and Kaveyl Wiki) can open the image again.
  expect(read('assets/zeichnung.excalidraw.svg')).toMatch(/payload-type:application\/vnd\.excalidraw\+json/);
  await expect(editor().locator('.note-image img')).toBeVisible();
  await expect.poll(() => read('Skizzen.md'), { timeout: 10_000 }).toContain('](assets/zeichnung.excalidraw.svg)');
  const first = read('assets/zeichnung.excalidraw.svg');

  // Edit: double click opens the drawing with its content; saving replaces the same file.
  await editor().locator('.note-image').first().dblclick();
  await expect(page.getByRole('dialog', { name: 'Zeichnung bearbeiten' })).toBeVisible();
  await draw('o', [520, 180], [640, 300]);
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => read('assets/zeichnung.excalidraw.svg') !== first).toBe(true);
  expect(read('assets/zeichnung.excalidraw.svg').match(/<path|<rect|<ellipse/g)!.length).toBeGreaterThan(first.match(/<path|<rect|<ellipse/g)!.length);
  expect(existsSync(join(NOTES, 'assets/zeichnung-2.excalidraw.svg'))).toBe(false);
  // The image menu offers it, too.
  await editor().locator('.note-image').first().click();
  await expect(page.getByRole('button', { name: 'Zeichnung bearbeiten' })).toBeVisible();
});

test('export: HTML or Markdown from one „Exportieren“ submenu (note, folder); print view without the app around the note', async () => {
  await tree().getByText('roadmap', { exact: true }).first().click();
  const exportFromNoteMenu = async (item: string) => {
    await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name: 'Exportieren' }).click();
    const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item, exact: true }).click()]);
    return d;
  };
  const file = await exportFromNoteMenu('HTML-Datei');
  expect(file.suggestedFilename()).toBe('roadmap.html');
  const html = readFileSync((await file.path())!, 'utf8');
  expect(html).toContain('<title>Roadmap</title>');
  expect(html).toContain('Trilium');
  // A note without pictures or files comes as its .md (owner 28.10.) – from the menu and from the button in the note's head.
  const mdNote = await exportFromNoteMenu('Markdown');
  expect(mdNote.suggestedFilename()).toBe('roadmap.md');
  expect(readFileSync((await mdNote.path())!, 'utf8')).toContain('# Roadmap');
  const [direct] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Herunterladen', exact: true }).filter({ visible: true }).click()]);
  expect(direct.suggestedFilename()).toBe('roadmap.md');

  const exportFromTree = async (name: string, item: string) => {
    await tree().getByText(name, { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Exportieren' }).click();
    const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item, exact: true }).click()]);
    return d;
  };
  const zip = await exportFromTree('plan', 'HTML (ZIP)');
  expect(zip.suggestedFilename()).toBe('plan.zip');
  expect(readFileSync((await zip.path())!).subarray(0, 2).toString()).toBe('PK');
  // Moving from one submenu to the next closes the first: never two open at once.
  await tree().getByText('plan', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Exportieren' }).hover();
  await expect(page.getByRole('menuitem', { name: 'Markdown (ZIP)' })).toBeVisible();
  // One jump of the pointer still counts as „on the way into the open submenu“ (Radix' grace area);
  // a person keeps moving – so does the test, a moment later, inside „Anordnen“.
  await page.getByRole('menuitem', { name: 'Anordnen' }).hover();
  await page.waitForTimeout(400);
  await page.getByRole('menuitem', { name: 'Anordnen' }).hover({ position: { x: 20, y: 8 } });
  await expect(page.getByRole('menuitem', { name: 'Markdown (ZIP)' })).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  const mdZip = await exportFromTree('plan', 'Markdown (ZIP)');
  expect(mdZip.suggestedFilename()).toBe('plan.zip');
  // The notes themselves, byte for byte (stored uncompressed or deflated: the name is in the ZIP directory).
  const bytes = readFileSync((await mdZip.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  expect(bytes.includes(Buffer.from('roadmap.md'))).toBe(true);

  // Ctrl+P in the app itself: only the note, without sidebar, tabs and toolbar.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('aside').first()).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true })).toHaveCount(0);
  await expect(page.locator('.prose-note').filter({ visible: true })).toContainText('Roadmap');
  // Not clipped by the app frame: the printed page has content (an empty page is < 1 kB).
  expect((await page.pdf()).length).toBeGreaterThan(3000);
  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('aside').first()).toBeVisible();

  // The clean page the print dialog gets (and „Als PDF speichern“ turns into a PDF).
  await page.goto(`/api/export/${mountId}/plan/roadmap.md?inline=1`);
  await expect(page.locator('h1')).toHaveText('Roadmap');
  await page.screenshot({ path: join(SHOTS, '66-html-export.png') });
  await page.goto('/');
  await expect(tree().getByText('Notizen', { exact: true }).first()).toBeVisible();
});
