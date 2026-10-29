import type { EventHooks } from '../hooks.js';
// What the route modules share (code-002): the services and checks buildApp sets up once. A route module takes
// what it needs from here, so its handlers read as they did inside buildApp. New routes go into a module like
// these, not into app.ts.
import type { Follows } from '../follows.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Acl, Level } from '../acl/acl.js';
import type { ActivityInput, ActivityLog } from '../activity.js';
import type { AccountMail } from '../auth/accountmail.js';
import type { AuthService, commitAuthor, FailureLimit } from '../auth/auth.js';
import type { CloudflareAccess } from '../auth/cloudflare.js';
import type { ProxyAuth } from '../auth/proxyRoutes.js';
import type { Rules } from '../cleanup.js';
import type { Config } from '../config.js';
import type { DB } from '../db/db.js';
import type { EventBus } from '../events.js';
import type { Entry, Indexer } from '../index/indexer.js';
import type { IconStore } from '../icons/icons.js';
import type { Mailer } from '../mail/mailer.js';
import type { Connection, ConnectionStore } from '../mounts/connections.js';
import type { MountManager } from '../mounts/manager.js';
import type { Mount, MountInput, MountOptions } from '../mounts/model.js';
import type { Move, NoteService } from '../notes/service.js';
import type { Notifier } from '../notify/notifier.js';
import type { UpdateCheck } from '../updates.js';
import type { Presence } from '../presence.js';
import type { Settings } from '../settings.js';
import type { BackupService } from '../backups/service.js';
import type { FsckReport } from '../index/fsck.js';
import type { RepoTrash } from '../mounts/repo-trash.js';
import type { SyncResult } from '../git/sync.js';
import type { Ops } from '../api/ops.js';

/** What the client sends to add or change a source. */
export type MountBody = Partial<MountInput> & {
  options?: Partial<MountOptions>;
  /** Before connections (AD-029): `gitea` = the first Gitea connection, `token` = new plain Git connection. */
  credential?: { kind: 'gitea' } | { kind: 'token'; token: string; username?: string } | null;
  connectionId?: string | null;
  selection?: { path: string; kind: 'dir' | 'file' }[];
  /** New local folder: give it its own Git for versions (AD-071). */
  versions?: boolean;
};

/** Steps of moving rules along with notes to another source (sec2-012…017). */
export interface RulesAcross {
  before(toMountId: string, to: string): void;
  placed(): void;
  done(): void;
  failed(): Promise<void>;
}

export interface AppContext {
  config: Config;
  db: DB;
  settings: Settings;
  auth: AuthService;
  acl: Acl;
  manager: MountManager;
  notes: NoteService;
  icons: IconStore;
  activity: ActivityLog;
  accountMail: AccountMail;
  mailer: Mailer;
  notifier: Notifier;
  updates: UpdateCheck;
  cloudflare: CloudflareAccess;
  connections: ConnectionStore;
  presence: Presence;
  follows: Follows;
  eventHooks: EventHooks;
  indexer: Indexer;
  events: EventBus;

  /** Into the activity log; never throws. */
  record(e: ActivityInput): void;
  /** An admin or user action into the activity log, with who and from where. */
  audit(req: FastifyRequest, action: string, message: string, extra?: Partial<ActivityInput>): void;
  /** Throws 403 unless an admin (and a token, if any, has „admin“). */
  requireAdmin(req: FastifyRequest): void;
  /** Sets the session cookie (https-only when the request came over https); without `expires` a browser-session cookie. */
  setSessionCookie(reply: FastifyReply, token: string, expires?: Date): FastifyReply;
  /** Name of the signed-in user for the log, or null. */
  who(req: FastifyRequest): string | null;
  /** Commit author of the signed-in user. */
  author(req: FastifyRequest): ReturnType<typeof commitAuthor>;

  // Access control (AD-020, acl/access.ts) – every note route goes through these.
  levelIn(req: FastifyRequest, mountId: string, path: string, isDir?: boolean): Level;
  /** Mount of the request, if the user has at least `need` on `path`: none → 404, less → 403. */
  access(req: FastifyRequest, mountId: string, path: string, need: Level, isDir?: boolean): Mount;
  canRead(req: FastifyRequest, mountId: string, path: string, isDir?: boolean): boolean;
  /** Like access, for a whole folder: also every rule below must allow `need`. */
  accessAll(req: FastifyRequest, mountId: string, path: string, need: Level): Mount;
  /** Folder rules (ACL and AI release) follow a folder moved in the app. */
  rulesMoved(mountId: string, from: string, to: string, toMountId?: string): void;
  /** Rules (ACL, AI) of a move to another source, in steps – see rulesAcross in app.ts. */
  rulesAcross(mountId: string, from: string): RulesAcross;
  mountVisible(req: FastifyRequest, mountId: string): boolean;
  /** The mount, if the user sees anything in it; else 404. */
  visibleMount(req: FastifyRequest, mountId: string): Mount;
  mountOr404(id: string): Mount;
  mountRef(m: Mount): { id: string; name: string };
  /** Tree entries the user may see, each with its effective level (folders also when something inside is visible). */
  visibleEntries(req: FastifyRequest, mountId: string): (Entry & { access: Level })[];
  isDirPath(path: string): boolean;
  /** A source as the client sees it (local server paths only for admins, sync state, own level). */
  mountFor(req: FastifyRequest, m: Mount): object;
  connectionOr404(id: string): Connection;
  /** The connection a source form names (or the old credential choices), checked to fit the address. */
  connectionFor(req: FastifyRequest, b: { connectionId?: string | null; credential?: MountBody['credential'] }, source: string): Connection | null;
  /** The first Gitea connection (before connections, AD-029, there was one Gitea); 403 without one. */
  giteaConnection(): Connection;
  /** Access to a hoster for repository actions (archive, delete): the named connection or the first Gitea. */
  repoAccess(connectionId?: string | null): ReturnType<ConnectionStore['hostAccess']>;
  /** The connection, if it serves this address (else 400). */
  fitting(conn: Connection, source: string): Connection;
  /** Renames noticed in a source whose links could be repaired, per source. */
  pendingRepairs: Map<string, Move[]>;
  /** How many links an offered repair would change now. */
  offeredRepair(mount: Mount): Promise<number>;
  /** The sync detail of a source for this user (only what they may read). */
  syncDetailFor(req: FastifyRequest, m: Mount): string | null;
  /** A conflicted file (repository-relative) as a path of this source; null outside its subfolder or filter. */
  conflictRel(mount: Mount, path: string): string | null;
  /** A sync result for this user (sec2-002): only file names of this source the user may read. */
  syncResultFor(req: FastifyRequest, mount: Mount, r: SyncResult | null): SyncResult | null;

  // Session, setup and sign-in.
  /** Code for the first setup until the first admin exists (null afterwards, or when not required). */
  /** `restoring`: a database from a backup is staged, the server is about to start again (AD-075). */
  setup: { code: string | null; restoring?: boolean };
  setupFailures: FailureLimit;
  /** Ends the process so Docker starts it again; undefined in tests. */
  restart?: () => void;
  /** `git --version` of the container (shown to admins). */
  gitVersion: string;
  /** Sign-in through an auth proxy (AD-049). */
  proxy: ProxyAuth;
  /** When and from where the first request through a proxy came while TRUST_PROXY is not set (Reverse-Proxy tab). */
  proxyHint(): { at: string; proxy: string } | null;

  // Löschregeln and the nightly run (AD-034, nightly.ts).
  backupDir: string;
  reposDir: string;
  backups: BackupService;
  repoTrash: RepoTrash;
  /** A source without its secrets, as admins list it. */
  publicMount(m: Mount): object;
  /** Database backup now; returns the files written. */
  runBackup(opts?: { weekly?: boolean; manual?: boolean }): Promise<string[]>;
  runFsck(): Promise<FsckReport>;
  /** Every Löschregel once, each step on its own; what each removed. */
  runCleanup(step: (name: string, fn: () => Promise<unknown> | unknown) => Promise<void>): Promise<Record<string, number>>;
  /** Clones that sources use (everything else under data/repos is left behind). */
  usedClones(): Set<string>;
  /** The hoster repository of a remote source, when it is on a connected (or known) hoster – for webhooks. */
  hostedRepoOf(m: Mount): { connectionId: string; kind: Connection['kind']; fullName: string } | null;

  /** Operations of REST/MCP (AD-023); the app's move, copy and delete run through them as well (code-002). */
  ops: Ops;

  /** Content-Disposition for a download named `name.ext` (any characters). */
  download(name: string, ext: string): string;
  /** Löschregeln (AD-034) as stored. */
  rules(): Rules;
  trashDays(): number;
  /** When the push webhook last arrived, per source (settings „webhook_seen“). */
  webhookSeen(): Record<string, string>;
  /** Size limit of one upload in MB (admin setting). */
  attachmentMaxMb(): number;
  /** File endings that may not be attached (Einstellungen → Anhänge). */
  uploadBlocked(): ReadonlySet<string>;
  /** Tells the admins (security notification) that someone became an admin. */
  newAdmin(name: string, how: string): unknown;
}
