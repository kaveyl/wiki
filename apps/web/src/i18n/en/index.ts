// English dictionary, split by area so several people can work on it at once. The same German text may appear in
// more than one area only with the same translation (checked in i18n.test.ts).
import type { Dictionary } from '@kaveyl-wiki/core';
import common from './common';
import connect from './connect';
import editor from './editor';
import settings from './settings';
import shell from './shell';

export const AREAS: Record<string, Dictionary> = { common, shell, settings, editor, connect };

const en: Dictionary = Object.assign({}, ...Object.values(AREAS));
export default en;
