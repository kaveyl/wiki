import { describe, expect, it } from 'vitest';
import { sniffIcon } from './icons.js';

const svg = (s: string) => sniffIcon(Buffer.from(s));

describe('sniffIcon: SVG', () => {
  it('finds the <svg> root after BOM, XML declaration, comments and doctype', () => {
    expect(svg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe('image/svg+xml');
    expect(svg('﻿  <?xml version="1.0"?>\n<!-- a -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<!---->\n<SVG>')).toBe('image/svg+xml');
    expect(svg('<svg\nviewBox="0 0 1 1">')).toBe('image/svg+xml');
  });

  it('refuses everything else', () => {
    expect(svg('<html><svg></svg></html>')).toBeNull();
    expect(svg('<svgx>')).toBeNull();
    expect(svg('<!-- never closed <svg>')).toBeNull();
    expect(svg('<?xml version="1.0" <svg>')).toBeNull();
    expect(svg('text <svg>')).toBeNull();
  });

  it('stays fast on many empty comments before a wrong character (CodeQL js/redos, was exponential)', () => {
    const t = performance.now();
    expect(svg('<!---->'.repeat(600) + 'x')).toBeNull();
    expect(svg('<!--' + '-'.repeat(4000))).toBeNull();
    expect(performance.now() - t).toBeLessThan(200);
  });
});
