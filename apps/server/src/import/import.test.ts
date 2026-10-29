// Import from other programs (docs/PLAN-IMPORT.md): reading the ZIP safely, names, links, and the formats –
// HedgeDoc with a real export of HedgeDoc 1.12.0 (invented content, fixtures/hedgedoc-1.12.0.zip).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { buildPlan } from './build.js';
import { detectFormat, formatById } from './formats/index.js';
import { convertBody } from './formats/hedgedoc.js';
import { convertPage, formatDate } from './formats/logseq.js';
import { convertCallouts, inlineTags, markdownLinks } from './formats/obsidian.js';
import { footnotesHtml, formulas, Kept } from './formats/trilium.js';
import { Readable } from 'node:stream';
import { readdir } from 'node:fs/promises';
import { folderName, ImportService } from './service.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { htmlToMarkdown, imgTagsToMarkdown } from './html.js';
import { fetchable, fetchRemote, RemoteError, webFetcher } from './remote.js';
import { convertExport, runConversion } from './convert.js';
import { PassThrough } from 'node:stream';
import { build as esbuild } from 'esbuild';
import { linksToText, outsideCode } from './text.js';
import type { Draft, Plan } from './types.js';
import { IMPORT_LIMITS, ImportZip, type SourceFile } from './zip.js';

// Shared CI runners (GitHub sets CI) are 2–3× slower than a desk machine and vary; the limits catch blow-ups, not that.
const SLOW = process.env.CI ? 4 : 1;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kaveyl-import-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function zipFile(files: Record<string, string | Uint8Array>): Promise<string> {
  const file = join(dir, `t${n++}.zip`);
  await writeFile(file, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));
  return file;
}

async function planOf(files: Record<string, string | Uint8Array>, format?: string): Promise<{ plan: Plan; format: string | null; zip: ImportZip }> {
  const zip = await ImportZip.open(await zipFile(files));
  const id = format ?? (await detectFormat(zip.files));
  const plan = id ? buildPlan(await formatById(id)!.convert(zip.files), { folderNote: 'index.md', blocked: new Set(['exe', 'sh']) }) : { notes: [], files: [], folders: 0, warnings: [], remote: { count: 0, servers: [] } };
  await zip.close();
  return { plan, format: id, zip };
}

const note = (plan: Plan, path: string) => plan.notes.find((x) => x.path === path)?.content;

describe('reading the ZIP', () => {
  it('keeps every path inside the import and leaves system files out', async () => {
    const zip = await ImportZip.open(await zipFile({ '../../etc/evil.md': 'x', '/abs/olut.md': 'y', 'a/../../b.md': 'z', 'ok/n.md': 'n', '__MACOSX/ok/._n.md': 'j', 'ok/.DS_Store': 'j' }));
    expect(zip.files.map((f) => f.path).sort()).toEqual(['abs/olut.md', 'ok/n.md']);
    expect(zip.skipped.sort()).toEqual(['../../etc/evil.md', 'a/../../b.md']);
    await zip.close();
  });

  it('drops the one folder around everything and remembers its name', async () => {
    const zip = await ImportZip.open(await zipFile({ 'Mein Wiki/a.md': '# A', 'Mein Wiki/sub/b.md': '# B' }));
    expect(zip.rootName).toBe('Mein Wiki');
    expect(zip.files.map((f) => f.path).sort()).toEqual(['a.md', 'sub/b.md']);
    expect(await zip.files.find((f) => f.path === 'a.md')!.text()).toBe('# A');
    await zip.close();
  });

  it('refuses what is no ZIP, too many entries, and leaves encrypted entries out', async () => {
    const notZip = join(dir, 'kein.zip');
    await writeFile(notZip, 'das ist kein zip');
    await expect(ImportZip.open(notZip)).rejects.toThrow('kein lesbares ZIP-Archiv');

    const many: Record<string, string> = {};
    for (let i = 0; i <= IMPORT_LIMITS.entries; i++) many[`n${i}.md`] = '';
    await expect(ImportZip.open(await zipFile(many))).rejects.toThrow(`mehr als ${IMPORT_LIMITS.entries} Dateien`);
    // Refused from the end record alone – before zip.js reads the directory (which would cost gigabytes for millions).
    const before = IMPORT_LIMITS.entries;
    IMPORT_LIMITS.entries = 3;
    try {
      await expect(ImportZip.open(await zipFile({ 'a.md': '', 'b.md': '', 'c/': '', 'd.md': '', 'e.md': '' }))).rejects.toThrow('mehr als 3 Dateien');
    } finally {
      IMPORT_LIMITS.entries = before;
    }

    const w = new ZipWriter(new Uint8ArrayWriter());
    await w.add('offen.md', new Uint8ArrayReader(strToU8('# offen')));
    await w.add('geheim.md', new Uint8ArrayReader(strToU8('# geheim')), { password: 'pw-0001', encryptionStrength: 3 });
    const enc = join(dir, 'enc.zip');
    await writeFile(enc, await w.close());
    const zip = await ImportZip.open(enc);
    expect(zip.files.map((f) => f.path)).toEqual(['offen.md']);
    expect(zip.skipped).toEqual(['geheim.md']);
    await zip.close();
  });

  it('reads binary data and text apart: no text from files with NUL bytes or broken UTF-8', async () => {
    const zip = await ImportZip.open(await zipFile({ 'a.md': '\uFEFF# Mit BOM', 'b.md': new Uint8Array([0x23, 0x20, 0xff, 0xfe]), 'c.png': new Uint8Array([137, 80, 78, 71, 0, 1]) }));
    const by = (p: string) => zip.files.find((f) => f.path === p)!;
    expect(await by('a.md').text()).toBe('# Mit BOM');
    expect(await by('b.md').text()).toBeNull();
    expect(await by('c.png').text()).toBeNull();
    expect([...(await by('c.png').bytes())]).toEqual([137, 80, 78, 71, 0, 1]);
    await zip.close();
  });
});

describe('names, files and links (all formats)', () => {
  const src = (path: string): SourceFile => ({ path, size: 1, modified: new Date(), bytes: async () => new Uint8Array([1]), text: async () => null });
  const build = (draft: Draft) => buildPlan(draft, { folderNote: 'index.md', blocked: new Set(['exe']) });

  it('makes names safe and unique (also by case), never over the report', () => {
    const plan = build({
      notes: [
        { from: 'a.md', dir: ['Ordner: eins'], name: 'Plan / v2', content: '' },
        { from: 'b.md', dir: ['Ordner: eins'], name: 'plan - v2', content: '' },
        { from: 'c.md', dir: [], name: 'Import-Bericht', content: '' },
        { from: 'd.md', dir: [], name: '..', content: '' },
      ],
      files: [],
      warnings: [],
    });
    expect(plan.notes.map((x) => x.path)).toEqual(['Ordner - eins/Plan - v2.md', 'Ordner - eins/plan - v2 2.md', 'Import-Bericht 2.md', 'Neue Notiz.md']);
    expect(plan.folders).toBe(1);
  });

  it('puts files the app would not show next to a note into assets/, leaves blocked types out', () => {
    const plan = build({
      notes: [{ from: 'n.md', dir: [], name: 'n', content: '![b](bild.png) [d](docs/liste.xlsx) [x](tool.exe)' }],
      files: [
        { from: 'bild.png', dir: [], name: 'bild.png', source: src('bild.png') },
        { from: 'docs/liste.xlsx', dir: ['docs'], name: 'liste.xlsx', source: src('docs/liste.xlsx') },
        { from: 'tool.exe', dir: [], name: 'tool.exe', source: src('tool.exe') },
      ],
      warnings: [],
    });
    expect(plan.files.map((f) => f.path)).toEqual(['bild.png', 'docs/assets/liste.xlsx']);
    expect(plan.notes[0]!.content).toBe('![b](bild.png) [d](docs/assets/liste.xlsx) [x](tool.exe)');
    expect(plan.warnings.map((w) => [w.text, w.items])).toEqual([
      ['Dateien mit gesperrter Dateiendung – nicht übernommen', ['tool.exe']],
    ]);
  });

  it('follows renamed notes in links (relative, with anchor, without .md) and names the ones that lead nowhere', () => {
    const plan = build({
      notes: [
        { from: 'a/Start: hier.md', dir: ['a'], name: 'Start: hier', content: '# S\n[b](../b/Ziel%3F.md#teil-2) [ohne](../b/Ziel?) [fehlt](nix.md) [web](https://x.org/a.md)' },
        { from: 'b/Ziel?.md', dir: ['b'], name: 'Ziel?', content: '[zurück](<../a/Start: hier.md>)' },
      ],
      files: [],
      warnings: [],
    });
    expect(plan.notes.map((x) => x.path)).toEqual(['a/Start - hier.md', 'b/Ziel.md']);
    expect(note(plan, 'a/Start - hier.md')).toBe('# S\n[b](../b/Ziel.md#teil-2) [ohne](../b/Ziel) [fehlt](nix.md) [web](https://x.org/a.md)');
    expect(note(plan, 'b/Ziel.md')).toBe('[zurück](<../a/Start - hier.md>)');
    expect(plan.warnings).toEqual([{ text: 'Links auf Seiten oder Dateien, die nicht im Export sind', notes: ['a/Start - hier.md'], items: [] }]);
  });

  it('keeps links working for names with # and %, absolute links of the export, folders that differ only in case', () => {
    const plan = build({
      notes: [
        { from: 'Sitzung #3.md', dir: [], name: 'Sitzung #3', content: '# Drei' },
        { from: 'Start.md', dir: [], name: 'Start', content: '[Drei](Sitzung%20%233.md) [abs](/Sub/Seite.md) [[100% sicher]]' },
        { from: 'Sub/Seite.md', dir: ['Sub'], name: 'Seite', content: 'x' },
        { from: '100% sicher.md', dir: [], name: '100% sicher', content: 'y' },
        { from: 'sub/Andere.md', dir: ['sub'], name: 'Andere', content: 'z' },
      ],
      files: [],
      warnings: [],
      wikiLinks: true,
    });
    expect(note(plan, 'Start.md')).toBe('[Drei](Sitzung%20%233.md) [abs](Sub/Seite.md) [100% sicher](100%25%20sicher.md)');
    expect(plan.notes.map((n) => n.path)).toContain('Sub/Andere.md');
    expect(plan.folders).toBe(1);
    expect(plan.warnings).toEqual([]);
  });

  it('turns [[wiki links]] into Markdown links: alias, heading, picture, nearest of several, missing ones stay', () => {
    const plan = build({
      notes: [
        { from: 'x/Home.md', dir: ['x'], name: 'Home', content: '[[Rezept]] [[rezept|das Rezept]] [[Rezept#Zutaten & Menge]] ![[foto.png|200]] ![[Rezept]] [[Gibts nicht]] `[[code]]` [[y/Rezept]]\n```\n[[Rezept]]\n```\n' },
        { from: 'x/Rezept.md', dir: ['x'], name: 'Rezept', content: '' },
        { from: 'y/Rezept.md', dir: ['y'], name: 'Rezept', content: '' },
      ],
      files: [{ from: 'x/foto.png', dir: ['x'], name: 'foto.png', source: src('x/foto.png') }],
      warnings: [],
      wikiLinks: true,
    });
    expect(note(plan, 'x/Home.md')).toBe(
      '[Rezept](Rezept.md) [das Rezept](Rezept.md) [Rezept – Zutaten & Menge](Rezept.md#zutaten--menge) ![](foto.png) [Rezept](Rezept.md) [[Gibts nicht]] `[[code]]` [y/Rezept](../y/Rezept.md)\n```\n[[Rezept]]\n```\n',
    );
    expect(plan.warnings.map((w) => [w.text, w.notes])).toEqual([
      ['[[Links]] auf Seiten, die nicht im Export sind – sie bleiben als Text stehen', ['x/Home.md']],
      ['[[Links]] auf Namen, die es mehrfach gibt – die nächstgelegene Seite wurde gewählt', ['x/Home.md']],
    ]);
  });

  it('changes text only outside code', () => {
    const up = (s: string) => outsideCode(s, (p) => p.toUpperCase());
    expect(up('a `b` c\n```js\nd\n```\ne ``f`` g\n~~~\nh\n~~~\n')).toBe('A `b` C\n```js\nd\n```\nE ``f`` G\n~~~\nh\n~~~\n');
    // A lone backtick is text, not a code span over paragraphs; ```x``` on one line is a code span, no fence.
    expect(up('a ` b\n\nc `d`\n```x```\ne\n')).toBe('A ` B\n\nC `d`\n```x```\nE\n');
    // A fence inside a list item (Logseq writes every block as one) is code too.
    expect(up('- ```js\n  d\n  ```\n- e\n\t- ```\n\t  f\n\t  ```\n')).toBe('- ```js\n  d\n  ```\n- E\n\t- ```\n\t  f\n\t  ```\n');
  });

  it('stops an upload that grows beyond the limit while it streams in, and keeps nothing of it', async () => {
    const before = IMPORT_LIMITS.upload;
    IMPORT_LIMITS.upload = 10;
    const service = new ImportService(join(dir, 'uploads'));
    try {
      await expect(service.receive(Readable.from([Buffer.from('123456'), Buffer.from('789012')]), { userId: 'u', mountId: 'm', parent: '', fileName: 'x.zip' })).rejects.toThrow('größer als 500 MB');
      expect(await readdir(join(dir, 'uploads'))).toEqual([]);
      const ok = await service.receive(Readable.from([Buffer.from('12345')]), { userId: 'u', mountId: 'm', parent: '', fileName: 'x.zip' });
      expect(service.get(ok.token, 'u').file).toBe(ok.file);
      expect(() => service.get(ok.token, 'jemand')).toThrow('abgelaufen');
      // A second upload of the same person replaces the first.
      const next = await service.receive(Readable.from([Buffer.from('1')]), { userId: 'u', mountId: 'm', parent: '', fileName: 'y.zip' });
      expect(await readdir(join(dir, 'uploads'))).toEqual([`${next.token}.zip`]);
      await service.sweep(true);
      expect(await readdir(join(dir, 'uploads'))).toEqual([]);
    } finally {
      IMPORT_LIMITS.upload = before;
    }
  });

  it('takes one upload per person and two in all at a time; the disk must keep room', async () => {
    const service = new ImportService(join(dir, 'parallel'));
    const input = (userId: string) => ({ userId, mountId: 'm', parent: '', fileName: 'x.zip' });
    const slow = new PassThrough();
    const first = service.receive(slow, input('anna'));
    await expect(service.receive(Readable.from([Buffer.from('1')]), input('anna'))).rejects.toMatchObject({ statusCode: 409 });
    const other = new PassThrough();
    const second = service.receive(other, input('ben'));
    await expect(service.receive(Readable.from([Buffer.from('1')]), input('cleo'))).rejects.toThrow('Gerade laden schon andere hoch');
    slow.end('1');
    other.end('2');
    await Promise.all([first, second]);
    await expect(service.receive(Readable.from([Buffer.from('1')]), input('cleo'), Number.MAX_SAFE_INTEGER)).rejects.toThrow('Zu wenig freier Speicherplatz');
    await service.sweep(true);
  });

  it('removes links that would run code; pictures as data stay', () => {
    const plan = buildPlan(
      {
        notes: [{ from: 'a.md', dir: [], name: 'a', content: '[Klick](javascript:alert%281%29) ![x](data:image/png;base64,AAAA) [d](data:text/html,<b>) <javascript:alert(1)> `[c](javascript:x)`\n\n[r]: javascript:alert(2)\n' }],
        files: [],
        warnings: [],
      },
      { folderNote: 'index.md', blocked: new Set() },
    );
    expect(note(plan, 'a.md')).toBe('Klick ![x](data:image/png;base64,AAAA) d  `[c](javascript:x)`\n\n\n');
    expect(plan.warnings.map((w) => w.text)).toEqual(['Links mit Skript-Adressen (javascript:, data:) – die Adresse wurde entfernt, der Text bleibt']);
  });

  it('converts in a worker with time and memory limits, the same as in the process', async () => {
    const worker = join(dir, 'import-worker.mjs');
    await esbuild({ entryPoints: [join(import.meta.dirname, 'worker.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: worker, logLevel: 'silent', external: ['better-sqlite3', '@parcel/watcher'], banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" } });
    const input = { file: join(import.meta.dirname, 'fixtures', 'logseq-0.10.15-graph.zip'), folderNote: 'index.md', blocked: [], fetch: false };
    const inWorker = await runConversion(input, { timeoutMs: 60_000, worker });
    expect(inWorker).toEqual(await convertExport(input));
    expect(inWorker).toMatchObject({ format: 'logseq', rootName: 'Alpenrose' });
    // Errors of the import come back as they are; too long or too much memory end the worker, not the server.
    await expect(runConversion({ ...input, file: join(dir, 'fehlt.zip') }, { timeoutMs: 60_000, worker })).rejects.toThrow('Das Umwandeln des Exports ist fehlgeschlagen');
    const notZip = join(dir, 'kein2.zip');
    await writeFile(notZip, 'kein zip');
    await expect(runConversion({ ...input, file: notZip }, { timeoutMs: 60_000, worker })).rejects.toThrow('kein lesbares ZIP-Archiv');
    await expect(runConversion(input, { timeoutMs: 5, worker })).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('dauerte zu lange') });
    const big = await zipFile(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`n${i}.md`, `[a](b.md)\n`.repeat(200_000)])));
    await expect(runConversion({ ...input, file: big }, { timeoutMs: 120_000, worker, memoryMb: 32 })).rejects.toThrow('zu viel Speicher');
  }, 180_000);

  it('names the new folder after the export, not after a generic download', () => {
    expect(folderName('archive.zip', null, 'HedgeDoc')).toBe('Import aus HedgeDoc');
    expect(folderName('C:\\Downloads\\Vereinswiki.zip', null, 'HedgeDoc')).toBe('Vereinswiki');
    expect(folderName('export (2).zip', 'Mein Graph', 'Logseq')).toBe('Mein Graph');
  });
});

describe('HedgeDoc', () => {
  it('converts a real export of HedgeDoc 1.12.0', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'hedgedoc-1.12.0.zip'));
    expect(await detectFormat(zip.files)).toBe('hedgedoc');
    const plan = buildPlan(await formatById('hedgedoc')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    const paths = plan.notes.map((x) => x.path);
    // 61 notes in the export, one empty; names from HedgeDoc's title rule, made safe the Kaveyl Wiki way.
    expect(paths).toHaveLength(60);
    expect(paths).toEqual(
      expect.arrayContaining([
        'Hütte 0 - Tiroler Haus.md',
        'Protokoll.md',
        'Protokoll 2.md',
        'Protokoll 3.md',
        'Titel - aus dem Frontmatter - mit Schrägstrich.md',
        'Größe & Gewicht - Rucksack - 50 l - Test.md',
        'Nur Text ohne Überschrift und ohne Titel.md',
        'versteckt.md',
        '🏔️ Gipfelbuch.md',
      ]),
    );
    expect(paths.find((p) => p.startsWith('Sehr langer Titel'))!.length).toBeLessThanOrEqual(123);
    expect(note(plan, 'Titel - aus dem Frontmatter - mit Schrägstrich.md')).toMatch(/^---\ntags: \[a, "b c"\]\n---\n# Andere Überschrift/);
    expect(note(plan, 'Hinweisboxen.md')).toContain('> [!TIP]\n> Tour erfolgreich abgeschlossen!');
    expect(note(plan, 'Hinweisboxen.md')).toContain('<details>\n<summary>Ausrüstung (aufklappen)</summary>\n\n- Helm');
    expect(note(plan, 'Willkommen beim Wanderverein Alpenrose.md')).not.toContain('[TOC]');
    expect(note(plan, 'Medien.md')).toContain('[YouTube](https://www.youtube.com/watch?v=1G4isv_Fylg)');
    expect(note(plan, 'Medien.md')).toMatch(/!\[GIF\]\(http:\/\/127\.0\.0\.1:8097\/uploads\/[\w-]+\.gif\)/);
    expect(note(plan, 'Linksammlung.md')).toContain('[Packliste](http://127.0.0.1:8097/qHTRHbxMToe7wbmn1khO7Q)');
    expect(note(plan, 'Code und Formeln.md')).toContain('```mermaid');
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['Links auf Seiten oder Dateien, die nicht im Export sind', 1],
      ['Notizen mit Bildern auf dem alten Server – der Export enthält sie nicht, sie bleiben Web-Links', 3],
      ['Links auf andere HedgeDoc-Notizen – HedgeDoc exportiert keine Notiz-Adressen, die Links zeigen weiter auf den alten Server', 44],
      ['Folien – sie erscheinen als normaler Text', 1],
      ['Leere Notizen – nicht übernommen', 1],
    ]);
    expect(plan.remote).toEqual({ count: 4, servers: ['127.0.0.1:8097'] });
  });

  it('fetches the pictures from the old server on request: next to the note, linked; the rest is named', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'hedgedoc-1.12.0.zip'));
    const draft = await formatById('hedgedoc')!.convert(zip.files);
    await zip.close();
    const urls = draft.remote!.map((r) => r.url);
    const asked: string[] = [];
    await fetchRemote(draft, async (url) => {
      asked.push(url);
      if (url.endsWith('.gif')) throw new RemoteError('HTTP 404');
      return strToU8(`bytes of ${url}`);
    });
    expect(asked.sort()).toEqual([...urls].sort());
    const plan = buildPlan(draft, { folderNote: 'index.md', blocked: new Set() });
    expect(plan.files.map((f) => f.path)).toHaveLength(3);
    // Named after the picture's text, not after HedgeDoc's random id.
    expect(plan.files.map((f) => f.path).sort()).toEqual(['assets/Gipfelfoto.jpg', 'assets/Logo.svg', 'assets/PNG.png']);
    expect(note(plan, 'Medien.md')).toContain('![PNG](assets/PNG.png)');
    expect(note(plan, 'Touren 2026 – Alpen.md')).toContain('![Gipfelfoto](assets/Gipfelfoto.jpg)');
    const medien = note(plan, 'Medien.md')!;
    expect(medien).toMatch(/!\[GIF\]\(http:\/\/127\.0\.0\.1:8097\/uploads\/[\w-]+\.gif\)/);
    expect(plan.warnings.find((w) => w.text.startsWith('Notizen mit Bildern, die sich vom alten Server nicht holen ließen'))!.notes).toEqual(['Medien.md']);
    expect(plan.remote.count).toBe(1);
  });

  it('gives a server up after it did not answer once', async () => {
    const draft: Draft = {
      notes: [{ from: 'a.md', dir: [], name: 'a', content: '![](http://alt.invalid/uploads/1.png) ![](http://alt.invalid/uploads/2.png) ![](http://neu.invalid/uploads/3.png)' }],
      files: [],
      warnings: [],
      remote: ['http://alt.invalid/uploads/1.png', 'http://alt.invalid/uploads/2.png', 'http://neu.invalid/uploads/3.png'].map((url) => ({ url, notes: ['a.md'] })),
    };
    const asked: string[] = [];
    await fetchRemote(draft, async (url) => {
      asked.push(url);
      if (url.includes('alt.invalid')) throw new RemoteError('server not reachable', true);
      return strToU8('x');
    });
    // Four at a time: both pictures of the dead server may have started before it failed – never more.
    expect(asked.filter((u) => u.includes('alt.invalid')).length).toBeLessThanOrEqual(2);
    expect(draft.remote!.map((r) => r.url)).toEqual(['http://alt.invalid/uploads/1.png', 'http://alt.invalid/uploads/2.png']);
    expect(draft.notes[0]!.content).toContain('![](assets/3.png)');
  });

  it('fetches only uploads: right path, picture or PDF, no redirect, not from this machine', async () => {
    expect(fetchable('https://hd.example/uploads/upload_ab-12.png')).toBe(true);
    expect(fetchable('https://hd.example/uploads/plan.PDF')).toBe(true);
    for (const bad of ['https://hd.example/uploads/x.html', 'https://hd.example/admin/x.png', 'https://hd.example/uploads/../x.png', 'https://u:p@hd.example/uploads/x.png', 'https://hd.example/uploads/x.png?a=1', 'file:///uploads/x.png', 'ftp://hd.example/uploads/x.png'])
      expect(fetchable(bad), bad).toBe(false);
    const server = createServer((req, res) => {
      if (req.url === '/uploads/ok.png') res.writeHead(200, { 'content-type': 'image/png' }).end('PNG');
      else if (req.url === '/uploads/moved.png') res.writeHead(302, { location: '/uploads/ok.png' }).end();
      else if (req.url === '/uploads/page.png') res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/uploads`;
    try {
      const local = webFetcher({ allowLocal: true });
      expect(Buffer.from(await local(`${base}/ok.png`)).toString()).toBe('PNG');
      for (const name of ['moved.png', 'page.png', 'gone.png']) await expect(local(`${base}/${name}`), name).rejects.toMatchObject({ server: false });
      // Without the test switch an address on this machine is refused before anything is sent.
      await expect(webFetcher()(`${base}/ok.png`)).rejects.toMatchObject({ message: 'address on this machine', server: true });
      await expect(webFetcher()(`http://[::ffff:127.0.0.1]:1/uploads/x.png`)).rejects.toMatchObject({ server: true });
    } finally {
      server.close();
    }
  });

  it('turns HedgeDoc syntax into Markdown, but not inside code', () => {
    expect(convertBody(':::warning\nAchtung\n\nzwei\n:::\n```\n:::info\n[TOC]\n```\n[TOC]\n{%vimeo 42 %}')).toBe('> [!WARNING]\n> Achtung\n>\n> zwei\n```\n:::info\n[TOC]\n```\n[Vimeo](https://vimeo.com/42)');
    expect(convertBody(':::spoiler <b>x</b>\ny\n:::')).toBe('<details>\n<summary>&lt;b&gt;x&lt;/b&gt;</summary>\n\ny\n\n</details>');
    expect(convertBody(':::info\nnie geschlossen')).toBe(':::info\nnie geschlossen');
    // A box with a code block in it (the `:::` inside the code closes nothing).
    expect(convertBody(':::info\nVorher\n```\n:::\n```\n:::')).toBe('> [!NOTE]\n> Vorher\n> ```\n> :::\n> ```');
  });

  it('is recognised only for flat Markdown exports; a folder tree is a Markdown folder', async () => {
    expect((await planOf({ 'Untitled.md': 'x', 'a.md': '# A' })).format).toBe('hedgedoc');
    expect((await planOf({ 'a.md': '# A', 'b.md': 'nichts Besonderes' })).format).toBe('markdown');
    expect((await planOf({ 'a/b.md': ':::info\nx\n:::', 'c/d.md': 'x' })).format).toBe('markdown');
    expect((await planOf({ 'bild.png': 'x' })).format).toBeNull();
  });
});

describe('Joplin', () => {
  it('converts a real export of Joplin 3.7.1 (Markdown + Front Matter)', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'joplin-3.7.1-md-frontmatter.zip'));
    expect(zip.rootName).toBe('Joplin-Export');
    expect(await detectFormat(zip.files)).toBe('joplin');
    const plan = buildPlan(await formatById('joplin')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    const paths = plan.notes.map((x) => x.path);
    // 56 notes (the one in Joplin's trash is not exported); notebooks become folders, names from the title.
    expect(paths).toHaveLength(56);
    expect(paths).toEqual(
      expect.arrayContaining([
        'Verein Alpenrose/Touren/2026/Sommer & Herbst/Dachstein Südwand.md',
        'Verein Alpenrose/Vorstand/Größe - 50 l - Rucksack - Test.md',
        'Verein Alpenrose/Vorstand/Notiz.md',
        'Verein Alpenrose/Vorstand/Notiz 2.md',
        'Verein Alpenrose/Notiz ohne Titel.md',
        'Verein Alpenrose/Web-Ausschnitt (HTML).md',
        'Privat _ Rezepte/Rezept - Kaiserschmarrn.md',
      ]),
    );
    expect(paths.every((p) => !/\s\.md$/.test(p))).toBe(true);
    // Resources next to the first note that shows them; links follow.
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      'Verein Alpenrose/Touren/2026/Sommer & Herbst/assets/Foto-vom-Berg.jpg',
      'Verein Alpenrose/Touren/2026/assets/Tourenplan-2026.pdf',
      'Verein Alpenrose/assets/animiert.gif',
      'Verein Alpenrose/assets/bild-test.png',
      'Verein Alpenrose/assets/logo.svg',
    ]);
    const plan2026 = note(plan, 'Verein Alpenrose/Touren/2026/Tourenplan 2026.md')!;
    expect(plan2026).toContain('![Gipfel](Sommer%20&%20Herbst/assets/Foto-vom-Berg.jpg)');
    expect(plan2026).toContain('[Tourenplan 2026.pdf](assets/Tourenplan-2026.pdf)');
    expect(plan2026).toContain('[Beitritt](../../Willkommen.md#beitritt)');
    expect(plan2026).not.toMatch(/^title:/m);
    expect(plan2026).toMatch(/^tags:\n  - 2026\n  - touren$/m);
    expect(note(plan, 'Verein Alpenrose/Willkommen.md')).toContain('![Logo](assets/logo.svg)');
    expect(note(plan, 'Verein Alpenrose/Touren/Archiv/Protokoll.md')).toContain('[neues Protokoll](../../Vorstand/Protokoll.md)');
    expect(note(plan, 'Verein Alpenrose/Bilder.md')).toContain('![PNG](assets/bild-test.png) ![GIF](assets/animiert.gif)\n\nDasselbe Logo wie auf der Startseite: ![Logo](assets/logo.svg)\n\n![](assets/bild-test.png)\n');
    expect(note(plan, 'Verein Alpenrose/Vorstand/Hütte buchen.md')).toContain('todo: true\ndone: false\ndue: 2026-05-31 00:00:00Z');
    expect(note(plan, 'Verein Alpenrose/Vorstand/Mitgliedsbeiträge einsammeln.md')).toContain('todo: true\ndone: true');
    // HTML notes become Markdown; the script is gone with its content.
    expect(note(plan, 'Verein Alpenrose/Web-Ausschnitt (HTML).md')).toMatch(/---\n\n# Geklippt\n\nEine \*\*HTML-Notiz\*\* aus dem Web Clipper mit \[Link\]\(https:\/\/example\.invalid\)\.\n$/);
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['Links auf Seiten oder Dateien, die nicht im Export sind', 1],
      ['To-dos – erledigt oder offen und die Fälligkeit stehen im Frontmatter (todo, done, due)', 2],
      ['HTML-Notizen (Web Clipper) – in Markdown umgewandelt, bitte Aussehen prüfen', 1],
    ]);
  });

  it('turns HTML into Markdown without scripts, styles or forms; <img> tags into pictures', () => {
    const md = htmlToMarkdown('<h2>T</h2><script>alert(1)</script><style>p{}</style><form><input value="x"></form><table><tr><td>A</td><td>B|x</td></tr><tr><td>1</td><td>2</td></tr></table><ul><li>a<ul><li>b</li></ul></li></ul>');
    expect(md).toBe('## T\n\n| A | B\\|x |\n| - | ---- |\n| 1 | 2    |\n\n- a\n  - b');
    expect(imgTagsToMarkdown(`<img src=":/abc" alt="Gipfel [1]" width="120"> <img alt='x' src='a b.png'/> <img width=3>`)).toBe('![Gipfel \\[1\\]](:/abc) ![x](<a b.png>) <img width=3>');
  });

  it('is recognised by its resources folder or its own frontmatter', async () => {
    expect((await planOf({ 'Buch/a.md': '# A', '_resources/x.png': 'x' })).format).toBe('joplin');
    expect((await planOf({ 'Buch/a.md': '---\ntitle: A\nupdated: 2026-01-01 10:00:00Z\ncreated: 2026-01-01 10:00:00Z\n---\n', 'Buch/b.md': 'x' })).format).toBe('joplin');
  });
});

describe('Logseq', () => {
  it('converts a real graph of Logseq 0.10.15', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'logseq-0.10.15-graph.zip'));
    expect(zip.rootName).toBe('Alpenrose');
    expect(await detectFormat(zip.files)).toBe('logseq');
    const plan = buildPlan(await formatById('logseq')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    const paths = plan.notes.map((x) => x.path);
    // 49 pages and journals written by Logseq; the Org page stays out, „Leer“ has no file at all.
    expect(paths).toHaveLength(49);
    expect(paths).toEqual(
      expect.arrayContaining([
        'Journal/2026-10-28.md',
        'Touren.md',
        'Touren/2026.md',
        'Touren/2026/Sommer.md',
        'Hütten/Tirol/Ost/Hütte 2.md',
        'Vorstand/Protokoll März.md',
        'Größe - 50 l - Rucksack - Test.md',
        '🏔️ Gipfelbuch.md',
      ]),
    );
    // Pasted files lose Logseq's time stamp in the name.
    expect(plan.files.map((f) => f.path).sort()).toEqual(['assets/animiert.gif', 'assets/bild-test.png', 'assets/foto-berg.jpg', 'assets/logo.svg', 'assets/tourenplan.pdf']);
    const start = note(plan, 'Willkommen.md')!;
    expect(start).toMatch(/^---\naliases: \[Start, Startseite\]\ntags: \[verein, Wichtige Seiten\]\n---\n/);
    expect(start).toContain('- Wir wandern seit 1987. ![Logo](assets/logo.svg)');
    expect(start).toContain('[Vorstand/Protokoll März](Vorstand/Protokoll%20März.md)');
    expect(start).toContain('[[Hütten|die Hütten]]');
    expect(start).toContain('\t- Unterpunkt mit **fett**, *kursiv*, ==markiert==, ==hervorgehoben== und ~~gestrichen~~');
    // Block references and embeds: a link to the page with the block's text; Logseq's own properties are gone.
    expect(start).toContain('- Siehe den Beschluss [Beschluss: Mitgliedsbeitrag 30 € ab 2027](Vorstand/Protokoll%20M%C3%A4rz.md)');
    expect(start).toContain('- [Touren/2026](Touren/2026.md)\n');
    expect(start).not.toMatch(/heading::|id::|\(\([0-9a-f-]{36}\)\)/);
    expect(note(plan, 'Vorstand/Protokoll März.md')).toBe('- Anwesend: 7\n- Beschluss: Mitgliedsbeitrag 30 € ab 2027\n');
    expect(note(plan, 'Aufgaben.md')).toContain('- [ ] Bus bestellen  \n  SCHEDULED: <2026-11-02 Mon>\n- [ ] DOING Hütte reservieren\n- [x] Tourenplan verschicken\n');
    expect(note(plan, 'Aufgaben.md')).toContain('- [x] ~~Bergfest~~');
    expect(note(plan, 'Aufgaben.md')).toContain('- ```clojure\n  {:title "Offene Aufgaben"');
    expect(note(plan, 'Touren/2026.md')).toContain('- Dachstein  \n  ort: Ramsau  \n  höhe: 2995  \n  schwierigkeit: mittel');
    expect(note(plan, 'Touren/2026.md')).toContain('![Gipfel](../assets/foto-berg.jpg)');
    expect(note(plan, 'Touren/2026/Sommer.md')).toBe('- Treffpunkt 7 Uhr am Parkplatz\n\t- Eingeklappter Unterpunkt\n- Animiert: ![GIF](../../assets/animiert.gif) und ![PNG](../../assets/bild-test.png)\n');
    // Journals: their title is a name for [[…]]; the empty placeholder block is gone.
    expect(note(plan, 'Journal/2026-10-27.md')).toBe('- Nachgeholt. Vorher: [Oct 26th, 2026](2026-10-26.md). TODO Fotos sortieren\n');
    expect(note(plan, 'Journal/2026-10-28.md')).toMatch(/^- Besprechung zu \[Touren\/2026\]\(\.\.\/Touren\/2026\.md\) mit \[\[Anna-Lena\]\]\. \[Hütten\/Tirol\/Hütte 1\]\(\.\.\/Hütten\/Tirol\/Hütte%201\.md\)\n/);
    expect(note(plan, 'Hütten/Tirol/Hütte 1.md')).toBe('---\nregion: Salzburg\ntags: [hütte]\n---\n- Lage: 1237 m. #übernachtung\n- Vorher: [Hütten/Hütte 0](../Hütte%200.md)\n');
    expect(note(plan, 'Code und Formeln.md')).toContain('- > [!NOTE]\n  > Ein Hinweis im Logseq-Stil\n- > [!WARNING]\n  > Steinschlaggefahr!');
    expect(note(plan, 'Code und Formeln.md')).toContain('// [[kein Link]]');
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['[[Links]] auf Seiten, die nicht im Export sind – sie bleiben als Text stehen', 2],
      ['Block-Verweise und Einbettungen – als Link auf die Seite mit dem Text des Blocks übernommen', 2],
      ['Abfragen von Logseq ({{query}}, #+BEGIN_QUERY) – sie stehen als Text bzw. Codeblock in der Notiz', 1],
      ['Seiten im Org-Format – nicht übernommen', 1],
      ['Leere Seiten – nicht übernommen', 1],
      ['Einstellungen von Logseq (Ordner logseq/, versteckte Dateien) – nicht übernommen', 2],
    ]);
  });

  it('reads namespaces from „___“ and title::, the journal title format from the config; names what it cannot take', async () => {
    const { plan, format } = await planOf({
      'g/logseq/config.edn': '{;; :journal/page-title-format "EEE do, MMM yyyy"\n :journal/page-title-format "yyyy-MM-dd EEEE"\n :pages-directory "seiten"}',
      'g/seiten/Projekte___Alpen___Plan.md': '- Plan\n- Zum [[2026-10-28 Wednesday]] und [[projekte/alpen]]',
      'g/seiten/x.md': 'title:: Projekte/Alpen\n\n- Übersicht ((11111111-2222-3333-4444-555555555555))',
      // Without the setting in the config Logseq writes namespaces as %2F.
      'g/seiten/Alt%2FSeite.md': '- Alt [[Projekte/Alpen/Plan]]',
      'g/journals/2026_10_28.md': '- \n- Heute',
      'g/seiten/leer.md': '-\n',
      'g/whiteboards/Brett.edn': '{}',
    });
    expect(format).toBe('logseq');
    expect(note(plan, 'Projekte/Alpen/Plan.md')).toBe('- Plan\n- Zum [2026-10-28 Wednesday](../../Journal/2026-10-28.md) und [projekte/alpen](../Alpen.md)\n');
    expect(note(plan, 'Projekte/Alpen.md')).toBe('- Übersicht ((11111111-2222-3333-4444-555555555555))\n');
    expect(note(plan, 'Alt/Seite.md')).toBe('- Alt [Projekte/Alpen/Plan](../Projekte/Alpen/Plan.md)\n');
    expect(plan.warnings.map((w) => w.text)).toEqual([
      'Block-Verweise auf Blöcke, die nicht im Export sind – sie bleiben als Text stehen',
      'Whiteboards und Zeichnungen – nicht übernommen',
      'Leere Seiten – nicht übernommen',
      'Einstellungen von Logseq (Ordner logseq/, versteckte Dateien) – nicht übernommen',
    ]);
  });

  it('turns blocks into Markdown: tasks, quotes, code, properties – never inside code', () => {
    expect(convertPage('- #+BEGIN_QUOTE\n  Zitat\n  zwei\n  #+END_QUOTE\n- #+BEGIN_SRC python\n  [[x]]\n  #+END_SRC\n- ```\n  TODO bleibt\n  id:: bleibt\n  ```').body).toBe(
      '- > Zitat\n  > zwei\n- ```python\n  [[x]]\n  ```\n- ```\n  TODO bleibt\n  id:: bleibt\n  ```\n',
    );
    // An empty parent block stays an empty item – its children must not become an indented code block.
    expect(convertPage('-\n\t- Kind\n\t\t- Enkel\n-\n- Rest').body).toBe('-\n\t- Kind\n\t\t- Enkel\n- Rest\n');
    expect(convertPage('- [Text]([[Seite]]) ^^hell^^ `^^code^^` {{video https://example.invalid/v}}').body).toBe('- [[Seite|Text]] ==hell== `^^code^^` <https://example.invalid/v>\n');
    expect(formatDate(new Date(Date.UTC(2026, 0, 1)), 'MMM do, yyyy')).toBe('Jan 1st, 2026');
    expect(formatDate(new Date(Date.UTC(2026, 9, 12)), 'EEEE, dd.MM.yyyy')).toBe('Monday, 12.10.2026');
  });
});

describe('SilverBullet', () => {
  it('converts a real space of SilverBullet 2.12.1', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'silverbullet-2.12.1-space.zip'));
    expect(await detectFormat(zip.files)).toBe('silverbullet');
    const plan = buildPlan(await formatById('silverbullet')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    const paths = plan.notes.map((x) => x.path);
    expect(paths).toHaveLength(56);
    expect(paths).not.toContain('CONFIG.md');
    expect(paths).toEqual(expect.arrayContaining(['index.md', 'Archiv/2019/Tief/Noch tiefer/Ganz unten.md', 'Library/Vorlagen/Protokoll.md', 'vereinsheim.md', 'Vereinsheim 2.md']));
    expect(plan.files.map((f) => f.path)).toEqual(['Medien/animiert.gif', 'Medien/bild-test.png', 'Medien/foto-berg.jpg', 'Medien/logo.svg', 'Touren/2026/Tourenplan-2026.pdf']);
    const welcome = note(plan, 'Willkommen.md')!;
    expect(welcome).toContain('[letzten Protokoll](Vorstand/Protokoll.md)');
    expect(welcome).toContain('[Touren/2026/Tourenplan – Termine](Touren/2026/Tourenplan.md#termine)');
    expect(welcome).toContain('[[Gibt es nicht]]');
    expect(welcome).toContain('> [!NOTE]\n> **Hinweis**\n> Neue Mitglieder sind willkommen.');
    expect(welcome).toContain('${template.each(query[[from index.tag "page"');
    const tour = note(plan, 'Touren/2026/Tourenplan.md')!;
    expect(tour).toContain('![](../../Medien/bild-test.png)');
    expect(tour).toContain('[Tourenplan 2026.pdf](Tourenplan-2026.pdf)');
    expect(tour).toContain('#[[zwei Wörter]]');
    expect(tour).toContain('Eingebettet: [Touren/Sommer/Dachstein Südwand](../Sommer/Dachstein%20Südwand.md)');
    expect(note(plan, 'Code und Formeln.md')).toContain('`[[kein Link]]`');
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['[[Links]] auf Seiten, die nicht im Export sind – sie bleiben als Text stehen', 1],
      ['Einstellungen und Erweiterungen von SilverBullet (CONFIG, Bibliothek, Plugs) – nicht übernommen', 1],
      ['Lua-Ausdrücke und Abfragen von SilverBullet – sie stehen als Text in der Notiz und werden nicht ausgeführt', 5],
    ]);
  });
});

describe('Markdown folder', () => {
  it('keeps folders and files, leaves hidden ones out', async () => {
    const { plan } = await planOf({
      'wiki/Start.md': '# Start\n![](bilder/a.png) [[Unterseite]]',
      'wiki/sub/Unterseite.md': '[zurück](../Start.md)',
      'wiki/bilder/a.png': new Uint8Array([1, 2]),
      'wiki/.vscode/settings.json': '{}',
      'wiki/.git/config': '[core]',
    });
    expect(plan.notes.map((x) => [x.path, x.content])).toEqual([
      ['Start.md', '# Start\n![](bilder/a.png) [Unterseite](sub/Unterseite.md)'],
      ['sub/Unterseite.md', '[zurück](../Start.md)'],
    ]);
    expect(plan.files.map((f) => f.path)).toEqual(['bilder/a.png']);
    expect(plan.folders).toBe(2);
    expect(plan.warnings).toEqual([{ text: 'Versteckte Dateien (Einstellungen anderer Programme) – nicht übernommen', notes: [], items: ['.git/config', '.vscode/settings.json'] }]);
  });
});

describe('Obsidian', () => {
  it('converts a real vault of Obsidian 1.14.5: relative and path-end [[links]], names with ? # %, embeds, settings and trash out', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'obsidian-1.14.5-vault.zip'));
    expect(await detectFormat(zip.files)).toBe('obsidian');
    const plan = buildPlan(await formatById('obsidian')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    expect(plan.notes).toHaveLength(66);
    expect(plan.files).toHaveLength(13);
    const welcome = note(plan, 'Willkommen.md')!;
    expect(welcome).toContain('[Vorfahrt in Kürze](Ausbildung/Segelschein/Theorie%20&%20Regeln/Vorfahrtsregeln.md#grundregeln)');
    expect(welcome).toContain('[Was tun bei Kenterung?](Was%20tun%20bei%20Kenterung.md), [Grillabend #3](Grillabend%20%233.md), [100% Wind](100%25%20Wind.md)');
    // Obsidian writes `%` unencoded and `[[../…]]` after a rename; a path end is enough for it.
    expect(note(plan, 'Boote/Kielboote/Trimm & Takelage.md')).toContain('[100% Wind](../../100%25%20Wind.md)');
    const story = note(plan, 'Verein/Geschichte der Möwe.md')!;
    expect(story).toContain('![](../Anhänge/Fotos/Steg-im-Herbst.jpg)');
    expect(story).toContain('[Küche und Bar](../Hafen/Clubhaus/Küche%20und%20Bar.md)');
    expect(note(plan, 'Ausbildung/Checkliste.md')).toContain('[Segelschein/Theorie & Regeln/Vorfahrtsregeln](Segelschein/Theorie%20&%20Regeln/Vorfahrtsregeln.md)');
    expect(note(plan, 'Hafen/Clubhaus/Küche und Bar.md')).toContain('[Mitgliedsantrag.docx](../../Anhänge/assets/Mitgliedsantrag.docx)');
    // Properties keep their [[links]].
    expect(note(plan, 'Verein/Vorstand/Protokolle/2026/Protokoll März.md')).toContain('ort: "[[../../../../Hafen/Clubhaus/Küche und Bar]]"');
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['[[Links]] auf Seiten, die nicht im Export sind – sie bleiben als Text stehen', 1],
      ['[[Links]] auf Namen, die es mehrfach gibt – die nächstgelegene Seite wurde gewählt', 3],
      ['Links auf Seiten oder Dateien, die nicht im Export sind', 2],
      ['Einstellungen von Obsidian (Ordner .obsidian: Plugins, Themes, Arbeitsbereich) – nicht übernommen', 0],
      ['Papierkorb von Obsidian (.trash) – nicht übernommen', 1],
      ['Callouts – auf die fünf Arten von Kaveyl Wiki abgebildet, einklappbare als aufklappbarer Abschnitt', 7],
      ['Aufgaben mit eigenem Zustand ([/], [>], [?] …) – als offen übernommen, [-] (abgebrochen) als erledigt', 1],
      ['Hervorhebungen (==Text==) – als fett übernommen', 2],
      ['Block-IDs (^abc) am Zeilenende – entfernt, Links auf einzelne Blöcke zeigen auf die Notiz', 2],
      ['Kommentare (%%…%%) – als unsichtbare HTML-Kommentare übernommen', 2],
      ['Canvas, Bases und Zeichnungen – als Datei übernommen, nicht als Notiz', 2],
    ]);
  });

  it('turns callouts into the five kinds, foldable ones into <details>, nested ones too – not inside code', () => {
    expect(convertCallouts('> [!tip] Gut zu wissen\n> Text\n>\n> mehr')).toBe('> [!TIP]\n> **Gut zu wissen**\n> Text\n>\n> mehr');
    expect(convertCallouts('> [!warning]\n> Achtung')).toBe('> [!WARNING]\n> Achtung');
    expect(convertCallouts('> [!example]\n> Bsp')).toBe('> [!NOTE]\n> **Example**\n> Bsp');
    expect(convertCallouts('> [!faq]- Frage?\n> Antwort\nweiter')).toBe('<details>\n<summary>Frage?</summary>\n\nAntwort\n\n</details>\nweiter');
    expect(convertCallouts('> [!bug]+ Fehler <b>\n> x')).toBe('<details open>\n<summary>Fehler &lt;b&gt;</summary>\n\nx\n\n</details>');
    expect(convertCallouts('> [!note] Außen\n> > [!danger] Innen\n> > y')).toBe('> [!NOTE]\n> **Außen**\n> > [!CAUTION]\n> > **Innen**\n> > y');
    expect(convertCallouts('```\n> [!tip] x\n```')).toBe('```\n> [!tip] x\n```');
  });

  it('turns Obsidian\'s Markdown links into what Kaveyl Wiki shows: embedded notes and PDFs as links, sizes out, file names as text', () => {
    expect(markdownLinks('![420er](../Boote/420er.md) ![](a/plan.pdf#page=1) ![200](x.png) ![Steg|300](x.png) [](../A/Antrag.docx)')).toBe(
      '[420er](../Boote/420er.md) [plan.pdf](a/plan.pdf#page=1) ![](x.png) ![Steg](x.png) [Antrag.docx](../A/Antrag.docx)',
    );
  });

  it('finds inline #tags, but not headings, links, addresses, numbers or code', () => {
    expect(inlineTags('---\ntags: [a]\n---\n# Titel\n#projekt/alpha und #Ärger, aber nicht #123 oder `#code` oder [x](#anker) oder [[#Abschnitt]] oder https://x.at/#frag oder a#b')).toEqual(['projekt/alpha', 'Ärger']);
  });

  it('converts a vault: wiki links over the whole vault, embeds, comments, marks, block ids, tags, settings left out', async () => {
    const { plan, format } = await planOf({
      'Tresor/.obsidian/app.json': '{"attachmentFolderPath":"Anhänge"}',
      'Tresor/.obsidian/plugins/x/main.js': 'x',
      'Tresor/Start.md': '---\ntags:\n  - start\n---\n# Start #willkommen\n[[Projekte/Alpha|Alpha]] und [[Alpha#Ziele]] und [[Alpha#^abc123]]\n![[Bild 1.png|200]] ![[Handbuch.pdf]] ![[Alpha]]\nDas ist ==wichtig== %%geheim%% Ende ^satz1\n\n%%\nBlock -- Kommentar\n%%\n',
      'Tresor/Projekte/Alpha.md': '## Ziele\nText ^abc123',
      'Tresor/Anhänge/Bild 1.png': new Uint8Array([1]),
      'Tresor/Anhänge/Handbuch.pdf': new Uint8Array([2]),
      'Tresor/Plan.canvas': '{"nodes":[]}',
    });
    expect(format).toBe('obsidian');
    expect(note(plan, 'Start.md')).toBe(
      '---\ntags: [start, willkommen]\n---\n# Start #willkommen\n[Alpha](Projekte/Alpha.md) und [Alpha – Ziele](Projekte/Alpha.md#ziele) und [Alpha](Projekte/Alpha.md)\n![](Anhänge/Bild-1.png) [Handbuch.pdf](Anhänge/Handbuch.pdf) [Alpha](Projekte/Alpha.md)\nDas ist **wichtig** <!--geheim--> Ende\n\n<!--\nBlock - - Kommentar\n-->\n',
    );
    expect(note(plan, 'Projekte/Alpha.md')).toBe('## Ziele\nText');
    expect(plan.files.map((f) => f.path)).toEqual(['Anhänge/Bild-1.png', 'Anhänge/Handbuch.pdf', 'assets/Plan.canvas']);
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['Einstellungen von Obsidian (Ordner .obsidian: Plugins, Themes, Arbeitsbereich) – nicht übernommen', 0],
      ['Hervorhebungen (==Text==) – als fett übernommen', 1],
      ['Block-IDs (^abc) am Zeilenende – entfernt, Links auf einzelne Blöcke zeigen auf die Notiz', 2],
      ['Kommentare (%%…%%) – als unsichtbare HTML-Kommentare übernommen', 1],
      ['Canvas, Bases und Zeichnungen – als Datei übernommen, nicht als Notiz', 1],
    ]);
  });
});

describe('Trilium', () => {
  it('converts a real Markdown export of Trilium 0.106.1', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'trilium-0.106.1-markdown.zip'));
    expect(await detectFormat(zip.files)).toBe('trilium');
    const plan = buildPlan(await formatById('trilium')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    const paths = plan.notes.map((x) => x.path);
    expect(paths).toHaveLength(58);
    // Titles as in Trilium (not its shortened file names), clashes as „Name 2“, a note with children as its folder's page.
    expect(paths).toEqual(
      expect.arrayContaining([
        'index.md',
        'Vereinsleben/Sitzungen 2026/index.md',
        'Vereinsleben/Sitzungen 2026/Protokoll.md',
        'Vereinsleben/Sitzungen 2026/Protokoll 2.md',
        'Vereinsleben/Sitzungen 2026/protokoll 3.md',
        'Bienenhaltung/Futter - Zucker-Mischung 3 - 2.md',
        'Bienenhaltung/Völker & Stände/Stand „Am Lindenhang“/Volk 1 - Königin Gelb.md',
        'Rezepte/Wachs-Auswertung.md',
        'Diagramme/Ablauf Honigernte.md',
      ]),
    );
    expect(plan.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['Medien/Bienenstand-Foto.jpg', 'Medien/Tourenplan-Lehrfahrt.pdf', 'Rezepte/bild-test.png', 'Diagramme/Bienenstand-Skizze.svg', 'Diagramme/assets/Bienenstand-Skizze.excalidraw.json']),
    );
    // The title line goes; pictures, references, embeds, footnotes, download links become Markdown.
    expect(note(plan, 'Rezepte/Honigkuchen.md')).toMatch(/^Zutaten:[\s\S]*!\[Teig in der Form\]\(bild-test\.png\)[\s\S]*!\[\]\(\.\.\/Medien\/Bienenstand-Foto\.jpg\)/);
    const links = note(plan, 'Formatierungen/Links quer durch.md')!;
    expect(links).toContain('Verweis (reference-link): [Vorstand](../Vereinsleben/Vorstand.md)');
    expect(links).toContain('[Protokoll B](../Vereinsleben/Sitzungen%202026/Protokoll%202.md)');
    expect(links).toContain('[Sitzungen 2026](../Vereinsleben/Sitzungen%202026/index.md)');
    expect(links).toContain('Link ins Leere (Notiz gibt es nicht): Verschollene Notiz');
    expect(note(plan, 'Formatierungen/Eingebettete Notiz.md')).toContain('[Protokoll](../Vereinsleben/Sitzungen%202026/J%C3%A4nner/Protokoll.md)');
    expect(note(plan, 'Formatierungen/Mathe & Fußnoten.md')).toContain('3 km weit[^1].\n\n[^1]: Laut Vereinsheft 3/2026 (erfunden).');
    expect(note(plan, 'Sonstiges/Tourenplanung Lehrfahrt.md')).toContain('[tourenplan.pdf herunterladen](tourenplan.pdf)');
    expect(note(plan, 'Formatierungen/Text und Überschriften.md')).toContain('**gelb markiert**, **Hintergrund gelb**, rote Schrift.');
    expect(note(plan, 'Formatierungen/Text und Überschriften.md')).toContain('<details>\n<summary>Aufklappen</summary>\n\nVersteckter Text.\n\n</details>');
    expect(note(plan, 'Formatierungen/Hinweisboxen.md')).toContain('> [!IMPORTANT]\n> Wichtig: Stockkarte führen.');
    expect(note(plan, 'Rezepte/Wachs-Auswertung.md')).toMatch(/^```python\n# Wachsausbeute/);
    expect(note(plan, 'Diagramme/Ablauf Honigernte.md')).toMatch(/^```mermaid\nflowchart LR/);
    expect(note(plan, 'Diagramme/Bienenstand-Skizze.md')).toBe('![Bienenstand-Skizze](Bienenstand-Skizze.svg)\n');
    expect(note(plan, 'Bienenhaltung/Volk 1 - Königin Gelb.md')).toContain('](V%C3%B6lker%20&%20St%C3%A4nde/Stand%20%E2%80%9EAm%20Lindenhang%E2%80%9C/Volk%201%20-%20K%C3%B6nigin%20Gelb.md)');
    // Labels without value are tags, with value own keys (numbers as numbers); Trilium's own labels stay out.
    expect(note(plan, 'Vereinsleben/Mitglieder/Hilde Wabenreich.md')).toMatch(/^---\nstatus: aktiv\nvoelker: 12\n---\n/);
    expect(note(plan, 'index.md')).not.toContain('iconClass');
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['Links auf Seiten oder Dateien, die nicht im Export sind', 1],
      ['Geschützte Notizen – Trilium exportiert sie ohne Titel und Inhalt, nicht übernommen (genannt ist der Ordner, in dem sie waren)', 3],
      ['Klone – am ersten Ort übernommen, an den weiteren Orten als Link dorthin', 2],
      ['Labels und Beziehungen von Trilium – als Eigenschaften im Frontmatter übernommen', 14],
      ['Leinwände, Mindmaps und Beziehungskarten – als Datei (JSON) übernommen, Leinwände mit ihrem Bild', 3],
      ['Suchen, Render-, Webseiten- und Karten-Notizen von Trilium – nicht übernommen', 3],
      ['Links auf Notizen, die nicht im Export sind – nur der Text bleibt', 1],
      ['Tabellen mit verbundenen Zellen oder Absätzen – vereinfacht als Markdown-Tabelle, bitte prüfen', 1],
    ]);
  });
});

describe('Wiki.js', () => {
  it('converts a real dump of Wiki.js 2.5.317: headers read line by line, titles as names, links by its rules', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'wikijs-2.5.317-disk.zip'));
    expect(await detectFormat(zip.files)).toBe('wikijs');
    const plan = buildPlan(await formatById('wikijs')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    const paths = plan.notes.map((x) => x.path);
    expect(paths).toHaveLength(69);
    expect(paths).toEqual(
      expect.arrayContaining([
        'Startseite.md',
        'Über die Bibliothek/index.md',
        'Über die Bibliothek/Standorte/Hauptstelle am Markt/Räume/Lesesaal.md',
        'Veranstaltungen/2026/lesungen/Herbstlesung - Krimis aus der Region.md',
        'sonderzeichen/& Co. - Partner der Bibliothek.md',
        'Veranstaltungen/2026/kinder/#Ferienprogramm 2026.md',
        'en/Home.md',
        'projekte/digitalisierung/Digitalisierungsplan.md',
      ]),
    );
    // Uploaded files stay where they were, in the renamed folders.
    expect(plan.files.map((f) => f.path)).toEqual(expect.arrayContaining(['Über die Bibliothek/Standorte/lageplan.png', 'bilder/lesesaal_übersicht.png', 'logo_stadtbibliothek.svg']));
    const home = note(plan, 'Startseite.md')!;
    expect(home).toMatch(/^---\ndescription: Einstieg ins Wiki der Stadtbibliothek\ntags: \[start, übersicht\]\ncreated: 2026-10-28T21:09:36.021Z\nupdated: /);
    expect(home).toContain('![Logo](logo_stadtbibliothek.svg)');
    expect(home).toContain('[Notfallplan](Intern/Teamhandbuch/Notfallplan.md#erste-schritte)');
    expect(home).toContain('[Library in English](en/Home.md)');
    expect(home).toContain('> [!NOTE]\n> Neu hier?');
    expect(home).not.toMatch(/\{\.[\w-]+\}/);
    expect(note(plan, 'Veranstaltungen/2026/lesungen/Herbstlesung - Krimis aus der Region.md')).toContain('description: "Titel mit Doppelpunkt: YAML-Risiko"');
    // `../zweigstelle-nord` led nowhere in Wiki.js (the browser resolves it against the page address) – the neighbour was meant.
    expect(note(plan, 'Über die Bibliothek/Standorte/Hauptstelle am Markt/index.md')).toContain('[Zur Zweigstelle](../Zweigstelle%20Nord/index.md)');
    // Visual editor: HTML → Markdown, pictures and links included.
    const story = note(plan, 'Über die Bibliothek/Geschichte der Stadtbibliothek.md')!;
    expect(story).toContain('![Lesesaal](../bilder/lesesaal_%C3%BCbersicht.png)');
    expect(story).toContain('[Zweigstelle Nord](Standorte/Zweigstelle%20Nord/index.md)');
    expect(note(plan, 'Intern/Aushang Schwarzes Brett.md')).not.toMatch(/<script|alert\(/);
    // A link Wiki.js itself resolved to nothing (/en/benutzung/gebuehren) does not land on the German page.
    expect(plan.notes.find((x) => x.content.includes('Renew twice online'))?.content).toContain('[fees](/benutzung/gebuehren)');
    expect(note(plan, 'Intern/Entwurf Jahresbericht 2026.md')).toContain('published: false');
    expect(note(plan, 'projekte/digitalisierung/Digitalisierungsplan.md')).toMatch(/^```asciidoc\n= Digitalisierungsplan/);
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['Links auf Seiten oder Dateien, die nicht im Export sind', 6],
      ['Links, die in Wiki.js ins Leere zeigten (Kindseite statt Nachbarseite) – auf die gleichnamige Nachbarseite gesetzt', 7],
      ['Links auf Schlagwort-Seiten von Wiki.js (/t/…) – nur der Text bleibt, die Schlagwörter stehen im Frontmatter (tags)', 1],
      ['Seiten aus dem visuellen Editor oder mit HTML – in Markdown umgewandelt, bitte Aussehen prüfen', 7],
      ['AsciiDoc-Seiten – als Codeblock übernommen', 2],
      ['Unveröffentlichte Seiten – übernommen, im Frontmatter steht published: false', 1],
      ['Zeichnungen (draw.io) – stehen als Codeblock in der Notiz', 1],
    ]);
    // A link to Wiki.js's tag page is text (code-010c).
    expect(note(plan, 'Veranstaltungen/index.md')).toContain('Alle Termine mit Tag: lesung. Archiv: [Sommerfest 2024](Archiv/Sommerfest%202024.md).');
  });

  it('converts the Git storage of the same Wiki.js: the main language in de/ is at the top, files next to their pages (code-010b)', async () => {
    const open = async (name: string) => {
      const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', name));
      expect(await detectFormat(zip.files)).toBe('wikijs');
      const plan = buildPlan(await formatById('wikijs')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
      await zip.close();
      return plan;
    };
    const git = await open('wikijs-2.5.317-git.zip');
    const disk = await open('wikijs-2.5.317-disk.zip');
    // The same pages, files and folders as from the dump to disk – no `de/` tree, no second tree for the files.
    expect(git.notes.map((x) => x.path).sort()).toEqual(disk.notes.map((x) => x.path).sort());
    expect(git.notes.some((x) => x.path.startsWith('de/'))).toBe(false);
    expect(git.files.map((f) => f.path).sort()).toEqual(disk.files.map((f) => f.path).sort());
    expect(git.files.map((f) => f.path)).toContain('Über die Bibliothek/Standorte/lageplan.png');
    expect(git.folders).toBe(disk.folders);
    const home = note(git, 'Startseite.md')!;
    expect(home).toContain('[Notfallplan](Intern/Teamhandbuch/Notfallplan.md#erste-schritte)');
    expect(home).toContain('[Library in English](en/Home.md)');
    expect(note(git, 'Über die Bibliothek/Standorte/index.md')).toContain('](lageplan.png)');
    // Another language stays in its folder; its link to a page it does not have still leads nowhere (code-010a).
    expect(git.notes.find((x) => x.content.includes('Renew twice online'))?.content).toContain('[fees](/benutzung/gebuehren)');
    expect(git.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual(disk.warnings.map((w) => [w.text, w.notes.length + w.items.length]));
  });
});

describe('Outline', () => {
  it('converts a real Markdown export of Outline 1.12.0: names, icons, dates, anchors, uploads once, missing documents as text', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'outline-1.12.0-markdown-workspace.zip'));
    expect(await detectFormat(zip.files)).toBe('outline');
    const plan = buildPlan(await formatById('outline')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    expect(plan.notes).toHaveLength(60);
    // A file used in three folders is there once.
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      'Café & Verkauf/Logo-Bohnenglück.svg',
      'Café & Verkauf/Veranstaltungen/Bohne-dreht-sich.gif',
      'Rösterei & Produktion/Lager-Foto.jpg',
      'Rösterei & Produktion/Maschinen & Wartung/Röstplan-Oktober.pdf',
      'Rösterei & Produktion/Röstprofile/Äthiopien/Yirgacheffe/Röstkurve-Charge-12.png',
    ]);
    expect(plan.notes.map((x) => x.path)).toEqual(expect.arrayContaining(['Rösterei & Produktion/#1 Bestseller.md', 'Rösterei & Produktion/Röstprofile/index.md', 'Café & Verkauf (1)/Speisekarte.md']));
    const welcome = note(plan, 'Team-Handbuch/Willkommen bei Bohnenglück.md')!;
    expect(welcome).toMatch(/^---\nicon: 👋\ncreated: 2026-10-28T21:30:46.520Z\nupdated: [^\n]+\n---\nSchön, dass du da bist! Ansprechpartner: @Rita Röstmeister und @Bruno Bohne\./);
    expect(welcome).toContain('![Logo Bohnenglück](../Caf%C3%A9%20&%20Verkauf/Logo-Bohnengl%C3%BCck.svg)');
    const links = note(plan, 'Team-Handbuch/Linksammlung.md')!;
    expect(links).toContain('Charge%2012/index.md#schritt-2-abk%C3%BChlen)');
    expect(links).toContain('[#1](../R%C3%B6sterei%20&%20Produktion/%231%20Bestseller.md)');
    expect(links).toContain('* Gelöschte Seite (Papierkorb): Alte Preisliste 2024');
    expect(links).toContain('* Volle Adresse: [absolut](Urlaubsregelung.md)');
    expect(links).toContain('[Röstplan Oktober.pdf](../R%C3%B6sterei%20&%20Produktion/Maschinen%20&%20Wartung/R%C3%B6stplan-Oktober.pdf)');
    const formats = note(plan, 'Team-Handbuch/Formatierungen im Überblick.md')!;
    expect(formats).toContain('*unterstrichen*');
    expect(formats).toContain('<details>\n<summary>Versteckter Text im Toggle-Block.</summary>\n\n* Punkt im Toggle\n\n</details>');
    expect(formats).not.toContain('mermaidjs');
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['Links auf Dokumente, die nicht im Export sind (Entwürfe, archivierte, gelöschte, andere Sammlungen) – nur der Text bleibt', 1],
      ['Erwähnungen von Personen – als @Name übernommen', 3],
      ['Unterstreichungen (__Text__) – als kursiv übernommen', 1],
      ['Einklappbare Abschnitte – als aufklappbarer Abschnitt übernommen, der erste Absatz ist die Überschrift', 1],
    ]);
  });

  it('converts a real OKF export of Outline 1.12.0: links by /doc/<urlId> to documents in the export, the overview is no note', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'outline-1.12.0-okf-workspace.zip'));
    expect(await detectFormat(zip.files)).toBe('outline');
    const plan = buildPlan(await formatById('outline')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    expect(plan.notes).toHaveLength(60);
    expect(plan.notes.map((x) => x.path)).not.toContain('index.md');
    expect(plan.files).toHaveLength(5);
    const links = note(plan, 'Team-Handbuch/Linksammlung.md')!;
    // OKF's own frontmatter (resource, generated …) is no property of the note.
    expect(links).toMatch(/^---\ncreated: [^\n]+\nupdated: [^\n]+\n---\nAlle Arten/);
    // `/doc/<urlId>` of a document in the export (its `resource`) is a link to it, also to a heading of the same document.
    expect(links).toContain('* Nur urlId: [kurz](Schichtplan.md)');
    expect(links).toContain('* Selbst-Link auf Abschnitt: [Inhalt](Linksammlung.md#inhalt)');
    expect(links).toContain('* Entwurf: Herbstkarte');
    expect(links).toContain('* Sammlung: Café & Verkauf');
    // A number at the end of a picture's text is no file size (code-007).
    expect(note(plan, 'Rösterei & Produktion/Röstprofile/Äthiopien/Yirgacheffe/Röstkurve Charge 12/index.md')).toContain('![Röstkurve Charge 12](../R%C3%B6stkurve-Charge-12.png)');
    expect(plan.warnings.map((w) => [w.text, w.notes.length + w.items.length])).toEqual([
      ['Links auf Dokumente, die nicht im Export sind (Entwürfe, archivierte, gelöschte, andere Sammlungen) – nur der Text bleibt', 1],
      ['Erwähnungen von Personen – als @Name übernommen', 3],
      ['Unterstreichungen (__Text__) – als kursiv übernommen', 1],
      ['Einklappbare Abschnitte – als aufklappbarer Abschnitt übernommen, der erste Absatz ist die Überschrift', 1],
    ]);
  });

  it('keeps a picture in a list item and takes only its own boxes – no HedgeDoc syntax (code-008, code-013)', async () => {
    const { plan } = await planOf({ 'Sammlung/Dok.md': '# Dok\n\n- Punkt\n\n  ![bild](uploads/u/i/b.png)\n\n:::tip\nTipp\n:::\n\n[TOC]\n\n{%youtube abc %}\n', 'Sammlung/uploads/u/i/b.png': 'p' }, 'outline');
    // The one folder around everything goes (as for every ZIP).
    const doc = note(plan, 'Dok.md')!;
    expect(doc).toContain('- Punkt\n\n  ![bild](b.png)');
    expect(doc).toContain('> [!TIP]\n> Tipp');
    expect(doc).toContain('[TOC]\n\n{%youtube abc %}');
    // HedgeDoc has no `:::tip`.
    expect(convertBody(':::tip\nx\n:::')).toBe(':::tip\nx\n:::');
  });
});

describe('crafted exports (Diff-Prüfung 0.2.6)', () => {
  const quick = async (what: () => Promise<unknown> | unknown) => {
    const start = performance.now();
    await what();
    return performance.now() - start;
  };
  const triliumZip = (notes: object[], files: Record<string, string>) => ({ '!!!meta.json': JSON.stringify({ formatVersion: 2, files: notes }), ...files });

  it('stays linear on input made to make the patterns backtrack', async () => {
    // 256 KB: what was quadratic or cubic took minutes here; the Markdown parser itself needs a few seconds per MB.
    const MB = 256 * 1024;
    // Trilium: <details> and <table> openers without their end.
    const details = '<details><summary>\n' + '</summary>x\n'.repeat(MB / 12) + '<table>\n'.repeat(MB / 16);
    // Outline: a line of `[`, ` \n` before `mermaidjs`, `+++` toggles without their end.
    const outline = '['.repeat(MB / 2) + '\n' + '```' + ' \n'.repeat(MB / 4) + 'mermaidjs\n' + '+++\nx\n'.repeat(MB / 12);
    // Wiki.js: a long quote with a callout after every line.
    const wikijs = '>\n{.is-info}\n'.repeat(MB / 13);
    // Wiki links by path end that match nothing, many times, next to many notes (one per paragraph: many brackets in
    // one paragraph are slow in the Markdown parser itself, see audit 0.2.6 sec-006).
    const many: Record<string, string> = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`d${i}/n${i}.md`, 'x']));
    const times = {
      trilium: await quick(() => planOf(triliumZip([{ noteId: 'a', title: 'A', type: 'text', format: 'markdown', dataFileName: 'A.md' }], { 'A.md': details }), 'trilium')),
      outline: await quick(() => planOf({ 'Sammlung/Dokument.md': outline }, 'outline')),
      wikijs: await quick(() => planOf({ 'start.md': wikijs }, 'wikijs')),
      obsidianLinks: await quick(() => markdownLinks('[](' + 'a'.repeat(MB / 4) + '\n' + '[](a'.repeat(MB / 16))),
      obsidianTags: await quick(() => inlineTags(Array.from({ length: 40_000 }, (_, i) => `#t${i}`).join(' '))),
      wikiIndex: await quick(() => planOf({ ...many, 'a.md': '[[q/z]]\n\n'.repeat(MB / 9) }, 'markdown')),
    };
    for (const [what, ms] of Object.entries(times)) expect({ what, slow: ms > 5000 * SLOW }).toEqual({ what, slow: false });
  }, 120_000);

  it('Trilium: keeps one name per note quickly, makes no note out of metadata alone and stops beyond the limit', async () => {
    const same = Array.from({ length: 15_000 }, (_, i) => ({ noteId: `n${i}`, title: 'Gleich', type: 'text', format: 'markdown', dataFileName: 'A.md' }));
    let plan!: Plan;
    expect(await quick(async () => (plan = (await planOf(triliumZip(same, { 'A.md': 'x' }), 'trilium')).plan))).toBeLessThan(5000 * SLOW);
    expect(plan.notes.map((x) => x.path).slice(0, 3)).toEqual(['Gleich.md', 'Gleich 2.md', 'Gleich 3.md']);
    expect(new Set(plan.notes.map((x) => x.path)).size).toBe(15_000);

    const onlyMeta = await planOf(triliumZip([{ noteId: 'a', title: 'Leer', type: 'text' }, { noteId: 'b', title: 'Ordner', type: 'text', children: [{ noteId: 'c', title: 'Kind', type: 'text', dataFileName: 'K.md' }] }], { 'K.md': 'k' }), 'trilium');
    expect(onlyMeta.plan.notes.map((x) => x.path)).toEqual(['Kind.md']);
    expect(onlyMeta.plan.warnings.find((w) => w.text.startsWith('Dateien, die im Export fehlen'))?.items).toEqual(['Leer']);

    const tooMany = Array.from({ length: IMPORT_LIMITS.entries + 1 }, (_, i) => ({ noteId: `n${i}`, title: `T${i}`, type: 'text', dataFileName: 'A.md' }));
    const file = await zipFile(triliumZip(tooMany, { 'A.md': 'x' }));
    await expect(convertExport({ file, format: 'trilium', folderNote: 'index.md', blocked: [], fetch: false })).rejects.toThrow(`mehr als ${IMPORT_LIMITS.entries} Notizen und Dateien`);
  }, 60_000);

  it('Wiki.js: leaves the Git folder of the storage out', async () => {
    const { plan } = await planOf({ 'home.md': '---\ntitle: Start\neditor: markdown\ndateCreated: 2026-10-28T10:00:00Z\n---\nHallo', '.git/config': '[remote "origin"]\n\turl = https://u:geheim@example.org/w.git', '.git/objects/ab/cdef': 'x', 'bild.png': 'p' });
    expect(plan.files.map((f) => f.path)).toEqual(['bild.png']);
    expect(plan.warnings.find((w) => w.text.startsWith('Versteckte Dateien'))?.items).toEqual(['.git/config', '.git/objects/ab/cdef']);
  });
});

describe('script addresses from other programs (sec-004)', () => {
  it('takes the address of every way of writing a javascript: link, keeps the text and data: pictures', () => {
    const notes = [
      "[t1](javascript:alert%281%29 'x')",
      '[t2\nzwei](javascript:alert(2))',
      '> [r3]: javascript:alert(3)',
      '[t4](&#106;avascript:alert(4))',
      '[t5](javascript&#58;alert(5))',
      '[t6](javascript\\:alert(6))',
      '[t7](<&#106;avascript:alert(7)>)',
      '[t8](javascript:alert(8))',
      '[![bild](javascript:a)](javascript:b)',
      '<javascript:alert(9)>',
      '![pixel](data:image/png;base64,AAAA) [ok](https://example.org) `[c](javascript:x)`',
    ].map((content, i) => ({ from: `n${i}.md`, dir: [], name: `n${i}`, content }));
    const plan = buildPlan({ notes, files: [], warnings: [] }, { folderNote: 'index.md', blocked: new Set() });
    expect(plan.notes.map((x) => x.content.trim())).toEqual([
      't1',
      't2\nzwei',
      '>',
      't4',
      't5',
      't6',
      't7',
      't8',
      'bild',
      '',
      '![pixel](data:image/png;base64,AAAA) [ok](https://example.org) `[c](javascript:x)`',
    ]);
    expect(plan.warnings.find((w) => w.text.startsWith('Links mit Skript-Adressen'))?.notes).toHaveLength(10);
  });

  it('Trilium: reads numeric entities in reference links as what they are', async () => {
    const { plan } = await planOf(
      { '!!!meta.json': JSON.stringify({ formatVersion: 2, files: [{ noteId: 'a', title: 'A', type: 'text', format: 'markdown', dataFileName: 'A.md' }] }), 'A.md': 'Siehe <a class="reference-link" href="&#106;avascript:alert(1)">Ziel</a>.' },
      'trilium',
    );
    expect(note(plan, 'A.md')?.trim()).toBe('Siehe Ziel.');
  });
});

describe('code review 0.2.6', () => {
  const meta = (notes: object[]) => JSON.stringify({ formatVersion: 2, files: notes });

  it('Trilium: labels named like object methods, titles with a dot, indents and hard breaks', async () => {
    const { plan } = await planOf(
      {
        '!!!meta.json': meta([
          { noteId: 'a', title: 'A', type: 'text', format: 'markdown', dataFileName: 'A.md', attributes: [{ type: 'label', name: 'toString', value: 'a' }, { type: 'label', name: '__proto__', value: 'c' }] },
          { noteId: 'p', title: 'Plan v1.2', type: 'image', dataFileName: 'Plan v1.2.png' },
        ]),
        'A.md': '- Punkt\n\n  ![bild](x.png)\n\nZeile mit [Link](https://x.org)  \nnächste\n',
        'Plan v1.2.png': 'p',
      },
      'trilium',
    );
    const a = note(plan, 'A.md')!;
    expect(a).toContain('toString: a\n');
    expect(a).toContain('__proto__: c\n');
    expect(a).toContain('- Punkt\n\n  ![bild](x.png)');
    expect(a).toContain('[Link](https://x.org)  \nnächste');
    expect(plan.files.map((f) => f.path)).toEqual(['Plan-v1.2.png']);
  });

  it('Outline: a comment with an object gives no date', async () => {
    const zip = join(dir, 'outline-comment.zip');
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add('Sammlung/Dok.md', new Uint8ArrayReader(strToU8('# Dok\n\nText\n')), { comment: '{"createdAt":{"x":1},"updatedAt":"2026-10-01T10:00:00Z"}' });
    await writeFile(zip, await writer.close());
    const z = await ImportZip.open(zip);
    const plan = buildPlan(await formatById('outline')!.convert(z.files), { folderNote: 'index.md', blocked: new Set() });
    await z.close();
    const doc = plan.notes.find((x) => x.path.endsWith('Dok.md'))!.content;
    expect(doc).not.toContain('created:');
    expect(doc).toContain('updated: 2026-10-01T10:00:00Z');
  });

  it('Obsidian: links in tables, Windows line ends; a docs folder with GitHub alerts stays a Markdown folder', async () => {
    const { plan, format } = await planOf({ 'Ziel.md': 'z', 'bild.png': 'p', 'a.md': '| x | y |\r\n|---|---|\r\n| [[Ziel\\|Text]] | ![[bild.png\\|200]] |\r\n\r\n> [!tip] Titel\r\n> Text ^abc\r\n' }, 'obsidian');
    expect(format).toBe('obsidian');
    const a = note(plan, 'a.md')!;
    expect(a).toContain('| [Text](Ziel.md) | ![](bild.png) |');
    expect(a).not.toContain('\r');
    expect(a).not.toContain('[!tip]');
    expect(a).not.toContain('^abc');
    expect((await planOf({ 'docs/README.md': '> [!NOTE]\n> Farbe #ffaa00\n' })).format).toBe('markdown');
    expect((await planOf({ 'docs/README.md': '> [!note]- Zu\n> x\n' })).format).toBe('obsidian');
  });
});

describe('Unicode forms of names (code-005)', () => {
  it('finds an NFD file name from a macOS ZIP by an NFC link (and a link in another case), and writes names in NFC', async () => {
    const nfd = (s: string) => s.normalize('NFD');
    const { plan } = await planOf({ [nfd('Übungen/Übung.md')]: 'ü', 'Notiz.md': 'n', [nfd('Bilder/Käse.png')]: 'p', 'a.md': '[md](%C3%9Cbungen/%C3%9Cbung.md) [klein](notiz.md) ![bild](Bilder/K%C3%A4se.png)\n' }, 'markdown');
    expect(plan.notes.map((x) => x.path).sort()).toEqual(['a.md', 'Notiz.md', 'Übungen/Übung.md'].map((p) => p.normalize('NFC')).sort());
    expect(plan.notes.every((x) => x.path === x.path.normalize('NFC'))).toBe(true);
    expect(plan.files.map((f) => f.path)).toEqual(['Bilder/Käse.png'.normalize('NFC')]);
    expect(note(plan, 'a.md')).toBe('[md](%C3%9Cbungen/%C3%9Cbung.md) [klein](Notiz.md) ![bild](Bilder/K%C3%A4se.png)\n');
    expect(plan.warnings).toEqual([]);
  });
});

describe('folders named by title (code-001)', () => {
  it('keeps two sibling folders of the same title apart (Trilium, Wiki.js)', async () => {
    const t = await planOf(
      {
        '!!!meta.json': JSON.stringify({
          formatVersion: 2,
          files: [{ noteId: 'r', title: 'Root', type: 'book', dirFileName: 'Root', children: [
            { noteId: 'a', title: 'Projekt', type: 'text', format: 'markdown', dataFileName: 'Projekt.md', dirFileName: 'Projekt', children: [{ noteId: 'a1', title: 'Plan', type: 'text', format: 'markdown', dataFileName: 'Plan.md' }] },
            { noteId: 'b', title: 'Projekt', type: 'text', format: 'markdown', dataFileName: '1_Projekt.md', dirFileName: '1_Projekt', children: [{ noteId: 'b1', title: 'Plan', type: 'text', format: 'markdown', dataFileName: 'Plan.md' }] },
          ] }],
        }),
        'Root/Projekt.md': 'A',
        'Root/Projekt/Plan.md': 'Plan A',
        'Root/1_Projekt.md': 'B',
        'Root/1_Projekt/Plan.md': 'Plan B',
      },
      'trilium',
    );
    expect(t.plan.notes.map((x) => [x.path, x.content.trim()]).sort()).toEqual([
      ['Projekt 2/Plan.md', 'Plan B'],
      ['Projekt 2/index.md', 'B'],
      ['Projekt/Plan.md', 'Plan A'],
      ['Projekt/index.md', 'A'],
    ]);
    const w = await planOf({ 'a.md': '---\ntitle: Team\n---\nA', 'a/x.md': 'x', 'b.md': '---\ntitle: Team\n---\nB', 'b/x.md': 'y' }, 'wikijs');
    expect(w.plan.notes.map((x) => [x.path, x.content.trim()]).sort()).toEqual([
      ['Team 2/index.md', 'B'],
      ['Team 2/x.md', 'y'],
      ['Team/index.md', 'A'],
      ['Team/x.md', 'x'],
    ]);
  });
});

describe('Trilium HTML export (code-012)', () => {
  it('converts it, but says that the Markdown export is the better one', async () => {
    const zip = await ImportZip.open(join(import.meta.dirname, 'fixtures', 'trilium-0.106.1-html.zip'));
    expect(await detectFormat(zip.files)).toBe('trilium');
    const plan = buildPlan(await formatById('trilium')!.convert(zip.files), { folderNote: 'index.md', blocked: new Set() });
    await zip.close();
    expect(plan.notes.length).toBeGreaterThan(40);
    expect(plan.warnings.map((w) => w.text)).toContain('Trilium-Export im HTML-Format – Aufgaben, Hinweisboxen, Markierungen, aufklappbare Abschnitte und die Sprache von Codeblöcken kommen nicht richtig an, besser in Trilium als „Markdown“ exportieren');
    for (const n of plan.notes) expect(n.content).not.toMatch(/<script|\bon\w+=/i);
    // Formulas and footnotes come over as from the Markdown export (code-012).
    const math = note(plan, 'Formatierungen/Mathe & Fußnoten.md')!;
    expect(math).toContain('Inline: $A = \\pi r^2$ ist die Fläche.');
    expect(math).toContain('$$\\sum_{i=1}^{n} w_i = 40\\,000$$');
    expect(math).toContain('3 km weit[^1].');
    expect(math).toContain('[^1]: Laut Vereinsheft 3/2026 (erfunden).');
    expect(math).not.toMatch(/#fn|kwmath|kwnote/);
  });

  it('turns formulas and footnotes of the HTML export into Markdown, linear on crafted input', async () => {
    const meta = JSON.stringify({ formatVersion: 2, files: [{ noteId: 'a', title: 'A', type: 'text', format: 'html', dataFileName: 'A.html' }] });
    const html =
      '<p>x <span class="math-tex">\\(a &lt; b\\)</span> y<span class="footnote-reference" data-footnote-index="1" data-footnote-id="f1"><sup><a href="#fnf1">[1]</a></sup></span></p>' +
      '<ol class="footnote-section footnotes"><li class="footnote-item" data-footnote-item="" data-footnote-index="1"><span class="footnote-back-link"><sup><strong><a href="#fnreff1">^</a></strong></sup></span><div class="footnote-content"><p>Erste.</p><ol><li>Liste</li></ol><p>Mit <span class="math-tex">\\(x^2\\)</span>.</p></div></li></ol>';
    const { plan } = await planOf({ '!!!meta.json': meta, 'A.html': html }, 'trilium');
    const a = note(plan, 'A.md')!;
    expect(a).toContain('x $a < b$ y[^1]');
    expect(a).toMatch(/\[\^1\]: Erste\.\n {4}\n {4}1\. Liste\n {4}\n {4}Mit \$x\^2\$\./);
    // Openers without their end, many times – only the own step: the HTML converter itself is slow on deeply nested
    // tags (the conversion runs in its own process with a time limit).
    const MB = 256 * 1024;
    const crafted = '<span class="math-tex">\\(x'.repeat(MB / 28) + '<span class="footnote-reference" data-footnote-index="1">'.repeat(MB / 58) + '<ol class="footnote-section"><li data-footnote-item data-footnote-index="1">'.repeat(MB / 80) + 'kwmath0z';
    const start = performance.now();
    const kept = new Kept('kwmath', crafted);
    kept.restore(footnotesHtml(formulas(crafted, kept), kept));
    expect(performance.now() - start).toBeLessThan(5000 * SLOW);
  });
});

describe('linksToText (audit 0.2.7 sec-005)', () => {
  it('turns links into their text and stays linear on a long run of escaped brackets', () => {
    expect(linksToText('a [Text \\[x\\]](#root/abc) b ![p](#root/q) \\[c](#root/d)', /#root\/[^\s)>]*/)).toBe('a Text \\[x\\] b p \\[c](#root/d)');
    const started = Date.now();
    linksToText(`[${'\\['.repeat(128 * 1024)}`, /#root\/[^\s)>]*/);
    expect(Date.now() - started).toBeLessThan(1000 * SLOW);
  });
});
