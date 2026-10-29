// Deleting repositories on Gitea, GitHub or GitLab from Kaveyl Wiki (admin only). Two ways:
// - "move to trash": the repository is archived on the host (read-only, reversible) and
//   deleted for good after the repository-trash days (Löschregel repoTrashDays; 0 = never)
//   by the nightly job — restorable until then;
// - "delete now": irreversible on the host, only after typing the full name.
// Before any final deletion a complete `git bundle` is written to /config/backups/repos
// (kept for the bundle days, Löschregel repoBundleDays), so a mistake can still be undone. SEE-DOC: DECISIONS.md AD-014, AD-029

import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db/db.js';
import { git } from '../git/git.js';
import { deleteRepo, gitAuthorization, hostCloneUrl, setArchived, type HostKind } from './hosts.js';
import { PathError } from './model.js';
import { DEFAULT_RULES } from '../cleanup.js';

export interface TrashedRepo {
  fullName: string;
  cloneUrl: string;
  archivedAt: string;
  deleteAfter: string;
  actor: string | null;
  /** Connection the repository lives on (AD-029); null for entries from before. */
  connectionId: string | null;
}

/** Host access for one action; `kind` defaults to Gitea (entries and callers from before AD-029). */
export interface GiteaAccess {
  base: string;
  token: string;
  kind?: HostKind;
  connectionId?: string | null;
}

const kindOf = (g: GiteaAccess): HostKind => g.kind ?? 'gitea';
const host = (g: GiteaAccess) => ({ kind: kindOf(g), base: g.base, token: g.token });

export class RepoTrash {
  constructor(
    private readonly db: DB,
    private readonly bundleDir: string,
    /** Where to clone from for the bundle (tests point this at a local repository). */
    private readonly cloneUrl: (g: GiteaAccess, fullName: string) => string = (g, n) => hostCloneUrl(kindOf(g), g.base, n),
    /** Löschregeln (cleanup.ts): days in the trash and days a bundle is kept; 0 = never. */
    private readonly days: () => { trash: number; bundles: number } = () => ({ trash: DEFAULT_RULES.repoTrashDays, bundles: DEFAULT_RULES.repoBundleDays }),
  ) {}

  /** The final deletion follows the current rule (also for entries made before a change). */
  private deleteAfter(archivedAt: string, stored = ''): string {
    const d = this.days().trash;
    const at = Date.parse(archivedAt);
    if (Number.isNaN(at)) return stored; // a broken row keeps what it had
    return d ? new Date(at + d * 86_400_000).toISOString() : '';
  }

  list(): TrashedRepo[] {
    const rows = this.db.prepare('SELECT * FROM repo_trash ORDER BY archived_at').all() as {
      full_name: string;
      clone_url: string;
      archived_at: string;
      delete_after: string;
      actor: string | null;
      connection_id: string | null;
    }[];
    return rows.map((r) => ({
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      archivedAt: r.archived_at,
      deleteAfter: this.deleteAfter(r.archived_at, r.delete_after),
      actor: r.actor,
      connectionId: r.connection_id,
    }));
  }

  /** Archives on the host and schedules the final deletion. */
  async trash(g: GiteaAccess, fullName: string, actor: string | null, now = new Date()): Promise<TrashedRepo> {
    const cloneUrl = hostCloneUrl(kindOf(g), g.base, fullName); // validates the name first
    // The trash is keyed by name: a namesake of another server must not overwrite its entry.
    const other = this.list().find((r) => r.fullName === fullName && r.cloneUrl !== cloneUrl);
    if (other) throw new PathError(`Im Repository-Papierkorb liegt schon „${fullName}“ von ${new URL(other.cloneUrl).origin} – erst wiederherstellen oder endgültig löschen`);
    await setArchived(host(g), fullName, true);
    const entry: TrashedRepo = {
      fullName,
      cloneUrl,
      archivedAt: now.toISOString(),
      deleteAfter: this.deleteAfter(now.toISOString()),
      actor,
      connectionId: g.connectionId ?? null,
    };
    this.db
      .prepare('INSERT OR REPLACE INTO repo_trash (full_name, clone_url, archived_at, delete_after, actor, connection_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.fullName, entry.cloneUrl, entry.archivedAt, entry.deleteAfter, entry.actor, entry.connectionId);
    return entry;
  }

  /** Un-archives and takes the repository out of the trash. */
  async restore(g: GiteaAccess, fullName: string): Promise<void> {
    await setArchived(host(g), fullName, false);
    this.db.prepare('DELETE FROM repo_trash WHERE full_name = ?').run(fullName);
  }

  /** Bundle backup, then irreversible deletion on Gitea. Returns the bundle file name. */
  async deleteNow(g: GiteaAccess, fullName: string, now = new Date()): Promise<string> {
    const bundle = await this.bundle(g, fullName, now);
    await deleteRepo(host(g), fullName);
    this.db.prepare('DELETE FROM repo_trash WHERE full_name = ?').run(fullName);
    return bundle;
  }

  /** Repositories whose time in the trash is over (deleted by the nightly job); none with „nie“. */
  due(now = new Date()): TrashedRepo[] {
    return this.list().filter((r) => r.deleteAfter && r.deleteAfter <= now.toISOString());
  }

  /** A complete copy of all branches and tags as a single file (`git clone <bundle>` restores it). */
  async bundle(g: GiteaAccess, fullName: string, now = new Date()): Promise<string> {
    await mkdir(this.bundleDir, { recursive: true, mode: 0o700 });
    const tmp = await mkdtemp(join(tmpdir(), 'kaveyl-wiki-bundle-'));
    try {
      const mirror = join(tmp, 'repo.git');
      await git(tmp, ['clone', '-q', '--mirror', '--', this.cloneUrl(g, fullName), mirror], { authorization: gitAuthorization(kindOf(g), g.token) });
      // Date and time in the name: a second deletion on the same day must not overwrite the first backup.
      const name = `${fullName.replaceAll('/', '__')}-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.bundle`;
      const file = join(this.bundleDir, name);
      // An empty repository has nothing to bundle; the (empty) mirror is all there is.
      const refs = (await git(mirror, ['for-each-ref', '--count=1'])).trim();
      if (refs) {
        await git(mirror, ['bundle', 'create', file, '--all']);
        await chmod(file, 0o600);
      }
      return refs ? name : '(leeres Repository – nichts zu sichern)';
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** Removes bundle backups older than the bundle days (none with 0 = never). */
  async pruneBundles(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    const days = this.days().bundles;
    if (!days) return removed;
    for (const n of await readdir(this.bundleDir).catch(() => [] as string[])) {
      if (!n.endsWith('.bundle')) continue;
      const st = await stat(join(this.bundleDir, n)).catch(() => null);
      if (st && now - st.mtimeMs > days * 86_400_000) {
        await rm(join(this.bundleDir, n), { force: true });
        removed.push(n);
      }
    }
    return removed;
  }

  bundles(): Promise<{ name: string; size: number; createdAt: string }[]> {
    return readdir(this.bundleDir)
      .catch(() => [] as string[])
      .then(async (names) =>
        (
          await Promise.all(
            names
              .filter((n) => n.endsWith('.bundle'))
              .map(async (name) => {
                const st = await stat(join(this.bundleDir, name)).catch(() => null);
                return st ? { name, size: st.size, createdAt: st.mtime.toISOString() } : null;
              }),
          )
        ).filter((x): x is { name: string; size: number; createdAt: string } => x !== null),
      );
  }
}
