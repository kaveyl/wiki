// The production build that the server delivers (and the Docker image carries).
import { describe, expect, it } from 'vitest';
import config, { preloadApp } from '../vite.config';

describe('web build', () => {
  it('writes no source maps: they would hand out the whole frontend source without a login (seo-007)', () => {
    expect(config.build?.sourcemap).toBe(false);
  });

  it('leaves elkjs (EPL-2.0, not compatible with the AGPL) out: the import is replaced by a stub (AD-064)', () => {
    const alias = config.resolve?.alias as Record<string, string>;
    expect(alias['elkjs/lib/elk.bundled.js']).toMatch(/src\/vendor\/elk-stub\.ts$/);
  });

  it('announces the app chunk and its own imports as modulepreload in index.html, not the dictionary (seo-003)', () => {
    const chunk = (fileName: string, more: Record<string, unknown> = {}) =>
      [fileName, { type: 'chunk', fileName, imports: [], dynamicImports: [], isDynamicEntry: false, facadeModuleId: null, ...more }] as const;
    const bundle = Object.fromEntries([
      chunk('assets/index-a1.js', { imports: ['assets/rolldown-runtime-r1.js'], dynamicImports: ['assets/App-b2.js', 'assets/en-c3.js'] }),
      chunk('assets/rolldown-runtime-r1.js'),
      chunk('assets/App-b2.js', { isDynamicEntry: true, facadeModuleId: '/w/apps/web/src/App.tsx', imports: ['assets/ui-d4.js', 'assets/rolldown-runtime-r1.js'], dynamicImports: ['assets/Shell-e5.js'] }),
      chunk('assets/ui-d4.js', { imports: ['assets/x-f6.js'] }),
      chunk('assets/x-f6.js'),
      chunk('assets/Shell-e5.js', { isDynamicEntry: true, facadeModuleId: '/w/apps/web/src/shell/Shell.tsx' }),
      chunk('assets/en-c3.js', { isDynamicEntry: true, facadeModuleId: '/w/apps/web/src/i18n/en/index.ts' }),
      ['assets/index-g7.css', { type: 'asset', fileName: 'assets/index-g7.css' }],
    ]);
    const plugin = preloadApp() as unknown as { configResolved: (c: { base: string }) => void; transformIndexHtml: { order: string; handler: Function } };
    plugin.configResolved({ base: '/' });
    expect(plugin.transformIndexHtml.order).toBe('post'); // the bundle is only there in post hooks
    const warnings: string[] = [];
    const run = (b: object) => plugin.transformIndexHtml.handler.call({ warn: (m: string) => warnings.push(m) }, '<html>', { bundle: b, chunk: b['assets/index-a1.js' as keyof typeof b] });
    const tags = run(bundle) as { tag: string; attrs: Record<string, unknown>; injectTo: string }[];
    // Fetched alongside index.js; not what index.js already loads, not chunks the app loads later, not the dictionary.
    expect(tags.map((t) => t.attrs.href)).toEqual(['/assets/App-b2.js', '/assets/ui-d4.js', '/assets/x-f6.js']);
    expect(tags.every((t) => t.tag === 'link' && t.attrs.rel === 'modulepreload' && t.attrs.crossorigin === true && t.injectTo === 'head')).toBe(true);
    // Without the app chunk (renamed): a build warning instead of a wrong preload.
    const { 'assets/App-b2.js': _app, ...without } = bundle;
    expect(run(without)).toBeUndefined();
    expect(warnings).toEqual(['App-Chunk nicht gefunden – kein Vorladen']);
  });
});
