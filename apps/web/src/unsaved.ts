// Open editors report changes that are not on the server yet, so an ended session does not throw them away (code-012).
// Only which notes are unsaved is kept here – never their content (no storage either: encrypted notes).
import { createContext } from 'react';
import { create } from 'zustand';

interface Unsaved {
  /** Editor id → note key (`mountId:path`) of every editor with changes not saved yet. */
  notes: Record<string, string>;
  /** The user chose to sign out without them: the login may replace the workspace. */
  discarded: boolean;
}

export const useUnsaved = create<Unsaved>(() => ({ notes: {}, discarded: false }));

const savers = new Map<string, () => Promise<unknown>>();
const texts = new Map<string, () => string>();

/**
 * `note` = the editor's note while it has unsaved changes, null once saved or closed; `save` saves it now;
 * `text` = its current text (only read when the user copies it out, never kept).
 */
export function setUnsaved(id: string, note: string | null, save?: () => Promise<unknown>, text?: () => string): void {
  const { notes } = useUnsaved.getState();
  if (note === null) {
    savers.delete(id);
    texts.delete(id);
    if (!(id in notes)) return;
    const rest = { ...notes };
    delete rest[id];
    useUnsaved.setState({ notes: rest });
    return;
  }
  if (save) savers.set(id, save);
  if (text) texts.set(id, text);
  if (notes[id] !== note) useUnsaved.setState({ notes: { ...notes, [id]: note } });
}

/** Number of notes (a note open twice counts once). */
export const countUnsaved = (notes: Record<string, string>) => new Set(Object.values(notes)).size;

/** Saves every editor with unsaved changes; one failing does not stop the others. */
export async function saveAllUnsaved(): Promise<void> {
  await Promise.allSettled([...savers.values()].map((save) => save()));
}

export interface UnsavedNote {
  note: string;
  text: string;
}

/**
 * The text of every editor with unsaved changes, read now – a part of the app that fails keeps it in memory before
 * its editors are gone (code-004). An editor whose text cannot be read is left out.
 */
export function unsavedSnapshot(): UnsavedNote[] {
  const { notes } = useUnsaved.getState();
  return Object.entries(notes).flatMap(([id, note]) => {
    const text = texts.get(id);
    if (!text) return [];
    try {
      return [{ note, text: text() }];
    } catch {
      return [];
    }
  });
}

/** Notes, each under its path – to copy them out when they cannot be saved here. */
export function formatUnsaved(list: UnsavedNote[]): string {
  return list.map(({ note, text }) => `<!-- ${note.slice(note.indexOf(':') + 1)} -->\n${text.endsWith('\n') ? text : `${text}\n`}`).join('\n\n');
}

/** The text of every unsaved note, each under its path – to copy it out when it cannot be saved here. */
export const unsavedText = (): string => formatUnsaved(unsavedSnapshot());

export function discardUnsaved(): void {
  useUnsaved.setState({ discarded: true });
}

/**
 * What the app shows: the workspace; the workspace under the „signed out“ hint (`hold`), under the „another account
 * signed in“ hint (`other`) or with the „server not reachable“ bar (`offline`); the error page; or the login.
 * The workspace stays only when it was open – unmounting it would lose what the editors hold.
 */
export function sessionScreen(s: {
  /** The session could not be asked (server not reachable). */
  error?: boolean;
  signedIn: boolean;
  /** Signed in, but not the account whose workspace is open. */
  otherUser?: boolean;
  shellShown: boolean;
  unsaved: number;
  discarded: boolean;
}): 'shell' | 'hold' | 'other' | 'offline' | 'error' | 'login' {
  const keep = s.shellShown && s.unsaved > 0 && !s.discarded;
  if (s.error) return keep ? 'offline' : 'error';
  if (s.signedIn) return s.otherUser && keep ? 'other' : 'shell';
  return keep ? 'hold' : 'login';
}

/** The account whose workspace is open: its editors write only under its session (code-012). */
export const WorkspaceUser = createContext<string | null>(null);

/**
 * Whether an editor opened by `owner` may send its changes now: the known session (`cached`) must be that account;
 * otherwise the server is asked again (`fresh`) – signed out or another account (signed in meanwhile in another tab,
 * the cookie is shared) and nothing is sent. Requests carry no account, so this is decided before sending.
 */
export async function mayWriteAs(
  owner: string | null,
  cached: string | null | undefined,
  fresh: () => Promise<string | null | undefined>,
): Promise<'ok' | 'signedOut' | 'other'> {
  if (owner === null || cached === owner) return 'ok';
  let now: string | null | undefined;
  try {
    now = await fresh();
  } catch {
    now = cached;
  }
  if (now === owner) return 'ok';
  return now ? 'other' : 'signedOut';
}
