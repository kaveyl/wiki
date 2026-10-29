// Encrypted notes (AD-021): the body is an age block the server cannot read. So that moving, copying, the index
// and the consistency check still know which files such a note uses (its encrypted `.age` attachments), the
// browser lists them in the plain frontmatter as `attachments` when it seals the note. File names are visible on
// disk anyway; the list adds nothing secret.
import { isExternal } from './links.js';
import { extractLinks } from './linkScan.js';
import { readFrontmatter, splitFrontmatter } from './markdown/frontmatter.js';

export const ATTACHMENTS_KEY = 'attachments';

/** Local files (not notes, not web addresses) a plaintext note links to, as written (relative hrefs). */
export function localFileLinks(raw: string): string[] {
  const out = new Set<string>();
  const add = (href: string) => {
    const h = href.split(/[?#]/)[0]!;
    // Files have an extension; notes are `.md` or written without one (Wiki.js style).
    if (h && !isExternal(h) && /\.[a-z0-9]+$/i.test(h) && !/\.md$/i.test(h)) out.add(h);
  };
  for (const l of extractLinks(raw)) add(l.href);
  return [...out];
}

/** The files an encrypted note lists in its frontmatter, or null for notes sealed before the list existed. */
export function listedAttachments(raw: string): string[] | null {
  const v = readFrontmatter(splitFrontmatter(raw).frontmatter)[ATTACHMENTS_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}
