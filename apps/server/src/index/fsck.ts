// Consistency check across index, disk and git (docs/PLAN.md §2.8 "Verifikation").
// Read-only: produces a report, changes nothing. Runs on demand (admin) and nightly.

import { lstat, readFile, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { linkCandidates, listedAttachments, noteMeta } from '@kaveyl-wiki/core';
import { git } from '../git/git.js';
import { contentRoot, fileFilter, repoDir, type Mount } from '../mounts/model.js';
import { MAX_INDEX_BYTES, walk, type Indexer } from './indexer.js';
import { isAttachmentPath } from '../notes/attachments.js';
import { isEncryptedNote } from '../notes/encryption.js';
import { inEncryptedFolder } from '../notes/order.js';

export type IssueKind =
  | 'duplicate-id'
  | 'not-indexed'
  | 'orphaned-index'
  | 'broken-link'
  | 'orphaned-attachment'
  | 'plain-in-encrypted'
  | 'git-in-progress'
  | 'conflict-ref'
  | 'error';

export interface FsckIssue {
  kind: IssueKind;
  path: string;
  detail: string;
}

export interface FsckMountReport {
  mountId: string;
  name: string;
  issues: FsckIssue[];
}

export interface FsckReport {
  checkedAt: string;
  mounts: FsckMountReport[];
}

const MAX_ISSUES_PER_KIND = 200;

/**
 * Files linked from notes of any source, as paths on disk: two sources can show the same folder (a source for a
 * whole repository and one for a folder of it, or two local folders inside each other) – an attachment one of them
 * links is in use, even if the source it lies in does not link it (diff check 0.2.15). `except` leaves out one note.
 */
export function linkedOnDisk(all: Mount[], indexer: Indexer, dataPath: string, except?: { mountId: string; path: string }): Set<string> {
  const out = new Set<string>();
  for (const m of all) {
    const root = contentRoot(m, dataPath);
    for (const l of indexer.allLinks(m.id)) if (!(except && m.id === except.mountId && l.src === except.path)) out.add(join(root, ...l.target.split('/')));
  }
  return out;
}

/**
 * A note over the index limit in this source or one showing the same folder (one inside the other): its links are not
 * in the index, so no attachment there may be called unused. Returns where it is, or null.
 */
export function largeNoteNear(all: Mount[], mount: Mount, indexer: Indexer, dataPath: string): string | null {
  const root = contentRoot(mount, dataPath);
  all = all.filter((m) => rootOk(m, dataPath));
  const overlaps = (r: string) => r === root || r.startsWith(root + sep) || root.startsWith(r + sep);
  // Its own notes first: the report names the note in this source where it can.
  for (const m of [mount, ...all.filter((x) => x.id !== mount.id)]) {
    if (!overlaps(contentRoot(m, dataPath))) continue;
    const big = indexer.all(m.id).find((e) => e.kind === 'file' && /\.md$/i.test(e.path) && e.size > MAX_INDEX_BYTES);
    if (big) return m.id === mount.id ? big.path : `${m.name} / ${big.path}`;
  }
  return null;
}

const rootOk = (m: Mount, dataPath: string) => {
  try {
    contentRoot(m, dataPath);
    return true;
  } catch {
    return false;
  }
};

export async function fsck(mounts: Mount[], indexer: Indexer, dataPath: string): Promise<FsckReport> {
  const report: FsckReport = { checkedAt: new Date().toISOString(), mounts: [] };
  // Frontmatter ids across all mounts: the same id in two places is a copy (or a moved
  // note that was copied instead of moved).
  const idOwners = new Map<string, { mount: string; path: string }[]>();
  // Links of every source, once: an attachment one of them links stays (see linkedOnDisk).
  // A source whose folder cannot be resolved (e.g. a symbolic link in its sub-path) is left out here and reports its
  // own error below – it never stops the whole check (sec-g04).
  const referenced = linkedOnDisk(mounts.filter((m) => rootOk(m, dataPath)), indexer, dataPath);
  for (const mount of mounts.filter((m) => !m.paused)) {
    const issues: FsckIssue[] = [];
    const add = (i: FsckIssue) => {
      if (issues.filter((x) => x.kind === i.kind).length < MAX_ISSUES_PER_KIND) issues.push(i);
    };
    try {
      const root = contentRoot(mount, dataPath);
      const visible = fileFilter(mount);
      const onDisk = new Set<string>();
      const attachments: string[] = [];
      await walk(root, '', (f) => {
        if (visible(f)) onDisk.add(f);
        else if (isAttachmentPath(f)) attachments.push(f);
      });
      const indexed = new Set(indexer.all(mount.id).filter((e) => e.kind === 'file').map((e) => e.path));
      for (const p of onDisk) if (!indexed.has(p)) add({ kind: 'not-indexed', path: p, detail: 'Datei existiert, fehlt aber im Index' });
      for (const p of indexed) if (!onDisk.has(p)) add({ kind: 'orphaned-index', path: p, detail: 'Im Index, aber nicht mehr auf der Platte' });

      /** Encrypted notes sealed before they listed their files: their `.age` attachments cannot be told from orphans. */
      let unlistedEncrypted = false;
      /**
       * A note too large for the index has no links there: any attachment could be one it shows, so this source reports
       * none as orphaned (and says why) – without keeping or searching those texts (diff check 0.2.15, sec-g01).
       */
      const large = largeNoteNear(mounts, mount, indexer, dataPath);
      for (const p of onDisk) {
        const raw = await readFile(join(root, ...p.split('/')), 'utf8').catch(() => null);
        const id = raw !== null ? noteMeta(raw, posix.basename(p)).id : null;
        if (id) idOwners.set(id, [...(idOwners.get(id) ?? []), { mount: mount.id, path: p }]);
        if (raw === null) continue;
        if (isEncryptedNote(raw)) {
          if (listedAttachments(raw) === null) unlistedEncrypted = true;
        } else if (await inEncryptedFolder(mount, dataPath, p)) {
          // Left over by an interrupted „Ordner verschlüsseln“ or copied in from outside: readable by everyone with
          // access to the files, and Kaveyl Wiki refuses to save it until it is encrypted.
          add({ kind: 'plain-in-encrypted', path: p, detail: 'Notiz liegt unverschlüsselt in einem verschlüsselten Ordner – öffnen und „Verschlüsseln“ wählen' });
        }
      }

      // Attachments no note links to any more (left behind after deleting a link or a note).
      if (large !== null && attachments.length)
        add({ kind: 'error', path: large, detail: 'Notiz ist größer als 2 MB und hat keine Links im Index – verwaiste Anhänge werden für diese Quelle nicht gemeldet' });
      for (const a of large === null ? attachments : []) {
        if (a.endsWith('.age') && unlistedEncrypted) continue;
        if (!referenced.has(join(root, ...a.split('/')))) add({ kind: 'orphaned-attachment', path: a, detail: 'Anhang wird von keiner Notiz mehr verlinkt' });
      }

      const exists = async (p: string) => !!(await lstat(join(root, ...p.split('/'))).catch(() => null))?.isFile();
      for (const l of indexer.allLinks(mount.id)) {
        let ok = false;
        for (const c of linkCandidates(l.target, l.kind, mount.options.folderNote)) if (onDisk.has(c) || (await exists(c))) ok = true;
        if (!ok) add({ kind: 'broken-link', path: l.src, detail: `${l.kind === 'image' ? 'Bild' : 'Link'} auf „${l.target}“ führt ins Leere` });
      }

      const dir = repoDir(mount, dataPath);
      const gitDir = (await stat(join(dir, '.git')).catch(() => null))?.isDirectory() ? join(dir, '.git') : null;
      if (gitDir) {
        for (const [marker, label] of [
          ['rebase-merge', 'Rebase'],
          ['rebase-apply', 'Rebase/am'],
          ['MERGE_HEAD', 'Merge'],
        ] as const) {
          if (await lstat(join(gitDir, marker)).catch(() => null)) add({ kind: 'git-in-progress', path: '', detail: `${label} hängt im Repository (${dir})` });
        }
        const refs = (await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/kaveyl-wiki/conflicts/']).catch(() => '')).split('\n').filter(Boolean);
        if (refs.length && mount.syncStatus !== 'conflict') {
          add({ kind: 'conflict-ref', path: '', detail: `${refs.length} Konflikt-Sicherung(en) ohne offenen Konflikt: ${refs.join(', ')}` });
        }
      }
    } catch (e) {
      add({ kind: 'error', path: '', detail: e instanceof Error ? e.message : String(e) });
    }
    report.mounts.push({ mountId: mount.id, name: mount.name, issues });
  }
  for (const [id, owners] of idOwners) {
    if (owners.length < 2) continue;
    for (const o of owners) {
      const entry = report.mounts.find((m) => m.mountId === o.mount);
      const others = owners.filter((x) => x !== o).map((x) => `${report.mounts.find((m) => m.mountId === x.mount)?.name ?? x.mount}: ${x.path}`);
      entry?.issues.push({ kind: 'duplicate-id', path: o.path, detail: `id ${id} auch in ${others.join(', ')}` });
    }
  }
  return report;
}
