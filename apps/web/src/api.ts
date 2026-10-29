// Typed client for the Kaveyl Wiki REST API (same origin; session cookie).
import type { AccountProxy, PMNode, ProxyAuthSettings, ProxyAuthState, ProxyProvider, TagColor } from '@kaveyl-wiki/core';
import { lang, t } from './i18n';
import { rememberFolderNotes } from './names';

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  disabled?: boolean;
  /** Sees only what is shared with them (AD-030). */
  isGuest?: boolean;
  /** Must set a new password before anything else (policy, or a start password from the admin). */
  mustChangePassword?: boolean;
  /** Auth proxies the account is connected to (AD-049; admin list only). */
  proxyLinks?: ProxyProvider[];
  /** Last sign-in or use, to the hour; null = never (owner 21.10.). */
  lastSeenAt?: string | null;
}

/** At the top of a source for one person: their own rule, and what would apply without it and from where. */
export interface TopWhy {
  own: AccessLevel | null;
  inherited: AccessLevel;
  via: 'group' | 'all' | 'default' | null;
  viaId?: string;
  /** One of their groups locks them out here – nothing but removing that lock (or the membership) helps. */
  groupLock?: boolean;
}

/** Settings → Benutzer & Rechte → Rechte (admins). */
export interface RightsOverview {
  defaultLevel: AccessLevel;
  mounts: { id: string; name: string }[];
  users: {
    id: string;
    name: string;
    email: string;
    isAdmin: boolean;
    isGuest: boolean;
    disabled: boolean;
    lastSeenAt: string | null;
    groups: string[];
    /** What they may at the top of each source… */
    sources: Record<string, AccessLevel>;
    /** …and why (empty for admins). */
    why: Record<string, TopWhy>;
  }[];
  groups: { id: string; name: string; members: string[] }[];
  rules: { id: string; mountId: string; target: AclTarget; path: string; subject: 'all' | 'group' | 'user'; subjectId: string | null; level: AccessLevel; orphan?: boolean }[];
}

// Proxy sign-in (AD-049): one definition with the server (code-006).
export type { AccountProxy, ProxyAuthSettings, ProxyAuthState, ProxyField, ProxyProvider } from '@kaveyl-wiki/core';
export interface ReverseProxyState {
  trustProxy: string | null;
  socket: string;
  clientIp: string;
  forwarded: boolean;
  viaTrustedProxy: boolean;
  https: boolean;
  hint: { at: string; proxy: string } | null;
}

export type SmtpSecurity = 'starttls' | 'tls' | 'none';
/** Notifications for admins (AD-035). */
export type NotifyEvent = 'sync' | 'nightly' | 'backup' | 'security';
export type NotifyChannel = 'mail' | 'pushover';
export interface NotifyOverview {
  rules: Record<NotifyEvent, Record<NotifyChannel, boolean>>;
  pushover: { tokenSet: boolean; userKeySet: boolean; device: string };
  /** Ready to deliver: mail = SMTP set up and an admin with an address; pushover = keys stored. */
  channels: Record<NotifyChannel, boolean>;
  recipients: string[];
  /** Beobachten: at most this many messages per person and day (AD-068). */
  followPerDay: number;
}

/** Update hint (AD-062): what the server's last look at the public releases found. */
export interface UpdateState {
  enabled: boolean;
  current: string;
  latest: { version: string; url: string; security: boolean; published: string | null } | null;
  newer: boolean;
  checkedAt: string | null;
  /** 'unreachable', 'timeout', 'invalid' or 'status:<code>'. */
  problem: string | null;
}

export interface MailSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  fromAddress: string;
  fromName: string;
  publicUrl: string;
  passwordSet: boolean;
  configured: boolean;
}

/** What a link from a mail (#reset=…, #invite=…) is about. */
export interface MailTokenInfo {
  kind: 'reset' | 'invite';
  email: string;
  displayName: string;
  note?: string;
  /** Shared folder or whole source (sharing, owner 21.10.). */
  folder?: string;
  source?: string;
  level?: 'read' | 'write';
  inviter?: string;
  accountExists: boolean;
}

export type TokenScope = 'read' | 'write' | 'mcp' | 'admin';

export type AiProviderKind = 'ollama' | 'ollama-cloud' | 'anthropic' | 'openrouter' | 'openai';
export interface AiProvider {
  id: string;
  kind: AiProviderKind;
  name: string;
  baseUrl?: string;
  model: string;
  cloud: boolean;
  hasKey?: boolean;
}
export type AiLevel = 'none' | 'read' | 'suggest';
export interface AiRule {
  id: string;
  mountId: string;
  target: 'mount' | 'folder' | 'note';
  path: string;
  level: AiLevel;
  cloud: boolean;
  orphan?: boolean;
}
export type AiAction = 'rewrite' | 'shorten' | 'expand' | 'grammar' | 'translate' | 'summarize' | 'continue' | 'custom';
export type AiScope = { kind: 'note' | 'folder'; mountId: string; path: string } | { kind: 'source'; mountId: string } | { kind: 'all' } | { kind: 'general' };
export interface AiSource {
  n: number;
  mountId: string;
  path: string;
  title: string;
}
/** A change the AI agent proposed; carried out only when the user applies it (AD-026). */
export interface AiProposal {
  id: string;
  chatId: string;
  kind: 'create' | 'write' | 'move' | 'remember';
  mountId: string;
  mountName: string;
  path: string;
  toPath: string | null;
  title: string | null;
  content: string | null;
  reason: string | null;
  status: 'open' | 'applied' | 'rejected' | 'failed';
  result: string | null;
  createdAt: string;
}
export type AiAgentEvent =
  | { type: 'start'; mode: 'agent' | 'rag' }
  | { type: 'step'; tool: string; label: string }
  | { type: 'delta'; text: string }
  | { type: 'proposal'; proposal: AiProposal }
  | { type: 'answer'; chatId: string; answer: string; sources: AiSource[]; provider: string; model: string; mode: 'agent' | 'rag' }
  | { type: 'error'; error: string; status: number };
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources: AiSource[];
  meta: { provider?: string; model?: string; mode?: string; steps?: string[]; proposals?: string[] };
}

/** Effective permission of the current user (AD-020). */
export type AccessLevel = 'none' | 'read' | 'write' | 'admin';
export type AclTarget = 'mount' | 'folder' | 'note';
export interface AclRule {
  id: string;
  mountId: string;
  target: AclTarget;
  path: string;
  noteId: string | null;
  subject: 'all' | 'group' | 'user';
  subjectId: string | null;
  level: AccessLevel;
  createdAt: string;
  orphan?: boolean;
  /** A folder rule whose folder is gone (renamed outside): still in force for a folder of that name. */
  folderMissing?: boolean;
}
export interface Group {
  id: string;
  name: string;
  members: string[];
}
export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** An admin made (or renewed) it for this person – null when the person did (owner 28.10.); name null = account gone. */
  createdBy: { id: string; name: string | null } | null;
}
/** A token in the admins' list of everyone's tokens. */
export interface AdminTokenInfo extends TokenInfo {
  user: { id: string; username: string; displayName: string; isAdmin: boolean };
}

export interface MountOptions {
  writeMetadata: boolean;
  readonly: boolean;
  autoCommit: boolean;
  folderNote: string;
  commitIdleSec: number;
  /** AI memory in `.kaveyl-wiki/ai/` (AD-026); absent = on. */
  aiMemory?: boolean;
  /** Days unused AI chats about this source are kept (0 = keep); absent/-1 = general rule (AD-034). */
  aiChatDays?: number;
}

/** Push webhook of a connection at its hoster (AD-033). */
export interface WebhookStep {
  scope: 'account' | 'repo';
  name: string;
  action: 'create' | 'move' | 'remove';
  from?: string;
}

export interface WebhookStatus {
  url: string;
  repos: string[];
  lastReceived?: string | null;
  /** github.com/gitlab.com cannot call an address inside the own network. */
  unreachable?: boolean;
  supported?: boolean;
  /**
   * Kaveyl Wiki's hooks that exist at the hoster (owner 26.10.: only these are shown). `current` = calls `url` (else an
   * earlier address); `double` = a repository hook next to the account hook (every push twice); `foreign` = another Kaveyl
   * Wiki instance's hook (an address this one never used, code-004) – shown, never moved or removed.
   */
  hooks: { scope: 'account' | 'repo'; name: string; at: string; current: boolean; active: boolean; double?: boolean; foreign?: boolean }[];
  /** Added repositories no hook of ours reaches – they sync every 5 minutes. */
  uncovered: string[];
  /** Gitea with account hooks: the login – then setting up offers „whole account“ or „only the added repositories“. */
  account?: string;
  /** What each way of setting up would do, and what „Entfernen“ would delete. */
  plans: { repos: WebhookStep[]; account?: WebhookStep[]; remove: WebhookStep[] };
  /** After „Einrichten“/„Entfernen“: what changed (empty lists = nothing to do). */
  changes?: { created: string[]; moved: string[]; removed: string[] };
}

export interface Mount {
  id: string;
  name: string;
  type: 'remote' | 'local';
  source: string;
  branch: string | null;
  subpath: string;
  include: string[];
  exclude: string[];
  icon: string | null;
  position: number;
  options: MountOptions;
  hasCredential: boolean;
  /** Connection with the access data (AD-029); null = local folder or public repository. */
  connection: { id: string; kind: ConnectionKind; name: string } | null;
  /** The repository on a hoster (Gitea, GitHub, GitLab) — enables repo actions. */
  hostedRepo: { connectionId: string; kind: HostKind; fullName: string } | null;
  /** Effective level of the current user on the source root. */
  access?: AccessLevel;
  /** Remote repo or local folder with `.git`. */
  git?: boolean;
  /** Last push webhook that synced this source (AD-033); null = none yet (interval only). */
  webhookAt?: string | null;
  paused: boolean;
  syncStatus: string | null;
  syncDetail: string | null;
  syncedAt: string | null;
}

export interface Entry {
  mountId: string;
  path: string;
  parent: string;
  name: string;
  kind: 'file' | 'dir';
  noteId: string | null;
  title: string;
  icon: string | null;
  readonly: boolean;
  tags: string[];
  access?: AccessLevel;
}

export interface NoteDocument {
  mountId: string;
  path: string;
  raw: string;
  hash: string;
  /** null: too large or too nested for the server's parser (sec-006) – the app shows the Markdown source. */
  doc: PMNode | null;
  title: string;
  readonly: boolean;
  frontmatter: Record<string, unknown>;
  access?: AccessLevel;
}

export interface SearchHit {
  mountId: string;
  path: string;
  kind: 'file' | 'dir';
  title: string;
  icon: string | null;
  snippet?: string;
}

export interface FullHit {
  mountId: string;
  path: string;
  title: string;
  icon: string | null;
  tags: string[];
  mtime: number;
  snippet?: string;
}

export interface SearchResult {
  folders: SearchHit[];
  notes: SearchHit[];
  content: SearchHit[];
}

export interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  notes: number;
  children?: TreeNode[];
}

export interface GiteaRepo {
  fullName: string;
  description: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface MountStatus {
  id: string;
  name: string;
  type: 'remote' | 'local';
  /** Write on the source: may sync it (AD-020). */
  canSync: boolean;
  autoCommit: boolean;
  syncStatus: string | null;
  syncDetail: string | null;
  syncedAt: string | null;
  pending: number;
  /** Links an offered repair would fix after renames outside the app (local folders). */
  linkRepairs: number;
  commitIdleSec: number;
  git: { branch: string | null; upstream: string | null; ahead: number; behind: number; uncommitted: number } | null;
}

/** „Beobachten“ (AD-066): what one follows and how; '' path = the whole source. */
export interface WatchInput {
  mountId: string;
  path: string;
  isDir: boolean;
  badge: boolean;
  mail: boolean;
  pushover: boolean;
}
export interface Watch extends WatchInput {
  createdAt: string;
  unread: number;
}
export interface Unread {
  mountId: string;
  path: string;
  kind: 'created' | 'changed' | 'deleted' | 'moved';
  by: string | null;
  at: string;
}
export interface PersonalPushover {
  available: boolean;
  userKeySet: boolean;
}
/** Attachment rules (admins): size, image size, blocked file endings and the factory list. */
export interface AttachmentAdmin {
  maxMb: number;
  imageMaxPx: number;
  blocked: string[];
  blockedDefault: string[];
}
/** How often messages about followed changes come (AD-068). */
export type WatchRhythm = 'bundled' | 'hourly' | 'daily';
export interface WatchOverview {
  watches: Watch[];
  unread: Unread[];
  channels: { mail: boolean; pushover: PersonalPushover };
  rhythm: WatchRhythm;
  /** When the daily summary comes („HH:MM“, server time). */
  dailyAt: string;
  /** The admin's limit per person and day. */
  perDay: number;
}
export interface EventHook {
  id: string;
  name: string;
  url: string;
  userId: string;
  mountId: string | null;
  path: string;
  includeOwn: boolean;
  active: boolean;
  createdAt: string;
  lastAt: string | null;
  lastStatus: string | null;
  failures: number;
}
export type EventHookInput = Partial<Pick<EventHook, 'name' | 'url' | 'userId' | 'mountId' | 'path' | 'includeOwn' | 'active'>>;

export interface Version {
  commit: string;
  date: string;
  author: string;
  coAuthors?: string[];
  subject: string;
  path: string;
}

/** One entry of a source's trash (AD-025): a note, a folder, or notes deleted in one commit. */
export interface TrashItem {
  id: string;
  source: 'folder' | 'git';
  path: string;
  isDir: boolean;
  files: string[];
  date: string;
  author: string;
  subject: string | null;
}

export interface Trash {
  /** Where deleting puts notes: the git history (auto-commit) or `.kaveyl-wiki/trash/`. */
  mode: 'folder' | 'git';
  /** Retention in days, 0 = forever. */
  days: number;
  canEmpty: boolean;
  items: TrashItem[];
}

export interface ConflictFile {
  path: string;
  base: string | null;
  mine: string | null;
  theirs: string | null;
  merged: string | null;
}

export interface FsckIssue {
  kind: 'duplicate-id' | 'not-indexed' | 'orphaned-index' | 'broken-link' | 'orphaned-attachment' | 'plain-in-encrypted' | 'git-in-progress' | 'conflict-ref' | 'error';
  path: string;
  detail: string;
}

export interface FsckReport {
  checkedAt: string;
  mounts: { mountId: string; name: string; issues: FsckIssue[] }[];
}

export interface ActivityEntry {
  id: number;
  at: string;
  category: 'sync' | 'error' | 'audit' | 'system';
  level: 'info' | 'warn' | 'error';
  mountId: string | null;
  mountName: string | null;
  actor: string | null;
  action: string;
  message: string;
  detail: Record<string, unknown> | null;
}

export interface ActivityQuery {
  mountId?: string;
  /** Admins: only what this person did. */
  userId?: string;
  category?: ActivityEntry['category'];
  problems?: boolean;
  before?: number;
  limit?: number;
}

/** Löschregeln (AD-034): one number per rule; 0 = „nie“ where allowed. */
export type RuleKey =
  | 'logInfoDays'
  | 'logProblemDays'
  | 'logAuditDays'
  | 'trashDays'
  | 'aiChatDays'
  | 'repoTrashDays'
  | 'repoBundleDays'
  | 'backupDaily'
  | 'backupWeekly'
  | 'backupManualDays'
  | 'backupRunDays'
  | 'orphanCloneDays';
export type Rules = Record<RuleKey, number>;
interface SizeCount {
  count: number;
  size: number;
}
export interface CleanupOverview {
  rules: Rules;
  limits: Record<RuleKey, { setting: string; def: number; min: number; max: number; unit: 'days' | 'count' }>;
  usage: {
    log: { count: number; oldest: string | null };
    trash: { mountId: string; name: string; entries: number; size: number; mode: 'git' | 'folder'; aiChatDays: number }[];
    aiChats: { count: number; messages: number };
    repoTrash: { count: number };
    bundles: SizeCount;
    backups: { daily: SizeCount; weekly: SizeCount; manual: SizeCount };
    backupRuns: { count: number };
    clones: { used: number; orphans: { name: string; size: number; since: string }[]; size: number };
    db: { size: number; free: number };
    sessions: { count: number };
  };
}

export interface BackupFile {
  name: string;
  kind: 'daily' | 'weekly' | 'manual';
  size: number;
  createdAt: string;
}

export interface GiteaOwner {
  name: string;
  kind: 'user' | 'org';
  /** GitLab: namespace id of a group. */
  id?: number;
}

export type HostKind = 'gitea' | 'github' | 'gitlab';
export type ConnectionKind = HostKind | 'git';
export const CONNECTION_LABEL: Record<ConnectionKind, string> = { gitea: 'Gitea', github: 'GitHub', gitlab: 'GitLab', git: t('Git (allgemein)') };
export const isHostKind = (k: ConnectionKind): k is HostKind => k !== 'git';

/** Reusable access data for repositories (AD-029). The token itself never comes back. */
export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  baseUrl: string;
  username: string | null;
  hasToken: boolean;
  createdAt: string;
  /** Sources using it and repositories of it in the trash. */
  mounts: number;
  trash: number;
}

export interface ConnectionInput {
  kind?: ConnectionKind;
  name?: string;
  baseUrl?: string;
  username?: string | null;
  token?: string;
}

/** Access data for a wizard call: a connection, or a token typed in the wizard (not stored yet). */
export type SourceAccess = { connectionId?: string | null; credential?: { kind: 'token'; token: string; username?: string } | null };

export interface TrashedRepo {
  fullName: string;
  cloneUrl: string;
  archivedAt: string;
  deleteAfter: string;
  actor: string | null;
  connectionId: string | null;
  connectionName: string | null;
  kind: HostKind;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

// What fetch() rejects with when the server cannot be reached at all (Chromium, Firefox, Safari, Node).
const FETCH_FAILED = /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/;

/** Any caught error as text to show (code-005): the message alone – never "Error: …" – and a network failure in words. */
export function errorText(e: unknown): string {
  if (e instanceof TypeError && FETCH_FAILED.test(e.message)) return t('Keine Verbindung zum Server');
  if (e instanceof Error) return e.message;
  return String(e);
}


// ── Backup (AD-038) ───────────────────────────────────────────────────────────────────
export type BackupTargetKind = 'local' | 'smb';
export interface BackupTarget {
  id: string;
  kind: BackupTargetKind;
  name: string;
  location: string;
  username: string | null;
  domain: string | null;
  passwordSet: boolean;
  encrypted: boolean;
  createdAt: string;
  /** Names of the plans using it. */
  plans: string[];
}
export interface BackupTargetInput {
  kind: BackupTargetKind;
  name?: string;
  location: string;
  username?: string | null;
  domain?: string | null;
  password?: string;
  archivePassword?: string;
}
export interface BackupTestResult {
  ok: true;
  free: number | null;
  warnings: string[];
}
export interface BackupKeep {
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}
export interface BackupPlan {
  id: string;
  name: string;
  targetId: string;
  sources: string[];
  includeDb: boolean;
  keep: BackupKeep;
  time: string;
  enabled: boolean;
  createdAt: string;
  nextRun: string | null;
}
export type BackupPlanInput = Partial<Omit<BackupPlan, 'id' | 'createdAt' | 'nextRun'>> & { targetId: string };
export interface BackupRun {
  id: string;
  planId: string | null;
  planName: string;
  targetName: string;
  trigger: 'plan' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'partial' | 'error';
  message: string | null;
  archives: number;
  bytes: number;
}
export interface BackupArchive {
  id: string;
  planId: string | null;
  targetId: string;
  targetName: string;
  mountId: string | null;
  label: string;
  path: string;
  size: number;
  encrypted: boolean;
  createdAt: string;
}
export interface BackupEntry {
  path: string;
  size: number;
  modified: string;
}
export interface BackupRunning {
  runId: string;
  planName: string;
  step: string;
}
/** „Ziel durchsuchen“ (AD-075): archives newly listed, all found, folders without a source of that name. */
export interface BackupScan {
  added: number;
  found: number;
  unmatched: string[];
}
/** Database checked in the first-run setup (AD-075). */
export interface SetupRestoreResult {
  version: number;
  users: number;
  admins: number;
  key: boolean;
  /** The server ends and Docker starts it again; false: start it by hand. */
  restart: boolean;
}

/** Database backup up in the first-run setup (AD-075) – binary with the upload header; code and password URI-encoded. */
async function uploadSetupRestore(file: File, code: string | undefined, password: string): Promise<SetupRestoreResult> {
  const headers: Record<string, string> = { 'content-type': 'application/x-sqlite3', 'x-kaveyl-wiki-upload': '1', 'x-kaveyl-wiki-lang': lang };
  if (code) headers['x-setup-code'] = encodeURIComponent(code.trim());
  if (password) headers['x-backup-password'] = encodeURIComponent(password);
  const res = await fetch('/api/setup/restore', { method: 'POST', credentials: 'same-origin', headers, body: file });
  return (await readJson(res)) as SetupRestoreResult;
}

/** `asUser`: the account the request is for – the server refuses it under another account's session (code-012). */
async function request<T>(method: string, url: string, body?: unknown, asUser?: string): Promise<T> {
  // Every state-changing request is JSON (the server rejects anything else as CSRF guard).
  const hasBody = method !== 'GET';
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), 'x-kaveyl-wiki-lang': lang, ...(asUser ? { 'x-kaveyl-wiki-user': asUser } : {}) },
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
  return (await readJson(res)) as T;
}

/** Text for a failure without a message from Kaveyl Wiki (e.g. an error page of the proxy in front). */
function statusMessage(status: number): string {
  if (status === 413) return t('Zu groß für den Server');
  if (status === 502 || status === 503 || status === 504) return t('Server nicht erreichbar');
  return t('Unerwartete Antwort vom Server (HTTP {status})', { status });
}

/** The JSON body (null when empty); a failure or a body that is not JSON (HTML page) becomes an ApiError with the status. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  let data: unknown = null;
  let json = true;
  if (text)
    try {
      data = JSON.parse(text);
    } catch {
      json = false;
    }
  if (!res.ok) {
    const b = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    throw new ApiError(res.status, typeof b.error === 'string' ? b.error : statusMessage(res.status), b);
  }
  if (!json) throw new ApiError(res.status, statusMessage(res.status), {});
  return data;
}

const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export interface StoredAttachment {
  path: string;
  href: string;
  name: string;
  size: number;
  image: boolean;
}

export interface AttachmentInfo {
  path: string;
  name: string;
  size: number | null;
  kind: 'image' | 'pdf' | 'file';
}

export interface CustomIcon {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdBy: string | null;
  createdAt: string;
}

/** A new version of an existing attachment (edited drawing), same file in assets/. */
async function replaceAttachment(mountId: string, notePath: string, path: string, file: File): Promise<StoredAttachment> {
  return uploadBinary(`/api/attachments/${mountId}?${new URLSearchParams({ note: notePath, name: file.name || 'datei', replace: path })}`, file);
}

async function upload(mountId: string, notePath: string, file: File): Promise<StoredAttachment> {
  return uploadBinary(`/api/attachments/${mountId}?${new URLSearchParams({ note: notePath, name: file.name || 'datei' })}`, file);
}

/** What an import from another program would bring (docs/PLAN-IMPORT.md); the upload waits under `token` on the server. */
export interface ImportPreview {
  token: string;
  format: string;
  detected: string;
  formats: { id: string; label: string }[];
  /** Suggested name of the new folder. */
  name: string;
  notes: number;
  files: number;
  folders: number;
  warnings: { text: string; items: string[]; more: number }[];
  /** Pictures only on the old server: the dialog offers to fetch them. */
  remote: { count: number; servers: string[] };
}

/** Upload of an export (ZIP) with progress – fetch reports none for uploads. Binary, so with the upload header (CSRF guard). */
function uploadImport(mountId: string, parent: string, file: File, onProgress: (share: number) => void, signal: AbortSignal): Promise<ImportPreview> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/import/${mountId}/upload?${new URLSearchParams({ parent, name: file.name })}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/zip');
    xhr.setRequestHeader('x-kaveyl-wiki-upload', '1');
    xhr.setRequestHeader('x-kaveyl-wiki-lang', lang);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => readJson(new Response(xhr.responseText || null, { status: xhr.status })).then((v) => resolve(v as ImportPreview), reject);
    xhr.onerror = () => reject(new Error(t('Keine Verbindung zum Server')));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Binary upload (not JSON): the server accepts it only with the upload header (CSRF guard). */
async function uploadBinary<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream', 'x-kaveyl-wiki-upload': '1', 'x-kaveyl-wiki-lang': lang },
    body: file,
  });
  return (await readJson(res)) as T;
}

export const api = {
  icons: () => request<CustomIcon[]>('GET', '/api/icons'),
  groups: () => request<Group[]>('GET', '/api/admin/groups'),
  createGroup: (name: string) => request<Group>('POST', '/api/admin/groups', { name }),
  updateGroup: (id: string, patch: { name?: string; members?: string[] }) => request<Group>('PATCH', `/api/admin/groups/${id}`, patch),
  deleteGroup: (id: string) => request('DELETE', `/api/admin/groups/${id}`),
  cloudflare: () => request<{ enabled: boolean; teamDomain: string; aud: string }>('GET', '/api/admin/cloudflare'),
  saveCloudflare: (c: { enabled: boolean; teamDomain: string; aud: string }) => request<{ enabled: boolean; teamDomain: string; aud: string }>('PUT', '/api/admin/cloudflare', c),
  aclDefault: () => request<{ level: AccessLevel }>('GET', '/api/admin/acl-default'),
  setAclDefault: (level: AccessLevel) => request<{ level: AccessLevel }>('PUT', '/api/admin/acl-default', { level }),
  aclSubjects: () => request<{ users: { id: string; name: string; username: string; guest?: boolean }[]; groups: { id: string; name: string; size: number }[] }>('GET', '/api/acl-subjects'),
  acl: (mountId: string, target: AclTarget, path: string) =>
    request<{ rules: AclRule[]; inherited: AclRule[]; orphans: AclRule[]; mine: AccessLevel }>('GET', `/api/acl/${mountId}?${new URLSearchParams({ target, path })}`),
  addAclRule: (mountId: string, rule: { target: AclTarget; path: string; subject: AclRule['subject']; subjectId: string | null; level: AccessLevel }) =>
    request<AclRule>('POST', `/api/acl/${mountId}`, rule),
  deleteAclRule: (id: string) => request('DELETE', `/api/acl/rule/${id}`),
  rights: () => request<RightsOverview>('GET', '/api/admin/rights'),
  uploadIcon: (file: File) => uploadBinary<CustomIcon>(`/api/icons?${new URLSearchParams({ name: file.name || 'icon' })}`, file),
  deleteIcon: (id: string) => request('DELETE', `/api/icons/${encodeURIComponent(id)}`),
  session: () => request<{ user: User | null; setupRequired: boolean; setupCode?: boolean; restoring?: boolean; version?: string; mail: boolean }>('GET', '/api/session'),
  setupRestore: uploadSetupRestore,
  setup: (b: { email: string; password: string; displayName?: string; code?: string }) => request<{ user: User }>('POST', '/api/setup', b),
  login: (email: string, password: string, remember: boolean) => request<{ user: User }>('POST', '/api/login', { email, password, remember }),
  /** `redirect`: signed out through an auth proxy – the browser goes on to its logout (AD-049). */
  logout: () => request<{ ok: true; redirect?: string }>('POST', '/api/logout'),
  proxyAuth: (p: ProxyProvider) => request<ProxyAuthState>('GET', `/api/admin/proxy-auth/${p}`),
  saveProxyAuth: (p: ProxyProvider, c: Partial<ProxyAuthSettings>) => request<ProxyAuthState>('PUT', `/api/admin/proxy-auth/${p}`, c),
  createProxySecret: (p: ProxyProvider) => request<{ secret: string; state: ProxyAuthState }>('POST', `/api/admin/proxy-auth/${p}/secret`),
  removeProxySecret: (p: ProxyProvider) => request<ProxyAuthState>('DELETE', `/api/admin/proxy-auth/${p}/secret`),
  reverseProxy: () => request<ReverseProxyState>('GET', '/api/admin/reverse-proxy'),
  myProxies: () => request<AccountProxy[]>('GET', '/api/account/proxy'),
  linkProxy: (p: ProxyProvider) => request('POST', `/api/account/proxy/${p}`, {}),
  unlinkProxy: (p: ProxyProvider) => request('DELETE', `/api/account/proxy/${p}`, {}),
  unlinkUserProxy: (userId: string, p: ProxyProvider) => request('DELETE', `/api/admin/users/${userId}/proxy/${p}`, {}),
  changePassword: (current: string, next: string) => request<{ ok: true; user: User }>('POST', '/api/account/password', { current, next }),
  forgotPassword: (email: string) => request<{ ok: true; mail: boolean }>('POST', '/api/password/forgot', { email }),
  mailTokenInfo: (token: string) => request<MailTokenInfo>('POST', '/api/invite/info', { token }),
  resetPasswordByLink: (token: string, password: string) => request<{ user: User }>('POST', '/api/password/reset', { token, password }),
  acceptInvite: (token: string, password: string, displayName?: string) =>
    request<{ user: User; note?: { mountId: string; path: string }; folder?: { mountId: string; path: string } }>('POST', '/api/invite/accept', { token, password, displayName }),
  share: (input: { mountId: string; target: AclTarget; path: string; level: 'read' | 'write'; email: string; displayName?: string; more?: { target: 'note' | 'folder'; path: string }[] }) =>
    request<{ existing: boolean }>('POST', '/api/share', input),
  mailSettings: () => request<MailSettings>('GET', '/api/admin/mail'),
  saveMailSettings: (s: Partial<Omit<MailSettings, 'passwordSet' | 'configured'>> & { password?: string }) => request<MailSettings>('PUT', '/api/admin/mail', s),
  testMail: (to?: string) => request<{ ok: true; to: string }>('POST', '/api/admin/mail/test', { to }),
  notify: () => request<NotifyOverview>('GET', '/api/admin/notify'),
  saveNotify: (b: { rules?: Partial<Record<NotifyEvent, Partial<Record<NotifyChannel, boolean>>>>; pushover?: { token?: string; userKey?: string; device?: string }; followPerDay?: number }) =>
    request<NotifyOverview>('PUT', '/api/admin/notify', b),
  testNotify: (channel: NotifyChannel) => request<{ ok: true }>('POST', '/api/admin/notify/test', { channel }),
  updates: () => request<UpdateState>('GET', '/api/admin/updates'),
  saveUpdates: (enabled: boolean) => request<UpdateState>('PUT', '/api/admin/updates', { enabled }),
  checkUpdates: () => request<UpdateState>('POST', '/api/admin/updates/check', {}),

  mounts: () =>
    request<Mount[]>('GET', '/api/mounts').then((list) => {
      rememberFolderNotes(list);
      return list;
    }),
  status: () => request<MountStatus[]>('GET', '/api/status'),
  syncAll: () => request('POST', '/api/sync-all'),
  createMount: (b: Record<string, unknown>) => request<Mount>('POST', '/api/mounts', b),
  updateMount: (id: string, b: Record<string, unknown>) => request<Mount>('PATCH', `/api/mounts/${id}`, b),
  deleteMount: (id: string) => request('DELETE', `/api/mounts/${id}`),
  repairLinks: (mountId: string) => request<{ files: string[]; links: number }>('POST', `/api/mounts/${mountId}/repair-links`, {}),
  conflict: (mountId: string) => request<{ files: ConflictFile[] }>('GET', `/api/mounts/${mountId}/conflict`),
  resolveConflict: (mountId: string, resolutions: { path: string; content: string | null }[]) =>
    request<{ mount: Mount }>('POST', `/api/mounts/${mountId}/conflict/resolve`, { resolutions }),
  fsckReport: () => request<FsckReport | null>('GET', '/api/admin/fsck'),
  runFsck: () => request<FsckReport>('POST', '/api/admin/fsck', {}),
  /** Commit (+ push) pending edits now — "leaving the note". keepalive: survives page hide/close. */
  commitNow: (mountId: string, asUser?: string) =>
    fetch(`/api/mounts/${mountId}/commit-now`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json', ...(asUser ? { 'x-kaveyl-wiki-user': asUser } : {}) }, body: '{}' }).then(
      () => undefined,
      () => undefined,
    ),
  activity: (q: ActivityQuery) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== false) p.set(k, String(v));
    return request<ActivityEntry[]>('GET', `/api/activity?${p.toString()}`);
  },
  cleanup: () => request<CleanupOverview>('GET', '/api/admin/cleanup'),
  saveCleanup: (r: Partial<Rules>) => request<Rules>('PUT', '/api/admin/cleanup', r),
  runCleanup: () => request<{ done: Record<string, number>; failed: string[] }>('POST', '/api/admin/cleanup/run', {}),
  backups: () => request<BackupFile[]>('GET', '/api/admin/backups'),
  backupNow: () => request<BackupFile[]>('POST', '/api/admin/backups', {}),
  backupStatus: () => request<{ root: string | null; timeZone: string; running: BackupRunning | null }>('GET', '/api/backup/status'),
  backupTargets: () => request<BackupTarget[]>('GET', '/api/backup/targets'),
  testBackupTarget: (input: BackupTargetInput & { id?: string }) => request<BackupTestResult>('POST', '/api/backup/targets/test', input),
  addBackupTarget: (input: BackupTargetInput) => request<BackupTarget & { scan: BackupScan | { error: string } }>('POST', '/api/backup/targets', input),
  scanBackupTarget: (id: string) => request<BackupScan>('POST', `/api/backup/targets/${id}/scan`, {}),
  saveBackupTarget: (id: string, input: Partial<BackupTargetInput>) => request<BackupTarget>('PUT', `/api/backup/targets/${id}`, input),
  removeBackupTarget: (id: string, withPlans = false) => request<{ ok: true }>('DELETE', `/api/backup/targets/${id}${withPlans ? '?plans=1' : ''}`),
  backupPlans: () => request<BackupPlan[]>('GET', '/api/backup/plans'),
  addBackupPlan: (input: BackupPlanInput) => request<BackupPlan>('POST', '/api/backup/plans', input),
  saveBackupPlan: (id: string, input: Partial<BackupPlanInput>) => request<BackupPlan>('PUT', `/api/backup/plans/${id}`, input),
  removeBackupPlan: (id: string) => request<{ ok: true }>('DELETE', `/api/backup/plans/${id}`),
  runBackupPlan: (id: string) => request<{ ok: true }>('POST', `/api/backup/plans/${id}/run`, {}),
  backupSource: (mountId: string) => request<{ plans: string[] }>('POST', `/api/backup/sources/${mountId}/run`, {}),
  backupRuns: () => request<{ runs: BackupRun[]; running: BackupRunning | null }>('GET', '/api/backup/runs'),
  backupArchives: (filter: { mountId?: string; targetId?: string } = {}) =>
    request<BackupArchive[]>('GET', `/api/backup/files?${new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as [string, string][])}`),
  removeBackupArchive: (id: string) => request<{ ok: true }>('DELETE', `/api/backup/files/${id}`),
  unlockBackupArchive: (id: string, password: string | null) => request<{ updated: number }>('POST', `/api/backup/files/${id}/password`, password === null ? { none: true } : { password }),
  backupArchiveUrl: (id: string) => `/api/backup/files/${id}/download`,
  backupEntries: (id: string) => request<BackupEntry[]>('GET', `/api/backup/files/${id}/entries`),
  backupEntryText: (id: string, path: string) => request<{ text: string }>('GET', `/api/backup/files/${id}/entry?${new URLSearchParams({ path })}`),
  backupEntryUrl: (id: string, path: string) => `/api/backup/files/${id}/entry?${new URLSearchParams({ path, download: '1' })}`,
  /** `to` (copy): Speichern als — source and path of the copy (AD-039). */
  restoreBackup: (id: string, path: string, mode: 'overwrite' | 'copy', to?: { mountId: string; path: string }) =>
    request<{ paths: string[]; skipped: string[]; root: string; mountId: string; warnings: string[]; history?: boolean }>('POST', `/api/backup/files/${id}/restore`, { path, mode, to }),
  repoTrash: () => request<{ repos: TrashedRepo[]; bundles: { name: string; size: number; createdAt: string }[] }>('GET', '/api/repo-trash'),
  trashRepo: (connectionId: string | null, fullName: string) => request<{ entry: { deleteAfter: string }; unmounted: number }>('POST', '/api/repos/trash', { connectionId, fullName }),
  restoreRepo: (connectionId: string | null, fullName: string) => request<{ ok: boolean }>('POST', '/api/repos/restore', { connectionId, fullName }),
  deleteRepo: (connectionId: string | null, fullName: string, confirm: string) =>
    request<{ bundle: string; unmounted: number }>('POST', '/api/repos/delete', { connectionId, fullName, confirm }),
  syncMount: (id: string) => request<{ mount: Mount }>('POST', `/api/mounts/${id}/sync`),
  reorderMounts: (ids: string[]) => request<Mount[]>('POST', '/api/mounts/reorder', { ids }),

  webhookSettings: () =>
    request<{
      path: string;
      url: string;
      /** The admin's own webhook address ('' = the public address is used). */
      base: string;
      source: 'webhook' | 'public' | 'browser';
      secret: string;
      publicUrlSet: boolean;
      lan: boolean;
      recent: { at: string; level: string; action: string; message: string }[];
    }>('GET', '/api/settings/webhook'),
  saveWebhookAddress: (base: string) => request<{ url: string; base: string; source: 'webhook' | 'public' | 'browser'; lan: boolean }>('PUT', '/api/settings/webhook', { base }),
  connectionWebhook: (id: string) => request<WebhookStatus>('GET', `/api/connections/${id}/webhook`),
  installWebhook: (id: string, way: 'account' | 'repos') => request<WebhookStatus>('POST', `/api/connections/${id}/webhook`, { way }),
  /** Without `only`: every hook of Kaveyl Wiki of this connection; with it: just that one. */
  removeWebhook: (id: string, only?: { scope: 'account' | 'repo'; name: string }) =>
    request<WebhookStatus>('DELETE', `/api/connections/${id}/webhook${only ? `?${new URLSearchParams(only)}` : ''}`),
  connections: () => request<Connection[]>('GET', '/api/connections'),
  createConnection: (b: ConnectionInput) => request<Connection>('POST', '/api/connections', b),
  updateConnection: (id: string, b: ConnectionInput) => request<Connection>('PATCH', `/api/connections/${id}`, b),
  deleteConnection: (id: string) => request<{ ok: boolean }>('DELETE', `/api/connections/${id}`),
  checkConnection: (id: string) => request<{ ok: boolean; detail: string }>('POST', `/api/connections/${id}/check`),
  hostRepos: (connectionId: string, q: string) => request<GiteaRepo[]>('GET', `/api/connections/${connectionId}/repos?q=${encodeURIComponent(q)}`),
  hostOwners: (connectionId: string) => request<GiteaOwner[]>('GET', `/api/connections/${connectionId}/owners`),
  createHostRepo: (connectionId: string, b: { owner: GiteaOwner; name: string; description: string; private: boolean }) =>
    request<GiteaRepo>('POST', `/api/connections/${connectionId}/repos`, b),
  branches: (url: string, access: SourceAccess) => request<string[]>('POST', '/api/sources/branches', { url, ...access }),
  sourceTree: (b: { type: 'remote' | 'local'; source: string; branch?: string } & SourceAccess) => request<TreeNode>('POST', '/api/sources/tree', b),
  browseLocal: (path?: string) =>
    request<{ path: string | null; isRepo?: boolean; dirs: { name: string; path: string; isRepo: boolean; writable?: boolean }[]; hint?: string }>(
      'GET',
      `/api/sources/local${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),

  /** „Neuer Ordner …“ in the local folder browser; the new folder's path. */
  createLocalFolder: (parent: string, name: string) => request<{ path: string }>('POST', '/api/sources/local/folder', { parent, name }),
  /** A local folder gets its own Git for versions (AD-071); `restored`: history from a backup lying in it. */
  enableVersions: (mountId: string) => request<{ mount: Mount; restored: boolean }>('POST', `/api/mounts/${mountId}/versions`, {}),

  tree: (mountId: string) => request<Entry[]>('GET', `/api/tree/${mountId}`),
  /** Which of these hrefs in the note lead nowhere (same rule as the check). */
  linkCheck: (mountId: string, path: string, hrefs: string[]) => request<{ broken: string[] }>('POST', `/api/link-check/${mountId}/${enc(path)}`, { hrefs }),
  backlinks: (mountId: string, path: string) =>
    request<{ path: string; title: string; count: number }[]>('GET', `/api/backlinks/${mountId}/${enc(path)}`),
  note: (mountId: string, path: string) => request<NoteDocument>('GET', `/api/notes/${mountId}/${enc(path)}`),
  history: (mountId: string, path: string) => request<{ git: boolean; versions: Version[] }>('GET', `/api/history/${mountId}/${enc(path)}`),
  diff: (mountId: string, path: string, from: Version | null, to: Version | null) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from.commit), q.set('fromPath', from.path);
    if (to) q.set('to', to.commit), q.set('toPath', to.path);
    return request<{ diff: string }>('GET', `/api/diff/${mountId}/${enc(path)}?${q.toString()}`);
  },
  restoreVersion: (mountId: string, b: { path: string; commit: string; versionPath: string; baseHash: string }) =>
    request<{ hash: string }>('POST', `/api/history/${mountId}/restore`, b),
  /** Speichern als (AD-039): a version as a new note at `to` (`.md` added) in `toMountId`. */
  saveVersionAs: (mountId: string, b: { commit: string; versionPath: string; to: string; toMountId: string }) =>
    request<{ mountId: string; path: string; warnings: string[] }>('POST', `/api/history/${mountId}/save-as`, b),
  trash: (mountId: string) => request<Trash>('GET', `/api/trash/${mountId}`),
  /** `as`: under another name (a note: new path; a whole folder entry: new folder). */
  /** `as` + `toMountId`: Speichern als, also into another source (AD-039). */
  restoreFromTrash: (mountId: string, id: string, paths?: string[], as?: string, toMountId?: string) =>
    request<{ paths: string[]; warnings: string[]; mountId: string }>('POST', `/api/trash/${mountId}/restore`, { id, paths, as, toMountId }),
  purgeFromTrash: (mountId: string, id: string) => request<{ ok: true }>('POST', `/api/trash/${mountId}/purge`, { id }),
  emptyTrash: (mountId: string) => request<{ removed: number }>('POST', `/api/trash/${mountId}/empty`, {}),
  saveDoc: (mountId: string, path: string, doc: PMNode, baseHash: string, asUser?: string) =>
    request<{ hash: string; changed: boolean }>('PUT', `/api/notes/${mountId}/${enc(path)}`, { doc, baseHash }, asUser),
  saveRaw: (mountId: string, path: string, raw: string, baseHash: string, { asUser, ...opts }: { allowPlain?: boolean; asUser?: string } = {}) =>
    request<{ hash: string; changed: boolean }>('PUT', `/api/notes/${mountId}/${enc(path)}`, { raw, baseHash, ...opts }, asUser),
  encryptedFolders: (mountId: string) => request<string[]>('GET', `/api/encrypted/${mountId}`),
  setFolderEncrypted: (mountId: string, folder: string, encrypted: boolean) => request('PUT', `/api/encrypted/${mountId}`, { folder, encrypted }),
  /** The folder's notes as they are on disk (index may lag): encrypted or not, with or without content. */
  encryptedNotes: (mountId: string, folder: string) =>
    request<{ path: string; encrypted: boolean; empty: boolean }[]>('GET', `/api/encrypted/${mountId}/notes?${new URLSearchParams({ folder })}`),
  /** `unlessLinkedBy`: kept when a note other than that one still links to the file. */
  deleteAttachment: (mountId: string, path: string, unlessLinkedBy?: string) =>
    request<{ ok: true; kept?: boolean }>('DELETE', `/api/attachments/${mountId}/${enc(path)}${unlessLinkedBy === undefined ? '' : `?${new URLSearchParams({ unlessLinkedBy })}`}`),
  /** Speichern als (AD-039): the editor's text of a note gone outside meanwhile as a new note. */
  saveNoteAs: (mountId: string, b: { from: string; raw: string; to: string; toMountId?: string }) =>
    request<{ mountId: string; path: string; warnings: string[] }>('POST', `/api/notes/${mountId}/save-as`, b),
  createNote: (mountId: string, parent: string, title: string, kind: 'file' | 'dir', template?: string, body?: string) =>
    request<{ path: string }>('POST', `/api/notes/${mountId}`, { parent, title, kind, template, body }),
  templates: (mountId: string) => request<{ name: string; title: string }[]>('GET', `/api/templates/${mountId}`),
  saveTemplate: (mountId: string, from: string, title: string) => request<{ name: string; title: string }>('POST', `/api/templates/${mountId}`, { from, title }),
  moveNote: (mountId: string, from: string, to: string, toMountId?: string) =>
    request<{ mountId: string; path: string; warnings: string[] }>('POST', `/api/notes/${mountId}/move`, { from, to, toMountId }),
  copyNote: (mountId: string, from: string, toParent: string, toMountId?: string) =>
    request<{ mountId: string; path: string; warnings: string[] }>('POST', `/api/notes/${mountId}/copy`, { from, toParent, toMountId }),
  order: (mountId: string) => request<Record<string, string[]>>('GET', `/api/order/${mountId}`),
  saveOrder: (mountId: string, folder: string, order: string[]) => request('PUT', `/api/order/${mountId}`, { folder, order }),
  deleteNote: (mountId: string, path: string) => request('DELETE', `/api/notes/${mountId}/${enc(path)}`),
  /** A Markdown file from the computer into a folder (owner 28.10.); never over an existing note. */
  importNote: (mountId: string, parent: string, name: string, raw: string) => request<{ path: string }>('POST', `/api/notes/${mountId}/import`, { parent, name, raw }),
  importUpload: uploadImport,
  importPreview: (token: string, format: string) => request<ImportPreview>('POST', '/api/import/preview', { token, format }),
  importRun: (token: string, format: string, name: string, pictures: boolean) =>
    request<{ folder: string; report: string; notes: number; files: number; skipped: number }>('POST', '/api/import/run', { token, format, name, pictures }),
  importCancel: (token: string) => request<{ ok: true }>('DELETE', `/api/import/${token}`),
  /** Notes as .md attachments to any address (owner 28.10.). */
  mailNotes: (mountId: string, paths: string[], to: string[]) => request<{ sent: number; notes: number }>('POST', '/api/mail-notes', { mountId, paths, to }),
  // „Beobachten“ (AD-066)
  watches: () => request<WatchOverview>('GET', '/api/watches'),
  setWatch: (w: WatchInput) => request<WatchOverview>('PUT', '/api/watches', w),
  setWatchRhythm: (b: { rhythm?: WatchRhythm; dailyAt?: string }) => request<{ rhythm: WatchRhythm; dailyAt: string; perDay: number }>('PUT', '/api/account/watch-rhythm', b),
  markRead: (mountId: string, path: string) => request<{ ok: true }>('POST', '/api/watches/read', { mountId, path }),
  personalPushover: () => request<PersonalPushover>('GET', '/api/account/pushover'),
  savePersonalPushover: (userKey: string) => request<PersonalPushover>('PUT', '/api/account/pushover', { userKey }),
  testPersonalPushover: () => request<{ ok: true }>('POST', '/api/account/pushover/test', {}),
  // Event webhooks (AD-066, admins)
  eventHooks: () => request<EventHook[]>('GET', '/api/admin/event-hooks'),
  createEventHook: (h: EventHookInput) => request<{ hook: EventHook; secret: string }>('POST', '/api/admin/event-hooks', h),
  updateEventHook: (id: string, h: EventHookInput) => request<EventHook>('PATCH', `/api/admin/event-hooks/${id}`, h),
  deleteEventHook: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/event-hooks/${id}`),
  eventHookSecret: (id: string) => request<{ secret: string }>('POST', `/api/admin/event-hooks/${id}/secret`, {}),
  testEventHook: (id: string) => request<{ status: string }>('POST', `/api/admin/event-hooks/${id}/test`, {}),
  presence: (mountId: string, path: string, open: boolean, editing: boolean) =>
    request<{ id: string; name: string; editing: boolean }[]>('POST', '/api/presence', { mountId, path, open, editing }),
  users: () => request<User[]>('GET', '/api/admin/users'),
  createUser: (u: { email: string; username?: string; displayName?: string; password?: string; isAdmin?: boolean; isGuest?: boolean; invite?: boolean; mustChange?: boolean }) =>
    request<User | { invited: true }>('POST', '/api/admin/users', u),
  updateUser: (id: string, patch: { displayName?: string; email?: string; isAdmin?: boolean; isGuest?: boolean; disabled?: boolean }) => request<User>('PATCH', `/api/admin/users/${id}`, patch),
  resetPassword: (id: string, password: string, mustChange = true) => request('POST', `/api/admin/users/${id}/password`, { password, mustChange }),
  deleteUser: (id: string) => request('DELETE', `/api/admin/users/${id}`),
  tokens: () => request<TokenInfo[]>('GET', '/api/tokens'),
  createToken: (name: string, scopes: TokenScope[], expiresDays: number | null) => request<{ token: string; info: TokenInfo }>('POST', '/api/tokens', { name, scopes, expiresDays }),
  revokeToken: (id: string) => request('DELETE', `/api/tokens/${id}`),
  renewToken: (id: string) => request<{ token: string; info: TokenInfo }>('POST', `/api/tokens/${id}/renew`, {}),
  allTokens: () => request<AdminTokenInfo[]>('GET', '/api/admin/tokens'),
  createTokenFor: (userId: string, name: string, scopes: TokenScope[], expiresDays: number | null) =>
    request<{ token: string; info: TokenInfo }>('POST', '/api/admin/tokens', { userId, name, scopes, expiresDays }),
  renewTokenOf: (id: string) => request<{ token: string; info: TokenInfo }>('POST', `/api/admin/tokens/${id}/renew`, {}),
  deleteTokenOf: (id: string) => request('DELETE', `/api/admin/tokens/${id}`),
  recent: (limit = 15) => request<{ mountId: string; path: string; title: string; icon: string | null; mtime: number }[]>('GET', `/api/recent?limit=${limit}`),
  saveMeta: (mountId: string, path: string, changes: { tags?: string[]; icon?: string | null; readonly?: boolean }, baseHash: string) =>
    request<{ hash: string; changed: boolean }>('PUT', `/api/meta/${mountId}/${enc(path)}`, { ...changes, baseHash }),
  /** All tags with count and color (the one most of its notes have; `mixed`: sources differ). */
  tags: () => request<{ tag: string; count: number; color: TagColor | null; mixed: boolean }[]>('GET', '/api/tags'),
  /** mountId → tag (lower-case) → color (AD-040). */
  tagColors: () => request<Record<string, Record<string, TagColor>>>('GET', '/api/tag-colors'),
  setTagColor: (tag: string, color: TagColor | null) => request<{ saved: string[]; skipped: string[] }>('PUT', '/api/tags/color', { tag, color }),
  renameTag: (from: string, to: string) => request<{ notes: number; skipped: number; sources: string[] }>('POST', '/api/tags/rename', { from, to }),
  searchFull: (q: string) => request<{ hits: FullHit[] }>('GET', `/api/search/full?q=${encodeURIComponent(q)}`),
  search: (q: string, limit = 8) => request<SearchResult>('GET', `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  getState: <T>(key: string) => request<T | null>('GET', `/api/state/${key}`),
  putState: (key: string, value: unknown) => request('PUT', `/api/state/${key}`, value),

  fileUrl: (mountId: string, path: string) => `/api/files/${mountId}/${enc(path)}`,
  /** HTML of a note, or ZIP of a folder / the whole source (path ''). */
  exportUrl: (mountId: string, path: string, format: 'html' | 'md' = 'html') => `/api/export/${mountId}/${enc(path)}${format === 'md' ? '?format=md' : ''}`,
  /** Several marked notes and folders of one source as one ZIP (a POST: a long selection does not fit into a URL). */
  exportPick: async (mountId: string, paths: string[], format: 'html' | 'md' = 'html'): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`/api/export-pick/${mountId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-kaveyl-wiki-lang': lang },
      body: JSON.stringify({ paths, format }),
    });
    if (!res.ok) await readJson(res);
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
    return { blob: await res.blob(), name: name ? decodeURIComponent(name) : 'export.zip' };
  },
  downloadUrl: (mountId: string, path: string) => `/api/files/${mountId}/${enc(path)}?download=1`,
  upload,
  replaceAttachment,
  attachments: (mountId: string, path: string) => request<AttachmentInfo[]>('GET', `/api/attachments/${mountId}/${enc(path)}`),
  attachmentSettings: () => request<AttachmentAdmin>('GET', '/api/admin/attachments'),
  /** For every uploader: size limit and how far large images are scaled down (0 = not at all). */
  attachmentLimits: () => request<{ maxMb: number; imageMaxPx: number }>('GET', '/api/attachment-settings'),
  saveAttachmentSettings: (b: { maxMb?: number; imageMaxPx?: number; blocked?: string | string[] }) => request<AttachmentAdmin>('PUT', '/api/admin/attachments', b),
  // ── AI assistant (AD-024) ──
  aiProviders: () => request<{ providers: AiProvider[]; defaultId: string | null; retentionDays: number }>('GET', '/api/ai/providers'),
  saveAiProvider: (p: Partial<AiProvider> & { kind: AiProviderKind; apiKey?: string | null }) => request<AiProvider>('PUT', '/api/ai/providers', p),
  removeAiProvider: (id: string) => request('DELETE', `/api/ai/providers/${id}`, {}),
  aiModels: (id: string) => request<{ models: string[] }>('POST', `/api/ai/providers/${id}/models`, {}),
  aiSettings: (b: { defaultId?: string | null; retentionDays?: number }) => request('PUT', '/api/ai/settings', b),
  aiRule: (mountId: string, target: AclTarget, path: string) =>
    request<{
      rule: AiRule | null;
      effective: { level: AiLevel; cloud: boolean };
      /** What applies without this place's own rule, and the rule that decides it. */
      inherited: { level: AiLevel; cloud: boolean; from: { target: 'mount' | 'folder' | 'note'; path: string } | null };
    }>('GET', `/api/ai/rule/${mountId}?target=${target}&path=${encodeURIComponent(path)}`),
  setAiRule: (mountId: string, b: { target: AclTarget; path: string; level: AiLevel; cloud: boolean }) => request<AiRule>('PUT', `/api/ai/rule/${mountId}`, b),
  removeAiRule: (id: string) => request('DELETE', `/api/ai/rules/${id}`, {}),
  aiRules: () => request<AiRule[]>('GET', '/api/ai/rules'),
  aiStatus: (mountId: string, path: string) =>
    request<{ configured: boolean; provider: { id: string; name: string; cloud: boolean } | null; grant: { level: AiLevel; cloud: boolean }; read: boolean; suggest: boolean }>(
      'GET',
      `/api/ai/status/${mountId}/${enc(path)}`,
    ),
  aiTransform: (b: { action: AiAction; mountId: string; path: string; text?: string; instruction?: string; language?: string }) =>
    request<{ text: string; provider: string; model: string }>('POST', '/api/ai/transform', b),
  aiAsk: (b: { question: string; scope: AiScope; chatId?: string }) =>
    request<{ chatId: string; answer: string; sources: AiSource[]; provider: string; model: string }>('POST', '/api/ai/ask', b),
  /** The agent: events arrive while it works (NDJSON). Resolves after the last event. */
  aiAgent: async (b: { question: string; scope: AiScope; chatId?: string }, onEvent: (e: AiAgentEvent) => void) => {
    const res = await fetch('/api/ai/agent', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-kaveyl-wiki-lang': lang }, body: JSON.stringify(b) });
    if (!res.ok || !res.body) {
      await readJson(res); // throws for a failure or a body that is not JSON
      throw new ApiError(res.status, statusMessage(res.status), {});
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line) as AiAgentEvent);
      }
      if (done) break;
    }
    if (buf.trim()) onEvent(JSON.parse(buf) as AiAgentEvent);
  },
  aiProposalPreview: (id: string) => request<{ diff: string | null; content: string | null }>('GET', `/api/ai/proposals/${id}/preview`),
  applyAiProposal: (id: string) => request<AiProposal>('POST', `/api/ai/proposals/${id}/apply`, {}),
  rejectAiProposal: (id: string) => request<AiProposal>('POST', `/api/ai/proposals/${id}/reject`, {}),
  aiMemory: (mountId: string) => request<{ enabled: boolean; instructions: string | null; memory: string | null }>('GET', `/api/ai/memory/${mountId}`),
  saveAiMemory: (mountId: string, b: { instructions?: string; memory?: string }) =>
    request<{ enabled: boolean; instructions: string | null; memory: string | null }>('PUT', `/api/ai/memory/${mountId}`, b),
  aiChats: () => request<{ id: string; title: string; scope: AiScope; updatedAt: string }[]>('GET', '/api/ai/chats'),
  aiChat: (id: string) =>
    request<{ id: string; title: string; scope: AiScope; messages: AiChatMessage[]; proposals: AiProposal[] }>('GET', `/api/ai/chats/${id}`),
  /** One chat, or `all` (with `hours`: only those of the last hours). */
  deleteAiChat: (id: string, hours?: number) => request<{ ok: true; deleted: number }>('DELETE', `/api/ai/chats/${id}${hours ? `?hours=${hours}` : ''}`, {}),
};
