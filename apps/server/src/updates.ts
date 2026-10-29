// Update hint (owner 2026-10-22, AD-062): once a day the server – never the browser – asks the public release list on
// GitHub for the newest release and compares it with its own version. Only admins see the result (top right and in the
// help); nothing is sent along but the request itself. Off with Einstellungen → Benachrichtigungen → Updates.

/** Public releases of Kaveyl Wiki (the releases for the owner's own installations stay on Gitea, AD-060). */
export const RELEASES_URL = 'https://api.github.com/repos/kaveyl/wiki/releases/latest';
const DAY_MS = 86_400_000;
/** First check after a start: a little later, the server has other things to do first. */
const FIRST_MS = 60_000;
const TIMEOUT_MS = 15_000;
/** Log lines for a failed check (German, translated on the way out). */
const PROBLEM: Record<string, string> = {
  unreachable: 'Update-Prüfung: GitHub nicht erreichbar',
  timeout: 'Update-Prüfung: GitHub antwortet nicht',
  invalid: 'Update-Prüfung: unerwartete Antwort von GitHub',
};

export interface Release {
  version: string;
  /** Release page on GitHub. */
  url: string;
  /** The release title says „Sicherheit“ or „Security“ (scripts/release.sh, docs/WARTUNG.md). */
  security: boolean;
  published: string | null;
}

export interface UpdateState {
  enabled: boolean;
  current: string;
  /** Newest published release, if one was found. */
  latest: Release | null;
  /** `latest` is newer than the running version. */
  newer: boolean;
  checkedAt: string | null;
  /** Why the last check got no usable answer: 'unreachable', 'timeout', 'invalid' or 'status:<code>'. */
  problem: string | null;
}

interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** „0.1.2+dev (77584d6)“, „v0.1.4“ → [0, 1, 2]; nothing for local builds („dev“). */
export function parseVersion(v: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export class UpdateCheck {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<UpdateState> | null = null;
  /** The daily check runs (not in most tests). */
  private started = false;

  constructor(
    private readonly settings: KV,
    private readonly current: string,
    private readonly record: (level: 'info' | 'warn', message: string) => void,
    private readonly url: string = RELEASES_URL,
  ) {}

  /** On unless an admin switched it off. */
  enabled(): boolean {
    return this.settings.get('update_check') !== 'off';
  }

  setEnabled(on: boolean) {
    this.settings.set('update_check', on ? 'on' : 'off');
    if (on && this.started) this.schedule(0);
    else clearTimeout(this.timer);
  }

  state(): UpdateState {
    const latest = this.read<Release>('update_latest');
    return {
      enabled: this.enabled(),
      current: this.current,
      latest,
      newer: !!latest && isNewer(latest.version, this.current),
      checkedAt: this.settings.get('update_checked'),
      problem: this.settings.get('update_problem') || null,
    };
  }

  /** Asks GitHub now (also „Jetzt prüfen“); concurrent calls share one request. */
  check(): Promise<UpdateState> {
    this.running ??= this.fetchLatest().finally(() => (this.running = null));
    return this.running;
  }

  start() {
    this.started = true;
    if (this.enabled()) this.schedule(FIRST_MS);
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check().finally(() => this.enabled() && this.schedule(DAY_MS)), ms);
    this.timer.unref?.();
  }

  private async fetchLatest(): Promise<UpdateState> {
    let problem = '';
    try {
      const res = await fetch(this.url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Kaveyl-Wiki-Update-Check' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) {
        // No public release yet: nothing to show, nothing wrong.
        this.settings.set('update_latest', '');
      } else if (!res.ok) {
        problem = `status:${res.status}`;
      } else {
        const r = (await res.json()) as { tag_name?: unknown; name?: unknown; html_url?: unknown; published_at?: unknown };
        const version = String(r.tag_name ?? '').replace(/^v/, '');
        const url = String(r.html_url ?? '');
        if (!parseVersion(version) || !/^https:\/\//.test(url)) problem = 'invalid';
        else {
          const release: Release = { version, url, security: /sicherheit|security/i.test(String(r.name ?? '')), published: typeof r.published_at === 'string' ? r.published_at : null };
          const before = this.read<Release>('update_latest');
          this.settings.set('update_latest', JSON.stringify(release));
          if (before?.version !== version && isNewer(version, this.current))
            this.record('info', `Neue Version ${version} von Kaveyl Wiki erschienen${release.security ? ' (Sicherheitsupdate)' : ''}`);
        }
      }
    } catch (e) {
      problem = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    }
    // A failed check is no fault of the installation (no internet on purpose, GitHub down): noted once, not every day.
    if (problem && problem !== this.settings.get('update_problem'))
      this.record('info', problem.startsWith('status:') ? `Update-Prüfung: GitHub antwortet mit ${problem.slice(7)}` : PROBLEM[problem]!);
    this.settings.set('update_problem', problem);
    this.settings.set('update_checked', new Date().toISOString());
    return this.state();
  }

  private read<T>(key: string): T | null {
    const raw = this.settings.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
