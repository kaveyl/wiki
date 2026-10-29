// Lasting AI knowledge per source (PLAN §3c „Gedächtnis“, AD-026), as Markdown in the repo:
// `.kaveyl-wiki/ai/README.md` (what this folder is), `anweisungen.md` (written by people, like a
// CLAUDE.md) and `gedaechtnis.md` (entries the AI proposed and a person confirmed). Versioned
// with the source and readable for Claude Code and Hermes. Each file carries
// `managed_by: kaveyl-wiki-ai`. The AI only sees them for sources released at the top level
// (cloud providers: released for cloud); an admin can switch the memory off per source.
import type { FastifyRequest } from 'fastify';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Author } from '../git/sync.js';
import type { MountManager } from '../mounts/manager.js';
import { absPath, type Mount } from '../mounts/model.js';
import type { Scope } from './assistant.js';
import type { ProviderConfig } from './providers.js';
import type { AiRules } from './rules.js';
import { META_DIR } from '../notes/meta.js';

export const AI_DIR = `${META_DIR}/ai`;
const README = `${AI_DIR}/README.md`;
const INSTRUCTIONS = `${AI_DIR}/anweisungen.md`;
const MEMORY = `${AI_DIR}/gedaechtnis.md`;
const MAX_CHARS = 6000;

const header = (title: string, text: string) => `---\nmanaged_by: kaveyl-wiki-ai\n---\n# ${title}\n\n> ${text}\n\n`;

const TEMPLATES: Record<string, string> = {
  [README]:
    header(
      'KI-Ordner von Kaveyl Wiki',
      'Dieser Ordner wird von der Kaveyl-Wiki-App (KI-Assistent) verwaltet. Er ist Teil der Quelle und wird mit ihr versioniert.',
    ) +
    '- `anweisungen.md` – Anweisungen für die KI zu dieser Quelle (schreiben Menschen, wie eine CLAUDE.md).\n' +
    '- `gedaechtnis.md` – Dinge, die sich die KI merken soll. Neue Einträge schlägt die KI vor; sie landen erst nach Bestätigung hier.\n\n' +
    'Beide Dateien gehen bei jeder KI-Anfrage zu dieser Quelle mit, wenn die Quelle für die KI freigegeben ist. Ändern kannst du sie in Kaveyl Wiki (Rechtsklick auf die Quelle → KI-Freigabe) oder mit jedem Editor.\n',
  [INSTRUCTIONS]: header('Anweisungen für die KI', 'Wird von Menschen gepflegt und bei jeder KI-Anfrage zu dieser Quelle mitgeschickt (verwaltet von Kaveyl Wiki).'),
  [MEMORY]: header('Gedächtnis der KI', 'Einträge schlägt die KI vor; sie stehen erst nach Bestätigung durch einen Menschen hier (verwaltet von Kaveyl Wiki).'),
};

/** Text below the managed header (what goes to the AI). */
function body(raw: string): string {
  return raw
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^# .*\n+(> .*\n+)?/, '')
    .trim();
}

export interface MemoryDeps {
  manager: MountManager;
  rules: AiRules;
  dataPath: string;
  /** The memory speaks for the whole source: only for users who may read its root. */
  rootReadable(req: FastifyRequest, mountId: string): boolean;
}

export function createMemory(d: MemoryDeps) {
  const file = (mount: Mount, rel: string) => absPath(mount, d.dataPath, rel);
  const read = async (mount: Mount, rel: string) => readFile(file(mount, rel), 'utf8').catch(() => null);

  /** Creates the three files if missing (never overwrites). Returns the paths it wrote. */
  const ensure = async (mount: Mount): Promise<string[]> => {
    const written: string[] = [];
    for (const [rel, text] of Object.entries(TEMPLATES)) {
      const abs = file(mount, rel);
      if (await lstat(abs).catch(() => null)) continue;
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text, { flag: 'wx' });
      written.push(rel);
    }
    return written;
  };

  return {
    memoryPath: MEMORY,
    instructionsPath: INSTRUCTIONS,

    enabled(mount: Mount): boolean {
      return mount.options.aiMemory !== false;
    },

    /**
     * Instructions and memory of the sources in reach of this question, as a prompt block —
     * only sources released for the AI at their top level (and for cloud, if needed).
     */
    async context(req: FastifyRequest, p: ProviderConfig, scope: Scope, inReach: (mountId: string) => boolean): Promise<string> {
      if (scope.kind === 'general') return '';
      const parts: string[] = [];
      for (const mount of d.manager.list()) {
        if (mount.paused || !this.enabled(mount) || !inReach(mount.id) || !d.rootReadable(req, mount.id)) continue;
        const g = d.rules.grant(mount.id, INSTRUCTIONS);
        if (g.level === 'none' || (p.cloud && !g.cloud)) continue;
        for (const [rel, what] of [
          [INSTRUCTIONS, 'Anweisungen'],
          [MEMORY, 'Gedächtnis'],
        ] as const) {
          const text = body((await read(mount, rel)) ?? '');
          if (text) parts.push(`${what} für die Quelle „${mount.name}“ (${rel}):\n${text.slice(0, MAX_CHARS)}`);
        }
      }
      return parts.join('\n\n');
    },

    /** The three files for the admin dialog (body only; null = not created yet). */
    async get(mount: Mount) {
      const instructions = await read(mount, INSTRUCTIONS);
      const memory = await read(mount, MEMORY);
      return { enabled: this.enabled(mount), instructions: instructions === null ? null : body(instructions), memory: memory === null ? null : body(memory) };
    },

    /** Saves instructions and/or memory (body; the managed header is kept). */
    async save(mount: Mount, input: { instructions?: string; memory?: string }, author: Author): Promise<string[]> {
      const changed = await ensure(mount);
      for (const [rel, text] of [
        [INSTRUCTIONS, input.instructions],
        [MEMORY, input.memory],
      ] as const) {
        if (typeof text !== 'string') continue;
        const next = TEMPLATES[rel]! + (text.trim() ? `${text.trim()}\n` : '');
        if ((await read(mount, rel)) === next) continue;
        await writeFile(file(mount, rel), next);
        changed.push(rel);
      }
      if (changed.length) await d.manager.touched(mount, [...new Set(changed)], author);
      return changed;
    },

    /** Appends a confirmed entry to the memory (creating the folder on first use). */
    async remember(mount: Mount, text: string, author: Author): Promise<string> {
      const written = await ensure(mount);
      const current = (await read(mount, MEMORY)) ?? TEMPLATES[MEMORY]!;
      // The day where the server is (TZ), not in UTC: shortly after midnight it would still say yesterday.
      const at = new Date();
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      const entry = `- ${day}: ${text.replace(/\s*\n\s*/g, ' ').trim()}\n`;
      await writeFile(file(mount, MEMORY), current.endsWith('\n') ? current + entry : `${current}\n${entry}`);
      await d.manager.touched(mount, [...new Set([...written, MEMORY])], author);
      return MEMORY;
    },
  };
}

export type Memory = ReturnType<typeof createMemory>;
