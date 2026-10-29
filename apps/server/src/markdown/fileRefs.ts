// Files a note points to, found without the Markdown parser – for a note it does not read (over 256 KB, too nested,
// AD-076). Only to keep and carry along what such a note shows: its pictures and attachments must not count as unused
// (deleted with „unlessLinkedBy“, called orphaned, left behind on a move). Its links to notes still do not count, and
// nothing is rewritten with these (they may come from a code block – keeping a file too many is harmless).
// Every pattern reads each character a bounded number of times (linear).
import { isExternal } from '@kaveyl-wiki/core';

const INLINE = /\]\(\s*<?([^)\s>]{1,2048})/g;
const HTML_SRC = /<img\b[^>\n]{0,512}?\bsrc\s*=\s*["']?([^"'\s>]{1,2048})/gi;
const DEFINITION = /^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*<?([^\s>]{1,2048})/gm;

/** Addresses of local non-note files in `raw` (as written, like LocalLink.href). */
export function fileReferences(raw: string): string[] {
  const out = new Set<string>();
  for (const re of [INLINE, HTML_SRC, DEFINITION]) {
    for (const m of raw.matchAll(re)) {
      const href = m[1]!;
      const path = href.split(/[?#]/)[0]!;
      if (!path || href.startsWith('#') || isExternal(href) || /\.md$/i.test(path)) continue;
      out.add(href);
    }
  }
  return [...out];
}
