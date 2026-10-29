// Line diff for comparing two versions of a note (restore from a backup, AD-038): the text is
// cut into equal and changed blocks; a changed block can be taken over on its own.

export type DiffBlock = { kind: 'same'; lines: string[] } | { kind: 'change'; left: string[]; right: string[] };

/** Longest common subsequence on lines; above ~4 million cells the middle counts as one change. */
export function diffLines(left: string, right: string): DiffBlock[] {
  const a = left.replace(/\r\n/g, '\n').split('\n');
  const b = right.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const blocks: DiffBlock[] = [];
  const push = (kind: 'same' | 'left' | 'right', line: string) => {
    const last = blocks[blocks.length - 1];
    if (kind === 'same') {
      if (last?.kind === 'same') last.lines.push(line);
      else blocks.push({ kind: 'same', lines: [line] });
      return;
    }
    const change = last?.kind === 'change' ? last : (blocks[blocks.length] = { kind: 'change', left: [], right: [] });
    (kind === 'left' ? change.left : change.right).push(line);
  };
  for (let i = 0; i < start; i++) push('same', a[i]!);
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > 4_000_000) {
    for (const l of ma) push('left', l);
    for (const l of mb) push('right', l);
  } else {
    // dp[i][j] = LCS length of ma[i..] and mb[j..]
    const w = mb.length + 1;
    const dp = new Uint32Array((ma.length + 1) * w);
    for (let i = ma.length - 1; i >= 0; i--)
      for (let j = mb.length - 1; j >= 0; j--) dp[i * w + j] = ma[i] === mb[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < ma.length || j < mb.length) {
      if (i < ma.length && j < mb.length && ma[i] === mb[j]) {
        push('same', ma[i]!);
        i++;
        j++;
      } else if (j < mb.length && (i >= ma.length || dp[i * w + j + 1]! >= dp[(i + 1) * w + j]!)) push('right', mb[j++]!);
      else push('left', ma[i++]!);
    }
  }
  for (let i = endA; i < a.length; i++) push('same', a[i]!);
  return blocks;
}

/** The text again, each changed block taken from the left (`true`) or the right side. */
export function mergeBlocks(blocks: DiffBlock[], takeLeft: (index: number) => boolean): string {
  return blocks.flatMap((bl, i) => (bl.kind === 'same' ? bl.lines : takeLeft(i) ? bl.left : bl.right)).join('\n');
}

/**
 * The changes as diff lines for reading (`-` left, `+` right, ` ` equal) with `context` equal lines
 * around each change; longer equal stretches become one `@@ … @@` line. Empty when nothing differs.
 */
export function diffText(blocks: DiffBlock[], context = 3): string {
  if (!blocks.some((b) => b.kind === 'change')) return '';
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (b.kind === 'change') {
      out.push(...b.left.map((l) => `-${l}`), ...b.right.map((l) => `+${l}`));
      return;
    }
    const head = i > 0 ? context : 0;
    const tail = i < blocks.length - 1 ? context : 0;
    const same = (lines: string[]) => lines.map((l) => ` ${l}`);
    if (b.lines.length <= head + tail) out.push(...same(b.lines));
    else out.push(...same(b.lines.slice(0, head)), '@@ … @@', ...same(b.lines.slice(b.lines.length - tail)));
  });
  return out.join('\n');
}
