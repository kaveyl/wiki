// Event webhooks (AD-066): Kaveyl Wiki tells an agent or another system right away what changed – a signed POST per
// batch of changes, instead of the agent asking all the time (/api/v1/changes). Set up by admins; each webhook runs with
// the rights of one person (only what they may read goes out; their own changes only on request – an agent does not
// hear its own writes). Delivery is retried a few times; a webhook that keeps failing is switched off and reported.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import type { DB } from './db/db.js';
import type { Change } from './changes.js';
import type { SecretStore } from './secrets.js';
import { PathError } from './mounts/model.js';
import { trimSlashes } from './text.js';

export interface EventHook {
  id: string;
  name: string;
  url: string;
  userId: string;
  /** Only this source (null = all the person may read) … */
  mountId: string | null;
  /** … and only this note or below this folder ('' = everything). */
  path: string;
  includeOwn: boolean;
  active: boolean;
  createdAt: string;
  lastAt: string | null;
  lastStatus: string | null;
  failures: number;
}

export interface HookInput {
  name?: string;
  url?: string;
  userId?: string;
  mountId?: string | null;
  path?: string;
  includeOwn?: boolean;
  active?: boolean;
}

export interface HookDeps {
  readable(userId: string, mountId: string, path: string, isDir: boolean): boolean;
  personActive(userId: string): boolean;
  mountName(mountId: string): string | null;
  /** Event log (no secrets). */
  record(level: 'info' | 'warn', action: string, message: string): void;
}

/** Changes close together go out as one request. */
const BUNDLE_MS = 1000;
/** Waits before the next try of a failed delivery. */
const RETRY_MS = [10_000, 60_000, 300_000];
/** Failed deliveries in a row (each after its retries) until the webhook is switched off. */
const MAX_FAILURES = 5;
const TIMEOUT_MS = 10_000;

const secretId = (id: string) => `event-hook:${id}`;
const isDirPath = (p: string) => !/\.md$/i.test(p);

export function payloadChange(c: Change, mountName: string | null) {
  return { sourceId: c.mountId, source: mountName, path: c.path, kind: c.kind, ...(c.from ? { from: c.from } : {}), at: c.at, by: c.by?.name ?? null, byId: c.by?.id ?? null, via: c.via };
}

/** The signature a receiver checks: HMAC-SHA256 of the raw body with the webhook's secret, hex. */
export function signature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export class EventHooks {
  private readonly queues = new Map<string, { changes: Change[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly db: DB,
    private readonly secrets: SecretStore,
    private readonly deps: HookDeps,
    private readonly opts: { bundleMs?: number; retryMs?: number[]; fetch?: typeof fetch } = {},
  ) {}

  list(): EventHook[] {
    const rows = this.db.prepare('SELECT * FROM event_hooks ORDER BY created_at').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      url: String(r.url),
      userId: String(r.user_id),
      mountId: (r.mount_id as string | null) ?? null,
      path: String(r.path),
      includeOwn: !!r.include_own,
      active: !!r.active,
      createdAt: String(r.created_at),
      lastAt: (r.last_at as string | null) ?? null,
      lastStatus: (r.last_status as string | null) ?? null,
      failures: Number(r.failures),
    }));
  }

  get(id: string): EventHook | null {
    return this.list().find((h) => h.id === id) ?? null;
  }

  /** New webhook; the secret is returned only here (and on a new secret), never again. */
  create(input: HookInput): { hook: EventHook; secret: string } {
    const v = this.validate(input, null);
    const id = ulid();
    const secret = randomBytes(24).toString('base64url');
    this.secrets.put(secret, secretId(id));
    this.db
      .prepare('INSERT INTO event_hooks (id, name, url, user_id, mount_id, path, include_own, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, v.name, v.url, v.userId, v.mountId, v.path, +v.includeOwn, new Date().toISOString());
    return { hook: this.get(id)!, secret };
  }

  update(id: string, input: HookInput): EventHook {
    const old = this.get(id);
    if (!old) throw new PathError('Webhook nicht gefunden');
    const v = this.validate(input, old);
    const active = input.active ?? old.active;
    this.db
      .prepare('UPDATE event_hooks SET name = ?, url = ?, user_id = ?, mount_id = ?, path = ?, include_own = ?, active = ?, failures = CASE WHEN ? THEN 0 ELSE failures END WHERE id = ?')
      .run(v.name, v.url, v.userId, v.mountId, v.path, +v.includeOwn, +active, active && !old.active ? 1 : 0, id);
    return this.get(id)!;
  }

  newSecret(id: string): string {
    if (!this.get(id)) throw new PathError('Webhook nicht gefunden');
    const secret = randomBytes(24).toString('base64url');
    this.secrets.put(secret, secretId(id));
    return secret;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM event_hooks WHERE id = ?').run(id);
    this.secrets.delete(secretId(id));
    const q = this.queues.get(id);
    if (q) clearTimeout(q.timer);
    this.queues.delete(id);
  }

  /**
   * A note or folder moved (in the app, also into another source) or a note renamed outside: a path filter of a webhook
   * for this source at or below it moves along (code-001). Filters for all sources stay – the path means every source.
   */
  moved(mountId: string, from: string, to: string, toMountId = mountId): void {
    if (!from) return;
    const update = this.db.prepare('UPDATE event_hooks SET mount_id = ?, path = ? WHERE id = ?');
    for (const h of this.list()) {
      if (h.mountId !== mountId || (h.path !== from && !h.path.startsWith(from + '/'))) continue;
      update.run(toMountId, to + h.path.slice(from.length), h.id);
    }
  }

  /** A source was removed: a webhook only for it would never deliver again – it is switched off and reported (code-001). */
  mountRemoved(mountId: string): void {
    for (const h of this.list()) {
      if (h.mountId !== mountId || !h.active) continue;
      this.db.prepare('UPDATE event_hooks SET active = 0 WHERE id = ?').run(h.id);
      this.deps.record('warn', 'event-hook-off', `Ereignis-Webhook „${h.name}“ abgeschaltet: Quelle ausgehängt`);
    }
  }

  /** A „ping“ right now, to check address and signature; the answer's status comes back. */
  async test(id: string): Promise<string> {
    const hook = this.get(id);
    if (!hook) throw new PathError('Webhook nicht gefunden');
    return this.post(hook, { event: 'ping', hook: hook.id, name: hook.name, changes: [] }, false);
  }

  onChanges(changes: Change[]): void {
    if (this.stopped) return;
    for (const hook of this.list()) {
      if (!hook.active) continue;
      const mine = changes.filter((c) => this.wants(hook, c));
      if (!mine.length) continue;
      const q = this.queues.get(hook.id);
      if (q) q.changes.push(...mine);
      else {
        const timer = setTimeout(() => this.flushOne(hook.id), this.opts.bundleMs ?? BUNDLE_MS);
        timer.unref?.();
        this.queues.set(hook.id, { changes: mine, timer });
      }
    }
  }

  /** Sends what is waiting now and waits for all deliveries (tests, shutdown). */
  async flush(): Promise<void> {
    for (const [id, q] of [...this.queues]) {
      clearTimeout(q.timer);
      this.flushOne(id);
    }
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  stop(): void {
    this.stopped = true;
    for (const q of this.queues.values()) clearTimeout(q.timer);
    this.queues.clear();
  }

  private wants(hook: EventHook, c: Change): boolean {
    if (hook.mountId && c.mountId !== hook.mountId) return false;
    const p = hook.path;
    const inside = (x: string) => !p || x === p || x.startsWith(p + '/');
    // The old path of a move counts only when the person may read it, too (sec-001).
    if (!inside(c.path) && !(c.from && inside(c.from) && this.deps.readable(hook.userId, c.mountId, c.from, isDirPath(c.from)))) return false;
    if (!hook.includeOwn && c.by?.id === hook.userId) return false;
    return this.deps.personActive(hook.userId) && this.deps.readable(hook.userId, c.mountId, c.path, isDirPath(c.path));
  }

  private flushOne(id: string) {
    const q = this.queues.get(id);
    this.queues.delete(id);
    const hook = this.get(id);
    if (!q || !hook || !hook.active) return;
    // Rights again at sending time; the old path of a move only when readable, too.
    const changes = q.changes
      .filter((c) => this.deps.readable(hook.userId, c.mountId, c.path, isDirPath(c.path)))
      .map((c) => {
        const out = payloadChange(c, this.deps.mountName(c.mountId));
        if (c.from && !this.deps.readable(hook.userId, c.mountId, c.from, isDirPath(c.from))) delete (out as { from?: string }).from;
        return out;
      });
    if (!changes.length) return;
    const run = this.post(hook, { event: 'changes', hook: hook.id, name: hook.name, changes }, true)
      .catch(() => undefined)
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  private async post(hook: EventHook, payload: object, retry: boolean): Promise<string> {
    const secret = this.secrets.get(secretId(hook.id)) ?? '';
    const body = JSON.stringify(payload);
    const delivery = randomUUID();
    const tries = retry ? [0, ...(this.opts.retryMs ?? RETRY_MS)] : [0];
    let status = '';
    for (const wait of tries) {
      if (wait) await new Promise((r) => setTimeout(r, wait).unref?.());
      if (this.stopped) return status;
      try {
        const res = await (this.opts.fetch ?? fetch)(hook.url, {
          method: 'POST',
          // Never follow a redirect: the address an admin entered is the only one that gets the data.
          redirect: 'manual',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Kaveyl-Wiki-Webhook',
            'x-kaveyl-event': (payload as { event: string }).event,
            'x-kaveyl-delivery': delivery,
            'x-kaveyl-signature': `sha256=${signature(secret, body)}`,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = `HTTP ${res.status}`;
        if (res.ok) {
          this.db.prepare('UPDATE event_hooks SET last_at = ?, last_status = ?, failures = 0 WHERE id = ?').run(new Date().toISOString(), status, hook.id);
          return status;
        }
      } catch (e) {
        status = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message).slice(0, 120) : String(e);
      }
    }
    const failures = (this.get(hook.id)?.failures ?? 0) + 1;
    const off = retry && failures >= MAX_FAILURES;
    this.db.prepare('UPDATE event_hooks SET last_at = ?, last_status = ?, failures = ?, active = CASE WHEN ? THEN 0 ELSE active END WHERE id = ?').run(new Date().toISOString(), status, failures, +off, hook.id);
    if (retry) {
      this.deps.record(
        'warn',
        off ? 'event-hook-off' : 'event-hook-failed',
        off ? `Ereignis-Webhook „${hook.name}“ abgeschaltet: ${failures}× nicht zugestellt (${status})` : `Ereignis-Webhook „${hook.name}“ nicht zugestellt (${status})`,
      );
    }
    return status;
  }

  private validate(input: HookInput, old: EventHook | null) {
    const name = (input.name ?? old?.name ?? '').trim();
    const url = (input.url ?? old?.url ?? '').trim();
    const userId = input.userId ?? old?.userId ?? '';
    const mountId = input.mountId !== undefined ? input.mountId || null : (old?.mountId ?? null);
    const path = trimSlashes(input.path ?? old?.path ?? '', true);
    if (!name) throw new PathError('Name fehlt');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new PathError('Adresse ungültig (http:// oder https://)');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PathError('Adresse ungültig (http:// oder https://)');
    if (u.username || u.password) throw new PathError('Zugangsdaten gehören nicht in die Adresse – der Empfänger prüft die Signatur');
    if (!this.deps.personActive(userId)) throw new PathError('Person nicht gefunden oder gesperrt');
    if (path.split('/').some((s) => s === '..')) throw new PathError('Ungültiger Pfad');
    return { name: name.slice(0, 100), url, userId, mountId, path, includeOwn: input.includeOwn ?? old?.includeOwn ?? false };
  }
}
