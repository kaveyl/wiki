// Private AI (AD-079) through the UI, after phase 5 in the same workspace (admin, source „Projektwiki“, local provider
// „Ollama“ from phase 5 – ticked private by default). Two fake cloud providers record every byte they get:
// „Claude E2E“ (Anthropic Messages API, not private) and „Ollama ZDR“ (OpenAI-compatible as Ollama Cloud, ticked).
// Owner 16.11.: switching „Bearbeiten“ between providers kept the first one's fields – and the security rule must hold
// end to end: private notes never reach the non-private AI, also not through the chat history.
import { expect, test, type Page } from '@playwright/test';
import { sidebarView } from './menus';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openSettingsPage } from './settings-nav';
import { waitIndexed } from './indexed';
import { shot } from './shots';

const NOTES = resolve(import.meta.dirname, '../.local/e2e/projekte/notizen');
const PRIV = 'PRIV-E2E-777';
const PUB = 'OFFEN-E2E-1';

test.describe.configure({ mode: 'serial' });

let page: Page;
let fake: Server;
let fakeUrl: string;
const got: { provider: 'claude' | 'zdr'; body: string }[] = [];
const sentTo = (p: 'claude' | 'zdr') => got.filter((g) => g.provider === p).map((g) => g.body).join('\n');
const markers = (text: string) => [...new Set(text.match(/(PRIV|OFFEN)-E2E-\d+/g) ?? [])].sort().join(' ');

/** A nosy model: searches, reads every hit, also guesses the private note's path, then names every marker it saw. */
function decide(body: { messages?: { role: string; content: unknown; tool_calls?: unknown[] }[]; tools?: unknown[] }, anthropic: boolean) {
  const msgs = body.messages ?? [];
  const rounds = msgs.filter((m) => m.role === 'assistant' && (anthropic ? Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === 'tool_use') : m.tool_calls?.length)).length;
  const all = JSON.stringify(body);
  if (!body.tools || rounds >= 2) return { text: `Antwort. Gesehen: ${markers(all) || '—'}` };
  if (rounds === 0) return { calls: [{ name: 'search', args: { query: 'Tresorwort' } }] };
  const calls: { name: string; args: Record<string, string> }[] = [];
  for (const m of all.matchAll(/sourceId=(\w+) \(.*?\) path=([^\s\\]+)/g)) calls.push({ name: 'read_note', args: { sourceId: m[1]!, path: m[2]! } });
  const src = /sourceId=(\w+)/.exec(all)?.[1];
  if (src) calls.push({ name: 'read_note', args: { sourceId: src, path: 'e2e-privat/Tresor.md' } });
  return calls.length ? { calls } : { text: 'Keine Treffer.' };
}

function reply(res: ServerResponse, body: { model?: string; stream?: boolean }, out: ReturnType<typeof decide>, anthropic: boolean) {
  let n = 0;
  const calls = out.calls?.map((c) => ({ ...c, id: `c${Date.now()}${n++}` }));
  if (anthropic) {
    type Block = { type: 'tool_use'; id: string; name: string; input: Record<string, string> } | { type: 'text'; text: string };
    const content: Block[] = calls ? calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args })) : [{ type: 'text', text: out.text ?? '' }];
    if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: body.model, content, stop_reason: calls ? 'tool_use' : 'end_turn' }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, d: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { model: body.model, usage: { input_tokens: 1 } } });
    content.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      } else {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
    });
    ev('message_delta', { delta: { stop_reason: calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
    return res.end();
  }
  const toolCalls = calls?.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  if (!body.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: body.model, choices: [{ message: { content: out.text ?? null, tool_calls: toolCalls } }] }));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (out.text) res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: out.text } }] })}\n\n`);
  if (toolCalls) res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { tool_calls: toolCalls } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

test.beforeAll(async ({ browser }) => {
  fake = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const provider = req.url!.startsWith('/claude') ? 'claude' : 'zdr';
      if (req.url!.includes('/v1/models/')) {
        // Anthropic Models API: this model knows low/medium/high, not xhigh.
        const level = (supported: boolean) => ({ supported });
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ capabilities: { effort: { supported: true, low: level(true), medium: level(true), high: level(true), xhigh: level(false) } } }));
      }
      if (req.url!.includes('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: provider === 'claude' ? 'claude-e2e' : 'gpt-zdr' }] }));
      got.push({ provider, body: data });
      const body = JSON.parse(data || '{}');
      reply(res, body, decide(body, provider === 'claude'), provider === 'claude');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  mkdirSync(join(NOTES, 'e2e-privat'), { recursive: true });
  mkdirSync(join(NOTES, 'e2e-offen'), { recursive: true });
  writeFileSync(join(NOTES, 'e2e-privat', 'Tresor.md'), `# Tresor\n\nTresorwort ${PRIV}.\n`);
  writeFileSync(join(NOTES, 'e2e-offen', 'Info.md'), `# Info\n\nTresorwort ${PUB}.\n`);
  page = await browser.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(tree().getByText('Projektwiki', { exact: true }).first()).toBeVisible();
  await waitIndexed(page, 'Projektwiki', ['e2e-privat/Tresor.md', 'e2e-offen/Info.md']);
});

test.afterAll(async () => {
  // Leave the workspace as phase 5 left it: providers, defaults, rules, files.
  const list = (await (await page.request.get('/api/ai/providers')).json()) as { providers: { id: string; name: string }[] };
  for (const p of list.providers.filter((x) => x.name === 'Claude E2E' || x.name === 'Ollama ZDR')) await page.request.delete(`/api/ai/providers/${p.id}`, { data: {} });
  const ollama = list.providers.find((x) => x.name === 'Ollama');
  await page.request.put('/api/ai/settings', { data: { defaultId: ollama?.id ?? null, privateDefaultId: null } });
  await page.request.put('/api/state/ai', { data: {} });
  const mounts = (await (await page.request.get('/api/mounts')).json()) as { id: string; name: string }[];
  const id = mounts.find((m) => m.name === 'Projektwiki')!.id;
  const rules = (await (await page.request.get(`/api/ai/rules?mountId=${id}`)).json()) as { id: string; path: string }[];
  for (const r of (Array.isArray(rules) ? rules : []).filter((r) => r.path.startsWith('e2e-'))) await page.request.delete(`/api/ai/rules/${r.id}`, { data: {} });
  rmSync(join(NOTES, 'e2e-privat'), { recursive: true, force: true });
  rmSync(join(NOTES, 'e2e-offen'), { recursive: true, force: true });
  await new Promise((r) => fake.close(r));
});

const tree = () => page.locator('aside nav[aria-label="Quellen"]');
const providerList = () => page.getByRole('list', { name: 'KI-Anbieter' });
const row = (name: string) => providerList().getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
const form = () => page.getByRole('form', { name: 'KI-Anbieter' });
// The label „Aufwand“ sits around a select whose first option says „Standard des Modells“: by label, „Modell“ would hit both.
const model = () => form().locator('input[role="combobox"]');
const effortSelect = () => form().locator('select');
const providers = async () =>
  (await (await page.request.get('/api/ai/providers')).json()) as { defaultId: string; privateDefaultId: string | null; providers: { id: string; name: string; baseUrl: string; model: string; private: boolean; cloud: boolean; effort?: string }[] };

test('admin adds a cloud AI and a private cloud AI; effort only where the model knows it', async () => {
  await openSettingsPage(page, 'KI');
  await page.getByRole('button', { name: '+ Anthropic', exact: true }).click();
  await form().getByLabel('Name').fill('Claude E2E');
  await form().getByLabel('Adresse').fill(`${fakeUrl}/claude`);
  await form().getByLabel('API-Key').fill('key-claude-e2e');
  await model().fill('claude-e2e');
  await expect(form().getByRole('checkbox', { name: 'Für private Seiten zulassen' })).not.toBeChecked();
  await form().getByRole('button', { name: 'Verbindung testen' }).click();
  await expect(form().getByText('Verbunden – 1 Modelle zur Auswahl.')).toBeVisible();
  const effort = effortSelect();
  await expect(effort.locator('option')).toHaveText(['Standard des Modells', 'Niedrig', 'Mittel', 'Hoch']);
  await effort.selectOption({ label: 'Mittel' });
  await form().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(row('Claude E2E')).toBeVisible();

  await page.getByRole('button', { name: '+ Ollama Cloud', exact: true }).click();
  await form().getByLabel('Name').fill('Ollama ZDR');
  await form().getByLabel('Adresse').fill(`${fakeUrl}/zdr`);
  await form().getByLabel('API-Key').fill('key-zdr-e2e');
  await model().fill('gpt-zdr');
  await expect(effortSelect()).toHaveCount(0);
  const tick = form().getByRole('checkbox', { name: 'Für private Seiten zulassen' });
  await expect(tick).not.toBeChecked();
  await tick.check();
  await expect(form()).toContainText('Zero Data Retention');
  await form().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(row('Ollama ZDR')).toBeVisible();

  // „privat“ in the overview: the ticked cloud AI and the local one, not Claude.
  await expect(row('Ollama ZDR').getByText('privat', { exact: true })).toBeVisible();
  await expect(row('Ollama').getByText('privat', { exact: true })).toBeVisible();
  await expect(row('Claude E2E').getByText('privat', { exact: true })).toHaveCount(0);
  const saved = await providers();
  expect(saved.providers.find((p) => p.name === 'Claude E2E')).toMatchObject({ private: false, cloud: true, effort: 'medium', baseUrl: `${fakeUrl}/claude` });
  expect(saved.providers.find((p) => p.name === 'Ollama ZDR')).toMatchObject({ private: true, cloud: true, baseUrl: `${fakeUrl}/zdr` });
});

test('„Bearbeiten“ on another provider shows that provider – and „Speichern“ writes only it (owner bug 16.11.)', async () => {
  const before = await providers();
  const expectForm = async (name: string, url: string, priv: boolean, effort: string | null) => {
    await expect(form().getByLabel('Name')).toHaveValue(name);
    await expect(form().getByLabel('Adresse')).toHaveValue(url);
    const tick = form().getByRole('checkbox', { name: 'Für private Seiten zulassen' });
    if (priv) await expect(tick).toBeChecked();
    else await expect(tick).not.toBeChecked();
    if (effort) await expect(effortSelect().locator('option:checked')).toHaveText(effort);
    else await expect(effortSelect()).toHaveCount(0);
  };
  // Every order of switching, without closing the form in between.
  for (const [name, url, priv, effort] of [
    ['Ollama ZDR', `${fakeUrl}/zdr`, true, null],
    ['Claude E2E', `${fakeUrl}/claude`, false, 'Mittel'],
    ['Ollama', before.providers.find((p) => p.name === 'Ollama')!.baseUrl, true, null],
    ['Claude E2E', `${fakeUrl}/claude`, false, 'Mittel'],
    ['Ollama ZDR', `${fakeUrl}/zdr`, true, null],
  ] as const) {
    await row(name).getByRole('button', { name: 'Bearbeiten' }).click();
    await expectForm(name, url, priv, effort);
  }
  // Opened Claude after Ollama ZDR and saved unchanged: both stay exactly as they were.
  await row('Claude E2E').getByRole('button', { name: 'Bearbeiten' }).click();
  await expectForm('Claude E2E', `${fakeUrl}/claude`, false, 'Mittel');
  await form().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(form()).toHaveCount(0);
  const after = await providers();
  const pick = (l: typeof before) => l.providers.map(({ id, name, baseUrl, model, private: p, effort }) => ({ id, name, baseUrl, model, p, effort })).sort((a, b) => a.id.localeCompare(b.id));
  expect(pick(after)).toEqual(pick(before));
  // A change on one provider's form lands on that provider only.
  await row('Claude E2E').getByRole('button', { name: 'Bearbeiten' }).click();
  await row('Ollama ZDR').getByRole('button', { name: 'Bearbeiten' }).click();
  await model().fill('gpt-zdr-2');
  await form().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(form()).toHaveCount(0);
  const changed = await providers();
  expect(changed.providers.find((p) => p.name === 'Ollama ZDR')!.model).toBe('gpt-zdr-2');
  expect(changed.providers.find((p) => p.name === 'Claude E2E')!.model).toBe('claude-e2e');
});

test('defaults: Claude for everything, Ollama ZDR for private notes; „Meine KI“ offers the private choice', async () => {
  // The radios follow the server (controlled): click, then wait for the saved state.
  await row('Claude E2E').getByRole('radio', { name: 'Standard', exact: true }).click();
  await expect(row('Claude E2E').getByRole('radio', { name: 'Standard', exact: true })).toBeChecked();
  // Two ticked providers (local Ollama, Ollama ZDR): the private default is a choice.
  await expect(row('Claude E2E').getByRole('radio', { name: 'Standard privat' })).toHaveCount(0);
  await row('Ollama ZDR').getByRole('radio', { name: 'Standard privat' }).click();
  await expect(row('Ollama ZDR').getByRole('radio', { name: 'Standard privat' })).toBeChecked();
  await expect.poll(async () => {
    const l = await providers();
    return [l.providers.find((p) => p.id === l.defaultId)?.name, l.providers.find((p) => p.id === l.privateDefaultId)?.name];
  }).toEqual(['Claude E2E', 'Ollama ZDR']);
  const mine = page.getByLabel('Meine KI für private Seiten');
  await expect(mine.locator('option')).toHaveText(['Standard (Ollama ZDR)', 'Ollama (lokal)', 'Ollama ZDR (Cloud)']);
  await expect(page.getByLabel('Mein Anbieter').locator('option').first()).toHaveText('Standard (Claude E2E)');
  await shot(page, 'ki-anbieter-privat');
  await page.keyboard.press('Escape');
});

test('releases: „nur private KI“ is offered and shown; the overview filter „privat“ lists it', async () => {
  for (const [folder, choice] of [
    ['e2e-offen', 'Freigegeben'],
    ['e2e-privat', 'Freigegeben – nur private KI'],
  ] as const) {
    await tree().getByText(folder, { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'KI-Freigabe …' }).click();
    const dialog = page.getByRole('dialog', { name: `KI-Freigabe: ${folder}` });
    await expect(dialog.getByRole('radio', { name: 'Freigegeben – nur private KI' })).toBeVisible();
    await dialog.getByRole('radio', { name: choice, exact: true }).check();
    if (folder === 'e2e-privat') await expect(dialog).toContainText('Claude E2E');
    await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  // The overview is a view of the sidebar of its own (redesign 23.11.).
  await sidebarView(page, 'KI-Freigaben');
  const rules = page.getByRole('list', { name: 'KI-Freigaben' });
  await expect(rules.getByRole('listitem').filter({ hasText: 'e2e-privat' })).toContainText('nur private KI');
  await sidebarView(page, 'Baum');
});

test('a private note goes to the private AI from the editor; the cloud AI never gets it', async () => {
  await tree().getByText('e2e-privat', { exact: true }).first().click();
  await tree().getByText('Tresor', { exact: true }).first().click();
  const editor = page.locator('.prose-note').filter({ visible: true });
  await editor.getByText('Tresorwort').click();
  await page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true }).getByRole('button', { name: 'KI' }).click();
  await page.getByRole('menuitem', { name: 'Zusammenfassen' }).click();
  await expect(page.getByText(/Vorschlag \(Ollama ZDR · gpt-zdr-2\)/)).toBeVisible();
  await expect(page.getByText(`Gesehen: ${PRIV}`)).toBeVisible();
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  expect(sentTo('zdr')).toContain(PRIV);
  expect(sentTo('claude')).not.toContain(PRIV);
  // A public note from the same editor goes to the default.
  await tree().getByText('e2e-offen', { exact: true }).first().click();
  await tree().getByText('Info', { exact: true }).first().click();
  await page.locator('.prose-note').filter({ visible: true }).getByText('Tresorwort').click();
  await page.getByRole('toolbar', { name: 'Formatierung' }).filter({ visible: true }).getByRole('button', { name: 'KI' }).click();
  await page.getByRole('menuitem', { name: 'Zusammenfassen' }).click();
  await expect(page.getByText(/Vorschlag \(Claude E2E · claude-e2e\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Verwerfen' }).click();
});

test('asking everything: Claude answers without the private note, „Mit Ollama ZDR fragen“ includes it, the chat then stays private', async () => {
  await page.locator('aside').getByRole('button', { name: 'KI fragen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Frag die Wissensbasis' });
  const scope = dialog.getByLabel('Bezug');
  const all = await scope.locator('option', { hasText: 'Alles Freigegebene' }).getAttribute('value');
  await scope.selectOption(all!);
  const chat = dialog.getByLabel('Chat');
  await dialog.getByRole('textbox', { name: 'Frage' }).fill('Was steht zum Tresorwort?');
  await dialog.getByRole('button', { name: 'Fragen' }).click();
  await expect(chat.getByText('Claude E2E · claude-e2e · Agent')).toBeVisible();
  await expect(chat.getByText(`Gesehen: ${PUB}`)).toBeVisible();
  await expect(chat.getByRole('note').filter({ hasText: 'Gefunden wird nur, was für Claude E2E freigegeben ist' })).toContainText('1 passende private Seite');
  expect(sentTo('claude')).toContain(PUB);
  expect(sentTo('claude')).not.toContain(PRIV);
  // The nosy model guessed the private path itself: it got a refusal, and no search hit named it.
  expect(sentTo('claude')).not.toContain('path=e2e-privat');
  expect(sentTo('claude')).toContain('nur für private KI freigegeben');
  await shot(page, 'ki-fragen-privat-hinweis');

  await chat.getByRole('button', { name: 'Mit Ollama ZDR fragen' }).click();
  await expect(chat.getByText('Ollama ZDR · gpt-zdr-2 · Agent')).toBeVisible();
  await expect(chat.getByText(new RegExp(`Gesehen: .*${PRIV}`))).toBeVisible();
  // The next question in this chat: its history holds the private answer – it must not go to Claude.
  const claudeBefore = got.filter((g) => g.provider === 'claude').length;
  await dialog.getByRole('textbox', { name: 'Frage' }).fill('Und was noch?');
  await dialog.getByRole('button', { name: 'Fragen' }).click();
  await expect(chat.getByText('Ollama ZDR · gpt-zdr-2 · Agent')).toHaveCount(2);
  expect(got.filter((g) => g.provider === 'claude').length).toBe(claudeBefore);
  await page.keyboard.press('Escape');
});

test('nothing private ever reached the cloud AI; untick → nobody sees the private note', async () => {
  expect(sentTo('claude')).not.toContain(PRIV);
  expect(sentTo('claude')).not.toContain('path=e2e-privat');
  expect(sentTo('zdr')).toContain(PRIV);
  // Untick on the provider's form: the private note is refused for everyone, nothing is sent.
  await openSettingsPage(page, 'KI');
  await row('Ollama ZDR').getByRole('button', { name: 'Bearbeiten' }).click();
  await form().getByRole('checkbox', { name: 'Für private Seiten zulassen' }).uncheck();
  await form().getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(row('Ollama ZDR').getByText('privat', { exact: true })).toHaveCount(0);
  const l = await providers();
  expect(l.providers.find((p) => p.name === 'Ollama ZDR')!.private).toBe(false);
  // The local Ollama is still ticked – the private note may go there only; Claude and ZDR named directly are refused.
  const mounts = (await (await page.request.get('/api/mounts')).json()) as { id: string; name: string }[];
  const mountId = mounts.find((m) => m.name === 'Projektwiki')!.id;
  const count = got.length;
  for (const name of ['Claude E2E', 'Ollama ZDR']) {
    const id = l.providers.find((p) => p.name === name)!.id;
    const r = await page.request.post('/api/ai/transform', { data: { action: 'summarize', mountId, path: 'e2e-privat/Tresor.md', providerId: id } });
    expect(r.status()).toBeGreaterThanOrEqual(400);
  }
  expect(got.length).toBe(count);
  await page.keyboard.press('Escape');
});
