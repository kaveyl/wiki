import { describe, expect, it } from 'vitest';
import { firstHeading, noteMeta } from './meta.js';

describe('noteMeta', () => {
  it('title from frontmatter, else the first level-1 heading outside code, else the file name', () => {
    expect(noteMeta('---\ntitle: Aus dem Kopf\n---\n# Überschrift', 'datei.md').title).toBe('Aus dem Kopf');
    expect(noteMeta('```\n# im Code\n```\n## Zwei\n# **Eins** [mit Link](x.md) ##\n', 'datei.md').title).toBe('Eins mit Link');
    expect(noteMeta('Nur Text', 'datei.md').title).toBe('datei');
  });

  it('closing hashes go only after a space; an empty heading counts as none (CommonMark)', () => {
    expect(firstHeading('# C#')).toBe('C#');
    expect(firstHeading('# Titel ##')).toBe('Titel');
    expect(firstHeading('# #\n#  \n# Echt')).toBe('Echt');
    expect(firstHeading('    # eingerückt = Code')).toBeNull();
    expect(firstHeading('# a\rb')).toBe('a'); // a lone CR ends the line
  });

  it('plain text for the search: markers, comments, links and table rules out', () => {
    const text = noteMeta(
      '# Kopf\n> Zitat\n- [x] Aufgabe\n1. Punkt\n| a | b |\n|---|:-:|\n<!-- weg -->Bild ![Alt](a.png) und [Link](b.md)\n> ---\n',
      'f.md',
    ).text;
    expect(text.replace(/\s+/g, ' ').trim()).toBe('Kopf Zitat Aufgabe Punkt a b Bild Alt und Link');
  });

  it('stays fast on bodies built to make regular expressions backtrack (CodeQL js/polynomial-redos)', () => {
    const t = performance.now();
    firstHeading('# T' + ' '.repeat(200_000) + 'x');
    noteMeta('[a]('.repeat(100_000), 'f.md');
    noteMeta('![a]('.repeat(100_000), 'f.md');
    noteMeta('<!--'.repeat(100_000), 'f.md');
    noteMeta('\n'.repeat(200_000) + 'x', 'f.md');
    noteMeta('-'.repeat(200_000) + 'x', 'f.md');
    expect(performance.now() - t).toBeLessThan(500);
  });
});
