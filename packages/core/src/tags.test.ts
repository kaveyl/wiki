import { describe, expect, it } from 'vitest';
import { isTagColor, renameInTags, tagKey } from './tags.js';

describe('tags', () => {
  it('renames case-insensitively and merges into an existing tag', () => {
    expect(renameInTags(['Rechnung', 'büro'], 'rechnung', 'Belege')).toEqual(['Belege', 'büro']);
    expect(renameInTags(['a', 'B', 'c'], 'a', 'b')).toEqual(['b', 'c']);
    expect(renameInTags(['x'], 'y', 'z')).toEqual(['x']);
    expect(renameInTags(['Alt'], 'alt', 'alt')).toEqual(['alt']);
  });
  it('knows the palette and the storage key', () => {
    expect(isTagColor('red')).toBe(true);
    expect(isTagColor('#ff0000')).toBe(false);
    expect(tagKey(' #Rechnung ')).toBe('rechnung');
  });
});
