// Three-way merge of a note (team test 23.10.): two people changed the same version – changes at different
// places come together, like Git does. Lines are the unit (a Markdown paragraph is one line).
// Both changing the same lines is a conflict; then the people choose a version as before.
import { diffLines } from './diff.js';

interface Hunk {
  /** Base lines [start, end) are replaced by `lines`; start === end is a pure insertion before `start`. */
  start: number;
  end: number;
  lines: string[];
}

function hunks(base: string, other: string): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  for (const b of diffLines(base, other)) {
    if (b.kind === 'same') at += b.lines.length;
    else {
      out.push({ start: at, end: at + b.left.length, lines: b.right });
      at += b.left.length;
    }
  }
  return out;
}

const same = (a: Hunk, b: Hunk) => a.start === b.start && a.end === b.end && a.lines.join('\n') === b.lines.join('\n');

/**
 * `mine` and `theirs` both started from `base`. Returns the merged text, or null when both changed the same
 * place. Both only inserting at the same spot keeps both (theirs first – it was saved first).
 */
export function merge3(base: string, mine: string, theirs: string): string | null {
  const norm = (s: string) => s.replace(/\r\n/g, '\n');
  [base, mine, theirs] = [norm(base), norm(mine), norm(theirs)];
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const a = hunks(base, mine);
  const b = hunks(base, theirs);
  const lines = base.split('\n');
  const merged: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x && y) {
      const insX = x.start === x.end;
      const insY = y.start === y.end;
      const shareLines = x.start < y.end && y.start < x.end;
      const inside = (ins: Hunk, h: Hunk) => ins.start > h.start && ins.start < h.end;
      if (shareLines || (insX && inside(x, y)) || (insY && inside(y, x))) {
        if (!same(x, y)) return null;
        merged.push(x);
        i++;
        j++;
        continue;
      }
      if (insX && insY && x.start === y.start) {
        merged.push(same(x, y) ? x : { start: x.start, end: x.end, lines: [...y.lines, ...x.lines] });
        i++;
        j++;
        continue;
      }
      // Apart (also: an insertion right before or after the other's change) – the earlier one first.
      const xFirst = x.start < y.start || (x.start === y.start && insX);
      merged.push(xFirst ? x : y);
      if (xFirst) i++;
      else j++;
      continue;
    }
    merged.push((x ?? y)!);
    if (x) i++;
    else j++;
  }
  const out: string[] = [];
  let at = 0;
  for (const h of merged) {
    out.push(...lines.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...lines.slice(at));
  return out.join('\n');
}
