// Linux: a middle click pastes the last marked text (the "primary selection") – and Chromium pastes it into the
// focused field even when the click hit something else. A middle click on a row in the tree or a tab ("open in a
// new tab") wrote the marked text into the open note (E2E 16.11.: 24 × U+FFFC from marked icons). Middle clicks
// outside the focused field must not paste; inside a field they still do.

const EDITABLE = '[contenteditable=""], [contenteditable="true"], input, textarea';

interface Field {
  contains(other: unknown): boolean;
}
interface Focused {
  closest(selector: string): Field | null;
}

/** Whether a middle click on `target` would paste into another, focused field. */
export function strayMiddlePaste(target: unknown, active: Focused | null): boolean {
  const field = active?.closest?.(EDITABLE);
  return !!field && !(target && field.contains(target));
}

export function installMiddleClickGuard(win: Window = window) {
  // The paste happens as the default action of the mouse button going up.
  win.addEventListener(
    'mouseup',
    (e) => {
      if (e.button === 1 && strayMiddlePaste(e.target, win.document.activeElement)) e.preventDefault();
    },
    true,
  );
}
