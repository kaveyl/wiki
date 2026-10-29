/**
 * Runs `open` once no menu is open any more. A dialog that mounts while the menu it was chosen from
 * is still there fights that menu for the focus, and the first keys typed land in the menu („bc“
 * instead of „abc“ in the title of a new note). After a menu closes, Radix gives the focus back to
 * where it was in a timer of its own – `open` waits for that too, so the dialog starts like one
 * opened by a button. Gives up waiting after `frames` frames.
 */
export function afterMenus(open: () => void, { menuOpen = defaultMenuOpen, nextFrame = defaultNextFrame, later = defaultLater, frames = 30 }: Wait = {}, waited = false): void {
  if (frames <= 0) return open();
  if (!menuOpen()) return waited ? later(open) : open();
  nextFrame(() => afterMenus(open, { menuOpen, nextFrame, later, frames: frames - 1 }, true));
}

interface Wait {
  menuOpen?: () => boolean;
  nextFrame?: (f: () => void) => void;
  later?: (f: () => void) => void;
  frames?: number;
}

const defaultMenuOpen = () => typeof document !== 'undefined' && !!document.querySelector('[role="menu"]');
const defaultNextFrame = (f: () => void) => (typeof requestAnimationFrame === 'undefined' ? setTimeout(f, 16) : requestAnimationFrame(f));
const defaultLater = (f: () => void) => setTimeout(f, 0);
