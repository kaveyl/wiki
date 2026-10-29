// AI agent (PLAN §3c „Rahmen“, AD-026): a server-side loop in which the model itself searches,
// lists and reads notes through tools, and proposes changes. The tools are the operations of
// the MCP server (ops.ts), narrowed to what the AI may see: the user's ACL, the AI release
// rules, `ai: false`, never encrypted notes — the same gates as the assistant. Nothing is
// written by the model: a proposal waits in `ai_proposals` until the user applies it; then it
// is committed as „Kaveyl Wiki KI (im Auftrag von …)“ with an `ai(...)` message.
// Models without tool calling fall back to the plain search answer (assistant.ask).
import type { FastifyRequest } from 'fastify';
import { readFrontmatter, splitFrontmatter, setFrontmatterKeys } from '@kaveyl-wiki/core';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ulid } from 'ulid';
import { atLeast, type Level } from '../acl/acl.js';
import { now, type DB } from '../db/db.js';
import type { Author } from '../git/sync.js';
import { textDiff } from '../git/history.js';
import type { MountManager } from '../mounts/manager.js';
import { absPath, cleanRelPath, type Mount } from '../mounts/model.js';
import { isEncryptedNote } from '../notes/encryption.js';
import { ConflictError, fileNameFor, type NoteService } from '../notes/service.js';
import type { Ops } from '../api/ops.js';
import { AiAccessError, citedSources, GROUNDING, type Assistant, type Scope, type Source } from './assistant.js';
import { ToolsUnsupportedError, type AgentMessage, type ChatMessage, type Providers, type ToolCall, type ToolDef } from './providers.js';
import type { AiRules } from './rules.js';
import type { Memory } from './memory.js';
import { publicError } from '../errors.js';

/**
 * Source numbers like "[1]" belong to the chat answer, not into a note — the model adds them
 * anyway (live test 2026-10-08). Kept where the note already had them; links `[1](…)`,
 * definitions `[1]:`, footnotes `[^1]` and code (`list[0]`, fenced blocks) are not touched.
 */
export function stripCitations(content: string, original = ''): string {
  // Odd parts are code: fenced blocks and inline code spans.
  return content
    .split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$|`[^`\n]+`)/m)
    .map((part, i) => (i % 2 ? part : part.replace(/ ?\[(\d{1,2})\](?![(:[])/g, (m, n: string) => (original.includes(`[${n}]`) ? m : ''))))
    .join('');
}

/**
 * The model writes links from the source root ("Besprechungen/x.md") also into a note inside
 * a folder: such a link is turned into one from the note's folder when only the root reading
 * points to an existing file.
 */
export function relinkFromRoot(content: string, folder: string, exists: (path: string) => boolean): string {
  if (!folder) return content;
  return content.replace(/\]\(([^)\s]+\.md)(#[^)\s]*)?\)/g, (m, target: string, hash: string | undefined) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) return m;
    let path: string;
    try {
      path = decodeURIComponent(target);
    } catch {
      return m;
    }
    if (exists(`${folder}/${path}`) || !exists(path)) return m;
    return `](${folder.split('/').map(() => '..').join('/')}/${target}${hash ?? ''})`;
  });
}

export interface AgentDeps {
  db: DB;
  dataPath: string;
  manager: MountManager;
  notes: NoteService;
  providers: Providers;
  rules: AiRules;
  ops: Ops;
  assistant: Assistant;
  memory: Memory;
  levelIn(req: FastifyRequest, mountId: string, path: string, isDir?: boolean): Level;
  /** Throws unless the user has `need` on every note and folder below `path` (as moving in the tree). */
  accessAll(req: FastifyRequest, mountId: string, path: string, need: Level): unknown;
  author(req: FastifyRequest): Author;
  rulesMoved(mountId: string, from: string, to: string, toMountId?: string): void;
  audit(req: FastifyRequest, action: string, message: string, detail: Record<string, unknown>): void;
}

export type ProposalKind = 'create' | 'write' | 'move' | 'remember';

export interface Proposal {
  id: string;
  chatId: string;
  kind: ProposalKind;
  mountId: string;
  mountName: string;
  /** write: the note; create: the parent folder; move: the old path; remember: the memory file. */
  path: string;
  toPath: string | null;
  title: string | null;
  content: string | null;
  reason: string | null;
  status: 'open' | 'applied' | 'rejected' | 'failed';
  result: string | null;
  createdAt: string;
}

export type AgentEvent =
  | { type: 'start'; mode: 'agent' | 'rag' }
  | { type: 'step'; tool: string; label: string }
  /** Text of the model as it arrives (streaming); a following step discards it. */
  | { type: 'delta'; text: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'answer'; chatId: string; answer: string; sources: Source[]; provider: string; model: string; mode: 'agent' | 'rag' };

/** Errors with an HTTP status (the app's error handler passes statusCode < 500 on). */
export class ProposalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

const MAX_STEPS = 10;
const MAX_TOOL_CHARS = 12_000;
const str = { type: 'string' } as const;

const TOOLS: ToolDef[] = [
  {
    name: 'search',
    description: 'Volltextsuche in den für dich freigegebenen Notizen. Operatoren: "Phrase", -wort, tag:x, in:ordner. Liefert Quelle (sourceId), Pfad, Titel und Ausschnitt.',
    parameters: { type: 'object', properties: { query: str, limit: { type: 'number', description: 'höchstens so viele Treffer (Standard 10)' } }, required: ['query'] },
  },
  {
    name: 'list_sources',
    description: 'Die Quellen (Repositories/Ordner), auf die du zugreifen darfst, mit ihrer sourceId.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_tree',
    description: 'Ordner und Notizen einer Quelle unterhalb von path (leer = oberste Ebene), zwei Ebenen tief.',
    parameters: { type: 'object', properties: { sourceId: str, path: str }, required: ['sourceId'] },
  },
  {
    name: 'read_note',
    description: 'Liest eine Notiz als Markdown. Die Antwort nennt die Quellen-Nummer [n], mit der du Aussagen belegst.',
    parameters: { type: 'object', properties: { sourceId: str, path: str }, required: ['sourceId', 'path'] },
  },
  {
    name: 'get_backlinks',
    description: 'Welche Notizen auf diese Notiz verlinken.',
    parameters: { type: 'object', properties: { sourceId: str, path: str }, required: ['sourceId', 'path'] },
  },
  {
    name: 'propose_create_note',
    description: 'Schlägt eine neue Notiz vor (wird erst nach Bestätigung des Benutzers angelegt). parent = Ordner ("" = oberste Ebene), title = Dateiname ohne .md.',
    parameters: { type: 'object', properties: { sourceId: str, parent: str, title: str, markdown: str, reason: str }, required: ['sourceId', 'parent', 'title', 'markdown'] },
  },
  {
    name: 'propose_edit_note',
    description: 'Schlägt neuen Inhalt für eine bestehende Notiz vor (ganzer Markdown-Text, Frontmatter darf fehlen – er bleibt erhalten). Lies die Notiz vorher. Wird erst nach Bestätigung geändert.',
    parameters: { type: 'object', properties: { sourceId: str, path: str, markdown: str, reason: str }, required: ['sourceId', 'path', 'markdown'] },
  },
  {
    name: 'propose_move_note',
    description: 'Schlägt vor, eine Notiz oder einen Ordner umzubenennen/zu verschieben (to = neuer Pfad in derselben Quelle). Links werden beim Ausführen angepasst.',
    parameters: { type: 'object', properties: { sourceId: str, from: str, to: str, reason: str }, required: ['sourceId', 'from', 'to'] },
  },
  {
    name: 'propose_remember',
    description:
      'Schlägt einen Eintrag für das dauerhafte Gedächtnis einer Quelle vor (.kaveyl-wiki/ai/gedaechtnis.md) – nur, wenn der Benutzer ausdrücklich möchte, dass du dir etwas merkst.',
    parameters: { type: 'object', properties: { sourceId: str, text: str }, required: ['sourceId', 'text'] },
  },
];

const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const cut = (t: string, n = MAX_TOOL_CHARS) => (t.length > n ? `${t.slice(0, n)}\n… (gekürzt)` : t);
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function createAgent(d: AgentDeps) {
  const { providerFor, blocked, noteFor, system, auditCall } = d.assistant.core;

  const proposalRow = (r: Record<string, unknown>): Proposal => ({
    id: s(r.id),
    chatId: s(r.chat_id),
    kind: r.kind as ProposalKind,
    mountId: s(r.mount_id),
    mountName: d.manager.get(s(r.mount_id))?.name ?? s(r.mount_id),
    path: s(r.path),
    toPath: (r.to_path as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    content: (r.content as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    status: r.status as Proposal['status'],
    result: (r.result as string | null) ?? null,
    createdAt: s(r.created_at),
  });

  const ownProposal = (req: FastifyRequest, id: string) => {
    const row = d.db.prepare('SELECT * FROM ai_proposals WHERE id = ? AND user_id = ?').get(id, req.user!.id) as Record<string, unknown> | undefined;
    if (!row) throw new ProposalError('Vorschlag nicht gefunden', 404);
    return proposalRow(row);
  };

  /** The path whose release/ACL a proposal needs (a folder is checked like a note inside it); a new note's file name as create() makes it. */
  const targetOf = (p: Pick<Proposal, 'kind' | 'path' | 'toPath' | 'title'>) =>
    p.kind === 'create' ? (p.path ? `${p.path}/${fileNameFor(p.title ?? '')}.md` : `${fileNameFor(p.title ?? '')}.md`) : p.kind === 'move' ? p.toPath! : p.path;

  /**
   * A folder moves with everything in it: the user needs write on all of it (as moving in the tree), and no AI rule
   * inside may hold less than „suggest“ (audit sec2-001).
   */
  const assertFolderMovable = (req: FastifyRequest, mountId: string, dir: string) => {
    try {
      d.accessAll(req, mountId, dir, 'write');
    } catch {
      throw new AiAccessError('der Benutzer hat nicht auf alles im Ordner Schreibrecht');
    }
    // Without the path: the model (and its provider) must not learn names of folders closed for the AI (sec2-009).
    if (d.rules.rules(mountId).some((r) => r.target !== 'mount' && r.path.startsWith(`${dir}/`) && r.level !== 'suggest'))
      throw new AiAccessError('der Ordner enthält etwas, das nicht für KI-Vorschläge freigegeben ist');
  };

  return {
    /**
     * One question: the model works with the tools until it answers. Events stream to the
     * browser as they happen; the chat (and its proposals) is kept like an assistant chat.
     */
    async run(req: FastifyRequest, input: { question: string; scope: Scope; chatId?: string; providerId?: string }, emit: (e: AgentEvent) => void): Promise<void> {
      const question = s(input.question).trim().slice(0, 4000);
      if (!question) throw new AiAccessError('Frage fehlt');
      const scope: Scope = input.scope ?? { kind: 'all' };
      if (!['note', 'folder', 'source', 'all', 'general'].includes(scope.kind)) throw new AiAccessError('Unbekannter Bezug');
      const p = providerFor(req, input.providerId);
      // Without wiki content there is nothing to look up: the plain answer.
      if (scope.kind === 'general') {
        await emitRag();
        return;
      }

      let chatId = input.chatId
        ? (d.db.prepare('SELECT id FROM ai_chats WHERE id = ? AND user_id = ?').get(input.chatId, req.user!.id) as { id: string } | undefined)?.id
        : undefined;
      const history: ChatMessage[] = chatId
        ? (d.db.prepare('SELECT role, content FROM ai_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 8').all(chatId) as ChatMessage[]).reverse()
        : [];
      const ensureChat = () => {
        if (chatId) return chatId;
        chatId = ulid();
        const t = now();
        d.db.prepare('INSERT INTO ai_chats (id, user_id, title, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(chatId, req.user!.id, question.slice(0, 80), JSON.stringify(scope), t, t);
        return chatId;
      };

      // What the AI may see in this run: inside the scope, released for it, readable by the user.
      const sourceInScope = (mountId: string) => scope.kind === 'all' || ('mountId' in scope && scope.mountId === mountId);
      const inScope = (mountId: string, path: string) =>
        sourceInScope(mountId) && (scope.kind !== 'folder' || path === scope.path || path.startsWith(`${cleanRelPath(scope.path)}/`));
      const mayRead = (mountId: string, path: string) => inScope(mountId, path) && !blocked(req, p, mountId, path, 'read');
      // `ai: false` and encrypted notes stay invisible in lists, too (not only when read).
      const fileOk = new Map<string, Promise<boolean>>();
      const allowedFile = (mountId: string, path: string) => {
        const key = `${mountId}:${path}`;
        if (!fileOk.has(key)) {
          const mount = d.manager.get(mountId);
          fileOk.set(
            key,
            mount
              ? readFile(absPath(mount, d.dataPath, path), 'utf8')
                  .then((raw) => readFrontmatter(splitFrontmatter(raw).frontmatter).ai !== false && !isEncryptedNote(raw))
                  .catch(() => false)
              : Promise.resolve(false),
          );
        }
        return fileOk.get(key)!;
      };
      const visible = async <T>(items: T[], at: (x: T) => [string, string]) => {
        const ok = await Promise.all(items.map((x) => (mayRead(...at(x)) ? allowedFile(...at(x)) : Promise.resolve(false))));
        return items.filter((_, i) => ok[i]);
      };
      const name = (id: string) => d.manager.get(id)?.name ?? id;

      const sources: Source[] = [];
      const read: { mountId: string; path: string; hash: string }[] = [];
      const steps: string[] = [];
      const proposals: string[] = [];

      /** Does the file exist in the source (false for anything outside)? */
      const fileIn = (mount: Mount, path: string) => {
        try {
          return existsSync(absPath(mount, d.dataPath, path));
        } catch {
          return false;
        }
      };
      const propose = (pr: Omit<Proposal, 'id' | 'chatId' | 'mountName' | 'status' | 'result' | 'createdAt'> & { baseHash?: string }) => {
        const id = ulid();
        d.db
          .prepare(
            'INSERT INTO ai_proposals (id, chat_id, user_id, kind, mount_id, path, to_path, title, content, base_hash, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(id, ensureChat(), req.user!.id, pr.kind, pr.mountId, pr.path, pr.toPath, pr.title, pr.content, pr.baseHash ?? null, pr.reason, 'open', now());
        proposals.push(id);
        const full = ownProposal(req, id);
        emit({ type: 'proposal', proposal: full });
        return `Vorschlag gespeichert (${id.slice(-6)}). Er wird erst ausgeführt, wenn der Benutzer ihn bestätigt.`;
      };

      /** Checks for a proposal: inside the scope, released for suggestions, user may write. */
      const mayPropose = (mountId: string, path: string, isDir = false) => {
        const mount = d.manager.get(mountId);
        if (!mount || mount.paused || !inScope(mountId, path)) throw new AiAccessError('außerhalb des Bezugs oder unbekannte Quelle');
        if (mount.options.readonly) throw new AiAccessError('Quelle ist schreibgeschützt');
        const why = blocked(req, p, mountId, path, 'suggest');
        if (why) throw new AiAccessError(`Pfad ist ${why}`);
        if (!atLeast(d.levelIn(req, mountId, path, isDir), 'write')) throw new AiAccessError('der Benutzer hat dort kein Schreibrecht');
        return mount;
      };

      const label = (c: ToolCall) => {
        const a = c.args;
        const where = (src: unknown, path: unknown) => `${name(s(src))}${s(path) ? ` / ${s(path)}` : ''}`;
        switch (c.name) {
          case 'search':
            return `Sucht „${s(a.query)}“`;
          case 'list_sources':
            return 'Sieht nach, welche Quellen es gibt';
          case 'list_tree':
            return `Sieht sich ${where(a.sourceId, a.path)} an`;
          case 'read_note':
            return `Liest ${where(a.sourceId, a.path)}`;
          case 'get_backlinks':
            return `Sucht Links auf ${s(a.path)}`;
          case 'propose_create_note':
            return `Schlägt eine neue Notiz „${s(a.title)}“ vor`;
          case 'propose_edit_note':
            return `Schlägt eine Änderung an ${s(a.path)} vor`;
          case 'propose_move_note':
            return `Schlägt vor: ${s(a.from)} → ${s(a.to)}`;
          case 'propose_remember':
            return 'Schlägt einen Gedächtnis-Eintrag vor';
          default:
            return c.name;
        }
      };

      const runTool = async (c: ToolCall): Promise<string> => {
        const a = c.args;
        switch (c.name) {
          case 'search': {
            const limit = Math.max(1, Math.min(20, Number(a.limit) || 10));
            const find = async (q: string) => visible(d.ops.search(req, q, 100), (h) => [h.sourceId, h.path]);
            let hits = (await find(s(a.query))).slice(0, limit);
            let note = '';
            // All words together found nothing (e.g. two topics in one query): each word on its
            // own — otherwise the model concluded "nothing in the notes" (live test 2026-10-08).
            const words = [...new Set(s(a.query).split(/\s+/).filter((w) => w.length >= 3))];
            if (!hits.length && words.length > 1) {
              const seen = new Set<string>();
              for (const w of words)
                for (const h of await find(w))
                  if (!seen.has(`${h.sourceId}:${h.path}`)) {
                    seen.add(`${h.sourceId}:${h.path}`);
                    hits.push(h);
                  }
              hits = hits.slice(0, limit);
              note = `Keine Notiz enthält alle Wörter zusammen; Treffer für einzelne Wörter (${words.join(', ')}):\n`;
            }
            if (!hits.length) return 'Keine Treffer in den freigegebenen Notizen.';
            return note + hits.map((h) => `- sourceId=${h.sourceId} (${name(h.sourceId)}) path=${h.path} titel="${h.title}"${h.snippet ? ` … ${h.snippet} …` : ''}`).join('\n');
          }
          case 'list_sources': {
            const list = d.ops.sources(req).filter((m) => sourceInScope(m.id) && d.rules.anyReleased(m.id));
            return list.length ? list.map((m) => `- sourceId=${m.id} name="${m.name}"${m.readonly ? ' (schreibgeschützt)' : ''}`).join('\n') : 'Keine freigegebenen Quellen.';
          }
          case 'list_tree': {
            const sourceId = s(a.sourceId);
            if (!sourceInScope(sourceId)) return 'Diese Quelle liegt außerhalb des Bezugs.';
            const root = s(a.path) ? cleanRelPath(s(a.path)) : scope.kind === 'folder' ? cleanRelPath(scope.path) : '';
            const all = d.ops.tree(req, sourceId, root);
            const depth = (p: string) => (root ? p.slice(root.length + 1) : p).split('/').length;
            const files = all.filter((e) => e.kind === 'file' && mayRead(sourceId, e.path));
            const dirs = all.filter((e) => e.kind === 'dir' && depth(e.path) <= 2 && files.some((f) => f.path.startsWith(`${e.path}/`)));
            const shown = await visible(
              files.filter((f) => depth(f.path) <= 2),
              (f) => [sourceId, f.path],
            );
            const lines = [...dirs.map((e) => `[Ordner] ${e.path}`), ...shown.map((f) => `${f.path} – ${f.title}`)];
            return lines.length ? cut(lines.sort().join('\n')) : 'Hier ist nichts für dich freigegeben.';
          }
          case 'read_note': {
            const sourceId = s(a.sourceId);
            const path = cleanRelPath(s(a.path));
            if (!inScope(sourceId, path)) return 'Diese Notiz liegt außerhalb des Bezugs.';
            const { mount, note } = await noteFor(req, p, sourceId, path, 'read');
            let n = sources.find((x) => x.mountId === mount.id && x.path === note.path)?.n;
            if (!n) {
              n = sources.length + 1;
              sources.push({ n, mountId: mount.id, path: note.path, title: note.title });
              read.push({ mountId: mount.id, path: note.path, hash: note.hash });
            }
            return `Quelle [${n}]: ${mount.name} / ${note.path} („${note.title}“)\n\n${cut(note.raw)}`;
          }
          case 'get_backlinks': {
            const sourceId = s(a.sourceId);
            if (!mayRead(sourceId, cleanRelPath(s(a.path)))) return 'Diese Notiz ist nicht freigegeben.';
            const links = await visible(await d.ops.backlinks(req, sourceId, s(a.path)), (b) => [sourceId, b.path]);
            return links.length ? links.map((b) => `- ${b.path}`).join('\n') : 'Keine Notiz verlinkt hierher.';
          }
          case 'propose_create_note': {
            const parent = s(a.parent) ? cleanRelPath(s(a.parent)) : '';
            const title = s(a.title).trim().replace(/\.md$/i, '').slice(0, 120);
            if (!title) return 'Fehler: title fehlt.';
            const mount = mayPropose(s(a.sourceId), parent ? `${parent}/${fileNameFor(title)}.md` : `${fileNameFor(title)}.md`);
            const exists = (path: string) => fileIn(mount, path);
            const content = relinkFromRoot(stripCitations(s(a.markdown)), parent, exists);
            return propose({ kind: 'create', mountId: mount.id, path: parent, toPath: null, title, content, reason: s(a.reason).slice(0, 300) || null });
          }
          case 'propose_edit_note': {
            const path = cleanRelPath(s(a.path));
            const mount = mayPropose(s(a.sourceId), path);
            const { note } = await noteFor(req, p, mount.id, path, 'suggest');
            const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            const exists = (p: string) => fileIn(mount, p);
            let content = relinkFromRoot(stripCitations(s(a.markdown), note.raw), folder, exists);
            // The model often leaves out the frontmatter: keep it (the id is the note's identity).
            const { frontmatter } = splitFrontmatter(note.raw);
            if (frontmatter && !content.startsWith('---')) content = frontmatter + content.replace(/^\n+/, '');
            if (content === note.raw) return 'Der vorgeschlagene Inhalt entspricht dem aktuellen – kein Vorschlag nötig.';
            return propose({ kind: 'write', mountId: mount.id, path: note.path, toPath: null, title: null, content, reason: s(a.reason).slice(0, 300) || null, baseHash: note.hash });
          }
          case 'propose_move_note': {
            const from = cleanRelPath(s(a.from));
            const to = cleanRelPath(s(a.to));
            const isDir = !/\.md$/i.test(from);
            const mount = mayPropose(s(a.sourceId), isDir ? `${from}/x.md` : from, false);
            mayPropose(mount.id, isDir ? `${to}/x.md` : to, false);
            // Also for a „note“ path: a folder may end in „.md“ (sec2-010); for a note there is nothing below.
            assertFolderMovable(req, mount.id, from);
            if (!atLeast(d.levelIn(req, mount.id, parentOf(to), true), 'write')) throw new AiAccessError('der Benutzer hat am Ziel kein Schreibrecht');
            return propose({ kind: 'move', mountId: mount.id, path: from, toPath: to, title: null, content: null, reason: s(a.reason).slice(0, 300) || null });
          }
          case 'propose_remember': {
            const sourceId = s(a.sourceId);
            const text = s(a.text).trim().slice(0, 2000);
            if (!text) return 'Fehler: text fehlt.';
            const mount = d.manager.get(sourceId);
            if (!mount || !sourceInScope(sourceId)) return 'Unbekannte Quelle oder außerhalb des Bezugs.';
            if (!d.memory.enabled(mount)) return 'Das Gedächtnis ist für diese Quelle abgeschaltet.';
            if (mount.options.readonly || !atLeast(d.levelIn(req, mount.id, '', true), 'write')) return 'Der Benutzer darf in dieser Quelle nicht schreiben.';
            if (!d.rules.anyReleased(mount.id)) return 'Diese Quelle ist für die KI nicht freigegeben.';
            return propose({ kind: 'remember', mountId: mount.id, path: d.memory.memoryPath, toPath: null, title: null, content: text, reason: null });
          }
          default:
            return `Unbekanntes Werkzeug: ${c.name}`;
        }
      };

      // The note in focus and the source's own AI instructions go along up front.
      const preface: string[] = [];
      if (scope.kind === 'note') {
        const { mount, note } = await noteFor(req, p, scope.mountId, scope.path, 'read');
        sources.push({ n: 1, mountId: mount.id, path: note.path, title: note.title });
        read.push({ mountId: mount.id, path: note.path, hash: note.hash });
        preface.push(`Notiz im Fokus – Quelle [1]: ${mount.name} / ${note.path} („${note.title}“)\n\n${cut(note.raw)}`);
      }
      const instructions = await d.memory.context(req, p, scope, (mountId) => !!d.rules.anyReleased(mountId) && sourceInScope(mountId));
      const where =
        scope.kind === 'all'
          ? 'alle für dich freigegebenen Quellen'
          : scope.kind === 'source'
            ? `die Quelle „${name(scope.mountId)}“ (sourceId=${scope.mountId})`
            : scope.kind === 'folder'
              ? `den Ordner „${scope.path}“ der Quelle „${name(scope.mountId)}“ (sourceId=${scope.mountId})`
              : `die Notiz im Fokus und ihre Quelle „${name(scope.mountId)}“ (sourceId=${scope.mountId})`;
      const task = [
        `Du arbeitest mit Werkzeugen auf dem Wiki. Bezug dieser Unterhaltung: ${where}.`,
        'Stütze Antworten auf Notizen: suche (search), sieh dich um (list_tree) und lies (read_note), bevor du dich auf eine Notiz beziehst. Belege Aussagen mit der Quellen-Nummer [n] aus read_note. Rate nicht – steht etwas nicht in den Notizen, sag das.',
        'Hat die Frage mehrere Teile, suche jeden Teil einzeln (kurze Suchbegriffe, z. B. „Ideen“ und „2027“ statt alles in einer Suche). Sage erst, dass etwas nicht in den Notizen steht, wenn du gezielt danach gesucht und den Ordnerbaum (list_tree) angesehen hast.',
        GROUNDING,
        'Du kannst nichts direkt ändern. Nur wenn der Benutzer darum bittet, legst du mit propose_create_note, propose_edit_note, propose_move_note oder propose_remember Vorschläge an; der Benutzer prüft und bestätigt sie. Löschen ist nicht möglich.',
        // Seen in the live test (2026-10-08): "[1]" and "{{date}}" ended up in a proposed note.
        `Der Inhalt vorgeschlagener Notizen steht für sich: keine Quellen-Nummern [n] (die gelten nur in deiner Antwort im Chat; verweise in der Notiz stattdessen mit einem Markdown-Link auf die Notiz, z. B. [Kassensystem](Kassensystem.md)) und keine Platzhalter wie {{date}} – schreibe echte Werte. Heute ist der ${new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}.`,
        // A closing summary of the answer re-condensed it and drifted from the notes (live test 2026-10-08).
        'Hast du Vorschläge angelegt, nenne am Ende kurz, was du vorgeschlagen hast. Sonst keine Zusammenfassung oder Kurzfassung am Ende – die Antwort nicht wiederholen. Antworte in der Sprache der Frage.',
        instructions,
      ]
        .filter(Boolean)
        .join('\n\n');
      const messages: AgentMessage[] = [...history, { role: 'user', content: preface.length ? `${preface.join('\n\n')}\n\n---\n\n${question}` : question }];

      let answer = '';
      let model = p.model;
      for (let step = 0; step <= MAX_STEPS; step++) {
        const last = step === MAX_STEPS;
        if (last) messages.push({ role: 'user', content: 'Genug nachgesehen: antworte jetzt abschließend, ohne weitere Werkzeuge.' });
        let res;
        try {
          res = await d.providers.chatTools(p, { system: system(req, task), messages, tools: TOOLS, onText: (text) => emit({ type: 'delta', text }) });
        } catch (e) {
          // No tool calling at all: the assistant's search-based answer instead.
          if (e instanceof ToolsUnsupportedError && step === 0) {
            await emitRag();
            return;
          }
          throw e;
        }
        if (step === 0) emit({ type: 'start', mode: 'agent' });
        model = res.model;
        if (!res.toolCalls.length || last) {
          answer = res.text.trim();
          break;
        }
        messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
        for (const c of res.toolCalls) {
          const l = label(c);
          steps.push(l);
          emit({ type: 'step', tool: c.name, label: l });
          let out: string;
          try {
            out = await runTool(c);
          } catch (e) {
            // Goes to the model (and so to the provider): no internal texts with server paths (audit sec2-003).
            out = `Fehler: ${publicError(e)?.message ?? 'interner Fehler'}`;
          }
          messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: out });
        }
      }
      if (!answer) answer = proposals.length ? 'Ich habe Vorschläge angelegt – bitte prüfen.' : 'Ich konnte keine Antwort finden.';

      const cited = citedSources(answer, sources);
      const id = ensureChat();
      const t = now();
      d.db.prepare('UPDATE ai_chats SET updated_at = ? WHERE id = ?').run(t, id);
      const add = d.db.prepare('INSERT INTO ai_messages (id, chat_id, role, content, sources_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      add.run(ulid(), id, 'user', question, '[]', '{}', t);
      add.run(ulid(), id, 'assistant', answer, JSON.stringify(cited), JSON.stringify({ provider: p.name, model, mode: 'agent', steps, proposals }), new Date(Date.now() + 1).toISOString());
      // The audit keeps which notes went where, not what was asked: search terms stay in the chat (deletable).
      const audited = steps.map((st) => (st.startsWith('Sucht „') ? 'Sucht (Suchbegriff nur im Chat)' : st));
      auditCall(req, p, model, `Agent (${scope.kind}), ${steps.length} Schritte${proposals.length ? `, ${proposals.length} Vorschläge` : ''}`, read, { chatId: id, steps: audited, proposals });
      emit({ type: 'answer', chatId: id, answer, sources: cited, provider: p.name, model, mode: 'agent' });

      async function emitRag() {
        emit({ type: 'start', mode: 'rag' });
        const res = await d.assistant.ask(req, { question, scope, chatId: input.chatId, providerId: input.providerId });
        emit({ type: 'answer', ...res, mode: 'rag' });
      }
    },

    proposals(req: FastifyRequest, chatId: string): Proposal[] {
      return (d.db.prepare('SELECT * FROM ai_proposals WHERE chat_id = ? AND user_id = ? ORDER BY created_at').all(chatId, req.user!.id) as Record<string, unknown>[]).map(proposalRow);
    },

    /** What applying would change: a diff for edits, the content for new notes. */
    async preview(req: FastifyRequest, id: string): Promise<{ diff: string | null; content: string | null }> {
      const pr = ownProposal(req, id);
      if (pr.kind === 'write') {
        const mount = d.manager.get(pr.mountId);
        // The note as it is now: only while the user may still read it (and it is still released).
        const current = mount && d.levelIn(req, mount.id, pr.path, false) !== 'none' && d.rules.grant(mount.id, pr.path).level !== 'none' ? await d.notes.read(mount, pr.path).catch(() => null) : null;
        return { diff: await textDiff(current?.raw ?? '', pr.content ?? ''), content: null };
      }
      return { diff: null, content: pr.content };
    },

    /** Carries a proposal out as the AI on behalf of the user — after re-checking every gate. */
    async apply(req: FastifyRequest, id: string): Promise<Proposal> {
      const pr = ownProposal(req, id);
      if (pr.status !== 'open') throw new ProposalError('Dieser Vorschlag ist schon erledigt', 409);
      const mount = d.manager.get(pr.mountId);
      if (!mount || mount.paused) throw new ProposalError('Quelle nicht verfügbar', 404);
      if (pr.kind === 'remember' && !d.memory.enabled(mount)) throw new AiAccessError('Das KI-Gedächtnis ist für diese Quelle abgeschaltet');
      const target = targetOf(pr);
      const checks = pr.kind === 'move' ? [pr.path, target] : [pr.kind === 'remember' ? '' : target];
      for (const path of checks) {
        const isDir = !path || !/\.md$/i.test(path);
        if (pr.kind !== 'remember' && d.rules.grant(mount.id, isDir ? `${path}/x.md` : path).level !== 'suggest') throw new AiAccessError(`${path || mount.name} ist nicht mehr für KI-Vorschläge freigegeben`);
        if (mount.options.readonly || !atLeast(d.levelIn(req, mount.id, path, isDir), 'write')) throw new AiAccessError('Kein Schreibrecht');
      }
      if (pr.kind === 'move') assertFolderMovable(req, mount.id, pr.path);
      const user = d.author(req);
      const what = pr.kind === 'move' ? `${pr.path} → ${pr.toPath}` : target;
      const ai: Author = {
        name: `Kaveyl Wiki KI (im Auftrag von ${user.name})`,
        email: user.email,
        message: `ai(${pr.kind === 'write' ? 'edit' : pr.kind}): ${what}${pr.reason ? ` – ${pr.reason.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`,
      };
      // Pending edits of people first, so the AI change is a commit of its own.
      if (mount.options.autoCommit) await d.manager.commitNow(mount);
      let result: string;
      try {
        if (pr.kind === 'write') {
          const base = (d.db.prepare('SELECT base_hash FROM ai_proposals WHERE id = ?').get(id) as { base_hash: string | null }).base_hash ?? '';
          await d.notes.saveRaw(mount, pr.path, pr.content ?? '', base, ai);
          result = pr.path;
        } else if (pr.kind === 'create') {
          result = await d.notes.create(mount, pr.path, pr.title ?? 'Neue Notiz', 'file', ai);
          const created = await d.notes.read(mount, result);
          const nid = created.frontmatter.id;
          const content = typeof nid === 'string' && !/^---\n[\s\S]*?\bid:/.test(pr.content ?? '') ? setFrontmatterKeys(pr.content ?? '', { id: nid }) : (pr.content ?? '');
          if (content.trim()) await d.notes.saveRaw(mount, result, content, created.hash, ai);
        } else if (pr.kind === 'move') {
          // Files that come along: only what the confirming user may read, as when moving in the tree.
          result = await d.notes.move(mount, pr.path, pr.toPath!, ai, (ref) => d.levelIn(req, mount.id, ref, false) !== 'none');
          d.rulesMoved(mount.id, pr.path, result);
        } else {
          result = await d.memory.remember(mount, pr.content ?? '', ai);
        }
      } catch (e) {
        if (e instanceof ConflictError) {
          d.db.prepare("UPDATE ai_proposals SET status = 'failed', result = ?, decided_at = ? WHERE id = ?").run('Notiz wurde inzwischen geändert', now(), id);
          throw new ProposalError('Die Notiz wurde seit dem Vorschlag geändert – bitte die KI neu fragen.', 409);
        }
        throw e;
      }
      if (mount.options.autoCommit) await d.manager.commitNow(mount);
      d.db.prepare("UPDATE ai_proposals SET status = 'applied', result = ?, decided_at = ? WHERE id = ?").run(result, now(), id);
      d.audit(req, 'ai-proposal-applied', `KI-Vorschlag übernommen (${pr.kind}): ${what}`, { mount: { id: mount.id, name: mount.name }, proposal: id });
      return ownProposal(req, id);
    },

    reject(req: FastifyRequest, id: string): Proposal {
      const pr = ownProposal(req, id);
      if (pr.status !== 'open') throw new ProposalError('Dieser Vorschlag ist schon erledigt', 409);
      d.db.prepare("UPDATE ai_proposals SET status = 'rejected', decided_at = ? WHERE id = ?").run(now(), id);
      return ownProposal(req, id);
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
