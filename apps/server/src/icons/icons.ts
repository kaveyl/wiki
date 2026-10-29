// Custom note icons (uploaded images), global for all sources (AD-018): stored in the app DB, so
// the regular DB backup covers them. Notes reference them as `icon: custom:<id>`.
import { randomBytes } from 'node:crypto';
import type { DB } from '../db/db.js';
import { now } from '../db/db.js';

export const ICON_MAX_BYTES = 256 * 1024;

export class IconError extends Error {}

export interface IconInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdBy: string | null;
  createdAt: string;
}

/** Type from the content, never from the file name or the client's claim. */
export function sniffIcon(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  // SVG: text with an <svg> root (after optional BOM, XML declaration, comments, doctype).
  const head = data.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Display name from the upload's file name: no extension, no path, at most 60 characters. */
export function iconName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\u0000-\u001f]/g, '').trim();
  return (name || 'Icon').slice(0, 60);
}

interface Row {
  id: string;
  name: string;
  mime: string;
  size: number;
  created_by: string | null;
  created_at: string;
}

const info = (r: Row): IconInfo => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, createdBy: r.created_by, createdAt: r.created_at });

export class IconStore {
  constructor(private db: DB) {}

  list(): IconInfo[] {
    return (this.db.prepare('SELECT id, name, mime, length(data) AS size, created_by, created_at FROM icons ORDER BY name COLLATE NOCASE, created_at').all() as Row[]).map(info);
  }

  get(id: string): { mime: string; data: Buffer } | null {
    return (this.db.prepare('SELECT mime, data FROM icons WHERE id = ?').get(id) as { mime: string; data: Buffer } | undefined) ?? null;
  }

  add(fileName: string, data: Buffer, userId: string | null): IconInfo {
    if (!data.length) throw new IconError('Leere Datei');
    if (data.length > ICON_MAX_BYTES) throw new IconError(`Icons dürfen höchstens ${ICON_MAX_BYTES / 1024} KB groß sein`);
    const mime = sniffIcon(data);
    if (!mime) throw new IconError('Erlaubt sind PNG, WebP, JPEG, GIF und SVG');
    const id = randomBytes(6).toString('hex');
    this.db
      .prepare('INSERT INTO icons (id, name, mime, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, iconName(fileName), mime, data, userId, now());
    return this.list().find((i) => i.id === id)!;
  }

  owner(id: string): string | null | undefined {
    const row = this.db.prepare('SELECT created_by FROM icons WHERE id = ?').get(id) as { created_by: string | null } | undefined;
    return row ? row.created_by : undefined;
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM icons WHERE id = ?').run(id).changes > 0;
  }
}
