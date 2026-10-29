import { describe, expect, it } from 'vitest';
import { loadMarkdown, saveMarkdown, canonicalKey } from './document.js';
import { blockToMarkdown } from './to-markdown.js';
import { readFrontmatter, setFrontmatterKeys, splitFrontmatter, updateFrontmatter } from './frontmatter.js';
import type { PMNode } from './from-mdast.js';

const SAMPLE = `---
title: "Home"   # Wiki.js title
tags: home
---

# Willkommen

Ein Absatz mit *kursiv*, __fett__ und [\`code\` im Link](../x.md "T").

* Stern-Liste
* zweiter Punkt

- [ ] offen
- [x] erledigt

| A | B |
|:--|--:|
| 1 | 2 |

<div align="center">HTML bleibt</div>

Fußnote[^1].

[^1]: Die Fußnote.

\`\`\`ts title="meta"
const x = 1;
\`\`\`
`;

function editFirstParagraph(doc: PMNode, suffix: string): PMNode {
  const content = structuredClone(doc.content ?? []);
  const p = content.find((n) => n.type === 'paragraph');
  if (!p?.content) throw new Error('no paragraph');
  const last = [...p.content].reverse().find((n) => n.type === 'text' && !n.marks?.length);
  if (last) last.text += suffix;
  else p.content.push({ type: 'text', text: suffix });
  return { ...doc, content };
}

describe('loadMarkdown/saveMarkdown', () => {
  it('returns the original bytes when nothing changed', () => {
    const { doc, source } = loadMarkdown(SAMPLE);
    expect(saveMarkdown(source, doc)).toBe(SAMPLE);
  });

  it('reproduces the original bytes through the block splicer', () => {
    const { doc, source } = loadMarkdown(SAMPLE);
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(SAMPLE);
  });

  it('keeps unsupported constructs as raw blocks', () => {
    const { doc } = loadMarkdown(SAMPLE);
    const raw = (doc.content ?? []).filter((n) => n.type === 'rawBlock').map((n) => n.attrs?.markdown);
    expect(raw).toEqual([
      '<div align="center">HTML bleibt</div>',
      '[^1]: Die Fußnote.',
      '```ts title="meta"\nconst x = 1;\n```',
    ]);
  });

  it('rewrites only the edited block', () => {
    const { doc, source } = loadMarkdown(SAMPLE);
    const out = saveMarkdown(source, editFirstParagraph(doc, ' Neu.'));
    const before = SAMPLE.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([7]);
    // Edited block uses house style; neighbours keep their original style (`* `, `__`).
    expect(after[7]).toBe('Ein Absatz mit *kursiv*, **fett** und [`code` im Link](../x.md "T"). Neu.');
    expect(after[9]).toBe('* Stern-Liste');
  });

  it('keeps soft line breaks as their own node and writes them back unchanged', () => {
    const md = '- [ ] Token laden (`x`, siehe 9)\n  — MUSS vor dem `git fetch`\n  passieren.\n- [x] fertig\n\nZeile eins\n*kursiv\nüber zwei* Zeilen\n';
    const { doc, source } = loadMarkdown(md);
    expect(JSON.stringify(doc)).not.toContain('\\n');
    const item = doc.content![0]!.content![0]!.content![0]!.content!;
    expect(item.filter((n) => n.type === 'softBreak')).toHaveLength(2);
    expect(saveMarkdown(source, doc)).toBe(md);
    // Edited in the editor (block re-serialized): soft breaks stay soft, indentation stays.
    const edited = structuredClone(doc);
    const last = edited.content![1]!.content!;
    last.push({ type: 'text', text: ' Neu.' });
    edited.content![0]!.content![1]!.attrs = { checked: false };
    expect(saveMarkdown(source, edited)).toBe(
      '- [ ] Token laden (`x`, siehe 9)\n  — MUSS vor dem `git fetch`\n  passieren.\n- [ ] fertig\n\nZeile eins\n*kursiv\nüber zwei* Zeilen Neu.\n',
    );
  });

  it('handles inserted and deleted blocks', () => {
    const { doc, source } = loadMarkdown('# A\n\nEins\n\nZwei\n');
    const content = doc.content ?? [];
    const inserted = { ...doc, content: [content[0]!, { type: 'paragraph', content: [{ type: 'text', text: 'Neu' }] }, ...content.slice(1)] };
    expect(saveMarkdown(source, inserted)).toBe('# A\n\nNeu\n\nEins\n\nZwei\n');
    const deleted = { ...doc, content: [content[0]!, content[2]!] };
    expect(saveMarkdown(source, deleted)).toBe('# A\n\nZwei\n');
  });

  it('preserves CRLF line endings', () => {
    const raw = '# Titel\r\n\r\nAbsatz\r\n\r\n- a\r\n- b\r\n';
    const { doc, source } = loadMarkdown(raw);
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(raw);
    expect(saveMarkdown(source, editFirstParagraph(doc, '!'))).toBe('# Titel\r\n\r\nAbsatz!\r\n\r\n- a\r\n- b\r\n');
  });

  it('writes a fresh document in house style', () => {
    const { source } = loadMarkdown('');
    const doc: PMNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Neu' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'italic' }] }] }] }] },
      ],
    };
    expect(saveMarkdown(source, doc)).toBe('## Neu\n\n- *x*\n');
  });

  // Regressions found by Spike A on real repository files (spikes/roundtrip.spike.ts).
  it.each([
    ['code inside bold stays one strong run', '- **`microsoft-learn`-MCP-Server** registriert'],
    ['paragraph after nested list stays in its item', '- [ ] Punkt\n  - Unterpunkt\n\n  Erst danach zur Kontrolle\n- [ ] zwei'],
    ['code span across lines', '- [ ] `az monitor show --resource-group RG\n      --workspace-name law` liefert'],
    ['table row with missing cells', '| A | B |\n|---|---|\n| nur eins |'],
  ])('re-serializes stably: %s', (_name, md) => {
    const node = loadMarkdown(md).doc.content![0]!;
    const again = loadMarkdown(blockToMarkdown(node)).doc.content!;
    expect(again).toHaveLength(1);
    expect(canonicalKey(again[0]!)).toBe(canonicalKey(node));
  });

  it('drops spaces at paragraph edges instead of writing &#x20;', () => {
    const p = (content: PMNode[]): PMNode => ({ type: 'paragraph', content });
    expect(blockToMarkdown(p([{ type: 'text', text: ' Hallo ' }]))).toBe('Hallo');
    expect(blockToMarkdown(p([{ type: 'text', text: 'a ' }, { type: 'text', text: 'fett ', marks: [{ type: 'bold' }] }]))).toBe('a **fett**');
    expect(blockToMarkdown(p([{ type: 'text', text: 'x' }, { type: 'text', text: 'code ', marks: [{ type: 'code' }] }]))).toBe('x`code `');
  });

  it('puts spaces at the edges of bold/italic/strike outside the mark instead of writing entities (owner find 25.10.)', () => {
    const p = (content: PMNode[]): PMNode => ({ type: 'paragraph', content });
    expect(blockToMarkdown(p([{ type: 'text', text: 'E-Mail- ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'Bundled' }]))).toBe('**E-Mail-** Bundled');
    expect(blockToMarkdown(p([{ type: 'text', text: 'a' }, { type: 'text', text: ' kursiv ', marks: [{ type: 'italic' }] }, { type: 'text', text: 'b' }]))).toBe('a *kursiv* b');
    expect(blockToMarkdown(p([{ type: 'text', text: 'a' }, { type: 'text', text: ' ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'b' }]))).toBe('a b');
    expect(blockToMarkdown(p([{ type: 'text', text: 'fett ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'und kursiv ', marks: [{ type: 'bold' }, { type: 'italic' }] }, { type: 'text', text: 'x' }]))).toBe('**fett *und kursiv*** x');
  });

  it('ignores empty paragraphs added by the editor (no blank-line diff)', () => {
    const raw = '# Stand\n\n- eins\n- zwei\n';
    const { doc, source } = loadMarkdown(raw);
    const withTrailing = { ...doc, content: [...doc.content!, { type: 'paragraph', content: [] }] };
    expect(saveMarkdown(source, withTrailing)).toBe(raw);
    const withMiddle = { ...doc, content: [doc.content![0]!, { type: 'paragraph' }, doc.content![1]!] };
    expect(saveMarkdown(source, withMiddle)).toBe(raw);
  });

  it('treats default attrs and mark order as equal', () => {
    const a: PMNode = { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'italic' }, { type: 'bold' }] }] };
    const b: PMNode = { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'italic' }] }] };
    expect(canonicalKey(a)).toBe(canonicalKey(b));
  });
});

describe('callouts and details', () => {
  const CALLOUT = '> [!WARNING]\n> Vorsicht **heiß**\n> zweite Zeile\n\n> [!tip]\n>\n> Eigener Absatz\n';
  const DETAILS = '<details>\n<summary>Mehr &amp; anderes</summary>\n\nInnen *kursiv*\n\n- a\n- b\n\n</details>\n\nDanach\n';

  it('loads GitHub alerts as callouts and keeps the bytes', () => {
    const { doc, source } = loadMarkdown(CALLOUT);
    expect(doc.content!.map((n) => [n.type, n.attrs?.kind])).toEqual([
      ['callout', 'WARNING'],
      ['callout', 'TIP'],
    ]);
    expect(doc.content![0]!.content![0]!.content![0]).toEqual({ type: 'text', text: 'Vorsicht ' });
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(CALLOUT);
  });

  it('writes edited callouts in GitHub syntax', () => {
    const { doc, source } = loadMarkdown(CALLOUT);
    const edited = structuredClone(doc);
    edited.content![0]!.attrs = { kind: 'NOTE' };
    const out = saveMarkdown(source, edited);
    expect(out).toBe('> [!NOTE]\n> Vorsicht **heiß**\n> zweite Zeile\n\n> [!tip]\n>\n> Eigener Absatz\n');
    const fresh = blockToMarkdown({ type: 'callout', attrs: { kind: 'CAUTION' }, content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }] }] });
    expect(fresh).toBe('> [!CAUTION]\n>\n> - x');
    expect(loadMarkdown(fresh).doc.content![0]!.type).toBe('callout');
  });

  it('never writes &#xA; for callouts with empty paragraphs', () => {
    const p = (text?: string): PMNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
    expect(blockToMarkdown({ type: 'callout', attrs: { kind: 'WARNING' }, content: [p(), p(), p('Text')] })).toBe('> [!WARNING]\n> Text');
    expect(blockToMarkdown({ type: 'callout', attrs: { kind: 'NOTE' }, content: [p(' ')] })).toBe('> [!NOTE]');
  });

  it('leaves blockquotes without a known marker alone', () => {
    const { doc } = loadMarkdown('> [!FOO] kein Alert\n\n> normales Zitat\n');
    expect(doc.content!.map((n) => n.type)).toEqual(['blockquote', 'blockquote']);
  });

  it('groups <details> … </details> into one block and keeps the bytes', () => {
    const { doc, source } = loadMarkdown(DETAILS);
    expect(doc.content!.map((n) => n.type)).toEqual(['details', 'paragraph']);
    const d = doc.content![0]!;
    expect(d.attrs).toEqual({ open: false });
    expect(d.content![0]!.content).toEqual([{ type: 'text', text: 'Mehr & anderes' }]);
    expect(d.content![1]!.content!.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(source.blocks[0]!.md).toBe('<details>\n<summary>Mehr &amp; anderes</summary>\n\nInnen *kursiv*\n\n- a\n- b\n\n</details>');
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(DETAILS);
  });

  it('writes edited details and reads them back identically', () => {
    const { doc, source } = loadMarkdown(DETAILS);
    const edited = structuredClone(doc);
    edited.content![0]!.attrs = { open: true };
    const out = saveMarkdown(source, edited);
    expect(out).toBe('<details open>\n<summary>Mehr &amp; anderes</summary>\n\nInnen *kursiv*\n\n- a\n- b\n\n</details>\n\nDanach\n');
    expect(canonicalKey(loadMarkdown(out).doc.content![0]!)).toBe(canonicalKey(edited.content![0]!));
  });

  it('handles nested details and falls back to raw for unusual HTML', () => {
    const nested = '<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\nTief\n\n</details>\n\n</details>\n';
    const { doc, source } = loadMarkdown(nested);
    expect(doc.content).toHaveLength(1);
    expect(doc.content![0]!.content![1]!.content![0]!.type).toBe('details');
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(nested);

    const odd = '<details class="x">\n<summary><b>A</b></summary>\n\nText\n\n</details>\n';
    const r = loadMarkdown(odd);
    expect(r.doc.content!.map((n) => n.type)).toEqual(['rawBlock']);
    expect(saveMarkdown(r.source, r.doc, { forceSplice: true })).toBe(odd);

    const unclosed = '<details>\n<summary>A</summary>\n\nText\n';
    expect(loadMarkdown(unclosed).doc.content!.map((n) => n.type)).toEqual(['rawBlock', 'paragraph']);
  });
});

describe('tables: line breaks in a cell', () => {
  const p = (content: PMNode[]): PMNode => ({ type: 'paragraph', content });
  const text = (t: string): PMNode => ({ type: 'text', text: t });
  const table = (...cell: PMNode[]): PMNode => ({
    type: 'table',
    content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [p([text('A')])] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: cell }] },
    ],
  });

  it('writes a break and a further paragraph (Enter) as <br>, an empty one not at all', () => {
    expect(blockToMarkdown(table(p([text('eins'), { type: 'hardBreak' }, text('zwei')])))).toBe('| A |\n| - |\n| eins<br>zwei |');
    expect(blockToMarkdown(table(p([text('eins')]), p([text('zwei')]), p([])))).toBe('| A |\n| - |\n| eins<br>zwei |');
  });

  it('reads <br> in a cell as a line break and keeps the bytes', () => {
    const md = '| A |\n|---|\n| eins<br>zwei<br/>drei |\n';
    const { doc, source } = loadMarkdown(md);
    const cell = doc.content![0]!.content![1]!.content![0]!.content![0]!;
    expect(cell.content).toEqual([text('eins'), { type: 'hardBreak' }, text('zwei'), { type: 'hardBreak' }, text('drei')]);
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(md);
  });
});

describe('images: size and alignment (AD-019)', () => {
  const img = (doc: PMNode, block = 0, i = 0) => doc.content![block]!.content![i]!;

  it('reads <img> with width inline and on its own line, keeps the bytes', () => {
    const md = 'Text <img src="assets/a b.png" alt="A &amp; B" width="300"> danach\n\n<img src=\'x.png\' width=50%>\n';
    const { doc, source } = loadMarkdown(md);
    expect(img(doc, 0, 1)).toEqual({ type: 'image', attrs: { src: 'assets/a b.png', alt: 'A & B', title: null, width: '300', height: null } });
    expect(doc.content![1]).toEqual({ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'x.png', alt: null, title: null, width: '50%', height: null } }] });
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(md);
  });

  it('keeps <img> with unknown attributes raw', () => {
    const md = 'A <img src="a.png" style="float:right"> B\n\n<img src="b.png" align="right">\n';
    const { doc, source } = loadMarkdown(md);
    expect(img(doc, 0, 1).type).toBe('rawInline');
    expect(doc.content![1]!.type).toBe('rawBlock');
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(md);
  });

  it('writes a size as <img> and plain images as Markdown', () => {
    const p = (attrs: Record<string, unknown>) => blockToMarkdown({ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'assets/bild.png', alt: 'Ein "Bild"', title: null, width: null, height: null, ...attrs } }] });
    expect(p({})).toBe('![Ein "Bild"](assets/bild.png)');
    expect(p({ width: '400' })).toBe('<img src="assets/bild.png" alt="Ein &quot;Bild&quot;" width="400">');
    expect(p({ width: '50%', alt: null })).toBe('<img src="assets/bild.png" width="50%">');
  });

  it('reads <div align> around a paragraph and <p align> around images; writes the div form', () => {
    const md = '<div align="center">\n\n![Logo](logo.png)\n\n</div>\n\n<p align="right"><img src="r.png" width="120"></p>\n\nEnde\n';
    const { doc, source } = loadMarkdown(md);
    expect(doc.content!.map((n) => [n.type, n.attrs?.align])).toEqual([
      ['paragraph', 'center'],
      ['paragraph', 'right'],
      ['paragraph', undefined],
    ]);
    expect(img(doc).attrs!.src).toBe('logo.png');
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(md);
    // Edited: the second block is rewritten in the div form, the rest stays byte-exact.
    const edited = structuredClone(doc);
    edited.content![1]!.content![0]!.attrs!.width = '200';
    const out = saveMarkdown(source, edited);
    expect(out).toBe('<div align="center">\n\n![Logo](logo.png)\n\n</div>\n\n<div align="right">\n\n<img src="r.png" width="200">\n\n</div>\n\nEnde\n');
    const again = loadMarkdown(out);
    expect(canonicalKey(again.doc.content![1]!)).toBe(canonicalKey(edited.content![1]!));
  });

  it('aligns a text paragraph too and drops the wrapper for no alignment', () => {
    const p: PMNode = { type: 'paragraph', attrs: { align: 'center' }, content: [{ type: 'text', text: 'Mitte **fett**' }] };
    const md = blockToMarkdown(p);
    expect(md).toBe('<div align="center">\n\nMitte \\*\\*fett\\*\\*\n\n</div>');
    expect(loadMarkdown(md + '\n').doc.content![0]!.attrs).toEqual({ align: 'center' });
    expect(blockToMarkdown({ ...p, attrs: { align: null } })).toBe('Mitte \\*\\*fett\\*\\*');
  });

  it('leaves an unclosed or unusual <div align> alone', () => {
    const md = '<div align="center">\n\nText\n\nmehr\n\n</div>\n';
    const { doc, source } = loadMarkdown(md);
    expect(doc.content!.map((n) => n.type)).toEqual(['rawBlock', 'paragraph', 'paragraph', 'rawBlock']);
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(md);
  });
});

describe('math', () => {
  const MD = 'Formel $E = mc^2$ im Text, Preis $5 und $10 bleibt Text.\n\n$$\n\\int_0^1 x\\,dx\n$$\n';
  it('loads inline and display math, keeps money as text and the bytes as they are', () => {
    const { doc, source } = loadMarkdown(MD);
    const para = doc.content![0]!.content!;
    expect(para.find((n) => n.type === 'mathInline')?.attrs).toEqual({ latex: 'E = mc^2' });
    expect(para.filter((n) => n.type === 'mathInline')).toHaveLength(1);
    expect(doc.content![1]).toEqual({ type: 'mathBlock', attrs: { latex: '\\int_0^1 x\\,dx' } });
    expect(saveMarkdown(source, doc, { forceSplice: true })).toBe(MD);
  });
  it('writes edited math back in dollar syntax', () => {
    const { doc, source } = loadMarkdown(MD);
    const edited = structuredClone(doc);
    edited.content![1]!.attrs = { latex: 'a^2 + b^2 = c^2' };
    edited.content![0]!.content!.push({ type: 'text', text: ' Neu.' });
    expect(saveMarkdown(source, edited)).toBe('Formel $E = mc^2$ im Text, Preis $5 und $10 bleibt Text. Neu.\n\n$$\na^2 + b^2 = c^2\n$$\n');
  });
});

describe('frontmatter', () => {
  it('splits byte-exact and reads values', () => {
    const { frontmatter, body } = splitFrontmatter(SAMPLE);
    expect(frontmatter + body).toBe(SAMPLE);
    expect(readFrontmatter(frontmatter)).toEqual({ title: 'Home', tags: 'home' });
  });

  it('updates keys textually: every other byte stays, including comment spacing', () => {
    const { frontmatter } = splitFrontmatter(SAMPLE);
    const updated = updateFrontmatter(frontmatter, { id: '01JA0X8Q7Z', tags: undefined });
    expect(updated).toBe('---\ntitle: "Home"   # Wiki.js title\nid: 01JA0X8Q7Z\n---\n');
    expect(updateFrontmatter(updated, { id: '01JB' })).toBe('---\ntitle: "Home"   # Wiki.js title\nid: 01JB\n---\n');
  });

  it('replaces block values, keeps CRLF and quotes when needed', () => {
    const fm = '---\r\ntags:\r\n  - a\r\n  - b\r\nkeep: 1 # c\r\n...\r\n';
    expect(updateFrontmatter(fm, { tags: 'x', icon: 'emoji:📘', note: 'a: b', flag: true })).toBe(
      '---\r\ntags: x\r\nkeep: 1 # c\r\nicon: emoji:📘\r\nnote: "a: b"\r\nflag: true\r\n...\r\n',
    );
    for (const v of ['yes', '123', '- x', '#x', 'a #b', 'null', '']) {
      expect(readFrontmatter(updateFrontmatter('---\n---\n', { v }))).toEqual({ v });
    }
  });

  it('writes lists as flow sequences', () => {
    expect(updateFrontmatter('---\ntags:\n  - a\n---\n', { tags: ['a', 'b c', 'x: y'] })).toBe('---\ntags: [a, b c, "x: y"]\n---\n');
    expect(readFrontmatter(updateFrontmatter('---\n---\n', { tags: ['a', 'b c', 'x: y'] }))).toEqual({ tags: ['a', 'b c', 'x: y'] });
  });

  it('creates frontmatter only when a key is set', () => {
    expect(setFrontmatterKeys('# T\n', { id: 'X' })).toBe('---\nid: X\n---\n# T\n');
    expect(setFrontmatterKeys('# T\r\n', { id: 'X' })).toBe('---\r\nid: X\r\n---\r\n# T\r\n');
    // Adding a key and taking it away again leaves the file as it was (no empty block).
    expect(setFrontmatterKeys(setFrontmatterKeys('# T\n', { tags: 'x' }), { tags: undefined })).toBe('# T\n');
    expect(setFrontmatterKeys('---\nid: A\ntags: x\n---\n# T\n', { tags: undefined })).toBe('---\nid: A\n---\n# T\n');
    expect(setFrontmatterKeys('# T\n', { id: undefined })).toBe('# T\n');
    expect(setFrontmatterKeys('---\na: 1\n---\nBody\n', { id: 'X' })).toBe('---\na: 1\nid: X\n---\nBody\n');
  });

  it('ignores files without frontmatter', () => {
    expect(splitFrontmatter('# x\n---\n')).toEqual({ frontmatter: '', body: '# x\n---\n' });
  });
});
