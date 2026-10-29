// Live events to the browser over a WebSocket (/api/events): changes, presence, sync state – only what the
// account may see. Moved out of buildApp (code-002).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sessionCookie } from '../auth/session.js';
import type { AppContext } from './context.js';

export function registerLiveEvents(server: FastifyInstance, ctx: AppContext) {
  const { auth, canRead, events, isDirPath, mountFor, mountVisible } = ctx;
  // ── Live events ───────────────────────────────────────────────────────────────────
  /** Browsers always send Origin: only the own address (as the browser sees it, also behind a trusted proxy) may open it. */
  const ownOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (origin === undefined) return; // not a browser
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (!host || (host !== req.host && host !== req.headers.host)) return reply.code(403).send({ error: 'Origin nicht erlaubt' });
  };
  // Open live connections, each with its session check: run at once when sessions end, so a locked or signed-out
  // browser hears 4401 now – a later reconnect can't (refused with 401 before the upgrade, the browser sees 1006).
  const liveChecks = new Set<() => void>();
  auth.onSessionsEnded = () => {
    for (const check of liveChecks) check();
  };
  server.get('/api/events', { websocket: true, preValidation: ownOrigin }, (socket, req) => {
    // Only as long as its session (sec-005): signed out, locked, password reset or proxy session ended – checked before
    // every event, which also keeps the user's rights current. 4401 tells the app to check the login.
    const token = sessionCookie(req);
    const session = () => {
      const user = auth.userForSession(token);
      if (user && !user.mustChangePassword) return (req.user = user);
      socket.close(4401, 'session ended');
      return null;
    };
    if (!session()) return;
    const check = () => void session();
    liveChecks.add(check);
    socket.on('close', () => liveChecks.delete(check));
    // Every event only as far as this user may see it (AD-020).
    const off = events.on((event) => {
      if (!session()) return;
      let payload: unknown = event;
      try {
        if (event.type === 'mount') {
          if (!mountVisible(req, event.mount.id)) return;
          payload = { ...event, mount: mountFor(req, event.mount) };
        } else if (event.type === 'tree') {
          // Not even that a hidden source changed (team test 23.10.: a guest heard empty tree events).
          if (!mountVisible(req, event.mountId)) return;
          const ok = (p: string) => canRead(req, event.mountId, p, isDirPath(p));
          const c = event.change;
          // A rename only with both names readable; otherwise the user just sees the readable side go or come.
          const half = c.renamed.filter((r) => ok(r.from) !== ok(r.to));
          payload = {
            ...event,
            change: {
              added: [...c.added.filter(ok), ...half.filter((r) => ok(r.to)).map((r) => r.to)],
              updated: c.updated.filter(ok),
              removed: [...c.removed.filter(ok), ...half.filter((r) => ok(r.from)).map((r) => r.from)],
              renamed: c.renamed.filter((r) => ok(r.from) && ok(r.to)),
            },
          };
          // Nothing of it readable: nothing to tell (an empty change from the server itself still goes out).
          const seen = (payload as typeof event).change;
          const none = (x: typeof c) => !x.added.length && !x.updated.length && !x.removed.length && !x.renamed.length;
          if (none(seen) && !none(c)) return;
        } else if (event.type === 'note' || event.type === 'presence') {
          if (!canRead(req, event.mountId, event.path, false)) return;
        } else if (event.type === 'unread') {
          if (event.userId !== req.user?.id) return;
          payload = { type: 'unread' };
        }
      } catch {
        return;
      }
      socket.send(JSON.stringify(payload));
    });
    socket.on('close', off);
  });
}
