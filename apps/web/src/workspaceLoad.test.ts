// Restoring the workspace (code-001b): a failed load is not "nothing stored" – the empty workspace must not be
// written over the stored tabs; loading is retried and tabs opened meanwhile are kept next to the stored ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreWorkspace, useWorkspace, type SavedWorkspace } from './store';

const A = { id: 'a1', mountId: 'm', path: 'a.md', title: 'A' };
const B = { id: 'b1', mountId: 'm', path: 'b.md', title: 'B', pinned: true };
const stored: SavedWorkspace = { tabs: [A, B], activeId: 'a1', expanded: { 'm:': true }, sidebarWidth: 340 };

const load = vi.fn<() => Promise<SavedWorkspace | null>>();
const save = vi.fn(async (_state: unknown) => ({ ok: true }));
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  load.mockReset();
  save.mockClear();
  useWorkspace.getState().hydrate(null);
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe('restoreWorkspace', () => {
  it('writes nothing over the stored tabs after a failed load and keeps the tabs opened meanwhile', async () => {
    load.mockRejectedValueOnce(new Error('Server nicht erreichbar')).mockResolvedValue(stored);
    const ready = vi.fn();
    stop = restoreWorkspace(load, save, ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledTimes(1); // the note from the URL opens anyway
    expect(useWorkspace.getState().loaded).toBe(false);
    useWorkspace.getState().openNote('m', 'c.md', 'C');
    useWorkspace.getState().toggle('m:docs', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalledTimes(1);
    const s = useWorkspace.getState();
    expect(s.loaded).toBe(true);
    expect(s.tabs.map((t) => t.path)).toEqual(['b.md', 'a.md', 'c.md']); // pinned stays left
    expect(s.tabs.find((t) => t.id === s.activeId)?.path).toBe('c.md'); // what the user looks at stays active
    expect(s.expanded).toEqual({ 'm:': true, 'm:docs': true });
    expect(s.sidebarWidth).toBe(340);
    s.setSidebarWidth(300);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]![0] as SavedWorkspace).tabs!.map((t) => t.path)).toEqual(['b.md', 'a.md', 'c.md']);
  });

  it('starts empty when nothing was ever stored, and saves changes from then on', async () => {
    load.mockResolvedValue(null);
    stop = restoreWorkspace(load, save, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorkspace.getState()).toMatchObject({ tabs: [], loaded: true });
    useWorkspace.getState().openNote('m', 'c.md', 'C');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('restores the stored workspace as before when loading works', async () => {
    load.mockResolvedValue(stored);
    const ready = vi.fn(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
    stop = restoreWorkspace(load, save, ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState()).toMatchObject({ tabs: [A, B], activeId: 'a1', sidebarWidth: 340, loaded: true });
  });

  it('starts from scratch on a new account: nothing of the previous workspace is kept', async () => {
    useWorkspace.getState().openNote('m', 'old.md', 'Old');
    load.mockResolvedValue(stored);
    stop = restoreWorkspace(load, save, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorkspace.getState().tabs.map((t) => t.path)).toEqual(['a.md', 'b.md']);
  });

  it('stops retrying once stopped', async () => {
    load.mockRejectedValue(new Error('down'));
    stop = restoreWorkspace(load, save, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
