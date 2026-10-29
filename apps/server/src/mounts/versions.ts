// Versions for local folders (AD-071): Kaveyl Wiki gives a folder below /docs its own Git – no remote, no push or
// pull, only the history (versions, trash from the history, who changed what). A backup of such a folder carries the
// history as a bundle; a folder unpacked from that backup gets it back when its versions are switched on.
// SEE-DOC: DECISIONS.md AD-071

import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { git, gitOk } from '../git/git.js';
import { commitPending, type Author } from '../git/sync.js';
import { PathError } from './model.js';

/** The history inside a backup ZIP of a local folder with versions – and in the folder after unpacking it. */
export const HISTORY_BUNDLE = '.kaveyl-wiki-history.bundle';

/** Set in the Git config of a folder whose versions Kaveyl Wiki keeps: changes from outside are committed there too. */
export const VERSIONS_MARK = 'kaveyl-wiki.versions';

/** Versions need a folder Kaveyl Wiki may write into (its Git lies inside) – a clear message instead of a half `git init`. */
export async function assertVersionsPossible(dir: string): Promise<void> {
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw new PathError('Kaveyl Wiki darf in diesem Ordner nicht schreiben – Versionen brauchen Schreibrecht (Besitzer/Rechte des Ordners)');
  }
}

const hasCommit = (dir: string) => gitOk(dir, ['rev-parse', '-q', '--verify', 'HEAD']);

/**
 * `git init` in `dir`, the history from a bundle lying in it (then removed), and a first commit of what is there.
 * `restored`: the history came from a backup.
 */
export async function initVersions(dir: string, author: Author): Promise<{ restored: boolean }> {
  const before = existsSync(join(dir, '.git'));
  try {
    return await init(dir, author);
  } catch (e) {
    // Half done (a file git cannot read, no space): take back the Git made here – a second try starts afresh.
    if (!before) await rm(join(dir, '.git'), { recursive: true, force: true });
    throw e;
  }
}

/**
 * Never committed: what the app does not commit from outside either (hidden files, NAS helpers) – otherwise the first
 * commit would take them and every later change would stay „not committed“. Kaveyl Wiki's own hidden files go in.
 */
const EXCLUDE = ['.*', '!.kaveyl-wiki.yml', '!/.kaveyl-wiki/', 'node_modules/', '@eaDir/', '#recycle/', '@Recycle/', 'Thumbs.db', 'desktop.ini', `/${HISTORY_BUNDLE}`];

async function init(dir: string, author: Author): Promise<{ restored: boolean }> {
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', VERSIONS_MARK, 'true']);
  // Notes need no executable bit; a NAS share or a ZIP sets it at will – that is no new version.
  await git(dir, ['config', 'core.fileMode', 'false']);
  // An unpacked backup lying in a folder that already has versions must not end up in its commits.
  await mkdir(join(dir, '.git', 'info'), { recursive: true });
  await appendFile(join(dir, '.git', 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`);
  const bundle = join(dir, HISTORY_BUNDLE);
  let restored = false;
  if (existsSync(bundle) && (await gitOk(dir, ['bundle', 'verify', '-q', bundle]))) {
    await git(dir, ['fetch', '-q', '--update-head-ok', bundle, '+refs/heads/*:refs/heads/*']);
    if (await hasCommit(dir)) {
      // Index = the backed-up state; the files stay as they are, so what changed since shows up in the next commit.
      await git(dir, ['reset', '-q']);
      restored = true;
    }
  }
  if (restored) await rm(bundle, { force: true });
  const message = restored ? 'docs: Versionen aus der Sicherung übernommen (Kaveyl Wiki)' : 'docs: Versionen eingeschaltet (Kaveyl Wiki)';
  const committed = await commitPending({ dir, branch: 'main' }, message, author);
  if (!committed && !(await hasCommit(dir))) {
    // An empty folder: one empty commit, so versions and the trash have a start.
    const id = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    await git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message], { env: id });
  }
  return { restored };
}

/**
 * Writes the whole history of the folder's Git into `out` – only for a folder whose versions Kaveyl Wiki keeps; a Git
 * of your own (a project in VS Code) stays out of the backup. False when there is none (or no commit yet).
 */
export async function historyBundle(dir: string, out: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git')) || !(await hasCommit(dir))) return false;
  if ((await git(dir, ['config', '--get', VERSIONS_MARK], { okCodes: [1] })).trim() !== 'true') return false;
  await git(dir, ['bundle', 'create', '-q', out, '--branches']);
  return true;
}
