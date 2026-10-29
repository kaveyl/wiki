import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { git } from '../git/git.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/db.js';
import { relinkFromRoot, stripCitations } from './agent.js';
import { plainText } from './providers.js';
import { citedSources, dropRepeat } from './assistant.js';

// A fake OpenAI-compatible provider (like Ollama's /v1): records every request, answers with a
// fixed text that echoes which sources it got.
let fake: Server;
let fakeUrl: string;
const received: { path: string; auth?: string; body: { model: string; messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] } }[] = [];
/** Scripted answers to requests with tools (agent steps); `unsupported` = model without tools. */
let script: { tool_calls?: { id: string; function: { name: string; arguments: string } }[]; content?: string }[] = [];
let toolsUnsupported = false;
const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, function: { name, arguments: JSON.stringify(args) } }] });

let root: string;
let app: App;
let cookie: string;
let mountId: string;

const json = (body: unknown, c = cookie) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: c } });
const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, c = cookie) =>
  app.server.inject({ method, url, ...(body === undefined ? { headers: { cookie: c } } : json(body, c)) });

beforeEach(async () => {
  received.length = 0;
  script = [];
  toolsUnsupported = false;
  fake = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.url === '/api/tags') {
        received.push({ path: req.url, auth: req.headers.authorization, body: { model: '', messages: [] } });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'qwen3:480b' }, { name: 'gpt-oss:120b' }] }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mini' }, { id: 'gross' }] }));
        return;
      }
      const body = JSON.parse(data || '{}');
      received.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      if (req.url === '/v1/messages' && body.stream) {
        // Anthropic Messages API, streamed: tool_use blocks with partial JSON, text deltas.
        const next = script.shift() ?? { content: 'Fertig.' };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (type: string, d: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
        ev('message_start', { message: { model: body.model, usage: { input_tokens: 5 } } });
        let index = 0;
        if (next.content) {
          ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
          for (const piece of next.content.match(/.{1,6}/gs) ?? []) ev('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
          index++;
        }
        for (const c of next.tool_calls ?? []) {
          ev('content_block_start', { index, content_block: { type: 'tool_use', id: c.id, name: c.function.name, input: {} } });
          const half = Math.floor(c.function.arguments.length / 2);
          ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: c.function.arguments.slice(0, half) } });
          ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: c.function.arguments.slice(half) } });
          index++;
        }
        ev('message_delta', { usage: { output_tokens: 7 } });
        ev('message_stop', {});
        res.end();
        return;
      }
      if (body.tools) {
        if (toolsUnsupported) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'registry.ollama.ai/library/mini does not support tools' } }));
          return;
        }
        const next = script.shift() ?? { content: 'Fertig.' };
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: body.model, choices: [{ message: { content: next.content ?? null, tool_calls: next.tool_calls } }] }));
          return;
        }
        // Like a real provider: text in pieces, tool-call arguments in pieces.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: unknown) => res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta }] })}\n\n`);
        if (next.content) for (const piece of next.content.match(/.{1,8}/gs) ?? []) chunk({ content: piece });
        for (const [index, c] of (next.tool_calls ?? []).entries()) {
          const half = Math.floor(c.function.arguments.length / 2);
          chunk({ tool_calls: [{ index, id: c.id, function: { name: c.function.name, arguments: c.function.arguments.slice(0, half) } }] });
          chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments.slice(half) } }] });
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      const last = body.messages?.at(-1)?.content ?? '';
      const answer = last.includes('[1]') ? 'Laut [1] steht es im Plan.' : last.includes('TYPO-TEST') ? 'Das Eis\u2011Angebot  \nist gut\u00a0und günstig.\u200b' : 'Umformuliert.';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: body.model, choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-ai-'));
  const wiki = join(root, 'projekte', 'wiki');
  mkdirSync(join(wiki, 'offen'), { recursive: true });
  mkdirSync(join(wiki, 'privat'), { recursive: true });
  writeFileSync(join(wiki, 'offen', 'plan.md'), '# Plan\n\nDer Kolibri-Plan steht hier.\n');
  writeFileSync(join(wiki, 'offen', 'gesperrt.md'), '---\nai: false\n---\n# Gesperrt\n\nKolibri geheim im Frontmatter gesperrt.\n');
  writeFileSync(join(wiki, 'privat', 'tagebuch.md'), '# Tagebuch\n\nKolibri privat.\n');
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [join(root, 'projekte')], syncIntervalSec: 0, commitDelaySec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false });
  await app.manager.start();
  const res = await app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', displayName: 'Admin' } });
  cookie = `kw_session=${res.cookies.find((c) => c.name === 'kw_session')!.value}`;
  app.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('acl_default', 'write')").run(); // rules on top of the former default (AD-051)
  mountId = ((await inject('POST', '/api/mounts', { type: 'local', source: wiki, name: 'Wiki' })).json() as { id: string }).id;
});

afterEach(async () => {
  await app.close();
  await new Promise((r) => fake.close(r));
  rmSync(root, { recursive: true, force: true });
});

async function provider(cloud = false) {
  // The fake runs on 127.0.0.1: as Ollama it is local, as Ollama Cloud always a cloud provider.
  const res = await inject('PUT', '/api/ai/providers', { kind: cloud ? 'ollama-cloud' : 'ollama', name: 'Lokal', baseUrl: fakeUrl, model: 'mini', apiKey: cloud ? 'sk-test-geheim-123' : undefined });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; hasKey: boolean };
}

describe('AI assistant (AD-011, AD-024)', () => {
  it('sees nothing without a release rule; with one: actions as suggestions, audited, nothing written', async () => {
    const p = await provider();
    expect((await inject('POST', `/api/ai/providers/${p.id}/models`, {})).json()).toEqual({ models: ['gross', 'mini'] });
    const act = () => inject('POST', '/api/ai/transform', { action: 'rewrite', mountId, path: 'offen/plan.md', text: 'Der Plan steht.' });
    const denied = await act();
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain('nicht für die KI freigegeben');
    expect(received).toHaveLength(0);

    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'read' });
    expect((await act()).json().error).toContain('nur zum Lesen');
    const sum = await inject('POST', '/api/ai/transform', { action: 'summarize', mountId, path: 'offen/plan.md' });
    expect(sum.json()).toMatchObject({ text: 'Umformuliert.', provider: 'Lokal', model: 'mini' });
    expect(received.at(-1)!.body.messages.at(-1)!.content).toContain('Kolibri-Plan');

    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'suggest' });
    expect((await act()).json()).toMatchObject({ text: 'Umformuliert.' });
    expect(received.at(-1)!.body.messages.at(-1)!.content).toBe('Der Plan steht.');
    // `ai: false` in the frontmatter is a hard block, even inside a released folder.
    expect((await inject('POST', '/api/ai/transform', { action: 'summarize', mountId, path: 'offen/gesperrt.md' })).json().error).toContain('ai: false');
    const log = JSON.stringify(app.db.prepare("SELECT message, detail_json FROM activity WHERE action = 'ai-request'").all());
    expect(log).toContain('offen/plan.md');
    expect(log).toContain('Lokal');
    // With the note's state (handbook „Protokoll der KI“).
    const detail = JSON.parse((app.db.prepare("SELECT detail_json FROM activity WHERE action = 'ai-request' ORDER BY id DESC").get() as { detail_json: string }).detail_json);
    expect(detail.notes).toEqual([{ mountId, path: 'offen/plan.md', version: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
  });

  it('plain text back: no non-breaking hyphens/spaces, one paragraph stays one paragraph (live test 2026-10-08)', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'suggest' });
    const r = await inject('POST', '/api/ai/transform', { action: 'grammar', mountId, path: 'offen/plan.md', text: 'TYPO-TEST das eis angebot ist gut' });
    expect(r.json().text).toBe('Das Eis-Angebot ist gut und günstig.');
  });

  it('cloud providers only get notes released for cloud; the key never reaches the browser', async () => {
    const p = await provider(true);
    expect(p.hasKey).toBe(true);
    const list = JSON.stringify((await inject('GET', '/api/ai/providers')).json());
    expect(list).not.toContain('sk-test-geheim-123');
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read', cloud: false });
    expect((await inject('POST', '/api/ai/transform', { action: 'summarize', mountId, path: 'offen/plan.md' })).json().error).toContain('nur für lokale');
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read', cloud: true });
    expect((await inject('POST', '/api/ai/transform', { action: 'summarize', mountId, path: 'offen/plan.md' })).statusCode).toBe(200);
    expect(received.at(-1)!.auth).toBe('Bearer sk-test-geheim-123');
  });

  it('ask: sources only from released, readable notes; a none rule always wins; chats are kept per user', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read' });
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'privat', level: 'none' });
    const res = await inject('POST', '/api/ai/ask', { question: 'Was steht zum Kolibri?', scope: { kind: 'all' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { chatId: string; answer: string; sources: { path: string }[] };
    expect(body.answer).toBe('Laut [1] steht es im Plan.');
    expect(body.sources.map((s) => s.path)).toEqual(['offen/plan.md']);
    const sent = received.at(-1)!.body.messages.at(-1)!.content;
    expect(sent).toContain('Kolibri-Plan');
    expect(sent).not.toContain('privat');
    expect(sent).not.toContain('geheim');
    // Follow-up in the same chat; the history goes along.
    await inject('POST', '/api/ai/ask', { question: 'Und genauer?', scope: { kind: 'all' }, chatId: body.chatId });
    expect(received.at(-1)!.body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const chat = (await inject('GET', `/api/ai/chats/${body.chatId}`)).json() as { messages: { role: string }[] };
    expect(chat.messages).toHaveLength(4);
    // Another user neither sees the chat nor gets sources from a folder closed to them by ACL.
    await inject('POST', '/api/admin/users', { email: 'maria@example.test', username: 'maria', password: 'Maria-Passwort-0001' });
    // Not about accounts here: skip the forced first password change (AD-030).
    app.db.prepare('UPDATE users SET must_change_password = 0').run();
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: 'Maria-Passwort-0001' } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    expect((await inject('GET', `/api/ai/chats/${body.chatId}`, undefined, maria)).statusCode).toBe(404);
    const users = (await inject('GET', '/api/admin/users')).json() as { id: string; username: string }[];
    await inject('POST', `/api/acl/${mountId}`, { target: 'folder', path: 'offen', subject: 'user', subjectId: users.find((u) => u.username === 'maria')!.id, level: 'none' });
    const theirs = (await inject('POST', '/api/ai/ask', { question: 'Was steht zum Kolibri?', scope: { kind: 'all' } }, maria)).json() as { sources: unknown[] };
    expect(theirs.sources).toEqual([]);
    // Only admins manage providers and rules.
    expect((await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'suggest' }, maria)).statusCode).toBe(403);
    // Deleting like a browser history: only the last 24 hours, then everything – and really gone.
    const older = (await inject('POST', '/api/ai/ask', { question: 'Alte Frage zum Kolibri?', scope: { kind: 'all' } })).json() as { chatId: string };
    app.db.prepare('UPDATE ai_chats SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86_400_000).toISOString(), older.chatId);
    const before = (await inject('GET', '/api/ai/chats')).json() as { id: string }[];
    expect((await inject('DELETE', '/api/ai/chats/all?hours=24', {})).json()).toEqual({ ok: true, deleted: before.length - 1 });
    expect(((await inject('GET', '/api/ai/chats')).json() as { id: string }[]).map((c) => c.id)).toEqual([older.chatId]);
    expect((await inject('DELETE', '/api/ai/chats/all', {})).json()).toEqual({ ok: true, deleted: 1 });
    expect((await inject('GET', '/api/ai/chats')).json()).toEqual([]);
    // Messages go with their chat (only Maria's chat is left).
    expect(app.db.prepare('SELECT COUNT(*) FROM ai_messages WHERE chat_id NOT IN (SELECT id FROM ai_chats)').pluck().get()).toBe(0);
  });

  it('Löschregeln: unused chats go after the general rule, chats about a source follow its own (AD-034)', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read' });
    const ask = async (scope: object) => ((await inject('POST', '/api/ai/ask', { question: 'Was steht zum Kolibri?', scope })).json() as { chatId: string }).chatId;
    const general = await ask({ kind: 'all' });
    const source = await ask({ kind: 'source', mountId });
    const age = (id: string, days: number) => app.db.prepare('UPDATE ai_chats SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - days * 86_400_000).toISOString(), id);
    const left = () => (app.db.prepare('SELECT id FROM ai_chats').pluck().all() as string[]).sort();
    const run = async () => (await inject('POST', '/api/admin/cleanup/run', {})).json() as { done: Record<string, number>; failed: string[] };
    age(general, 40);
    age(source, 40);
    // Defaults: 90 days → both stay.
    expect((await run()).failed).toEqual([]);
    expect(left()).toEqual([general, source].sort());
    // The source keeps its chats for 10 days only; the general rule stays at 90.
    expect((await inject('PATCH', `/api/mounts/${mountId}`, { options: { aiChatDays: 10 } })).statusCode).toBe(200);
    expect((await run()).done.aiChats).toBe(1);
    expect(left()).toEqual([general]);
    // Back to the general rule (empty value), which is now 30 days.
    await inject('PATCH', `/api/mounts/${mountId}`, { options: { aiChatDays: null } });
    expect(((await inject('GET', '/api/mounts')).json() as { id: string; options: { aiChatDays?: number } }[]).find((m) => m.id === mountId)!.options.aiChatDays).toBe(-1);
    expect((await inject('PUT', '/api/admin/cleanup', { aiChatDays: 30 })).json()).toMatchObject({ aiChatDays: 30 });
    expect((await inject('GET', '/api/ai/providers')).json()).toMatchObject({ retentionDays: 30 });
    await run();
    expect(left()).toEqual([]);
    // The overview lists rules, limits and what is stored now.
    const overview = (await inject('GET', '/api/admin/cleanup')).json() as { rules: Record<string, number>; usage: { trash: { mountId: string; aiChatDays: number }[]; db: { size: number } } };
    expect(overview.rules).toMatchObject({ aiChatDays: 30, trashDays: 30 });
    expect(overview.usage.trash.find((t) => t.mountId === mountId)).toMatchObject({ aiChatDays: -1 });
    expect(overview.usage.db.size).toBeGreaterThan(0);
    expect(app.db.prepare("SELECT message FROM activity WHERE action = 'cleanup-rules-changed'").pluck().get()).toContain('aiChatDays 90 → 30');
  });

  it('cloud or local is derived, never chosen: address, Ollama cloud models, fixed cloud services (AD-028)', async () => {
    const save = async (b: Record<string, unknown>) => (await inject('PUT', '/api/ai/providers', { name: 'x', ...b })).json() as { cloud: boolean; kind: string };
    expect(await save({ kind: 'ollama', baseUrl: 'http://ollama:11434', model: 'llama3.1', cloud: true })).toMatchObject({ cloud: false });
    expect(await save({ kind: 'ollama', baseUrl: 'http://192.168.7.35:11434', model: 'qwen3' })).toMatchObject({ cloud: false });
    expect(await save({ kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'gpt-oss:120b-cloud' })).toMatchObject({ cloud: true });
    expect(await save({ kind: 'ollama', baseUrl: 'https://ollama.example.com', model: 'llama3.1' })).toMatchObject({ cloud: true });
    expect(await save({ kind: 'openai', baseUrl: 'http://127.0.0.1:1234', model: 'lokal' })).toMatchObject({ cloud: false });
    expect(await save({ kind: 'openai', baseUrl: 'https://mein-projekt.openai.azure.com/openai', model: 'gpt-x', cloud: false })).toMatchObject({ cloud: true });
    expect(await save({ kind: 'anthropic', baseUrl: 'http://127.0.0.1:9', model: 'm' })).toMatchObject({ cloud: true });
    // Providers saved before (with a stored flag) are re-derived on reading.
    const stored = JSON.parse(app.db.prepare("SELECT value FROM settings WHERE key = 'ai_providers'").pluck().get() as string) as { cloud: boolean }[];
    stored.forEach((p) => (p.cloud = false));
    app.db.prepare("UPDATE settings SET value = ? WHERE key = 'ai_providers'").run(JSON.stringify(stored));
    const list = (await inject('GET', '/api/ai/providers')).json() as { providers: { cloud: boolean }[] };
    expect(list.providers.map((p) => p.cloud)).toEqual([false, false, true, true, false, true, true]);
  });

  it('Ollama Cloud: always a cloud provider with key; models from /api/tags; ollama.com never counts as local', async () => {
    const asLocal = (await inject('PUT', '/api/ai/providers', { kind: 'ollama', name: 'Versehen', baseUrl: 'https://ollama.com', cloud: false })).json() as { kind: string; cloud: boolean };
    expect(asLocal).toMatchObject({ kind: 'ollama-cloud', cloud: true });
    const p = (await inject('PUT', '/api/ai/providers', { kind: 'ollama-cloud', name: 'Ollama Cloud', baseUrl: fakeUrl, model: 'gpt-oss:120b', cloud: false })).json() as { id: string; cloud: boolean };
    expect(p.cloud).toBe(true);
    // Without a key: a clear message, nothing is sent.
    expect((await inject('POST', `/api/ai/providers/${p.id}/models`, {})).json().error).toContain('API-Key');
    await inject('PUT', '/api/ai/providers', { id: p.id, kind: 'ollama-cloud', apiKey: 'ollama-key-123' });
    expect((await inject('POST', `/api/ai/providers/${p.id}/models`, {})).json()).toEqual({ models: ['gpt-oss:120b', 'qwen3:480b'] });
    expect(received.at(-1)!.auth).toBe('Bearer ollama-key-123');
    await inject('PUT', '/api/ai/settings', { defaultId: p.id });
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read', cloud: false });
    expect((await inject('POST', '/api/ai/transform', { action: 'summarize', mountId, path: 'offen/plan.md' })).json().error).toContain('nur für lokale');
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read', cloud: true });
    expect((await inject('POST', '/api/ai/transform', { action: 'summarize', mountId, path: 'offen/plan.md' })).json()).toMatchObject({ provider: 'Ollama Cloud', model: 'gpt-oss:120b' });
    expect(received.at(-1)).toMatchObject({ path: '/v1/chat/completions', auth: 'Bearer ollama-key-123' });
  });

  it('release rules follow a folder moved in the app', async () => {
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'read' });
    await inject('POST', `/api/notes/${mountId}/move`, { from: 'offen', to: 'archiv/offen' });
    const r = (await inject('GET', `/api/ai/rule/${mountId}?target=folder&path=archiv/offen`)).json() as { rule: { level: string } | null };
    expect(r.rule?.level).toBe('read');
  });

  it('the dialog learns what applies without the own rule and from where; old read-only rules become released (AD-031)', async () => {
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'suggest', cloud: true });
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'none' });
    type R = { rule: { level: string } | null; inherited: { level: string; cloud: boolean; from: { target: string; path: string } | null } };
    const at = async (q: string) => (await inject('GET', `/api/ai/rule/${mountId}?${q}`)).json() as R;
    // The folder's own block is left out: above it the source is released.
    expect((await at('target=folder&path=offen')).inherited).toEqual({ level: 'suggest', cloud: true, from: { target: 'mount', path: '' } });
    // Below the block, the block decides.
    expect((await at('target=note&path=offen/plan.md')).inherited).toEqual({ level: 'none', cloud: false, from: { target: 'folder', path: 'offen' } });
    // Nothing above a source: the default.
    expect((await at('target=mount')).inherited).toEqual({ level: 'none', cloud: false, from: null });
    // Several blocks on the way: the nearest one is named, not the oldest.
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'none' });
    expect((await at('target=note&path=offen/plan.md')).inherited.from).toEqual({ target: 'folder', path: 'offen' });
    // Migration v13: a database at v12 with a read-only rule.
    const dir = mkdtempSync(join(tmpdir(), 'kw-v13-'));
    try {
      const file = join(dir, 'db.sqlite');
      const db = openDb(file);
      db.prepare("INSERT INTO mounts (id, name, type, source, created_at) VALUES ('m', 'Ordner', 'local', '/docs/x', 'x')").run();
      const add = db.prepare("INSERT INTO ai_rules (id, mount_id, target, path, level, cloud, created_at) VALUES (?, ?, 'folder', ?, ?, 0, 'x')");
      add.run('a', 'm', 'lesen', 'read');
      add.run('b', 'm', 'zu', 'none');
      // v14: a release of a source removed earlier goes.
      add.run('c', 'weg', 'alt', 'suggest');
      db.pragma('user_version = 12');
      db.close();
      const again = openDb(file);
      expect(again.prepare('SELECT id, level FROM ai_rules ORDER BY id').all()).toEqual([
        { id: 'a', level: 'suggest' },
        { id: 'b', level: 'none' },
      ]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removing a source removes its AI releases too (owner 2026-10-11)', async () => {
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'suggest', cloud: true });
    expect(((await inject('GET', '/api/ai/rules')).json() as unknown[]).length).toBe(1);
    expect((await inject('DELETE', `/api/mounts/${mountId}`, {})).statusCode).toBe(200);
    expect((await inject('GET', '/api/ai/rules')).json()).toEqual([]);
    expect(app.db.prepare('SELECT COUNT(*) FROM ai_rules').pluck().get()).toBe(0);
  });

  it('a note rule follows its note when it is renamed (a block keeps blocking)', async () => {
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'read', cloud: true });
    expect((await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'note', path: 'offen/plan.md', level: 'none' })).statusCode).toBe(200);
    const grant = async (path: string) => ((await inject('GET', `/api/ai/status/${mountId}/${path}`)).json() as { grant: { level: string } }).grant.level;
    expect(await grant('offen/plan.md')).toBe('none');
    expect((await inject('POST', `/api/notes/${mountId}/move`, { from: 'offen/plan.md', to: 'offen/plan-2026.md' })).statusCode).toBe(200);
    await expect.poll(() => grant('offen/plan-2026.md')).toBe('none');
  });
});

type Ev = { type: string; [k: string]: unknown };
const agent = async (body: unknown, c = cookie) => {
  const res = await inject('POST', '/api/ai/agent', body, c);
  return res.body.trim().split('\n').map((l) => JSON.parse(l) as Ev);
};

describe('AI agent (AD-026)', () => {
  it('searches and reads only released notes, proposes an edit; applying commits it as the AI on behalf of the user', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read' });
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'suggest' });
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'privat', level: 'none' });
    script = [
      call('search', { query: 'Kolibri' }),
      call('read_note', { sourceId: mountId, path: 'offen/plan.md' }),
      call('read_note', { sourceId: mountId, path: 'privat/tagebuch.md' }),
      call('propose_edit_note', { sourceId: mountId, path: 'offen/plan.md', markdown: '# Plan\n\nDer Kolibri-Plan ist fertig.\n', reason: 'Status nachgetragen' }),
      call('propose_create_note', { sourceId: mountId, parent: 'privat', title: 'Heimlich', markdown: '# x' }),
      { content: 'Laut [1] steht der Plan; ich habe eine Änderung vorgeschlagen.' },
    ];
    const all = await agent({ question: 'Trag ein, dass der Kolibri-Plan fertig ist', scope: { kind: 'all' } });
    // The answer streamed in pieces before it was complete.
    expect(all.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('Laut [1] steht der Plan; ich habe eine Änderung vorgeschlagen.');
    const events = all.filter((e) => e.type !== 'delta');
    expect(events.map((e) => e.type)).toEqual(['start', 'step', 'step', 'step', 'step', 'proposal', 'step', 'answer']);
    expect(events[0]).toMatchObject({ mode: 'agent' });
    expect(events.filter((e) => e.type === 'step').map((e) => e.label)).toEqual([
      'Sucht „Kolibri“',
      'Liest Wiki / offen/plan.md',
      'Liest Wiki / privat/tagebuch.md',
      'Schlägt eine Änderung an offen/plan.md vor',
      'Schlägt eine neue Notiz „Heimlich“ vor',
    ]);
    // What went back to the model: no blocked note, no closed folder, the read note as [1].
    const toolResults = received.at(-1)!.body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolResults[0]).toContain('offen/plan.md');
    expect(toolResults[0]).not.toContain('gesperrt');
    expect(toolResults[0]).not.toContain('privat');
    expect(toolResults[1]).toContain('Quelle [1]');
    expect(toolResults[2]).toMatch(/^Fehler: .*nicht für die KI freigegeben/);
    expect(toolResults[4]).toMatch(/^Fehler: /);
    expect(received.at(-1)!.body.tools!.map((t) => t.function.name)).toContain('propose_edit_note');
    const answer = events.at(-1)!;
    expect(answer).toMatchObject({ answer: 'Laut [1] steht der Plan; ich habe eine Änderung vorgeschlagen.', mode: 'agent', sources: [{ n: 1, path: 'offen/plan.md' }] });
    // Nothing written yet; the proposal waits with a diff.
    expect(readFileSync(join(root, 'projekte/wiki/offen/plan.md'), 'utf8')).toBe('# Plan\n\nDer Kolibri-Plan steht hier.\n');
    const chat = (await inject('GET', `/api/ai/chats/${answer.chatId as string}`)).json() as { proposals: { id: string; kind: string; status: string }[]; messages: { meta: { steps: string[] } }[] };
    expect(chat.proposals).toMatchObject([{ kind: 'write', status: 'open' }]);
    expect(chat.messages[1]!.meta.steps).toHaveLength(5);
    const id = chat.proposals[0]!.id;
    expect(((await inject('GET', `/api/ai/proposals/${id}/preview`)).json() as { diff: string }).diff).toContain('+Der Kolibri-Plan ist fertig.');

    // Applying: as the AI on behalf of the user, own commit with an ai(...) message.
    const wiki = join(root, 'projekte/wiki');
    await git(wiki, ['init', '-q', '-b', 'main']);
    await git(wiki, ['add', '-A']);
    await git(wiki, ['-c', 'user.name=Test', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'start']);
    await inject('PATCH', `/api/mounts/${mountId}`, { options: { autoCommit: true } });
    const applied = await inject('POST', `/api/ai/proposals/${id}/apply`, {});
    expect(applied.json()).toMatchObject({ status: 'applied', result: 'offen/plan.md' });
    expect(readFileSync(join(wiki, 'offen/plan.md'), 'utf8')).toBe('# Plan\n\nDer Kolibri-Plan ist fertig.\n');
    expect((await git(wiki, ['log', '-1', '--format=%an|%s'])).trim()).toBe('Kaveyl Wiki KI (im Auftrag von Admin)|ai(edit): offen/plan.md – Status nachgetragen');
    expect((await inject('POST', `/api/ai/proposals/${id}/apply`, {})).statusCode).toBe(409);
    const log = JSON.stringify(app.db.prepare("SELECT action, message FROM activity WHERE action IN ('ai-request', 'ai-proposal-applied')").all());
    expect(log).toContain('Agent (all), 5 Schritte, 1 Vorschläge');
    expect(log).toContain('KI-Vorschlag übernommen');
    // Another user can neither see nor apply it.
    await inject('POST', '/api/admin/users', { email: 'maria@example.test', username: 'maria', password: 'Maria-Passwort-0001' });
    // Not about accounts here: skip the forced first password change (AD-030).
    app.db.prepare('UPDATE users SET must_change_password = 0').run();
    const maria = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'maria@example.test', password: 'Maria-Passwort-0001' } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    expect((await inject('POST', `/api/ai/proposals/${id}/reject`, {}, maria)).statusCode).toBe(404);
  });

  it('a confirmed move brings along only files the confirming user may read – as moving in the tree does', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'suggest' });
    const wiki = join(root, 'projekte/wiki');
    // An encrypted note lists its files in the plain frontmatter; one lies in a folder Eva may not read.
    mkdirSync(join(wiki, 'offen/assets'), { recursive: true });
    writeFileSync(join(wiki, 'offen/assets/bild.png.age'), 'age-encryption.org/v1\n-> scrypt\n');
    writeFileSync(join(wiki, 'offen/geheim.md'), '---\ntitle: Geheim\nencrypted: age\nattachments:\n  - assets/bild.png.age\n---\n-----BEGIN AGE ENCRYPTED FILE-----\nx\n-----END AGE ENCRYPTED FILE-----\n');
    const eva = (await inject('POST', '/api/admin/users', { email: 'eva@example.test', username: 'eva', password: 'Eva-Passwort-0001-lang' })).json() as { id: string };
    app.db.prepare('UPDATE users SET must_change_password = 0').run();
    expect((await inject('POST', `/api/acl/${mountId}`, { target: 'folder', path: 'offen/assets', subject: 'user', subjectId: eva.id, level: 'none' })).statusCode).toBe(200);
    const evaCookie = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Eva-Passwort-0001-lang' } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    script = [call('propose_move_note', { sourceId: mountId, from: 'offen/geheim.md', to: 'offen/neu/geheim.md' }), { content: 'Vorgeschlagen.' }];
    const events = await agent({ question: 'Verschieb die Notiz nach neu', scope: { kind: 'all' } }, evaCookie);
    const id = (events.find((e) => e.type === 'proposal')!.proposal as { id: string }).id;
    expect((await inject('POST', `/api/ai/proposals/${id}/apply`, {}, evaCookie)).json()).toMatchObject({ status: 'applied', result: 'offen/neu/geheim.md' });
    expect(existsSync(join(wiki, 'offen/neu/geheim.md'))).toBe(true);
    expect(existsSync(join(wiki, 'offen/neu/assets/bild.png.age'))).toBe(false);
  });

  it('a folder moves only when the user may write everything in it and nothing inside is closed for the AI (sec2-001)', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'suggest' });
    const wiki = join(root, 'projekte/wiki');
    mkdirSync(join(wiki, 'offen/projekt/zu'), { recursive: true });
    mkdirSync(join(wiki, 'offen/projekt/ki-tabu'), { recursive: true });
    writeFileSync(join(wiki, 'offen/projekt/a.md'), '# A\n');
    writeFileSync(join(wiki, 'offen/projekt/zu/geheim.md'), '# Geheim\n');
    writeFileSync(join(wiki, 'offen/projekt/ki-tabu/privat.md'), '# Privat\n');
    // Written from outside: wait until the index knows them (the folder check goes by the index).
    const end = Date.now() + 5000;
    while (!(await inject('GET', `/api/tree/${mountId}`)).body.includes('offen/projekt/zu/geheim.md') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    const eva = (await inject('POST', '/api/admin/users', { email: 'eva@example.test', username: 'eva', password: 'Eva-Passwort-0001-lang' })).json() as { id: string };
    app.db.prepare('UPDATE users SET must_change_password = 0').run();
    expect((await inject('POST', `/api/acl/${mountId}`, { target: 'folder', path: 'offen/projekt/zu', subject: 'user', subjectId: eva.id, level: 'read' })).statusCode).toBe(200);
    const evaCookie = `kw_session=${(await app.server.inject({ method: 'POST', url: '/api/login', payload: { email: 'eva@example.test', password: 'Eva-Passwort-0001-lang' } })).cookies.find((c) => c.name === 'kw_session')!.value}`;
    const moveProposal = async (c: string) => {
      script = [call('propose_move_note', { sourceId: mountId, from: 'offen/projekt', to: 'offen/archiv' }), { content: 'Vorgeschlagen.' }];
      const events = await agent({ question: 'Verschieb projekt nach archiv', scope: { kind: 'all' } }, c);
      return (events.find((e) => e.type === 'proposal')?.proposal as { id: string } | undefined)?.id;
    };
    // Eva may only read „zu“: the tree refuses, and so does the AI.
    expect((await inject('POST', `/api/notes/${mountId}/move`, { from: 'offen/projekt', to: 'offen/archiv' }, evaCookie)).statusCode).toBe(403);
    expect(await moveProposal(evaCookie)).toBeUndefined();
    expect(received.at(-1)!.body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join()).toContain('nicht auf alles im Ordner Schreibrecht');
    // The admin may write everything; a folder inside closed for the AI after the proposal stops it when confirming.
    const id = await moveProposal(cookie);
    expect(id).toBeTruthy();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen/projekt/ki-tabu', level: 'none' });
    expect((await inject('POST', `/api/ai/proposals/${id}/apply`, {})).statusCode).toBe(403);
    expect(existsSync(join(wiki, 'offen/projekt/ki-tabu/privat.md'))).toBe(true);
    expect(existsSync(join(wiki, 'offen/archiv'))).toBe(false);
    expect(await moveProposal(cookie)).toBeUndefined();
    // The refusal names no folder closed for the AI – the model (and its provider) must not learn it (sec2-009).
    const refusal = received.at(-1)!.body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join();
    expect(refusal).toContain('nicht für KI-Vorschläge freigegeben');
    expect(refusal).not.toContain('ki-tabu');
  });

  it('search: when no note has all words, each word is searched on its own (live test 2026-10-08)', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'read' });
    script = [call('search', { query: 'Kolibri Zebrawortgibtsnicht' }), { content: 'Gefunden.' }];
    await agent({ question: 'Kolibri und Zebrawortgibtsnicht?', scope: { kind: 'all' } });
    const toolResults = received.at(-1)!.body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolResults[0]).toContain('Treffer für einzelne Wörter');
    expect(toolResults[0]).toContain('offen/plan.md');
  });

  it('a new note and a stale edit: created with its own id; a changed note is not overwritten', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'folder', path: 'offen', level: 'suggest' });
    script = [
      call('propose_create_note', { sourceId: mountId, parent: 'offen', title: 'Kolibri Übersicht', markdown: '# Übersicht\n\nAlles zum Kolibri.\n' }),
      call('propose_edit_note', { sourceId: mountId, path: 'offen/plan.md', markdown: '# Plan\n\nNeu.\n' }),
      { content: 'Zwei Vorschläge.' },
    ];
    const events = await agent({ question: 'Leg eine Übersicht an', scope: { kind: 'folder', mountId, path: 'offen' } });
    const [create, edit] = events.filter((e) => e.type === 'proposal').map((e) => (e.proposal as { id: string }).id);
    const made = (await inject('POST', `/api/ai/proposals/${create}/apply`, {})).json() as { result: string };
    expect(made.result).toBe('offen/Kolibri Übersicht.md');
    expect(readFileSync(join(root, 'projekte/wiki', made.result), 'utf8')).toMatch(/^---\nid: [0-9A-Z]{26}\n---\n# Übersicht\n\nAlles zum Kolibri.\n$/);
    writeFileSync(join(root, 'projekte/wiki/offen/plan.md'), '# Plan\n\nInzwischen von Hand geändert.\n');
    await new Promise((r) => setTimeout(r, 400));
    const stale = await inject('POST', `/api/ai/proposals/${edit}/apply`, {});
    expect(stale.statusCode).toBe(409);
    expect(readFileSync(join(root, 'projekte/wiki/offen/plan.md'), 'utf8')).toContain('von Hand');
    expect((await inject('POST', `/api/ai/proposals/${edit}/reject`, {})).statusCode).toBe(409);
  });

  it('falls back to the search answer for models without tool calling; general questions need no tools', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read' });
    toolsUnsupported = true;
    const events = await agent({ question: 'Was steht zum Kolibri?', scope: { kind: 'all' } });
    expect(events.map((e) => e.type)).toEqual(['start', 'answer']);
    expect(received.at(-2)!.body).toMatchObject({ stream: true });
    expect(events[1]).toMatchObject({ mode: 'rag', answer: 'Laut [1] steht es im Plan.' });
    const general = await agent({ question: 'Was ist ein Kolibri?', scope: { kind: 'general' } });
    expect(general.at(-1)).toMatchObject({ type: 'answer', mode: 'rag' });
    // Errors arrive as an event (the stream is already open).
    await inject('DELETE', `/api/ai/providers/${(await provider()).id}`, {});
    const none = await agent({ question: 'x', scope: { kind: 'all' }, providerId: 'weg' });
    expect(none.at(-1)).toMatchObject({ type: 'error' });
  });

  it('memory: instructions and confirmed entries in .kaveyl-wiki/ai/ go along with every request to the source', async () => {
    await provider();
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read' });
    const saved = await inject('PUT', `/api/ai/memory/${mountId}`, { instructions: 'Antworte immer mit einem Kolibri-Emoji.' });
    expect(saved.json()).toMatchObject({ enabled: true, instructions: 'Antworte immer mit einem Kolibri-Emoji.', memory: '' });
    const wiki = join(root, 'projekte/wiki');
    expect(readFileSync(join(wiki, '.kaveyl-wiki/ai/README.md'), 'utf8')).toContain('managed_by: kaveyl-wiki-ai');
    script = [call('propose_remember', { sourceId: mountId, text: 'Der Owner heißt Mara.' }), { content: 'Gemerkt (nach Bestätigung).' }];
    const events = await agent({ question: 'Merk dir: der Owner heißt Mara', scope: { kind: 'source', mountId } });
    expect(received.at(-1)!.body.messages[0]!.content).toContain('Antworte immer mit einem Kolibri-Emoji.');
    const id = (events.find((e) => e.type === 'proposal')!.proposal as { id: string }).id;
    expect((await inject('POST', `/api/ai/proposals/${id}/apply`, {})).json()).toMatchObject({ status: 'applied', result: '.kaveyl-wiki/ai/gedaechtnis.md' });
    expect(readFileSync(join(wiki, '.kaveyl-wiki/ai/gedaechtnis.md'), 'utf8')).toMatch(/- \d{4}-\d{2}-\d{2}: Der Owner heißt Mara\.\n$/);
    await agent({ question: 'Wie heißt der Owner?', scope: { kind: 'all' } });
    expect(received.at(-1)!.body.messages[0]!.content).toContain('Der Owner heißt Mara.');
    // The tree never shows the folder; switched off per source, nothing goes along.
    expect(JSON.stringify((await inject('GET', `/api/tree/${mountId}`)).json())).not.toContain('.kaveyl-wiki');
    await inject('PATCH', `/api/mounts/${mountId}`, { options: { aiMemory: false } });
    await agent({ question: 'Wie heißt der Owner?', scope: { kind: 'all' } });
    expect(received.at(-1)!.body.messages[0]!.content).not.toContain('Mara');
  });

  it('works the same with the Anthropic Messages API (streamed tool use and text)', async () => {
    const p = (await inject('PUT', '/api/ai/providers', { kind: 'anthropic', name: 'Claude', baseUrl: fakeUrl, model: 'claude-test', apiKey: 'sk-ant-test' })).json() as { id: string };
    await inject('PUT', '/api/ai/settings', { defaultId: p.id });
    await inject('PUT', `/api/ai/rule/${mountId}`, { target: 'mount', level: 'read', cloud: true });
    script = [call('search', { query: 'Kolibri' }), { content: 'Anthropic findet den Plan.' }];
    const all = await agent({ question: 'Wo steht der Kolibri?', scope: { kind: 'all' } });
    expect(all.filter((e) => e.type === 'step').map((e) => e.label)).toEqual(['Sucht „Kolibri“']);
    expect(all.at(-1)).toMatchObject({ type: 'answer', answer: 'Anthropic findet den Plan.', model: 'claude-test' });
    const second = received.at(-1)!.body as unknown as { messages: { role: string; content: { type: string; tool_use_id?: string; input?: unknown }[] }[] };
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.messages[1]!.content[0]).toMatchObject({ type: 'tool_use', input: { query: 'Kolibri' } });
    expect(second.messages[2]!.content[0]).toMatchObject({ type: 'tool_result' });
    expect(received.at(-1)!.auth).toBeUndefined();
  });
});


describe('agent proposals: clean note content (live test 2026-10-08)', () => {
  it('turns gpt-oss citations „【2†L1-L9】“ into the [2] of the sources list', () => {
    expect(plainText('Frist 25.09.【2†L1-L9】【1†L4-L6】 und mehr【3†Quelle】.')).toBe('Frist 25.09.[2][1] und mehr[3].');
    expect(plainText('41.380,50 €【1】, verschoben【2】.')).toBe('41.380,50 €[1], verschoben[2].');
    expect(plainText('abgeschaltet.\n\n[Quelle [1]] und [Quellen: [1], [2]]')).toBe('abgeschaltet.\n\n[1] und [1][2]');
    expect(plainText('```powershell\nGet-Date\n```[1]\n\nText')).toBe('```powershell\nGet-Date\n```\n\n[1]\n\nText');
  });

  it('a continuation does not repeat the words the text broke off with', () => {
    expect(dropRepeat('Your price is interesting, but', 'but we would like more.')).toBe('we would like more.');
    expect(dropRepeat('Neuigkeiten:\n\n**3.**', '**3. Neues Brot.** Ab [Datum].')).toBe('**Neues Brot.** Ab [Datum].');
    expect(dropRepeat('Wir freuen uns auf', 'Wir freuen uns auf Sie.')).toBe('Sie.');
    expect(dropRepeat('Neuigkeiten:\n\n**3.**', '**3.** [Neuigkeit: …]')).toBe('[Neuigkeit: …]');
    expect(dropRepeat('- Punkt', '- Punkt 2')).toBe('- Punkt 2');
    expect(dropRepeat('Ende.', 'Ende. Neu')).toBe('Ende. Neu');
    expect(dropRepeat('aber', 'aberwitzig')).toBe('aberwitzig');
  });

  it('lists only the sources an answer cites (all of them when it cites none)', () => {
    const src = [1, 2, 3].map((n) => ({ n, mountId: 'm', path: `${n}.md`, title: String(n) }));
    expect(citedSources('Um 02:30 Uhr [1], laut [3].', src).map((s) => s.n)).toEqual([1, 3]);
    expect(citedSources('Steht nicht in den Notizen.', src)).toHaveLength(3);
    expect(citedSources('Siehe [7].', src)).toHaveLength(3);
  });

  it('drops chat source numbers, keeps links, footnotes, definitions and numbers the note had', () => {
    expect(stripCitations('Preis steigt um 6 % [1]. Siehe [2] und [3](x.md), [^4], [5]: def')).toBe('Preis steigt um 6 %. Siehe und [3](x.md), [^4], [5]: def');
    expect(stripCitations('Quelle [1] bleibt, neu [2]', 'alt: Quelle [1]')).toBe('Quelle [1] bleibt, neu');
    expect(stripCitations('Erster `x = list[0]` [1].\n\n```python\nprint(a[1])\n```\n\nEnde [2].')).toBe('Erster `x = list[0]`.\n\n```python\nprint(a[1])\n```\n\nEnde.');
  });

  it('turns links written from the source root into links from the note folder', () => {
    const files = new Set(['Besprechungen/2026-10-01 Lieferanten.md', 'Notizen/Ideen.md']);
    const exists = (p: string) => files.has(p);
    const md = '[L](Besprechungen/2026-10-01%20Lieferanten.md#a) [I](Ideen.md) [W](https://x.org/a.md) [U](../Besprechungen/2026-10-01%20Lieferanten.md) [F](fehlt.md)';
    expect(relinkFromRoot(md, 'Notizen', exists)).toBe(
      '[L](../Besprechungen/2026-10-01%20Lieferanten.md#a) [I](Ideen.md) [W](https://x.org/a.md) [U](../Besprechungen/2026-10-01%20Lieferanten.md) [F](fehlt.md)',
    );
    expect(relinkFromRoot(md, '', exists)).toBe(md);
    expect(relinkFromRoot('[L](Besprechungen/2026-10-01%20Lieferanten.md)', 'a/b', exists)).toBe('[L](../../Besprechungen/2026-10-01%20Lieferanten.md)');
  });
});
