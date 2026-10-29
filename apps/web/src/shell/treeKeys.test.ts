import { describe, expect, it } from 'vitest';
import { rowAfterRemoval, treeMove, type TreeRow } from './treeKeys';

// Source „A“ (open) with folder „plan“ (open: roadmap), folder „ideen“ (closed), note „x“; source „B“ (closed).
const rows: TreeRow[] = [
  { level: 1, expanded: true }, // 0 A
  { level: 2, expanded: true }, // 1 plan
  { level: 3 }, //                 2 plan/roadmap
  { level: 2, expanded: false }, // 3 ideen
  { level: 2 }, //                 4 x
  { level: 1, expanded: false }, // 5 B
];

describe('treeMove (WAI-ARIA tree view keys)', () => {
  it('moves up and down through the visible rows, stops at the ends', () => {
    expect(treeMove(rows, 2, 'ArrowDown')).toEqual({ focus: 3 });
    expect(treeMove(rows, 2, 'ArrowUp')).toEqual({ focus: 1 });
    expect(treeMove(rows, 5, 'ArrowDown')).toBeNull();
    expect(treeMove(rows, 0, 'ArrowUp')).toBeNull();
  });

  it('Home and End jump to the first and last row', () => {
    expect(treeMove(rows, 3, 'Home')).toEqual({ focus: 0 });
    expect(treeMove(rows, 1, 'End')).toEqual({ focus: 5 });
  });

  it('right opens a closed folder, then steps into it; nothing on a note', () => {
    expect(treeMove(rows, 3, 'ArrowRight')).toEqual({ expand: true });
    expect(treeMove(rows, 1, 'ArrowRight')).toEqual({ focus: 2 });
    expect(treeMove(rows, 4, 'ArrowRight')).toBeNull();
  });

  it('right on an open folder without visible children does nothing', () => {
    expect(treeMove([{ level: 2, expanded: true }, { level: 2 }], 0, 'ArrowRight')).toBeNull();
  });

  it('left closes an open folder, else goes to the parent; nothing at the top', () => {
    expect(treeMove(rows, 1, 'ArrowLeft')).toEqual({ expand: false });
    expect(treeMove(rows, 2, 'ArrowLeft')).toEqual({ focus: 1 });
    expect(treeMove(rows, 3, 'ArrowLeft')).toEqual({ focus: 0 });
    expect(treeMove(rows, 4, 'ArrowLeft')).toEqual({ focus: 0 });
    expect(treeMove(rows, 5, 'ArrowLeft')).toBeNull();
  });

  it('ignores other keys and an empty tree', () => {
    expect(treeMove(rows, 2, 'a')).toBeNull();
    expect(treeMove([], 0, 'ArrowDown')).toBeNull();
  });
});

describe('rowAfterRemoval (focus after deleting a row, design-009)', () => {
  it('takes the next row, skipping what was inside a deleted open folder', () => {
    expect(rowAfterRemoval(rows, 2)).toBe(3);
    expect(rowAfterRemoval(rows, 1)).toBe(3);
    expect(rowAfterRemoval(rows, 3)).toBe(4);
  });

  it('stays in the source: the last row takes the previous one, never the next source', () => {
    expect(rowAfterRemoval(rows, 4)).toBe(3);
    expect(rowAfterRemoval([{ level: 1, expanded: true }, { level: 2 }, { level: 1 }], 1)).toBe(0);
  });

  it('nothing for a source head or an unknown row', () => {
    expect(rowAfterRemoval(rows, 0)).toBeNull();
    expect(rowAfterRemoval(rows, -1)).toBeNull();
  });
});
