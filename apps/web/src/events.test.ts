// What the live connection asks for again once it is open (seo-004): after a reconnect everything (changes were
// missed); the first time only what live events keep current – the rest was just loaded and no event refreshes it.
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { refreshAfterOpen } from './events';

const KEYS = [['session'], ['ai-rules'], ['tag-colors'], ['tree', 'm1'], ['backlinks', 'm1', 'a.md'], ['status'], ['mounts'], ['note', 'm1', 'a.md']];
const LIVE = ['tree', 'backlinks', 'status', 'mounts', 'note'];

const loaded = () => {
  const qc = new QueryClient();
  for (const key of KEYS) qc.setQueryData(key, { loaded: true });
  return qc;
};
const invalidated = (qc: QueryClient) => KEYS.filter((key) => qc.getQueryState(key)?.isInvalidated).map((key) => key[0]);

describe('refreshAfterOpen', () => {
  it('first open: only what live events keep current is asked for again (changed between loading and connecting)', () => {
    const qc = loaded();
    refreshAfterOpen(qc, false);
    expect(invalidated(qc)).toEqual(LIVE);
  });

  it('reconnect: everything is asked for again – changes were missed while disconnected', () => {
    const qc = loaded();
    refreshAfterOpen(qc, true);
    expect(invalidated(qc)).toEqual(KEYS.map((key) => key[0]));
  });
});
