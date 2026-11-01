import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { frontmatterEnd, headingText, idLine, MAX_ENTRIES, sourceHeadings } from './sourceToc';

const state = (doc: string) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
// In the app the view parses in the background; here the whole document is parsed first.
const headings = (s: EditorState) => sourceHeadings(s, ensureSyntaxTree(s, s.doc.length, 10_000)!);
const DOC = [
  '---',
  'id: 01HXYZ',
  'title: Plan',
  '---',
  '# Plan **neu**',
  '',
  'Text',
  '',
  '```md',
  '# kein Titel im Code',
  '```',
  '',
  '## Schritt [[a/b|Zwei]]',
  '',
  'Setext Titel',
  '------------',
  '',
  '    # eingerückt = Code',
  '### `code` und *kursiv* ###',
].join('\n');

describe('Markdown view: table of contents and id hint (Owner 30.10.)', () => {
  it('finds the headings as the parser sees them – not in code, not in the frontmatter', () => {
    const s = state(DOC);
    expect(headings(s).map((h) => [h.level, h.text])).toEqual([
      [1, 'Plan neu'],
      [2, 'Schritt Zwei'],
      [2, 'Setext Titel'],
      [3, 'code und kursiv'],
    ]);
    // Positions point at the heading lines (for jumping).
    expect(headings(s).map((h) => s.doc.lineAt(h.pos).number)).toEqual([5, 13, 15, 19]);
  });

  it('a frontmatter that is not closed hides nothing, and without one nothing is skipped', () => {
    expect(frontmatterEnd(Text.of(['---', 'id: x']))).toBe(0);
    expect(frontmatterEnd(Text.of(['# A', '---']))).toBe(0);
    expect(headings(state('# Eins\n\n## Zwei')).map((h) => h.text)).toEqual(['Eins', 'Zwei']);
  });

  it('cleans heading text like the editor shows it', () => {
    expect(headingText('## [Link](x.md) und ~~alt~~ ##', false)).toBe('Link und alt');
    expect(headingText('Zeile eins\nzwei\n===', true)).toBe('Zeile eins zwei');
    expect(headingText('# snake_case_name', false)).toBe('snake_case_name');
  });

  it('long Setext headings, a BOM, headings in lists – as the visual editor counts them (code review 0.2.12)', () => {
    for (const n of [150, 160, 290, 400]) {
      const [h] = headings(state(`${'a'.repeat(n)}\n${'='.repeat(n)}\n`));
      expect(h!.text).toBe('a'.repeat(Math.min(n, 300)));
    }
    const bom = state(`\uFEFF---\nid: 01HXYZ\ntitle: Plan\n---\n# Plan\n`);
    expect(headings(bom).map((h) => h.text)).toEqual(['Plan']);
    expect(idLine(bom.doc)?.number).toBe(2);
    expect(headings(state('# Oben\n\n- # In der Liste\n\n> ## Im Zitat\n')).map((h) => h.text)).toEqual(['Oben', 'Im Zitat']);
  });

  it('marks only the id line of the frontmatter', () => {
    expect(idLine(Text.of(DOC.split('\n')))?.number).toBe(2);
    expect(idLine(Text.of(['---', 'title: x', '---', 'id: y']))).toBeNull();
    expect(idLine(Text.of(['id: y']))).toBeNull();
  });
});

describe('Markdown view: huge headings stay fast (security review 0.2.12, sec-001)', () => {
  it('a heading of 300 000 brackets or link starts takes milliseconds, and the list is capped', () => {
    for (const body of ['['.repeat(300_000), '[['.repeat(150_000), `${' #'.repeat(150_000)}x`]) {
      const s = state(`# ${body}\n`);
      const tree = ensureSyntaxTree(s, s.doc.length, 10_000)!;
      const start = performance.now();
      const [h] = sourceHeadings(s, tree);
      expect(performance.now() - start).toBeLessThan(200);
      expect(h!.text.length).toBeLessThanOrEqual(300);
    }
    const start = performance.now();
    expect(headingText(`Zeile ${'['.repeat(300_000)}\n---`, true).length).toBeLessThanOrEqual(300);
    expect(performance.now() - start).toBeLessThan(50);
    expect(headings(state('# h\n\n'.repeat(5000))).length).toBe(MAX_ENTRIES);
  });
});
