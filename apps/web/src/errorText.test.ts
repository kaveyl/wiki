// Caught errors become text in one place (code-005): never "Error: …"/"TypeError: Failed to fetch" on screen.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, errorText } from './api';

const src = resolve(import.meta.dirname);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('errorText', () => {
  it('shows the message alone, without the class name', () => {
    expect(errorText(new ApiError(404, 'Nicht gefunden', {}))).toBe('Nicht gefunden');
    expect(errorText(new Error('Kaputt'))).toBe('Kaputt');
    expect(errorText(new TypeError('Cannot read properties of undefined'))).toBe('Cannot read properties of undefined');
    expect(errorText('schon Text')).toBe('schon Text');
    expect(errorText(undefined)).toBe('undefined');
  });

  it('says in words when the server could not be reached at all', () => {
    for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'fetch failed'])
      expect(errorText(new TypeError(m))).toBe('Keine Verbindung zum Server');
  });

  it('no hand-built error texts are left: they go through errorText', () => {
    const built: string[] = [];
    for (const file of sources(src)) {
      if (relative(src, file) === 'api.ts') continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // `e instanceof ApiError ? e.message : String(e)`, `String(query.error)` – the class name shows up on screen.
          if (/\.message\)? *: *String\(|\bString\((e|err|error|reason|[A-Za-z_][\w.]*\.error)\)/.test(line)) built.push(`${relative(src, file)}:${i + 1}`);
        });
    }
    expect(built).toEqual([]);
  });
});
