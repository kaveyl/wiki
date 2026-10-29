// Live events from the server (WebSocket /api/events) with automatic reconnect.
// Tree changes invalidate the cached tree; note changes are forwarded to open editors.
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type Mount } from './api';
import { t } from './i18n';
import { toast } from './toast';
import { useWorkspace } from './store';
import { afterClose, useConnection } from './connection';

export type ServerEvent =
  | { type: 'tree'; mountId: string; change?: { renamed?: { from: string; to: string }[] } }
  | { type: 'note'; mountId: string; path: string; hash: string | null }
  | { type: 'mount'; mount: Mount }
  | { type: 'mount-removed'; mountId: string }
  | { type: 'presence'; mountId: string; path: string; users: PresenceUser[] }
  | { type: 'unread' };

export interface PresenceUser {
  id: string;
  name: string;
  editing: boolean;
}

type PresenceListener = (e: Extract<ServerEvent, { type: 'presence' }>) => void;
const presenceListeners = new Set<PresenceListener>();

export function onPresence(fn: PresenceListener): () => void {
  presenceListeners.add(fn);
  return () => presenceListeners.delete(fn);
}

type NoteListener = (e: Extract<ServerEvent, { type: 'note' }>) => void;
const noteListeners = new Set<NoteListener>();

export function onNoteEvent(fn: NoteListener): () => void {
  noteListeners.add(fn);
  return () => noteListeners.delete(fn);
}

/** What live events keep current (`onmessage`, NoteView's note listener). */
const LIVE_KEYS = new Set(['tree', 'backlinks', 'status', 'mounts', 'note']);

/**
 * Once the live connection is open (seo-004). Reconnected: anything may have changed while disconnected. First open:
 * only what an event would have refreshed – a change between loading and connecting sent no event; everything else
 * no event keeps current anyway, asking again would only repeat what was just loaded.
 */
export function refreshAfterOpen(qc: QueryClient, reconnect: boolean) {
  if (reconnect) void qc.invalidateQueries();
  else void qc.invalidateQueries({ predicate: (q) => LIVE_KEYS.has(String(q.queryKey[0])) });
}

export function useServerEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 500;
    let closed = false;
    let opened = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`);
      ws.onopen = () => {
        retry = 500;
        useConnection.setState({ live: 'open' });
        refreshAfterOpen(qc, opened);
        opened = true;
      };
      ws.onmessage = (msg) => {
        const e = JSON.parse(String(msg.data)) as ServerEvent;
        if (e.type === 'tree') {
          // Renamed outside the app (VS Code, git pull): open tabs follow the note.
          for (const r of e.change?.renamed ?? []) useWorkspace.getState().moved(e.mountId, r.from, r.to);
          void qc.invalidateQueries({ queryKey: ['tree', e.mountId] });
          void qc.invalidateQueries({ queryKey: ['backlinks', e.mountId] });
          void qc.invalidateQueries({ queryKey: ['status'] });
        } else if (e.type === 'mount' || e.type === 'mount-removed') {
          void qc.invalidateQueries({ queryKey: ['mounts'] });
          void qc.invalidateQueries({ queryKey: ['status'] });
          if (e.type === 'mount') notifySyncProblem(e.mount);
        }
        else if (e.type === 'note') for (const fn of noteListeners) fn(e);
        else if (e.type === 'presence') for (const fn of presenceListeners) fn(e);
        // „Beobachten“: something new (or read) in what one follows – the dots come anew.
        else if (e.type === 'unread') void qc.invalidateQueries({ queryKey: ['watches'] });
      };
      ws.onclose = (ev) => {
        if (closed) return;
        // 4401: the session ended (signed out in another tab, locked …). Ask for the login first – signed out, the
        // shell goes away (and with it this hook); signed in again (auth proxy), connect anew – not more than every 5 s.
        const ended = ev.code === 4401;
        // Shown in the sync indicator; an ended session is no lost server.
        if (!ended) useConnection.setState({ live: afterClose(useConnection.getState().live) });
        // Any other close may hide an ended session too: a reconnect without a session is refused before the upgrade
        // (the browser only sees 1006). Asked directly, so a server that is just gone leaves the session as it is.
        const ready = ended
          ? qc.refetchQueries({ queryKey: ['session'] })
          : api.session().then(
              (s) => {
                const known = qc.getQueryData<{ user: { id: string } | null }>(['session'])?.user;
                if (known && s.user?.id !== known.id) qc.setQueryData(['session'], s);
              },
              () => undefined,
            );
        void ready.finally(() => {
          if (closed) return;
          timer = setTimeout(connect, ended ? Math.max(retry, 5_000) : retry);
          retry = Math.min(retry * 2, 15_000);
        });
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
      useConnection.setState({ live: 'pending' });
    };
  }, [qc]);
}

const lastStatus = new Map<string, string | null>();

/** Toast once when a mount enters an error/conflict state (not on every repeated event). */
function notifySyncProblem(mount: Mount) {
  const prev = lastStatus.get(mount.id);
  lastStatus.set(mount.id, mount.syncStatus);
  if (prev === mount.syncStatus) return;
  if (mount.syncStatus === 'error') toast({ kind: 'error', title: t('Sync-Fehler: {name}', { name: mount.name }), text: mount.syncDetail ?? undefined });
  else if (mount.syncStatus === 'conflict')
    toast({ kind: 'warn', title: t('Konflikt: {name}', { name: mount.name }), text: t('Lokale Änderungen sind gesichert. Details in der Sync-Übersicht.') });
  else if (prev === 'error' || prev === 'conflict') toast({ kind: 'ok', title: t('{name} wieder synchron', { name: mount.name }) });
}
