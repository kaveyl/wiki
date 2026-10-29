import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineConfig, type Plugin, type Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backend = process.env.KAVEYL_WIKI_BACKEND ?? 'http://127.0.0.1:8093';

/**
 * Excalidraw's fonts, served by Kaveyl Wiki itself (`/excalidraw-assets/fonts/…`) instead of a CDN.
 * Without the large CJK font (Xiaolai): Chinese/Japanese text falls back to Excalidraw's CDN. Without Liberation Sans
 * (licences, AD-064: an old 2007 build under GPL-2 with font exception; only the stand-in for „Helvetica“ in old drawings).
 * The licences of the fonts shipped are in THIRD-PARTY-NOTICES (scripts/third-party-notices.mjs, FONTS).
 */
function excalidrawFonts(): Plugin {
  return {
    name: 'kaveyl-wiki-excalidraw-fonts',
    apply: 'build',
    closeBundle() {
      const pkg = dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'));
      const from = join(pkg, 'fonts');
      if (!existsSync(from)) return this.warn(`Excalidraw-Schriften nicht gefunden: ${from}`);
      cpSync(from, join(import.meta.dirname, 'dist', 'excalidraw-assets', 'fonts'), { recursive: true, filter: (src) => !src.includes('Xiaolai') && !src.includes('Liberation') });
    },
  };
}

/**
 * The user manual is the in-app help (owner 2026-10-11): docs/BENUTZERHANDBUCH.md, docs/API.md
 * and the pictures in docs/handbuch are served as /hilfe/… — copied into the build (so the
 * Docker image carries them) and served straight from docs/ by the dev server.
 */
/** The example agent's files, served as /hilfe/beispiele/incident-agent/<file>. */
const EXAMPLE_FILES = ['agent.mjs', 'README.md'];

function helpFiles(): Plugin {
  const docs = join(import.meta.dirname, '..', '..', 'docs');
  const files: Record<string, string> = { 'handbuch.md': 'BENUTZERHANDBUCH.md', 'api.md': 'API.md' };
  const examples = join(import.meta.dirname, '..', '..', 'examples', 'incident-agent');
  return {
    name: 'kaveyl-wiki-help',
    configureServer(server) {
      server.middlewares.use('/hilfe/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\/+/, ''));
        // Translated manuals: /hilfe/<lang>/handbuch.md → docs/i18n/<lang>/BENUTZERHANDBUCH.md (AD-046).
        const tr = /^([a-z]{2})\/(handbuch\.md|api\.md)$/.exec(rel);
        const example = /^beispiele\/incident-agent\/([^/]+)$/.exec(rel)?.[1];
        const file = tr
          ? join(docs, 'i18n', tr[1]!, files[tr[2]!]!)
          : files[rel]
            ? join(docs, files[rel])
            : rel.startsWith('handbuch/') && !rel.includes('..')
              ? join(docs, rel)
              : example && EXAMPLE_FILES.includes(example)
                ? join(examples, example)
                : null;
        if (!file || !existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.md') ? 'text/markdown; charset=utf-8' : file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'image/webp');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      const out = join(import.meta.dirname, 'dist', 'hilfe');
      mkdirSync(out, { recursive: true });
      for (const [to, from] of Object.entries(files)) {
        if (!existsSync(join(docs, from))) return this.warn(`Hilfe fehlt: ${from}`);
        cpSync(join(docs, from), join(out, to));
      }
      cpSync(join(docs, 'handbuch'), join(out, 'handbuch'), { recursive: true });
      // The example agent the manual links to (owner 25.10.: „comes with an example“ – also without GitHub).
      for (const f of EXAMPLE_FILES) {
        mkdirSync(join(out, 'beispiele', 'incident-agent'), { recursive: true });
        cpSync(join(examples, f), join(out, 'beispiele', 'incident-agent', f));
      }
      // Translated manuals (docs/i18n/<lang>/), when there are any.
      const i18n = join(docs, 'i18n');
      if (existsSync(i18n))
        for (const l of readdirSync(i18n, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z]{2}$/.test(d.name)))
          for (const [to, from] of Object.entries(files))
            if (existsSync(join(i18n, l.name, from))) {
              mkdirSync(join(out, l.name), { recursive: true });
              cpSync(join(i18n, l.name, from), join(out, l.name, to));
            }
    },
  };
}

/**
 * Compressed copies made once at build time (seo-004): <file>.br (Brotli 11) and <file>.gz (-9) next to every text file
 * from 1 KiB on, which the server sends as they are (@fastify/static `preCompressed`). Smaller than its run-time
 * compression (Brotli 4) and no CPU per request. Runs last (`post`), after the copied help files.
 */
function precompress(): Plugin {
  const dist = join(import.meta.dirname, 'dist');
  return {
    name: 'kaveyl-wiki-precompress',
    apply: 'build',
    closeBundle: {
      order: 'post',
      handler() {
        let plain = 0;
        let packed = 0;
        for (const e of readdirSync(dist, { recursive: true, withFileTypes: true })) {
          if (!e.isFile() || !/\.(?:js|css|html|svg|json|webmanifest)$/.test(e.name)) continue;
          const file = join(e.parentPath, e.name);
          const data = readFileSync(file);
          if (data.length < 1024) continue;
          const br = brotliCompressSync(data, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
          });
          const gz = gzipSync(data, { level: 9 });
          // Only where it pays off; otherwise the plain file goes out.
          if (br.length < data.length) writeFileSync(`${file}.br`, br);
          if (gz.length < data.length) writeFileSync(`${file}.gz`, gz);
          plain += data.length;
          packed += Math.min(br.length, data.length);
        }
        this.info(`vorkomprimiert: ${(plain / 1024).toFixed(0)} KiB → ${(packed / 1024).toFixed(0)} KiB (br)`);
      },
    },
  };
}

/**
 * The app chunk and its own imports announced in index.html as <link rel="modulepreload"> (seo-003): fetched alongside
 * index.js instead of only after it ran (and after the dictionary). modulepreload fetches and parses, it does not run –
 * main.tsx still evaluates the app only after loadLanguage() (i18n/moduleLevel.test.ts). The dictionary is not announced:
 * the language is only known in the browser (localStorage, navigator.languages), and German visitors fetch none.
 */
export function preloadApp(): Plugin {
  let base = '/';
  return {
    name: 'kaveyl-wiki-preload-app',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle, chunk }) {
        if (!bundle || !chunk) return;
        const chunks = new Map(Object.values(bundle).flatMap((c) => (c.type === 'chunk' ? [[c.fileName, c] as const] : [])));
        const graph = (from: Rollup.OutputChunk, seen = new Set<string>()) => {
          if (!seen.has(from.fileName)) {
            seen.add(from.fileName);
            for (const f of from.imports) if (chunks.has(f)) graph(chunks.get(f)!, seen);
          }
          return seen;
        };
        const entry = graph(chunk);
        const app = [...chunks.values()].find((c) => c.isDynamicEntry && /[/\\]src[/\\]App\.tsx$/.test(c.facadeModuleId ?? ''));
        if (!app) {
          this.warn('App-Chunk nicht gefunden – kein Vorladen');
          return;
        }
        return [...graph(app)]
          .filter((f) => !entry.has(f))
          .map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: base + f }, injectTo: 'head' as const }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadApp(), excalidrawFonts(), helpFiles(), precompress()],
  resolve: {
    // Licences (AD-064): elkjs (EPL-2.0) is not compatible with the AGPL – Mermaid's optional „elk“ layout stays out.
    alias: { 'elkjs/lib/elk.bundled.js': fileURLToPath(new URL('./src/vendor/elk-stub.ts', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api/events': { target: backend.replace(/^http/, 'ws'), ws: true },
      '/api': backend,
      '/health': backend,
    },
  },
  // No source maps (seo-007): nothing reads them, and served from /assets/ they would hand out the whole source.
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
