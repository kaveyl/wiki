// package.json + package-lock.json for the runtime stage of the Dockerfile: only the native modules
// the server bundle keeps external, with exactly the versions, tarball URLs and integrity hashes
// (transitive and optional platform packages included) from the root package-lock.json, so the
// image installs them with `npm ci` instead of an unpinned `npm install` (audit sec-011).
// Derived at build time, never edited by hand: it cannot drift from the root lockfile.
// Usage: node scripts/runtime-lock.mjs <outDir> <package…>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const NAME = 'kaveyl-wiki-runtime';

/** Node's lookup from a lockfile path: own node_modules first, then each parent's, then the root's. */
export function locate(packages, from, name) {
  for (let base = from; ; ) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i < 0 ? '' : base.slice(0, i);
  }
}

/** Lockfile paths reachable from `names`; optional edges only when `withOptional`. */
function closure(packages, names, withOptional) {
  const seen = new Set();
  const queue = names.map((name) => ['', name, false]);
  while (queue.length) {
    const [from, name, optional] = queue.shift();
    const key = locate(packages, from, name);
    if (!key) {
      if (optional) continue; // platform package not in the lockfile
      throw new Error(`${name} (gebraucht von ${from || 'Wurzel'}) fehlt in package-lock.json`);
    }
    if (seen.has(key)) continue;
    const entry = packages[key];
    if (entry.link) throw new Error(`${key} ist ein Workspace-Link – gehört nicht ins Laufzeit-Image`);
    seen.add(key);
    for (const d of Object.keys(entry.dependencies ?? {})) queue.push([key, d, false]);
    for (const d of Object.keys(entry.peerDependencies ?? {}))
      if (!entry.peerDependenciesMeta?.[d]?.optional) queue.push([key, d, false]);
    if (withOptional) for (const d of Object.keys(entry.optionalDependencies ?? {})) queue.push([key, d, true]);
  }
  return seen;
}

/** { pkg, lock } for `names`, taken from a parsed root package-lock.json (lockfileVersion 3). */
export function runtimeLock(rootLock, names) {
  const src = rootLock.packages;
  if (!src) throw new Error('package-lock.json ohne "packages" (lockfileVersion 3 nötig)');
  const required = closure(src, names, false);
  const all = closure(src, names, true);
  const dependencies = Object.fromEntries(names.map((n) => [n, src[locate(src, '', n)].version]));
  const packages = { '': { name: NAME, dependencies } };
  for (const key of [...all].sort()) {
    // Flags describe the root tree; recompute "optional" for this smaller one.
    const { dev, devOptional, optional, peer, ...entry } = src[key];
    packages[key] = required.has(key) ? entry : { ...entry, optional: true };
  }
  return {
    pkg: { name: NAME, private: true, type: 'module', dependencies },
    lock: { name: NAME, lockfileVersion: 3, requires: true, packages },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, ...names] = process.argv.slice(2);
  if (!out || !names.length) {
    console.error('Aufruf: node scripts/runtime-lock.mjs <Zielordner> <Paket…>');
    process.exit(2);
  }
  const { pkg, lock } = runtimeLock(JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')), names);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(out, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`${out}: ${Object.keys(lock.packages).length - 1} Pakete aus package-lock.json`);
}
