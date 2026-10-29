import { describe, expect, it } from 'vitest';
import { ChangeFeed } from './changes.js';

const ANNA = { name: 'Anna', email: 'a@x', userId: 'u-anna', via: 'mcp' as const };
const none = { added: [], updated: [], removed: [], renamed: [] };

describe('ChangeFeed', () => {
  it('records who changed what; a cursor gives what came after it', () => {
    const feed = new ChangeFeed();
    const start = feed.since(undefined, () => true);
    expect(start).toMatchObject({ reset: false, changes: [] });
    feed.record('m', { ...none, added: ['a.md'], renamed: [{ from: 'x.md', to: 'y.md' }] }, ANNA);
    feed.record('m', { ...none, updated: ['a.md'] }, null);
    const page = feed.since(start.cursor, () => true);
    expect(page.changes.map((c) => [c.path, c.kind, c.from ?? null, c.by?.name ?? null, c.via])).toEqual([
      ['a.md', 'created', null, 'Anna', 'mcp'],
      ['y.md', 'moved', 'x.md', 'Anna', 'mcp'],
      ['a.md', 'changed', null, null, 'extern'],
    ]);
    expect(feed.since(page.cursor, () => true).changes).toEqual([]);
  });

  it('a cursor of another start or one that fell out of the buffer says reset', () => {
    const feed = new ChangeFeed(2);
    const start = feed.since(undefined, () => true).cursor;
    for (const p of ['a.md', 'b.md', 'c.md']) feed.record('m', { ...none, updated: [p] }, null);
    expect(feed.since(start, () => true)).toMatchObject({ reset: true });
    expect(new ChangeFeed().since(start, () => true)).toMatchObject({ reset: true, changes: [] });
    expect(feed.since('kaputt', () => true).reset).toBe(true);
  });

  it('waits for the first matching change; ends at the timeout or when the client goes', async () => {
    const feed = new ChangeFeed();
    const start = feed.since(undefined, () => true).cursor;
    const waiting = feed.wait(start, (c) => c.path === 'b.md', 2000);
    feed.record('m', { ...none, updated: ['a.md'] }, null);
    setTimeout(() => feed.record('m', { ...none, updated: ['b.md'] }, null), 20);
    expect((await waiting).changes.map((c) => c.path)).toEqual(['b.md']);
    const t0 = Date.now();
    expect((await feed.wait(feed.cursor(), () => true, 50)).changes).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    const gone = new AbortController();
    setTimeout(() => gone.abort(), 10);
    expect((await feed.wait(feed.cursor(), () => true, 5000, gone.signal)).changes).toEqual([]);
  });
});
