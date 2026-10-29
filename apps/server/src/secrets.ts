// Encrypted storage for credentials (e.g. Gitea tokens per mount) in the `secrets` table.
// AES-256-GCM with a key from KAVEYL_WIKI_SECRET_KEY or, if unset, <config>/secret.key
// (generated on first start with mode 600). Values are never returned to the frontend.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { DB } from './db/db.js';

export class SecretStore {
  constructor(
    private readonly db: DB,
    private readonly key: Buffer,
  ) {}

  static open(db: DB, configPath: string, envKey = process.env.KAVEYL_WIKI_SECRET_KEY): SecretStore {
    if (envKey) {
      const key = Buffer.from(envKey, 'base64');
      if (key.length !== 32) throw new Error('KAVEYL_WIKI_SECRET_KEY must be 32 bytes, base64-encoded');
      return new SecretStore(db, key);
    }
    mkdirSync(configPath, { recursive: true });
    const file = join(configPath, 'secret.key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    return new SecretStore(db, Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
  }

  put(value: string, id: string = ulid()): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const enc = [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
    this.db.prepare('INSERT INTO secrets (id, value_enc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value_enc = excluded.value_enc').run(id, enc);
    return id;
  }

  get(id: string): string | null {
    const row = this.db.prepare('SELECT value_enc FROM secrets WHERE id = ?').get(id) as { value_enc: string } | undefined;
    if (!row) return null;
    const [iv, tag, data] = row.value_enc.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
  }

  /** The key itself (base64) — only for the database backup onto an encrypted target (AD-038). */
  keyBase64(): string {
    return this.key.toString('base64');
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
  }
}
