// CodeMirror is only needed in the Markdown source view (seo-002): opening a note must not load it. This test keeps
// it that way – nothing NoteView imports statically (directly or through its own modules) pulls in CodeMirror; the
// source view comes in by a dynamic import of ./SourceEditor.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
// The parser Vite builds with (rolldown, oxc) – no extra dependency.
import { parseSync } from 'rolldown/utils';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
type Node = { type: string; [k: string]: unknown };
const CODEMIRROR = /(^|\/)(@codemirror\/|@uiw\/react-codemirror|codemirror$)/;

function walk(node: unknown, visit: (n: Node) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  const n = node as Node;
  if (typeof n.type === 'string') visit(n);
  for (const [k, v] of Object.entries(n)) if (k !== 'parent' && v && typeof v === 'object') walk(v, visit);
}

/** Static (not import()) graph from `entry`: the local modules and the package specifiers they import. */
function staticImports(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const add = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    walk(parseSync(file, readFileSync(file, 'utf8')).program, (n) => {
      if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && (n as { importKind?: string }).importKind !== 'type') {
        const spec = (n.source as { value?: string } | null)?.value;
        if (!spec) return;
        if (!spec.startsWith('.')) return void packages.add(spec);
        const base = resolve(dirname(file), spec);
        const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => base + x).find((p) => /\.tsx?$/.test(p) && existsSync(p));
        if (hit) add(hit);
      }
    });
  };
  add(entry);
  return { files: [...files].map((f) => relative(SRC, f)), packages: [...packages] };
}

describe('Markdown source view loads on demand (seo-002)', () => {
  const noteView = resolve(SRC, 'editor/NoteView.tsx');

  it('nothing NoteView imports statically pulls in CodeMirror', () => {
    const graph = staticImports(noteView);
    expect(graph.files).not.toContain('editor/SourceEditor.tsx');
    expect(graph.packages.filter((p) => CODEMIRROR.test(p))).toEqual([]);
    expect(graph.files.length).toBeGreaterThan(10); // the walk did follow NoteView's own modules
  });

  it('NoteView loads the source view by a dynamic import', () => {
    expect(readFileSync(noteView, 'utf8')).toMatch(/lazyPart\(\(\) => import\('\.\/SourceEditor'\)/);
  });

  it('the check finds CodeMirror where it is imported', () => {
    expect(staticImports(resolve(SRC, 'editor/SourceEditor.tsx')).packages.filter((p) => CODEMIRROR.test(p)).length).toBeGreaterThan(0);
  });
});
