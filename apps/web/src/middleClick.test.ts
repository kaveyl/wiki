import { describe, expect, it } from 'vitest';
import { strayMiddlePaste } from './middleClick';

describe('middle click (Linux primary selection)', () => {
  it('does not paste into the focused note when the click hits a tree row or tab; inside the note it still may', () => {
    const paragraph = {};
    const row = {};
    const note = { contains: (x: unknown) => x === paragraph || x === note };
    const editor = { closest: () => note };
    expect(strayMiddlePaste(row, editor)).toBe(true);
    expect(strayMiddlePaste(paragraph, editor)).toBe(false);
    // Nothing editable has the focus: nothing to protect.
    expect(strayMiddlePaste(row, { closest: () => null })).toBe(false);
    expect(strayMiddlePaste(row, null)).toBe(false);
  });
});
