// Parts that load later or fail while rendering never leave a blank page (code-004): a failed load shows a message
// with „Neu laden“, a failed part keeps what its editors held so it can be copied out, and a failed loader tries again.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadingOnce, retryable } from './loading';
import { PartBoundary, lazyPart } from './lazyPart';
import { setUnsaved, useUnsaved } from './unsaved';
import { PartLoading } from './ui';

async function html(node: Parameters<typeof prerender>[0]): Promise<string> {
  const { prelude } = await prerender(node);
  return new Response(prelude).text();
}

describe('loaders try again after a failure', () => {
  it('keeps a result, but not a failure', async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('katex');
    const get = retryable(load);
    await expect(get()).rejects.toThrow('offline');
    await expect(get()).resolves.toBe('katex');
    await expect(get()).resolves.toBe('katex');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('a load that fails reloads the page once', () => {
  const store = new Map<string, string>();
  const reload = vi.fn();
  beforeEach(() => {
    store.clear();
    reload.mockClear();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    vi.stubGlobal('location', { reload });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reloads on the first failure, gives up on the second, and starts afresh after a success', async () => {
    let settled = false;
    void reloadingOnce('k', Promise.reject(new Error('gone'))).finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await expect(reloadingOnce('k', Promise.reject(new Error('gone')))).rejects.toThrow('gone');
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(reloadingOnce('k', Promise.resolve(1))).resolves.toBe(1);
    expect(store.has('k')).toBe(false);
  });

  it('never reloads in a loop when the browser keeps nothing', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    });
    await expect(reloadingOnce('k', Promise.reject(new Error('gone')))).rejects.toThrow('gone');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('lazy parts', () => {
  it('a part that cannot load shows the message with „Neu laden“ instead of throwing', async () => {
    const Part = lazyPart<{ name: string }>(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    const out = await html(createElement(Part, { name: 'x' }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('Dieser Teil der App konnte nicht geladen werden.');
    expect(out).toContain('Neu laden');
  });

  it('a part that loads shows itself; a given fallback replaces the standard message', async () => {
    const Part = lazyPart<{ name: string }>(async () => ({ name }) => createElement('p', null, `Hallo ${name}`));
    expect(await html(createElement(Part, { name: 'Welt' }))).toBe('<p>Hallo Welt</p>');
    const Own = lazyPart<{ name: string }>(() => Promise.reject(new Error('x')), () => createElement('p', null, 'eigene Meldung'));
    expect(await html(createElement(Own, { name: 'x' }))).toBe('<p>eigene Meldung</p>');
  });
});

describe('a part that fails while rendering', () => {
  beforeEach(() => useUnsaved.setState({ notes: {}, discarded: false }));

  const failed = (note?: string) => {
    const boundary = new PartBoundary({ note, children: null });
    // React asks the boundary for its state while the failed part is still mounted …
    boundary.state = PartBoundary.getDerivedStateFromError();
    // … and unmounts it afterwards: its editors forget what they held.
    setUnsaved('e1', null);
    setUnsaved('e2', null);
    return renderToStaticMarkup(boundary.render() as Parameters<typeof renderToStaticMarkup>[0]);
  };

  it('shows the message with „Neu laden“ and keeps the unsaved notes to copy them out', () => {
    setUnsaved('e1', 'm:a.md', async () => undefined, () => '# A');
    setUnsaved('e2', 'm:b.md', async () => undefined, () => '# B');
    const out = failed();
    expect(out).toContain('role="alert"');
    expect(out).toContain('Dieser Teil der App konnte nicht angezeigt werden.');
    expect(out).toContain('2 Notizen waren noch nicht gespeichert');
    expect(out).toContain('Inhalte kopieren');
    expect(out).toContain('Neu laden');
  });

  it('in a tab, only its own note counts; without unsaved changes there is nothing to copy', () => {
    setUnsaved('e1', 'm:a.md', async () => undefined, () => '# A');
    setUnsaved('e2', 'm:b.md', async () => undefined, () => '# B');
    expect(failed('m:a.md')).toContain('1 Notiz war noch nicht gespeichert');
    const clean = failed('m:c.md');
    expect(clean).not.toContain('Inhalte kopieren');
    expect(clean).toContain('Neu laden');
  });

  it('an editor whose text cannot be read does not stop the others', () => {
    setUnsaved('e1', 'm:a.md', async () => undefined, () => {
      throw new Error('destroyed');
    });
    setUnsaved('e2', 'm:b.md', async () => undefined, () => '# B');
    expect(failed()).toContain('1 Notiz war noch nicht gespeichert');
  });
});

describe('a part that is still loading (design-010)', () => {
  it('is announced to screen readers – „Lade…“ or the visible text', () => {
    expect(renderToStaticMarkup(createElement(PartLoading))).toMatch(/^<div role="status"[^>]*>.*<span class="sr-only">Lade…<\/span><\/div>$/);
    const text = renderToStaticMarkup(createElement(PartLoading, { text: 'Markdown-Ansicht wird geladen …' }));
    expect(text).toContain('role="status"');
    expect(text).toContain('<span>Markdown-Ansicht wird geladen …</span>');
    expect(text).not.toContain('sr-only');
  });

  it('shows the same loading block everywhere – never nothing, never a silent spinner', () => {
    const src = resolve(import.meta.dirname);
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []));
    // NOTE_LOADING, Loading (App.tsx) and AiLoading (the AI dialog frame) are PartLoading themselves.
    const allowed = /^(<PartLoading\b|NOTE_LOADING$|<Loading \/>$|<AiLoading \/>$)/;
    const bad = files(src).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/<Suspense\s+fallback=\{\s*([^}]*?)\s*\}/g)].filter((m) => !allowed.test(m[1]!)).map((m) => `${relative(src, f)}: ${m[1]}`),
    );
    expect(bad).toEqual([]);
  });
});
