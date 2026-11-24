// Alt+↑ / Alt+↓ moves the paragraph, heading, list item or block with the cursor one place up or down (owner 24.11.).
// A list item stays in its list (swaps with its neighbour); everything else swaps with the block above or below it at
// the top of the note. Several selected items or blocks of the same list or level move together. Undo brings it back.
import { Extension } from '@tiptap/react';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

const ITEMS = new Set(['listItem', 'taskItem']);

/** The run of sibling blocks to move: their parent, first/last index and where they start and end. */
function blocksOf(state: EditorState): { parent: PMNode; first: number; last: number; start: number; end: number } | null {
  const sel = state.selection;
  // Selected table cells: moving rows is not this command (and a text selection across cells would be invalid).
  if ('$anchorCell' in sel) return null;
  if (sel instanceof NodeSelection) {
    const $at = sel.$from;
    // A whole block (picture, rule, diagram …) or list item chosen as a node: it is the run itself.
    if ($at.depth === 0 || ITEMS.has(sel.node.type.name)) return { parent: $at.parent, first: $at.index(), last: $at.index(), start: sel.from, end: sel.to };
  }
  const { $from, $to } = sel;
  let depth = 1;
  for (let d = $from.depth; d > 0; d--) {
    if (ITEMS.has($from.node(d).type.name)) {
      depth = d;
      break;
    }
  }
  if ($from.depth < depth || $to.depth < depth) return null;
  // The selection must end in the same list where it starts (the note itself is one for the top level).
  if (depth > 1 && $to.start(depth - 1) !== $from.start(depth - 1)) return null;
  return { parent: $from.node(depth - 1), first: $from.index(depth - 1), last: $to.index(depth - 1), start: $from.before(depth), end: $to.after(depth) };
}

export function moveBlock(state: EditorState, dir: -1 | 1, dispatch?: (tr: Transaction) => void): boolean {
  const run = blocksOf(state);
  if (!run) return false;
  const { parent, first, last, start, end } = run;
  if (dir < 0 ? first === 0 : last >= parent.childCount - 1) return false;
  if (!dispatch) return true;
  const neighbour = parent.child(dir < 0 ? first - 1 : last + 1);
  const shift = dir < 0 ? -neighbour.nodeSize : neighbour.nodeSize;
  const tr = state.tr;
  const moved = state.doc.slice(start, end).content;
  tr.delete(start, end);
  tr.insert(dir < 0 ? start - neighbour.nodeSize : start + neighbour.nodeSize, moved);
  const sel = state.selection;
  if (sel instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, sel.from + shift));
  else tr.setSelection(TextSelection.create(tr.doc, sel.anchor + shift, sel.head + shift));
  dispatch(tr.scrollIntoView());
  return true;
}

export const MoveBlock = Extension.create({
  name: 'moveBlock',
  addKeyboardShortcuts() {
    return {
      'Alt-ArrowUp': ({ editor }) => moveBlock(editor.state, -1, editor.view.dispatch),
      'Alt-ArrowDown': ({ editor }) => moveBlock(editor.state, 1, editor.view.dispatch),
    };
  },
});
