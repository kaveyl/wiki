// The import formats (docs/PLAN-IMPORT.md, Stufe 1 und 2). New format = a converter here and its sentence
// „so erzeugst du den Export“ in the manual.
import type { FormatId, ImportFormat } from '../types.js';
import type { SourceFile } from '../zip.js';
import { hedgedoc } from './hedgedoc.js';
import { joplin } from './joplin.js';
import { logseq } from './logseq.js';
import { markdown } from './markdown.js';
import { obsidian } from './obsidian.js';
import { outline } from './outline.js';
import { trilium } from './trilium.js';
import { wikijs } from './wikijs.js';
import { silverbullet } from './silverbullet.js';

export const FORMATS: readonly ImportFormat[] = [hedgedoc, joplin, logseq, silverbullet, obsidian, trilium, wikijs, outline, markdown];

export const formatById = (id: string): ImportFormat | undefined => FORMATS.find((f) => f.id === id);

/** The most likely format of an export, or null when none fits (no Markdown at all). */
export async function detectFormat(files: SourceFile[]): Promise<FormatId | null> {
  let best: { id: FormatId; score: number } | null = null;
  for (const f of FORMATS) {
    const score = await f.detect(files);
    if (score > 0 && (!best || score > best.score)) best = { id: f.id, score };
  }
  return best?.id ?? null;
}
