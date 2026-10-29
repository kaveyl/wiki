// Encrypted notes and folders in the UI (PLAN.md §3d, AD-021): unlock screen, encrypt / decrypt a note,
// encrypt a folder. All crypto runs in the browser (crypto.ts); the passphrase dialog is in Passphrase.tsx.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { api, ApiError, errorText, type NoteDocument } from '../api';
import { Button, Field, Input, Spinner, FormError, useRepeatCheck } from '../ui';
import { askPassphrase } from './Passphrase';
import { decryptBytes, encryptBytes, markSealed, onLock, openNote, passphraseFor, remember, savesSettled, sealNote, unsealNote, WrongPassphrase, autoLockMin } from './crypto';
import { extractLinks, isExternal, loadMarkdown, resolveHref, splitFrontmatter } from '@kaveyl-wiki/core';
import { noteNameIn } from '../names';
import { t, tn } from '../i18n';


const LOSS_WARNING = (
  <>
    {t('Ver- und Entschlüsselt wird nur in deinem Browser.')} <b>{t('Ohne Passphrase sind die Inhalte verloren')}</b>{' '}
    {t('– niemand kann sie wiederherstellen. Ältere, unverschlüsselte Versionen bleiben in der Git-Historie lesbar. Titel, Tags und Dateinamen bleiben sichtbar.')}
  </>
);

// ── Unlock screen for an encrypted note ─────────────────────────────────────────────
/** Shows the note after unlocking: `children` gets the plaintext note and a function that encrypts on save. */
export function EncryptedGate({
  note,
  scope,
  children,
  onLocked,
}: {
  note: NoteDocument;
  /** After locking: reload the note (the file changed with every save since it was loaded). */
  onLocked?: () => void;
  /** Where the passphrase is remembered: the encrypted folder, or the note itself. */
  scope: string;
  children: (plain: NoteDocument, seal: (plainRaw: string) => Promise<string>) => ReactNode;
}) {
  const [plain, setPlain] = useState<{ note: NoteDocument; passphrase: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  /** Nothing to check the passphrase against (empty note, no other note with content): typed twice instead. */
  const [repeat, setRepeat] = useState<string | null>(null);
  const repeatCheck = useRepeatCheck(input, repeat ?? '');
  const current = useRef(note);
  current.current = note;

  const unlock = async (passphrase: string, fromSession: boolean) => {
    const at = note;
    setBusy(true);
    setError(null);
    try {
      const { frontmatter, body } = await openNote(passphrase, at.raw);
      // An empty note decrypts with anything: check the passphrase against another note of the folder first, so a
      // typo is neither accepted nor remembered for the whole folder (the next save would seal the note with it).
      if (!fromSession && !splitFrontmatter(at.raw).body.trim()) {
        const ok = scope !== at.path ? await checkFolderPassphrase(at.mountId, scope, passphrase) : null;
        if (ok === false) throw new WrongPassphrase(t('Passphrase falsch'));
        if (ok === null && repeat !== passphrase) {
          setRepeat('');
          setError(repeat ? t('Die beiden Eingaben unterscheiden sich.') : t('Noch nichts zum Prüfen da – bitte die Passphrase zur Sicherheit wiederholen.'));
          return;
        }
      }
      if (current.current.hash !== at.hash) return; // the note changed meanwhile: its own unlock follows
      if (!fromSession) remember(at.mountId, scope, passphrase);
      const raw = frontmatter + body;
      setPlain({ note: { ...at, raw, doc: loadMarkdown(raw).doc }, passphrase });
      // The typed passphrase is not kept in the form: after locking, the field is empty again.
      setInput('');
      setRepeat(null);
    } catch (e) {
      setError(e instanceof WrongPassphrase ? t('Passphrase falsch.') : errorText(e));
      if (fromSession) setPlain(null); // e.g. damaged file: show the reason instead of the old text
    } finally {
      setBusy(false);
    }
  };
  // Locked again (pause or "Sperren"): back to the unlock screen. The note is reloaded once the editor's last
  // save (made while it closes) has arrived – before that the reload would show the old text.
  const [locks, setLocks] = useState(0);
  useEffect(
    () =>
      onLock(() => {
        setPlain(null);
        setInput('');
        setLocks((n) => n + 1);
      }),
    [],
  );
  const lockedRef = useRef(onLocked);
  lockedRef.current = onLocked;
  useEffect(() => {
    if (locks) void savesSettled().then(() => lockedRef.current?.());
  }, [locks]);
  useEffect(() => {
    markSealed(note.mountId, note.path, !!plain);
    return () => void markSealed(note.mountId, note.path, false);
  }, [plain, note.mountId, note.path]);
  // Already unlocked in this session (same note or its folder): open right away – also after the file changed.
  useEffect(() => {
    const known = passphraseFor(note.mountId, note.path);
    if (known) void unlock(known, true);
    else setPlain(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.raw]);

  if (plain && plain.note.hash === note.hash) return <>{children(plain.note, (plainRaw) => sealNote(plain.passphrase, plainRaw))}</>;
  if (plain) {
    // Decrypting the newer file text: never show (and edit) the old one meanwhile.
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        className="w-full max-w-sm space-y-3 rounded-xl border border-line p-6 text-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (input && (repeat === null || repeat)) void unlock(input, false);
        }}
      >
        <div className="flex items-center gap-2 text-base font-medium">
          <Lock className="h-5 w-5 text-accent" /> {noteNameIn(note.mountId, note.path)}
        </div>
        <p className="text-fg-muted">
          {scope !== note.path ? t('Diese Notiz ist verschlüsselt (Ordner „{folder}“).', { folder: scope }) : t('Diese Notiz ist verschlüsselt.')}{' '}
          {autoLockMin() > 0
            ? tn(autoLockMin(), 'Entsperren gilt für diese Sitzung, bis {n} Minute lang nichts passiert (Einstellungen → Konto).', 'Entsperren gilt für diese Sitzung, bis {n} Minuten lang nichts passiert (Einstellungen → Konto).')
            : t('Entsperren gilt für diese Sitzung, bis die Seite geschlossen wird (Einstellungen → Konto).')}
        </p>
        <Input
          type="password"
          autoFocus
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (repeat !== null) setRepeat('');
          }}
          aria-label={t('Passphrase')}
          placeholder={t('Passphrase')}
          autoComplete="current-password"
        />
        {repeat !== null && (
          <Field label={t('Passphrase wiederholen')} error={repeatCheck.error}>
            <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} onBlur={repeatCheck.onBlur} aria-label={t('Passphrase wiederholen')} placeholder={t('Wiederholen')} autoComplete="current-password" />
          </Field>
        )}
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" disabled={!input || busy || repeat === ''}>
          {busy ? <Spinner className="h-4 w-4" /> : t('Entsperren')}
        </Button>
      </form>
    </div>
  );
}

// ── Actions: encrypt / decrypt a note, encrypt a folder ───────────────────────────
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Checks a passphrase against a note of the folder that has encrypted content: true / false,
 * or null when there is none (an empty or new encrypted folder).
 */
export async function checkFolderPassphrase(mountId: string, folder: string, passphrase: string): Promise<boolean | null> {
  const notes = (await api.encryptedNotes(mountId, folder)).filter((n) => n.encrypted && !n.empty);
  for (const n of notes.slice(0, 3)) {
    // A failed load is no "nothing to check": the passphrase would be taken unchecked.
    const note = await api.note(mountId, n.path).catch((e: unknown) => {
      throw new Error(t('Die Passphrase ließ sich nicht prüfen – {error}. Bitte später noch einmal versuchen.', { error: errorText(e) }));
    });
    if (splitFrontmatter(note.raw).body.trim() === '') continue;
    try {
      await openNote(passphrase, note.raw);
      return true;
    } catch (e) {
      if (e instanceof WrongPassphrase) return false;
      // Damaged file: try the next one.
    }
  }
  return null;
}

/** Local file destinations of a note (Markdown links, images, definitions and `<img src>`) with their place in the text. */
function fileLinks(raw: string, notePath: string): { start: number; end: number; wrapped: boolean; path: string }[] {
  const out: { start: number; end: number; wrapped: boolean; path: string }[] = [];
  const add = (start: number, end: number, written: string, href: string) => {
    if (isExternal(href) || href.startsWith('#') || href.startsWith('data:')) return;
    const target = resolveHref(href, notePath);
    if (!target || target.path.endsWith('.md') || !target.path.split('/').includes('assets')) return;
    out.push({ start, end, wrapped: written.startsWith('<'), path: target.path });
  };
  // extractLinks covers Markdown links/images and `<img src>` alike.
  for (const l of extractLinks(raw)) add(l.start, l.end, l.raw, l.href);
  return out.sort((a, b) => b.start - a.start);
}

/**
 * Replaces the attachments a note links to: `convert` gets each file (once) and returns the new link, or null
 * to leave it. Returns the new text and the replaced files (removed by the caller once the note is saved).
 */
export async function replaceAttachments(raw: string, notePath: string, convert: (path: string) => Promise<string | null>): Promise<{ raw: string; replaced: string[] }> {
  const links = fileLinks(raw, notePath);
  const done = new Map<string, string | null>();
  for (const l of links) if (!done.has(l.path)) done.set(l.path, await convert(l.path));
  let out = raw;
  for (const l of links) {
    const to = done.get(l.path);
    if (to) out = out.slice(0, l.start) + (l.wrapped ? `<${to}>` : to) + out.slice(l.end);
  }
  return { raw: out, replaced: [...done].filter(([, to]) => to).map(([p]) => p) };
}

async function fileBytes(mountId: string, path: string): Promise<Uint8Array | null> {
  const res = await fetch(api.fileUrl(mountId, path), { credentials: 'same-origin' });
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

/** Plain attachments (in `assets/`) → encrypted `.age` copies. */
const sealAttachments = (mountId: string, notePath: string, plainRaw: string, passphrase: string) =>
  replaceAttachments(plainRaw, notePath, async (path) => {
    if (path.endsWith('.age')) return null;
    const data = await fileBytes(mountId, path);
    if (!data) return null;
    const stored = await api.upload(mountId, notePath, new File([(await encryptBytes(passphrase, data)) as BlobPart], `${path.split('/').pop()!}.age`));
    return stored.href;
  });

/** Encrypted `.age` attachments → plain copies (the note must already be saved in plain text). */
const unsealAttachments = (mountId: string, notePath: string, plainRaw: string, passphrase: string) =>
  replaceAttachments(plainRaw, notePath, async (path) => {
    if (!path.endsWith('.age')) return null;
    const data = await fileBytes(mountId, path);
    if (!data) return null;
    const stored = await api.upload(mountId, notePath, new File([(await decryptBytes(passphrase, data)) as BlobPart], path.split('/').pop()!.replace(/\.age$/, '')));
    return stored.href;
  });

/** Removes replaced attachments – unless another note still links to them (shared images). */
async function dropReplaced(mountId: string, notePath: string, files: string[]) {
  for (const f of files) await api.deleteAttachment(mountId, f, notePath).catch(() => undefined);
}

/** Saves with a fresh base when an autosave got there first (the content is computed from the newest text). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409) || i >= 2) throw e;
    }
  }
}

/**
 * Encrypts one note (asks for a new passphrase unless one is given). True when done.
 * `content`: the editor's newer text (not yet saved) instead of the file's.
 */
export async function encryptNote(mountId: string, path: string, given?: string, content?: string): Promise<boolean> {
  const passphrase = given ?? (await askPassphrase(t('Notiz verschlüsseln'), LOSS_WARNING, true));
  if (!passphrase) return false;
  let replaced: string[] = [];
  await withRetry(async () => {
    const note = await api.note(mountId, path);
    if (note.frontmatter?.encrypted === 'age') return;
    // Encrypted copies first, the note second, the plain originals last: an error in between loses nothing.
    const sealed = await sealAttachments(mountId, path, content ?? note.raw, passphrase);
    await api.saveRaw(mountId, path, await sealNote(passphrase, sealed.raw), note.hash);
    replaced = sealed.replaced;
  });
  await dropReplaced(mountId, path, replaced);
  remember(mountId, path, passphrase);
  return true;
}

/** Plain text of an encrypted note → saved in plain text, its `.age` attachments back as plain files. */
async function unsealAndSave(mountId: string, path: string, passphrase: string) {
  const note = await api.note(mountId, path);
  if (note.frontmatter?.encrypted !== 'age') return;
  const plain = await unsealNote(passphrase, note.raw);
  const saved = await api.saveRaw(mountId, path, plain, note.hash, { allowPlain: true });
  const files = await unsealAttachments(mountId, path, plain, passphrase);
  if (!files.replaced.length) return;
  await api.saveRaw(mountId, path, files.raw, saved.hash, { allowPlain: true });
  await dropReplaced(mountId, path, files.replaced);
}

/** Removes the encryption of a note (needs the passphrase), including its attachments. */
export async function decryptNote(mountId: string, path: string): Promise<boolean> {
  const passphrase = passphraseFor(mountId, path) ?? (await askPassphrase(t('Verschlüsselung entfernen'), t('Die Notiz wird danach wieder im Klartext gespeichert.'), false));
  if (!passphrase) return false;
  await unsealAndSave(mountId, path, passphrase);
  return true;
}

/**
 * Marks a folder as encrypted and encrypts every note in it with one passphrase – the notes as they are on disk,
 * again until none is left (notes arriving meanwhile). Also continues an interrupted run of an encrypted folder.
 */
export async function encryptFolder(mountId: string, folder: string, onProgress: (done: number, total: number) => void): Promise<boolean> {
  const known = passphraseFor(mountId, folder);
  const already = (await api.encryptedFolders(mountId)).includes(folder);
  let passphrase = known;
  if (!passphrase) {
    passphrase = already
      ? await askPassphrase(t('Ordner „{folder}“ fertig verschlüsseln', { folder }), t('Die Passphrase des Ordners – die übrigen Notizen bekommen dieselbe.'), false)
      : await askPassphrase(t('Ordner „{folder}“ verschlüsseln', { folder }), <>{LOSS_WARNING} {t('Alle Notizen darin bekommen dieselbe Passphrase, neue werden automatisch verschlüsselt.')}</>, true);
    if (!passphrase) return false;
    if ((await checkFolderPassphrase(mountId, folder, passphrase)) === false) throw new Error(t('Passphrase falsch – sie passt nicht zu den schon verschlüsselten Notizen des Ordners.'));
  }
  // Mark first: from now on the server refuses plaintext in this folder (also for new notes).
  if (!already) await api.setFolderEncrypted(mountId, folder, true);
  remember(mountId, folder, passphrase);
  let done = 0;
  for (let round = 0; round < 3; round++) {
    const plain = (await api.encryptedNotes(mountId, folder)).filter((n) => !n.encrypted);
    if (!plain.length) return true;
    for (const n of plain) {
      try {
        await encryptNote(mountId, n.path, passphrase);
      } catch (e) {
        throw new Error(t('{path}: {error} – „Ordner fertig verschlüsseln“ im Menü des Ordners setzt fort.', { path: n.path, error: errorText(e) }));
      }
      onProgress(++done, done + plain.length);
    }
  }
  const left = (await api.encryptedNotes(mountId, folder)).filter((n) => !n.encrypted);
  if (left.length) throw new Error(t('Noch unverschlüsselt: {paths} – „Ordner fertig verschlüsseln“ im Menü des Ordners setzt fort.', { paths: left.map((n) => n.path).join(', ') }));
  return true;
}

/** Encrypts a plain note lying in an encrypted folder with the folder's passphrase (asked and checked if needed). */
export async function encryptIntoFolder(mountId: string, folder: string, path: string, content?: string): Promise<boolean> {
  let passphrase = passphraseFor(mountId, folder);
  if (!passphrase) {
    passphrase = await askPassphrase(t('Notiz im Ordner „{folder}“ verschlüsseln', { folder }), t('Die Passphrase des Ordners.'), false);
    if (!passphrase) return false;
    const ok = await checkFolderPassphrase(mountId, folder, passphrase);
    if (ok === false) throw new Error(t('Passphrase falsch.'));
    if (ok === null && (await askPassphrase(t('Passphrase wiederholen'), t('Im Ordner gibt es noch nichts, woran sie sich prüfen ließe.'), false)) !== passphrase) {
      throw new Error(t('Die beiden Eingaben unterscheiden sich.'));
    }
    remember(mountId, folder, passphrase);
  }
  return encryptNote(mountId, path, passphrase, content);
}


/** Removes the encryption of a whole folder: checks the passphrase, lifts the mark, then decrypts every note. */
export async function decryptFolder(mountId: string, folder: string, onProgress: (done: number, total: number) => void): Promise<boolean> {
  const passphrase = passphraseFor(mountId, folder) ?? (await askPassphrase(t('Verschlüsselung von „{folder}“ aufheben', { folder }), t('Alle Notizen darin werden wieder im Klartext gespeichert.'), false));
  if (!passphrase) return false;
  if ((await checkFolderPassphrase(mountId, folder, passphrase)) === false) throw new Error(t('Passphrase falsch.'));
  // Unmark first: plain notes (and their plain attachments) are only accepted outside an encrypted folder.
  await api.setFolderEncrypted(mountId, folder, false);
  const notes = (await api.encryptedNotes(mountId, folder)).filter((n) => n.encrypted);
  let done = 0;
  for (const n of notes) {
    try {
      await unsealAndSave(mountId, n.path, passphrase);
    } catch (e) {
      throw new Error(t('{path}: {error} – die übrigen Notizen bleiben verschlüsselt und lassen sich einzeln entschlüsseln.', { path: n.path, error: errorText(e) }));
    }
    onProgress(++done, notes.length);
  }
  return true;
}

// Decrypted images live as object URLs in this page only: freed when locking.
const fileUrls = new Set<string>();
onLock(() => {
  for (const u of fileUrls) URL.revokeObjectURL(u);
  fileUrls.clear();
});

/** Object URL of a decrypted `.age` file (images in encrypted notes), or null without passphrase. */
export async function decryptedFileUrl(mountId: string, notePath: string, filePath: string): Promise<string | null> {
  const passphrase = passphraseFor(mountId, notePath);
  if (!passphrase) return null;
  const data = await fileBytes(mountId, filePath);
  if (!data) return null;
  const plain = await decryptBytes(passphrase, data);
  const inner = filePath.replace(/\.age$/, '');
  const type = IMAGE_EXT.test(inner) ? (inner.endsWith('.svg') ? 'image/svg+xml' : `image/${inner.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg')}`) : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([plain as BlobPart], { type }));
  fileUrls.add(url);
  return url;
}

export function EncryptedBadge() {
  return (
    <span className="flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-[0.6875rem] text-fg" title={t('Verschlüsselt (age)')}>
      <ShieldAlert className="h-3 w-3" /> {t('verschlüsselt')}
    </span>
  );
}
