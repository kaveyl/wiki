// Access control (AD-020): groups, rules on a source / folder / note, and their evaluation.
// Every route asks `level()` (via one helper in app.ts) before touching a note; lists are
// filtered with the same function. Rules live in the app DB, never in the repository.
import { ulid } from 'ulid';
import type { DB } from '../db/db.js';
import { now } from '../db/db.js';

export const LEVELS = ['none', 'read', 'write', 'admin'] as const;
export type Level = (typeof LEVELS)[number];
export const rank = (l: Level) => LEVELS.indexOf(l);
export const atLeast = (have: Level, need: Level) => rank(have) >= rank(need);

export type Target = 'mount' | 'folder' | 'note';
export type Subject = 'all' | 'group' | 'user';

export interface Rule {
  id: string;
  mountId: string;
  target: Target;
  /** Folder path, or the note's current path (resolved from its id); '' for the source. */
  path: string;
  noteId: string | null;
  subject: Subject;
  subjectId: string | null;
  level: Level;
  createdAt: string;
  /** Note rule whose note no longer exists (or folder rule after a rename outside the app). */
  orphan?: boolean;
}

export interface Group {
  id: string;
  name: string;
  members: string[];
}

export class AclError extends Error {}

/** Who asks: system admins always get `admin`. */
export interface Principal {
  id: string;
  isAdmin: boolean;
  /** Guests (AD-030): neither the default level nor rules for „Alle“ apply — only their own and their groups'.
   *  They never get `admin` (AD-048): such a rule works like `write`. */
  isGuest?: boolean;
}

interface RuleRow {
  id: string;
  mount_id: string;
  target: Target;
  path: string;
  note_id: string | null;
  subject: Subject;
  subject_id: string | null;
  level: Level;
  created_at: string;
}

const under = (path: string, folder: string) => folder === '' || path === folder || path.startsWith(folder + '/');

export class Acl {
  private rulesCache = new Map<string, Rule[]>();
  private groupsCache = new Map<string, Set<string>>();

  constructor(
    private db: DB,
    /** Level when no rule applies (setting `acl_default`). */
    readonly defaultLevel: () => Level,
  ) {}

  /** Call after anything that changes note paths (index updates, moves). */
  invalidate(mountId?: string) {
    if (mountId) this.rulesCache.delete(mountId);
    else this.rulesCache.clear();
  }

  // ── Groups ─────────────────────────────────────────────────────────────────────
  groups(): Group[] {
    const groups = this.db.prepare('SELECT id, name FROM groups ORDER BY name COLLATE NOCASE').all() as { id: string; name: string }[];
    const members = this.db.prepare('SELECT group_id, user_id FROM group_members').all() as { group_id: string; user_id: string }[];
    return groups.map((g) => ({ ...g, members: members.filter((m) => m.group_id === g.id).map((m) => m.user_id) }));
  }

  createGroup(name: string): Group {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new AclError('Name fehlt');
    if (this.db.prepare('SELECT 1 FROM groups WHERE name = ?').get(clean)) throw new AclError(`Gruppe „${clean}“ gibt es schon`);
    const id = ulid();
    this.db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, clean, now());
    return { id, name: clean, members: [] };
  }

  renameGroup(id: string, name: string) {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new AclError('Name fehlt');
    const other = this.db.prepare('SELECT id FROM groups WHERE name = ?').get(clean) as { id: string } | undefined;
    if (other && other.id !== id) throw new AclError(`Gruppe „${clean}“ gibt es schon`);
    if (!this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(clean, id).changes) throw new AclError('Gruppe nicht gefunden');
  }

  deleteGroup(id: string) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM acl_rules WHERE subject = 'group' AND subject_id = ?").run(id);
      this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    })();
    this.groupsCache.clear();
    this.rulesCache.clear();
  }

  setMembers(groupId: string, userIds: string[]) {
    if (!this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) throw new AclError('Gruppe nicht gefunden');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
      const add = this.db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) SELECT ?, id FROM users WHERE id = ?');
      for (const u of new Set(userIds)) add.run(groupId, u);
    })();
    this.groupsCache.clear();
  }

  private groupsOf(userId: string): Set<string> {
    let g = this.groupsCache.get(userId);
    if (!g) {
      g = new Set((this.db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[]).map((r) => r.group_id));
      this.groupsCache.set(userId, g);
    }
    return g;
  }

  /** Users removed or group membership changed elsewhere (user deletion cascades in the DB). */
  forgetUser(userId: string) {
    this.groupsCache.delete(userId);
    this.rulesCache.clear();
  }

  // ── Rules ──────────────────────────────────────────────────────────────────────
  rules(mountId: string): Rule[] {
    let rules = this.rulesCache.get(mountId);
    if (!rules) {
      const rows = this.db.prepare('SELECT * FROM acl_rules WHERE mount_id = ? ORDER BY created_at').all(mountId) as RuleRow[];
      const pathOf = this.db.prepare('SELECT path FROM note_ids WHERE mount_id = ? AND id = ?');
      rules = rows.map((r) => {
        const rule: Rule = { id: r.id, mountId: r.mount_id, target: r.target, path: r.path, noteId: r.note_id, subject: r.subject, subjectId: r.subject_id, level: r.level, createdAt: r.created_at };
        if (r.target === 'note') {
          const current = (pathOf.get(mountId, r.note_id) as { path: string } | undefined)?.path;
          if (current) rule.path = current;
          else rule.orphan = true;
        }
        return rule;
      });
      this.rulesCache.set(mountId, rules);
    }
    return rules;
  }

  /** Rules placed exactly on this target (for the permissions dialog). */
  rulesAt(mountId: string, target: Target, path: string): Rule[] {
    return this.rules(mountId).filter((r) => r.target === target && (target === 'mount' || r.path === path));
  }

  addRule(input: { mountId: string; target: Target; path: string; subject: Subject; subjectId: string | null; level: Level }): Rule {
    const { mountId, target, subject, level } = input;
    if (!(LEVELS as readonly string[]).includes(level)) throw new AclError('Unbekannte Stufe');
    if (!['mount', 'folder', 'note'].includes(target)) throw new AclError('Unbekanntes Ziel');
    const path = target === 'mount' ? '' : input.path;
    let noteId: string | null = null;
    if (target === 'note') {
      noteId = (this.db.prepare('SELECT id FROM note_ids WHERE mount_id = ? AND path = ?').get(mountId, path) as { id: string } | undefined)?.id ?? null;
      if (!noteId) throw new AclError('Notiz nicht gefunden');
    }
    if (target === 'folder' && !path) throw new AclError('Ordner fehlt');
    let subjectId = subject === 'all' ? null : input.subjectId;
    if (subject === 'group' && !this.db.prepare('SELECT 1 FROM groups WHERE id = ?').get(subjectId)) throw new AclError('Gruppe nicht gefunden');
    const user = subject === 'user' ? (this.db.prepare('SELECT is_guest FROM users WHERE id = ?').get(subjectId) as { is_guest: number } | undefined) : null;
    if (subject === 'user' && !user) throw new AclError('Benutzer nicht gefunden');
    if (user?.is_guest && level === 'admin') throw new AclError('Gäste können keine Rechte verwalten – höchstens lesen & schreiben');
    if (!['all', 'group', 'user'].includes(subject)) throw new AclError('Unbekanntes Subjekt');
    subjectId ??= null;
    // One rule per target and subject: a new level replaces the old one.
    const existing = this.rulesAt(mountId, target, path).find((r) => r.subject === subject && r.subjectId === subjectId);
    const id = existing?.id ?? ulid();
    this.db
      .prepare('INSERT OR REPLACE INTO acl_rules (id, mount_id, target, path, note_id, subject, subject_id, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, mountId, target, target === 'note' ? '' : path, noteId, subject, subjectId, level, existing?.createdAt ?? now());
    this.invalidate(mountId);
    return this.rules(mountId).find((r) => r.id === id)!;
  }

  rule(id: string): Rule | null {
    const row = this.db.prepare('SELECT mount_id FROM acl_rules WHERE id = ?').get(id) as { mount_id: string } | undefined;
    return row ? (this.rules(row.mount_id).find((r) => r.id === id) ?? null) : null;
  }

  removeRule(id: string) {
    const rule = this.rule(id);
    this.db.prepare('DELETE FROM acl_rules WHERE id = ?').run(id);
    if (rule) this.invalidate(rule.mountId);
  }

  /**
   * Folder rules follow a folder moved in the app (note rules follow the note id anyway). `keep`: the folder is still
   * there too (files a move to another source leaves behind) – the rules are copied, the old place stays protected
   * (audit sec2-012).
   */
  moved(mountId: string, from: string, to: string, toMountId = mountId, keep = false) {
    const rows = this.db.prepare("SELECT id, path FROM acl_rules WHERE mount_id = ? AND target = 'folder'").all(mountId) as { id: string; path: string }[];
    const update = this.db.prepare('UPDATE acl_rules SET mount_id = ?, path = ? WHERE id = ?');
    const copy = this.db.prepare(
      'INSERT INTO acl_rules (id, mount_id, target, path, note_id, subject, subject_id, level, created_at) SELECT ?, ?, target, ?, note_id, subject, subject_id, level, created_at FROM acl_rules WHERE id = ?',
    );
    for (const r of rows) {
      if (!under(r.path, from) || from === '') continue;
      if (keep) copy.run(ulid(), toMountId, to + r.path.slice(from.length), r.id);
      else update.run(toMountId, to + r.path.slice(from.length), r.id);
    }
    this.invalidate(mountId);
    this.invalidate(toMountId);
  }

  /** Folder rules at or below `from` – after a move to another source that left nothing behind (copied before). */
  dropFolderRules(mountId: string, from: string) {
    if (!from) return;
    const rows = this.db.prepare("SELECT id, path FROM acl_rules WHERE mount_id = ? AND target = 'folder'").all(mountId) as { id: string; path: string }[];
    const del = this.db.prepare('DELETE FROM acl_rules WHERE id = ?');
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
    this.db.prepare(`INSERT INTO acl_rules (id, mount_id, target, path, note_id, subject, subject_id, level, created_at) SELECT ?, ?, 'folder', ?, NULL, subject, subject_id, level, created_at FROM acl_rules WHERE id = ?`).run(id, toMountId, path, ruleId);
    this.invalidate(toMountId);
    return id;
  }

  /** …then, once the new place is indexed, a note rule again: it follows the note's id there (renames). */
  pathRuleToNote(ruleId: string, mountId: string, noteId: string) {
    this.db.prepare("UPDATE acl_rules SET target = 'note', note_id = ?, path = '' WHERE id = ?").run(noteId, ruleId);
    this.invalidate(mountId);
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────────
  /**
   * Effective level of `who` for `path` in a source (a note path, or a folder path with
   * `isDir`); '' is the source itself. See AD-020 for the order of the steps.
   */
  level(who: Principal, mountId: string, path: string, isDir = false): Level {
    if (who.isAdmin) return 'admin';
    const level = this.ruleLevel(who, mountId, path, isDir);
    return who.isGuest && level === 'admin' ? 'write' : level;
  }

  private ruleLevel(who: Principal, mountId: string, path: string, isDir: boolean): Level {
    const fallback = (): Level => (who.isGuest ? 'none' : this.defaultLevel());
    const rules = this.rules(mountId);
    if (!rules.length) return fallback();
    const applies = this.appliesTo(who);
    // Specificity: note rule (exact path) > folder rules by depth > source rule.
    const matching = rules.filter((r) => {
      if (r.orphan || !applies(r)) return false;
      if (r.target === 'mount') return true;
      if (r.target === 'note') return !isDir && r.path === path;
      return under(path, r.path);
    });
    if (matching.some((r) => r.level === 'none' && r.subject !== 'all')) return 'none';
    const depth = (r: Rule) => (r.target === 'mount' ? 0 : r.target === 'note' ? Number.MAX_SAFE_INTEGER : r.path.split('/').length);
    let best = -1;
    for (const r of matching) best = Math.max(best, depth(r));
    if (best < 0) return fallback();
    const top = matching.filter((r) => depth(r) === best);
    const pick = (list: Rule[]) => list.reduce<Level | null>((acc, r) => (acc === null || rank(r.level) > rank(acc) ? r.level : acc), null);
    return pick(top.filter((r) => r.subject === 'user')) ?? pick(top.filter((r) => r.subject === 'group')) ?? pick(top.filter((r) => r.subject === 'all'))!;
  }

  /**
   * The top of a source for one person, taken apart for the rights grid (owner 21.10.): their own rule there, and what
   * would apply without it and where that comes from – a group (the highest of theirs, or one that locks them out),
   * a rule for „Alle“, or the default level.
   */
  explainTop(who: Principal, mountId: string): { own: Level | null; inherited: Level; via: 'group' | 'all' | 'default' | null; viaId?: string; groupLock?: boolean } {
    const applies = this.appliesTo(who);
    const top = this.rules(mountId).filter((r) => !r.orphan && applies(r) && (r.target === 'mount' || (r.target === 'folder' && r.path === '')));
    const cap = (l: Level): Level => (who.isGuest && l === 'admin' ? 'write' : l);
    const own = top.find((r) => r.subject === 'user')?.level ?? null;
    const groups = top.filter((r) => r.subject === 'group');
    const lock = groups.find((r) => r.level === 'none');
    if (lock) return { own, inherited: 'none', via: 'group', viaId: lock.subjectId!, groupLock: true };
    const best = groups.reduce<Rule | null>((acc, r) => (!acc || rank(r.level) > rank(acc.level) ? r : acc), null);
    if (best) return { own, inherited: cap(best.level), via: 'group', viaId: best.subjectId! };
    const all = top.filter((r) => r.subject === 'all').reduce<Rule | null>((acc, r) => (!acc || rank(r.level) > rank(acc.level) ? r : acc), null);
    if (all) return { own, inherited: all.level, via: 'all' };
    if (who.isGuest || this.defaultLevel() === 'none') return { own, inherited: 'none', via: null };
    return { own, inherited: this.defaultLevel(), via: 'default' };
  }

  /** Whether any rule of this source (for anyone) sits below a folder – e.g. a closed note inside an open folder. */
  hasRulesBelow(mountId: string, folder: string): boolean {
    return this.rules(mountId).some((r) => r.target !== 'mount' && r.path !== folder && under(r.path, folder));
  }

  /**
   * Whether a rule for this person opens something below a folder they cannot read themselves – what makes a closed
   * source or folder show up in their tree. Rules for other people never do: their names stay hidden.
   */
  opensBelow(who: Principal, mountId: string, folder: string): boolean {
    const applies = this.appliesTo(who);
    return this.rules(mountId).some(
      (r) => !r.orphan && r.target !== 'mount' && r.path !== folder && under(r.path, folder) && applies(r) && this.level(who, mountId, r.path, r.target === 'folder') !== 'none',
    );
  }

  private appliesTo(who: Principal): (r: Rule) => boolean {
    const groups = this.groupsOf(who.id);
    return (r) => (r.subject === 'all' && !who.isGuest) || (r.subject === 'user' && r.subjectId === who.id) || (r.subject === 'group' && groups.has(r.subjectId!));
  }
}
