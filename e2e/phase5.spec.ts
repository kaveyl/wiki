// Phase 5: AI assistant in the UI against a fake OpenAI-compatible provider started here.
// Runs after phase1–4 in the same seeded workspace (admin + local mount "Notizen").
import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { shot } from './shots';
import { openSettingsPage } from './settings-nav';

const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
const read = (name: string) => (existsSync(join(NOTES, name)) ? readFileSync(join(NOTES, name), 'utf8') : '');

test.describe.configure({ mode: 'serial' });

let page: Page;
let fake: Server;
let fakeUrl: string;
const prompts: string[] = [];

/** The agent's model (AD-026): looks things up with tools like a real one would, then answers. */
function agentStep(messages: { role: string; content: string | null }[], res: import('node:http').ServerResponse) {
  prompts.push(JSON.stringify(messages));
  const user = messages.filter((m) => m.role === 'user').at(-1)!.content ?? '';
  const last = messages.at(-1)!;
  const lastTool = last.role === 'tool' ? (last.content ?? '') : null;
  const n = messages.filter((m) => m.role === 'tool').length;
  const call = (name: string, args: Record<string, unknown>) =>
    res.end(JSON.stringify({ model: 'test-modell', choices: [{ message: { content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
  const say = (text: string) => res.end(JSON.stringify({ model: 'test-modell', choices: [{ message: { content: text } }] }));
  if (user.includes('Übersicht')) {
    if (!lastTool) return call('list_sources', {});
    const src = /sourceId=(\S+) name="Notizen"/.exec(lastTool);
    if (src) return call('propose_create_note', { sourceId: src[1], parent: 'plan', title: 'Übersicht', markdown: '# Übersicht\n\n- [Roadmap](roadmap.md)\n', reason: 'Wie gewünscht' });
    return say('Ich habe eine Übersicht für „plan“ vorgeschlagen.');
  }
  if (!lastTool) return call('search', { query: 'Roadmap' });
  const hit = /sourceId=(\S+) \(.*?\) path=(\S+)/.exec(lastTool);
  if (hit && !lastTool.startsWith('Quelle')) return call('read_note', { sourceId: hit[1], path: hit[2] });
  return say('Die Roadmap verweist auf Trilium [1].');
}

test.beforeAll(async ({ browser }) => {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-modell' }] }));
      const j = JSON.parse(body || '{}') as { messages: { role: string; content: string | null }[]; tools?: unknown[] };
      if (j.tools) return agentStep(j.messages, res);
      const last = j.messages.at(-1)!.content!;
      prompts.push(last);
      const text = last.startsWith('Quellen:')
        ? 'Die Roadmap verweist auf Trilium [1].'
        : last.trimEnd().endsWith('und dann')
          ? 'und dann folgt [Termin].' // „Weiterschreiben“ after a broken-off sentence, repeating its last words
          : 'Siehe dazu die **Trilium**-Notiz.';
      res.end(JSON.stringify({ model: 'test-modell', choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  page = await browser.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(tree().getByText('Notizen', { exact: true }).first()).toBeVisible();
});

test.afterAll(async () => {
  await new Promise((r) => fake.close(r));
});

const tree = () => page.locator('aside nav[aria-label="Quellen"]');

test('admin sets up a provider; without a release the AI sees nothing', async () => {
  await openSettingsPage(page, 'KI');
  await page.getByRole('button', { name: '+ Ollama', exact: true }).click();
  const form = page.getByRole('form', { name: 'KI-Anbieter' });
  await form.getByLabel('Adresse').fill(fakeUrl);
  await form.getByLabel('Modell').fill('test-modell');
  await form.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect(form.getByText('Verbunden – 1 Modelle zur Auswahl.')).toBeVisible();
  await shot(page, '60-ki-anbieter');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('list', { name: 'KI-Anbieter' }).getByText('Ollama', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // Not released yet: the action fails with a clear reason, nothing went to the provider.
  await tree().getByText('roadmap', { exact: true }).first().click();
  await page.locator('.prose-note').filter({ visible: true }).getByText('Siehe').click();
  await page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true }).getByRole('button', { name: 'KI' }).click();
  await page.getByRole('menuitem', { name: 'Zusammenfassen' }).click();
  await expect(page.getByRole('alert')).toContainText('nicht für die KI freigegeben');
  expect(prompts).toHaveLength(0);
  await page.getByRole('button', { name: 'Verwerfen' }).click();
});

test('release a folder, rewrite a selection as a suggestion, replace it', async () => {
  await tree().getByText('plan', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'KI-Freigabe …' }).click();
  const dialog = page.getByRole('dialog', { name: 'KI-Freigabe: plan' });
  await expect(dialog.getByRole('radio', { name: 'Wie darüber' })).toBeChecked();
  await expect(dialog.getByText('derzeit: nicht freigegeben (Standard)')).toBeVisible();
  // Only a provider in the own network: no question about the cloud.
  await expect(dialog.getByRole('radio', { name: 'Freigegeben – nur für KI im eigenen Netz' })).toHaveCount(0);
  await dialog.getByRole('radio', { name: 'Freigegeben', exact: true }).check();
  await expect(dialog.getByText('Die Inhalte bleiben im eigenen Netz (Ollama).')).toBeVisible();
  await shot(page, '61-ki-freigabe');
  await page.getByRole('button', { name: 'Speichern' }).click();
  const editor = page.locator('.prose-note').filter({ visible: true });
  await editor.getByText('Siehe').click({ clickCount: 3 });
  await page.getByRole('button', { name: 'KI' }).filter({ visible: true }).last().click();
  await page.getByRole('menuitem', { name: 'Umformulieren' }).click();
  // Shown formatted like the note (bold is bold), not as raw Markdown.
  await expect(page.getByLabel('KI-Vorschlag')).toContainText('Siehe dazu die Trilium-Notiz.');
  await expect(page.getByLabel('KI-Vorschlag').locator('strong')).toHaveText('Trilium');
  expect(prompts.at(-1)).toContain('Siehe');
  await shot(page, '62-ki-vorschlag');
  await page.getByRole('button', { name: 'Ersetzen' }).click();
  await expect.poll(() => read('plan/roadmap.md'), { timeout: 10_000 }).toContain('Siehe dazu die **Trilium**-Notiz.');
});

test('overview „KI-Freigaben“ lists every rule, ✦ marks it in the tree', async () => {
  const rules = page.getByRole('list', { name: 'KI-Freigaben' });
  const mountRow = tree().locator('[data-mount]').filter({ hasText: 'Notizen' }).first();
  // The folder released above: ✦ in the tree, a row in the overview.
  const planMark = tree().locator('[data-node]').filter({ has: page.getByText('plan', { exact: true }) }).getByRole('button', { name: /KI-Freigabe: freigegeben/ });
  await expect(planMark).toBeVisible();
  // ✦ stays put: hovering the row shows the row actions left of it, clicking it hides them again.
  await page.mouse.move(0, 0);
  // A handle: while the menu is open, Radix hides the rest of the page from role locators.
  const mark = (await planMark.elementHandle())!;
  const x = async () => (await mark.boundingBox())!.x;
  const resting = await x();
  await planMark.hover();
  await expect(tree().locator('[data-node]').filter({ has: page.getByText('plan', { exact: true }) }).getByRole('button', { name: 'Neu …' })).toBeVisible();
  expect(await x()).toBe(resting);
  // A click on ✦: ask the AI about exactly this folder.
  await planMark.click();
  await expect(page.getByRole('menuitem', { name: 'KI fragen …' })).toBeVisible();
  expect(await x()).toBe(resting);
  await page.getByRole('menuitem', { name: 'KI fragen …' }).click();
  const ask = page.getByRole('dialog', { name: 'Frag die Wissensbasis' });
  await expect(ask.getByLabel('Bezug').locator('option:checked')).toHaveText('Dieser Ordner (plan)');
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(rules.getByRole('listitem')).toHaveCount(1);
  await expect(rules.getByRole('listitem').first()).toContainText('plan (Notizen)');
  // Block the whole source: second row, ✦ at the source.
  await mountRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'KI-Freigabe …' }).click();
  await page.getByRole('radio', { name: 'Nicht freigegeben' }).check();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(rules.getByRole('listitem')).toHaveCount(2);
  await expect(mountRow.getByRole('button', { name: 'KI-Freigabe: nicht freigegeben' })).toBeVisible();
  await shot(page, '69-ki-freigaben');
  // Filters.
  const section = page.locator('aside').getByText('KI-Freigaben', { exact: true }).locator('..');
  // A filter on the collapsed section unfolds it again.
  await section.getByText('KI-Freigaben', { exact: true }).click();
  await expect(rules).toHaveCount(0);
  await section.getByRole('button', { name: 'gesperrt' }).click();
  await expect(rules.getByRole('listitem')).toHaveCount(1);
  await expect(rules.getByRole('listitem').first()).toContainText('Notizen');
  await section.getByRole('button', { name: 'aktiv' }).click();
  await expect(rules.getByRole('listitem')).toHaveCount(1);
  await expect(rules.getByRole('listitem').first()).toContainText('plan (Notizen)');
  // „nur eigenes Netz“ only matters with cloud providers besides local ones.
  await expect(section.getByRole('button', { name: 'lokal' })).toHaveCount(0);
  await section.getByRole('button', { name: 'alle' }).click();
  // Remove from the overview: row and ✦ disappear, the folder rule stays.
  await rules.getByRole('listitem').filter({ hasText: 'nicht freigegeben' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Freigabe entfernen' }).click();
  await expect(rules.getByRole('listitem')).toHaveCount(1);
  await expect(mountRow.getByRole('button', { name: /KI-Freigabe/ })).toHaveCount(0);
  // A click shows the folder in the tree.
  await rules.getByRole('listitem').first().click();
  await expect(tree().locator('[data-node].bg-active')).toContainText('plan');
  // A cloud provider besides the local one: the folder released while there was none stays in the own network.
  const cloud = (await (await page.request.put('/api/ai/providers', { data: { kind: 'ollama-cloud', name: 'Wolke', apiKey: 'test-key' } })).json()) as { id: string };
  await page.reload();
  await expect(rules.getByRole('listitem').first()).toContainText('nur eigenes Netz');
  await rules.getByRole('listitem').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Freigabe bearbeiten …' }).click();
  const dialog = page.getByRole('dialog', { name: 'KI-Freigabe: plan' });
  await expect(dialog.getByRole('radio', { name: 'Freigegeben – nur für KI im eigenen Netz' })).toBeChecked();
  await expect(dialog.getByText('Nur Ollama sieht die Inhalte, nie Wolke.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  expect((await page.request.delete(`/api/ai/providers/${cloud.id}`, { data: {} })).ok()).toBe(true);
  await page.reload();
  await expect(rules.getByRole('listitem').first()).toContainText('freigegeben');
  // „Alles zu-/aufklappen“ next to the search includes this section (one toggle, like at each source).
  await page.locator('aside').getByRole('button', { name: 'Alles zuklappen' }).click();
  await expect(rules).toHaveCount(0);
  await page.locator('aside').getByRole('button', { name: 'Alles aufklappen' }).click();
  await expect(rules.getByRole('listitem').first()).toBeVisible();
});

test('ask the knowledge base: answer with a source that opens the note', async () => {
  await page.locator('aside').getByRole('button', { name: 'KI fragen' }).click();
  await page.getByRole('textbox', { name: 'Frage' }).fill('Worauf verweist die Roadmap?');
  await page.getByRole('button', { name: 'Fragen' }).click();
  const chat = page.getByLabel('Chat');
  await expect(chat.getByText('Die Roadmap verweist auf Trilium [1].')).toBeVisible();
  await expect(chat.getByRole('button', { name: /^\[1\] / })).toBeVisible();
  expect(prompts.at(-1)).toContain('plan/');
  expect(prompts.at(-1)).not.toContain('Zebrawort');
  // The agent looked it up itself: the steps are listed with the answer.
  await expect(chat.getByText(/2 Schritte/)).toBeVisible();
  await chat.getByText(/2 Schritte/).click();
  await expect(chat.getByText('Sucht „Roadmap“')).toBeVisible();
  // The chat keeps its scope: text, no choice that looks changeable (owner 21.10.).
  const ask = page.getByRole('dialog', { name: 'Frag die Wissensbasis' });
  await expect(ask.getByLabel('Bezug')).toHaveCount(0);
  await expect(ask.getByTestId('ai-scope')).toHaveText('Alles Freigegebene');
  await shot(page, '63-ki-fragen');
  await expect(page.getByLabel('Frühere Chats').getByText('Worauf verweist die Roadmap?')).toBeVisible();
  await ask.getByRole('button', { name: 'Anderer Bezug: neuer Chat' }).click();
  await expect(ask.getByLabel('Bezug')).toBeEnabled();
  await page.getByLabel('Frühere Chats').getByText('Worauf verweist die Roadmap?').click();
  await expect(ask.getByTestId('ai-scope')).toHaveText('Alles Freigegebene');
  // Right-click: open in a new tab and stay in the dialog (to open several sources).
  const source = chat.getByRole('button', { name: /^\[1\] / }).first();
  const path = (await source.getAttribute('title'))!.split(' – ')[0]!;
  const sourceTabs = page.locator(`[data-tab="${path}"]`);
  await source.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rechts daneben öffnen' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'In neuem Tab öffnen' }).click();
  await expect(page.getByRole('dialog', { name: 'Frag die Wissensbasis' })).toBeVisible();
  // A tab for the source — never a second one when it was open already.
  await expect(sourceTabs).toHaveCount(1);
  await source.click({ button: 'middle' });
  await expect(sourceTabs).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Frag die Wissensbasis' })).toBeVisible();
  await chat.getByRole('button', { name: /^\[1\] / }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('"KI fragen …" also in the editor\'s KI menu, with this note as the scope', async () => {
  await tree().getByText('roadmap', { exact: true }).first().click();
  await page.locator('.prose-note').filter({ visible: true }).getByText('Siehe').click();
  await page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true }).getByRole('button', { name: 'KI' }).click();
  await expect(page.getByRole('menuitem', { name: 'Zusammenfassen' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'KI fragen …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Frag die Wissensbasis' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Bezug').locator('option:checked')).toHaveText('Diese Notiz (roadmap)');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('"Weiterschreiben" finishes a broken-off sentence in the same paragraph, placeholders are pointed out', async () => {
  await tree().getByText('Detailseite', { exact: true }).last().click(); // renamed in phase 1
  const editor = page.locator('.prose-note').filter({ visible: true });
  await editor.getByText('Extern geändert in VS Code.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Erst Plan und dann');
  await expect.poll(() => read('plan/Detailseite.md'), { timeout: 10_000 }).toContain('und dann');
  await page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true }).getByRole('button', { name: 'KI' }).click();
  await page.getByRole('menuitem', { name: 'Weiterschreiben' }).click();
  // The repeated „und dann“ is dropped; the note went out as Markdown.
  await expect(page.getByLabel('KI-Vorschlag')).toHaveText('folgt [Termin].');
  expect(prompts.at(-1)).toContain('# Details');
  await expect(page.getByText('Angaben in [eckigen Klammern] sind Platzhalter')).toBeVisible();
  await page.getByRole('button', { name: 'Am Ende einfügen' }).click();
  await expect(editor.locator('p').last()).toHaveText('Extern geändert in VS Code. Erst Plan und dann folgt [Termin].');
  await expect.poll(() => read('plan/Detailseite.md'), { timeout: 10_000 }).toContain('Extern geändert in VS Code. Erst Plan und dann folgt \\[Termin].');
});

test('agent proposes a new note; it is created only after "Übernehmen"', async () => {
  await page.locator('aside').getByRole('button', { name: 'KI fragen' }).click();
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.getByRole('textbox', { name: 'Frage' }).fill('Leg im Ordner plan eine Übersicht an');
  await page.getByRole('button', { name: 'Fragen' }).click();
  const card = page.getByLabel('Vorschlag');
  await expect(card).toContainText('Neue Notiz „Übersicht“ in Notizen / plan');
  expect(read('plan/Übersicht.md')).toBe('');
  await card.getByRole('button', { name: 'Vorschau' }).click();
  await expect(card).toContainText('- [Roadmap](roadmap.md)');
  await shot(page, '64-ki-agent-vorschlag');
  await card.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(card).toContainText('Übernommen');
  await expect.poll(() => read('plan/Übersicht.md'), { timeout: 10_000 }).toContain('- [Roadmap](roadmap.md)');
  await card.getByRole('button', { name: 'Öffnen' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.prose-note').filter({ visible: true })).toContainText('Roadmap');
});

test('note menu dialogs name the note by its file name, not its first heading', async () => {
  await tree().getByText('trilium', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Berechtigungen …' }).click();
  await expect(page.getByRole('dialog', { name: 'Berechtigungen: trilium' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Weitere Aktionen' }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: 'Löschen' }).click();
  await expect(page.getByRole('dialog')).toContainText('trilium');
  await expect(page.getByRole('dialog')).not.toContainText('Trilium Ideen');
  await page.keyboard.press('Escape');
});

test('chats: answers formatted like a note, a general question has a hint, the history is cleared by time range', async () => {
  await page.locator('aside').getByRole('button', { name: 'KI fragen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Frag die Wissensbasis' });
  const history = dialog.getByRole('complementary', { name: 'Frühere Chats' });
  await expect(history.getByRole('button').filter({ hasNotText: /Neuer Chat|Verlauf/ }).first()).toBeVisible();
  // An earlier answer is rendered (a paragraph of the editor), not shown as raw text.
  await history.locator('button[title]').first().click();
  await expect(dialog.getByLabel('Chat').locator('.prose-compact p').first()).toBeVisible();
  // Use an answer: copy (formatted + Markdown), switch to Markdown and back, save it as a note.
  const tools = dialog.getByLabel('Antwort verwenden').last();
  await tools.getByRole('button', { name: 'Kopieren' }).click();
  await expect(page.getByText('Antwort kopiert')).toBeVisible();
  await tools.getByRole('button', { name: 'Markdown' }).click();
  await expect(dialog.getByLabel('Antwort als Markdown').last()).toBeVisible();
  await tools.getByRole('button', { name: 'Formatiert' }).click();
  await tools.getByRole('button', { name: 'Als Notiz speichern …' }).click();
  const save = page.getByRole('dialog', { name: 'Antwort als Notiz speichern' });
  await save.getByLabel('Titel').fill('KI-Antwort Test');
  await save.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Als Notiz gespeichert')).toBeVisible();
  await expect(page.locator('.prose-note h1').filter({ visible: true })).toHaveText('KI-Antwort Test');
  await page.locator('aside').getByRole('button', { name: 'KI fragen' }).click();
  await dialog.getByRole('button', { name: 'Neuer Chat' }).click();
  const general = await dialog.getByLabel('Bezug').locator('option', { hasText: 'Allgemein (ohne Wiki)' }).getAttribute('value');
  await dialog.getByLabel('Bezug').selectOption(general!);
  await expect(dialog.getByText('Es geht keine Notiz an den Anbieter')).toBeVisible();
  // „Verlauf löschen …“: the last 24 hours (all test chats), after asking.
  await history.getByRole('button', { name: 'Verlauf löschen …' }).click();
  await page.getByRole('menuitem', { name: 'Letzte 24 Stunden' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Löschen' }).click();
  await expect(page.getByText(/\d+ Chats? gelöscht/)).toBeVisible();
  await expect(history.locator('button[title]')).toHaveCount(0);
  await page.keyboard.press('Escape');
});
