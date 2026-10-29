import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countUnsaved, discardUnsaved, mayWriteAs, saveAllUnsaved, sessionScreen, setUnsaved, unsavedText, useUnsaved } from './unsaved';

const count = () => countUnsaved(useUnsaved.getState().notes);

beforeEach(() => {
  useUnsaved.setState({ notes: {}, discarded: false });
});

describe('unsaved changes', () => {
  it('counts notes, not editors (the same note twice counts once)', () => {
    setUnsaved('e1', 'm:a.md', async () => undefined);
    setUnsaved('e2', 'm:b.md', async () => undefined);
    setUnsaved('e3', 'm:a.md', async () => undefined);
    expect(count()).toBe(2);
  });

  it('forgets an editor once it is saved or closed', () => {
    setUnsaved('e1', 'm:a.md', async () => undefined);
    setUnsaved('e2', 'm:b.md', async () => undefined);
    setUnsaved('e1', null);
    expect(count()).toBe(1);
    setUnsaved('e2', null);
    expect(count()).toBe(0);
    // Forgetting twice changes nothing.
    setUnsaved('e2', null);
    expect(count()).toBe(0);
  });

  it('saves every editor with unsaved changes, also when one fails', async () => {
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => {
      throw new Error('401');
    });
    const done = vi.fn(async () => undefined);
    setUnsaved('e1', 'm:a.md', a);
    setUnsaved('e2', 'm:b.md', b);
    setUnsaved('e3', 'm:c.md', done);
    setUnsaved('e3', null);
    await saveAllUnsaved();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
  });

  it('uses the latest save function of an editor', async () => {
    const old = vi.fn(async () => undefined);
    const now = vi.fn(async () => undefined);
    setUnsaved('e1', 'm:a.md', old);
    setUnsaved('e1', 'm:a.md', now);
    await saveAllUnsaved();
    expect(old).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledOnce();
  });

  it('copies the text of every unsaved note, each under its path (another account signed in: take it out by hand)', () => {
    setUnsaved('e1', 'm:docs/a.md', async () => undefined, () => '# A\n');
    setUnsaved('e2', 'm:b.md', async () => undefined, () => 'Bee');
    setUnsaved('e3', 'm:c.md', async () => undefined, () => 'saved');
    setUnsaved('e3', null);
    expect(unsavedText()).toBe('<!-- docs/a.md -->\n# A\n\n\n<!-- b.md -->\nBee\n');
  });

  it('remembers a deliberate discard', () => {
    discardUnsaved();
    expect(useUnsaved.getState().discarded).toBe(true);
  });
});

describe('sessionScreen', () => {
  it('signed in: the workspace', () => {
    expect(sessionScreen({ signedIn: true, shellShown: true, unsaved: 3, discarded: false })).toBe('shell');
    expect(sessionScreen({ signedIn: true, shellShown: false, unsaved: 0, discarded: false })).toBe('shell');
  });

  it('session gone with unsaved notes in the open workspace: keep it, show the hint', () => {
    expect(sessionScreen({ signedIn: false, shellShown: true, unsaved: 1, discarded: false })).toBe('hold');
  });

  it('session gone and nothing unsaved: the login, as before', () => {
    expect(sessionScreen({ signedIn: false, shellShown: true, unsaved: 0, discarded: false })).toBe('login');
  });

  it('session gone and the changes discarded: the login', () => {
    expect(sessionScreen({ signedIn: false, shellShown: true, unsaved: 2, discarded: true })).toBe('login');
  });

  it('no workspace was open (fresh page load): the login', () => {
    expect(sessionScreen({ signedIn: false, shellShown: false, unsaved: 2, discarded: false })).toBe('login');
  });
});

describe('sessionScreen: another account, server gone (code-012)', () => {
  it('another account signed in while the workspace holds unsaved notes: keep it, show the hint', () => {
    expect(sessionScreen({ signedIn: true, otherUser: true, shellShown: true, unsaved: 1, discarded: false })).toBe('other');
  });

  it('another account and nothing unsaved, or the changes discarded: its own workspace', () => {
    expect(sessionScreen({ signedIn: true, otherUser: true, shellShown: true, unsaved: 0, discarded: false })).toBe('shell');
    expect(sessionScreen({ signedIn: true, otherUser: true, shellShown: true, unsaved: 2, discarded: true })).toBe('shell');
  });

  it('server not reachable with unsaved notes in the open workspace: keep it (the editors save once it is back)', () => {
    expect(sessionScreen({ error: true, signedIn: true, shellShown: true, unsaved: 1, discarded: false })).toBe('offline');
    expect(sessionScreen({ error: true, signedIn: false, shellShown: true, unsaved: 1, discarded: false })).toBe('offline');
  });

  it('server not reachable and nothing to lose: the error page, as before', () => {
    expect(sessionScreen({ error: true, signedIn: true, shellShown: true, unsaved: 0, discarded: false })).toBe('error');
    expect(sessionScreen({ error: true, signedIn: false, shellShown: false, unsaved: 1, discarded: false })).toBe('error');
    expect(sessionScreen({ error: true, signedIn: true, shellShown: true, unsaved: 1, discarded: true })).toBe('error');
  });
});

describe('mayWriteAs: an editor writes only under the account it was opened with (code-012)', () => {
  const never = vi.fn(async () => {
    throw new Error('not asked');
  });
  beforeEach(() => {
    never.mockClear();
  });

  it('the known session is that account: yes, without asking the server', async () => {
    expect(await mayWriteAs('u1', 'u1', never)).toBe('ok');
    expect(never).not.toHaveBeenCalled();
  });

  it('the known session is gone or someone else: asks the server again before deciding', async () => {
    expect(await mayWriteAs('u1', null, async () => 'u1')).toBe('ok');
    expect(await mayWriteAs('u1', 'u2', async () => 'u1')).toBe('ok');
    expect(await mayWriteAs('u1', null, async () => null)).toBe('signedOut');
    expect(await mayWriteAs('u1', null, async () => 'u2')).toBe('other');
    expect(await mayWriteAs('u1', 'u2', async () => 'u2')).toBe('other');
  });

  it('the server cannot tell: nothing is sent', async () => {
    expect(await mayWriteAs('u1', null, never)).toBe('signedOut');
    expect(await mayWriteAs('u1', 'u2', never)).toBe('other');
  });

  it('no account known (an editor outside the workspace): as before', async () => {
    expect(await mayWriteAs(null, null, never)).toBe('ok');
  });
});
