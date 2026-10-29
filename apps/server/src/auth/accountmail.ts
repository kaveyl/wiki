// Everything that sends account mail (AD-030): „Passwort vergessen“, invitations of new users,
// sharing a note, folder or source (→ guest account with that access), notice after a password change.
// Tokens are random, sent once in the link's URL fragment and stored only as SHA-256.

import { createHash, randomBytes } from 'node:crypto';
import { now, type DB } from '../db/db.js';
import { type Acl, type Level, type Target, atLeast } from '../acl/acl.js';
import type { Mailer } from '../mail/mailer.js';
import { userLang } from '../i18n/index.js';
import type { Lang } from '@kaveyl-wiki/core';
import { AuthError, FailureLimit, normEmail, validEmail, type AuthService, type User } from './auth.js';

const RESET_MINUTES = 30;
const INVITE_DAYS = 7;
const HOUR = 3_600_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** App link of a note, like the address bar shows it (Shell.tsx). */
export const noteLink = (mountId: string, path: string) => `n/${mountId}/${path.split('/').map(encodeURIComponent).join('/')}`;
/** App link that shows a folder or a whole source in the tree (Shell.tsx). */
export const treeLink = (mountId: string, path: string) => `t/${mountId}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** What can be shared by e-mail, and how far: guests never get „verwalten“. */
export type ShareLevel = 'read' | 'write';
export interface ShareInput {
  email: string;
  mountId: string;
  target: Target;
  /** Note or folder path; '' for a whole source. */
  path: string;
  level: ShareLevel;
  displayName?: string;
  /** Further notes and folders of the same source, shared in one go (several marked in the tree, owner 28.10.). */
  more?: { target: 'note' | 'folder'; path: string }[];
}

export type TokenKind = 'reset' | 'invite';

interface InvitePayload {
  displayName?: string;
  isAdmin?: boolean;
  isGuest?: boolean;
  /** Sharing: access to this note (by ID, survives renames) … */
  mountId?: string;
  noteId?: string;
  /** … or to this folder ('' = the whole source). */
  folder?: string;
  /** Missing in older invitations: read. */
  level?: ShareLevel;
  inviter?: string;
  /** Further notes (by ID) and folders of the same source, from a share of several marked ones. */
  more?: { noteId?: string; folder?: string }[];
}

interface TokenRow {
  token_hash: string;
  kind: TokenKind;
  email: string;
  user_id: string | null;
  payload: string;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
}

/** What the page behind a mail link may show before anything is done. */
export interface TokenInfo {
  kind: TokenKind;
  email: string;
  displayName: string;
  /** Invitation to a note: its name and who invited. */
  note?: string;
  /** Invitation to a folder or a whole source: its name, and which of the two. */
  folder?: string;
  source?: string;
  /** What sharing grants: read or write. */
  level?: ShareLevel;
  inviter?: string;
  /** Invitation, but the address has an account by now: confirm with its password instead. */
  accountExists: boolean;
}

export class AccountMail {
  private resetPerEmail = new FailureLimit(3, HOUR);
  private resetPerIp = new FailureLimit(10, HOUR);
  private invitesPerUser = new FailureLimit(30, HOUR);
  private acceptPerIp = new FailureLimit(20, HOUR);

  constructor(
    private readonly db: DB,
    private readonly auth: AuthService,
    private readonly acl: Acl,
    private readonly mailer: Mailer,
    private readonly log: (level: 'info' | 'warn', action: string, message: string, actor?: string | null) => void,
  ) {}

  private notePath(mountId: string, noteId: string): string | null {
    return (this.db.prepare('SELECT path FROM note_ids WHERE mount_id = ? AND id = ?').get(mountId, noteId) as { path: string } | undefined)?.path ?? null;
  }

  private noteName(mountId: string, noteId: string): string {
    const path = this.notePath(mountId, noteId);
    return path ? path.split('/').pop()!.replace(/\.md$/i, '') : 'eine Notiz';
  }

  private mountName(mountId: string): string {
    return (this.db.prepare('SELECT name FROM mounts WHERE id = ?').get(mountId) as { name: string } | undefined)?.name ?? 'eine Quelle';
  }

  private folderExists(mountId: string, path: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM entries WHERE mount_id = ? AND path = ? AND kind = 'dir'").get(mountId, path);
  }

  /** How a share is named in mails and on the invitation page. */
  private sharedThing(p: InvitePayload): { what: 'note' | 'folder' | 'source'; name: string } | null {
    if (!p.mountId) return null;
    if (p.noteId) return { what: 'note', name: this.noteName(p.mountId, p.noteId) };
    if (p.folder === undefined) return null;
    return p.folder ? { what: 'folder', name: p.folder.split('/').pop()! } : { what: 'source', name: this.mountName(p.mountId) };
  }

  private issue(kind: TokenKind, email: string, userId: string | null, payload: InvitePayload, createdBy: string | null): string {
    const token = randomBytes(32).toString('base64url');
    const ms = kind === 'reset' ? RESET_MINUTES * 60_000 : INVITE_DAYS * 24 * HOUR;
    this.db
      .prepare('INSERT INTO email_tokens (token_hash, kind, email, user_id, payload, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), kind, email, userId, JSON.stringify(payload), createdBy, now(), new Date(Date.now() + ms).toISOString());
    return token;
  }

  private row(token: string): TokenRow | null {
    if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(sha256(token)) as TokenRow | undefined;
    if (!row || row.used_at || row.expires_at <= now()) return null;
    // An invitation ends with the account that sent it (deleteUser removes them; this covers older ones).
    if (row.created_by && !this.auth.getUser(row.created_by)) return null;
    return row;
  }

  purgeExpired() {
    this.db.prepare('DELETE FROM email_tokens WHERE expires_at <= ? OR used_at IS NOT NULL').run(new Date(Date.now() - 7 * 24 * HOUR).toISOString());
  }

  // ── Passwort vergessen ──────────────────────────────────────────────────────────────

  /**
   * Always behaves the same to the caller (no way to probe addresses); a mail goes out only
   * for an active account with that address, and only a few times per hour.
   */
  async requestReset(rawEmail: string, ip: string): Promise<void> {
    const email = normEmail(rawEmail);
    if (!validEmail(email)) return;
    if (!this.resetPerIp.hit(ip) || !this.resetPerEmail.hit(email)) {
      this.log('warn', 'password-reset-throttled', 'Passwort vergessen: zu viele Anfragen, gebremst');
      return;
    }
    const user = this.auth.userByEmail(email);
    if (!user || user.disabled) return;
    if (!this.mailer.configured()) {
      this.log('warn', 'password-reset-no-mail', `Passwort vergessen für „${user.username}“: E-Mail-Versand ist nicht eingerichtet`, user.username);
      return;
    }
    // Only the newest link works.
    this.db.prepare("DELETE FROM email_tokens WHERE kind = 'reset' AND user_id = ?").run(user.id);
    const token = this.issue('reset', email, user.id, {}, null);
    try {
      await this.mailer.send({
        to: email,
        subject: 'Kaveyl Wiki: Passwort zurücksetzen',
        text: `Hallo ${user.displayName},\n\njemand (hoffentlich du) möchte das Passwort deines Kaveyl-Wiki-Kontos zurücksetzen. Der Link gilt ${RESET_MINUTES} Minuten und nur einmal.\n\nWenn du das nicht warst, ignoriere diese Nachricht einfach – dein Passwort bleibt unverändert.`,
        action: { label: 'Neues Passwort festlegen', url: this.mailer.link(`#reset=${token}`) },
      });
      this.log('info', 'password-reset-mail', `Link zum Zurücksetzen verschickt an „${user.username}“`, user.username);
    } catch (e) {
      this.log('warn', 'password-reset-mail-failed', `Passwort vergessen: ${e instanceof Error ? e.message : String(e)}`, user.username);
    }
  }

  // ── Links aus Mails ─────────────────────────────────────────────────────────────────

  info(token: string): TokenInfo | null {
    const row = this.row(token);
    if (!row) return null;
    const p = JSON.parse(row.payload) as InvitePayload;
    const user = row.user_id ? this.auth.getUser(row.user_id) : this.auth.userByEmail(row.email);
    const shared = this.sharedThing(p);
    return {
      kind: row.kind,
      email: row.email,
      displayName: user?.displayName ?? p.displayName ?? '',
      ...(shared ? { [shared.what]: shared.name, level: p.level ?? 'read' } : {}),
      inviter: p.inviter,
      accountExists: row.kind === 'invite' && !!user,
    };
  }

  /** „Passwort vergessen“ link: sets the password, ends all sessions, uses the link up. */
  async resetPassword(token: string, password: string, ip: string): Promise<User> {
    if (!this.acceptPerIp.hit(ip)) throw new AuthError('Zu viele Versuche – bitte später noch einmal');
    const row = this.row(token);
    if (!row || row.kind !== 'reset' || !row.user_id) throw new AuthError('Der Link ist ungültig oder abgelaufen');
    const user = this.auth.getUser(row.user_id);
    if (!user || user.disabled) throw new AuthError('Der Link ist ungültig oder abgelaufen');
    await this.auth.setOwnPassword(user.id, password);
    this.db.prepare("DELETE FROM email_tokens WHERE kind = 'reset' AND user_id = ?").run(user.id);
    this.log('info', 'password-reset', `Passwort über E-Mail-Link neu gesetzt: ${user.username}`, user.username);
    void this.passwordChanged(user);
    return this.auth.getUser(user.id)!;
  }

  /**
   * Invitation link: creates the account (name + password) — a guest when something was shared — and
   * grants what was shared. If the address has an account by now, its password confirms instead.
   */
  async accept(
    token: string,
    input: { displayName?: string; password: string },
    ip: string,
  ): Promise<{ user: User; note?: { mountId: string; path: string }; folder?: { mountId: string; path: string } }> {
    if (!this.acceptPerIp.hit(ip)) throw new AuthError('Zu viele Versuche – bitte später noch einmal');
    const row = this.row(token);
    if (!row || row.kind !== 'invite') throw new AuthError('Die Einladung ist ungültig oder abgelaufen');
    const p = JSON.parse(row.payload) as InvitePayload;
    let user: User | null = this.auth.userByEmail(row.email);
    if (user) {
      const ok = await this.auth.login(row.email, input.password);
      if (!ok) throw new AuthError('Für diese E-Mail gibt es schon ein Konto – bitte dessen Passwort eingeben');
      user = ok;
    } else {
      user = await this.auth.createUser({
        email: row.email,
        displayName: input.displayName?.trim() || p.displayName,
        password: input.password,
        isAdmin: !!p.isAdmin,
        isGuest: !!p.isGuest,
      });
    }
    // Only what the person who invited may still share there (audit 28.10. sec-004): rights or places can change in 14 days.
    const inviter = row.created_by ? this.auth.getUser(row.created_by) : null;
    const mayShare = (path: string, isDir: boolean) => !!inviter && !inviter.disabled && this.acl.level(inviter, p.mountId!, path, isDir) === 'admin';
    let note: { mountId: string; path: string } | undefined;
    let folder: { mountId: string; path: string } | undefined;
    if (p.mountId && p.noteId) {
      const path = this.notePath(p.mountId, p.noteId);
      // With further ones, a first one that is gone is left out like them (audit 28.10. code-008).
      if (!path && !p.more?.length) throw new AuthError('Die Notiz gibt es nicht mehr');
      if (path && !mayShare(path, false)) {
        if (!p.more?.length) throw new AuthError('Wer eingeladen hat, darf das inzwischen nicht mehr freigeben');
      } else if (path) {
        this.grant(user, { mountId: p.mountId, target: 'note', path, level: p.level ?? 'read' });
        note = { mountId: p.mountId, path };
      }
    } else if (p.mountId && p.folder !== undefined) {
      if (!mayShare(p.folder, true)) throw new AuthError('Wer eingeladen hat, darf das inzwischen nicht mehr freigeben');
      this.grant(user, { mountId: p.mountId, target: p.folder ? 'folder' : 'mount', path: p.folder, level: p.level ?? 'read' });
      folder = { mountId: p.mountId, path: p.folder };
    }
    // Further ones of a share of several: what is gone by now is left out (the first one says whether it worked).
    for (const m of p.mountId ? (p.more ?? []) : []) {
      const path = m.noteId ? this.notePath(p.mountId!, m.noteId) : m.folder;
      if (!path || (m.folder && !this.folderExists(p.mountId!, m.folder)) || !mayShare(path, !m.noteId)) continue;
      this.grant(user, { mountId: p.mountId!, target: m.noteId ? 'note' : 'folder', path, level: p.level ?? 'read' });
    }
    this.db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
    this.log('info', 'invite-accepted', `Einladung angenommen: ${user.username}${user.isGuest ? ' (Gast)' : ''}`, user.username);
    return { user, note, folder };
  }

  // ── Einladungen ─────────────────────────────────────────────────────────────────────

  /** Admin invites a new person; the account appears only when they accept. */
  async inviteUser(input: { email: string; displayName?: string; isAdmin?: boolean; isGuest?: boolean }, by: User, uiLang?: Lang): Promise<void> {
    const email = normEmail(input.email ?? '');
    if (!validEmail(email)) throw new AuthError('Bitte eine gültige E-Mail-Adresse angeben');
    if (this.auth.userByEmail(email)) throw new AuthError('Diese E-Mail-Adresse hat schon ein Konto');
    this.requireMail(by);
    // A new invitation replaces an open one for the same address.
    this.db.prepare("DELETE FROM email_tokens WHERE kind = 'invite' AND email = ? AND used_at IS NULL AND payload NOT LIKE '%\"mountId\"%'").run(email);
    const token = this.issue('invite', email, null, { displayName: input.displayName?.trim() || undefined, isAdmin: !!input.isAdmin, isGuest: !!input.isGuest && !input.isAdmin, inviter: by.displayName }, by.id);
    await this.mailer.send({
      to: email,
      // A new person has no language yet: the inviter's (AD-046) – chosen, else the one of their interface.
      lang: userLang(this.db, by.id) ?? uiLang,
      subject: `${by.displayName} lädt dich zu Kaveyl Wiki ein`,
      text: `Hallo${input.displayName?.trim() ? ` ${input.displayName.trim()}` : ''},\n\n${by.displayName} hat für dich ein Konto in Kaveyl Wiki vorbereitet. Leg über den Link dein Passwort fest – danach meldest du dich mit dieser E-Mail-Adresse an.\n\nDer Link gilt ${INVITE_DAYS} Tage.`,
      action: { label: 'Konto einrichten', url: this.mailer.link(`#invite=${token}`) },
    });
  }

  /**
   * Shares a note, a folder or a whole source with an address – read, or read and write. Existing account: access now
   * (never less than before: a rule here would otherwise downgrade someone who may do more) and a notice mail.
   * Otherwise an invitation; accepting creates a guest account.
   */
  async share(input: ShareInput, by: User, uiLang?: Lang): Promise<{ existing: boolean }> {
    const email = normEmail(input.email ?? '');
    if (!validEmail(email)) throw new AuthError('Bitte eine gültige E-Mail-Adresse angeben');
    if (by.isGuest) throw new AuthError('Gäste können niemanden einladen');
    if (input.level !== 'read' && input.level !== 'write') throw new AuthError('Unbekannte Stufe');
    if (!this.invitesPerUser.hit(by.id)) throw new AuthError('Zu viele Einladungen in kurzer Zeit – bitte später noch einmal');
    const payload: InvitePayload = { mountId: input.mountId, level: input.level, inviter: by.displayName };
    if (input.target === 'note') {
      payload.noteId = (this.db.prepare('SELECT id FROM note_ids WHERE mount_id = ? AND path = ?').get(input.mountId, input.path) as { id: string } | undefined)?.id;
      if (!payload.noteId) throw new AuthError('Notiz nicht gefunden');
    } else if (input.target === 'folder') {
      if (!input.path || !this.folderExists(input.mountId, input.path)) throw new AuthError('Ordner nicht gefunden');
      payload.folder = input.path;
    } else payload.folder = '';
    const more = (input.more ?? []).map((m): { target: 'note' | 'folder'; path: string; name: string; noteId?: string; folder?: string } => {
      if (m.target === 'note') {
        const noteId = (this.db.prepare('SELECT id FROM note_ids WHERE mount_id = ? AND path = ?').get(input.mountId, m.path) as { id: string } | undefined)?.id;
        if (!noteId) throw new AuthError('Notiz nicht gefunden');
        return { noteId, name: this.noteName(input.mountId, noteId), ...m };
      }
      if (!m.path || !this.folderExists(input.mountId, m.path)) throw new AuthError('Ordner nicht gefunden');
      return { folder: m.path, name: m.path.split('/').pop()!, ...m };
    });
    if (more.length) payload.more = more.map((m) => (m.noteId ? { noteId: m.noteId } : { folder: m.folder }));
    this.requireMail(by);
    const thing = this.sharedThing(payload)!;
    // Whole sentences per kind, so that every paragraph translates (mailer: line by line).
    const subjects: { several?: string; text?: string } = {};
    const subject = {
      note: `${by.displayName} hat die Notiz „${thing.name}“ mit dir geteilt`,
      folder: `${by.displayName} hat den Ordner „${thing.name}“ mit dir geteilt`,
      source: `${by.displayName} hat die Quelle „${thing.name}“ mit dir geteilt`,
    }[thing.what];
    const n = thing.name;
    const shared = {
      note: `${by.displayName} hat die Notiz „${n}“ in Kaveyl Wiki mit dir geteilt.`,
      folder: `${by.displayName} hat den Ordner „${n}“ in Kaveyl Wiki mit dir geteilt, mit allem, was darin liegt.`,
      source: `${by.displayName} hat die Quelle „${n}“ in Kaveyl Wiki mit dir geteilt, mit allem, was darin liegt.`,
    }[thing.what];
    const show = {
      note: `${by.displayName} möchte dir die Notiz „${n}“ in Kaveyl Wiki zeigen.`,
      folder: `${by.displayName} möchte dir den Ordner „${n}“ in Kaveyl Wiki zeigen, mit allem, was darin liegt.`,
      source: `${by.displayName} möchte dir die Quelle „${n}“ in Kaveyl Wiki zeigen, mit allem, was darin liegt.`,
    }[thing.what];
    const may = input.level === 'write' ? 'Du darfst dort lesen und bearbeiten.' : 'Du darfst dort lesen.';
    if (more.length) {
      // Several at once: one mail naming them all.
      const count = more.length + 1;
      const notesOnly = input.target === 'note' && more.every((m) => m.target === 'note');
      const list = [thing.name, ...more.map((m) => m.name)].map((x) => `„${x}“`).join(', ');
      subjects.several = notesOnly ? `${by.displayName} hat ${count} Notizen mit dir geteilt` : `${by.displayName} hat ${count} Notizen und Ordner mit dir geteilt`;
      subjects.text = notesOnly
        ? `${by.displayName} hat ${count} Notizen in Kaveyl Wiki mit dir geteilt: ${list}.`
        : `${by.displayName} hat ${count} Notizen und Ordner in Kaveyl Wiki mit dir geteilt: ${list}.`;
    }
    const topic = subjects.several ?? subject;
    const existing = this.auth.userByEmail(email);
    if (existing) {
      if (existing.disabled) throw new AuthError('Dieses Konto ist gesperrt');
      this.grant(existing, input);
      for (const m of more) this.grant(existing, { mountId: input.mountId, target: m.target, path: m.path, level: input.level });
      const one = input.target === 'note' && !more.length;
      const where = one ? noteLink(input.mountId, input.path) : treeLink(input.mountId, more.length ? '' : input.path);
      await this.mailer.send({
        to: email,
        subject: topic,
        text: `Hallo ${existing.displayName},\n\n${subjects.text ?? shared}\n\n${may}`,
        action: { label: one ? 'Notiz öffnen' : 'In Kaveyl Wiki zeigen', url: this.mailer.link(where) },
      });
      return { existing: true };
    }
    const token = this.issue('invite', email, null, { ...payload, displayName: input.displayName?.trim() || undefined, isGuest: true }, by.id);
    await this.mailer.send({
      to: email,
      lang: userLang(this.db, by.id) ?? uiLang,
      subject: topic,
      text: `Hallo,\n\n${subjects.text ?? show}\n\n${may}\n\nLeg dafür über den Link ein Passwort fest – danach meldest du dich mit dieser E-Mail-Adresse an.\n\nDer Link gilt ${INVITE_DAYS} Tage.`,
      action: { label: input.target === 'note' && !more.length ? 'Notiz ansehen' : 'Ansehen', url: this.mailer.link(`#invite=${token}`) },
    });
    return { existing: false };
  }

  /** Access to a note, folder or source, without ever lowering what the person has already or lifting a lock. */
  private grant(user: User, at: { mountId: string; target: Target; path: string; level: Level }) {
    const isDir = at.target !== 'note';
    const path = at.target === 'mount' ? '' : at.path;
    if (at.target === 'folder' && !this.folderExists(at.mountId, path)) throw new AuthError('Den Ordner gibt es nicht mehr');
    if (atLeast(this.acl.level(user, at.mountId, path, isDir), at.level)) return;
    const own = this.acl.rulesAt(at.mountId, at.target, path).find((r) => r.subject === 'user' && r.subjectId === user.id);
    // Their own „Kein Zugriff“ right here: the share would replace it – a lock is never lifted that way.
    if (own?.level === 'none') {
      const place = { note: 'die Notiz', folder: 'den Ordner', mount: 'die Quelle' }[at.target];
      throw new AuthError(`Diese Person ist für ${place} gesperrt – die Sperre lässt sich nur unter „Berechtigungen“ aufheben`);
    }
    const rule = this.acl.addRule({ mountId: at.mountId, target: at.target, path, subject: 'user', subjectId: user.id, level: at.level });
    // A lock („Kein Zugriff“ for them or a group, AD-020) still wins — then the share cannot work: back to how it was.
    if (!atLeast(this.acl.level(user, at.mountId, path, isDir), at.level)) {
      if (own) this.acl.addRule({ mountId: at.mountId, target: at.target, path, subject: 'user', subjectId: user.id, level: own.level });
      else this.acl.removeRule(rule.id);
      throw new AuthError(at.target === 'mount' ? 'Diese Person ist für die Quelle gesperrt – die Freigabe würde nicht greifen' : 'Diese Person ist für den Ordner gesperrt – die Freigabe würde nicht greifen');
    }
  }

  private requireMail(by: User) {
    if (!this.mailer.configured()) {
      throw new AuthError(by.isAdmin ? 'E-Mail-Versand ist nicht eingerichtet (Einstellungen → Benachrichtigungen → E-Mail)' : 'E-Mail-Versand ist nicht eingerichtet – bitte den Administrator fragen');
    }
  }

  // ── Hinweise ────────────────────────────────────────────────────────────────────────

  /** „Dein Passwort wurde geändert“ — best effort, never blocks the change itself. */
  async passwordChanged(user: User): Promise<void> {
    if (!this.mailer.configured() || !validEmail(user.email)) return;
    try {
      await this.mailer.send({
        to: user.email,
        subject: 'Kaveyl Wiki: Dein Passwort wurde geändert',
        text: `Hallo ${user.displayName},\n\ndas Passwort deines Kaveyl-Wiki-Kontos wurde gerade geändert; alle anderen Anmeldungen wurden beendet.\n\nWarst du das nicht? Dann setz es sofort über „Passwort vergessen?“ auf der Anmeldeseite zurück und sag dem Administrator Bescheid.`,
        action: { label: 'Zur Anmeldung', url: this.mailer.link('') },
      });
    } catch (e) {
      this.log('warn', 'password-notice-failed', `Hinweis „Passwort geändert“ nicht verschickt: ${e instanceof Error ? e.message : String(e)}`, user.username);
    }
  }
}
