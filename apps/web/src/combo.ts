// Pure logic of `ComboInput` (ui.tsx): which suggestions to list and where the arrow keys go.

/**
 * Suggestions to list. Opened by its button or an arrow key (`filter` false) the list shows all of
 * them, whatever the field holds; while typing only those containing the text (case-insensitive).
 * A list holding nothing but the typed text itself has nothing to offer and stays closed.
 */
export function comboShown(options: readonly string[], text: string, filter: boolean): string[] {
  const q = text.trim().toLowerCase();
  if (!filter || !q) return [...options];
  const hits = options.filter((o) => o.toLowerCase().includes(q));
  return hits.every((o) => o.toLowerCase() === q) ? [] : hits;
}

/** Next highlighted entry for ↓ (+1) / ↑ (-1), wrapping around; -1 = none (empty list). */
export function comboStep(active: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (active < 0 || active >= count) return dir === 1 ? 0 : count - 1;
  return (active + dir + count) % count;
}
