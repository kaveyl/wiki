import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb, type DB } from '../db/db.js';
import { MountStore, absPath, PathError, type Mount } from '../mounts/model.js';
import { Indexer } from './indexer.js';
import { search } from './search.js';

let root: string;
let db: DB;
let mounts: MountStore;
let indexer: Indexer;
let mount: Mount;

function write(rel: string, content: string) {
  const abs = join(root, 'notes', rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-idx-'));
  write('home.md', '---\ntitle: "Startseite"\ntags: home, wiki\n---\n\n# Ignorierte H1\n\nWillkommen im Wiki.\n');
  write('projekte/trilium-notes.md', '# Trilium Notes\n\nHierarchische **Notizen** mit Klonen.\n');
  write('projekte/outline.md', 'Kein Heading, nur Text über Kollaboration.\n');
  write('projekte/bild.png', 'not markdown');
  write('.obsidian/workspace.md', '# versteckt\n');
  write('node_modules/pkg/README.md', '# versteckt\n');
  write('code/src/main.ts', 'console.log(1)');
  db = openDb(':memory:');
  mounts = new MountStore(db);
  indexer = new Indexer(db, join(root, 'data'));
  mount = mounts.create({ name: 'Notizen', type: 'local', source: join(root, 'notes') });
  await indexer.rebuild(mount);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Indexer', () => {
  it('indexes visible Markdown files and derives folders', () => {
    expect(indexer.all(mount.id).map((e) => `${e.kind}:${e.path}`)).toEqual([
      'file:home.md',
      'dir:projekte',
      'file:projekte/outline.md',
      'file:projekte/trilium-notes.md',
    ]);
  });

  it('takes titles from Wiki.js frontmatter, then H1, then the file name', () => {
    const titles = Object.fromEntries(indexer.all(mount.id).map((e) => [e.path, e.title]));
    expect(titles['home.md']).toBe('Startseite');
    expect(titles['projekte/trilium-notes.md']).toBe('Trilium Notes');
    expect(titles['projekte/outline.md']).toBe('outline');
    expect(indexer.get(mount.id, 'home.md')?.tags).toEqual(['home', 'wiki']);
  });

  it('lists children folders first', () => {
    write('projekte/sub/deep.md', '# Tief\n');
    return indexer.update(mount, ['projekte/sub/deep.md']).then(() => {
      expect(indexer.children(mount.id, 'projekte').map((e) => e.name)).toEqual(['sub', 'outline.md', 'trilium-notes.md']);
    });
  });

  it('applies incremental updates for edits, renames and deletions', async () => {
    write('home.md', '# Neu\n');
    renameSync(join(root, 'notes/projekte'), join(root, 'notes/archiv'));
    const ids = (paths: string[]) => paths.map((p) => indexer.get(mount.id, p)?.noteId);
    const before = ids(['projekte/outline.md', 'projekte/trilium-notes.md']);
    const change = await indexer.update(mount, ['home.md', 'projekte', 'archiv']);
    expect(change.updated).toEqual(['home.md']);
    expect(change.removed).toEqual([]);
    expect(change.added).toEqual([]);
    expect(change.renamed.sort((a, b) => a.to.localeCompare(b.to))).toEqual([
      { from: 'projekte/outline.md', to: 'archiv/outline.md' },
      { from: 'projekte/trilium-notes.md', to: 'archiv/trilium-notes.md' },
    ]);
    expect(ids(['archiv/outline.md', 'archiv/trilium-notes.md'])).toEqual(before);
    expect(indexer.get(mount.id, 'projekte')).toBeNull();
    expect(indexer.get(mount.id, 'archiv')?.kind).toBe('dir');
  });

  it('a rebuild (restart) reports only files whose content changed meanwhile', async () => {
    // Followers, webhooks and agents hear these as changes from outside – a restart alone must not be one.
    expect(await indexer.rebuild(mount)).toEqual({ added: [], updated: [], removed: [], renamed: [] });
    write('projekte/outline.md', 'Kein Heading, nur Text über Kollaboration. Draußen ergänzt.\n');
    expect((await indexer.rebuild(mount)).updated).toEqual(['projekte/outline.md']);
  });

  it('keeps note identities across renames, rebuilds and split watcher batches', async () => {
    const id = indexer.get(mount.id, 'projekte/outline.md')!.noteId!;
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
    // Rebuild (e.g. after restart) keeps it.
    await indexer.rebuild(mount);
    expect(indexer.get(mount.id, 'projekte/outline.md')!.noteId).toBe(id);
    // Removal and re-appearance in two different update batches still count as a move.
    renameSync(join(root, 'notes/projekte/outline.md'), join(root, 'notes/outline-neu.md'));
    expect((await indexer.update(mount, ['projekte/outline.md'])).removed).toEqual(['projekte/outline.md']);
    const second = await indexer.update(mount, ['outline-neu.md']);
    expect(second.renamed).toEqual([{ from: 'projekte/outline.md', to: 'outline-neu.md' }]);
    expect(indexer.get(mount.id, 'outline-neu.md')!.noteId).toBe(id);
    expect(indexer.pathOf(mount.id, id)).toBe('outline-neu.md');
    // While the app was not running: rebuild matches by content.
    renameSync(join(root, 'notes/outline-neu.md'), join(root, 'notes/projekte/zurueck.md'));
    const re = await indexer.rebuild(mount);
    expect(re.renamed).toEqual([{ from: 'outline-neu.md', to: 'projekte/zurueck.md' }]);
    expect(indexer.pathOf(mount.id, id)).toBe('projekte/zurueck.md');
  });

  it('uses frontmatter ids (rename + edit), git hints, and gives copies a fresh id', async () => {
    write('a.md', '---\nid: 01JFRONTMATTERID0000000000\n---\n# A\n');
    await indexer.update(mount, ['a.md']);
    expect(indexer.get(mount.id, 'a.md')!.noteId).toBe('01JFRONTMATTERID0000000000');
    // Moved and edited at once: the frontmatter id still identifies it.
    rmSync(join(root, 'notes/a.md'));
    write('b.md', '---\nid: 01JFRONTMATTERID0000000000\n---\n# A, bearbeitet\n');
    expect((await indexer.update(mount, ['a.md', 'b.md'])).renamed).toEqual([{ from: 'a.md', to: 'b.md' }]);
    // A copy keeps the original's frontmatter id in the file but gets its own identity.
    write('kopie.md', '---\nid: 01JFRONTMATTERID0000000000\n---\n# Kopie\n');
    expect((await indexer.update(mount, ['kopie.md'])).added).toEqual(['kopie.md']);
    expect(indexer.get(mount.id, 'kopie.md')!.noteId).not.toBe('01JFRONTMATTERID0000000000');
    expect(indexer.get(mount.id, 'b.md')!.noteId).toBe('01JFRONTMATTERID0000000000');
    // git -M: rename with edits and no frontmatter id.
    const id = indexer.get(mount.id, 'home.md')!.noteId;
    rmSync(join(root, 'notes/home.md'));
    write('start.md', '# Ganz anders\n');
    const hinted = await indexer.update(mount, ['home.md', 'start.md'], new Map([['start.md', 'home.md']]));
    expect(hinted.renamed).toEqual([{ from: 'home.md', to: 'start.md' }]);
    expect(indexer.get(mount.id, 'start.md')!.noteId).toBe(id);
  });

  it('indexes links and answers backlinks in every link style', async () => {
    write('projekte/index.md', '# Projekte\n');
    write('a.md', '[rel](projekte/outline.md#x) ![bild](projekte/bild.png) [web](https://x.test)\n');
    write('b.md', '[wikijs](/projekte/outline) und [nochmal](projekte/outline.md)\n');
    write('c.md', '[ordner](projekte/) [ordner2](/projekte)\n');
    await indexer.update(mount, ['a.md', 'b.md', 'c.md', 'projekte/index.md']);
    expect(indexer.backlinks(mount, 'projekte/outline.md')).toEqual([
      { path: 'a.md', title: 'a', count: 1 },
      { path: 'b.md', title: 'b', count: 2 },
    ]);
    expect(indexer.backlinks(mount, 'projekte/index.md').map((b) => b.path)).toEqual(['c.md']);
    expect(indexer.linkSources(mount.id, ['projekte']).sort()).toEqual(['a.md', 'b.md', 'c.md']);
    // Editing the source updates its links.
    write('b.md', 'keine Links mehr\n');
    await indexer.update(mount, ['b.md']);
    expect(indexer.backlinks(mount, 'projekte/outline.md').map((b) => b.path)).toEqual(['a.md']);
  });

  it('respects include/exclude filters', async () => {
    const only = mounts.update(mount.id, { include: ['projekte/**'], exclude: ['**/outline.md'] });
    await indexer.rebuild(only);
    expect(indexer.all(mount.id).map((e) => e.path)).toEqual(['projekte', 'projekte/trilium-notes.md']);
  });

  it('applies the subpath as mount root', async () => {
    const sub = mounts.update(mount.id, { subpath: 'projekte' });
    await indexer.rebuild(sub);
    expect(indexer.all(mount.id).map((e) => e.path)).toEqual(['outline.md', 'trilium-notes.md']);
  });
});

describe('search', () => {
  it('finds titles by substring, folders by name and content with snippets', () => {
    const r = search(db, 'lium');
    expect(r.notes.map((h) => h.path)).toEqual(['projekte/trilium-notes.md']);
    expect(search(db, 'projek').folders.map((h) => h.path)).toEqual(['projekte']);
    const c = search(db, 'kollab');
    expect(c.content.map((h) => h.path)).toEqual(['projekte/outline.md']);
    expect(c.content[0]!.snippet).toContain('\u0001Kollaboration\u0002');
  });

  it('matches umlaut-insensitive word prefixes and combines tokens', () => {
    expect(search(db, 'uber kollab').content.map((h) => h.path)).toEqual(['projekte/outline.md']);
    expect(search(db, 'notizen klonen').content.map((h) => h.path)).toEqual(['projekte/trilium-notes.md']);
  });

  it('filters by mount', () => {
    expect(search(db, 'lium', { mountIds: [] }).notes).toEqual([]);
  });
});

describe('paths', () => {
  it('rejects traversal and VCS folders', () => {
    expect(() => absPath(mount, '/data', '../etc/passwd')).toThrow(PathError);
    expect(() => absPath(mount, '/data', 'a/.git/config')).toThrow(PathError);
    expect(absPath(mount, '/data', 'a//b/./c.md')).toBe(join(root, 'notes', 'a', 'b', 'c.md'));
  });
});
