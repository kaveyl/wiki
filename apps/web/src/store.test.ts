import { beforeEach, describe, expect, it } from 'vitest';
import { usePersonal } from './personal';
import { useWorkspace } from './store';
import { noteName } from './names';

const ws = () => useWorkspace.getState();
const shown = () => {
  const { tabs, activeId, splitId } = ws();
  const path = (id: string | null) => tabs.find((t) => t.id === id)?.path ?? null;
  return [path(activeId), path(splitId)];
};

beforeEach(() => {
  ws().hydrate(null);
  usePersonal.setState({ recent: [] });
});

describe('openSplit', () => {
  it('puts the note right of the active one', () => {
    ws().openNote('m', 'a.md', 'A');
    ws().openSplit('m', 'b.md', 'B');
    expect(shown()).toEqual(['a.md', 'b.md']);
  });

  it('puts the note left of the active one', () => {
    ws().openNote('m', 'a.md', 'A');
    ws().openSplit('m', 'b.md', 'B', 'left');
    expect(shown()).toEqual(['b.md', 'a.md']);
  });

  it('works on the note that was just opened by a click (tab replaced): the previous note goes beside it', () => {
    ws().openNote('m', 'a.md', 'A');
    usePersonal.setState({ recent: [{ mountId: 'm', path: 'a.md', title: 'A' }] });
    ws().openNote('m', 'b.md', 'B'); // replaces A in the same tab
    usePersonal.setState({ recent: [{ mountId: 'm', path: 'b.md', title: 'B' }, ...usePersonal.getState().recent] });
    expect(ws().tabs).toHaveLength(1);
    ws().openSplit('m', 'b.md', 'B');
    expect(shown()).toEqual(['a.md', 'b.md']);
    ws().openSplit('m', 'b.md', 'B', 'left');
    expect(shown()).toEqual(['b.md', 'a.md']);
  });

  it('with nothing else to show, just opens the note', () => {
    ws().openSplit('m', 'a.md', 'A');
    expect(shown()).toEqual(['a.md', null]);
  });
});

describe('noteName', () => {
  it('is the file name without .md; a folder note shows its folder', () => {
    expect(noteName('docs/wikijs/CHANGELOG.md')).toBe('CHANGELOG');
    expect(noteName('Plan/index.md')).toBe('Plan');
    expect(noteName('Plan/README.md', 'README.md')).toBe('Plan');
    expect(noteName('index.md')).toBe('index');
    expect(noteName('docs/folder')).toBe('folder');
  });
});

describe('activate (tab click)', () => {
  it('the tree follows the tab: source and folders open, the note selected, a soft reveal (owner 24.11.)', () => {
    ws().openNote('m', 'Haus/Heizung/Wartung.md', 'Wartung');
    ws().openNote('m', 'Diverses/Einkauf.md', 'Einkauf', { newTab: true });
    const first = ws().tabs.find((t) => t.path === 'Haus/Heizung/Wartung.md')!;
    useWorkspace.setState({ expanded: {} });
    ws().activate(first.id);
    expect(Object.keys(ws().expanded).sort()).toEqual(['m:', 'm:Haus', 'm:Haus/Heizung'].sort());
    expect(ws().selected).toBe('m:Haus/Heizung/Wartung.md');
    expect(ws().reveal).toMatchObject({ key: 'm:Haus/Heizung/Wartung.md', soft: true });
  });
  it('„Im Baum anzeigen“ stays a hard reveal (switches the sidebar to the tree)', () => {
    ws().revealInTree('m', 'a.md');
    expect(ws().reveal?.soft).toBeUndefined();
  });
});
