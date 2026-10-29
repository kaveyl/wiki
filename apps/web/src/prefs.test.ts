// Loading the stored preferences (code-001): a failed request is not "nothing stored" – the defaults must never be
// written over what the server has; only a stored null (never saved) starts from the defaults.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  // applyFontScale sets CSS variables on <html>; Node has no document.
  (globalThis as { document?: unknown }).document ??= { documentElement: { lang: '', style: { setProperty() {}, removeProperty() {} } } };
  return { getState: vi.fn(), putState: vi.fn(async () => ({ ok: true })) };
});
vi.mock('./api', () => ({ api }));

import { usePrefs } from './prefs';
import { lang } from './i18n';

const SAVED = { editorWidth: 'wide', showToc: false, collapsedSections: ['recent'], autoLockMin: 5, hideWelcome: true, language: lang };

beforeEach(() => {
  vi.useFakeTimers();
  api.getState.mockReset();
  api.putState.mockClear();
  usePrefs.setState({ loaded: false });
});
afterEach(() => vi.useRealTimers());

describe('usePrefs.load', () => {
  it('writes nothing after a failed load, also not on a change, and loads again later', async () => {
    api.getState.mockRejectedValueOnce(new Error('Server nicht erreichbar')).mockResolvedValue(SAVED);
    await usePrefs.getState().load();
    expect(usePrefs.getState().loaded).toBe(false);
    usePrefs.getState().set({ showToc: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.putState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(usePrefs.getState()).toMatchObject({ ...SAVED, loaded: true });
    expect(api.putState).not.toHaveBeenCalled();
  });

  it('keeps the stored preferences of the account when saving at once before they arrived', async () => {
    api.getState.mockRejectedValue(new Error('Server nicht erreichbar'));
    await usePrefs.getState().load();
    await expect(usePrefs.getState().saveNow({ language: lang })).rejects.toThrow();
    expect(api.putState).not.toHaveBeenCalled();
  });

  it('starts from the defaults when nothing was ever stored, and stores the language', async () => {
    api.getState.mockResolvedValue(null);
    await usePrefs.getState().load();
    expect(usePrefs.getState()).toMatchObject({ editorWidth: 'normal', showToc: true, autoLockMin: 15, loaded: true });
    expect(api.putState).toHaveBeenCalledWith('prefs', expect.objectContaining({ language: lang, autoLockMin: 15 }));
  });
});
