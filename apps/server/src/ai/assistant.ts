// AI assistant (PLAN §3c, AD-011, AD-024): editor actions on a selection or note and
// „Frag die Wissensbasis“ (answers from the user's released notes, with numbered sources).
// Every note that goes to a provider passes four gates: the user may read it (ACL), an AI
// release rule allows it (and allows cloud if the provider is a cloud one), no `ai: false` in
// its frontmatter, not encrypted. Every request is audited with provider, model and the notes
// (path + hash). Results are only ever suggestions — the browser shows them for confirmation.
import type { FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import { now, type DB } from '../db/db.js';
import type { MountManager } from '../mounts/manager.js';
import { cleanRelPath, type Mount } from '../mounts/model.js';
import { isEncryptedNote } from '../notes/encryption.js';
import type { NoteService } from '../notes/service.js';
import { AiProviderError, type ChatMessage, type ProviderConfig, type Providers } from './providers.js';
import type { AiLevel, AiRules } from './rules.js';

export class AiAccessError extends Error {}

/**
 * Answers from notes must not add anything (Owner 2026-10-08, after "Ideen für 2027" came back
 * embellished: "dafür bräuchten wir eine eigene Backstube" became "Einführung einer Backstube").
 */
export const GROUNDING =
  'Halte dich streng an die Notizen: Gib nur wieder, was dort ausdrücklich steht, möglichst nah am Wortlaut. Ergänze, deute oder verallgemeinere nichts – Ideen bleiben Ideen, Fragen bleiben Fragen, Bedingungen bleiben Bedingungen (aus „dafür bräuchten wir …“ wird kein „wird eingeführt“), Vorschläge sind keine Beschlüsse. Keine Beispiele, Begründungen, Zahlen oder Details, die nicht in den Notizen stehen. Ideen, Wünsche, Bedingungen und Begründungen zitierst du wörtlich in Anführungszeichen statt sie umzuformulieren. Zieh keine eigenen Schlüsse (aus „seit 20.09. abgeschaltet“ wird kein „das Problem tritt nicht mehr auf“). Enthält die Frage eine Annahme, die die Notizen nicht stützen, sag das ausdrücklich. Eigene Einschätzungen nur, wenn ausdrücklich danach gefragt, und dann als „Einschätzung:“ gekennzeichnet.';

export const ACTIONS = ['rewrite', 'shorten', 'expand', 'grammar', 'translate', 'summarize', 'continue', 'custom'] as const;
export type AiAction = (typeof ACTIONS)[number];

export type Scope =
  | { kind: 'note'; mountId: string; path: string }
  | { kind: 'folder'; mountId: string; path: string }
  | { kind: 'source'; mountId: string }
  | { kind: 'all' }
  | { kind: 'general' };

export interface Source {
  n: number;
  mountId: string;
  path: string;
  title: string;
}

export interface AssistantDeps {
  db: DB;
  manager: MountManager;
  notes: NoteService;
  providers: Providers;
  rules: AiRules;
  canRead(req: FastifyRequest, mountId: string, path: string, isDir?: boolean): boolean;
  visibleMount(req: FastifyRequest, mountId: string): Mount;
  audit(req: FastifyRequest, action: string, message: string, detail: Record<string, unknown>): void;
}

const MAX_NOTE_CHARS = 6000;
const MAX_SOURCES = 6;
const STOP = new Set(
  'der die das und oder aber ein eine einer eines einem einen ist sind war wie was wer wo wann warum welche welcher welches mit für von zu zum zur im in am an auf aus bei nach über unter vor nicht kein keine ich du er sie es wir ihr mein dein unser euer gibt gib hat haben habe wird werden kann können soll sollen muss müssen auch noch nur schon dass dies diese dieser dieses the a an and or of to in on for with is are was what how why which who when where do does can'.split(
    ' ',
  ),
);

const PROMPTS: Record<Exclude<AiAction, 'custom'>, string> = {
  rewrite: 'Formuliere den Text klarer und flüssiger um. Inhalt, Ton und Sprache bleiben gleich.',
  shorten: 'Kürze den Text deutlich, ohne wichtige Aussagen zu verlieren.',
  expand: 'Baue den Text etwas aus: ergänze Erklärungen und Übergänge, erfinde keine Fakten.',
  grammar: 'Korrigiere nur Rechtschreibung, Grammatik und Zeichensetzung. Ändere sonst nichts.',
  translate: 'Übersetze den Text in die angegebene Zielsprache.',
  summarize:
    'Fasse den Text knapp zusammen: höchstens etwa acht kurze Stichpunkte (je eine Zeile) mit den wichtigsten Aussagen, bei kurzen Texten weniger. Übernimm keine Code-Blöcke oder Tabellen, sondern beschreib in einem Satz, was der Code tut bzw. was die Tabelle zeigt. Gib den Stand genau wieder: Geplantes, Angefragtes, Offenes und nicht Entschiedenes bleibt als solches gekennzeichnet, nichts wird zur Tatsache. Lass nichts weg, was offen oder ungeklärt ist. Schreib in der Sprache des Textes.',
  continue:
    'Schreibe den Text an seinem Ende weiter (höchstens drei kurze Absätze oder einige Listenpunkte), im selben Stil, in derselben Sprache und Form (Liste, Brief, Anleitung …). Bricht der Text mitten im Satz oder nach einer Aufzählungsnummer ab, beginnst du genau mit den fehlenden Worten – ohne das letzte Wort oder die Nummer zu wiederholen (endet der Text mit „interessant, aber“, beginnt die Ausgabe z. B. mit „wir möchten …“). Erfinde keine Fakten: keine Namen, Daten, Uhrzeiten, Zahlen, Preise, Produkte, Angebote, Regeln, Zusagen oder Entscheidungen, die nicht schon im Text stehen, und nichts, was dem Text widerspricht. Was nicht aus dem Text hervorgeht (z. B. eine weitere Neuigkeit, ein weiteres Produkt, eine weitere Regel), schreibst du nicht aus, sondern als Platzhalter, z. B. „**3.** [Neuigkeit: …]“. Offene Punkte bleiben offen. Wo eine solche Angabe nötig wäre, setze einen kurzen Platzhalter in eckigen Klammern, z. B. [Datum] oder [Neuigkeit] – lieber ein Platzhalter mehr als eine erfundene Angabe. Gib nur die Fortsetzung aus.',
};

/**
 * A continuation that repeats the last words of the text („aber“ → „aber wir …“, „**3.**“ → „**3. Neu …**“)
 * loses them again; emphasis markers stay balanced.
 */
export function dropRepeat(text: string, out: string): string {
  const last = (text.trimEnd().split('\n').at(-1) ?? '').replace(/[*_`]/g, '').replace(/^\s*(?:[-+>]|\d+[.)])\s+/, '').trim();
  // Only an unfinished sentence or a bare „3.“ can be repeated by mistake.
  if (!/[\p{L}\p{N},]$/u.test(last) && !/^\d+[.)]$/.test(last)) return out;
  const words = last.split(/\s+/).filter(Boolean);
  for (let k = Math.min(words.length, 8); k > 0; k--) {
    const esc = words.slice(-k).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`^([*_]*)\\s*${esc.join('[\\s*_]+')}([*_]*)(?=\\s|$)\\s*`, 'u');
    // „**3.** Neu“: the emphasis closes with the repeated words, so both markers go.
    if (re.test(out)) return out.replace(re, (_m, open: string, close: string) => (close.length >= open.length ? '' : open));
  }
  return out;
}

/**
 * The sources an answer actually cites ([n]), in their numbering; all of them when it cites none
 * (then they are what was searched). Six sources under a one-line answer are mostly noise.
 */
export function citedSources(answer: string, sources: Source[]): Source[] {
  const cited = new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  const used = sources.filter((s) => cited.has(s.n));
  return used.length ? used : sources;
}

export function createAssistant(d: AssistantDeps) {
  const personal = (req: FastifyRequest): { providerId?: string; instructions?: string } => {
    const row = d.db.prepare("SELECT value_json FROM user_state WHERE user_id = ? AND key = 'ai'").get(req.user!.id) as { value_json: string } | undefined;
    try {
      return row ? (JSON.parse(row.value_json) ?? {}) : {};
    } catch {
      return {};
    }
  };

  const providerFor = (req: FastifyRequest, id?: string): ProviderConfig => {
    const wanted = id || personal(req).providerId || d.providers.defaultId();
    const p = wanted ? d.providers.get(wanted) : null;
    if (!p) throw new AiProviderError('Kein KI-Anbieter eingerichtet (Einstellungen → KI)');
    return p;
  };

  const rank = (l: AiLevel) => ['none', 'read', 'suggest'].indexOf(l);

  /** Why a note may not go to this provider, or null when it may. */
  const blocked = (req: FastifyRequest, p: ProviderConfig, mountId: string, path: string, need: AiLevel): string | null => {
    if (!d.canRead(req, mountId, path)) return 'keine Berechtigung';
    const g = d.rules.grant(mountId, path);
    if (rank(g.level) < rank(need)) return need === 'suggest' && g.level === 'read' ? 'für die KI nur zum Lesen freigegeben' : 'nicht für die KI freigegeben';
    if (p.cloud && !g.cloud) return 'nur für lokale KI-Anbieter freigegeben';
    return null;
  };

  /** Reads a note for the AI, or throws with the reason. */
  const noteFor = async (req: FastifyRequest, p: ProviderConfig, mountId: string, path: string, need: AiLevel) => {
    const mount = d.visibleMount(req, mountId);
    const why = blocked(req, p, mount.id, cleanRelPath(path), need);
    if (why) throw new AiAccessError(`Diese Notiz ist ${why}.`);
    const note = await d.notes.read(mount, path);
    if (note.frontmatter.ai === false) throw new AiAccessError('Diese Notiz ist mit „ai: false“ für die KI gesperrt.');
    if (isEncryptedNote(note.raw)) throw new AiAccessError('Verschlüsselte Notizen sind für die KI tabu.');
    return { mount, note };
  };

  const system = (req: FastifyRequest, task: string) => {
    const own = personal(req).instructions?.trim();
    return [
      'Du bist der Schreib- und Wissensassistent von Kaveyl Wiki, einem Wiki aus Markdown-Dateien in Git.',
      task,
      'Antworte in Markdown, ohne Einleitung oder Schlussformel.',
      own ? `Persönliche Anweisungen des Benutzers:\n${own}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  };

  const auditCall = (req: FastifyRequest, p: ProviderConfig, model: string, what: string, notes: { mountId: string; path: string; hash: string }[], extra: Record<string, unknown> = {}) =>
    d.audit(req, 'ai-request', `KI (${p.name}, ${model}): ${what}${notes.length ? ` – ${notes.length} Notiz${notes.length === 1 ? '' : 'en'}` : ''}`, {
      provider: p.name,
      kind: p.kind,
      cloud: p.cloud,
      model,
      // The note's state as `version`: the log drops every key that looks like a secret, `hash` included.
      notes: notes.map((n) => ({ mountId: n.mountId, path: n.path, version: n.hash })),
      ...extra,
    });

  /** Candidate notes for a question: ranked by full-text match (any word), inside the scope. */
  const candidates = (req: FastifyRequest, p: ProviderConfig, scope: Scope, question: string): { mountId: string; path: string }[] => {
    const mounts = d.manager.list().filter((m) => !m.paused && d.rules.anyReleased(m.id));
    const inScope =
      scope.kind === 'all'
        ? mounts.map((m) => m.id)
        : scope.kind === 'source' || scope.kind === 'folder'
          ? mounts.filter((m) => m.id === scope.mountId).map((m) => m.id)
          : [];
    if (!inScope.length) return [];
    const words = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 12);
    const prefix = scope.kind === 'folder' ? cleanRelPath(scope.path) + '/' : '';
    const ok = (r: { mount_id: string; entry_path: string }) =>
      (!prefix || r.entry_path.startsWith(prefix)) && /\.md$/i.test(r.entry_path) && !blocked(req, p, r.mount_id, r.entry_path, 'read');
    const marks = inScope.map(() => '?').join(',');
    let rows: { mount_id: string; entry_path: string }[] = [];
    if (words.length) {
      const match = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' OR ');
      rows = d.db.prepare(`SELECT mount_id, entry_path FROM entries_fts WHERE entries_fts MATCH ? AND mount_id IN (${marks}) ORDER BY rank LIMIT 200`).all(match, ...inScope) as typeof rows;
    }
    let hits = rows.filter(ok);
    // Few or no matches (a vague question like „Was ist noch offen?“ in a folder): fill up with the
    // newest notes of the folder or source; the answer cites what it uses, the rest is not shown.
    if (hits.length < MAX_SOURCES && scope.kind !== 'all') {
      rows = d.db.prepare(`SELECT mount_id, path AS entry_path FROM entries WHERE kind = 'file' AND mount_id IN (${marks}) ORDER BY mtime DESC LIMIT 200`).all(...inScope) as typeof rows;
      const seen = new Set(hits.map((h) => `${h.mount_id}/${h.entry_path}`));
      hits = [...hits, ...rows.filter((r) => ok(r) && !seen.has(`${r.mount_id}/${r.entry_path}`))];
    }
    return hits.slice(0, MAX_SOURCES).map((r) => ({ mountId: r.mount_id, path: r.entry_path }));
  };

  return {
    personal,
    /** The same gates for the agent (AD-026): one place decides what the AI may see and do. */
    core: { providerFor, blocked, noteFor, system, auditCall },

    /** Which AI level/cloud flag applies here, and whether the current provider may use it (for the UI). */
    status(req: FastifyRequest, mountId: string, path: string) {
      const providers = d.providers.publicList();
      let provider: ProviderConfig | null = null;
      try {
        provider = providerFor(req);
      } catch {
        provider = null;
      }
      const grant = d.rules.grant(mountId, cleanRelPath(path), !/\.md$/i.test(path));
      return {
        configured: providers.length > 0,
        provider: provider ? { id: provider.id, name: provider.name, cloud: provider.cloud } : null,
        grant,
        read: provider ? !blocked(req, provider, mountId, cleanRelPath(path), 'read') : false,
        suggest: provider ? !blocked(req, provider, mountId, cleanRelPath(path), 'suggest') : false,
      };
    },

    /** Editor action on the selection (or the whole note): returns a suggestion, never writes. */
    async transform(req: FastifyRequest, input: { action: AiAction; mountId: string; path: string; text?: string; instruction?: string; language?: string; providerId?: string }) {
      if (!(ACTIONS as readonly string[]).includes(input.action)) throw new AiAccessError('Unbekannte Aktion');
      const p = providerFor(req, input.providerId);
      const need: AiLevel = input.action === 'summarize' ? 'read' : 'suggest';
      const { mount, note } = await noteFor(req, p, input.mountId, input.path, need);
      const text = (input.text?.trim() ? input.text : note.raw).slice(0, 40_000);
      let task: string;
      if (input.action === 'custom') {
        const instruction = input.instruction?.trim();
        if (!instruction) throw new AiAccessError('Anweisung fehlt');
        task = `Bearbeite den Text nach dieser Anweisung: ${instruction}\nGib nur das Ergebnis aus.`;
      } else if (input.action === 'translate') {
        task = `${PROMPTS.translate} Zielsprache: ${input.language?.trim() || 'Englisch'}. Gib nur die Übersetzung aus.`;
      } else task = `${PROMPTS[input.action]} Gib nur das Ergebnis aus.`;
      const res = await d.providers.chat(p, { system: system(req, task), messages: [{ role: 'user', content: text }], temperature: input.action === 'custom' ? 0.3 : 0.1 });
      auditCall(req, p, res.model, `Aktion „${input.action}“`, [{ mountId: mount.id, path: note.path, hash: note.hash }]);
      let out = res.text.trim();
      if (input.action === 'continue') out = dropRepeat(text, out);
      // A single paragraph stays one paragraph (models like to add hard line breaks "  \n").
      if (input.text?.trim() && !input.text.trim().includes('\n') && input.action !== 'expand' && input.action !== 'continue' && input.action !== 'summarize') {
        out = out.replace(/ *\n+ */g, ' ');
      }
      return { text: out, provider: p.name, model: res.model };
    },

    /** „Frag die Wissensbasis“: answer with numbered sources; kept as a chat of the user. */
    async ask(req: FastifyRequest, input: { question: string; scope: Scope; chatId?: string; providerId?: string }) {
      const question = String(input.question ?? '').trim().slice(0, 4000);
      if (!question) throw new AiAccessError('Frage fehlt');
      const p = providerFor(req, input.providerId);
      const scope = input.scope ?? { kind: 'all' };
      if (!['note', 'folder', 'source', 'all', 'general'].includes(scope.kind)) throw new AiAccessError('Unbekannter Bezug');

      let chat = input.chatId ? (d.db.prepare('SELECT id FROM ai_chats WHERE id = ? AND user_id = ?').get(input.chatId, req.user!.id) as { id: string } | undefined) : undefined;
      const history: ChatMessage[] = chat
        ? (d.db.prepare('SELECT role, content FROM ai_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 8').all(chat.id) as ChatMessage[]).reverse()
        : [];

      const picked: { mountId: string; path: string; title: string; hash: string; text: string }[] = [];
      if (scope.kind === 'note') {
        const { mount, note } = await noteFor(req, p, scope.mountId, scope.path, 'read');
        picked.push({ mountId: mount.id, path: note.path, title: note.title, hash: note.hash, text: note.raw });
      } else if (scope.kind !== 'general') {
        for (const c of candidates(req, p, scope, `${question} ${history.filter((m) => m.role === 'user').map((m) => m.content).join(' ')}`)) {
          const mount = d.manager.get(c.mountId);
          if (!mount) continue;
          const note = await d.notes.read(mount, c.path).catch(() => null);
          if (!note || note.frontmatter.ai === false || isEncryptedNote(note.raw)) continue;
          picked.push({ mountId: mount.id, path: note.path, title: note.title, hash: note.hash, text: note.raw });
        }
      }
      const searched: Source[] = picked.map((n, i) => ({ n: i + 1, mountId: n.mountId, path: n.path, title: n.title }));
      const name = (id: string) => d.manager.get(id)?.name ?? id;
      const context = picked.length
        ? picked.map((n, i) => `[${i + 1}] ${name(n.mountId)} / ${n.path} („${n.title}“)\n${n.text.slice(0, MAX_NOTE_CHARS)}`).join('\n\n---\n\n')
        : '';
      const task =
        scope.kind === 'general'
          ? 'Beantworte die Frage frei aus deinem Allgemeinwissen – Wiki-Inhalte stehen dir hier nicht zur Verfügung. Sag offen, wenn du dir unsicher bist oder dein Wissen veraltet sein kann, und erfinde keine Quellen, Links oder Zitate. Fragt der Benutzer nach seinen eigenen Notizen oder Daten, sag, dass du im Bezug „Allgemein“ keinen Zugriff darauf hast und er einen anderen Bezug wählen kann. Antworte in der Sprache der Frage.'
          : `Beantworte die Frage anhand der nummerierten Quellen aus dem Wiki. Belege Aussagen mit [1], [2] … Steht die Antwort nicht in den Quellen, sag das ehrlich und rate nicht. ${GROUNDING} Antworte in der Sprache der Frage.`;
      const content = context ? `Quellen:\n\n${context}\n\n---\n\nFrage: ${question}` : scope.kind === 'general' ? question : `Es wurden keine freigegebenen Notizen zu dieser Frage gefunden.\n\nFrage: ${question}`;
      const res = await d.providers.chat(p, { system: system(req, task), messages: [...history, { role: 'user', content }], maxTokens: 2048, temperature: scope.kind === 'general' ? 0.3 : 0.1 });
      const sources = citedSources(res.text, searched);

      const t = now();
      if (!chat) {
        chat = { id: ulid() };
        d.db.prepare('INSERT INTO ai_chats (id, user_id, title, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(chat.id, req.user!.id, question.slice(0, 80), JSON.stringify(scope), t, t);
      } else d.db.prepare('UPDATE ai_chats SET updated_at = ? WHERE id = ?').run(t, chat.id);
      const add = d.db.prepare('INSERT INTO ai_messages (id, chat_id, role, content, sources_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      add.run(ulid(), chat.id, 'user', question, '[]', '{}', t);
      add.run(ulid(), chat.id, 'assistant', res.text, JSON.stringify(sources), JSON.stringify({ provider: p.name, model: res.model }), new Date(Date.now() + 1).toISOString());
      auditCall(
        req,
        p,
        res.model,
        `Frage (${scope.kind})`,
        picked.map((n) => ({ mountId: n.mountId, path: n.path, hash: n.hash })),
        { chatId: chat.id },
      );
      return { chatId: chat.id, answer: res.text, sources, provider: p.name, model: res.model };
    },

    chats(req: FastifyRequest) {
      return d.db
        .prepare('SELECT id, title, scope_json, created_at, updated_at FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100')
        .all(req.user!.id)
        .map((r) => {
          const row = r as { id: string; title: string; scope_json: string; created_at: string; updated_at: string };
          return { id: row.id, title: row.title, scope: JSON.parse(row.scope_json) as Scope, createdAt: row.created_at, updatedAt: row.updated_at };
        });
    },

    chat(req: FastifyRequest, id: string) {
      const chat = d.db.prepare('SELECT id, title, scope_json FROM ai_chats WHERE id = ? AND user_id = ?').get(id, req.user!.id) as { id: string; title: string; scope_json: string } | undefined;
      if (!chat) return null;
      const messages = (d.db.prepare('SELECT role, content, sources_json, meta_json, created_at FROM ai_messages WHERE chat_id = ? ORDER BY created_at').all(id) as {
        role: string;
        content: string;
        sources_json: string;
        meta_json: string;
        created_at: string;
      }[]).map((m) => ({ role: m.role, content: m.content, sources: JSON.parse(m.sources_json) as Source[], meta: JSON.parse(m.meta_json) as Record<string, string>, createdAt: m.created_at }));
      return { id: chat.id, title: chat.title, scope: JSON.parse(chat.scope_json) as Scope, messages };
    },

    /**
     * Deletes one chat, all of them, or those of the last `hours` (like a browser history). Really
     * gone: messages and proposals go with the chat (cascade), SQLite overwrites the freed pages
     * (secure_delete) and the write-ahead log is emptied, so the text is not left lying around.
     */
    deleteChat(req: FastifyRequest, id: string | 'all', hours = 0): number {
      // Only here: globally it slows down the many index deletes (search, links) noticeably.
      d.db.pragma('secure_delete = ON');
      try {
        const res =
          id !== 'all'
            ? d.db.prepare('DELETE FROM ai_chats WHERE id = ? AND user_id = ?').run(id, req.user!.id)
            : hours > 0
              ? d.db.prepare('DELETE FROM ai_chats WHERE user_id = ? AND updated_at >= ?').run(req.user!.id, new Date(Date.now() - hours * 3_600_000).toISOString())
              : d.db.prepare('DELETE FROM ai_chats WHERE user_id = ?').run(req.user!.id);
        if (res.changes) d.db.pragma('wal_checkpoint(TRUNCATE)');
        return res.changes;
      } finally {
        d.db.pragma('secure_delete = OFF');
      }
    },

    /**
     * Deletes chats unused for longer than the retention (days; 0 = keep). A chat about one
     * source (note, folder, source) follows that source's own rule when it has one
     * (`options.aiChatDays`, Löschregeln AD-034). Returns how many went.
     */
    prune(days: number, now = Date.now()): number {
      const rows = d.db.prepare('SELECT id, scope_json, updated_at FROM ai_chats').all() as { id: string; scope_json: string; updated_at: string }[];
      const del = d.db.prepare('DELETE FROM ai_chats WHERE id = ?');
      let n = 0;
      for (const r of rows) {
        let mountId: string | undefined;
        try {
          mountId = (JSON.parse(r.scope_json) as { mountId?: string }).mountId;
        } catch {
          mountId = undefined;
        }
        const own = mountId ? d.manager.get(mountId)?.options.aiChatDays : undefined;
        const limit = typeof own === 'number' && own >= 0 ? own : days;
        if (limit > 0 && Date.parse(r.updated_at) < now - limit * 86_400_000) n += del.run(r.id).changes;
      }
      return n;
    },
  };
}

export type Assistant = ReturnType<typeof createAssistant>;
