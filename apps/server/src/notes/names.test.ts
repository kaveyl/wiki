import { describe, expect, it } from 'vitest';
import { attachmentName } from './names.js';

describe('attachment names', () => {
  it('keeps a readable name, never empty, never a dotfile', () => {
    expect(attachmentName('Mein Angebot (v2).PDF')).toBe('Mein-Angebot-v2.pdf');
    expect(attachmentName('.env')).toBe('env');
    expect(attachmentName('...')).toBe('datei');
    expect(attachmentName('-.-a-.-.pdf')).toBe('a.pdf');
  });

  it('dots and dashes at the end cost no quadratic time (CodeQL #51)', () => {
    const t0 = performance.now();
    expect(attachmentName(`a${'.-'.repeat(100_000)}b`)).toBe('a.b');
    expect(attachmentName(`a${'.-'.repeat(100_000)}`)).toBe('a');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
