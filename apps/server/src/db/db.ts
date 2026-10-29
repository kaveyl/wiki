// SQLite database: app state (users, sessions, mounts, secrets, per-user UI state) and
// the derived note index (entries + FTS). The index can always be rebuilt from the files.
// SEE-DOC: docs/PLAN.md §2.7

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/** SQL, or a function where SQL alone cannot be repeated safely (tests run migrations again from an older version). */
const MIGRATIONS: (string | ((db: DB) => void))[] = [
  // 1: initial schema
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    value_enc TEXT NOT NULL
  );

  CREATE TABLE mounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('remote', 'local')),
    source TEXT NOT NULL,
    branch TEXT,
    subpath TEXT NOT NULL DEFAULT '',
    include_json TEXT NOT NULL DEFAULT '["**"]',
    exclude_json TEXT NOT NULL DEFAULT '[]',
    icon TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    options_json TEXT NOT NULL DEFAULT '{}',
    credential_id TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    sync_status TEXT,
    sync_detail TEXT,
    synced_at TEXT
  );

  CREATE TABLE entries (
    mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    parent TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
    note_id TEXT,
    title TEXT NOT NULL,
    icon TEXT,
    readonly INTEGER NOT NULL DEFAULT 0,
    tags_json TEXT NOT NULL DEFAULT '[]',
    size INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0,
    hash TEXT,
    PRIMARY KEY (mount_id, path)
  );
  CREATE INDEX entries_parent ON entries (mount_id, parent);
  CREATE INDEX entries_note_id ON entries (note_id);

  -- Word search (prefix queries) over title, path, tags and body.
  CREATE VIRTUAL TABLE entries_fts USING fts5(
    title, path, tags, body,
    mount_id UNINDEXED, entry_path UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  -- Substring search over title and path ("lium" finds "Trilium").
  CREATE VIRTUAL TABLE entries_tri USING fts5(
    title, path,
    mount_id UNINDEXED, entry_path UNINDEXED,
    tokenize = 'trigram'
  );

  CREATE TABLE user_state (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `,
  // v2 (Phase 2): stable note identities that survive renames, index rebuilds and pauses.
  // `id` is the frontmatter `id:` when present, otherwise generated here (docs/PLAN.md §2.2).
  `
  CREATE TABLE note_ids (
    mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    id TEXT NOT NULL,
    hash TEXT,
    PRIMARY KEY (mount_id, path)
  );
  CREATE INDEX note_ids_id ON note_ids (id);
  `,
  // v3 (Phase 2): local links per note (derived, rebuilt with the index) for backlinks,
  // link repair after renames and fsck. `target` is the mount-relative path as written,
  // before `.md`/folder-note candidates are applied (docs/PLAN.md §2.5).
  `
  CREATE TABLE links (
    mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
    src_path TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    anchor TEXT
  );
  CREATE INDEX links_src ON links (mount_id, src_path);
  CREATE INDEX links_target ON links (mount_id, target);
  `,
  // v4: event log (sync, errors, security, system) with retention — never secrets (AD-013).
  // No foreign key on mount_id: entries outlive a removed mount (mount_name keeps them readable).
  `
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('sync', 'error', 'audit', 'system')),
    level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    mount_id TEXT,
    mount_name TEXT,
    actor TEXT,
    action TEXT NOT NULL,
    message TEXT NOT NULL,
    detail_json TEXT
  );
  CREATE INDEX activity_at ON activity (at);
  CREATE INDEX activity_mount ON activity (mount_id, at);
  CREATE INDEX activity_category ON activity (category, at);
  `,
  // v5: repositories Kaveyl Wiki archived on Gitea as "deleted" — final deletion after 30 days.
  `
  CREATE TABLE repo_trash (
    full_name TEXT PRIMARY KEY,
    clone_url TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    delete_after TEXT NOT NULL,
    actor TEXT
  );
  `,
  // v6 (Phase 4): disable accounts without deleting them; personal API tokens (kw_…, only hashes stored).
  `
  ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT
  );
  CREATE INDEX api_tokens_user ON api_tokens (user_id);
  `,
  // v7: custom note icons (uploaded images, global for all sources; AD-018).
  `
  CREATE TABLE icons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v8 (Phase 4): groups and access rules (AD-020).
  `
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE acl_rules (
    id TEXT PRIMARY KEY,
    mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
    target TEXT NOT NULL CHECK (target IN ('mount', 'folder', 'note')),
    path TEXT NOT NULL DEFAULT '',
    note_id TEXT,
    subject TEXT NOT NULL CHECK (subject IN ('all', 'group', 'user')),
    subject_id TEXT,
    level TEXT NOT NULL CHECK (level IN ('none', 'read', 'write', 'admin')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX acl_rules_mount ON acl_rules (mount_id);
  `,
  // v9: AI assistant (AD-011, AD-024): release rules (nothing is visible without one), chats.
  `
  CREATE TABLE ai_rules (
    id TEXT PRIMARY KEY,
    mount_id TEXT NOT NULL,
    target TEXT NOT NULL CHECK (target IN ('mount', 'folder', 'note')),
    path TEXT NOT NULL DEFAULT '',
    note_id TEXT,
    level TEXT NOT NULL CHECK (level IN ('none', 'read', 'suggest')),
    cloud INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ai_rules_mount ON ai_rules (mount_id);
  CREATE TABLE ai_chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX ai_chats_user ON ai_chats (user_id, updated_at);
  CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    sources_json TEXT NOT NULL DEFAULT '[]',
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX ai_messages_chat ON ai_messages (chat_id, created_at);
  `,
  // v10: changes the AI agent proposes; carried out only after the user confirms (AD-026).
  `
  CREATE TABLE ai_proposals (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'write', 'move', 'remember')),
    mount_id TEXT NOT NULL,
    path TEXT NOT NULL,
    to_path TEXT,
    title TEXT,
    content TEXT,
    base_hash TEXT,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'rejected', 'failed')),
    result TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX ai_proposals_chat ON ai_proposals (chat_id, created_at);
  `,
  // v11: reusable connections (Gitea, GitHub, GitLab, Git) instead of one global Gitea (AD-029).
  // Existing data is taken over at start-up (ConnectionStore.adoptLegacy) — it needs the secrets.
  `
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('gitea', 'github', 'gitlab', 'git')),
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    username TEXT,
    secret_id TEXT,
    created_at TEXT NOT NULL
  );
  ALTER TABLE mounts ADD COLUMN connection_id TEXT;
  ALTER TABLE repo_trash ADD COLUMN connection_id TEXT;
  `,
  // v12: login by e-mail, password policy, guests, mail tokens (AD-030). E-mails become unique
  // (case-insensitive); empty ones and later duplicates get the placeholder <username>@kaveyl-wiki.local.
  `
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET email = lower(trim(email));
  UPDATE users SET email = lower(username) || '@kaveyl-wiki.local'
    WHERE email = '' OR instr(email, '@') = 0 OR EXISTS (
      SELECT 1 FROM users v WHERE v.email = users.email AND (v.created_at < users.created_at OR (v.created_at = users.created_at AND v.id < users.id)));
  CREATE UNIQUE INDEX users_email ON users (email COLLATE NOCASE);
  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('reset', 'invite')),
    email TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    payload TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX email_tokens_email ON email_tokens (email, kind);
  `,
  // v13: the UI offers only „freigegeben“ (= read + suggest, AD-031); existing read-only releases become that.
  `
  UPDATE ai_rules SET level = 'suggest' WHERE level = 'read';
  `,
  // v14: AI releases of sources removed before they were cleaned up with the source (owner 2026-10-11).
  `
  DELETE FROM ai_rules WHERE mount_id NOT IN (SELECT id FROM mounts);
  `,
  // v15: backup module (AD-038) — targets (local folder / SMB), plans, runs and the archives written.
  `
  CREATE TABLE IF NOT EXISTS backup_targets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'smb')),
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    username TEXT,
    domain TEXT,
    secret_id TEXT,
    password_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backup_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target_id TEXT NOT NULL REFERENCES backup_targets(id),
    sources TEXT NOT NULL DEFAULT '["*"]',
    include_db INTEGER NOT NULL DEFAULT 0,
    keep TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '02:00',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_slot TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    plan_id TEXT,
    plan_name TEXT NOT NULL,
    target_name TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('plan', 'manual')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'error')),
    message TEXT,
    archives INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS backup_runs_started ON backup_runs (started_at);
  CREATE TABLE IF NOT EXISTS backup_files (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    plan_id TEXT,
    target_id TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE CASCADE,
    mount_id TEXT,
    label TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    password_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS backup_files_source ON backup_files (plan_id, target_id, mount_id, created_at);
  `,
  // v16: sign-in through an auth proxy (AD-049) — accounts connected to a provider's fixed id; sessions made by a proxy
  // remember provider and id (they end when the proxy stops naming the same person). Own table, not a column of
  // `sessions`: migrations stay repeatable (IF NOT EXISTS).
  `
  CREATE TABLE IF NOT EXISTS proxy_links (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject),
    UNIQUE (user_id, provider)
  );
  CREATE TABLE IF NOT EXISTS session_proxy (
    token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
    proxy TEXT NOT NULL
  );
  `,
  // v17: the default level without a rule becomes „kein Zugriff“ for new installations (AD-051). One that already has
  // accounts keeps what applied so far („lesen & schreiben“) – nobody is locked out by the update.
  `
  INSERT INTO settings (key, value)
    SELECT 'acl_default', 'write'
    WHERE EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'acl_default');
  `,
  // v18: took data over from the app's former name (AD-053) – removed with 0.1.3 (AD-057); the step stays so the
  // numbering does not shift.
  `SELECT 1;`,
  // v19: when someone was last active (sign-in, browser or token), so admins see whose account may go (owner 21.10.).
  // Starts from the newest session still stored.
  // A table of its own, so the step can run twice (see HANDBOOK: migrations).
  `
  CREATE TABLE IF NOT EXISTS user_seen (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO user_seen (user_id, at) SELECT user_id, MAX(created_at) FROM sessions GROUP BY user_id;
  `,
  // v20: no sign-in through Pangolin any more (AD-058) – its setting and the accounts' connections go (owner 21.10.).
  `
  DELETE FROM proxy_links WHERE provider = 'pangolin';
  DELETE FROM settings WHERE key = 'proxy_auth_pangolin';
  `,
  // v21 (AD-066): „Beobachten“ – what a person follows and how (symbol in the tree, e-mail, Pushover), what is new for
  // them; event webhooks for agents (run with the rights of one person).
  `
  CREATE TABLE IF NOT EXISTS watches (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount_id TEXT NOT NULL,
    path TEXT NOT NULL,
    is_dir INTEGER NOT NULL,
    badge INTEGER NOT NULL,
    mail INTEGER NOT NULL,
    pushover INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, mount_id, path)
  );
  CREATE TABLE IF NOT EXISTS unread (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount_id TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    by_name TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (user_id, mount_id, path)
  );
  CREATE TABLE IF NOT EXISTS event_hooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount_id TEXT,
    path TEXT NOT NULL,
    include_own INTEGER NOT NULL,
    active INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_at TEXT,
    last_status TEXT,
    failures INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v22 (AD-068): messages about followed changes wait in the database (a daily summary outlives a restart), and what
  // was sent counts towards the limits per hour and day.
  `
  CREATE TABLE IF NOT EXISTS follow_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    change_json TEXT NOT NULL,
    mail INTEGER NOT NULL,
    pushover INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS follow_queue_user ON follow_queue (user_id);
  CREATE TABLE IF NOT EXISTS follow_sent (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS follow_sent_user ON follow_sent (user_id, at);
  `,
  // v23: one waiting message per person and note (the newest state; „created“ stays) instead of one per save – with
  // the daily rhythm the queue grew by a row for every save. Index for „first waiting message“ (audit 26.10.).
  `
  CREATE TABLE follow_queue_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount_id TEXT NOT NULL,
    path TEXT NOT NULL,
    change_json TEXT NOT NULL,
    mail INTEGER NOT NULL,
    pushover INTEGER NOT NULL,
    at INTEGER NOT NULL,
    UNIQUE (user_id, mount_id, path)
  );
  INSERT INTO follow_queue_new (user_id, mount_id, path, change_json, mail, pushover, at)
    SELECT user_id, json_extract(change_json, '$.mountId'), json_extract(change_json, '$.path'), change_json, mail, pushover, at
    FROM follow_queue WHERE true ORDER BY id
    ON CONFLICT (user_id, mount_id, path) DO UPDATE SET
      change_json = CASE WHEN json_extract(follow_queue_new.change_json, '$.kind') = 'created' AND json_extract(excluded.change_json, '$.kind') = 'changed'
        THEN json_set(excluded.change_json, '$.kind', 'created') ELSE excluded.change_json END,
      mail = max(follow_queue_new.mail, excluded.mail),
      pushover = max(follow_queue_new.pushover, excluded.pushover);
  DROP TABLE follow_queue;
  ALTER TABLE follow_queue_new RENAME TO follow_queue;
  CREATE INDEX follow_queue_due ON follow_queue (user_id, at);
  `,
  // v24: tokens an admin made for someone else (owner 28.10.) – the person sees who; empty = the person made it.
  // No foreign key: the tokens go with the admin's account in code (auth.dropTokensMadeBy), also when it is locked.
  (db) => {
    const cols = db.prepare('PRAGMA table_info(api_tokens)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'created_by')) db.exec('ALTER TABLE api_tokens ADD COLUMN created_by TEXT');
  },
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Schema version this program writes (`PRAGMA user_version` after all migrations). */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Objects of an empty database migrated to `version` – the yardstick for a database from a backup (AD-075). */
export function schemaAt(version: number): { type: string; name: string; sql: string | null }[] {
  const db = freshDatabase(version);
  try {
    return db.prepare('SELECT type, name, sql FROM sqlite_master').all() as { type: string; name: string; sql: string | null }[];
  } finally {
    db.close();
  }
}

/** An empty database in memory, migrated to `version` (close it after use). */
export function freshDatabase(version: number): DB {
  const db = new Database(':memory:');
  migrate(db, version);
  return db;
}

function migrate(db: DB, to = MIGRATIONS.length) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < to; v++) {
    db.transaction(() => {
      const step = MIGRATIONS[v]!;
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const now = () => new Date().toISOString();
