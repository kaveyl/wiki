// Who has a note open / is typing in it right now ("Maria bearbeitet gerade", Phase 4).
// In memory only: heartbeats from the browser, entries expire, changes go out as events.
import type { EventBus } from './events.js';

export interface PresenceUser {
  id: string;
  name: string;
  editing: boolean;
}

const TTL_MS = 45_000;

export class Presence {
  private readonly notes = new Map<string, Map<string, PresenceUser & { at: number }>>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly events: EventBus) {
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref?.();
  }

  /** Records a heartbeat (or leaving, with `open: false`) and returns everyone on the note. */
  beat(mountId: string, path: string, user: { id: string; name: string }, open: boolean, editing: boolean): PresenceUser[] {
    const key = `${mountId}\0${path}`;
    const users = this.notes.get(key) ?? new Map<string, PresenceUser & { at: number }>();
    const before = this.snapshot(users);
    if (open) users.set(user.id, { id: user.id, name: user.name, editing, at: Date.now() });
    else users.delete(user.id);
    if (users.size) this.notes.set(key, users);
    else this.notes.delete(key);
    if (this.snapshot(users) !== before) this.emit(mountId, path, users);
    return this.list(mountId, path);
  }

  list(mountId: string, path: string): PresenceUser[] {
    return [...(this.notes.get(`${mountId}\0${path}`)?.values() ?? [])].map(({ id, name, editing }) => ({ id, name, editing }));
  }

  stop() {
    clearInterval(this.timer);
  }

  private sweep() {
    const now = Date.now();
    for (const [key, users] of this.notes) {
      const before = this.snapshot(users);
      for (const [id, u] of users) if (now - u.at > TTL_MS) users.delete(id);
      if (this.snapshot(users) === before) continue;
      const [mountId, path] = key.split('\0') as [string, string];
      if (!users.size) this.notes.delete(key);
      this.emit(mountId, path, users);
    }
  }

  private snapshot(users: Map<string, PresenceUser>) {
    return JSON.stringify([...users.values()].map((u) => [u.id, u.editing]).sort());
  }

  private emit(mountId: string, path: string, users: Map<string, PresenceUser>) {
    this.events.emit({ type: 'presence', mountId, path, users: [...users.values()].map(({ id, name, editing }) => ({ id, name, editing })) });
  }
}
