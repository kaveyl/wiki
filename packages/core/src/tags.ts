// Tag colors (AD-040): a fixed palette that reads well in light and dark mode. Stored per source in
// the root `.kaveyl-wiki.yml` (`tagColors: { rechnung: red }`, keys lower-case); no color = grey.

export const TAG_COLORS = ['red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'fuchsia', 'pink', 'slate'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const TAG_COLOR_NAMES: Record<TagColor, string> = {
  red: 'Rot',
  orange: 'Orange',
  amber: 'Gelb',
  lime: 'Hellgrün',
  green: 'Grün',
  teal: 'Türkis',
  sky: 'Himmelblau',
  blue: 'Blau',
  violet: 'Violett',
  fuchsia: 'Magenta',
  pink: 'Rosa',
  slate: 'Schiefergrau',
};

export const isTagColor = (v: unknown): v is TagColor => typeof v === 'string' && (TAG_COLORS as readonly string[]).includes(v);

/** The key a tag's color is stored under: tags match case-insensitively (#Rechnung = #rechnung). */
export const tagKey = (tag: string) => tag.trim().replace(/^#/, '').toLowerCase();

/** A note's tags with `from` renamed to `to` (case-insensitive), each tag once, order kept. */
export function renameInTags(tags: string[], from: string, to: string): string[] {
  const f = tagKey(from);
  const out: string[] = [];
  for (const t of tags) {
    const next = tagKey(t) === f ? to : t;
    if (!out.some((x) => tagKey(x) === tagKey(next))) out.push(next);
  }
  return out;
}
