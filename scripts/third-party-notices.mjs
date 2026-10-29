// THIRD-PARTY-NOTICES.txt (AD-064): the licence texts of everything Kaveyl Wiki ships – the npm packages the image and
// the web app contain, build tools that leave code in the bundle, and the fonts. Permissive licences (MIT, BSD, Apache …)
// require their text to travel with every copy; the minified bundles drop it, so this file carries it instead.
// Written at every build (npm run build → apps/web/dist/THIRD-PARTY-NOTICES.txt and LICENSE.txt, served and in the image
// at /app/web, linked in Settings → Help).
// A new dependency needs nothing here; a new font or other asset that is not an npm package goes into FONTS/OTHER.
//   node scripts/third-party-notices.mjs [out-file]      (default: stdout)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Replaced at build time and not shipped (licence not compatible with the AGPL, AD-064). */
const LEFT_OUT = new Set(['elkjs']);
/** Development dependencies that still put code into the bundle (CSS reset, module preload helper). */
const BUILD_TOOLS = ['tailwindcss', 'vite'];
/** Fonts shipped with the drawing editor and formulas that carry no licence file of their own. */
const FONTS = [
  ['Assistant', 'Copyright 2020 The Assistant Project Authors (https://github.com/hafontia/Assistant); Copyright 2010 The Source Sans Pro Authors', 'OFL-1.1'],
  ['Cascadia Code', '© 2020 Microsoft Corporation (https://github.com/microsoft/cascadia-code)', 'OFL-1.1'],
  ['Comic Shanns', 'Copyright (c) 2018 Shannon Miwa, (c) 2023 Jesus Gonzalez, (c) 2023 Rodrigo Batista de Moraes, (c) 2024 Fini Jastrow (https://github.com/shannpersand/comic-shanns)', 'MIT'],
  ['Excalifont', 'Copyright (c) 2024 Excalidraw (https://github.com/excalidraw/excalifont)', 'OFL-1.1'],
  ['Lilita One', 'Copyright (c) 2011 Juan Montoreano, with Reserved Font Name "Lilita One"', 'OFL-1.1'],
  ['Nunito', 'Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)', 'OFL-1.1'],
  ['Virgil', 'Copyright (c) 2011 Your Own Font Foundry / Excalidraw (https://github.com/excalidraw/virgil)', 'OFL-1.1'],
  ['KaTeX fonts', 'Copyright (c) 2009-2010 Design Science, Inc.; Copyright (c) 2014-2018 Khan Academy', 'OFL-1.1'],
];
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const ISC = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
/** Packages whose package.json names no licence (checked by hand: the README states it). */
const KNOWN = {
  format: { license: 'MIT', copyright: 'Copyright 2010 - 2014 Sami Samhuri' },
  fuzzy: { license: 'MIT' }, // LICENSE-MIT in the package
  khroma: { license: 'MIT' }, // LICENSE in the package
};
/** Copyright holders from the projects' licence files, for packages published without one. */
const HOLDERS = [
  [/^@radix-ui\//, 'Copyright (c) 2022 WorkOS (https://github.com/radix-ui/primitives)'],
  [/^@excalidraw\//, 'Copyright (c) 2020 Excalidraw (https://github.com/excalidraw/excalidraw)'],
];

/** name@version → { name, version, license, repository, dir } for everything shipped. */
export function packages() {
  // npm ls also exits with 1 for „invalid“ entries (versions forced by root overrides) – the tree is complete all the same.
  const ls = spawnSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], { cwd: ROOT, maxBuffer: 64 << 20, encoding: 'utf8' });
  if (!ls.stdout) throw new Error(`npm ls: ${ls.stderr}`);
  const tree = JSON.parse(ls.stdout);
  const seen = new Map();
  const add = (name, d) => {
    if (!d?.path || !d.version || name.startsWith('@kaveyl-wiki/') || LEFT_OUT.has(name)) return;
    const key = `${name}@${d.version}`;
    if (seen.has(key)) return;
    const lic = typeof d.license === 'string' ? d.license : d.license?.type;
    const repo = typeof d.repository === 'string' ? d.repository : d.repository?.url;
    seen.set(key, { name, version: d.version, license: lic ?? KNOWN[name]?.license ?? 'see package', repository: repo ?? d.homepage ?? '', dir: d.path });
  };
  const walk = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      add(name, d);
      walk(d.dependencies);
    }
  };
  walk(tree.dependencies);
  for (const name of BUILD_TOOLS) {
    const dir = join(ROOT, 'node_modules', name);
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    add(name, { path: dir, version: p.version, license: p.license, repository: p.repository, homepage: p.homepage });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The licence files a package carries (text), or null. */
function licenceText(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort();
  return files.length ? files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n') : null;
}

/** A package without a licence file: the MIT or ISC text with the author from package.json (both need the notice). */
function fallbackText(p) {
  const known = KNOWN[p.name];
  let author = known?.copyright ?? HOLDERS.find(([re]) => re.test(p.name))?.[1];
  if (!author) {
    try {
      const a = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')).author;
      author = `Copyright (c) ${typeof a === 'string' ? a : a?.name ?? `the ${p.name} authors`}`;
    } catch {
      author = `Copyright (c) the ${p.name} authors`;
    }
  }
  const where = p.repository || `https://www.npmjs.com/package/${p.name}`;
  const text = { MIT, ISC }[p.license];
  return text ? `${p.license} License (no licence file in the package; ${where})\n\n${author}\n\n${text}` : `${p.license} – no licence file in the package; see ${where}`;
}

export function notices() {
  const pkgs = packages();
  // Packages with the same licence text are listed together.
  const groups = new Map();
  for (const p of pkgs) {
    const text = licenceText(p.dir) ?? fallbackText(p);
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(p);
  }
  const line = '-'.repeat(100);
  const out = [
    'THIRD-PARTY NOTICES – Kaveyl Wiki',
    '',
    'Kaveyl Wiki is licensed under the GNU Affero General Public License v3.0 (LICENSE). It contains the third-party',
    'software listed below, each under its own licence. Full source of every package: https://www.npmjs.com/ (name and',
    'version as given).',
    '',
    'The container image is based on the official Node.js image (Debian bookworm-slim): Node.js is licensed under the MIT',
    'licence and bundles further components (https://github.com/nodejs/node/blob/main/LICENSE); the Debian packages in the',
    'image (among them git) keep their copyright and licence files under /usr/share/doc/<package>/copyright, their sources',
    'are at https://sources.debian.org/.',
    '',
    `${pkgs.length} packages, ${FONTS.length} fonts.`,
    '',
    line,
    'FONTS',
    line,
    ...FONTS.map(([n, c, l]) => `${n} – ${l}\n  ${c}`),
    '',
    'SIL Open Font License 1.1 (applies to the fonts marked OFL-1.1 above):',
    '',
    readFileSync(join(ROOT, 'scripts/licenses/OFL-1.1.txt'), 'utf8').trim(),
    '',
    'MIT License (applies to the fonts marked MIT above):',
    '',
    MIT,
    '',
  ];
  for (const [text, ps] of groups) {
    out.push(line, ps.map((p) => `${p.name} ${p.version} (${p.license})${p.repository ? ` – ${p.repository.replace(/^git\+/, '')}` : ''}`).join('\n'), line, '', text, '');
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = notices();
  // Only a path is an argument („--help“ once became a 600 KB file in the repository root).
  if (process.argv[2]?.startsWith('-')) {
    process.stderr.write('Usage: node scripts/third-party-notices.mjs [output file]  (without: to stdout)\n');
    process.exit(2);
  }
  if (process.argv[2]) {
    writeFileSync(process.argv[2], text);
    // Kaveyl Wiki's own licence next to it, as /LICENSE.txt (linked in Settings → Help).
    copyFileSync(join(ROOT, 'LICENSE'), join(dirname(resolve(process.argv[2])), 'LICENSE.txt'));
  }
  else process.stdout.write(text);
}
