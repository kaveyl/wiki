// Encrypted notes (PLAN.md §3d): frontmatter in plain text with `encrypted: age`, the body an
// ASCII-armored age block made in the browser. The server only checks the shape, never decrypts.
import { readFrontmatter, splitFrontmatter } from '@kaveyl-wiki/core';

export const AGE_ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const ARMOR_RE = /^\s*-----BEGIN AGE ENCRYPTED FILE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END AGE ENCRYPTED FILE-----\s*$/;

export function isEncryptedNote(raw: string): boolean {
  return readFrontmatter(splitFrontmatter(raw).frontmatter).encrypted === 'age';
}

/** The body is an age block — or still empty (a new note before its first save). */
export function isAgeBody(raw: string): boolean {
  const body = splitFrontmatter(raw).body;
  return !body.trim() || ARMOR_RE.test(body);
}
