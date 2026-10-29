import { describe, expect, it } from 'vitest';
import { scrollHint } from './scrollHint';

/** Just enough of an element: sizes, attributes and the scroll listener. */
function row(scrollWidth: number, clientWidth: number) {
  const attrs = new Set<string>();
  let onScroll: (() => void) | undefined;
  const el = {
    scrollWidth,
    clientWidth,
    scrollLeft: 0,
    toggleAttribute: (name: string, on: boolean) => void (on ? attrs.add(name) : attrs.delete(name)),
    addEventListener: (_: string, fn: () => void) => void (onScroll = fn),
    removeEventListener: () => void (onScroll = undefined),
  };
  const scrollTo = (x: number) => {
    el.scrollLeft = x;
    onScroll?.();
  };
  return { el: el as unknown as HTMLElement, attrs, scrollTo, listening: () => !!onScroll };
}

describe('scrollHint', () => {
  it('marks nothing when everything fits', () => {
    const r = row(300, 300);
    scrollHint(r.el);
    expect([...r.attrs]).toEqual([]);
  });

  it('marks the side where entries hide, following the scroll position', () => {
    const r = row(918, 390);
    const cleanup = scrollHint(r.el);
    expect([...r.attrs]).toEqual(['data-more-end']);
    r.scrollTo(200);
    expect([...r.attrs].sort()).toEqual(['data-more-end', 'data-more-start']);
    r.scrollTo(528);
    expect([...r.attrs]).toEqual(['data-more-start']);
    cleanup?.();
    expect(r.listening()).toBe(false);
  });

  it('ignores sub-pixel rests', () => {
    const r = row(391, 390);
    scrollHint(r.el);
    expect([...r.attrs]).toEqual([]);
  });
});
