import { describe, expect, it } from 'vitest';
import { merge3 } from './merge3.js';

const base = '# Plan\n\nErster Absatz.\n\nZweiter Absatz.\n\nDritter Absatz.\n';

describe('merge3', () => {
  it('brings changes in different paragraphs together', () => {
    const mine = base.replace('Erster Absatz.', 'Erster Absatz, von Maria.');
    const theirs = base.replace('Dritter Absatz.', 'Dritter Absatz, von Tom.');
    expect(merge3(base, mine, theirs)).toBe('# Plan\n\nErster Absatz, von Maria.\n\nZweiter Absatz.\n\nDritter Absatz, von Tom.\n');
  });

  it('refuses when both changed the same paragraph differently', () => {
    expect(merge3(base, base.replace('Zweiter', 'Maria:'), base.replace('Zweiter', 'Tom:'))).toBeNull();
  });

  it('the same change on both sides is taken once', () => {
    const both = base.replace('Zweiter', 'Gemeinsam');
    expect(merge3(base, both, both)).toBe(both);
    expect(merge3(base, both + '\nMehr.\n', both)).toBe(both + '\nMehr.\n');
  });

  it('both adding at the end keeps both (theirs first)', () => {
    expect(merge3(base, base + '\nVon Maria.\n', base + '\nVon Tom.\n')).toBe(base + '\nVon Tom.\n\nVon Maria.\n');
  });

  it('a new paragraph right below a paragraph the other one changed', () => {
    const mine = base.replace('Zweiter Absatz.\n', 'Zweiter Absatz.\n\nNeu von Maria.\n');
    const theirs = base.replace('Zweiter Absatz.', 'Zweiter Absatz (Tom).');
    expect(merge3(base, mine, theirs)).toBe('# Plan\n\nErster Absatz.\n\nZweiter Absatz (Tom).\n\nNeu von Maria.\n\nDritter Absatz.\n');
  });

  it('one side unchanged → the other side; deletion and edit elsewhere', () => {
    expect(merge3(base, base, base + 'x')).toBe(base + 'x');
    expect(merge3(base, base + 'x', base)).toBe(base + 'x');
    const mine = base.replace('Erster Absatz.\n\n', '');
    const theirs = base.replace('Dritter', 'Letzter');
    expect(merge3(base, mine, theirs)).toBe('# Plan\n\nZweiter Absatz.\n\nLetzter Absatz.\n');
  });

  it('deleting a paragraph the other one changed is a conflict', () => {
    expect(merge3(base, base.replace('Zweiter Absatz.\n\n', ''), base.replace('Zweiter', 'Geänderter'))).toBeNull();
  });
});
