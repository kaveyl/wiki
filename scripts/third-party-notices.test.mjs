// Licences of everything shipped (AD-064): only licences that may be combined with the AGPL-3.0 of Kaveyl Wiki, and a
// notice for each package. A new dependency with another licence fails here – check it, then extend ALLOWED or replace it.
import { describe, expect, it } from 'vitest';
import { notices, packages } from './third-party-notices.mjs';

/** Permissive or weak-copyleft licences compatible with the AGPL-3.0 (SPDX ids). */
const ALLOWED = new Set(['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'BlueOak-1.0.0', 'CC0-1.0', 'Zlib', 'Unlicense', 'MPL-2.0', 'Python-2.0', 'CC-BY-4.0']);

/** An SPDX expression is fine when one alternative (OR) consists only of allowed licences (AND). */
export function compatible(expr) {
  return String(expr)
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((alt) => alt.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())));
}

describe('third-party licences', () => {
  it('reads SPDX expressions', () => {
    expect(compatible('MIT')).toBe(true);
    expect(compatible('(MPL-2.0 OR Apache-2.0)')).toBe(true);
    expect(compatible('(MIT AND Zlib)')).toBe(true);
    expect(compatible('EPL-2.0')).toBe(false);
    expect(compatible('GPL-2.0-only')).toBe(false);
    expect(compatible('SSPL-1.0 OR MIT')).toBe(true);
  });

  it('every shipped package has a licence that goes with the AGPL; elkjs stays out', () => {
    const pkgs = packages();
    expect(pkgs.length).toBeGreaterThan(300);
    expect(pkgs.filter((p) => !compatible(p.license)).map((p) => `${p.name}@${p.version}: ${p.license}`)).toEqual([]);
    expect(pkgs.some((p) => p.name === 'elkjs')).toBe(false);
  });

  it('the notices name every package and font', () => {
    const text = notices();
    for (const p of packages()) expect(text).toContain(`${p.name} ${p.version} (`);
    for (const font of ['Excalifont', 'Virgil', 'KaTeX fonts', 'SIL OPEN FONT LICENSE']) expect(text).toContain(font);
    expect(text).not.toContain('no licence file in the package; see');
  });
});
