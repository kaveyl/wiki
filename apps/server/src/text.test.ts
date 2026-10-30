import { describe, expect, it } from 'vitest';
import { trimSlashes } from './text.js';

describe('trimSlashes', () => {
  it('takes slashes off the end, with start also off the beginning, and stays linear', () => {
    expect(trimSlashes('https://x.example/api//')).toBe('https://x.example/api');
    expect(trimSlashes('//a/b//', true)).toBe('a/b');
    expect(trimSlashes('///', true)).toBe('');
    expect(trimSlashes('')).toBe('');
    const t = performance.now();
    trimSlashes('a' + '/'.repeat(1_000_000) + 'x', true);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
