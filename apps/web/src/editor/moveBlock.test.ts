import { describe, expect, it } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { editorSchema, loadMarkdown, saveMarkdown } from '@kaveyl-wiki/core';
import { moveBlock } from './moveBlock';

/** The note `md` with the cursor in the first text `at`, moved once per step; returns the Markdown body. */
function run(md: string, at: string, steps: (-1 | 1)[]): string {
  const schema = editorSchema();
  const doc = schema.nodeFromJSON(loadMarkdown(md).doc);
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text!.includes(at)) pos = p + n.text!.indexOf(at) + 1;
  });
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  for (const dir of steps) moveBlock(state, dir, (tr) => (state = state.apply(tr)));
  return saveMarkdown(loadMarkdown(md).source, state.doc.toJSON()).trim();
}

describe('Alt+↑/↓ moves a block (owner 24.11.)', () => {
  it('a paragraph swaps with the block above or below; the cursor moves along', () => {
    expect(run('Eins\n\nZwei\n\nDrei\n', 'Zwei', [-1])).toBe('Zwei\n\nEins\n\nDrei');
    expect(run('Eins\n\nZwei\n\nDrei\n', 'Zwei', [1])).toBe('Eins\n\nDrei\n\nZwei');
    expect(run('Eins\n\nZwei\n\nDrei\n', 'Zwei', [1, -1, -1])).toBe('Zwei\n\nEins\n\nDrei');
  });
  it('a list item stays in its list, also checklist items and nested items', () => {
    expect(run('- a\n- b\n- c\n', 'c', [-1])).toBe('- a\n- c\n- b');
    expect(run('- [ ] a\n- [x] b\n', 'a', [1])).toBe('- [x] b\n- [ ] a');
    expect(run('- a\n  - x\n  - y\n- b\n', 'y', [-1])).toBe('- a\n  - y\n  - x\n- b');
  });
  it('at the edge nothing happens', () => {
    expect(run('Eins\n\nZwei\n', 'Eins', [-1])).toBe('Eins\n\nZwei');
    expect(run('- a\n- b\n', 'b', [1])).toBe('- a\n- b');
  });
  it('a whole block chosen as a node moves too; selected table cells are left alone', () => {
    const schema = editorSchema();
    const doc = schema.nodeFromJSON(loadMarkdown('Eins\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n').doc);
    let state = EditorState.create({ doc, selection: NodeSelection.create(doc, doc.child(0).nodeSize) });
    expect(moveBlock(state, -1, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(state.doc.child(0).type.name).toBe('horizontalRule');
    expect(state.selection).toBeInstanceOf(NodeSelection);
    let cell = -1;
    state.doc.descendants((n, p) => {
      if (cell < 0 && n.type.name === 'tableCell') cell = p;
    });
    const cells = EditorState.create({ doc: state.doc, selection: CellSelection.create(state.doc, cell, cell) });
    expect(moveBlock(cells, -1, () => {})).toBe(false);
  });
});
