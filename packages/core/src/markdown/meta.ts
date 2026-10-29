// Note metadata derived from a Markdown file: id, display title, icon, read-only flag, tags
// and a plain-text body for the search index. Foreign frontmatter (Wiki.js `title`/`tags`)
// is respected but never modified. SEE-DOC: docs/PLAN.md §2.3, §2.5a

import { readFrontmatter, splitFrontmatter } from './frontmatter.js';

export interface NoteMeta {
  id: string | null;
  title: string;
  icon: string | null;
  readonly: boolean;
  tags: string[];
  /** Body without frontmatter, lightly stripped of Markdown syntax (for full-text search). */
  text: string;
  frontmatter: Record<string, unknown>;
}

export function noteMeta(raw: string, fileName: string): NoteMeta {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = readFrontmatter(frontmatter);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    id: str(fm.id),
    title: str(fm.title) ?? firstHeading(body) ?? fileName.replace(/\.md$/i, ''),
    icon: str(fm.icon),
    readonly: fm.readonly === true,
    tags: parseTags(fm.tags),
    // Encrypted notes (`encrypted: age`): the body is an age block — nothing to index.
    text: fm.encrypted === 'age' ? '' : plainText(body),
    frontmatter: fm,
  };
}

/** Wiki.js stores tags as a comma-separated string; others use YAML lists. */
export function parseTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

export function firstHeading(body: string): string | null {
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) return stripInline(h[1]!);
  }
  return null;
}

function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .trim();
}

function plainText(body: string): string {
  return stripInline(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, '')
      .replace(/\|/g, ' '),
  );
}
