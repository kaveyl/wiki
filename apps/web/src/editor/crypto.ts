// Encrypted notes in the browser (PLAN.md §3d, AD-021/AD-048): age with a passphrase, armored body,
// frontmatter in plain text with `encrypted: age`. Passphrase and plaintext never leave the
// browser. Unlocked passphrases are kept per note or encrypted folder until a pause of
// AUTO_LOCK_MIN minutes (Trilium's "protected session").
import { ATTACHMENTS_KEY, firstHeading, localFileLinks, readFrontmatter, setFrontmatterKeys, splitFrontmatter } from '@kaveyl-wiki/core';
import { usePrefs } from '../prefs';
import { t } from '../i18n';
import { retryable } from '../loading';

const loadAge = retryable(() => import('age-encryption'));

/** scrypt cost 2^16: about a quarter second per note in the browser; the age CLI reads it. */
const WORK_FACTOR = 16;
/** Minutes without use until encrypted notes lock again (per user, Settings → Konto); 0 = never automatically. */
const autoLockMin = () => usePrefs.getState().autoLockMin;

export class WrongPassphrase extends Error {}
/** The file is not a valid age block (cut off, conflict markers in it, edited by hand) – not a passphrase problem. */
export class Damaged extends Error {}

export async function encryptText(passphrase: string, text: string): Promise<string> {
  const age = await loadAge();
  const e = new age.Encrypter();
  e.setPassphrase(passphrase);
  e.setScryptWorkFactor(WORK_FACTOR);
  return age.armor.encode(await e.encrypt(text));
}

export async function decryptText(passphrase: string, armored: string): Promise<string> {
  const age = await loadAge();
  const d = new age.Decrypter();
  d.addPassphrase(passphrase);
  let data: Uint8Array;
  try {
    data = age.armor.decode(armored.trim() + '\n');
  } catch {
    throw new Damaged(t('Der verschlüsselte Inhalt ist beschädigt (kein gültiger age-Block).'));
  }
  try {
    return await d.decrypt(data, 'text');
  } catch {
    throw new WrongPassphrase(t('Passphrase falsch'));
  }
}

export async function encryptBytes(passphrase: string, data: Uint8Array): Promise<Uint8Array> {
  const age = await loadAge();
  const e = new age.Encrypter();
  e.setPassphrase(passphrase);
  e.setScryptWorkFactor(WORK_FACTOR);
  return e.encrypt(data);
}

export async function decryptBytes(passphrase: string, data: Uint8Array): Promise<Uint8Array> {
  const age = await loadAge();
  const d = new age.Decrypter();
  d.addPassphrase(passphrase);
  try {
    return await d.decrypt(data);
  } catch {
    throw new WrongPassphrase(t('Passphrase falsch'));
  }
}

export const isEncrypted = (frontmatter: Record<string, unknown> | undefined) => frontmatter?.encrypted === 'age';

/** File text → { frontmatter block, plaintext body } of an encrypted note. */
export async function openNote(passphrase: string, raw: string): Promise<{ frontmatter: string; body: string }> {
  const { frontmatter, body } = splitFrontmatter(raw);
  return { frontmatter, body: body.trim() ? await decryptText(passphrase, body) : '' };
}

/** Plain file text (frontmatter + body) → encrypted file text, marking `encrypted: age`. */
export async function sealNote(passphrase: string, plainRaw: string): Promise<string> {
  const { body } = splitFrontmatter(plainRaw);
  // No title from the heading (AD-048): only the file name stays readable (display = file name, AD-022).
  // The files it links to stay findable for moving, copying and the consistency check (core/encrypted.ts).
  const files = localFileLinks(plainRaw);
  const marked = setFrontmatterKeys(plainRaw, { encrypted: 'age', [ATTACHMENTS_KEY]: files.length ? files : undefined });
  return splitFrontmatter(marked).frontmatter + (await encryptText(passphrase, body));
}

/** Encrypted file text → plain file text without the marker (removing the encryption). */
export async function unsealNote(passphrase: string, raw: string): Promise<string> {
  const { frontmatter, body } = await openNote(passphrase, raw);
  // Earlier versions copied the first heading into `title:` (AD-048 drops that); a title set on purpose differs and stays.
  const title = readFrontmatter(frontmatter).title;
  const copied = title != null && String(title) === firstHeading(body);
  const plain = setFrontmatterKeys(frontmatter + body, { encrypted: undefined, [ATTACHMENTS_KEY]: undefined, ...(copied ? { title: undefined } : {}) });
  return plain;
}

// ── Session: unlocked passphrases (per note path or encrypted folder) ─────────────────
const unlocked = new Map<string, string>();
let lockTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const keyOf = (mountId: string, scope: string) => `${mountId}:${scope}`;

function touch() {
  clearTimeout(lockTimer);
  const min = autoLockMin();
  if (min > 0) lockTimer = setTimeout(lockAll, min * 60_000);
}

export function lockAll() {
  unlocked.clear();
  clearTimeout(lockTimer);
  for (const l of listeners) l();
}

export function onLock(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Remember a passphrase for a note (scope = its path) or an encrypted folder (scope = folder). */
export function remember(mountId: string, scope: string, passphrase: string) {
  unlocked.set(keyOf(mountId, scope), passphrase);
  touch();
}

/** The passphrase that unlocks this note: its own, or the closest encrypted folder's. */
export function passphraseFor(mountId: string, path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length; i >= 0; i--) {
    const p = unlocked.get(keyOf(mountId, parts.slice(0, i).join('/')));
    if (p) {
      touch();
      return p;
    }
  }
  return null;
}

// Saves of encrypted notes still on their way: locking waits for them before the note is reloaded.
const pendingSaves = new Set<Promise<unknown>>();
export function trackSave<T>(p: Promise<T>): Promise<T> {
  pendingSaves.add(p);
  p.then(
    () => pendingSaves.delete(p),
    () => pendingSaves.delete(p),
  );
  return p;
}
export const savesSettled = () => Promise.allSettled([...pendingSaves]);

/** Any use of an unlocked note keeps the session open. */
export const keepAlive = touch;
export { autoLockMin };

export { isSealed, markSealed } from './sealed';

/** The encrypted folder a path lies in (closest), or null. */
export function encryptedFolderOf(folders: string[], path: string): string | null {
  return folders.filter((f) => path === f || path.startsWith(f + '/')).sort((a, b) => b.length - a.length)[0] ?? null;
}
