// The Kaveyl mark: a note page with wavy lines, the K as its spine. One source for the in-app logo
// (auth/AuthPages.tsx `Logo`), the favicon and the app icons (scripts/make-icons.mjs reads this file,
// so it stays plain, erasable TypeScript without imports).
// Drawn on a 26.67 grid and scaled 1.2 about the centre of the 32 tile (LOGO_TRANSFORM).

export const PRODUCT_NAME = 'Kaveyl Wiki';
/** Sidebar and tab title. */
export const PRODUCT_SHORT = 'Kaveyl';

export const LOGO_TRANSFORM = 'matrix(1.2 0 0 1.2 -3.2 -3.2)';
export const LOGO_FRAME = 'M8.5 5.7h15a2.8 2.8 0 0 1 2.8 2.8v15a2.8 2.8 0 0 1 -2.8 2.8h-15a2.8 2.8 0 0 1 -2.8 -2.8v-15a2.8 2.8 0 0 1 2.8 -2.8z';
export const LOGO_STEM = 'M16.2 5V27';
export const LOGO_ARMS = 'M16.6 16.6L22.6 9.6M18.8 14.6L22.8 22.4';

/** `full` from about 40 px up (four lines); `small` for tabs, sidebar and buttons (three thicker lines). */
export const LOGO_DETAIL = {
  full: { kw: 2.2, lw: 1.6, lines: 'M7.8 10.2q1.5 -0.7 3 0t3 0M7.8 14.6q1.17 -0.7 2.34 0t2.34 0M7.8 19q1.5 -0.7 3 0t3 0M7.8 23.4q1.8 -0.7 3.6 0' },
  small: { kw: 2.8, lw: 1.8, lines: 'M7.8 10q1.5 -0.8 3 0t3 0M7.8 16q1.12 -0.8 2.25 0t2.25 0M7.8 22q1.35 -0.8 2.7 0t2.7 0' },
};

/**
 * The mark as a standalone SVG file. `rx` 0 = full square (iOS and Android round it themselves);
 * `scale` < 1 keeps it inside the safe zone of maskable icons.
 */
export function logoSvg({ small = false, rx = 7, scale = 1, bg = '#4f46e5', fg = '#fff' } = {}): string {
  const d = small ? LOGO_DETAIL.small : LOGO_DETAIL.full;
  const s = (16 * (1 - scale)).toFixed(2);
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='${rx}' fill='${bg}'/>` +
    `<g transform='matrix(${scale} 0 0 ${scale} ${s} ${s})'><g transform='${LOGO_TRANSFORM}' stroke='${fg}' fill='none' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='${LOGO_FRAME}' stroke-width='1.4'/><path d='${LOGO_STEM}' stroke-width='${d.kw}' stroke-linecap='butt'/>` +
    `<path d='${LOGO_ARMS}' stroke-width='${d.kw}'/><path d='${d.lines}' stroke-width='${d.lw}'/></g></g></svg>`
  );
}
