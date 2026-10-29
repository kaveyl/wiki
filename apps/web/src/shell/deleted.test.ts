// After deleting: how many notes a folder holds (asked first) and the trash entry to bring it back (design-009).
import { describe, expect, it } from 'vitest';
import type { Entry, TrashItem } from '../api';
import { notesBelow, trashEntryFor } from './deleted';

const entry = (path: string, kind: 'file' | 'dir'): Entry => ({
  mountId: 'm',
  path,
  parent: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  name: path.slice(path.lastIndexOf('/') + 1),
  kind,
  noteId: null,
  title: '',
  icon: null,
  readonly: false,
  tags: [],
});
const item = (id: string, path: string, files: string[]): TrashItem => ({ id, source: 'folder', path, isDir: files.length > 1, files, date: '', author: '', subject: null });

describe('notesBelow', () => {
  const tree = [entry('plan', 'dir'), entry('plan/index.md', 'file'), entry('plan/a.md', 'file'), entry('plan/sub', 'dir'), entry('plan/sub/b.md', 'file'), entry('planung.md', 'file'), entry('x.md', 'file')];

  it('counts the notes at any depth, folder notes included, no folders and no look-alike names', () => {
    expect(notesBelow(tree, 'plan')).toBe(3);
    expect(notesBelow(tree, 'plan/sub')).toBe(1);
  });

  it('leaves the folder pages out when asked – a new folder holds only its own page (owner 27.10.)', () => {
    expect(notesBelow(tree, 'plan', 'index.md')).toBe(2);
    expect(notesBelow([entry('test', 'dir'), entry('test/index.md', 'file')], 'test', 'index.md')).toBe(0);
    expect(notesBelow([entry('test', 'dir'), entry('test/sub', 'dir'), entry('test/sub/HOME.md', 'file')], 'test', 'home.md')).toBe(0);
    // A note that only looks like one is counted.
    expect(notesBelow([entry('test/index.md.md', 'file')], 'test', 'index.md')).toBe(1);
  });

  it('zero for an empty folder, null while the tree is not loaded', () => {
    expect(notesBelow([entry('leer', 'dir')], 'leer')).toBe(0);
    expect(notesBelow(undefined, 'plan')).toBeNull();
  });
});

describe('trashEntryFor', () => {
  it('finds the newest entry holding the note, restoring only that note from a shared commit', () => {
    const items = [item('git:2', '', ['a.md', 'b.md']), item('git:1', 'a.md', ['a.md'])];
    expect(trashEntryFor(items, 'a.md', false)).toEqual({ id: 'git:2', paths: ['a.md'] });
  });

  it('a folder entry comes back whole', () => {
    expect(trashEntryFor([item('folder:1', 'plan', ['plan/a.md', 'plan/sub/b.md'])], 'plan', true)).toEqual({ id: 'folder:1' });
  });

  it('a folder never matches a note of a similar name; nothing found → null', () => {
    expect(trashEntryFor([item('folder:1', '', ['planung.md'])], 'plan', true)).toBeNull();
    expect(trashEntryFor([], 'a.md', false)).toBeNull();
  });
});
