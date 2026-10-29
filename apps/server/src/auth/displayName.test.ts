import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX, cleanDisplayName } from './auth.js';

describe('cleanDisplayName', () => {
  it('line breaks and control characters become one space, invisible format characters go (sec-004)', () => {
    expect(cleanDisplayName('Karl \n Kunde')).toBe('Karl Kunde');
    expect(cleanDisplayName('A\u0007B')).toBe('A B');
    expect(cleanDisplayName('Ma‮ry')).toBe('Mary');
    expect(cleanDisplayName('  Anna   Berg  ')).toBe('Anna   Berg');
    expect(cleanDisplayName('👩‍💻 Dev')).toBe('👩‍💻 Dev');
    expect(cleanDisplayName(undefined)).toBe('');
  });

  it('at most 100 characters, emoji not cut in half', () => {
    expect(cleanDisplayName('x'.repeat(5000))).toHaveLength(DISPLAY_NAME_MAX);
    expect(Array.from(cleanDisplayName('😀'.repeat(150)))).toHaveLength(DISPLAY_NAME_MAX);
  });

  it('stays fast on a huge name of spaces (CodeQL js/polynomial-redos, was quadratic)', () => {
    const t = performance.now();
    cleanDisplayName('a' + ' '.repeat(2_000_000) + 'a');
    expect(performance.now() - t).toBeLessThan(200);
  });
});
