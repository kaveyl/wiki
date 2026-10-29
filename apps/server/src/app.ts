// HTTP application: wires services together and registers the REST API, the WebSocket
// event stream and the static web app. Every route goes through the auth hook except the
// explicitly public ones. SEE-DOC: HANDBOOK.md#modul-karte

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { basename, join, posix, sep } from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { CONTENT_ROUTES, fallbackLang, rememberUiLang, requestLang, translateFields, userLang } from './i18n/index.js';
import { isLang, SOURCE_LANG } from '@kaveyl-wiki/core';
import { AuthService, commitAuthor, FailureLimit, validEmail, type TokenScope, type User } from './auth/auth.js';
import { AccountMail } from './auth/accountmail.js';
import { Mailer } from './mail/mailer.js';
import { TRUST_OWN_NETWORK, type Config } from './config.js';
import { openDb, type DB } from './db/db.js';
import { EventBus } from './events.js';
import { git } from './git/git.js';
import { Indexer } from './index/indexer.js';
import { MountManager } from './mounts/manager.js';
import { MountStore, PathError, absPath, fileFilter, repoDir, type Mount } from './mounts/model.js';
import { insideRepo } from './mounts/sources.js';
import { HISTORY_BUNDLE } from './mounts/versions.js';
import { ConnectionStore, type Connection } from './mounts/connections.js';
import { isHostKind, kindForUrl } from './mounts/hosts.js';
import { ConflictError, ForbiddenError, NotFoundError, NoteService, type Move } from './notes/service.js';
import { createOps } from './api/ops.js';
import { registerApiV1 } from './api/v1.js';
import { registerMcp } from './api/mcp.js';
import { Providers } from './ai/providers.js';
import { AiRules } from './ai/rules.js';
import { createAssistant } from './ai/assistant.js';
import { registerAi } from './ai/routes.js';
import { createAgent } from './ai/agent.js';
import { createMemory } from './ai/memory.js';
import { IconStore } from './icons/icons.js';
import { CloudflareAccess, type JwksFetcher } from './auth/cloudflare.js';
import { defaultGateway, defaultGateway6, normalizeIp } from './auth/proxyAuth.js';
import { announceSetupCode, createSetupCode } from './auth/setupCode.js';
import { applyDbRestore } from './backups/dbRestore.js';
import { Acl, LEVELS, type Level } from './acl/acl.js';
import { BLOCKLIST_KEY, blockedTypes, DEFAULT_ATTACHMENT_MAX_MB, listAttachments, storeAttachment, UPLOAD_HARD_LIMIT } from './notes/attachments.js';
import type { SyncResult } from './git/sync.js';
import { publicError } from './errors.js';
import { ActivityLog, SYNC_ERROR_HIDDEN, type ActivityInput } from './activity.js';
import { readRules } from './cleanup.js';
import { RepoTrash } from './mounts/repo-trash.js';
import { SecretStore } from './secrets.js';
import { Notifier } from './notify/notifier.js';
import { RELEASES_URL, UpdateCheck } from './updates.js';
import { registerWatchRoutes } from './routes/watches.js';
import { EventHooks } from './hooks.js';
import { registerEventHookRoutes } from './routes/eventHooks.js';
import { Follows } from './follows.js';
import { ChangeFeed } from './changes.js';
import { Presence } from './presence.js';
import { TargetStore } from './backups/targets.js';
import { BackupService } from './backups/service.js';
import { registerBackups } from './backups/routes.js';
import { createProxyAuth, registerProxyAuth, type ProxyAuthDeps } from './auth/proxyRoutes.js';
import { Settings } from './settings.js';
import { COOKIE, sessionCookie } from './auth/session.js';
import type { AppContext, MountBody } from './routes/context.js';
import { registerRepoTrashRoutes } from './routes/repoTrash.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerCleanupRoutes } from './routes/cleanup.js';
import { registerMountRoutes } from './routes/mounts.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { registerImportRoutes } from './routes/importing.js';
import type { PictureFetcher } from './import/remote.js';
import { registerMailNoteRoutes } from './routes/mailNotes.js';
import { registerAclRoutes } from './routes/acl.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerLiveEvents } from './routes/liveEvents.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { registerAccountLinkRoutes } from './routes/accountLinks.js';
import { registerTreeRoutes } from './routes/tree.js';
import { registerPushWebhookRoutes } from './routes/pushWebhooks.js';
import { registerTrashRoutes } from './routes/trash.js';
import { registerUserStateRoutes } from './routes/userState.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerGitWebhook } from './routes/gitWebhook.js';
import { registerMailRoutes } from './routes/mail.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { registerUserRoutes } from './routes/users.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerReverseProxyRoutes } from './routes/reverseProxy.js';
import { createAccess } from './acl/access.js';
import { createMaintenance } from './nightly.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    /** Set when the request came with a personal API token (Bearer kw_…) instead of a session. */
    tokenScopes?: TokenScope[];
    rawBody?: string;
  }
}

export const DB_FILE = 'kaveyl-wiki.db';
/** A personal API token in the Authorization header. */
const TOKEN_RE = /^Bearer\s+(kw_[A-Za-z0-9_-]{20,})$/;
const PUBLIC = new Set([
  '/health',
  '/api/session',
  '/api/setup',
  '/api/setup/restore',
  '/api/login',
  '/api/logout',
  '/api/password/forgot',
  '/api/password/reset',
  '/api/invite/info',
  '/api/invite/accept',
  '/api/webhooks/git',
  '/api/v1/openapi.json',
]);
/** All a session may do while its password must be replaced first (AD-030). */
const WHILE_PASSWORD_CHANGE = new Set(['/api/session', '/api/logout', '/api/account/password']);

export interface App {
  server: FastifyInstance;
  db: DB;
  manager: MountManager;
  /** The nightly maintenance once (tests). */
  nightly(): Promise<void>;
  /** Backup plans and runs (AD-038). */
  backups: BackupService;
  /** „Beobachten“ (AD-066) – tests wait for messages with flush(). */
  follows: Follows;
  eventHooks: EventHooks;
  close(): Promise<void>;
}

export async function buildApp(
  config: Config,
  opts: {
    db?: DB;
    logger?: boolean;
    /** Nightly maintenance and the backup scheduler (off in most tests). */
    nightlyFsck?: boolean;
    cloudflareJwks?: JwksFetcher;
    /** Tests: fake Pushover API. */ pushoverUrl?: string;
    /** Tests: how long „Beobachten“ bundles changes into one message (default 2 minutes). */ watchBundleMs?: number;
    /** Tests: bundling and retries of event webhooks. */ eventHookOptions?: { bundleMs?: number; retryMs?: number[] };
    /** Tests: fake GitHub release list instead of RELEASES_URL. */ updateUrl?: string;
    /** Tests: fetches the pictures an import leaves on the old server (default: from the network, import/remote.ts). */
    importFetcher?: PictureFetcher;
    /** First-run setup needs the one-time code from the log (AD-043); on in main.ts, off in tests. */
    requireSetupCode?: boolean;
    /** Tests: the container's default gateway instead of the ones in /proc/net/route and /proc/net/ipv6_route. */
    gateway?: string | null;
    /** Ends the process so Docker starts it again (after a database came back in the setup, AD-075); main.ts. */
    restart?: () => void;
  } = {},
): Promise<App> {
  mkdirSync(config.dataPath, { recursive: true });
  // A database staged in the first-run setup (AD-075) replaces the one of the fresh start before anything opens it.
  const restoredDb = opts.db ? null : applyDbRestore(config.configPath, join(config.configPath, DB_FILE));
  const db = opts.db ?? openDb(join(config.configPath, DB_FILE));
  const server = Fastify({
    // Lean technical log (stdout → docker, rotated there): no line per GET/health check, see
    // the onResponse hook below; credentials are redacted as a second line of defense.
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.secret'], censor: '***' },
          },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 20 * 1024 * 1024,
    // Whose X-Forwarded-For counts (client IP in the log, login brake): TRUST_PROXY, default the own network (AD-047).
    trustProxy: config.trustProxy,
  });
  const events = new EventBus();
  const secrets = SecretStore.open(db, config.configPath);
  const connections = new ConnectionStore(db, secrets);
  // Data from before connections (global Gitea, own tokens) → connections (AD-029), idempotent.
  const adopted = connections.adoptLegacy(new Settings(db).get('gitea_base_url'));
  if (adopted.created || adopted.linked) server.log.info(adopted, 'connections taken over from earlier settings');
  const store = new MountStore(db);
  const indexer = new Indexer(db, config.dataPath);
  const activity = new ActivityLog(db);
  const manager = new MountManager(config, store, indexer, secrets, events, server.log, activity, connections);
  const changes = new ChangeFeed();
  manager.changes = changes;
  /** Event log entry; logging must never break a request. Never pass secrets (AD-013). */
  const record = (e: ActivityInput) => {
    try {
      activity.log(e);
    } catch (err) {
      server.log.warn({ err }, 'activity log failed');
    }
  };
  if (restoredDb)
    record({
      category: 'audit',
      action: 'setup-restored',
      actor: null,
      message: `Ersteinrichtung: Datenbank aus einer Sicherung zurückgespielt (${restoredDb.users} Konto/Konten, Datenbank v${restoredDb.version}) – ${restoredDb.key ? 'mit Schlüssel' : 'ohne Schlüssel, Zugangsdaten neu eintragen'}`,
    });
  const who = (req: FastifyRequest) => req.user?.username ?? null;
  const audit = (req: FastifyRequest, action: string, message: string, extra: Partial<ActivityInput> = {}) =>
    record({ category: 'audit', action, message, actor: who(req), ...extra, detail: { ip: req.ip, ...extra.detail } });
  const mountRef = (m: Mount) => ({ id: m.id, name: m.name });
  const notes = new NoteService(manager, config.dataPath, indexer);
  const presence = new Presence(events);
  // Days follow the Löschregeln (AD-034); `settings` is read lazily, when an entry is listed or due.
  const repoTrash = new RepoTrash(db, join(config.configPath, 'backups', 'repos'), undefined, () => {
    const r = readRules(settings);
    return { trash: r.repoTrashDays, bundles: r.repoBundleDays };
  });
  const icons = new IconStore(db);

  // Renames outside the app (VS Code, Wiki.js, git pull): links are repaired automatically
  // where the app commits anyway; in plain local folders the repair is only offered.
  const LINK_BOT = { name: 'Kaveyl Wiki', email: 'kaveyl-wiki@localhost' };
  const pendingRepairs = new Map<string, Move[]>();
  manager.onRenamed((mount, renamed) => {
    // What people follow and webhook filters on a renamed note move along (code-001).
    for (const r of renamed) {
      follows.moved(mount.id, r.from, r.to);
      eventHooks.moved(mount.id, r.from, r.to);
    }
    record({
      category: 'sync',
      action: 'renamed-outside',
      mount: mountRef(mount),
      message: `${renamed.length} Umbenennung${renamed.length === 1 ? '' : 'en'} außerhalb der App erkannt`,
      detail: { renamed: renamed.slice(0, 50).map((r) => `${r.from} → ${r.to}`), paths: renamed.flatMap((r) => [r.from, r.to]) },
    });
    if (mount.options.readonly) return;
    if (mount.options.autoCommit) {
      const message = `fix(links): Links nach Umbenennung angepasst (Kaveyl Wiki)`;
      void notes
        .repairLinks(mount, renamed, LINK_BOT, [], { message })
        .then((r) => r.links && record({ category: 'sync', action: 'links-repaired', mount: mountRef(mount), message: `${r.links} Link${r.links === 1 ? '' : 's'} in ${r.files.length} Datei${r.files.length === 1 ? '' : 'en'} repariert`, detail: { files: r.files, paths: r.files } }))
        .catch((e: unknown) => {
          server.log.warn({ err: e, mount: mount.id }, 'link repair failed');
          record({ category: 'error', level: 'warn', action: 'link-repair', mount: mountRef(mount), message: `Link-Reparatur fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` });
        });
      return;
    }
    pendingRepairs.set(mount.id, [...(pendingRepairs.get(mount.id) ?? []), ...renamed]);
    events.emit({ type: 'mount', mount });
  });
  /** Links an offered repair would change right now (renames may have been fixed meanwhile). */
  const offeredRepair = async (mount: Mount) => {
    const moves = pendingRepairs.get(mount.id);
    if (!moves?.length) return 0;
    const { links } = await notes.repairLinks(mount, moves, LINK_BOT, [], { dryRun: true });
    if (!links) pendingRepairs.delete(mount.id);
    return links;
  };
  const auth = new AuthService(db);
  /** Code for the first setup (in the container log), until the first admin exists. */
  const setup: { code: string | null; restoring?: boolean } = { code: opts.requireSetupCode && !auth.hasUsers() ? createSetupCode(config.configPath) : null };
  if (setup.code) announceSetupCode(setup.code);
  const setupFailures = new FailureLimit(5, 60_000);
  const settings = new Settings(db);
  const cloudflare = new CloudflareAccess(opts.cloudflareJwks);
  /** The container's Docker gateways (IPv4, IPv6) – never accepted as a proxy address (sec-002). Fixed while running. */
  const gateways = (opts.gateway !== undefined ? [opts.gateway] : [defaultGateway(), defaultGateway6()]).filter((g): g is string => !!g);
  /** Sign-in through an auth proxy (AD-049): settings, sign-in of a request, tabs – auth/proxyRoutes.ts. */
  const proxyDeps: ProxyAuthDeps = {
    auth,
    settings,
    gateways,
    record,
    // Defined further down; called only once requests arrive.
    audit: (req, action, message, extra) => audit(req, action, message, extra),
    requireAdmin: (req) => requireAdmin(req),
    sessionCookie,
    setSessionCookie: (reply, token) => setSessionCookie(reply, token),
    clearSessionCookie: (reply) => void reply.clearCookie(COOKIE, { path: '/' }),
  };
  const proxy = createProxyAuth(proxyDeps);
  const aiProviders = new Providers(settings, secrets);
  const aiRules = new AiRules(db);
  /** Folder rules (ACL and AI release) follow a folder moved in the app – and so do watches and webhook filters (code-001). */
  const rulesMoved = (mountId: string, from: string, to: string, toMountId = mountId) => {
    acl.moved(mountId, from, to, toMountId);
    aiRules.moved(mountId, from, to, toMountId);
    follows.moved(mountId, from, to, toMountId);
    eventHooks.moved(mountId, from, to, toMountId);
  };
  /**
   * Rules (ACL, AI) of a move to another source, taken before it starts (sec2-012…015). Nothing at the old place goes
   * before the move succeeded, so neither the copies nor the originals are ever open:
   * - `before` (after the checks, before the first copy): folder rules are copied; note rules – they follow note ids,
   *   which are per source – are copied as rules on the notes' new paths.
   * - `placed` (copies in the target and indexed): those copies become note rules on the notes' new ids (renames).
   * - `done` (only after success): the old note rules go; folder rules of a folder that is gone at the old place too,
   *   one that stayed (files left behind) keeps them.
   * - `failed` (the move stopped half-way): what arrived is indexed and its rules become note rules like in `placed`;
   *   copies for notes that never arrived go – no rule stays hidden on a bare path (sec2-017).
   */
  const rulesAcross = (mountId: string, from: string) => {
    const inside = (p: string) => p === from || p.startsWith(`${from}/`);
    const aclNotes = acl.rules(mountId).filter((r) => r.target === 'note' && !r.orphan && inside(r.path));
    const aiNotes = aiRules.rules(mountId).filter((r) => r.target === 'note' && !r.orphan && inside(r.path));
    let target = '';
    let targetPath = '';
    let copies: { store: 'acl' | 'ai'; id: string; at: string }[] = [];
    const before = (toMountId: string, to: string) => {
      target = toMountId;
      targetPath = to;
      acl.moved(mountId, from, to, toMountId, true);
      aiRules.moved(mountId, from, to, toMountId, true);
      const at = (p: string) => to + p.slice(from.length);
      copies = [
        ...aclNotes.map((r) => ({ store: 'acl' as const, id: acl.copyAsPathRule(r.id, toMountId, at(r.path)), at: at(r.path) })),
        ...aiNotes.map((r) => ({ store: 'ai' as const, id: aiRules.copyAsPathRule(r.id, toMountId, at(r.path)), at: at(r.path) })),
      ];
    };
    const placed = () => {
      const idAt = db.prepare('SELECT id FROM note_ids WHERE mount_id = ? AND path = ?');
      for (const c of copies) {
        const noteId = (idAt.get(target, c.at) as { id: string } | undefined)?.id;
        if (!noteId) continue; // stays a rule on the path – still closed
        if (c.store === 'acl') acl.pathRuleToNote(c.id, target, noteId);
        else aiRules.pathRuleToNote(c.id, target, noteId);
      }
    };
    const done = () => {
      for (const r of aclNotes) acl.removeRule(r.id);
      for (const r of aiNotes) aiRules.remove(r.id);
      follows.moved(mountId, from, targetPath, target);
      eventHooks.moved(mountId, from, targetPath, target);
      const mount = manager.get(mountId);
      if (mount && existsSync(absPath(mount, config.dataPath, from))) return;
      acl.dropFolderRules(mountId, from);
      aiRules.dropFolderRules(mountId, from);
    };
    const failed = async () => {
      const mount = manager.get(target);
      if (!mount || !copies.length) return;
      const arrived = copies.filter((c) => existsSync(absPath(mount, config.dataPath, c.at)));
      await indexer.update(mount, arrived.map((c) => c.at)).catch(() => undefined);
      placed();
      for (const c of copies) {
        if (arrived.includes(c)) continue;
        if (c.store === 'acl') acl.removeRule(c.id);
        else aiRules.remove(c.id);
      }
    };
    return { before, placed, done, failed };
  };
  const acl = new Acl(db, () => {
    const v = settings.get('acl_default');
    // Not set: „kein Zugriff“ (AD-051) – the admin shares sources; installations from before keep `write` (migration v17).
    return v && (LEVELS as readonly string[]).includes(v) ? (v as Level) : 'none';
  });
  // Note rules follow note ids: any index change may move a path.
  events.on((e) => {
    if (e.type === 'mount-removed') aiRules.removeMount(e.mountId);
    if (e.type === 'tree' || e.type === 'mount-removed') {
      acl.invalidate(e.mountId);
      aiRules.invalidate(e.mountId);
    }
  });
  const mailer = new Mailer(settings, secrets);
  // Mails go out in the recipient's account language (AD-046).
  mailer.langOf = (email) => {
    const u = auth.userByEmail(email);
    return u ? userLang(db, u.id) : undefined;
  };
  const accountMail = new AccountMail(db, auth, acl, mailer, (level, action, message, actor) => record({ category: 'audit', level, action, message, actor: actor ?? null }));
  // Notifications to admins (AD-035): mail to every admin with a real address, and/or Pushover.
  const notifier = new Notifier(
    settings,
    secrets,
    mailer,
    () => auth.listUsers().filter((u) => u.isAdmin && !u.disabled && validEmail(u.email)).map((u) => ({ email: u.email, displayName: u.displayName })),
    record,
    { pushoverUrl: opts.pushoverUrl ?? process.env.PUSHOVER_API_URL },
  );
  activity.onLog((e) => notifier.observe(e));
  // „Beobachten“ (AD-066): dots in the tree, e-mail and Pushover for what a person follows.
  const follows = new Follows(db, {
    person: (id) => {
      const u = auth.getUser(id);
      return u ? { id: u.id, email: validEmail(u.email) ? u.email : '', displayName: u.displayName || u.username, disabled: !!u.disabled } : null;
    },
    readable: (userId, mountId, path, isDir) => {
      const u = auth.getUser(userId);
      const m = manager.get(mountId);
      return !!u && !!m && !m.paused && acl.level({ id: u.id, isAdmin: u.isAdmin, isGuest: !!u.isGuest }, mountId, path, isDir) !== 'none';
    },
    mountName: (id) => manager.get(id)?.name ?? null,
    emit: (userId) => events.emit({ type: 'unread', userId }),
    mail: {
      configured: () => mailer.configured(),
      send: (m) => mailer.send(m),
      langOf: (email) => mailer.langOf(email),
      publicUrl: () => mailer.settings().publicUrl,
    },
    pushover: (userId, title, message, url) => notifier.pushoverToPerson(userId, title, message, url),
    failed: (userId, channel, e) =>
      record({ category: 'error', level: 'warn', action: 'watch-notify-failed', actor: auth.getUser(userId)?.username ?? null, message: `Beobachten: ${channel === 'mail' ? 'E-Mail' : 'Pushover'} nicht zugestellt – ${e instanceof Error ? e.message : String(e)}` }),
    fallbackLang,
  }, opts.watchBundleMs);
  changes.on((c) => follows.onChanges(c));
  // Event webhooks for agents (AD-066): signed POSTs with what changed, with the rights of one person.
  const eventHooks = new EventHooks(
    db,
    secrets,
    {
      readable: (userId, mountId, path, isDir) => {
        const u = auth.getUser(userId);
        const m = manager.get(mountId);
        return !!u && !u.disabled && !!m && !m.paused && acl.level({ id: u.id, isAdmin: u.isAdmin, isGuest: !!u.isGuest }, mountId, path, isDir) !== 'none';
      },
      personActive: (id) => {
        const u = auth.getUser(id);
        return !!u && !u.disabled;
      },
      mountName: (id) => manager.get(id)?.name ?? null,
      record: (level, action, message) => record({ category: 'sync', level, action, message }),
    },
    opts.eventHookOptions,
  );
  changes.on((c) => eventHooks.onChanges(c));
  // A removed source leaves nothing behind that nobody sees any more (code-001).
  events.on((e) => {
    if (e.type !== 'mount-removed') return;
    follows.mountRemoved(e.mountId);
    eventHooks.mountRemoved(e.mountId);
  });
  // Update hint for admins (AD-062): the newest public release, asked once a day.
  const updates = new UpdateCheck(
    settings,
    config.version,
    (level, message) => record({ category: 'system', level, action: 'update-check', message }),
    opts.updateUrl ?? process.env.KAVEYL_WIKI_UPDATE_URL ?? RELEASES_URL,
  );
  if (opts.nightlyFsck !== false) updates.start();
  const newAdmin = (name: string, how: string) =>
    notifier.dispatch({ event: 'security', title: 'Neuer Administrator', text: `${name} ist jetzt Administrator von Kaveyl Wiki (${how}).`, priority: 1 });
  // Backups to a folder or SMB share, with plans, keep rules and restore (AD-038).
  const backupTargets = new TargetStore(db, secrets, config.backupRoot, config.dataPath);
  const backups = new BackupService({
    db,
    targets: backupTargets,
    notes,
    dataPath: config.dataPath,
    mounts: () => manager.list(),
    mount: (id) => manager.get(id) ?? undefined,
    snapshotDb: (file) => db.prepare('VACUUM INTO ?').run(file),
    secretKey: () => secrets.keyBase64(),
    record: (e) => record({ category: e.category ?? 'system', level: e.level, action: e.action, message: e.message, mount: e.mount ? mountRef(e.mount) : undefined }),
    notify: (plan, problems, partial) => notifier.backupResult(plan, problems, partial),
    // A whole source back over its old place (AD-075): a local folder with versions but no Git yet (new server) takes the
    // history from the archive; a folder that was missing is read in again (its source stood on „Ordner nicht gefunden“).
    wholeRestored: async (mount, o, author) => {
      const dir = repoDir(mount, config.dataPath);
      let history = false;
      if (o.bundle && mount.type === 'local' && !mount.subpath && mount.options.autoCommit && !insideRepo(dir, config.localRoots)) {
        // Never through a link lying there (it could point at /config/secret.key): remove it, then create the file anew.
        const bundle = join(dir, HISTORY_BUNDLE);
        await rm(bundle, { force: true });
        await copyFile(o.bundle, bundle, fsConstants.COPYFILE_EXCL);
        history = (await manager.enableVersions(mount, author)).restored;
      }
      if (o.missing) await manager.reactivate(mount);
      return history;
    },
  });
  backups.markInterrupted();
  if (opts.nightlyFsck !== false) backups.start();
  if (!settings.get('webhook_secret')) settings.set('webhook_secret', randomBytes(24).toString('base64url'));
  const gitVersion = (await git(process.cwd(), ['--version'])).trim();

  await server.register(cookie);
  await server.register(websocket);

  // Keep the raw body (webhook signatures) while parsing JSON ourselves.
  // Routes read fields of an object body: anything else (null, list, string, number) is a 400 here, not a TypeError
  // in a handler (code-007). Exceptions: UI state stores any JSON value; MCP takes JSON-RPC batches (lists).
  const ANY_JSON = new Set(['/api/state/:key', '/mcp']);
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    let value: unknown;
    try {
      value = body ? JSON.parse(body as string) : {};
    } catch {
      return done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined);
    }
    if ((value === null || typeof value !== 'object' || Array.isArray(value)) && !ANY_JSON.has(req.routeOptions.url ?? '')) {
      return done(Object.assign(new Error('JSON-Objekt erwartet'), { statusCode: 400 }), undefined);
    }
    done(null, value);
  });

  server.decorateRequest('user', null);
  // A proxy is in front, but TRUST_PROXY is not set: hint once that it should name the proxy (AD-047, AD-048).
  let proxyHinted = config.trustProxy !== TRUST_OWN_NETWORK;
  /** For the Reverse-Proxy tab (AD-049): when and from where the hint above came. */
  let proxyHint: { at: string; proxy: string } | null = null;
  server.addHook('onRequest', async (req) => {
    if (proxyHinted || !req.headers['x-forwarded-for']) return;
    proxyHinted = true;
    proxyHint = { at: new Date().toISOString(), proxy: normalizeIp(req.socket.remoteAddress) };
    server.log.warn(
      { proxy: req.socket.remoteAddress },
      'X-Forwarded-For received without TRUST_PROXY – every proxy in the own network is trusted. The address of this first such request is probably the proxy – compare it with the address of the reverse proxy before setting TRUST_PROXY to it',
    );
    // Also in the app's own log, where admins look (AD-048).
    record({ category: 'system', level: 'warn', action: 'trust-proxy-missing', message: 'Anfragen kommen über einen Reverse-Proxy, aber TRUST_PROXY ist nicht gesetzt. Die Adresse unter Details stammt von der ersten solchen Anfrage und ist vermutlich der Proxy – vor dem Eintragen in TRUST_PROXY mit der Adresse des Reverse-Proxys abgleichen', detail: { proxy: req.socket.remoteAddress } });
  });
  server.addHook('onRequest', async (req, reply) => {
    // Decide on the route that will run, not the raw URL: the router decodes %-escapes (/%61pi/… is /api/…).
    // Unknown paths (404) fall back to the decoded path; broken escapes never get this far (router: 400).
    let url = req.routeOptions.url;
    if (url === undefined) {
      try {
        url = decodeURIComponent(req.url.split('?')[0]!);
      } catch {
        return reply.code(404).send({ error: 'Nicht gefunden' });
      }
    }
    const bearer = TOKEN_RE.exec(String(req.headers.authorization ?? ''));
    if (bearer && (url.startsWith('/api/') || url === '/mcp')) {
      // Personal API token (scripts, MCP, desktop clients). No cookies → no CSRF risk.
      const t = auth.userForToken(bearer[1]!);
      if (!t) return reply.code(401).send({ error: 'Token ungültig oder abgelaufen' });
      req.user = t.user;
      req.tokenScopes = t.scopes;
      // MCP: always POST; the tools check `write` themselves (api/mcp.ts).
      if (url === '/mcp') return t.scopes.includes('mcp') ? undefined : reply.code(403).send({ error: 'Token ohne Recht „mcp“' });
      const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      // Tokens are for scripts and AI clients: the REST API and the files notes link to. Settings, sources, accounts
      // and tokens stay with the browser login (AD-047).
      if (!url.startsWith('/api/v1/') && !(url.startsWith('/api/files/') && !writes)) return reply.code(403).send({ error: 'API-Tokens gelten nur für /api/v1, /mcp und Dateien – alles andere nur mit Anmeldung im Browser' });
      if (url.startsWith('/api/v1/admin') && !t.scopes.includes('admin')) return reply.code(403).send({ error: 'Token ohne Recht „admin“' });
      if (writes && !t.scopes.includes('write') && !t.scopes.includes('admin')) return reply.code(403).send({ error: 'Token ohne Recht „write“' });
      // Reading needs „read“ (write and admin include it) – a token with only „mcp“ reads nothing.
      if (!writes && !t.scopes.some((sc) => sc !== 'mcp')) return reply.code(403).send({ error: 'Token ohne Recht „read“' });
      return;
    }
    req.user = auth.userForSession(sessionCookie(req));
    // Cloudflare Access (off by default): a verified Access token of a known, active user signs in.
    if (!req.user && url.startsWith('/api/') && settings.get('cf_access_enabled') === '1') {
      const jwt = req.headers['cf-access-jwt-assertion'];
      const email = typeof jwt === 'string' ? await cloudflare.verify(jwt, { teamDomain: settings.get('cf_access_team') ?? '', aud: settings.get('cf_access_aud') ?? '' }) : null;
      const found = email ? auth.userByEmail(email) : null;
      const user = found && !found.disabled ? found : undefined;
      if (user) {
        const { token, expires } = auth.createSession(user.id);
        setSessionCookie(reply, token, expires);
        req.user = auth.getUser(user.id);
        record({ category: 'audit', action: 'login-cloudflare', actor: user.username, message: `Anmeldung über Cloudflare Access: ${user.username}`, detail: { ip: req.ip } });
      } else if (email) {
        record({ category: 'audit', level: 'warn', action: 'login-cloudflare-unknown', message: `Cloudflare Access: kein aktiver Benutzer mit dieser E-Mail`, detail: { ip: req.ip } });
      }
    }
    // Auth proxy (AD-049, off by default): headers count only on requests straight from a configured proxy address, only
    // on routes of the browser app – never on unknown paths (404) and never where a proxy usually lets requests through
    // without its own sign-in (REST API, webhooks), so headers a browser sent there itself are not believed (veto
    // 2026-10-16). A session the proxy made is no login for the REST API either (tokens only). Logout never signs in.
    const restOrHook = url.startsWith('/api/v1') || url.startsWith('/api/webhooks');
    if (req.user && restOrHook && auth.sessionProxy(sessionCookie(req))) req.user = null;
    if (req.routeOptions.url !== undefined && url.startsWith('/api/') && !restOrHook && url !== '/api/logout') proxy.signIn(req, reply);
    if (!url.startsWith('/api/') || PUBLIC.has(url)) return;
    if (!req.user) return reply.code(401).send({ error: 'Nicht angemeldet' });
    // The browser names the account whose editor sent this (code-012): one account's edits never land under another's
    // session (signed in meanwhile in another tab). Without the header (REST API, MCP, scripts) nothing changes.
    const expected = req.headers['x-kaveyl-wiki-user'];
    if (typeof expected === 'string' && expected !== req.user.id) {
      return reply.code(403).send({ error: 'Inzwischen ist hier ein anderes Konto angemeldet – nichts gespeichert', code: 'other-user' });
    }
    const shown = req.headers['x-kaveyl-wiki-lang'];
    if (!req.tokenScopes && typeof shown === 'string' && isLang(shown)) rememberUiLang(db, req.user.id, shown);
    if (req.user.mustChangePassword && !req.tokenScopes && !WHILE_PASSWORD_CHANGE.has(url)) {
      return reply.code(403).send({ error: 'Bitte zuerst ein neues Passwort festlegen', code: 'password-change-required' });
    }
    // CSRF: state-changing requests must be JSON (cross-site forms cannot send that without CORS).
    // Uploads are binary instead and need a custom header, which also forces a CORS preflight.
    if (req.method === 'POST' && (url.startsWith('/api/attachments/') || url.startsWith('/api/icons') || /^\/api\/import\/[^/]+\/upload$/.test(url))) {
      if (req.headers['x-kaveyl-wiki-upload'] !== '1') return reply.code(415).send({ error: 'Upload-Kennung fehlt' });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return reply.code(415).send({ error: 'Content-Type application/json erforderlich' });
    }
  });

  // Only changes, failures and slow requests; the URL without query string (search terms).
  server.addHook('onResponse', async (req, reply) => {
    const ms = reply.elapsedTime;
    const status = reply.statusCode;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && status < 400 && ms < 1000) return;
    const line = { method: req.method, url: req.url.split('?')[0], status, ms: Math.round(ms), user: req.user?.username ?? null };
    if (status >= 500) req.log.error(line, 'request failed');
    else if (status >= 400 || ms >= 1000) req.log.warn(line, status >= 400 ? 'request rejected' : 'slow request');
    else req.log.info(line, 'request');
  });

  server.setErrorHandler((err, req, reply) => {
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message, currentHash: err.currentHash, currentRaw: err.currentRaw });
    const pub = publicError(err);
    if (pub) return reply.code(pub.status).send({ error: pub.message, ...(pub.code && { code: pub.code }) });
    const e = err as Error;
    req.log.error(e);
    record({ category: 'error', action: 'server-error', actor: who(req), message: `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}: ${e.message || 'Interner Fehler'}` });
    // The internal text stays in the log above; the answer is general (sec-008, CWE-209).
    return reply.code(500).send({ error: 'Interner Fehler' });
  });

  // CSP of the web app (sec-006): scripts only from the app itself plus the inline theme script of index.html by its
  // hash (read once here); no inline scripts or handlers. 'unsafe-eval' only because Excalidraw's font subsetting
  // (harfbuzz via embind) builds functions with new Function on the main thread – without it every drawing with text
  // embeds whole fonts (~20× larger SVG). WASM: Excalidraw fonts, image scaling. Workers from the app or blob: (pica).
  // Inline styles: KaTeX, Mermaid and Excalidraw write style attributes and <style> elements. Pictures in notes may come
  // from anywhere (sec-003). Excalidraw loads the CJK font it does not ship from its CDN (vite.config.ts). WebSocket
  // via ws:/wss: (not every browser counts it as 'self'). Frames: printing (self), web embeds in drawings (https).
  const indexHtml = join(config.webRoot, 'index.html');
  const inlineScripts = existsSync(indexHtml)
    ? [...readFileSync(indexHtml, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => ` 'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`)
    : [];
  const appCsp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'${inlineScripts.join('')}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data: https://esm.sh",
    "connect-src 'self' ws: wss: data: blob: https://esm.sh",
    "frame-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

  // Security headers on every answer (web app, static files, API). Routes with their own CSP (files, export) keep it.
  // HSTS only over https, the same test as the Secure cookie (protocol via TRUST_PROXY).
  server.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', appCsp);
    reply.header('x-frame-options', 'SAMEORIGIN').header('referrer-policy', 'same-origin');
    // A private wiki behind a login: no answer (pages, help, images, JSON) belongs in a search index (seo-001).
    reply.header('x-robots-tag', 'noindex, nofollow');
    if (req.protocol === 'https') reply.header('strict-transport-security', 'max-age=15552000');
    return payload;
  });

  // Interface language (AD-046): errors and message fields of JSON answers in the language of the request.
  // The code writes German; without a dictionary entry the German text goes out.
  server.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' || payload.length > 2_000_000) return payload;
    const lang = requestLang(req);
    if (lang === SOURCE_LANG || !String(reply.getHeader('content-type') ?? '').includes('application/json')) return payload;
    // Note content is never translated: content routes and MCP results (the MCP layer translates its own errors).
    // Judged by the route that ran, not the raw URL (%-escapes); unknown paths fall back to the decoded path.
    let url = req.routeOptions.url;
    if (url === undefined) {
      try {
        url = decodeURIComponent(req.url.split('?')[0]!);
      } catch {
        url = req.url.split('?')[0]!;
      }
    }
    if (reply.statusCode < 400 && (CONTENT_ROUTES.test(url) || url === '/mcp')) return payload;
    if (!/"(error|message|detail|reason|hint|warnings?|summary|problems?|label|text)":/.test(payload)) return payload;
    try {
      return JSON.stringify(translateFields(lang, JSON.parse(payload)));
    } catch {
      return payload;
    }
  });

  // The change feed (AD-066) also learns who it was and by which way; Git only gets name and address.
  const viaOf = (req: FastifyRequest) => {
    const route = req.routeOptions.url ?? '';
    return route === '/mcp' ? ('mcp' as const) : route.startsWith('/api/v1/') ? ('api' as const) : ('app' as const);
  };
  const author = (req: FastifyRequest) => ({ ...commitAuthor(req.user!), userId: req.user!.id, via: viaOf(req) });
  const requireAdmin = (req: FastifyRequest) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Nur für Administratoren');
    if (req.tokenScopes && !req.tokenScopes.includes('admin')) throw new ForbiddenError('Token ohne Recht „admin“');
  };

  // ── Access control (AD-020): the one check every note route makes (acl/access.ts) ───
  const { mountOr404, isDirPath, levelIn, access, canRead, accessAll, mountVisible, visibleMount, visibleEntries } = createAccess({ acl, manager, indexer });
  /** The repository on a hoster (enables repo actions, webhooks): via the own connection, else a hoster
   *  connection whose address matches (public repositories mounted without connection). */
  const hostedRepoOf = (m: Mount) => {
    const conn = m.connectionId ? connections.get(m.connectionId) : null;
    const host = m.type !== 'remote' ? null : conn && isHostKind(conn.kind) ? conn : !conn ? connections.findHostFor(m.source) : null;
    const fullName = host ? connections.repoOf(host, m.source) : null;
    return host && fullName ? { connectionId: host.id, kind: host.kind, fullName } : null;
  };
  /** Last push webhook per source (AD-033): settings key, mount id → ISO time. */
  const webhookSeen = (): Record<string, string> => JSON.parse(settings.get('webhook_seen') ?? '{}') as Record<string, string>;
  const publicMount = (m: Mount) => {
    const { credentialId, ...rest } = m;
    const conn = m.connectionId ? connections.get(m.connectionId) : null;
    const hostedRepo = hostedRepoOf(m);
    // `git`: remote repos and local folders inside a Git work tree (commit options, symbol in the sidebar).
    return {
      ...rest,
      hasCredential: !!credentialId || !!conn?.secretId,
      connection: conn ? { id: conn.id, kind: conn.kind, name: conn.name } : null,
      hostedRepo,
      webhookAt: webhookSeen()[m.id] ?? null,
      git: m.type === 'remote' || insideRepo(repoDir(m, config.dataPath), config.localRoots),
    };
  };
  /** A source's sync detail for this user (sec-004): conflict files only those of this source the user may read, an
   * error only as a general text for users without admin rights. */
  const syncDetailFor = (req: FastifyRequest, m: Mount): string | null => {
    if (req.user?.isAdmin || !m.syncDetail) return m.syncDetail;
    if (m.syncStatus === 'error') return SYNC_ERROR_HIDDEN;
    if (m.syncStatus !== 'conflict') return m.syncDetail;
    const prefix = m.subpath ? `${m.subpath}/` : '';
    try {
      const c = JSON.parse(m.syncDetail) as { files?: unknown };
      const files = (Array.isArray(c.files) ? c.files : []).filter(
        (f): f is string => typeof f === 'string' && f.startsWith(prefix) && canRead(req, m.id, f.slice(prefix.length)),
      );
      return JSON.stringify({ ...c, files });
    } catch {
      return null;
    }
  };
  const mountFor = (req: FastifyRequest, m: Mount) => {
    const pub = publicMount(m);
    // Server paths of local folders are none of a normal user's business: only the folder name.
    const source = m.type === 'local' && !req.user?.isAdmin ? basename(m.source) : pub.source;
    return { ...pub, source, syncDetail: syncDetailFor(req, m), access: levelIn(req, m.id, '', true) };
  };
  /**
   * Without `expires` the cookie lives as long as the browser session ("Angemeldet bleiben" off). Came the request over
   * https (directly or through a trusted proxy, X-Forwarded-Proto), the cookie is https-only; over plain http in the own
   * network (e.g. :8093) it must not be, or the browser drops it (AD-047).
   */
  const setSessionCookie = (reply: FastifyReply, token: string, expires?: Date) =>
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: reply.request.protocol === 'https', path: '/', expires });

  /**
   * A conflicted file (repository-relative) as a path of this source; null outside its subfolder or file
   * filter – sources can share a clone. Only used for users other than admins.
   */
  const conflictRel = (mount: Mount, path: string): string | null => {
    const prefix = mount.subpath ? `${mount.subpath}/` : '';
    if (!path.startsWith(prefix)) return null;
    const rel = path.slice(prefix.length);
    return /\.md$/i.test(rel) && !fileFilter(mount)(rel) ? null : rel;
  };
  /** A sync result for this user (audit sec2-002): file names only of this source and only those the user may read. */
  const syncResultFor = (req: FastifyRequest, mount: Mount, r: SyncResult | null): SyncResult | null => {
    if (!r || req.user?.isAdmin) return r;
    const readable = (path: string) => {
      const rel = conflictRel(mount, path);
      return rel !== null && canRead(req, mount.id, rel);
    };
    return {
      ...r,
      incoming: r.incoming.filter((c) => readable(c.path) && (!c.from || readable(c.from))),
      ...(r.conflict ? { conflict: { ...r.conflict, files: r.conflict.files.filter(readable) } } : {}),
    };
  };
  /** Database backups (nightly, manual) and the clones of remote sources. */
  const backupDir = join(config.configPath, 'backups');
  const reposDir = join(config.dataPath, 'repos');
  /** Content-Disposition for a download named `name.ext` (any characters; ASCII fallback plus UTF-8 name). */
  const download = (name: string, ext: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}.${ext}`;
  /** Size limit of one upload in MB (admin setting, at most UPLOAD_HARD_LIMIT). */
  const uploadBlocked = () => blockedTypes(settings.get(BLOCKLIST_KEY));
  const attachmentMaxMb = () => Math.min(UPLOAD_HARD_LIMIT / 1024 / 1024, Math.max(1, Number(settings.get('attachment_max_mb') ?? DEFAULT_ATTACHMENT_MAX_MB) || DEFAULT_ATTACHMENT_MAX_MB));
  const connectionOr404 = (id: string): Connection => {
    const c = connections.get(id);
    if (!c) throw new NotFoundError(id);
    return c;
  };
  /** The first Gitea connection, as the former "Settings → Gitea" (compatibility routes). */
  const giteaConnection = (): Connection => {
    const c = connections.defaultGitea();
    if (!c) throw new ForbiddenError('Gitea-Zugang ist nicht eingerichtet');
    return c;
  };
  /** A connection's token only ever goes to its own server. */
  const fitting = (conn: Connection, source: string): Connection => {
    let origin = '';
    try {
      origin = new URL(source).origin;
    } catch {
      origin = '';
    }
    if (new URL(conn.baseUrl).origin !== origin) throw new PathError(`„${conn.name}“ gehört zu ${conn.baseUrl}, die Quelle liegt auf ${origin || source}`);
    return conn;
  };
  /** Connection of a new source or a wizard call: by id, or the older `credential` form. */
  const connectionFor = (req: FastifyRequest, b: { connectionId?: string | null; credential?: MountBody['credential'] }, source: string): Connection | null => {
    if (b.connectionId) return fitting(connectionOr404(b.connectionId), source);
    if (b.credential?.kind === 'gitea') return fitting(giteaConnection(), source);
    if (b.credential?.kind === 'token' && b.credential.token) {
      const c = connections.create({ kind: kindForUrl(source), baseUrl: source, token: b.credential.token, username: b.credential.username ?? null });
      audit(req, 'connection-added', `Verbindung angelegt: ${c.name}`);
      return c;
    }
    return null;
  };
  /** Hoster access of the connection a repository action names (default: the first Gitea). */
  const repoAccess = (connectionId?: string | null) => connections.hostAccess(connectionId ? connectionOr404(connectionId) : giteaConnection());
  // Public REST API v1 + MCP server (AD-023); the app's move, copy and delete use it too (code-002).
  const ops = createOps({
    editingNow: (mountId, path) => presence.list(mountId, path).filter((u) => u.editing),
    changes,
    rulesMoved,
    rulesAcross,
    db,
    manager,
    notes,
    indexer,
    access,
    accessAll,
    canRead,
    levelIn,
    mountVisible,
    syncDetailFor,
    syncResultFor,
    visibleMount,
    visibleEntries,
    author,
    audit: (req, action, message, mount) => audit(req, action, message, { mount: mountRef(mount) }),
    attach: (req, mount, notePath, name, data, maxBytes) =>
      storeAttachment(manager, config.dataPath, mount, notePath, name, data, Math.min(maxBytes, attachmentMaxMb() * 1024 * 1024), author(req), uploadBlocked()),
    attachments: (mount, raw, notePath) => listAttachments(config.dataPath, mount, raw, notePath),
  });
  // AI assistant (AD-011, AD-024): before the nightly run, which prunes its chats.
  const assistant = createAssistant({
    db,
    manager,
    notes,
    providers: aiProviders,
    rules: aiRules,
    canRead,
    visibleMount,
    audit: (req, action, message, detail) => audit(req, action, message, { detail }),
  });
  // ── Nightly run, consistency check, Löschregeln helpers (nightly.ts) ─────────────────
  const maintenance = createMaintenance({
    config,
    db,
    settings,
    manager,
    indexer,
    activity,
    auth,
    accountMail,
    notes,
    repoTrash,
    backups,
    notifier,
    backupDir,
    reposDir,
    record,
    log: server.log,
    repoAccess,
    pruneAiChats: (days) => assistant.prune(days),
  });
  if (opts.nightlyFsck !== false) maintenance.schedule();
  /** What the route modules share (routes/context.ts). Everything in it is defined above. */
  const ctx: AppContext = {
    config,
    db,
    settings,
    auth,
    acl,
    manager,
    notes,
    icons,
    activity,
    accountMail,
    mailer,
    notifier,
    updates,
    cloudflare,
    connections,
    presence,
    follows,
    eventHooks,
    indexer,
    events,
    record,
    audit,
    who,
    requireAdmin,
    author,
    levelIn,
    access,
    canRead,
    accessAll,
    rulesMoved,
    rulesAcross,
    mountVisible,
    visibleMount,
    mountOr404,
    mountRef,
    visibleEntries,
    isDirPath,
    mountFor,
    setSessionCookie,
    connectionOr404,
    connectionFor,
    fitting,
    giteaConnection,
    repoAccess,
    pendingRepairs,
    offeredRepair,
    syncDetailFor,
    conflictRel,
    syncResultFor,
    setup,
    setupFailures,
    restart: opts.restart,
    gitVersion,
    proxy,
    backupDir,
    reposDir,
    backups,
    repoTrash,
    publicMount,
    runBackup: maintenance.runBackup,
    runFsck: maintenance.runFsck,
    runCleanup: maintenance.runCleanup,
    usedClones: maintenance.usedClones,
    hostedRepoOf,
    download,
    rules: maintenance.rules,
    trashDays: maintenance.trashDays,
    proxyHint: () => proxyHint,
    newAdmin,
    attachmentMaxMb,
    uploadBlocked,
    webhookSeen,
    ops,
  };

  // ── Health & session ──────────────────────────────────────────────────────────────
  registerSessionRoutes(server, ctx);
  // ── Passwort vergessen and invitation links (public; the token is the authorization) ──
  registerAccountLinkRoutes(server, ctx);
  // ── Users (admins, Phase 4) ──────────────────────────────────────────────────────
  registerUserRoutes(server, ctx);
  // ── Benachrichtigungen (AD-035) ──────────────────────────────────────────────────────
  registerNotificationRoutes(server, ctx);
  registerUpdateRoutes(server, ctx);
  // ── E-Mail-Versand (SMTP, AD-030) ────────────────────────────────────────────────────
  registerMailRoutes(server, ctx);
  // ── Groups and Cloudflare Access (routes/groups.ts) ──────────────────────────────────
  registerGroupRoutes(server, ctx);
  // ── Auth proxy (AD-049, AD-058): Authentik (auth/proxyRoutes.ts); status of the reverse proxy ─────────────
  registerProxyAuth(server, proxy, proxyDeps);

  registerReverseProxyRoutes(server, ctx);

  // ── Access rules (AD-020): default level, who can be picked, rules per target ───────────────────────
  registerAclRoutes(server, ctx);
  // ── Personal API tokens (AD-023, AD-047) ────────────────────────────────────────────────────────────
  registerTokenRoutes(server, ctx);
  registerImportRoutes(server, ctx, opts.importFetcher);
  registerMailNoteRoutes(server, ctx);
  // ── Sources: list, add, change, remove, status, commit now, link repair, conflicts, sync, order ─────
  registerMountRoutes(server, ctx);
  // ── Activity log ─────────────────────────────────────────────────────────────────
  registerActivityRoutes(server, ctx);

  // ── Löschregeln (AD-034): all rules, what they currently hold, and „Jetzt aufräumen“ ────
  registerCleanupRoutes(server, ctx);
  // ── Connections (AD-029) ──────────────────────────────────────────────────────────
  registerConnectionRoutes(server, ctx);
  // ── Push webhooks (AD-033) ────────────────────────────────────────────────────────────
  registerPushWebhookRoutes(server, ctx);
  // ── Deleting repositories (admin): trash = archived for 30 days, or delete now ─────────
  registerRepoTrashRoutes(server, ctx);
  // ── Wizard for new sources: branches, folder tree, local folders ─────────────────────
  registerSourceRoutes(server, ctx);
  // ── Tree, notes, search ───────────────────────────────────────────────────────────
  registerTreeRoutes(server, ctx);
  // ── Trash of deleted notes (AD-025) ───────────────────────────────────────────────
  registerTrashRoutes(server, ctx);
  // ── HTML export and print view (Phase 6, AD-027) ──────────────────────────────────
  registerNoteRoutes(server, ctx);
  // ── Public REST API v1 + MCP server (AD-023): one operations layer, same ACL ───────
  registerApiV1(server, ops);
  registerMcp(server, ops, config.version);

  // ── AI assistant (AD-011, AD-024) ───────────────────────────────────────────────
  const memory = createMemory({ manager, rules: aiRules, dataPath: config.dataPath, rootReadable: (req, mountId) => canRead(req, mountId, '', true) });
  const agent = createAgent({
    db,
    dataPath: config.dataPath,
    manager,
    notes,
    providers: aiProviders,
    rules: aiRules,
    ops,
    assistant,
    memory,
    levelIn,
    accessAll,
    author,
    rulesMoved,
    audit: (req, action, message, detail) => audit(req, action, message, { detail }),
  });
  registerBackups(server, {
    backups,
    targets: backupTargets,
    requireAdmin,
    author,
    mount: (id) => manager.get(id) ?? undefined,
    audit: (req, action, message, mount) => audit(req, action, message, mount ? { mount: mountRef(mount) } : {}),
  });
  registerAi(server, {
    assistant,
    agent,
    memory,
    author,
    providers: aiProviders,
    rules: aiRules,
    settings,
    requireAdmin,
    visibleMount,
    audit: (req, action, message, mount) => audit(req, action, message, mount ? { mount: mountRef(mount) } : {}),
  });

  // ── Attachments (docs/PLAN.md §2.6) ──────────────────────────────────────────────
  registerAttachmentRoutes(server, ctx);
  // ── Custom icons (AD-018): global, any user may add; delete own (admins: all) ────────────
  registerLibraryRoutes(server, ctx);
  // ── Per-user UI state (tabs, layout) ──────────────────────────────────────────────
  registerUserStateRoutes(server, ctx);
  registerWatchRoutes(server, ctx);
  registerEventHookRoutes(server, ctx);
  // ── Live events ───────────────────────────────────────────────────────────────────
  registerLiveEvents(server, ctx);
  // ── Webhook (Gitea/GitHub push) ───────────────────────────────────────────────────
  registerGitWebhook(server, ctx);
  // ── Web app ───────────────────────────────────────────────────────────────────────
  if (existsSync(join(config.webRoot, 'index.html'))) {
    // Files under /assets/ carry a content hash in their name (vite): cached for good (seo-006). Everything
    // else (index.html, sw.js, manifest, /hilfe/ …) keeps max-age=0, so a new version arrives at once.
    const assets = join(config.webRoot, 'assets') + sep;
    // Compressed app files (seo-004): the bundles shrink to about a third. Registered here, after every API route,
    // so it only reaches the static files below: API answers, WebSocket, AI stream and downloads stay as they are.
    // Text types only; range requests (206) stay uncompressed (the plugin skips them). Request bodies untouched.
    await server.register(compress, {
      encodings: ['br', 'gzip'],
      customTypes: /^(?:text\/(?:html|css|javascript|plain|markdown)|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)(?:;|$)/,
      globalDecompression: false,
    });
    // The build lays .br (quality 11) and .gz (-9) next to the text files (vite.config.ts): those go out as they are and
    // the plugin above leaves them alone (already encoded); without them it compresses at run time as before.
    await server.register(fastifyStatic, {
      root: config.webRoot,
      wildcard: false,
      preCompressed: true,
      globIgnore: ['**/*.br', '**/*.gz'],
      setHeaders: (reply, path) => {
        if (path.startsWith(assets)) reply.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    server.setNotFoundHandler((req, reply) => {
      // Decided on the decoded, normalized path as the router sees it (/%61pi/… is /api/…, sec-001).
      let path: string;
      try {
        path = posix.normalize(decodeURIComponent(req.url.split('?')[0]!));
      } catch {
        path = '/api/';
      }
      // The app's own page addresses: / , note links /n/<source>/<path> (these end in .md) and /t/<source>/<folder>
      // (a folder or source in the tree, from a share mail).
      if (path === '/' || path.startsWith('/n/') || path.startsWith('/t/')) return reply.sendFile('index.html');
      // Everything else is a real 404, not the app with 200 (seo-002, soft 404): API paths and missing files
      // (sitemap.xml, favicon.ico, an old asset …) get JSON; an unknown page address still opens the app.
      if (path === '/api' || path.startsWith('/api/') || /\/[^/]*\.[^/]+$/.test(path)) return reply.code(404).send({ error: 'Nicht gefunden' });
      return reply.code(404).sendFile('index.html');
    });
  }

  record({ category: 'system', action: 'start', message: `Kaveyl Wiki gestartet (${config.version})` });

  return {
    server,
    db,
    manager,
    nightly: maintenance.nightly,
    backups,
    follows,
    eventHooks,
    /**
     * Shutdown (docker stop/restart: SIGTERM, killed after the grace period). The pending commits
     * come first: no new requests (503), a short wait for requests in flight (an edit being saved),
     * then commit and push — only then are connections that still hang on cut.
     */
    async close() {
      const t0 = Date.now();
      maintenance.stop();
      updates.stop();
      presence.stop();
      // Event webhooks bundled right now go out first instead of being dropped – a few seconds at most. Beobachten
      // messages wait in the database and go out after the start (AD-068).
      await Promise.race([eventHooks.flush(), new Promise((r) => setTimeout(r, 3000).unref())]);
      follows.stop();
      eventHooks.stop();
      backups.stop();
      await backups.closeAll();
      record({ category: 'system', action: 'stop', message: 'Kaveyl Wiki wird beendet' });
      let open = true;
      const closing = server.close().then(() => (open = false));
      await Promise.race([closing, new Promise((r) => setTimeout(r, 3000).unref())]);
      const t1 = Date.now();
      await manager.stop();
      const t2 = Date.now();
      if (open) {
        server.log.warn('shutdown: requests still open after 3 s – closing their connections');
        server.server.closeAllConnections();
        await closing;
      }
      server.log.info({ requestsMs: t1 - t0, flushMs: t2 - t1, totalMs: Date.now() - t0 }, 'shutdown done');
      db.close();
    },
  };
}
