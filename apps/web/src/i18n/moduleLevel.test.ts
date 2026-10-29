// The dictionary is loaded before the app, not with the entry bundle (seo-003). Many modules translate texts as
// they load (menus, labels) – that only works because main.tsx imports the app after loadLanguage(). This test
// keeps it that way: the app comes in by a dynamic import, and nothing main.tsx imports statically translates while
// loading (it would run before the dictionary is there and stay German).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
// The parser Vite builds with (rolldown, oxc) – no extra dependency.
import { parseSync } from 'rolldown/utils';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
type Node = { type: string; start: number; [k: string]: unknown };
const SKIP = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression']);

function walk(node: unknown, visit: (n: Node) => boolean | void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  const n = node as Node;
  if (typeof n.type === 'string' && visit(n) === false) return;
  for (const [k, v] of Object.entries(n)) if (k !== 'parent' && v && typeof v === 'object') walk(v, visit);
}

const parsed = (file: string) => {
  const code = readFileSync(file, 'utf8');
  return { code, program: parseSync(file, code).program as unknown };
};

/** Relative modules main.tsx loads statically (not through import()). */
function staticGraph(entry: string): string[] {
  const seen = new Set<string>();
  const add = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    walk(parsed(file).program, (n) => {
      if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && (n as { importKind?: string }).importKind !== 'type') {
        const spec = (n.source as { value?: string } | null)?.value;
        if (!spec?.startsWith('.')) return;
        const base = resolve(dirname(file), spec);
        const hit = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => base + x).find((p) => existsSync(p));
        if (hit) add(hit);
      }
    });
  };
  add(entry);
  return [...seen];
}

/** Calls of t()/tn() that run while the module loads (outside any function or class). */
function moduleLevelCalls(file: string): string[] {
  const { code, program } = parsed(file);
  const found: string[] = [];
  walk(program, (n) => {
    if (SKIP.has(n.type)) return false;
    const callee = n.callee as { type?: string; name?: string } | undefined;
    if (n.type === 'CallExpression' && callee?.type === 'Identifier' && (callee.name === 't' || callee.name === 'tn'))
      found.push(`${relative(SRC, file)}:${code.slice(0, n.start).split('\n').length}`);
  });
  return found;
}

describe('dictionary before the app (seo-003)', () => {
  const main = resolve(SRC, 'main.tsx');
  const graph = staticGraph(main);

  it('main.tsx loads the app by a dynamic import, after loadLanguage()', () => {
    expect(graph.map((f) => relative(SRC, f))).not.toContain('App.tsx');
    expect(readFileSync(main, 'utf8')).toMatch(/loadLanguage\(\)\s*\.then\(\(\) => import\('\.\/App'\)\)/);
    expect(graph.length).toBeGreaterThan(1); // i18n …
  });

  it('nothing main.tsx imports statically translates while loading', () => {
    expect(graph.flatMap(moduleLevelCalls)).toEqual([]);
  });

  it('the check finds a translation at module level', () => {
    // Shell modules do it on purpose (they load after the dictionary) – a sanity check of the parser walk.
    expect(moduleLevelCalls(resolve(SRC, 'shell/Fsck.tsx')).length).toBeGreaterThan(0);
  });
});
