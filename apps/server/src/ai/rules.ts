// AI release rules (AD-011): the assistant sees nothing until an admin releases a source, a
// folder or a note — level `read` or `suggest` (read + propose changes), and whether cloud
// providers may get it (`cloud`) or only local ones (Ollama …). Inherited downwards; the most
// specific rule wins, except that a `none` anywhere on the way always wins. Note rules follow
// the note id (like ACL rules, AD-020). `ai: false` in the frontmatter and encrypted notes are
// checked on top of this by the assistant.
import { ulid } from 'ulid';
import { now, type DB } from '../db/db.js';
import type { Target } from '../acl/acl.js';

export const AI_LEVELS = ['none', 'read', 'suggest'] as const;
export type AiLevel = (typeof AI_LEVELS)[number];

export interface AiRule {
  id: string;
  mountId: string;
  target: Target;
  path: string;
  noteId: string | null;
  level: AiLevel;
  cloud: boolean;
  createdAt: string;
  orphan?: boolean;
}

export interface AiGrant {
  level: AiLevel;
  cloud: boolean;
}

interface Row {
  id: string;
  mount_id: string;
  target: Target;
  path: string;
  note_id: string | null;
  level: AiLevel;
  cloud: number;
  created_at: string;
}

export class AiRuleError extends Error {}

const under = (path: string, root: string) => root === '' || path === root || path.startsWith(root + '/');

export class AiRules {
  private cache = new Map<string, AiRule[]>();

  constructor(private readonly db: DB) {}

  invalidate(mountId?: string) {
    if (mountId) this.cache.delete(mountId);
    else this.cache.clear();
  }

  rules(mountId: string): AiRule[] {
    let rules = this.cache.get(mountId);
    if (!rules) {
      const rows = this.db.prepare('SELECT * FROM ai_rules WHERE mount_id = ? ORDER BY created_at').all(mountId) as Row[];
      const pathOf = this.db.prepare('SELECT path FROM note_ids WHERE mount_id = ? AND id = ?');
      rules = rows.map((r) => {
        const rule: AiRule = { id: r.id, mountId: r.mount_id, target: r.target, path: r.path, noteId: r.note_id, level: r.level, cloud: !!r.cloud, createdAt: r.created_at };
        if (r.target === 'note') {
          const current = (pathOf.get(mountId, r.note_id) as { path: string } | undefined)?.path;
          if (current) rule.path = current;
          else rule.orphan = true;
        }
        return rule;
      });
      this.cache.set(mountId, rules);
    }
    return rules;
  }

  all(): AiRule[] {
    const ids = (this.db.prepare('SELECT DISTINCT mount_id FROM ai_rules').all() as { mount_id: string }[]).map((r) => r.mount_id);
    return ids.flatMap((id) => this.rules(id));
  }

  ruleAt(mountId: string, target: Target, path: string): AiRule | null {
    return this.rules(mountId).find((r) => r.target === target && (target === 'mount' || r.path === path)) ?? null;
  }

  /** One rule per target: setting again replaces the level/cloud flag. */
  set(input: { mountId: string; target: Target; path: string; level: AiLevel; cloud: boolean }): AiRule {
    const { mountId, target, level } = input;
    if (!(AI_LEVELS as readonly string[]).includes(level)) throw new AiRuleError('Unbekannte Stufe');
    if (!['mount', 'folder', 'note'].includes(target)) throw new AiRuleError('Unbekanntes Ziel');
    const path = target === 'mount' ? '' : input.path;
    if (target === 'folder' && !path) throw new AiRuleError('Ordner fehlt');
    let noteId: string | null = null;
    if (target === 'note') {
      noteId = (this.db.prepare('SELECT id FROM note_ids WHERE mount_id = ? AND path = ?').get(mountId, path) as { id: string } | undefined)?.id ?? null;
      if (!noteId) throw new AiRuleError('Notiz hat keine id (Metadaten aus?) – Freigabe über den Ordner');
    }
    const existing = this.ruleAt(mountId, target, path);
    const id = existing?.id ?? ulid();
    this.db
      .prepare('INSERT OR REPLACE INTO ai_rules (id, mount_id, target, path, note_id, level, cloud, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, mountId, target, target === 'note' ? '' : path, noteId, level, input.cloud ? 1 : 0, existing?.createdAt ?? now());
    this.invalidate(mountId);
    return this.rules(mountId).find((r) => r.id === id)!;
  }

  /** A source was removed: its releases point nowhere any more (ACL rules go by foreign key). */
  removeMount(mountId: string) {
    this.db.prepare('DELETE FROM ai_rules WHERE mount_id = ?').run(mountId);
    this.invalidate(mountId);
  }

  remove(id: string) {
    const row = this.db.prepare('SELECT mount_id FROM ai_rules WHERE id = ?').get(id) as { mount_id: string } | undefined;
    this.db.prepare('DELETE FROM ai_rules WHERE id = ?').run(id);
    if (row) this.invalidate(row.mount_id);
  }

  /** Folder rules follow a folder moved in the app; `keep`: the folder is still there too – copied (as Acl.moved). */
  moved(mountId: string, from: string, to: string, toMountId = mountId, keep = false) {
    if (!from) return;
    const rows = this.db.prepare("SELECT id, path FROM ai_rules WHERE mount_id = ? AND target = 'folder'").all(mountId) as { id: string; path: string }[];
    const update = this.db.prepare('UPDATE ai_rules SET mount_id = ?, path = ? WHERE id = ?');
    const copy = this.db.prepare('INSERT INTO ai_rules (id, mount_id, target, path, note_id, level, cloud, created_at) SELECT ?, ?, target, ?, note_id, level, cloud, created_at FROM ai_rules WHERE id = ?');
    for (const r of rows) {
      if (!under(r.path, from)) continue;
      if (keep) copy.run(ulid(), toMountId, to + r.path.slice(from.length), r.id);
      else update.run(toMountId, to + r.path.slice(from.length), r.id);
    }
    this.invalidate(mountId);
    this.invalidate(toMountId);
  }

  /** Folder rules at or below `from` – after a move to another source that left nothing behind (copied before). */
  dropFolderRules(mountId: string, from: string) {
    if (!from) return;
    const rows = this.db.prepare("SELECT id, path FROM ai_rules WHERE mount_id = ? AND target = 'folder'").all(mountId) as { id: string; path: string }[];
    const del = this.db.prepare('DELETE FROM ai_rules WHERE id = ?');
    for (const r of rows) if (under(r.path, from)) del.run(r.id);
    this.invalidate(mountId);
  }

  /**
   * A note rule into another source (audit sec2-013…015): first as a rule on the note's new path – it closes the copy
   * from the start, also when the move fails half-way (the original keeps its own rule until the move succeeded).
   * Returns the copy's id.
   */
  copyAsPathRule(ruleId: string, toMountId: string, path: string): string {
    const id = ulid();
    this.db.prepare(`INSERT INTO ai_rules (id, mount_id, target, path, note_id, level, cloud, created_at) SELECT ?, ?, 'folder', ?, NULL, level, cloud, created_at FROM ai_rules WHERE id = ?`).run(id, toMountId, path, ruleId);
    this.invalidate(toMountId);
    return id;
  }

  /** …then, once the new place is indexed, a note rule again: it follows the note's id there (renames). */
  pathRuleToNote(ruleId: string, mountId: string, noteId: string) {
    this.db.prepare("UPDATE ai_rules SET target = 'note', note_id = ?, path = '' WHERE id = ?").run(noteId, ruleId);
    this.invalidate(mountId);
  }

  /** What the assistant may do with `path` ('' = the source; folders with `isDir`). */
  grant(mountId: string, path: string, isDir = false): AiGrant {
    return this.decide(this.matching(mountId, path, isDir)).grant;
  }

  /** What would apply at a place without its own rule, and which rule decides that (null: no rule above). */
  inherited(mountId: string, target: Target, path: string): AiGrant & { from: { target: Target; path: string } | null } {
    const own = this.ruleAt(mountId, target, path);
    const { grant, from } = this.decide(this.matching(mountId, path, target !== 'note').filter((r) => r.id !== own?.id));
    return { ...grant, from: from && { target: from.target, path: from.path } };
  }

  private matching(mountId: string, path: string, isDir: boolean): AiRule[] {
    return this.rules(mountId).filter((r) => {
      if (r.orphan) return false;
      if (r.target === 'mount') return true;
      if (r.target === 'note') return !isDir && r.path === path;
      return under(path, r.path);
    });
  }

  private decide(matching: AiRule[]): { grant: AiGrant; from: AiRule | null } {
    const depth = (r: AiRule) => (r.target === 'mount' ? 0 : r.target === 'note' ? Number.MAX_SAFE_INTEGER : r.path.split('/').length);
    const nearest = (rules: AiRule[]) => rules.reduce((a, b) => (depth(b) > depth(a) ? b : a));
    // Any block wins; `from` names the nearest one (removing it alone may not be enough, but it is the first to look at).
    const blocks = matching.filter((r) => r.level === 'none');
    if (!matching.length || blocks.length) return { grant: { level: 'none', cloud: false }, from: blocks.length ? nearest(blocks) : null };
    const top = nearest(matching);
    return { grant: { level: top.level, cloud: top.cloud }, from: top };
  }

  /** Whether anything below `folder` is released at all (to skip whole sources quickly). */
  anyReleased(mountId: string): boolean {
    return this.rules(mountId).some((r) => !r.orphan && r.level !== 'none');
  }
}
