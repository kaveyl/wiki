// Consistency check across index, disk and git (docs/PLAN.md §2.8 "Verifikation").
// Read-only: produces a report, changes nothing. Runs on demand (admin) and nightly.

import { lstat, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { linkCandidates, listedAttachments, noteMeta } from '@kaveyl-wiki/core';
import { git } from '../git/git.js';
import { contentRoot, fileFilter, repoDir, type Mount } from '../mounts/model.js';
import { walk, type Indexer } from './indexer.js';
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

export async function fsck(mounts: Mount[], indexer: Indexer, dataPath: string): Promise<FsckReport> {
  const report: FsckReport = { checkedAt: new Date().toISOString(), mounts: [] };
  // Frontmatter ids across all mounts: the same id in two places is a copy (or a moved
  // note that was copied instead of moved).
  const idOwners = new Map<string, { mount: string; path: string }[]>();
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
      const referenced = new Set(indexer.allLinks(mount.id).map((l) => l.target));
      for (const a of attachments) {
        if (a.endsWith('.age') && unlistedEncrypted) continue;
        if (!referenced.has(a)) add({ kind: 'orphaned-attachment', path: a, detail: 'Anhang wird von keiner Notiz mehr verlinkt' });
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
