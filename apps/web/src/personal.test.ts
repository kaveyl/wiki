// Loading favorites and "Zuletzt" (code-001): after a failed request the lists are not empty but unknown – nothing
// may be written over the stored ones; the changes made meanwhile are merged once loading succeeds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getState: vi.fn(), putState: vi.fn(async () => ({ ok: true })) }));
vi.mock('./api', () => ({ api }));

import { present, usePersonal } from './personal';

const A = { mountId: 'm', path: 'a.md', title: 'A' };
const B = { mountId: 'm', path: 'b.md', title: 'B' };
const C = { mountId: 'm', path: 'c.md', title: 'C' };

beforeEach(() => {
  vi.useFakeTimers();
  api.getState.mockReset();
  api.putState.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('usePersonal.load', () => {
  it('writes nothing over the stored lists after a failed load and merges the changes once loading succeeds', async () => {
    api.getState.mockRejectedValueOnce(new Error('Server nicht erreichbar')).mockResolvedValue({ favorites: [A], recent: [B] });
    await usePersonal.getState().load();
    expect(usePersonal.getState().loaded).toBe(false);
    usePersonal.getState().toggleFavorite(C);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.putState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(usePersonal.getState()).toMatchObject({ favorites: [C, A], recent: [B], loaded: true });
    expect(api.putState).toHaveBeenCalledTimes(1);
    expect(api.putState).toHaveBeenCalledWith('personal', { favorites: [C, A], recent: [B] });
  });

  it('starts with empty lists when nothing was ever stored', async () => {
    api.getState.mockResolvedValue(null);
    await usePersonal.getState().load();
    expect(usePersonal.getState()).toMatchObject({ favorites: [], recent: [], loaded: true });
  });
});

describe('present (design-008)', () => {
  const D = { mountId: 'm', path: 'plan', title: 'plan', dir: true };
  const X = { mountId: 'weg', path: 'x.md', title: 'X' };
  const O = { mountId: 'o', path: 'o.md', title: 'O' };
  const trees: Record<string, { path: string }[] | undefined> = { m: [{ path: 'a.md' }, { path: 'plan' }], o: undefined };

  it('drops entries of a source no longer mounted and notes missing from the loaded tree of their source', () => {
    expect(present([A, B, D, X, O], ['m', 'o'], (id) => trees[id])).toEqual([A, D, O]);
  });

  it('keeps entries whose source tree is not loaded (nothing is known about them)', () => {
    expect(present([O], ['o'], () => undefined)).toEqual([O]);
  });
});
