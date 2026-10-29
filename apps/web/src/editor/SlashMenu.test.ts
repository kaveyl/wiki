import { describe, expect, it } from 'vitest';
import { filterItems } from './SlashMenu';

const titles = (q: string) => filterItems(q).map((i) => i.title);

describe('slash commands', () => {
  it('match every word of the query: English keywords find the German heading (owner bug 25.10.)', () => {
    expect(titles('heading 2')).toEqual(['Überschrift 2']);
    expect(titles('Überschrift 2')).toEqual(['Überschrift 2']);
    expect(titles('h2')).toEqual(['Überschrift 2']);
    expect(titles('heading')).toEqual(['Überschrift 1', 'Überschrift 2', 'Überschrift 3']);
  });
  it('prose after a slash matches nothing, so the menu closes', () => {
    expect(titles('etc/hosts')).toEqual([]);
    expect(titles('heading und dann weiter')).toEqual([]);
  });
});
