import { describe, expect, it } from 'vitest';
import { rangeOf, synced, toggled, topmost, type MarkedItem } from './marked';

const row = (path: string): MarkedItem => ({ path, isDir: false, title: path });
const rows = ['a.md', 'b.md', 'c.md', 'd.md'].map(row);

describe('marking in the tree (owner 28.10.)', () => {
  it('Ctrl+click toggles; the open row joins when marking starts; another source starts over', () => {
    expect(toggled({ mountId: null, items: [] }, 'm1', row('b.md'), row('a.md')).map((i) => i.path)).toEqual(['a.md', 'b.md']);
    const two = [row('a.md'), row('b.md')];
    expect(toggled({ mountId: 'm1', items: two }, 'm1', row('c.md'), row('a.md')).map((i) => i.path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(toggled({ mountId: 'm1', items: two }, 'm1', row('a.md')).map((i) => i.path)).toEqual(['b.md']);
    expect(toggled({ mountId: 'm1', items: two }, 'm2', row('x.md'), null).map((i) => i.path)).toEqual(['x.md']);
    // Ctrl+click on the open row itself: marked once.
    expect(toggled({ mountId: null, items: [] }, 'm1', row('a.md'), row('a.md')).map((i) => i.path)).toEqual(['a.md']);
  });

  it('Shift+click marks the visible rows from the anchor, in either direction', () => {
    expect(rangeOf(rows, 'b.md', 'd.md').map((i) => i.path)).toEqual(['b.md', 'c.md', 'd.md']);
    expect(rangeOf(rows, 'd.md', 'b.md').map((i) => i.path)).toEqual(['b.md', 'c.md', 'd.md']);
    expect(rangeOf(rows, null, 'c.md').map((i) => i.path)).toEqual(['c.md']);
    expect(rangeOf(rows, 'weg.md', 'c.md').map((i) => i.path)).toEqual(['c.md']);
    expect(rangeOf(rows, 'a.md', 'weg.md')).toEqual([]);
  });

  it('a folder takes what is marked inside it along (audit 28.10. code-001)', () => {
    const items: MarkedItem[] = [row('plan/a.md'), { path: 'plan', isDir: true, title: 'plan' }, row('planung.md'), { path: 'plan/sub', isDir: true, title: 'sub' }];
    expect(topmost(items).map((i) => i.path)).toEqual(['plan', 'planung.md']);
  });

  it('after a change of the tree: gone paths drop out, access is current; a gone source clears (audit 28.10. code-002)', () => {
    const items: MarkedItem[] = [{ ...row('a.md'), access: 'write' }, row('b.md')];
    expect(synced(items, [{ path: 'a.md', access: 'read' }])).toEqual([{ ...row('a.md'), access: 'read' }]);
    expect(synced(items, null)).toEqual([]);
    const same = synced(items, [{ path: 'a.md', access: 'write' }, { path: 'b.md' }]);
    expect(same[0]).toBe(items[0]);
  });
});
