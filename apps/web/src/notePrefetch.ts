// The open note's data is asked for while the editor code still loads (seo-001): the shell starts the request,
// NoteView takes it over once instead of asking again. Same API and checks as NoteView's own request; the query
// options in NoteView stay as they are (nothing is kept in the query cache longer).
import { api, type NoteDocument } from './api';
import { onNoteEvent } from './events';

/** A request not taken by then is dropped (the note opens later or not at all). */
const KEEP_MS = 15_000;

const pending = new Map<string, { at: number; data: Promise<NoteDocument> }>();
let unsubscribe: (() => void) | undefined;
const key = (mountId: string, path: string) => `${mountId}\n${path}`;

/** Starts loading a note that is about to be shown. */
export function prefetchNote(mountId: string, path: string) {
  const k = key(mountId, path);
  const known = pending.get(k);
  if (known && Date.now() - known.at < KEEP_MS) return;
  // Changed meanwhile (another tab, an external editor): the request may hold the old text – NoteView asks anew.
  unsubscribe ??= onNoteEvent((e) => pending.delete(key(e.mountId, e.path)));
  const data = api.note(mountId, path);
  data.catch(() => undefined); // reported by NoteView when taken
  pending.set(k, { at: Date.now(), data });
}

/** NoteView's request: the prefetched one if there is one (only once), else a new one. */
export function takeNote(mountId: string, path: string): Promise<NoteDocument> {
  const k = key(mountId, path);
  const known = pending.get(k);
  pending.delete(k);
  return known && Date.now() - known.at < KEEP_MS ? known.data : api.note(mountId, path);
}

/** Forgets every prefetched note (the shell closes, e.g. on logout): the next account never gets them. */
export function dropPrefetchedNotes() {
  pending.clear();
  unsubscribe?.();
  unsubscribe = undefined;
}
