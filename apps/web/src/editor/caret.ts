// Keeps the reader's place when a note is reloaded because someone else changed it (live updates):
// focus, cursor and scroll position survive the new editor. Works on the DOM, so for the rich editor
// (ProseMirror) and the Markdown view (CodeMirror) alike – both pick up the DOM selection when focused.

export interface Caret {
  /** The cursor was in the editor (only then it gets the focus back). */
  focused: boolean;
  /** Text right before the cursor – found again in the new text, even if something was added above. */
  before: string;
  offset: number;
  scroll: number;
}

const EDITABLE = '[contenteditable="true"]';

export function captureCaret(root: HTMLElement | null): Caret | null {
  const ed = root?.querySelector<HTMLElement>(EDITABLE);
  if (!ed) return null;
  const scroll = ed.closest<HTMLElement>('.overflow-y-auto')?.scrollTop ?? 0;
  const sel = window.getSelection();
  const active = document.activeElement;
  // In the text – not on a control inside the editor (a task checkbox, a code language select): there is no text spot.
  const onControl = !!active && active !== ed && /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(active.tagName);
  const focused = !!active && ed.contains(active) && !onControl && !!sel?.rangeCount && ed.contains(sel.anchorNode);
  if (!focused) return { focused, before: '', offset: 0, scroll };
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.setEnd(sel!.anchorNode!, sel!.anchorOffset);
  const text = range.toString();
  // At the very start with nothing before it is no spot the person chose (e.g. after a click on a task checkbox the
  // editor sits at the start): then only the scroll position.
  if (!text) return { focused: false, before: '', offset: 0, scroll };
  return { focused, before: text.slice(-40), offset: text.length, scroll };
}

/** Puts focus, cursor and scroll position back; false while the new editor is not there yet. */
export function restoreCaret(root: HTMLElement | null, caret: Caret): boolean {
  const ed = root?.querySelector<HTMLElement>(EDITABLE);
  if (!ed || !ed.textContent) return false;
  const scroller = ed.closest<HTMLElement>('.overflow-y-auto');
  if (caret.focused) {
    const full = ed.textContent;
    // The occurrence of the text before the cursor nearest to where it was.
    // Longest piece first; shorter ones when something was inserted inside the piece (e.g. a new paragraph above).
    let at = -1;
    for (const len of [40, 20, 10, 5]) {
      const piece = caret.before.slice(-len);
      if (!piece || at !== -1) break;
      for (let i = full.indexOf(piece); i !== -1; i = full.indexOf(piece, i + 1)) {
        const end = i + piece.length;
        if (at === -1 || Math.abs(end - caret.offset) < Math.abs(at - caret.offset)) at = end;
      }
    }
    if (at === -1) at = Math.min(caret.offset, full.length);
    ed.focus({ preventScroll: true });
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let left = at;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.textContent?.length ?? 0;
      if (left <= len) {
        window.getSelection()?.collapse(node, left);
        break;
      }
      left -= len;
    }
  }
  if (scroller) scroller.scrollTop = caret.scroll;
  return true;
}
