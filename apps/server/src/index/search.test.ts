import { describe, expect, it } from 'vitest';
import { parseQuery } from './search.js';

describe('parseQuery', () => {
  const now = Date.UTC(2026, 9, 5);
  it('splits operators, phrases, exclusions and words', () => {
    expect(parseQuery('tag:Projekt in:WikiJS path:/docs/ "exakte Phrase" -alt seit:7d 10:30 Wort', now)).toEqual({
      words: ['10:30', 'Wort'],
      phrases: ['exakte Phrase'],
      excludes: ['alt'],
      tags: ['projekt'],
      mounts: ['wikijs'],
      paths: ['docs/'],
      since: now - 7 * 86400e3,
    });
  });
  it('accepts German aliases and dates', () => {
    const q = parseQuery('pfad:a quelle:notizen geändert:2026-10-01 tag:#x', now);
    expect(q).toMatchObject({ paths: ['a'], mounts: ['notizen'], tags: ['x'], since: Date.parse('2026-10-01') });
  });
});
