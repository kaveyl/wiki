// Local users and cookie sessions (Phase 1: single admin, created in the first-run setup).
// Passwords: scrypt (node:crypto, no native dependency). Session tokens are random and
// only their SHA-256 is stored. Login by e-mail, password policy, guests: AD-030.
// SEE-DOC: docs/PLAN.md §3, §3e

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import { passwordError, passwordTooLong, PROXY_PROVIDERS, type PasswordContext } from '@kaveyl-wiki/core';
import { now, type DB } from '../db/db.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
/** Without „Angemeldet bleiben“: browser-session cookie, and the server forgets it after a day. */
const SHORT_SESSION_HOURS = 24;
/** Accounts without a real address (created before AD-030) get this placeholder domain. */
export const PLACEHOLDER_DOMAIN = '@kaveyl-wiki.local';

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  disabled?: boolean;
  /** Sees only what is shared with them or their groups (AD-030). */
  isGuest?: boolean;
  /** Must set a new password before doing anything else. */
  mustChangePassword?: boolean;
  /** Last sign-in or use (browser or token), to the hour; null = never. */
  lastSeenAt?: string | null;
}

/** What a personal API token may do; a session (browser login) is not limited by scopes. */
/** `mcp` opens the MCP endpoint /mcp (writing tools also need `write`). */
export const TOKEN_SCOPES = ['read', 'write', 'mcp', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Set when an admin made (or renewed) the token for this person – they know its value (owner 28.10.). */
  createdBy: { id: string; name: string | null } | null;
}

/** A token in the admins' list of all tokens, with its person. */
export interface AdminTokenInfo extends TokenInfo {
  user: { id: string; username: string; displayName: string; isAdmin: boolean };
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string;
  password_hash: string;
  is_admin: number;
  disabled: number;
  is_guest: number;
  must_change_password: number;
  /** Only where the query joins `user_seen`. */
  last_seen_at?: string | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  email: r.email,
  isAdmin: r.is_admin === 1,
  disabled: r.disabled === 1,
  isGuest: r.is_guest === 1,
  mustChangePassword: r.must_change_password === 1,
  ...(r.last_seen_at !== undefined ? { lastSeenAt: r.last_seen_at } : {}),
});


const newApiToken = () => `kw_${randomBytes(30).toString('base64url')}`;

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  by_name: string | null;
  username: string;
  display_name: string;
  is_admin: number;
}
const TOKEN_SELECT = `SELECT t.*, u.username, u.display_name, u.is_admin, b.display_name AS by_name
  FROM api_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN users b ON b.id = t.created_by`;
const tokenInfoOf = (r: TokenRow): TokenInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes.split(' ') as TokenScope[],
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  createdBy: r.created_by ? { id: r.created_by, name: r.by_name } : null,
});

export class AuthError extends Error {}

export const normEmail = (raw: string) => raw.trim().toLowerCase();

/** A plausible address (the mail server has the last word); placeholders do not count. */
export function validEmail(raw: string): boolean {
  const e = normEmail(raw);
  // No comment, quote or list characters: a mail library would read `(a@b.example)` as no recipient at all (audit 28.10. sec-002).
  return e.length <= 254 && /^[^\s@()<>,;:"[\]\\]+@[^\s@()<>,;:"[\]\\]+\.[^\s@()<>,;:"[\]\\]+$/.test(e) && !e.endsWith(PLACEHOLDER_DOMAIN);
}

/** Policy check for a password being set (never at login: existing passwords stay valid, AD-048). */
function checkPassword(pw: string, context: PasswordContext) {
  const err = passwordError(pw, context);
  if (err) throw new AuthError(err);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, salt, key] = stored.split('$');
  if (algo !== 'scrypt' || !n || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Who a commit names: the display name and a made-up address from the account id – never the real e-mail, which would
 * stay in the history of every clone for good (also after the account is deleted). `.invalid` can never be delivered.
 */
export function commitAuthor(user: Pick<User, 'id' | 'displayName' | 'username'>): { name: string; email: string } {
  return { name: user.displayName || user.username, email: `${user.id.toLowerCase()}@users.kaveyl-wiki.invalid` };
}

/**
 * A display name as stored: control characters and line breaks (with the spaces around them) become one space (sec-004)
 * – the name ends up in commit trailers, mails and push messages, where a line break starts a new line of its own.
 * Invisible format characters go too (bidi overrides, zero-width spaces): they would make a name look like another one.
 * Kept: the zero-width (non-)joiner, which emoji and some scripts need.
 */
export function cleanDisplayName(name: string | undefined): string {
  return (name ?? '')
    .replace(/[\s\p{Cc}]*[\p{Cc}\p{Zl}\p{Zp}][\s\p{Cc}]*/gu, ' ')
    .replace(/(?![\u200c\u200d])\p{Cf}/gu, '')
    .trim();
}

export class AuthService {
  /** Called after sessions were removed (sign-out, lock, new password …): open live connections check theirs at once. */
  onSessionsEnded: (() => void) | null = null;

  constructor(private readonly db: DB) {}

  private ended() {
    this.onSessionsEnded?.();
  }

  hasUsers(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0;
  }

  /**
   * New account. The e-mail is the login and must be unique; the user name is derived from it
   * unless given. `mustChange` for passwords someone else chose (admin).
   */
  async createUser(input: { email: string; username?: string; displayName?: string; password: string; isAdmin?: boolean; isGuest?: boolean; mustChange?: boolean }): Promise<User> {
    const email = normEmail(input.email ?? '');
    if (!validEmail(email)) throw new AuthError('Bitte eine gültige E-Mail-Adresse angeben');
    if (this.byEmail(email)) throw new AuthError('Diese E-Mail-Adresse hat schon ein Konto');
    const username = input.username?.trim() || this.freeUsername(email);
    if (!/^[\p{L}\p{N}._-]{2,40}$/u.test(username)) throw new AuthError('Benutzername: 2–40 Zeichen, Buchstaben, Ziffern, . _ -');
    if (this.isUsername(username)) throw new AuthError('Benutzername ist schon vergeben');
    checkPassword(input.password, [email, username, input.displayName]);
    const id = ulid();
    this.db
      .prepare('INSERT INTO users (id, username, display_name, email, password_hash, is_admin, is_guest, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, username, cleanDisplayName(input.displayName) || username, email, await hashPassword(input.password), input.isAdmin ? 1 : 0, input.isGuest && !input.isAdmin ? 1 : 0, input.mustChange ? 1 : 0, now());
    return this.getUser(id)!;
  }

  /** „maria.muster@firma.de“ → „maria.muster“ (or „maria.muster2“ …), always a valid, free name. */
  private freeUsername(email: string): string {
    let base = email.split('@')[0]!.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 36);
    if (base.length < 2) base = `user${base}`;
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}${i}`;
      if (!this.isUsername(name)) return name;
    }
  }

  private byEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(normEmail(email)) as UserRow | undefined;
  }

  /** E-mail, user name and display name of an account: a new password must not be built from them. */
  private contextOf(id: string): PasswordContext {
    const u = this.getUser(id);
    return u ? [u.email, u.username, u.displayName] : [];
  }

  /** The account of an address (also locked ones), or null. */
  userByEmail(email: string): User | null {
    const row = this.byEmail(email);
    return row ? toUser(row) : null;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** True if an account with this name exists (to log failed logins without echoing arbitrary input). */
  isUsername(username: string): boolean {
    return this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim()) !== undefined;
  }

  /** Login by e-mail. The policy is not checked here: existing passwords stay valid (AD-048). */
  async login(email: string, password: string): Promise<User | null> {
    const r = await this.checkLogin(email, password);
    return r === 'locked' ? null : r;
  }

  /**
   * Like `login`, but a locked account with the right password is told apart ('locked'): only whoever knows the
   * password learns of the lock. Wrong password and unknown address stay alike (null), in answer and in time.
   */
  async checkLogin(email: string, password: string): Promise<User | 'locked' | null> {
    const row = this.byEmail(email);
    // Always run scrypt so response time does not reveal whether the user exists.
    const ok = await verifyPassword(password, row?.password_hash ?? 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!row || !ok) return null;
    if (row.disabled) return 'locked';
    return this.getUser(row.id);
  }

  /** Changes the password after verifying the current one; ends all other sessions of the user. */
  async changePassword(userId: string, current: string, next: string, keepToken?: string): Promise<boolean> {
    // Overlong input is refused before any costly work.
    if (passwordTooLong(next)) checkPassword(next, []);
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
    if (!row || !(await verifyPassword(current, row.password_hash))) return false;
    checkPassword(next, this.contextOf(userId));
    if (next === current) throw new AuthError('Das neue Passwort muss sich vom bisherigen unterscheiden');
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(next), userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256(keepToken) : '');
    this.ended();
    return true;
  }

  /** New password chosen by the user via a mail link (reset/invitation): every session ends. */
  async setOwnPassword(userId: string, password: string): Promise<void> {
    checkPassword(password, this.contextOf(userId));
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(password), userId);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.dropProxyLinks(userId);
    this.ended();
  }

  /** `remember` = „Angemeldet bleiben“: 30 days; otherwise a day (and a browser-session cookie). */
  /** `proxy` (`provider:id`): made by an auth proxy (AD-049) – valid only while the proxy names the same person. */
  createSession(userId: string, remember = true, proxy?: string): { token: string; expires: Date } {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + (remember ? SESSION_DAYS * 24 : SHORT_SESSION_HOURS) * 3_600_000);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), expires.toISOString());
    this.markSeen(userId);
    if (proxy) this.db.prepare('INSERT INTO session_proxy (token_hash, proxy) VALUES (?, ?)').run(sha256(token), proxy);
    return { token, expires };
  }

  /** `provider:id` of a session an auth proxy made, else null. */
  sessionProxy(token: string | undefined): string | null {
    if (!token) return null;
    return (this.db.prepare('SELECT proxy FROM session_proxy WHERE token_hash = ?').get(sha256(token)) as { proxy: string } | undefined)?.proxy ?? null;
  }

  // ── Accounts connected to an auth proxy (AD-049) ──────────────────────────────────────

  /** The active user connected to this provider id. */
  userForProxy(provider: string, subject: string): User | null {
    const row = this.db
      .prepare('SELECT u.* FROM proxy_links l JOIN users u ON u.id = l.user_id WHERE l.provider = ? AND l.subject = ? AND u.disabled = 0')
      .get(provider, subject) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /**
   * Connects the account to the id the provider sent; an id already connected to someone else is refused. `auto`:
   * made by e-mail on the first visit (goes when the account becomes admin). Sessions of an earlier id end.
   */
  linkProxy(userId: string, provider: string, subject: string, auto = false): void {
    const other = this.db.prepare('SELECT user_id FROM proxy_links WHERE provider = ? AND subject = ?').get(provider, subject) as { user_id: string } | undefined;
    if (other && other.user_id !== userId) throw new AuthError('Diese Anmeldung beim Anbieter ist schon mit einem anderen Konto verbunden');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM proxy_links WHERE user_id = ? AND provider = ?').run(userId, provider);
      this.endProxySessions(userId, provider);
      this.db.prepare('INSERT INTO proxy_links (user_id, provider, subject, auto, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, provider, subject, auto ? 1 : 0, now());
    })();
  }

  /** Removes the connection; sessions the proxy made for it end too. */
  unlinkProxy(userId: string, provider: string): boolean {
    const n = this.db.prepare('DELETE FROM proxy_links WHERE user_id = ? AND provider = ?').run(userId, provider).changes;
    this.endProxySessions(userId, provider);
    return n > 0;
  }

  /** A new or removed proxy secret (sec-003): every session that provider made ends – it may have come without the secret. */
  endAllProxySessions(provider: string) {
    this.endProxySessions(null, provider);
  }

  /** Sessions a proxy made – of one user or of all (null), of one provider or of all (`session_proxy.proxy` = „provider:…“). */
  private endProxySessions(userId: string | null, provider?: string) {
    this.db
      .prepare(
        "DELETE FROM sessions WHERE (? IS NULL OR user_id = ?) AND token_hash IN (SELECT token_hash FROM session_proxy WHERE ? IS NULL OR substr(proxy, 1, length(?) + 1) = ? || ':')",
      )
      .run(userId, userId, provider ?? null, provider ?? '', provider ?? '');
    this.ended();
  }

  /** A new password set from outside (admin, mail link): the account may have been in wrong hands – connections go. */
  private dropProxyLinks(userId: string) {
    this.db.prepare('DELETE FROM proxy_links WHERE user_id = ?').run(userId);
  }

  /** Connections per user id (provider → since). */
  proxyLinks(userId?: string): { userId: string; provider: string; createdAt: string }[] {
    const rows = (userId
      ? this.db.prepare('SELECT user_id, provider, created_at FROM proxy_links WHERE user_id = ? ORDER BY provider').all(userId)
      : this.db.prepare('SELECT user_id, provider, created_at FROM proxy_links ORDER BY provider').all()) as { user_id: string; provider: string; created_at: string }[];
    // Only providers that exist count – a connection to one that is gone (Pangolin, AD-058; removed by migration v20) never.
    return rows.filter((r) => (PROXY_PROVIDERS as readonly string[]).includes(r.provider)).map((r) => ({ userId: r.user_id, provider: r.provider, createdAt: r.created_at }));
  }

  userForSession(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        'SELECT u.*, us.at AS last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN user_seen us ON us.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0',
      )
      .get(sha256(token), now()) as UserRow | undefined;
    if (row) this.seen(row);
    return row ? toUser(row) : null;
  }

  /** „Zuletzt aktiv“: written at most once an hour per person. */
  private seen(row: UserRow) {
    if (row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 3_600_000) return;
    row.last_seen_at = now();
    this.markSeen(row.id, row.last_seen_at);
  }

  private markSeen(userId: string, at = now()) {
    this.db.prepare('INSERT INTO user_seen (user_id, at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at').run(userId, at);
  }

  deleteSession(token: string | undefined) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    this.ended();
  }

  /** Expired sessions go at once; expired API tokens stay listed for 30 days, then go too (AD-034). */
  purgeExpired() {
    if (this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes) this.ended();
    this.db.prepare('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date(Date.now() - 30 * 86_400_000).toISOString());
  }

  // ── User administration (admins) ─────────────────────────────────────────────────────

  /** Admins first, then users, then guests – each in the order they were created. */
  listUsers(): User[] {
    return (
      this.db.prepare('SELECT u.*, us.at AS last_seen_at FROM users u LEFT JOIN user_seen us ON us.user_id = u.id ORDER BY u.is_admin DESC, u.is_guest ASC, u.created_at, u.rowid').all() as UserRow[]
    ).map(toUser);
  }

  private activeAdmins(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get() as { n: number }).n;
  }

  /** Changes profile, role or lock state; the last active admin can never be demoted or locked. */
  updateUser(id: string, patch: { displayName?: string; email?: string; isAdmin?: boolean; isGuest?: boolean; disabled?: boolean }): User {
    const user = this.getUser(id);
    if (!user) throw new AuthError('Benutzer nicht gefunden');
    // Admin and guest exclude each other: whichever is switched on wins.
    let isAdmin = patch.isAdmin ?? user.isAdmin;
    let isGuest = patch.isGuest ?? !!user.isGuest;
    if (patch.isGuest === true) isAdmin = false;
    if (patch.isAdmin === true) isGuest = false;
    const losesAdmin = user.isAdmin && !user.disabled && (!isAdmin || patch.disabled === true);
    if (losesAdmin && this.activeAdmins() <= 1) throw new AuthError('Der letzte aktive Administrator kann nicht herabgestuft oder gesperrt werden');
    let email = user.email;
    if (patch.email?.trim() && normEmail(patch.email) !== user.email) {
      email = normEmail(patch.email);
      if (!validEmail(email)) throw new AuthError('Bitte eine gültige E-Mail-Adresse angeben');
      const other = this.byEmail(email);
      if (other && other.id !== id) throw new AuthError('Diese E-Mail-Adresse hat schon ein Konto');
    }
    this.db
      .prepare('UPDATE users SET display_name = ?, email = ?, is_admin = ?, is_guest = ?, disabled = ? WHERE id = ?')
      .run(cleanDisplayName(patch.displayName) || user.displayName, email, isAdmin ? 1 : 0, isGuest ? 1 : 0, (patch.disabled ?? user.disabled) ? 1 : 0, id);
    // Connections made by e-mail are for normal users only (AD-049): they go when the account becomes admin.
    if (isAdmin && !user.isAdmin) {
      this.db.prepare('DELETE FROM proxy_links WHERE user_id = ? AND auto = 1').run(id);
      this.endProxySessions(id);
    }
    // Locked out means logged out everywhere, tokens included.
    if (patch.disabled) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(id);
      this.ended();
    }
    // Guests have no tokens (AD-047).
    if (isGuest && !user.isGuest) this.db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(id);
    // An admin who is locked or no admin any more keeps no way in through tokens they made for others (audit 28.10. sec-001).
    if (losesAdmin) this.dropTokensMadeBy(id);
    return this.getUser(id)!;
  }

  /** Admin reset: new password the user must replace at the next login (unless `mustChange` is false); all their sessions end, their API tokens too. */
  async setPassword(id: string, password: string, mustChange = true): Promise<void> {
    checkPassword(password, this.contextOf(id));
    if (!this.getUser(id)) throw new AuthError('Benutzer nicht gefunden');
    this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(await hashPassword(password), mustChange ? 1 : 0, id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(id);
    this.dropProxyLinks(id);
    this.ended();
  }

  deleteUser(id: string, actingUserId: string): void {
    const user = this.getUser(id);
    if (!user) throw new AuthError('Benutzer nicht gefunden');
    if (id === actingUserId) throw new AuthError('Das eigene Konto kann nicht gelöscht werden');
    if (user.isAdmin && !user.disabled && this.activeAdmins() <= 1) throw new AuthError('Der letzte aktive Administrator kann nicht gelöscht werden');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      // No foreign key on rules (subject_id is a user or a group id): they would be left without an owner.
      this.db.prepare("DELETE FROM acl_rules WHERE subject = 'user' AND subject_id = ?").run(id);
      // Open invitations and shares this person sent end with the account (owner 26.10.).
      this.db.prepare('DELETE FROM email_tokens WHERE created_by = ? AND used_at IS NULL').run(id);
      // So do the API tokens they made for others: they know those values (audit 28.10. sec-001).
      this.dropTokensMadeBy(id);
      this.forgetInLog(user);
    })();
    this.ended();
  }

  /** Tokens an admin made (or renewed) for someone else – the admin knows their values. */
  private dropTokensMadeBy(adminId: string) {
    this.db.prepare('DELETE FROM api_tokens WHERE created_by = ? AND user_id != ?').run(adminId, adminId);
  }

  /**
   * The log keeps what happened, not who it was (GDPR erasure): name, display name, address and id become
   * „gelöschtes Konto“, the person's own entries lose their IP. Whole words only – „maria“ stays in „mariana“.
   */
  private forgetInLog(user: User) {
    const names = [user.email, user.displayName, user.username, user.id].filter((n) => n && n.length >= 2);
    const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![\\p{L}\\p{N}_.@-])(?:${names.map(escape).join('|')})(?![\\p{L}\\p{N}_@-])`, 'giu');
    const like = names.map(() => 'message LIKE ? OR detail_json LIKE ?').join(' OR ');
    const rows = this.db
      .prepare(`SELECT id, actor, message, detail_json FROM activity WHERE actor IN (?, ?) OR ${like}`)
      .all(user.username, user.displayName, ...names.flatMap((n) => [`%${n}%`, `%${n}%`])) as { id: number; actor: string | null; message: string; detail_json: string | null }[];
    const update = this.db.prepare('UPDATE activity SET actor = ?, message = ?, detail_json = ? WHERE id = ?');
    for (const r of rows) {
      const own = r.actor === user.username || r.actor === user.displayName;
      let detail = r.detail_json;
      if (detail) {
        try {
          const d = JSON.parse(detail) as Record<string, unknown>;
          if (own) delete d.ip;
          detail = JSON.stringify(d).replace(word, 'gelöschtes Konto');
        } catch {
          detail = null;
        }
      }
      update.run(own ? 'gelöschtes Konto' : r.actor, r.message.replace(word, 'gelöschtes Konto'), detail, r.id);
    }
  }

  // ── Personal API tokens (docs/PLAN.md §3) ─────────────────────────────────────────────

  /**
   * Creates a token; the plain value is returned exactly once (only its hash is stored). `by` = the admin who makes it
   * for someone else (owner 28.10.): it can do at most what the person may (guests none, „admin“ only for admins).
   */
  createToken(userId: string, name: string, scopes: TokenScope[], expiresDays: number | null, by?: string): { token: string; info: TokenInfo } {
    const clean = [...new Set(scopes)].filter((s): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s));
    if (!clean.length) throw new AuthError('Mindestens ein Recht wählen (read, write, admin)');
    if (!name.trim()) throw new AuthError('Name fehlt');
    const user = this.getUser(userId);
    if (!user) throw new AuthError('Benutzer nicht gefunden');
    if (user.disabled) throw new AuthError('Das Konto ist gesperrt – ein Token würde nicht gelten');
    if (user.isGuest) throw new AuthError('Gäste können keine Tokens erstellen');
    if (clean.includes('admin') && !user.isAdmin) throw new AuthError('Nur Administratoren können Admin-Tokens erstellen');
    const token = newApiToken();
    const id = ulid();
    const expires = expiresDays ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;
    this.db
      .prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, name.trim().slice(0, 80), sha256(token), token.slice(0, 10), clean.join(' '), now(), expires, by && by !== userId ? by : null);
    return { token, info: this.tokenInfo(id)! };
  }

  listTokens(userId: string): TokenInfo[] {
    return (this.db.prepare(`${TOKEN_SELECT} WHERE t.user_id = ? ORDER BY t.created_at DESC`).all(userId) as TokenRow[]).map(tokenInfoOf);
  }

  /** All tokens of all people, for the admins' tab „Tokens“ (owner 28.10.). */
  listAllTokens(): AdminTokenInfo[] {
    return (this.db.prepare(`${TOKEN_SELECT} ORDER BY u.display_name COLLATE NOCASE, t.created_at DESC`).all() as TokenRow[]).map((r) => ({
      ...tokenInfoOf(r),
      user: { id: r.user_id, username: r.username, displayName: r.display_name, isAdmin: r.is_admin === 1 },
    }));
  }

  /** One token with its person, or null. */
  tokenInfo(id: string): AdminTokenInfo | null {
    const r = this.db.prepare(`${TOKEN_SELECT} WHERE t.id = ?`).get(id) as TokenRow | undefined;
    return r ? { ...tokenInfoOf(r), user: { id: r.user_id, username: r.username, displayName: r.display_name, isAdmin: r.is_admin === 1 } } : null;
  }

  /** Deletes a token: of this person (`userId`), or any (admins, `userId` null). */
  revokeToken(userId: string | null, id: string): boolean {
    return (userId !== null ? this.db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId) : this.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id)).changes > 0;
  }

  /**
   * Renews a token (owner 28.10.): a new value with the same name, rights and validity (counted from now); the old
   * value stops working at once. `userId` null = an admin renews someone's token – then the admin knows the value.
   * „admin“ goes when the person is no admin any more.
   */
  renewToken(userId: string | null, id: string, actingUserId: string): { token: string; info: TokenInfo } | null {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as { user_id: string; scopes: string; created_at: string; expires_at: string | null } | undefined;
    if (!row || (userId !== null && row.user_id !== userId)) return null;
    const user = this.getUser(row.user_id);
    if (!user || user.disabled) throw new AuthError('Das Konto ist gesperrt – ein Token würde nicht gelten');
    if (user.isGuest) throw new AuthError('Gäste können keine Tokens erstellen');
    const scopes = row.scopes.split(' ').filter((s) => s !== 'admin' || user.isAdmin);
    if (!scopes.length) throw new AuthError('Der Token hätte keine Rechte mehr – bitte löschen und neu erstellen');
    const days = row.expires_at ? Math.max(1, Math.round((Date.parse(row.expires_at) - Date.parse(row.created_at)) / 86_400_000)) : null;
    const token = newApiToken();
    this.db
      .prepare('UPDATE api_tokens SET token_hash = ?, prefix = ?, scopes = ?, created_at = ?, expires_at = ?, last_used_at = NULL, created_by = ? WHERE id = ?')
      .run(sha256(token), token.slice(0, 10), scopes.join(' '), now(), days ? new Date(Date.now() + days * 86_400_000).toISOString() : null, actingUserId !== row.user_id ? actingUserId : null, id);
    return { token, info: this.tokenInfo(id)! };
  }

  /** Resolves a bearer token; records "last used" at most once a minute. */
  userForToken(token: string): { user: User; scopes: TokenScope[]; tokenId: string } | null {
    const row = this.db
      .prepare(
        `SELECT t.id AS token_id, t.scopes, t.last_used_at, u.*, us.at AS last_seen_at FROM api_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN user_seen us ON us.user_id = u.id
         WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.disabled = 0`,
      )
      .get(sha256(token), now()) as (UserRow & { token_id: string; scopes: string; last_used_at: string | null }) | undefined;
    if (!row) return null;
    this.seen(row);
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) {
      this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.token_id);
    }
    // A token never carries more than its owner currently has.
    const scopes = (row.scopes.split(' ') as TokenScope[]).filter((s) => s !== 'admin' || row.is_admin === 1);
    return { user: toUser(row), scopes, tokenId: row.token_id };
  }
}

/**
 * Failed logins per key (e-mail, IP) in a sliding window. Once `max` failures are reached, the key waits until the
 * oldest one falls out of the window – even the right password is refused then, or guessing would go on.
 * Memory stays bounded: expired keys are swept once per window, at most `maxKeys` keys (least recently failed go
 * first, but never a blocked one – else failures of other keys would lift a block), keys cut to 320 characters.
 * If every held key is blocked, a new key is not held and counts as blocked (fail closed).
 * Also the rate limit for requests (`hit`): at most `max` allowed hits per key and window.
 */
export class FailureLimit {
  private fails = new Map<string, number[]>();
  private sweptAt = Date.now();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}
  private recent(key: string): number[] {
    const t = Date.now();
    const list = (this.fails.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }
  private sweep(t: number): void {
    if (t - this.sweptAt < this.windowMs) return;
    this.sweptAt = t;
    this.prune(t);
  }
  private prune(t: number): void {
    for (const [k, list] of this.fails) if (t - (list.at(-1) ?? 0) >= this.windowMs) this.fails.delete(k);
  }
  private isBlocked(list: number[], t: number): boolean {
    return list.filter((x) => t - x < this.windowMs).length >= this.max;
  }
  /** Table full and every held key blocked – after dropping expired ones. */
  private saturated(t: number): boolean {
    if (this.fails.size < this.maxKeys) return false;
    this.prune(t);
    if (this.fails.size < this.maxKeys) return false;
    for (const list of this.fails.values()) if (!this.isBlocked(list, t)) return false;
    return true;
  }
  /** Number of keys held (for tests). */
  get size(): number {
    return this.fails.size;
  }
  blocked(key: string): boolean {
    const k = key.slice(0, 320);
    if (this.recent(k).length >= this.max) return true;
    return !this.fails.has(k) && this.saturated(Date.now());
  }
  fail(key: string): void {
    const k = key.slice(0, 320);
    const t = Date.now();
    this.sweep(t);
    const list = [...this.recent(k), t];
    this.fails.delete(k); // re-insert: Map order = least recently failed first
    this.fails.set(k, list);
    if (this.fails.size <= this.maxKeys) return;
    this.prune(t);
    // Least recently failed key that is not blocked; if there is none, the new key itself is not held.
    let drop = k;
    for (const [key, l] of this.fails) {
      if (!this.isBlocked(l, t)) {
        drop = key;
        break;
      }
    }
    if (this.fails.size > this.maxKeys) this.fails.delete(drop);
  }
  clear(key: string): void {
    this.fails.delete(key.slice(0, 320));
  }
  /** Rate limit: counts the hit and returns true, unless `max` hits in the window are reached already. */
  hit(key: string): boolean {
    if (this.blocked(key)) return false;
    this.fail(key);
    return true;
  }
}
