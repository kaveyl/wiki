// The note tab bar on narrow screens: a 24 × 24 px close target and a visible hint that more tabs follow (rest-d2);
// the unpin pin of a pinned tab gets the same target (rest-e1).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shell = readFileSync(resolve(import.meta.dirname, 'Shell.tsx'), 'utf8');
const tabBar = shell.slice(shell.indexOf('function TabBar('), shell.indexOf('\n}\n', shell.indexOf('function TabBar(')));

describe('note tab bar (rest-d2)', () => {
  it('gives the close × a target of at least 24 × 24 px (WCAG 2.5.8) inside the 32 px tab', () => {
    const close = tabBar.match(/<button\s+className=\{cx\('([^']*)'[^]*?aria-label=\{t\('Tab schließen'\)\}/);
    expect(close?.[1]).toMatch(/\bh-6\b/);
    expect(close?.[1]).toMatch(/\bw-6\b/);
    expect(tabBar).toMatch(/'group flex h-8 /);
  });

  it('gives the unpin button of a pinned tab the same 24 × 24 px target (rest-e1)', () => {
    const unpin = tabBar.match(/<button\s+className="([^"]*)"[^]*?aria-label=\{t\('Tab lösen'\)\}/);
    expect(unpin?.[1]).toMatch(/\bh-6\b/);
    expect(unpin?.[1]).toMatch(/\bw-6\b/);
  });

  it('marks the scrolling row with the scroll hint and brings the active tab into view', () => {
    expect(tabBar).toMatch(/ref=\{barRef\}\s+className="scroll-hint /);
    expect(tabBar).toMatch(/scrollHint\(el\)/);
    expect(tabBar).toMatch(/scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/);
  });
});
