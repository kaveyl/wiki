// Whether the server can be reached – from the live connection (events.ts) and failing status queries (design-004).
import { create } from 'zustand';
import { ApiError } from './api';

/**
 * The live connection: `pending` until it was open once, `open`, or `lost` after it was open. One that never opened
 * stays `pending` – a proxy without WebSocket support says nothing about the server being reachable.
 */
export type Live = 'pending' | 'open' | 'lost';

export const useConnection = create<{ live: Live }>(() => ({ live: 'pending' }));

export const afterClose = (prev: Live): Live => (prev === 'pending' ? 'pending' : 'lost');

/** A request failed because the server (or the proxy in front of it) could not be reached – not because it refused. */
export function unreachable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 502 || err.status === 503 || err.status === 504;
  return err instanceof TypeError; // fetch: network error
}

/**
 * No connection to the server: the browser reports no network, the live connection dropped, or the last status query
 * found no server. Offline, React Query pauses the status query instead of failing it, and a live connection on a dead
 * network can look open for minutes – so the browser's own report counts first.
 */
export const connectionLost = (s: { live: Live; statusError: unknown; online?: boolean }): boolean =>
  s.online === false || s.live === 'lost' || unreachable(s.statusError);
