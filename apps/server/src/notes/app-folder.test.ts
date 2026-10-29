// The app folder (`.kaveyl-wiki`) of a source is no way out of it: templates and the folder trash never follow
// a symbolic link there (AD-047), whatever part of the path is the link.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MountManager } from '../mounts/manager.js';
import type { Mount } from '../mounts/model.js';
import { listTemplates, readTemplate, saveAsTemplate } from './templates.js';
import { folderItems, folderTrashFile, moveToTrash, purgeFolderTrash, restoreFromFolder } from './trash.js';

let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-appfolder-'));
  root = join(base, 'quelle');
  outside = join(base, 'draussen');
  mkdirSync(root);
  mkdirSync(outside);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const mount = () => ({ id: 'm', name: 'Q', type: 'local', source: root, subpath: '', options: { readonly: false } }) as unknown as Mount;
const manager = { touched: async () => undefined } as unknown as MountManager;
const author = { name: 'T', email: 't@example.test' };

describe('templates', () => {
  it('a template that is a link is neither read nor listed', async () => {
    put(outside, 'geheim.md', 'GEHEIM-AUSSERHALB\n');
    mkdirSync(join(root, '.kaveyl-wiki', 'templates'), { recursive: true });
    symlinkSync(join(outside, 'geheim.md'), join(root, '.kaveyl-wiki', 'templates', 'probe.md'));
    await expect(readTemplate(mount(), base, 'probe.md')).rejects.toThrow();
    expect(await listTemplates(mount(), base)).toEqual([]);
  });

  it.each([
    ['the template folder', '.kaveyl-wiki/templates'],
    ['the app folder', '.kaveyl-wiki'],
  ])('%s as a link: nothing read, listed or written there', async (_what, rel) => {
    const target = rel === '.kaveyl-wiki' ? join(outside, 'templates', 'probe.md') : join(outside, 'probe.md');
    put(outside, target.slice(outside.length + 1), 'GEHEIM-AUSSERHALB\n');
    mkdirSync(join(root, rel, '..'), { recursive: true });
    symlinkSync(outside, join(root, rel));
    const before = readdirSync(outside, { recursive: true }).sort();
    await expect(readTemplate(mount(), base, 'probe.md')).rejects.toThrow();
    expect(await listTemplates(mount(), base)).toEqual([]);
    await expect(saveAsTemplate(manager, base, mount(), '# neu\n', 'Neu', author)).rejects.toThrow();
    expect(readdirSync(outside, { recursive: true }).sort()).toEqual(before);
  });
});

describe('folder trash', () => {
  const ID = '1700000000000-0badc0de';
  const entry = (dir: string) => {
    put(dir, `${ID}/meta.json`, JSON.stringify({ path: 'x.md', isDir: false, files: ['x.md'], date: '2026-01-01T00:00:00.000Z', author: 'T' }));
    put(dir, `${ID}/files/x.md`, 'GEHEIM-AUSSERHALB\n');
  };

  it.each([
    ['the trash folder', '.kaveyl-wiki/trash'],
    ['the app folder', '.kaveyl-wiki'],
  ])('%s as a link: no entries listed, read, restored, emptied or added', async (_what, rel) => {
    entry(rel === '.kaveyl-wiki' ? join(outside, 'trash') : outside);
    mkdirSync(join(root, rel, '..'), { recursive: true });
    symlinkSync(outside, join(root, rel));
    put(root, 'a.md', '# a\n');
    const before = readdirSync(outside, { recursive: true }).sort();

    expect(await folderItems(root)).toEqual([]);
    expect(await folderTrashFile(root, ID, 'x.md')).toBeNull();
    expect((await restoreFromFolder(root, ID)).restored).toEqual([]);
    expect(existsSync(join(root, 'x.md'))).toBe(false);
    await purgeFolderTrash(root, null);
    await expect(moveToTrash(root, 'a.md', false, ['a.md'], 'T')).rejects.toThrow();
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('# a\n');
    expect(readdirSync(outside, { recursive: true }).sort()).toEqual(before);
  });

  it('an entry folder that is a link is not followed', async () => {
    entry(outside);
    mkdirSync(join(root, '.kaveyl-wiki', 'trash'), { recursive: true });
    symlinkSync(join(outside, ID), join(root, '.kaveyl-wiki', 'trash', ID));
    expect(await folderItems(root)).toEqual([]);
    expect(await folderTrashFile(root, ID, 'x.md')).toBeNull();
    await purgeFolderTrash(root, null); // removes the link itself, not what it points to
    expect(existsSync(join(root, '.kaveyl-wiki', 'trash', ID))).toBe(false);
    expect(readFileSync(join(outside, ID, 'files', 'x.md'), 'utf8')).toBe('GEHEIM-AUSSERHALB\n');
  });
});
