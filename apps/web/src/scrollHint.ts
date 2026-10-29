/**
 * Ref callback for sideways scrolling rows (settings areas/tabs, editor toolbar): marks the side where
 * more entries hide with `data-more-start` / `data-more-end`; `.scroll-hint` in styles.css fades that
 * edge, so a cut-off entry reads as "continues" on narrow screens. Use as `ref={scrollHint}` (React 19
 * runs the returned cleanup on unmount).
 */
export function scrollHint(el: HTMLElement | null) {
  if (!el) return;
  const update = () => {
    const rest = el.scrollWidth - el.clientWidth - el.scrollLeft;
    el.toggleAttribute('data-more-start', el.scrollLeft > 1);
    el.toggleAttribute('data-more-end', rest > 1);
  };
  update();
  el.addEventListener('scroll', update, { passive: true });
  // Size changes (rotation, sm: layout) and changed entries (other settings area, language).
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  ro?.observe(el);
  const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
  mo?.observe(el, { childList: true, subtree: true, characterData: true });
  return () => {
    el.removeEventListener('scroll', update);
    ro?.disconnect();
    mo?.disconnect();
  };
}
