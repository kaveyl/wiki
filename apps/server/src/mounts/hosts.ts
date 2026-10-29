// Git hosters behind a connection (AD-029): repository list, owners, new repository,
// archive/restore and delete — Gitea (/api/v1), GitHub (api.github.com or <host>/api/v3)
// and GitLab (/api/v4). Plus the Authorization header git itself needs for each kind.
// SEE-DOC: DECISIONS.md AD-029, AD-014

import { PathError } from './model.js';

export type HostKind = 'gitea' | 'github' | 'gitlab';
export type ConnectionKind = HostKind | 'git';

export const HOST_LABEL: Record<ConnectionKind, string> = { gitea: 'Gitea', github: 'GitHub', gitlab: 'GitLab', git: 'Git' };

export const isHostKind = (k: unknown): k is HostKind => k === 'gitea' || k === 'github' || k === 'gitlab';

export interface HostRepo {
  fullName: string;
  description: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

export interface HostOwner {
  name: string;
  kind: 'user' | 'org';
  /** GitLab: namespace id of a group (needed to create a project in it). */
  id?: number;
}

export interface NewHostRepo {
  owner: HostOwner;
  name: string;
  description?: string;
  private: boolean;
}

/** What an API call needs: the kind, the address (any URL of the host) and the token. */
export interface HostAccess {
  kind: HostKind;
  base: string;
  token: string;
}

export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Value of the Authorization header for git over HTTPS. GitHub and GitLab only take Basic
 * auth for git (any user name with a token: `x-access-token` / `oauth2` by convention).
 */
export function gitAuthorization(kind: ConnectionKind, token: string, username?: string | null): string {
  const basic = (user: string) => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
  if (kind === 'github') return basic(username || 'x-access-token');
  if (kind === 'gitlab') return basic(username || 'oauth2');
  if (kind === 'git' && username) return basic(username);
  return `token ${token}`;
}

/** Kind for a URL entered by hand: github.com / gitlab.com need their own git sign-in. */
export function kindForUrl(url: string): ConnectionKind {
  const host = new URL(url).host.toLowerCase();
  return host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : 'git';
}

/** Default address of a hoster (the user may enter their own instance). */
export const DEFAULT_BASE: Partial<Record<ConnectionKind, string>> = { github: 'https://github.com', gitlab: 'https://gitlab.com' };

function apiBase(a: HostAccess): string {
  const origin = new URL(a.base).origin;
  if (a.kind === 'gitea') return `${origin}/api/v1`;
  if (a.kind === 'gitlab') return `${origin}/api/v4`;
  return origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
}

function headers(a: HostAccess): Record<string, string> {
  if (a.kind === 'gitea') return { Authorization: `token ${a.token}` };
  if (a.kind === 'github') return { Authorization: `Bearer ${a.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return { Authorization: `Bearer ${a.token}` };
}

async function call(a: HostAccess, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<unknown> {
  const res = await fetch(`${apiBase(a)}${path}`, {
    method,
    headers: { Accept: 'application/json', ...headers(a), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return res.status === 204 || res.status === 202 ? null : res.json();
  const label = HOST_LABEL[a.kind];
  if (res.status === 401) throw new HostError(403, `${label} lehnt den Token ab (ungültig oder abgelaufen)`);
  if (res.status === 409) throw new HostError(409, 'Ein Repository mit diesem Namen existiert bereits');
  if (res.status === 422 || res.status === 400) throw new HostError(422, `${label} lehnt den Namen ab (ungültig, vergeben oder reserviert)`);
  if (res.status === 403) throw new HostError(403, `Der ${label}-Token hat dafür keine Berechtigung`);
  if (res.status === 404) throw new HostError(404, `Repository auf ${label} nicht gefunden`);
  throw new HostError(res.status, `${label} antwortet mit ${res.status}`);
}

// owner/repo — no part may start with '.', so '..' can never walk up in an API URL. GitLab
// allows nested groups (group/sub/repo).
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9_.-]*';
const FULL_NAME = new RegExp(`^${SEGMENT}/${SEGMENT}$`);
const GITLAB_NAME = new RegExp(`^${SEGMENT}(/${SEGMENT})+$`);

export function validFullName(kind: HostKind, fullName: string): boolean {
  return (kind === 'gitlab' ? GITLAB_NAME : FULL_NAME).test(fullName);
}

function assertFullName(kind: HostKind, fullName: string): string {
  if (!validFullName(kind, fullName)) throw new PathError('Ungültiger Repository-Name');
  return fullName;
}

/** `owner/repo` from a clone URL on this host (null if it points elsewhere). */
export function hostFullName(kind: HostKind, base: string, cloneUrl: string): string | null {
  try {
    const u = new URL(cloneUrl);
    if (u.origin !== new URL(base).origin) return null;
    const name = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return validFullName(kind, name) ? name : null;
  } catch {
    return null;
  }
}

/** HTTPS clone URL of a repository on this host. */
export function hostCloneUrl(kind: HostKind, base: string, fullName: string): string {
  return `${new URL(base).origin}/${assertFullName(kind, fullName)}.git`;
}

const repoPath = (a: HostAccess, fullName: string) => {
  assertFullName(a.kind, fullName);
  if (a.kind === 'gitlab') return `/projects/${encodeURIComponent(fullName)}`;
  const [owner, repo] = fullName.split('/');
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}`;
};

function toRepo(kind: HostKind, r: Record<string, unknown>): HostRepo {
  if (kind === 'gitlab') {
    return {
      fullName: String(r.path_with_namespace),
      description: String(r.description ?? ''),
      cloneUrl: String(r.http_url_to_repo),
      defaultBranch: String(r.default_branch ?? 'main'),
      private: r.visibility !== 'public',
      updatedAt: String(r.last_activity_at ?? ''),
    };
  }
  return {
    fullName: String(r.full_name),
    description: String(r.description ?? ''),
    cloneUrl: String(r.clone_url),
    defaultBranch: String(r.default_branch ?? 'main'),
    private: r.private === true,
    updatedAt: String(r.updated_at ?? r.pushed_at ?? ''),
  };
}

/** Repositories the token can reach, most recently updated first, filtered by `query`. */
export async function listRepos(a: HostAccess, query: string): Promise<HostRepo[]> {
  const q = encodeURIComponent(query);
  if (a.kind === 'gitea') {
    const body = (await call(a, `/repos/search?q=${q}&limit=50&sort=updated&order=desc`)) as { data?: Record<string, unknown>[] };
    return (body.data ?? []).map((r) => toRepo(a.kind, r));
  }
  if (a.kind === 'gitlab') {
    const body = (await call(a, `/projects?membership=true&order_by=last_activity_at&per_page=50&search=${q}`)) as Record<string, unknown>[];
    return body.map((r) => toRepo(a.kind, r));
  }
  // GitHub's repo search cannot be limited to "everything this token sees": filter here.
  const body = (await call(a, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member')) as Record<string, unknown>[];
  const needle = query.trim().toLowerCase();
  return body.map((r) => toRepo(a.kind, r)).filter((r) => !needle || r.fullName.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle));
}

/** The token's own account plus the organisations/groups it may create repositories in. */
export async function listOwners(a: HostAccess): Promise<HostOwner[]> {
  const user = (await call(a, '/user')) as Record<string, unknown>;
  if (a.kind === 'gitlab') {
    const groups = (await call(a, '/groups?min_access_level=30&per_page=100')) as Record<string, unknown>[];
    return [{ name: String(user.username), kind: 'user' as const }, ...groups.map((g) => ({ name: String(g.full_path), kind: 'org' as const, id: Number(g.id) }))];
  }
  const orgs = (await call(a, a.kind === 'gitea' ? '/user/orgs?limit=50' : '/user/orgs?per_page=100')) as Record<string, unknown>[];
  return [{ name: String(user.login), kind: 'user' as const }, ...orgs.map((o) => ({ name: String(o.username ?? o.login ?? o.name), kind: 'org' as const }))];
}

/** Who the token belongs to — to check a connection. */
export async function whoAmI(a: HostAccess): Promise<string> {
  const user = (await call(a, '/user')) as Record<string, unknown>;
  return String(user.login ?? user.username);
}

/** Creates a repository with an initial README, so it can be mounted right away. */
export async function createRepo(a: HostAccess, repo: NewHostRepo): Promise<HostRepo> {
  const name = repo.name.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.startsWith('.')) {
    throw new PathError('Repo-Name: nur Buchstaben, Ziffern, „-“, „_“ und „.“ (nicht am Anfang)');
  }
  const description = repo.description?.trim() ?? '';
  const org = repo.owner.kind === 'org';
  if (a.kind === 'gitlab') {
    if (org && !Number.isInteger(repo.owner.id)) throw new PathError('Gruppe ohne ID');
    const body = {
      name,
      path: name,
      description,
      visibility: repo.private ? 'private' : 'public',
      initialize_with_readme: true,
      default_branch: 'main',
      ...(org ? { namespace_id: repo.owner.id } : {}),
    };
    return toRepo(a.kind, (await call(a, '/projects', body)) as Record<string, unknown>);
  }
  const owner = encodeURIComponent(repo.owner.name);
  if (a.kind === 'github') {
    const body = { name, description, private: repo.private, auto_init: true };
    return toRepo(a.kind, (await call(a, org ? `/orgs/${owner}/repos` : '/user/repos', body)) as Record<string, unknown>);
  }
  const body = { name, description, private: repo.private, auto_init: true, default_branch: 'main', readme: 'Default' };
  return toRepo(a.kind, (await call(a, org ? `/orgs/${owner}/repos` : '/user/repos', body)) as Record<string, unknown>);
}

/** Archives (read-only, reversible) or un-archives a repository. */
export async function setArchived(a: HostAccess, fullName: string, archived: boolean): Promise<void> {
  if (a.kind === 'gitlab') await call(a, `${repoPath(a, fullName)}/${archived ? 'archive' : 'unarchive'}`, {});
  else await call(a, repoPath(a, fullName), { archived }, 'PATCH');
}

/** Deletes a repository — irreversible; callers make a bundle backup first. */
export async function deleteRepo(a: HostAccess, fullName: string): Promise<void> {
  await call(a, repoPath(a, fullName), undefined, 'DELETE');
}

// ── Push webhooks (AD-033) ─────────────────────────────────────────────────────────
// Two ways at Gitea (owner 25.10.): one hook on the account covers every repository the account owns (Benutzer-
// Einstellungen → Webhooks), or one hook per added repository – the admin chooses. GitHub and GitLab have no
// account-wide hook for personal accounts: always one per repository. A hook counts as this instance's own only when it
// calls the current address or one this instance used before (`known`, owner 26.10., code-004) – setting up moves it,
// „Entfernen“ deletes it. A hook at …/api/webhooks/git on any other address belongs to another Kaveyl Wiki instance (e.g.
// Dev next to Prod on one Gitea account): it is listed as `foreign` and never moved or deleted. The status lists the hooks
// that exist, not what they cover (owner 26.10.: show the real state).

/** One of Kaveyl Wiki's hooks as it is at the hoster (owner 26.10.: the row shows these, nothing derived). */
export interface HookPlace {
  /** `account` = the Gitea account hook (every repository the account owns); `repo` = one repository. */
  scope: 'account' | 'repo';
  /** Account login or repository full name. */
  name: string;
  /** The address it calls. */
  at: string;
  /** It calls the current address (otherwise an earlier one: „Einrichten“ moves it). */
  current: boolean;
  /** Switched off at the hoster. */
  active: boolean;
  /** A repository hook next to the account hook: every push arrives twice. */
  double?: boolean;
  /** Another Kaveyl Wiki instance's hook (same path, an address this one never used): shown, never touched. */
  foreign?: boolean;
}

/** One thing a click would do at the hoster. */
export interface HookStep {
  scope: 'account' | 'repo';
  name: string;
  action: 'create' | 'move' | 'remove';
  /** `move`: the address the hook points at now. */
  from?: string;
}

export interface HookStatus {
  /** Kaveyl Wiki's hooks that exist, account first – also those of another instance (`foreign`). */
  hooks: HookPlace[];
  /** Added repositories no hook of ours reaches (neither their own nor the account hook): they sync every 5 minutes. */
  uncovered: string[];
  /** Gitea with account hooks: the login whose account hook would cover the repositories it owns. */
  account?: string;
  /** What setting up would do per way (`account` only where an account hook is possible), and what „Entfernen“ deletes. */
  plans: { repos: HookStep[]; account?: HookStep[]; remove: HookStep[] };
}

type RawHook = { id?: number; url?: string; active?: boolean; config?: { url?: string } };
const hookUrl = (h: RawHook) => h.config?.url ?? h.url ?? '';
/** An address without a trailing slash, for comparing (null when it is no URL). */
const addressKey = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};
/** Any Kaveyl Wiki's hook – this instance's or another's. */
const isKaveyl = (h: RawHook) => {
  try {
    return new URL(hookUrl(h)).pathname.replace(/\/+$/, '') === '/api/webhooks/git';
  } catch {
    return false;
  }
};
/** This instance's own hook: it calls the current address or one this instance used before (`known`). */
const oursAt = (url: string, known: string[]) => {
  const own = new Set([url, ...known].map(addressKey).filter((k): k is string => !!k));
  return (h: RawHook) => {
    const k = addressKey(hookUrl(h));
    return !!k && own.has(k);
  };
};
/** The installed state of one place: ours at `url`, else ours at an earlier address. */
const placeState = (list: RawHook[], url: string, isOurs: (h: RawHook) => boolean) => {
  const installed = list.some((h) => hookUrl(h) === url);
  const other = installed ? undefined : list.find(isOurs);
  return { installed, ...(other ? { other: hookUrl(other) } : {}) };
};

async function hooksOf(a: HostAccess, path: string): Promise<RawHook[] | null> {
  try {
    return (await call(a, path)) as RawHook[];
  } catch (e) {
    if (e instanceof HostError && e.status === 404) return null;
    throw e;
  }
}

const repoHooksPath = (a: HostAccess, fullName: string) => `${repoPath(a, fullName)}/hooks`;
const hooksPathOf = (a: HostAccess, s: { scope: 'account' | 'repo'; name: string }) => (s.scope === 'account' ? '/user/hooks' : repoHooksPath(a, s.name));

/** The hooks as they are at the hoster: the Gitea account (null = none possible) and each repository. */
async function survey(a: HostAccess, repos: string[]) {
  let me = '';
  let account: RawHook[] | null = null;
  if (a.kind === 'gitea') {
    me = await whoAmI(a);
    // Older Gitea versions have no account hooks (404): then every repository gets its own.
    account = await hooksOf(a, '/user/hooks');
  }
  const own = await Promise.all(repos.map(async (name) => ({ name, hooks: (await hooksOf(a, repoHooksPath(a, name))) ?? [] })));
  return { me, account, repos: own };
}

/** State and plans from a survey – no calls, so what the question names is exactly what a click does. */
function statusOf(s: Awaited<ReturnType<typeof survey>>, url: string, known: string[]): HookStatus {
  const isOurs = oursAt(url, known);
  const isForeign = (h: RawHook) => isKaveyl(h) && !isOurs(h);
  const acc = s.account ? placeState(s.account, url, isOurs) : null;
  const accHook = s.account?.find((h) => hookUrl(h) === url) ?? s.account?.find(isOurs);
  const owned = (name: string) => !!s.account && name.split('/')[0]!.toLowerCase() === s.me.toLowerCase();
  const place = (scope: 'account' | 'repo', name: string, h: RawHook, double = false): HookPlace => ({
    scope,
    name,
    at: hookUrl(h),
    current: hookUrl(h) === url,
    active: h.active !== false,
    ...(double ? { double } : {}),
  });
  /** Another instance's hooks at a place: listed, in no plan, never „double“. */
  const foreign = (scope: 'account' | 'repo', name: string, list: RawHook[]): HookPlace[] =>
    list.filter(isForeign).map((h) => ({ ...place(scope, name, h), foreign: true }));
  const hooks: HookPlace[] = [...(accHook ? [place('account', s.me, accHook)] : []), ...foreign('account', s.me, s.account ?? [])];
  const uncovered: string[] = [];
  /** The step that gives a repository its own hook at `url` (none when it has one). */
  const ownHook = (name: string, st: { installed: boolean; other?: string }): HookStep[] =>
    st.installed ? [] : [st.other ? { scope: 'repo', name, action: 'move', from: st.other } : { scope: 'repo', name, action: 'create' }];
  const repos: HookStep[] = [];
  const account: HookStep[] = [];
  const remove: HookStep[] = [];
  if (acc && !acc.installed) account.push(acc.other ? { scope: 'account', name: s.me, action: 'move', from: acc.other } : { scope: 'account', name: s.me, action: 'create' });
  for (const r of s.repos) {
    const st = placeState(r.hooks, url, isOurs);
    const mine = r.hooks.find((h) => hookUrl(h) === url) ?? r.hooks.find(isOurs);
    const byAccount = owned(r.name) && !!accHook;
    if (mine) hooks.push(place('repo', r.name, mine, byAccount));
    else if (!byAccount) uncovered.push(r.name);
    hooks.push(...foreign('repo', r.name, r.hooks));
    repos.push(...ownHook(r.name, st));
    // With the account hook, own repositories need no hook of their own – one of ours there would double every push.
    if (owned(r.name)) {
      if (mine) account.push({ scope: 'repo', name: r.name, action: 'remove' });
    } else account.push(...ownHook(r.name, st));
    if (mine) remove.push({ scope: 'repo', name: r.name, action: 'remove' });
  }
  if (accHook) {
    repos.push({ scope: 'account', name: s.me, action: 'remove' });
    remove.unshift({ scope: 'account', name: s.me, action: 'remove' });
  }
  return { hooks, uncovered, ...(s.account ? { account: s.me } : {}), plans: { repos, ...(s.account ? { account } : {}), remove } };
}

/** Where our push hook is (and should be) for these repositories of the account; `known` = addresses this instance used before. */
export async function webhookStatus(a: HostAccess, url: string, repos: string[], known: string[] = []): Promise<HookStatus> {
  return statusOf(await survey(a, repos), url, known);
}

/** The hook as each hoster wants it (create and update take the same body). GitHub has no name for hooks. */
function hookBody(a: HostAccess, url: string, secret: string): unknown {
  if (a.kind === 'gitea') return { type: 'gitea', name: HOOK_NAME, active: true, events: ['push'], branch_filter: '*', config: { url, content_type: 'json', secret, http_method: 'post' } };
  if (a.kind === 'github') return { name: 'web', active: true, events: ['push'], config: { url, content_type: 'json', secret, insecure_ssl: '0' } };
  return { name: HOOK_NAME, url, token: secret, push_events: true, enable_ssl_verification: true };
}
/** How the hook is called at Gitea and GitLab (owner 25.10.: not „Unnamed Webhook“). */
export const HOOK_NAME = 'Kaveyl Wiki';

/** What a click on „Einrichten“/„Entfernen“ did, per place (account login or repository). */
export interface HookChanges {
  created: string[];
  moved: string[];
  removed: string[];
}

async function apply(a: HostAccess, url: string, secret: string, steps: HookStep[], known: string[]): Promise<HookChanges> {
  const changes: HookChanges = { created: [], moved: [], removed: [] };
  const isOurs = oursAt(url, known);
  for (const s of steps) {
    const path = hooksPathOf(a, s);
    if (s.action === 'create') {
      await call(a, path, hookBody(a, url, secret));
      changes.created.push(s.name);
      continue;
    }
    // Only this instance's hooks – another instance's at the same place stays as it is (code-004).
    const ours = ((await hooksOf(a, path)) ?? []).filter((h) => isOurs(h) && h.id !== undefined);
    if (s.action === 'move' && ours[0]) {
      await call(a, `${path}/${ours[0].id}`, hookBody(a, url, secret), a.kind === 'gitlab' ? 'PUT' : 'PATCH');
      changes.moved.push(s.name);
    } else if (s.action === 'remove' && ours.length) {
      for (const h of ours) await call(a, `${path}/${h.id}`, undefined, 'DELETE');
      changes.removed.push(s.name);
    }
  }
  return changes;
}

/**
 * Sets up the push hooks the chosen way (`account` only at Gitea with account hooks; otherwise one per repository):
 * missing hooks are created, ours at an earlier address (`known`) moved, ours that would double a push removed; another
 * instance's hooks stay. Returns the new status and what changed (nothing = it was all there).
 */
export async function installWebhooks(
  a: HostAccess,
  url: string,
  secret: string,
  repos: string[],
  way: 'account' | 'repos' = 'repos',
  known: string[] = [],
): Promise<HookStatus & { changes: HookChanges }> {
  const { plans } = statusOf(await survey(a, repos), url, known);
  const changes = await apply(a, url, secret, way === 'account' && plans.account ? plans.account : plans.repos, known);
  return { ...(await webhookStatus(a, url, repos, known)), changes };
}

/**
 * Deletes this instance's hooks (current or earlier address, `known`) on the account and the repositories – or only the one
 * at `only` (owner 26.10.: each hook has its own button); another instance's hooks are never deleted. Returns the new status.
 */
export async function removeWebhooks(
  a: HostAccess,
  url: string,
  repos: string[],
  only?: { scope: 'account' | 'repo'; name: string },
  known: string[] = [],
): Promise<HookStatus & { changes: HookChanges }> {
  const { plans } = statusOf(await survey(a, repos), url, known);
  const steps = only ? plans.remove.filter((x) => x.scope === only.scope && x.name.toLowerCase() === only.name.toLowerCase()) : plans.remove;
  const changes = await apply(a, url, '', steps, known);
  return { ...(await webhookStatus(a, url, repos, known)), changes };
}
