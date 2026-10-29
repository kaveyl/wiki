import { describe, expect, it } from 'vitest';
import { LANGUAGES, SOURCE_LANG, placeholders } from '@kaveyl-wiki/core';
import { DICTIONARIES, translateFields, translateLines, translateMessage, tr } from './index.js';

describe('server messages in other languages (AD-046)', () => {
  for (const l of LANGUAGES.filter((x) => x.code !== SOURCE_LANG)) {
    it(`${l.name}: a dictionary whose patterns are safe`, () => {
      const dict = DICTIONARIES[l.code];
      expect(dict).toBeDefined();
      const entries = Object.entries(dict!);
      expect(entries.length).toBeGreaterThan(50);
      // Same placeholders, never empty, and enough fixed text that a pattern cannot match just anything.
      expect(entries.filter(([de, tr]) => placeholders(de).join() !== placeholders(tr).join())).toEqual([]);
      expect(entries.filter(([, tr]) => !tr.trim())).toEqual([]);
      expect(entries.filter(([de]) => (de.replace(/\{\w+\}/g, '').match(/\p{L}/gu) ?? []).length < 4).map(([de]) => de)).toEqual([]);
    });
  }

  it('translates finished messages and leaves unknown ones alone', () => {
    expect(translateMessage('en', 'Nicht gefunden')).toBe('Not found');
    expect(translateMessage('en', 'Etwas, das es nicht gibt')).toBe('Etwas, das es nicht gibt');
    expect(translateMessage('de', 'Nicht gefunden')).toBe('Nicht gefunden');
    expect(tr('en', 'Kaveyl Wiki öffnen')).toBe('Open Kaveyl Wiki');
  });

  it('translates every log entry of the REST API and MCP (api/ops.ts)', () => {
    for (const via of ['API', 'MCP']) {
      expect(translateMessage('en', `${via}: Ordner angelegt: a/b`)).toBe(`${via}: Folder created: a/b`);
      expect(translateMessage('en', `${via}: Anhang: assets/x.png (3 KB)`)).toBe(`${via}: Attachment: assets/x.png (3 KB)`);
      expect(translateMessage('en', `${via}: Gelöscht: a.md`)).toBe(`${via}: Deleted: a.md`);
    }
  });

  it('translates lists line by line and message fields only', () => {
    expect(translateLines('en', '• Nicht gefunden\n• unbekannt')).toBe('• Not found\n• unbekannt');
    const body = translateFields('en', { error: 'Nicht gefunden', raw: 'Nicht gefunden', items: [{ message: 'Nicht gefunden', title: 'Nicht gefunden' }] });
    expect(body).toEqual({ error: 'Not found', raw: 'Nicht gefunden', items: [{ message: 'Not found', title: 'Nicht gefunden' }] });
  });
});
