import { describe, expect, it } from 'vitest';
import { diffLines, diffText, mergeBlocks } from './diff.js';

describe('diffLines', () => {
  it('cuts into equal and changed blocks', () => {
    const blocks = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\nneu\n');
    expect(blocks).toEqual([
      { kind: 'same', lines: ['a'] },
      { kind: 'change', left: ['b'], right: ['B'] },
      { kind: 'same', lines: ['c', 'd'] },
      { kind: 'change', left: [], right: ['neu'] },
      { kind: 'same', lines: [''] },
    ]);
  });

  it('merges block by block and gives back either side unchanged', () => {
    const left = '# Titel\n\nAlter Absatz.\n\nGleich.\n';
    const right = '# Titel\n\nNeuer Absatz.\n\nGleich.\n\nAnhang.\n';
    const blocks = diffLines(left, right);
    expect(mergeBlocks(blocks, () => true)).toBe(left);
    expect(mergeBlocks(blocks, () => false)).toBe(right);
    const first = blocks.findIndex((b) => b.kind === 'change');
    expect(mergeBlocks(blocks, (i) => i === first)).toBe('# Titel\n\nAlter Absatz.\n\nGleich.\n\nAnhang.\n');
  });

  it('handles equal and empty texts', () => {
    expect(diffLines('x\n', 'x\n').every((b) => b.kind === 'same')).toBe(true);
    expect(mergeBlocks(diffLines('', 'neu'), () => false)).toBe('neu');
  });
});

describe('diffText', () => {
  it('writes the changes as - (left) and + (right) lines with a few equal lines around them', () => {
    const left = ['# Titel', '', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'alt', 'h'].join('\n');
    const right = ['# Titel', '', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'neu', 'h'].join('\n');
    expect(diffText(diffLines(left, right))).toBe(['@@ … @@', ' e', ' f', ' g', '-alt', '+neu', ' h'].join('\n'));
    expect(diffText(diffLines('a\nb\n', 'a\nb\nc\n'), 1)).toBe(['@@ … @@', ' b', '+c', ' '].join('\n'));
  });

  it('is empty when both sides are equal', () => {
    expect(diffText(diffLines('x\ny\n', 'x\ny\n'))).toBe('');
  });
});
