// Keyboard of a tab row (WAI-ARIA tabs pattern, design-007): arrows move to the neighbour (wrapping), Home/End to the ends.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tabKeyTarget } from './tabKeys';

describe('tab row keys', () => {
  it('ArrowRight / ArrowLeft move to the neighbour and wrap around', () => {
    expect(tabKeyTarget('ArrowRight', 0, 4)).toBe(1);
    expect(tabKeyTarget('ArrowRight', 3, 4)).toBe(0);
    expect(tabKeyTarget('ArrowLeft', 2, 4)).toBe(1);
    expect(tabKeyTarget('ArrowLeft', 0, 4)).toBe(3);
  });

  it('Home / End go to the first / last tab', () => {
    expect(tabKeyTarget('Home', 2, 4)).toBe(0);
    expect(tabKeyTarget('End', 1, 4)).toBe(3);
  });

  it('other keys, an empty row or no active tab change nothing (or start at the ends)', () => {
    expect(tabKeyTarget('Enter', 1, 4)).toBeNull();
    expect(tabKeyTarget('ArrowDown', 1, 4)).toBeNull();
    expect(tabKeyTarget('ArrowRight', 0, 0)).toBeNull();
    expect(tabKeyTarget('ArrowRight', -1, 3)).toBe(0);
    expect(tabKeyTarget('ArrowLeft', -1, 3)).toBe(2);
  });

  it('every tab row uses the shared hook (roving tabindex, tabpanel) instead of a bare role="tab"', () => {
    for (const file of ['shell/Settings.tsx', 'help/HelpDialog.tsx', 'shell/conflict.tsx', 'editor/IconPicker.tsx']) {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      expect(src, file).not.toMatch(/\srole="tab(list)?"/);
      expect(src, file).toMatch(/useTabs\(/);
      expect(src, file).toMatch(/\.panel/);
    }
  });
});
