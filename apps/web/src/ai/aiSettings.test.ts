// "Verbindung testen" saves the provider first – while it runs the button is locked and shows a spinner,
// like the other test buttons (Backup "Testen"), so a double click cannot create the provider twice (ki-laden).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(import.meta.dirname, 'AiSettings.tsx'), 'utf8');

describe('AiSettings: "Verbindung testen" (ki-laden)', () => {
  it('locks the button and shows a spinner while the test runs', () => {
    const button = src.match(/<Button\b[^>]*onClick=\{\(\) => void loadModels\(\)\}[^>]*>([\s\S]*?)<\/Button>/);
    expect(button).not.toBeNull();
    expect(button![0]).toMatch(/disabled=\{[^}]*\btesting\b[^}]*\}/);
    expect(button![1]).toMatch(/\{testing && <Spinner\b/);
  });

  it('sets the state around the request and ignores a second start', () => {
    const fn = src.match(/const loadModels = async \(\) => \{([\s\S]*?)\n {2}\};/);
    expect(fn).not.toBeNull();
    expect(fn![1]).toMatch(/if \(testing\b[^)]*\) return;/);
    expect(fn![1]).toMatch(/setTesting\(true\)/);
    expect(fn![1]).toMatch(/finally \{\s*setTesting\(false\);/);
  });

  it('does not save at the same time as the test (both would create the provider)', () => {
    expect(src).toMatch(/<Button variant="primary" size="sm" disabled=\{busy \|\| testing\}>/);
  });
});
