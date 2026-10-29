// How much JavaScript the web app loads (gzip), after a build (`npm run build`):
//   node scripts/bundle-report.mjs            – sign-in page, workspace without a note, with a note
//   node scripts/bundle-report.mjs Shell 30   – the 30 largest origins of the chunk Shell-*.js (needs `npx vite build --sourcemap` in apps/web)
// Counts the files each start file imports statically (what the browser fetches right away), not import().
// source-map-js comes with Vite (PostCSS) – no extra dependency.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { SourceMapConsumer } from 'source-map-js';

const dir = join(import.meta.dirname, '..', 'apps', 'web', 'dist', 'assets');
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const chunk = (name) => files.find((f) => f.startsWith(`${name}-`)) ?? (console.error(`Kein Chunk ${name}-*.js in ${dir}`), process.exit(1));

function closure(starts) {
  const seen = new Set();
  const add = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const code = readFileSync(join(dir, f), 'utf8');
    for (const m of code.matchAll(/(?:^|[;}\n])\s*import\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) add(m[1]);
  };
  starts.forEach(add);
  return seen;
}
const gzip = (set) => [...set].reduce((n, f) => n + gzipSync(readFileSync(join(dir, f))).length, 0);
const kb = (n) => `${Math.round(n / 1024)} KB`;

function origins(file, top) {
  const code = readFileSync(join(dir, file), 'utf8');
  if (!existsSync(join(dir, `${file}.map`))) return console.error('Ohne Sourcemap: erst `npx vite build --sourcemap` in apps/web');
  const map = new SourceMapConsumer(JSON.parse(readFileSync(join(dir, `${file}.map`), 'utf8')));
  const lines = code.split('\n');
  const by = new Map();
  const group = (s) => {
    if (!s) return '(ohne)';
    const nm = s.lastIndexOf('node_modules/');
    if (nm >= 0) {
      const p = s.slice(nm + 13).split('/');
      return p[0].startsWith('@') ? `${p[0]}/${p[1]}` : p[0];
    }
    return s.replace(/^.*?(apps\/web\/src|packages\/core\/src)\//, '$1/');
  };
  let last = null;
  map.eachMapping((m) => {
    if (last) by.set(last.g, (by.get(last.g) ?? 0) + ((last.line === m.generatedLine ? m.generatedColumn : lines[last.line - 1].length) - last.col));
    last = { line: m.generatedLine, col: m.generatedColumn, g: group(m.source) };
  });
  for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${String(Math.round(v / 1024)).padStart(6)} KB  ${((v / code.length) * 100).toFixed(1).padStart(5)} %  ${k}`);
  console.log(`gesamt ${kb(code.length)} (roh)`);
}

const [name, top] = process.argv.slice(2);
if (name) origins(chunk(name), Number(top ?? 30));
else {
  const base = [chunk('index'), chunk('App')];
  console.log(`Anmeldeseite:              ${kb(gzip(closure(base)))}`);
  console.log(`Oberfläche ohne Notiz:     ${kb(gzip(closure([...base, chunk('Shell')])))}`);
  console.log(`mit geöffneter Notiz:      ${kb(gzip(closure([...base, chunk('Shell'), chunk('NoteView')])))}`);
}
