// Pure logic of `useTabs` (ui.tsx): where the keys of a tab row go (WAI-ARIA tabs pattern).

/** Tab to move to for a key in a horizontal tab row, wrapping around; null = not a tab-row key (or no tabs). */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const at = index >= 0 && index < count;
  switch (key) {
    case 'ArrowRight':
      return at ? (index + 1) % count : 0;
    case 'ArrowLeft':
      return at ? (index - 1 + count) % count : count - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
