// Irreversible deletes ask first, like every other delete (design-002): purge from the trash, delete an
// API token (own or, for admins, someone's), delete a group or an AI chat, delete an account or a connection.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(import.meta.dirname);
// Renewing ends the old value at once: asked first too (audit 28.10.).
const RENEW = /\bapi\.(renewToken|renewTokenOf)\(/;
const IRREVERSIBLE = /\bapi\.(purgeFromTrash|revokeToken|deleteTokenOf|deleteGroup|deleteAiChat|deleteUser|deleteConnection)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'api.ts' ? [p] : [];
  });
}

describe('irreversible deletes (design-002)', () => {
  it('go through confirmDialog({ danger: true }) shortly before the call', () => {
    const calls = sources(src).flatMap((f) => {
      const lines = readFileSync(f, 'utf8').split('\n');
      return lines.flatMap((line, i) => (IRREVERSIBLE.test(line) ? [{ at: `${relative(src, f)}:${i + 1}`, before: lines.slice(Math.max(0, i - 12), i + 1).join('\n') }] : []));
    });
    expect(calls.length).toBeGreaterThanOrEqual(6);
    const unasked = calls.filter((c) => !/confirmDialog\(/.test(c.before) || !/danger: true/.test(c.before)).map((c) => c.at);
    expect(unasked).toEqual([]);
  });

  it('renewing a token asks first (the old value stops at once)', () => {
    const files = sources(src).map((f) => readFileSync(f, 'utf8'));
    const renewing = files.filter((text) => RENEW.test(text));
    expect(renewing.length).toBeGreaterThan(0);
    for (const text of renewing) expect(text).toMatch(/askRenew\(/);
  });
});
