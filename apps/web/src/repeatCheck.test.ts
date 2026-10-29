// Repeating a password or passphrase (design-002): one behaviour in every form – „Stimmt nicht überein“ at the
// repeat field once it is as long as the first entry or was left, never at the first character, never only on saving.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MissingHint, repeatMismatch } from './ui';

const src = resolve(import.meta.dirname);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });
}

describe('repeat check', () => {
  it('says nothing while the repeat is shorter and the field was not left', () => {
    expect(repeatMismatch('geheim-123', '', false)).toBe(false);
    expect(repeatMismatch('geheim-123', 'x', false)).toBe(false);
    expect(repeatMismatch('geheim-123', 'geheim-12', false)).toBe(false);
  });

  it('says it once the repeat is as long as the first entry, or the field was left', () => {
    expect(repeatMismatch('geheim-123', 'geheim-12x', false)).toBe(true);
    expect(repeatMismatch('geheim-123', 'geheim-1234', false)).toBe(true);
    expect(repeatMismatch('geheim-123', 'geh', true)).toBe(true);
  });

  it('never for a matching or an empty repeat (that one is „missing“, said beside the button)', () => {
    expect(repeatMismatch('geheim-123', 'geheim-123', true)).toBe(false);
    expect(repeatMismatch('geheim-123', '', true)).toBe(false);
  });

  it('every repeat field uses the shared check', () => {
    const own: string[] = [];
    for (const file of sources(src)) {
      const code = readFileSync(file, 'utf8');
      if (/label=\{t\('[^']*wiederholen'\)\}/.test(code) && !/useRepeatCheck\(/.test(code)) own.push(relative(src, file));
    }
    expect(own).toEqual([]);
  });

  it('a grey button says what is missing', () => {
    expect(renderToStaticMarkup(createElement(MissingHint, { id: 'm', items: [] }))).toBe('');
    expect(renderToStaticMarkup(createElement(MissingHint, { id: 'm', items: ['Aktuelles Passwort', 'Neues Passwort wiederholen'] }))).toMatch(
      /^<span id="m"[^>]*>Es fehlt noch: Aktuelles Passwort, Neues Passwort wiederholen<\/span>$/,
    );
  });
});
