// Keyboard for the sidebar tree (WAI-ARIA „Tree View“): the moves as a pure function over the
// visible rows, plus the DOM side – one row in the tab order (roving tabindex), menu by keyboard.

export interface TreeRow {
  /** 1 = source, 2 = its top level, … */
  level: number;
  /** Sources and folders: open or closed; notes: undefined. */
  expanded?: boolean;
}

/** Move the focus to another row, or open/close the current one. */
export type TreeMove = { focus: number } | { expand: boolean } | null;

/** What `key` does on row `i` of the visible rows (in display order). */
export function treeMove(rows: TreeRow[], i: number, key: string): TreeMove {
  const row = rows[i];
  if (!row) return null;
  switch (key) {
    case 'ArrowDown':
      return i + 1 < rows.length ? { focus: i + 1 } : null;
    case 'ArrowUp':
      return i > 0 ? { focus: i - 1 } : null;
    case 'Home':
      return { focus: 0 };
    case 'End':
      return { focus: rows.length - 1 };
    case 'ArrowRight':
      if (row.expanded === false) return { expand: true };
      return row.expanded && (rows[i + 1]?.level ?? 0) > row.level ? { focus: i + 1 } : null;
    case 'ArrowLeft':
      if (row.expanded) return { expand: false };
      for (let j = i - 1; j >= 0; j--) if (rows[j]!.level < row.level) return { focus: j };
      return null;
  }
  return null;
}

/**
 * Where the focus goes when row `i` is deleted (with what was inside it): the next row of the same
 * source, else the previous one (a sibling, the parent folder or the source head); null for a source head.
 */
export function rowAfterRemoval(rows: TreeRow[], i: number): number | null {
  const row = rows[i];
  if (!row || row.level <= 1) return null;
  for (let j = i + 1; j < rows.length && rows[j]!.level > 1; j++) if (rows[j]!.level <= row.level) return j;
  return i - 1;
}

export const TREE_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

export const treeItems = (tree: HTMLElement) => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];

export const treeRow = (el: HTMLElement): TreeRow => ({
  level: Number(el.getAttribute('aria-level')) || 1,
  expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : undefined,
});

/**
 * Exactly one row in the tab order: the focused one, else the last focused, else the selected one,
 * else the first. Rows render `tabIndex={-1}` and React never touches it again, so this sticks.
 */
export function rove(tree: HTMLElement, last: HTMLElement | null) {
  const rows = treeItems(tree);
  const active = document.activeElement;
  const pick =
    rows.find((r) => r === active) ??
    (last && rows.includes(last) ? last : undefined) ??
    rows.find((r) => r.getAttribute('aria-selected') === 'true') ??
    rows[0];
  for (const r of rows) r.tabIndex = r === pick ? 0 : -1;
}

/** Shift+F10 or the context menu key. */
export const isMenuKey = (e: { key: string; shiftKey: boolean }) => e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

/** Opens the element's context menu (Radix listens to `contextmenu`) just below its start. */
export function openContextMenu(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 16, clientY: r.bottom }));
}
