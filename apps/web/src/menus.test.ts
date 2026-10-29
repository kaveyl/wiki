// Menus stay inside the viewport on phones: every Radix dropdown goes through the shared boxes in ui.tsx;
// popovers (icon/emoji picker, note path, folder picker, sync status) too (rest-e3).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { glueEllipsis } from './ui';

const src = resolve(import.meta.dirname);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('dropdown menus (rest-d1)', () => {
  it('use DropdownContent / DropdownSubContent from ui.tsx instead of raw DM.Content / DM.SubContent', () => {
    const raw = sources(src)
      .filter((f) => !f.endsWith('/ui.tsx'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((line, i) => (/<DM\.(Sub)?Content\b/.test(line) ? [`${relative(src, f)}:${i + 1}`] : [])),
      );
    expect(raw).toEqual([]);
  });

  it('keep an 8 px margin and never grow beyond the available space (like ContextContent)', () => {
    const ui = readFileSync(join(src, 'ui.tsx'), 'utf8');
    expect(ui).toMatch(/<DM\.Content[^>]*collisionPadding=\{8\}/);
    expect(ui).toMatch(/<DM\.SubContent[^>]*collisionPadding=\{8\}/);
    expect(ui).toMatch(/max-w-\[var\(--radix-dropdown-menu-content-available-width\)\]/);
    expect(ui).toMatch(/max-h-\[var\(--radix-dropdown-menu-content-available-height\)\][^']*overflow-y-auto/);
    expect(ui).toMatch(/minWidth: `min\(\$\{minWidth\}px, var\(--radix-dropdown-menu-content-available-width\)\)`/);
  });
});

describe('popovers (rest-e3)', () => {
  it('use PopoverContent from ui.tsx instead of raw Popover.Content', () => {
    const raw = sources(src)
      .filter((f) => !f.endsWith('/ui.tsx'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((line, i) => (/<Popover\.Content\b/.test(line) ? [`${relative(src, f)}:${i + 1}`] : [])),
      );
    expect(raw).toEqual([]);
  });

  it('keep an 8 px margin and never grow beyond the available space (like the dropdowns)', () => {
    const ui = readFileSync(join(src, 'ui.tsx'), 'utf8');
    expect(ui).toMatch(/<Popover\.Content[^>]*collisionPadding=\{8\}/);
    expect(ui).toMatch(/max-w-\[var\(--radix-popover-content-available-width\)\]/);
    expect(ui).toMatch(/max-h-\[var\(--radix-popover-content-available-height\)\][^']*overflow-y-auto/);
  });
});

describe('suggestion fields', () => {
  it("use ComboInput from ui.tsx instead of the browser's own datalist menu", () => {
    const raw = sources(src).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/<datalist\b|\blist=["{]/.test(line) ? [`${relative(src, f)}:${i + 1}`] : [])),
    );
    expect(raw).toEqual([]);
  });
});

describe('context menu entries (design-015)', () => {
  it('never wrap the trailing "…" onto a line of its own', () => {
    expect(glueEllipsis('Ordner verschlüsseln …')).toBe('Ordner verschlüsseln\u00a0…');
    expect(glueEllipsis('Encrypt folder …')).toBe('Encrypt folder\u00a0…');
    expect(glueEllipsis('Umbenennen / verschieben')).toBe('Umbenennen / verschieben');
    expect(glueEllipsis('Suchen …ab')).toBe('Suchen …ab');
  });

  it('ContextItem applies it to its label', () => {
    const ui = readFileSync(join(src, 'ui.tsx'), 'utf8');
    expect(ui).toMatch(/typeof children === 'string' \? glueEllipsis\(children\) : children/);
  });
});
