// The runtime lockfile of the Docker image (audit sec-011) is a faithful excerpt of the root
// package-lock.json and covers exactly the modules the server bundle keeps external.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { locate, runtimeLock } from './runtime-lock.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const rootLock = JSON.parse(read('package-lock.json'));
const dockerNames = /runtime-lock\.mjs \S+ ([^\n\\&]+)/.exec(read('Dockerfile'))?.[1].trim().split(/\s+/) ?? [];

describe('runtime-lock', () => {
  it('Dockerfile installs exactly the esbuild externals of the server', () => {
    const build = JSON.parse(read('apps/server/package.json')).scripts.build;
    const externals = [...new Set([...build.matchAll(/--external:(\S+)/g)].map((m) => m[1]))]; // server and watcher bundle
    expect(dockerNames.length).toBeGreaterThan(0);
    expect([...dockerNames].sort()).toEqual([...externals].sort());
  });

  it('copies every entry from the root lockfile, pinned with integrity', () => {
    const { pkg, lock } = runtimeLock(rootLock, dockerNames);
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    for (const n of dockerNames) expect(pkg.dependencies[n]).toBe(rootLock.packages[`node_modules/${n}`].version);
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key) continue;
      const { dev, devOptional, optional, peer, ...src } = rootLock.packages[key];
      const { optional: opt, ...got } = entry;
      expect(got).toEqual(src);
      expect(entry.integrity).toMatch(/^sha512-/);
      expect(entry.resolved).toMatch(/^https:\/\//);
      expect(entry.dev).toBeUndefined();
    }
  });

  it('keeps nested copies and the platform packages of both architectures', () => {
    const { packages } = runtimeLock(rootLock, dockerNames).lock;
    expect(packages['node_modules/better-sqlite3/node_modules/node-addon-api']?.version).toMatch(/^8\./);
    expect(packages['node_modules/node-addon-api']?.version).toMatch(/^7\./);
    for (const arch of ['x64', 'arm64']) expect(packages[`node_modules/@parcel/watcher-linux-${arch}-glibc`]?.optional).toBe(true);
    expect(packages['node_modules/@parcel/watcher'].optional).toBeUndefined();
  });

  it('resolves like Node, recomputes flags and fails on gaps', () => {
    const packages = {
      '': {},
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^1' }, optionalDependencies: { gone: '1', o: '1' } },
      'node_modules/a/node_modules/b': { version: '1.1.0', dependencies: { c: '^1' } },
      'node_modules/b': { version: '2.0.0', dev: true },
      'node_modules/c': { version: '1.0.0', dev: true },
      'node_modules/o': { version: '1.0.0', optional: true, dependencies: { c: '^1' } },
      'node_modules/x': { version: '1.0.0', dependencies: { missing: '1' } },
    };
    expect(locate(packages, 'node_modules/a/node_modules/b', 'c')).toBe('node_modules/c');
    const { lock } = runtimeLock({ packages }, ['a']);
    expect(Object.keys(lock.packages)).toEqual(['', 'node_modules/a', 'node_modules/a/node_modules/b', 'node_modules/c', 'node_modules/o']);
    expect(lock.packages['node_modules/c']).toEqual({ version: '1.0.0' });
    expect(lock.packages['node_modules/o'].optional).toBe(true);
    expect(() => runtimeLock({ packages }, ['x'])).toThrow(/missing/);
  });
});
