// HTTP routes of the AI assistant (AD-024). Providers and release rules: admins only.
// Status, actions, questions and the own chats: every signed-in user, within their rights.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Target } from '../acl/acl.js';
import { cleanRelPath, type Mount } from '../mounts/model.js';
import type { Assistant, AiAction, Scope } from './assistant.js';
import type { Agent, AgentEvent } from './agent.js';
import type { Memory } from './memory.js';
import type { Author } from '../git/sync.js';
import type { ProviderKind, Providers } from './providers.js';
import { AiRuleError, type AiLevel, type AiRules } from './rules.js';
import { readRules, writeRules } from '../cleanup.js';
import { requestLang, translateMessage } from '../i18n/index.js';
import { publicError } from '../errors.js';

export interface AiRouteDeps {
  assistant: Assistant;
  agent: Agent;
  memory: Memory;
  author(req: FastifyRequest): Author;
  providers: Providers;
  rules: AiRules;
  settings: { get(key: string): string | null; set(key: string, value: string): void };
  requireAdmin(req: FastifyRequest): void;
  visibleMount(req: FastifyRequest, mountId: string): Mount;
  audit(req: FastifyRequest, action: string, message: string, mount?: Mount): void;
}

export function registerAi(server: FastifyInstance, d: AiRouteDeps) {
  const retention = () => readRules(d.settings).aiChatDays;

  // ── Providers ──────────────────────────────────────────────────────────────────
  server.get('/api/ai/providers', async (req) => {
    const list = d.providers.publicList();
    const defaultId = d.providers.defaultId();
    if (req.user!.isAdmin) return { providers: list, defaultId, retentionDays: retention() };
    return { providers: list.map((p) => ({ id: p.id, name: p.name, kind: p.kind, cloud: p.cloud, model: p.model })), defaultId, retentionDays: retention() };
  });

  server.put<{ Body: { id?: string; kind: ProviderKind; name?: string; baseUrl?: string; model?: string; cloud?: boolean; apiKey?: string | null } }>('/api/ai/providers', async (req) => {
    d.requireAdmin(req);
    const p = d.providers.save(req.body);
    d.audit(req, 'ai-provider-saved', `KI-Anbieter gespeichert: ${p.name} (${p.kind}, ${p.cloud ? 'Cloud' : 'lokal'}, Modell ${p.model || '–'})`);
    return p;
  });

  server.delete<{ Params: { id: string } }>('/api/ai/providers/:id', async (req) => {
    d.requireAdmin(req);
    const p = d.providers.get(req.params.id);
    d.providers.remove(req.params.id);
    if (p) d.audit(req, 'ai-provider-removed', `KI-Anbieter entfernt: ${p.name}`);
    return { ok: true };
  });

  server.put<{ Body: { defaultId?: string | null; retentionDays?: number } }>('/api/ai/settings', async (req) => {
    d.requireAdmin(req);
    if (req.body.defaultId !== undefined) d.providers.setDefault(req.body.defaultId || null);
    if (typeof req.body.retentionDays === 'number') writeRules(d.settings, { aiChatDays: req.body.retentionDays });
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>('/api/ai/providers/:id/models', async (req) => {
    d.requireAdmin(req);
    const p = d.providers.get(req.params.id);
    if (!p) throw new AiRuleError('Anbieter nicht gefunden');
    return { models: await d.providers.models(p) };
  });

  // ── Release rules (AD-011) ───────────────────────────────────────────────────────
  server.get<{ Querystring: { mountId?: string } }>('/api/ai/rules', async (req) => {
    d.requireAdmin(req);
    return req.query.mountId ? d.rules.rules(req.query.mountId) : d.rules.all();
  });

  server.get<{ Params: { mountId: string }; Querystring: { target?: Target; path?: string } }>('/api/ai/rule/:mountId', async (req) => {
    d.requireAdmin(req);
    const mount = d.visibleMount(req, req.params.mountId);
    const target = req.query.target ?? 'mount';
    const path = target === 'mount' ? '' : cleanRelPath(String(req.query.path ?? ''));
    return { rule: d.rules.ruleAt(mount.id, target, path), effective: d.rules.grant(mount.id, path, target !== 'note'), inherited: d.rules.inherited(mount.id, target, path) };
  });

  server.put<{ Params: { mountId: string }; Body: { target: Target; path?: string; level: AiLevel; cloud?: boolean } }>('/api/ai/rule/:mountId', async (req) => {
    d.requireAdmin(req);
    const mount = d.visibleMount(req, req.params.mountId);
    const path = req.body.target === 'mount' ? '' : cleanRelPath(String(req.body.path ?? ''));
    const rule = d.rules.set({ mountId: mount.id, target: req.body.target, path, level: req.body.level, cloud: req.body.cloud === true });
    const what = req.body.target === 'mount' ? 'ganze Quelle' : path;
    const label = { none: 'nicht freigegeben', read: 'nur lesen', suggest: 'freigegeben' }[rule.level];
    d.audit(req, 'ai-rule-set', `KI-Freigabe ${mount.name}: ${what} → ${label}${rule.level === 'none' ? '' : rule.cloud ? ' (auch Cloud)' : ' (nur eigenes Netz)'}`, mount);
    return rule;
  });

  server.delete<{ Params: { id: string } }>('/api/ai/rules/:id', async (req) => {
    d.requireAdmin(req);
    d.rules.remove(req.params.id);
    d.audit(req, 'ai-rule-removed', 'KI-Freigabe entfernt');
    return { ok: true };
  });

  // ── Using the assistant ──────────────────────────────────────────────────────────
  server.get<{ Params: { mountId: string; '*': string } }>('/api/ai/status/:mountId/*', async (req) => {
    const mount = d.visibleMount(req, req.params.mountId);
    return d.assistant.status(req, mount.id, req.params['*']);
  });

  server.post<{ Body: { action: AiAction; mountId: string; path: string; text?: string; instruction?: string; language?: string; providerId?: string } }>('/api/ai/transform', async (req) =>
    d.assistant.transform(req, req.body),
  );

  server.post<{ Body: { question: string; scope: Scope; chatId?: string; providerId?: string } }>('/api/ai/ask', async (req) => {
    d.assistant.prune(retention());
    return d.assistant.ask(req, req.body);
  });

  // The agent (AD-026): events as NDJSON lines while it works (steps, proposals, answer).
  server.post<{ Body: { question: string; scope: Scope; chatId?: string; providerId?: string } }>('/api/ai/agent', async (req, reply) => {
    d.assistant.prune(retention());
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    // The stream bypasses the onSend hook: step labels and errors in the interface's language here (AD-046).
    const lang = requestLang(req);
    const send = (e: AgentEvent | { type: 'error'; error: string; status: number }) => {
      const out = e.type === 'step' ? { ...e, label: translateMessage(lang, e.label) } : e.type === 'error' ? { ...e, error: translateMessage(lang, e.error) } : e;
      reply.raw.write(`${JSON.stringify(out)}\n`);
    };
    try {
      await d.agent.run(req, req.body, send);
    } catch (e) {
      // Internal texts stay in the log (audit sec2-003).
      const pub = publicError(e);
      if (!pub) req.log.error(e);
      send({ type: 'error', error: pub?.message ?? 'Interner Fehler', status: pub?.status ?? 500 });
    }
    reply.raw.end();
  });

  server.get('/api/ai/chats', async (req) => d.assistant.chats(req));

  server.get<{ Params: { id: string } }>('/api/ai/chats/:id', async (req, reply) => {
    const chat = d.assistant.chat(req, req.params.id);
    return chat ? { ...chat, proposals: d.agent.proposals(req, chat.id) } : reply.code(404).send({ error: 'Nicht gefunden' });
  });

  server.get<{ Params: { id: string } }>('/api/ai/proposals/:id/preview', async (req) => d.agent.preview(req, req.params.id));
  server.post<{ Params: { id: string } }>('/api/ai/proposals/:id/apply', async (req) => d.agent.apply(req, req.params.id));
  server.post<{ Params: { id: string } }>('/api/ai/proposals/:id/reject', async (req) => d.agent.reject(req, req.params.id));

  // ── Memory per source (admins): `.kaveyl-wiki/ai/` ─────────────────────────────────────
  server.get<{ Params: { mountId: string } }>('/api/ai/memory/:mountId', async (req) => {
    d.requireAdmin(req);
    return d.memory.get(d.visibleMount(req, req.params.mountId));
  });

  server.put<{ Params: { mountId: string }; Body: { instructions?: string; memory?: string } }>('/api/ai/memory/:mountId', async (req) => {
    d.requireAdmin(req);
    const mount = d.visibleMount(req, req.params.mountId);
    if (!d.memory.enabled(mount)) throw new AiRuleError('Das KI-Gedächtnis ist für diese Quelle abgeschaltet (Quelle bearbeiten).');
    const changed = await d.memory.save(mount, { instructions: req.body.instructions, memory: req.body.memory }, d.author(req));
    if (changed.length) d.audit(req, 'ai-memory-saved', `KI-Gedächtnis gespeichert: ${changed.join(', ')}`, mount);
    return d.memory.get(mount);
  });

  // `all` with `?hours=24`: only the chats of the last 24 hours (like a browser history).
  server.delete<{ Params: { id: string }; Querystring: { hours?: string } }>('/api/ai/chats/:id', async (req) => {
    const hours = Math.max(0, Number(req.query.hours) || 0);
    const deleted = d.assistant.deleteChat(req, req.params.id === 'all' ? 'all' : req.params.id, hours);
    return { ok: true, deleted };
  });
}
