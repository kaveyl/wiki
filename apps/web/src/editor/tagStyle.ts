// Tag colors (AD-040): palette classes for light and dark mode and the colors of all sources.
// No imports from the shell here — the search page uses it too (no import cycle).
import { useQuery } from '@tanstack/react-query';
import { tagKey, type TagColor } from '@kaveyl-wiki/core';
import { api } from '../api';

/** Chip colors; written out in full so Tailwind finds every class. No color = the grey of today. */
export const TAG_CHIP: Record<TagColor, string> = {
  red: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
  lime: 'bg-lime-100 text-lime-800 dark:bg-lime-500/20 dark:text-lime-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-500/20 dark:text-fuchsia-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200',
  slate: 'bg-slate-200 text-slate-800 dark:bg-slate-400/25 dark:text-slate-200',
};
export const TAG_DOT: Record<TagColor, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-400',
  lime: 'bg-lime-500',
  green: 'bg-green-600',
  teal: 'bg-teal-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-600',
  violet: 'bg-violet-500',
  fuchsia: 'bg-fuchsia-500',
  pink: 'bg-pink-400',
  slate: 'bg-slate-500',
};
export const tagChipClass = (color: TagColor | null | undefined) => (color ? TAG_CHIP[color] : 'bg-muted text-fg-muted');

/** The color of a tag in a source (null: none). Without a source: the one of the tag list. */
export function useTagColors() {
  const colors = useQuery({ queryKey: ['tag-colors'], queryFn: api.tagColors, staleTime: 30_000 });
  return (mountId: string, tag: string): TagColor | null => colors.data?.[mountId]?.[tagKey(tag)] ?? null;
}

