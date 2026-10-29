// Commit text of a batch (owner 27.10.): only Markdown files count as notes, the rest is named as files.
import { describe, expect, it } from 'vitest';
import { countText } from './manager.js';

describe('countText', () => {
  it('counts notes and files apart', () => {
    expect(countText(['a.md', 'b.md'])).toBe('2 Notizen');
    expect(countText(['a.md', 'bilder/x.png'])).toBe('1 Notiz und 1 Datei');
    expect(countText(['a.md', 'b.MD', 'x.png', 'y.pdf'])).toBe('2 Notizen und 2 Dateien');
    expect(countText(['x.png', 'y.pdf'])).toBe('2 Dateien');
  });
});
