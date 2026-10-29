// Instance settings (key → value in the database): admin choices such as the default access level or the proxy
// sign-in. Typed views of single keys live with their feature (e.g. readRules in cleanup.ts).
import type { DB } from './db/db.js';

export class Settings {
  constructor(private readonly db: DB) {}
  get(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  set(key: string, value: string) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  delete(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
