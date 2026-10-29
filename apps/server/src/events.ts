// In-process event bus; the WebSocket route forwards these events to connected clients.
import { EventEmitter } from 'node:events';
import type { IndexChange } from './index/indexer.js';
import type { Mount } from './mounts/model.js';

export type AppEvent =
  | { type: 'tree'; mountId: string; change: IndexChange }
  | { type: 'note'; mountId: string; path: string; hash: string | null }
  | { type: 'mount'; mount: Mount }
  | { type: 'mount-removed'; mountId: string }
  | { type: 'presence'; mountId: string; path: string; users: { id: string; name: string; editing: boolean }[] }
  /** Something new in what one person follows (AD-066) – only to that person's connections. */
  | { type: 'unread'; userId: string };

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: AppEvent) {
    this.emitter.emit('event', event);
  }

  on(listener: (event: AppEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
