import { describe, expect, it } from 'vitest';
import { fullPath, noteName, noteNameIn, rememberFolderNotes } from './names';

describe('noteName', () => {
  it('file name without .md, a folder note under its folder', () => {
    expect(noteName('a/Plan.md')).toBe('Plan');
    expect(noteName('a/index.md')).toBe('a');
    expect(noteName('index.md')).toBe('index');
  });

  it('noteNameIn uses the folder note of the source (checklist: two entries „sub“ in tabs and lists)', () => {
    rememberFolderNotes([
      { id: 'home', options: { folderNote: 'home.md' } },
      { id: 'std', options: { folderNote: 'index.md' } },
    ]);
    expect(noteNameIn('home', 'sub/home.md')).toBe('sub');
    expect(noteNameIn('home', 'sub/index.md')).toBe('index');
    expect(noteNameIn('std', 'sub/index.md')).toBe('sub');
    expect(noteNameIn('unbekannt', 'sub/index.md')).toBe('sub');
  });

  it('fullPath puts the source in front – what „Pfad kopieren“ copies (owner 25.10.)', () => {
    rememberFolderNotes([{ id: 'repo', name: 'Test-Repo (kaveyl-wiki-test)', options: { folderNote: 'index.md' } }]);
    expect(fullPath('repo', 'Unterhaltung.md')).toBe('Test-Repo (kaveyl-wiki-test)/Unterhaltung.md');
    expect(fullPath('repo', 'Besprechungen/2026-10-01 Lieferanten.md')).toBe('Test-Repo (kaveyl-wiki-test)/Besprechungen/2026-10-01 Lieferanten.md');
    expect(fullPath('repo', '')).toBe('Test-Repo (kaveyl-wiki-test)');
    expect(fullPath('unbekannt', 'a.md')).toBe('a.md');
  });
});
