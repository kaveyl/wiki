// The open note is asked for while the editor code still loads (seo-001): NoteView takes that request over once –
// never a stale one (changed meanwhile, too old) and never one of the previous account.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A plain function, not vi.fn(): a spy watches the promises it returns, which would hide an unhandled rejection.
const mocks = vi.hoisted(() => ({
  asked: [] as [string, string][],
  answer: (_mountId: string, _path: string): Promise<unknown> => Promise.resolve(null),
  api: {
    note: (mountId: string, path: string) => {
      mocks.asked.push([mountId, path]);
      return mocks.answer(mountId, path);
    },
  },
  listeners: new Set<(e: { type: 'note'; mountId: string; path: string; hash: string | null }) => void>(),
}));
vi.mock('./api', () => ({ api: mocks.api }));
vi.mock('./events', () => ({
  onNoteEvent: (fn: (e: { type: 'note'; mountId: string; path: string; hash: string | null }) => void) => {
    mocks.listeners.add(fn);
    return () => mocks.listeners.delete(fn);
  },
}));

import { dropPrefetchedNotes, prefetchNote, takeNote } from './notePrefetch';

const doc = (n: number) => ({ title: `Notiz ${n}` });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.asked.length = 0;
  mocks.answer = async () => doc(mocks.asked.length);
});
afterEach(() => {
  dropPrefetchedNotes();
  vi.useRealTimers();
});

describe('prefetchNote / takeNote', () => {
  it('NoteView gets the request started before, without asking again – and only once', async () => {
    prefetchNote('m', 'a/Notiz.md');
    prefetchNote('m', 'a/Notiz.md'); // shell: from the address, then as the active tab
    expect(mocks.asked).toHaveLength(1);
    expect(mocks.asked[0]).toEqual(['m', 'a/Notiz.md']);
    await expect(takeNote('m', 'a/Notiz.md')).resolves.toEqual(doc(1));
    expect(mocks.asked).toHaveLength(1);
    // Reloading (refetch) asks the server again.
    await expect(takeNote('m', 'a/Notiz.md')).resolves.toEqual(doc(2));
    expect(mocks.asked).toHaveLength(2);
  });

  it('without a prefetch, or for another note, NoteView asks as before', async () => {
    prefetchNote('m', 'a.md');
    await expect(takeNote('m', 'b.md')).resolves.toEqual(doc(2));
    await expect(takeNote('other', 'a.md')).resolves.toEqual(doc(3));
    expect(mocks.asked.at(-1)).toEqual(['other', 'a.md']);
  });

  it('a request not taken in time is not used', async () => {
    prefetchNote('m', 'a.md');
    vi.advanceTimersByTime(16_000);
    await expect(takeNote('m', 'a.md')).resolves.toEqual(doc(2));
  });

  it('a note changed meanwhile is asked for anew', async () => {
    prefetchNote('m', 'a.md');
    prefetchNote('m', 'b.md');
    for (const fn of mocks.listeners) fn({ type: 'note', mountId: 'm', path: 'a.md', hash: 'neu' });
    await expect(takeNote('m', 'a.md')).resolves.toEqual(doc(3));
    await expect(takeNote('m', 'b.md')).resolves.toEqual(doc(2));
  });

  it('nothing is left for the next account when the shell closes', async () => {
    prefetchNote('m', 'a.md');
    dropPrefetchedNotes();
    expect(mocks.listeners.size).toBe(0);
    await expect(takeNote('m', 'a.md')).resolves.toEqual(doc(2));
  });

  it('a failed prefetch is reported to NoteView, not as an unhandled rejection', async () => {
    const failure = new Error('nicht gefunden');
    mocks.answer = () => Promise.reject(failure);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.useRealTimers();
    try {
      prefetchNote('m', 'weg.md');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(takeNote('m', 'weg.md')).rejects.toBe(failure);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
