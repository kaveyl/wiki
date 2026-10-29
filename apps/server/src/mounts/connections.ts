// Reusable access data for remote sources (AD-029): a connection is a hoster account (Gitea,
// GitHub, GitLab) or plain Git access (HTTPS with optional user name + token). Sources point
// at a connection; the token lives encrypted in `secrets` and never leaves the server.
// SEE-DOC: DECISIONS.md AD-029

import { ulid } from 'ulid';
import { now, type DB } from '../db/db.js';
import type { SecretStore } from '../secrets.js';
import { DEFAULT_BASE, gitAuthorization, HOST_LABEL, hostFullName, isHostKind, type ConnectionKind, type HostAccess } from './hosts.js';
import { PathError } from './model.js';

/** Secret id of the token from before connections (global Gitea) — kept, not re-encrypted. */
export const LEGACY_GITEA_SECRET = 'gitea';

export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  /** Origin of the host, e.g. https://gitea.example.com. */
  baseUrl: string;
  username: string | null;
  secretId: string | null;
  createdAt: string;
}

export interface ConnectionInput {
  kind: ConnectionKind;
  name?: string;
  baseUrl?: string;
  username?: string | null;
  /** New token; '' or undefined keeps the stored one (update) / none (create). */
  token?: string;
}

interface Row {
  id: string;
  kind: ConnectionKind;
  name: string;
  base_url: string;
  username: string | null;
  secret_id: string | null;
  created_at: string;
}

const fromRow = (r: Row): Connection => ({ id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url, username: r.username, secretId: r.secret_id, createdAt: r.created_at });

const KINDS: ConnectionKind[] = ['gitea', 'github', 'gitlab', 'git'];

/** Only https (http just for hosts in the own network is still the user's choice). */
export function cleanBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new PathError('Adresse ungültig – z. B. https://gitea.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PathError('Adresse muss mit https:// beginnen');
  if (u.username || u.password) throw new PathError('Zugangsdaten gehören nicht in die Adresse – bitte Token separat angeben');
  return u.origin;
}

export class ConnectionStore {
  constructor(
    private readonly db: DB,
    private readonly secrets: SecretStore,
  ) {}

  list(): Connection[] {
    return (this.db.prepare('SELECT * FROM connections ORDER BY kind, name').all() as Row[]).map(fromRow);
  }

  get(id: string): Connection | null {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  create(input: ConnectionInput): Connection {
    if (!KINDS.includes(input.kind)) throw new PathError('Unbekannte Art der Verbindung');
    const baseUrl = cleanBaseUrl(input.baseUrl || DEFAULT_BASE[input.kind] || '');
    if (isHostKind(input.kind) && !input.token) throw new PathError(`Für ${HOST_LABEL[input.kind]} wird ein Token gebraucht`);
    const id = ulid();
    const secretId = input.token ? this.secrets.put(input.token) : null;
    const name = input.name?.trim() || `${HOST_LABEL[input.kind]} (${new URL(baseUrl).host})`;
    this.db
      .prepare('INSERT INTO connections (id, kind, name, base_url, username, secret_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.kind, name, baseUrl, input.username?.trim() || null, secretId, now());
    return this.get(id)!;
  }

  /** Name, user name and token any time; the address only while no source or trashed repository uses it. */
  update(id: string, patch: Partial<ConnectionInput>): Connection {
    const c = this.get(id);
    if (!c) throw new PathError('Verbindung nicht gefunden');
    const baseUrl = patch.baseUrl !== undefined ? cleanBaseUrl(patch.baseUrl) : c.baseUrl;
    const used = this.usage(id);
    if (baseUrl !== c.baseUrl && used.mounts > 0) {
      throw new PathError('Die Adresse lässt sich nicht ändern, solange Quellen diese Verbindung nutzen – neue Verbindung anlegen und die Quellen umstellen');
    }
    // Trashed repositories are restored or deleted later via this connection: on the right server.
    if (baseUrl !== c.baseUrl && used.trash > 0) {
      throw new PathError('Die Adresse lässt sich nicht ändern, solange Repositories dieser Verbindung im Repository-Papierkorb liegen');
    }
    let secretId = c.secretId;
    if (patch.token) secretId = this.secrets.put(patch.token, c.secretId ?? undefined);
    const name = patch.name !== undefined ? patch.name.trim() || c.name : c.name;
    const username = patch.username !== undefined ? patch.username?.trim() || null : c.username;
    this.db.prepare('UPDATE connections SET name = ?, base_url = ?, username = ?, secret_id = ? WHERE id = ?').run(name, baseUrl, username, secretId, id);
    // Sources store the secret id too (fallback for an older Kaveyl Wiki version, AD-029).
    if (secretId !== c.secretId) this.db.prepare('UPDATE mounts SET credential_id = ? WHERE connection_id = ?').run(secretId, id);
    return this.get(id)!;
  }

  usage(id: string): { mounts: number; trash: number } {
    const mounts = (this.db.prepare('SELECT COUNT(*) AS n FROM mounts WHERE connection_id = ?').get(id) as { n: number }).n;
    const trash = (this.db.prepare('SELECT COUNT(*) AS n FROM repo_trash WHERE connection_id = ?').get(id) as { n: number }).n;
    return { mounts, trash };
  }

  delete(id: string) {
    const c = this.get(id);
    if (!c) return;
    const u = this.usage(id);
    if (u.mounts) throw new PathError(`Wird noch von ${u.mounts} Quelle(n) genutzt`);
    if (u.trash) throw new PathError(`${u.trash} Repository/Repositories dieser Verbindung liegen im Papierkorb`);
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    if (c.secretId && !this.db.prepare('SELECT 1 FROM mounts WHERE credential_id = ?').get(c.secretId)) this.secrets.delete(c.secretId);
  }

  token(c: Connection): string | null {
    return c.secretId ? this.secrets.get(c.secretId) : null;
  }

  /** Authorization header for git, or undefined (public repository). */
  gitAuthorization(c: Connection): string | undefined {
    const token = this.token(c);
    return token ? gitAuthorization(c.kind, token, c.username) : undefined;
  }

  /** For API calls on a hoster (throws for plain Git or without token). */
  hostAccess(c: Connection): HostAccess & { connectionId: string } {
    if (!isHostKind(c.kind)) throw new PathError(`„${c.name}“ ist eine reine Git-Verbindung ohne Hoster-Funktionen`);
    const token = this.token(c);
    if (!token) throw new PathError(`„${c.name}“ hat keinen Token`);
    return { kind: c.kind, base: c.baseUrl, token, connectionId: c.id };
  }

  /** The repository (`owner/repo`) a clone URL points to on a hoster connection, or null. */
  repoOf(c: Connection, cloneUrl: string): string | null {
    return isHostKind(c.kind) ? hostFullName(c.kind, c.baseUrl, cloneUrl) : null;
  }

  /** A hoster connection whose address matches the URL (for sources without connection). */
  findHostFor(cloneUrl: string): Connection | null {
    return this.list().find((c) => this.repoOf(c, cloneUrl) !== null) ?? null;
  }

  /** The first Gitea connection — what the former "Settings → Gitea" was. */
  defaultGitea(): Connection | null {
    return this.list().find((c) => c.kind === 'gitea' && c.secretId === LEGACY_GITEA_SECRET) ?? this.list().find((c) => c.kind === 'gitea') ?? null;
  }

  /**
   * Takes over the data from before connections (AD-029), idempotent: the global Gitea becomes
   * a connection (same secret id), its sources and trash entries point at it; every own token
   * of a Git-URL source becomes a plain Git connection (same header as before).
   */
  adoptLegacy(giteaBase: string | null): { created: number; linked: number } {
    let created = 0;
    let linked = 0;
    this.db.transaction(() => {
      let gitea = this.db.prepare('SELECT * FROM connections WHERE secret_id = ?').get(LEGACY_GITEA_SECRET) as Row | undefined;
      if (!gitea && giteaBase && this.secrets.get(LEGACY_GITEA_SECRET)) {
        const id = ulid();
        const base = new URL(giteaBase).origin;
        this.db
          .prepare('INSERT INTO connections (id, kind, name, base_url, username, secret_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
          .run(id, 'gitea', `Gitea (${new URL(base).host})`, base, LEGACY_GITEA_SECRET, now());
        gitea = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Row;
        created++;
      }
      if (gitea) {
        linked += this.db.prepare('UPDATE mounts SET connection_id = ? WHERE credential_id = ? AND connection_id IS NULL').run(gitea.id, LEGACY_GITEA_SECRET).changes;
        this.db.prepare('UPDATE repo_trash SET connection_id = ? WHERE connection_id IS NULL').run(gitea.id);
      }
      const own = this.db
        .prepare('SELECT id, source, credential_id FROM mounts WHERE credential_id IS NOT NULL AND credential_id != ? AND connection_id IS NULL')
        .all(LEGACY_GITEA_SECRET) as { id: string; source: string; credential_id: string }[];
      for (const m of own) {
        let conn = this.db.prepare('SELECT id FROM connections WHERE secret_id = ?').get(m.credential_id) as { id: string } | undefined;
        if (!conn) {
          const base = new URL(m.source).origin;
          const id = ulid();
          this.db
            .prepare('INSERT INTO connections (id, kind, name, base_url, username, secret_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
            .run(id, 'git', `Git (${new URL(base).host})`, base, m.credential_id, now());
          conn = { id };
          created++;
        }
        linked += this.db.prepare('UPDATE mounts SET connection_id = ? WHERE id = ?').run(conn.id, m.id).changes;
      }
    })();
    return { created, linked };
  }
}
