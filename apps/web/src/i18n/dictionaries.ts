// One dictionary per language besides German (the source language). A new language: a folder like ./en and one line here.
// Each is loaded only for its language, before the app starts (seo-003) – German visitors never download one.
import type { Dictionary, Lang } from '@kaveyl-wiki/core';

export const DICTIONARIES: Partial<Record<Lang, () => Promise<Dictionary>>> = { en: () => import('./en').then((m) => m.default) };
