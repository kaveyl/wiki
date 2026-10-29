// AI providers (PLAN §3c, AD-024): two wire protocols cover all kinds —
// OpenAI-compatible chat completions (Ollama, Ollama Cloud, OpenRouter, LM Studio, vLLM …) and the Anthropic
// Messages API. Configuration lives in `settings.ai_providers` (JSON, without keys); API keys
// are in the encrypted SecretStore and never leave the server.
import { ulid } from 'ulid';
import type { SecretStore } from '../secrets.js';

export type ProviderKind = 'ollama' | 'ollama-cloud' | 'anthropic' | 'openrouter' | 'openai';
export const PROVIDER_KINDS: ProviderKind[] = ['ollama', 'ollama-cloud', 'anthropic', 'openrouter', 'openai'];
/** Kinds that always send data off the server and always need an API key. */
const ALWAYS_CLOUD: ProviderKind[] = ['ollama-cloud', 'anthropic', 'openrouter'];

/** Inside the own network: localhost, private IP ranges, `.local`, single-label names (Docker services). */
export function isLocalAddress(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return !host.includes('.');
}

/** Ollama's cloud models (e.g. `gpt-oss:120b-cloud`): a local Ollama forwards them to ollama.com. */
export const isCloudModel = (model: string) => /(^|[-:])cloud$/i.test(model.trim());

/**
 * Whether data leaves the server (AD-028). Fixed for cloud services; for Ollama and
 * OpenAI-compatible servers derived from the address (and for Ollama the model) — never a
 * free choice, so a cloud endpoint cannot be marked local by mistake.
 */
export function isCloud(p: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model'>): boolean {
  if (ALWAYS_CLOUD.includes(p.kind)) return true;
  if (!isLocalAddress(p.baseUrl)) return true;
  return p.kind === 'ollama' && isCloudModel(p.model);
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  /** Data leaves the server (cloud) — only notes released for cloud providers may be sent. */
  cloud: boolean;
  secretId: string | null;
}

/** What the browser sees: no key, only whether one is set. */
export type PublicProvider = Omit<ProviderConfig, 'secretId'> & { hasKey: boolean };

export const DEFAULTS: Record<ProviderKind, { baseUrl: string; model: string; cloud: boolean }> = {
  ollama: { baseUrl: 'http://ollama:11434', model: 'llama3.1', cloud: false },
  'ollama-cloud': { baseUrl: 'https://ollama.com', model: 'gpt-oss:120b', cloud: true },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', cloud: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-5.5', cloud: true },
  openai: { baseUrl: 'http://localhost:1234', model: '', cloud: false },
};

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
/** The model cannot call tools: the agent falls back to the plain search answer (AD-026). */
export class ToolsUnsupportedError extends AiProviderError {}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * Typographic characters some models (e.g. gpt-oss) write everywhere: non-breaking and other
 * hyphens, narrow/no-break and zero-width spaces. In plain Markdown files they break search ("Eis‑Angebot"
 * does not match "Eis-Angebot") and diffs, so they become their plain counterparts. gpt-oss also
 * cites in its own format („【2†L1-L9】“, „【2】“, „[Quelle [2]]“): that becomes the [2] the sources list uses.
 */
export function plainText(s: string): string {
  return s
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[\u200b\u2060\ufeff]/g, '')
    .replace(/【(\d+)(?:†[^】]*)?】/g, '[$1]')
    .replace(/\[Quellen?:? ?((?:\[\d{1,2}\][,; ]*)+)\]/g, (_m, refs: string) => refs.replace(/[,; ]+/g, ''))
    // „```[1]“ is no closing fence any more: the citation goes below the code block.
    .replace(/^([ \t]*```)((?:\[\d{1,2}\])+)[ \t]*$/gm, '$1\n\n$2');
}

const plainArgs = (v: unknown): unknown =>
  typeof v === 'string' ? plainText(v) : Array.isArray(v) ? v.map(plainArgs) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainArgs(x)])) : v;

export interface ChatResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** A tool the agent offers the model (JSON schema of the arguments). */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Messages of an agent run, independent of the wire protocol. */
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolChatResult extends ChatResult {
  toolCalls: ToolCall[];
}

interface SettingsLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Base URL of the OpenAI-compatible API: Ollama and others serve it under /v1. */
const openaiBase = (p: ProviderConfig) => {
  const b = trimSlash(p.baseUrl);
  return /\/v1$/.test(b) ? b : `${b}/v1`;
};

export class Providers {
  constructor(
    private readonly settings: SettingsLike,
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  list(): ProviderConfig[] {
    let list: ProviderConfig[];
    try {
      list = JSON.parse(this.settings.get('ai_providers') ?? '[]') as ProviderConfig[];
    } catch {
      return [];
    }
    // Always derived, also for providers saved before AD-028.
    return list.map((p) => ({ ...p, cloud: isCloud(p) }));
  }

  publicList(): PublicProvider[] {
    return this.list().map(({ secretId, ...p }) => ({ ...p, hasKey: !!secretId }));
  }

  get(id: string): ProviderConfig | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  defaultId(): string | null {
    const id = this.settings.get('ai_default_provider');
    return id && this.get(id) ? id : (this.list()[0]?.id ?? null);
  }

  setDefault(id: string | null) {
    if (id && !this.get(id)) throw new AiProviderError('Anbieter nicht gefunden');
    this.settings.set('ai_default_provider', id ?? '');
  }

  /** Creates or updates; `apiKey: ''` keeps the stored key, `null` removes it. `cloud` is derived (AD-028). */
  save(input: Partial<Omit<ProviderConfig, 'secretId' | 'cloud'>> & { kind: ProviderKind; apiKey?: string | null; cloud?: unknown }): PublicProvider {
    if (!PROVIDER_KINDS.includes(input.kind)) throw new AiProviderError('Unbekannter Anbieter-Typ');
    const list = this.list();
    const existing = input.id ? list.find((p) => p.id === input.id) : undefined;
    if (input.id && !existing) throw new AiProviderError('Anbieter nicht gefunden');
    const d = DEFAULTS[input.kind];
    const baseUrl = trimSlash(String(input.baseUrl ?? existing?.baseUrl ?? d.baseUrl).trim());
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new AiProviderError('Adresse ist keine gültige URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AiProviderError('Nur http(s)-Adressen ohne Zugangsdaten in der URL');
    // Ollama's own cloud behind the "local" kind would send notes released only for local
    // providers off the server: it is always a cloud provider.
    const kind: ProviderKind = input.kind === 'ollama' && /(^|\.)ollama\.com$/i.test(url.hostname) ? 'ollama-cloud' : input.kind;
    const p: ProviderConfig = {
      id: existing?.id ?? ulid(),
      kind,
      name: String(input.name ?? existing?.name ?? kind).trim().slice(0, 80) || kind,
      baseUrl,
      model: String(input.model ?? existing?.model ?? d.model).trim().slice(0, 200),
      cloud: false,
      secretId: existing?.secretId ?? null,
    };
    p.cloud = isCloud(p);
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) p.secretId = this.secrets.put(input.apiKey.trim(), p.secretId ?? undefined);
    if (input.apiKey === null && p.secretId) {
      this.secrets.delete(p.secretId);
      p.secretId = null;
    }
    this.settings.set('ai_providers', JSON.stringify(existing ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
    const { secretId, ...pub } = p;
    return { ...pub, hasKey: !!secretId };
  }

  remove(id: string) {
    const p = this.get(id);
    if (!p) return;
    if (p.secretId) this.secrets.delete(p.secretId);
    this.settings.set('ai_providers', JSON.stringify(this.list().filter((x) => x.id !== id)));
    if (this.settings.get('ai_default_provider') === id) this.settings.set('ai_default_provider', '');
  }

  private key(p: ProviderConfig): string | null {
    return p.secretId ? this.secrets.get(p.secretId) : null;
  }

  private async call(url: string, init: RequestInit, timeoutMs = 120_000): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new AiProviderError(`Anbieter nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string };
        msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? msg);
      } catch {
        // keep the raw text
      }
      throw new AiProviderError(`Anbieter antwortet ${res.status}: ${msg}`, res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AiProviderError('Anbieter liefert kein JSON');
    }
  }

  /**
   * Like call(), but reads a Server-Sent-Events answer line by line into `onSse` (then returns
   * undefined). Providers that answer with plain JSON despite `stream: true` still work.
   */
  private async callStream(url: string, init: RequestInit, onSse: (data: string, event: string | null) => void, timeoutMs = 180_000): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new AiProviderError(`Anbieter nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok || !/text\/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) {
      const text = await res.text();
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { error?: { message?: string } | string };
          msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? msg);
        } catch {
          // keep the raw text
        }
        throw new AiProviderError(`Anbieter antwortet ${res.status}: ${msg}`, res.status);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new AiProviderError('Anbieter liefert kein JSON');
      }
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let event: string | null = null;
    const line = (l: string) => {
      if (l.startsWith('event:')) event = l.slice(6).trim();
      else if (l.startsWith('data:')) onSse(l.slice(5).trim(), event);
      else if (!l.trim()) event = null;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
      if (done) break;
    }
    if (buf) line(buf);
    return undefined;
  }

  /** One chat turn (no streaming). */
  async chat(p: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
    const res = await this.chatRaw(p, req);
    return { ...res, text: plainText(res.text) };
  }

  private async chatRaw(p: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
    if (!p.model) throw new AiProviderError(`Für „${p.name}“ ist kein Modell eingestellt`);
    const key = this.key(p);
    if (p.kind === 'anthropic') {
      if (!key) throw new AiProviderError('Für Anthropic fehlt der API-Key');
      const j = (await this.call(`${trimSlash(p.baseUrl)}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: p.model, system: req.system, messages: req.messages, max_tokens: req.maxTokens ?? 2048, temperature: req.temperature ?? 0.3 }),
      })) as { content?: { type: string; text?: string }[]; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      return {
        text: (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
        model: j.model ?? p.model,
        inputTokens: j.usage?.input_tokens,
        outputTokens: j.usage?.output_tokens,
      };
    }
    if ((p.kind === 'openrouter' || p.kind === 'ollama-cloud' || (p.kind === 'openai' && p.cloud)) && !key) throw new AiProviderError(`Für „${p.name}“ fehlt der API-Key`);
    const j = (await this.call(`${openaiBase(p)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(p.kind === 'openrouter' ? { 'x-title': 'Kaveyl Wiki' } : {}) },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.3,
        stream: false,
      }),
    })) as { choices?: { message?: { content?: string } }[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { text: j.choices?.[0]?.message?.content ?? '', model: j.model ?? p.model, inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens };
  }

  /**
   * One step of an agent run: the model answers with text, tool calls or both. Models that
   * cannot call tools are reported as ToolsUnsupportedError.
   */
  async chatTools(
    p: ProviderConfig,
    req: { system: string; messages: AgentMessage[]; tools: ToolDef[]; maxTokens?: number; onText?: (delta: string) => void },
  ): Promise<ToolChatResult> {
    const res = await this.chatToolsRaw(p, req);
    return { ...res, text: plainText(res.text), toolCalls: res.toolCalls.map((c) => ({ ...c, args: plainArgs(c.args) as Record<string, unknown> })) };
  }

  private async chatToolsRaw(
    p: ProviderConfig,
    req: { system: string; messages: AgentMessage[]; tools: ToolDef[]; maxTokens?: number; onText?: (delta: string) => void },
  ): Promise<ToolChatResult> {
    if (!p.model) throw new AiProviderError(`Für „${p.name}“ ist kein Modell eingestellt`);
    const key = this.key(p);
    const unsupported = (e: unknown): never => {
      if (e instanceof AiProviderError && (e.status === 400 || e.status === 404 || e.status === 422) && /tool|function/i.test(e.message)) {
        throw new ToolsUnsupportedError(`Das Modell ${p.model} kann keine Werkzeuge aufrufen`, e.status);
      }
      throw e;
    };
    if (p.kind === 'anthropic') {
      if (!key) throw new AiProviderError('Für Anthropic fehlt der API-Key');
      const messages: { role: 'user' | 'assistant'; content: unknown }[] = [];
      for (const m of req.messages) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') {
          const blocks: unknown[] = m.content ? [{ type: 'text', text: m.content }] : [];
          for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
          messages.push({ role: 'assistant', content: blocks });
        } else {
          // Tool results go back as one user turn (consecutive results are merged).
          const result = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
          const last = messages.at(-1);
          if (last?.role === 'user' && Array.isArray(last.content)) (last.content as unknown[]).push(result);
          else messages.push({ role: 'user', content: [result] });
        }
      }
      type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; json?: string };
      const streamed: { blocks: Block[]; model?: string; usage: { input_tokens?: number; output_tokens?: number } } = { blocks: [], usage: {} };
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: p.model,
          system: req.system,
          messages,
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          max_tokens: req.maxTokens ?? 4096,
          temperature: 0.1,
          ...(req.onText ? { stream: true } : {}),
        }),
      };
      const url = `${trimSlash(p.baseUrl)}/v1/messages`;
      const raw = req.onText
        ? await this.callStream(url, init, (data) => {
            let e: { type?: string; index?: number; message?: { model?: string; usage?: { input_tokens?: number } }; content_block?: Block; delta?: { type?: string; text?: string; partial_json?: string }; usage?: { output_tokens?: number } };
            try {
              e = JSON.parse(data);
            } catch {
              return;
            }
            if (e.type === 'message_start') {
              streamed.model = e.message?.model;
              streamed.usage.input_tokens = e.message?.usage?.input_tokens;
            } else if (e.type === 'content_block_start' && e.content_block) streamed.blocks[e.index ?? streamed.blocks.length] = { ...e.content_block, json: '' };
            else if (e.type === 'content_block_delta') {
              const b = streamed.blocks[e.index ?? 0];
              if (!b) return;
              if (e.delta?.type === 'text_delta' && e.delta.text) {
                b.text = (b.text ?? '') + e.delta.text;
                req.onText!(e.delta.text);
              } else if (e.delta?.type === 'input_json_delta') b.json = (b.json ?? '') + (e.delta.partial_json ?? '');
            } else if (e.type === 'message_delta') streamed.usage.output_tokens = e.usage?.output_tokens;
          }).catch(unsupported)
        : await this.call(url, init).catch(unsupported);
      if (raw === undefined) {
        for (const b of streamed.blocks) {
          if (b?.type === 'tool_use') {
            try {
              b.input = b.json ? (JSON.parse(b.json) as Record<string, unknown>) : (b.input ?? {});
            } catch {
              b.input = {};
            }
          }
        }
      }
      const j = (raw === undefined ? { content: streamed.blocks.filter(Boolean), model: streamed.model, usage: streamed.usage } : raw) as {
        content?: Block[];
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const content = j.content ?? [];
      return {
        text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
        toolCalls: content.filter((c) => c.type === 'tool_use').map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name ?? '', args: c.input ?? {} })),
        model: j.model ?? p.model,
        inputTokens: j.usage?.input_tokens,
        outputTokens: j.usage?.output_tokens,
      };
    }
    if ((p.kind === 'openrouter' || p.kind === 'ollama-cloud' || (p.kind === 'openai' && p.cloud)) && !key) throw new AiProviderError(`Für „${p.name}“ fehlt der API-Key`);
    const messages = [
      { role: 'system', content: req.system },
      ...req.messages.map((m) =>
        m.role === 'tool'
          ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
          : m.role === 'assistant' && m.toolCalls?.length
            ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
            : { role: m.role, content: m.content },
      ),
    ];
    type OaiCall = { index?: number; id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } };
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(p.kind === 'openrouter' ? { 'x-title': 'Kaveyl Wiki' } : {}) },
      body: JSON.stringify({
        model: p.model,
        messages,
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        max_tokens: req.maxTokens ?? 4096,
        temperature: 0.1,
        stream: !!req.onText,
      }),
    };
    const url = `${openaiBase(p)}/chat/completions`;
    const acc: { text: string; calls: { id: string; name: string; args: string }[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } } = { text: '', calls: [] };
    const raw = req.onText
      ? await this.callStream(url, init, (data) => {
          if (data === '[DONE]') return;
          let c: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { delta?: { content?: string | null; tool_calls?: OaiCall[] } }[] };
          try {
            c = JSON.parse(data);
          } catch {
            return;
          }
          acc.model = c.model ?? acc.model;
          if (c.usage) acc.usage = c.usage;
          const delta = c.choices?.[0]?.delta;
          if (delta?.content) {
            acc.text += delta.content;
            req.onText!(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const i = tc.index ?? acc.calls.length;
            const cur = (acc.calls[i] ??= { id: '', name: '', args: '' });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            const a = tc.function?.arguments;
            if (a) cur.args += typeof a === 'string' ? a : JSON.stringify(a);
          }
        }).catch(unsupported)
      : await this.call(url, init).catch(unsupported);
    const j = (
      raw === undefined
        ? {
            model: acc.model,
            usage: acc.usage,
            choices: [{ message: { content: acc.text, tool_calls: acc.calls.filter(Boolean).map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })) } }],
          }
        : raw
    ) as {
      choices?: { message?: { content?: string | null; tool_calls?: OaiCall[] } }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = j.choices?.[0]?.message ?? {};
    const parse = (a: string | Record<string, unknown> | undefined): Record<string, unknown> => {
      if (!a) return {};
      if (typeof a === 'object') return a;
      try {
        const v = JSON.parse(a) as unknown;
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };
    return {
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((c, i) => ({ id: c.id || `call_${i}`, name: c.function?.name ?? '', args: parse(c.function?.arguments) })),
      model: j.model ?? p.model,
      inputTokens: j.usage?.prompt_tokens,
      outputTokens: j.usage?.completion_tokens,
    };
  }

  /** Connection test: the provider's model list (also helps picking a model). */
  async models(p: ProviderConfig): Promise<string[]> {
    const key = this.key(p);
    if (p.kind === 'anthropic') {
      if (!key) throw new AiProviderError('Für Anthropic fehlt der API-Key');
      const j = (await this.call(`${trimSlash(p.baseUrl)}/v1/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, 15_000)) as { data?: { id: string }[] };
      return (j.data ?? []).map((m) => m.id);
    }
    if (p.kind === 'ollama-cloud') {
      // Ollama's documented list of cloud models (the OpenAI-style list is not guaranteed there).
      if (!key) throw new AiProviderError('Für Ollama Cloud fehlt der API-Key (ollama.com → Settings → Keys)');
      const j = (await this.call(`${trimSlash(p.baseUrl)}/api/tags`, { headers: { authorization: `Bearer ${key}` } }, 15_000)) as { models?: { name?: string; model?: string }[] };
      return (j.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean).sort();
    }
    const j = (await this.call(`${openaiBase(p)}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} }, 15_000)) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id).sort();
  }
}
