// Names of the callout kinds (GitHub alerts) – in their own module: the toolbar and the slash menu
// both need them while loading, and importing one from the other made the load order matter.
import type { CALLOUT_KINDS } from '@kaveyl-wiki/core';

export const CALLOUT_LABELS: Record<(typeof CALLOUT_KINDS)[number], string> = {
  NOTE: 'Hinweis',
  TIP: 'Tipp',
  IMPORTANT: 'Wichtig',
  WARNING: 'Warnung',
  CAUTION: 'Vorsicht',
};
