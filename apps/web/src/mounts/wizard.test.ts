// The custom tree checkbox in the mount wizard: a 24 × 24 px target around the 16 px box (rest-e2, WCAG 2.5.8).
// The file/folder name next to it is a plain <span>, not a <label>, so it does not add to the target.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wizard = readFileSync(resolve(import.meta.dirname, 'MountWizard.tsx'), 'utf8');
const checkNode = wizard.slice(wizard.indexOf('function CheckNode('), wizard.indexOf('\n}\n', wizard.indexOf('function CheckNode(')));

describe('mount wizard tree checkbox (rest-e2)', () => {
  it('gives the checkbox button a target of at least 24 × 24 px and keeps the visible box at 16 px', () => {
    const box = checkNode.match(/<button\s+role="checkbox"[^]*?className="([^"]*)"[^]*?<\/button>/);
    expect(box?.[1]).toMatch(/\bh-6\b/);
    expect(box?.[1]).toMatch(/\bw-6\b/);
    expect(box?.[0]).toMatch(/<span className=\{cx\('flex h-4 w-4 [^']*\bborder\b/);
    // The border moved from the <button> to the inner box; the rest-d3 scan in contrast.test.ts only sees buttons.
    expect(box?.[0]).toMatch(/\bborder-line-control\b/);
  });
});
