// Base image pinned by digest (AD-048, addendum to AD-041): both stages of the Dockerfile use the same
// tag@sha256 index digest, and scripts/base-image.sh update replaces exactly that digest.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const froms = (text) => [...text.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);

describe('base image (AD-048)', () => {
  it('both FROM lines of the Dockerfile pin the same tag by digest', () => {
    const refs = froms(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'));
    expect(refs).toHaveLength(2);
    for (const ref of refs) expect(ref).toMatch(/^node:\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/);
    expect(refs[1]).toBe(refs[0]);
  });

  it('base-image.sh update replaces the digest in both FROM lines and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-base-'));
    try {
      const file = join(dir, 'Dockerfile');
      const old = 'a'.repeat(64);
      const neu = 'b'.repeat(64);
      writeFileSync(file, `FROM node:24-bookworm-slim@sha256:${old} AS build\nRUN echo ${old}\nFROM node:24-bookworm-slim AS runtime\n`);
      execFileSync('sh', [join(ROOT, 'scripts/base-image.sh'), 'update', `sha256:${neu}`], { env: { ...process.env, DOCKERFILE: file }, stdio: 'pipe' });
      expect(readFileSync(file, 'utf8')).toBe(
        `FROM node:24-bookworm-slim@sha256:${neu} AS build\nRUN echo ${old}\nFROM node:24-bookworm-slim@sha256:${neu} AS runtime\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('base-image.sh update checks the whole value, not just its first line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-base-'));
    try {
      const file = join(dir, 'Dockerfile');
      const before = `FROM node:24-bookworm-slim@sha256:${'a'.repeat(64)} AS build\nFROM node:24-bookworm-slim AS runtime\n`;
      writeFileSync(file, before);
      const ok = `sha256:${'b'.repeat(64)}`;
      for (const bad of [`${ok}\nRUN x`, `${ok}\n`, `x${ok}`, `${ok}0`, `sha256:${'B'.repeat(64)}`, `sha256:${'b'.repeat(63)}`, `sha256:${'b'.repeat(63)}\n`]) {
        let res;
        try {
          execFileSync('sh', [join(ROOT, 'scripts/base-image.sh'), 'update', bad], { env: { ...process.env, DOCKERFILE: file }, stdio: 'pipe' });
        } catch (e) {
          res = e;
        }
        expect(res?.status, JSON.stringify(bad)).toBe(2);
        expect(String(res.stderr), JSON.stringify(bad)).toContain('kein Digest');
        expect(readFileSync(file, 'utf8')).toBe(before);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('base-image.sh refuses different tags in the two stages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-base-'));
    try {
      const file = join(dir, 'Dockerfile');
      writeFileSync(file, 'FROM node:24-bookworm-slim AS build\nFROM node:22-bookworm-slim AS runtime\n');
      expect(() =>
        execFileSync('sh', [join(ROOT, 'scripts/base-image.sh'), 'update', `sha256:${'c'.repeat(64)}`], { env: { ...process.env, DOCKERFILE: file }, stdio: 'pipe' }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
