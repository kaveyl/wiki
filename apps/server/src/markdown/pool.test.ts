import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownPool, PARSE_LIMIT } from './pool.js';

// The real worker, bundled like in the image (package.json „build“), with a short time limit (sec-006).
let dir: string;
let pool: MarkdownPool;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-mdpool-'));
  await build({
    entryPoints: [join(__dirname, 'worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: join(dir, 'w.mjs'),
    logLevel: 'silent',
    banner: { js: "import { createRequire as __kaveylCreateRequire } from 'node:module'; const require = __kaveylCreateRequire(import.meta.url);" },
  });
  pool = new MarkdownPool({ worker: join(dir, 'w.mjs'), size: 2, timeoutMs: 1500 });
}, 60_000);

afterAll(async () => {
  await pool.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Markdown in the worker with a time limit', () => {
  it('parses ordinary notes like the core functions', async () => {
    const raw = '---\ntags: [a]\n---\n# Titel\n\n![Bild](assets/b.png) und [Notiz](andere.md).\n';
    expect((await pool.links(raw))!.map((l) => l.href)).toEqual(['assets/b.png', 'andere.md']);
    const doc = await pool.doc(raw);
    expect(doc!.content![0]).toMatchObject({ type: 'heading' });
    const para = structuredClone(doc!);
    para.content![1]!.content!.push({ type: 'text', text: ' Mehr.' });
    expect(await pool.save(raw, para)).toContain('[Notiz](andere.md). Mehr.');
    expect((await pool.tree('# A'))!.children[0]).toMatchObject({ type: 'heading' });
  });

  it('gives up on what the parser cannot do quickly – and keeps answering everything else meanwhile', async () => {
    // Nested lists: quadratic in micromark (64 KB ≈ 12 s), far over the limit here.
    const slow = '1. 1. a\n'.repeat(8000);
    const started = Date.now();
    const [stuck, quick] = await Promise.all([pool.links(slow), pool.links('[x](y.md)')]);
    expect(quick!.map((l) => l.href)).toEqual(['y.md']);
    expect(stuck).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    // The same text is not tried again; the worker after it works.
    const again = Date.now();
    expect(await pool.links(slow)).toBeNull();
    expect(Date.now() - again).toBeLessThan(200);
    expect((await pool.links('[z](z.md)'))!.map((l) => l.href)).toEqual(['z.md']);
  }, 20_000);

  it('a child that dies on its very first job stays a child – no falling back to the server process (sec-001 0.2.7)', async () => {
    const fresh = new MarkdownPool({ worker: join(dir, 'w.mjs'), size: 1, timeoutMs: 1500, memoryMb: 64 });
    try {
      // Runs out of memory in a fresh child …
      expect(await fresh.links('> '.repeat(40_000))).toBeNull();
      // … and a slow note afterwards is still cut off after the time limit, not parsed for seconds in this process.
      const started = Date.now();
      expect(await fresh.links('1. 1. a\n'.repeat(8000))).toBeNull();
      expect(Date.now() - started).toBeLessThan(4000);
      expect((await fresh.links('[q](q.md)'))!.map((l) => l.href)).toEqual(['q.md']);
    } finally {
      await fresh.close();
    }
  }, 30_000);

  it('opening a note goes ahead of background work waiting in the queue (code-004 0.2.7)', async () => {
    const one = new MarkdownPool({ worker: join(dir, 'w.mjs'), size: 1, timeoutMs: 5000 });
    try {
      const order: string[] = [];
      const background = Array.from({ length: 20 }, (_, i) => one.links(`[n${i}](n${i}.md)\n`.repeat(3000)).then(() => order.push(`links${i}`)));
      const open = one.doc('# Offen\n').then(() => order.push('doc'));
      await Promise.all([...background, open]);
      expect(order.indexOf('doc')).toBeLessThan(3);
    } finally {
      await one.close();
    }
  }, 30_000);

  it('a worker that does not start is no reason to parse nothing: the jobs run in the process', async () => {
    const broken = new MarkdownPool({ worker: join(dir, 'fehlt.mjs'), timeoutMs: 1500 });
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      expect((await broken.links('[a](b.md)'))!.map((l) => l.href)).toEqual(['b.md']);
      expect((await broken.links('[c](d.md)'))!.map((l) => l.href)).toEqual(['d.md']);
    } finally {
      console.error = log;
      await broken.close();
    }
    expect(errors).toHaveLength(1);
  });

  it('a stack overflow from deep nesting and anything over 256 KB count as not parsed', async () => {
    expect(await pool.links('> '.repeat(20_000))).toBeNull();
    expect(await pool.doc('a'.repeat(PARSE_LIMIT + 1))).toBeNull();
    expect(await pool.links('[a](b.md)\n')).toHaveLength(1);
  }, 20_000);
});
