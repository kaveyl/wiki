import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findAnchor, helpTarget, parseHelp, slug } from './help';

const ROOT = resolve(import.meta.dirname, '../../../..');
const manual = readFileSync(join(ROOT, 'docs/BENUTZERHANDBUCH.md'), 'utf8');
const api = readFileSync(join(ROOT, 'docs/API.md'), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) && !n.endsWith('.test.ts') ? [p] : [];
  });
}

describe('in-app help', () => {
  it('builds anchors like GitHub and the manual’s own table of contents', () => {
    expect(slug('Links und „Verlinkt von“')).toBe('links-und-verlinkt-von');
    expect(slug('API und MCP (Claude, Hermes, Skripte)')).toBe('api-und-mcp-claude-hermes-skripte');
    expect(slug('Gruppen & Rechte')).toBe('gruppen--rechte');
    expect(slug('Speichern, Übertragen und Synchronisieren')).toBe('speichern-übertragen-und-synchronisieren');
  });

  it('splits the manual into chapters with sections, without title and table of contents', () => {
    const chapters = parseHelp(manual);
    expect(chapters[0]!.id).toBe('was-ist-kaveyl-wiki');
    expect(chapters.some((c) => c.id === 'inhalt')).toBe(false);
    expect(findAnchor(chapters, 'markdown-spickzettel')?.chapter.id).toBe('bearbeiten');
    expect(findAnchor(chapters, 'löschregeln')?.chapter.id).toBe('daten-protokoll-und-sicherungen');
    // Pictures point at the files the build ships (/hilfe/handbuch/…).
    const pics = [...chapters.map((c) => c.md).join('\n').matchAll(/\]\(\/hilfe\/handbuch\/([^)]+)\)/g)].map((m) => m[1]!);
    expect(pics.length).toBeGreaterThan(40);
    const missing = pics.filter((f) => !existsSync(join(ROOT, 'docs/handbuch', f)));
    expect(missing).toEqual([]);
    // An explicit id keeps the German anchor in a translated heading, and is not shown.
    const tr = parseHelp('## Backup and restore {#backup}\n\n### Targets {#ziele}\n\n#### Plans {#zeitpläne}\n');
    expect(tr[0]!.id).toBe('backup');
    expect(tr[0]!.subs[0]).toMatchObject({ id: 'ziele', title: 'Targets' });
    expect(findAnchor(tr, 'zeitpläne')?.chapter.id).toBe('backup');
    expect(tr[0]!.md).not.toContain('{#');
    // Code blocks may contain "## " lines without starting a chapter.
    expect(parseHelp('## A\n\n```\n## kein Kapitel\n```\n\n## B\n').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('links to a spot in the help get the help address – not the open note\'s (owner 21.10.)', () => {
    const md = parseHelp('## A\n\n[NPM](#nginx-proxy-manager), [MCP](API.md#mcp-clients-einrichten), [API](API.md), [web](https://x.example).\n')[0]!.md;
    expect(md).toContain('[NPM](/?hilfe=nginx-proxy-manager)');
    expect(md).toContain('[MCP](/?hilfe=api:mcp-clients-einrichten)');
    expect(md).toContain('[API](/?hilfe=api:)');
    expect(md).toContain('[web](https://x.example)');
    // Inside the API reference an anchor alone stays there.
    expect(parseHelp('## A\n\n[x](#tokens)\n', 'api')[0]!.md).toContain('[x](/?hilfe=api:tokens)');
    expect(helpTarget('/?hilfe=rechte-%C3%BCbersicht', 'api')).toEqual({ doc: 'handbuch', anchor: 'rechte-übersicht' });
    expect(helpTarget('#gruppen', 'api')).toEqual({ doc: 'api', anchor: 'gruppen' });
    expect(helpTarget('BENUTZERHANDBUCH.md#konto', 'api')).toEqual({ doc: 'handbuch', anchor: 'konto' });
    expect(helpTarget('plan/roadmap.md', 'handbuch')).toBeNull();
    expect(helpTarget('https://x.example', 'handbuch')).toBeNull();
  });

  it('every link inside the manual and every help anchor in the app leads somewhere', () => {
    const chapters = parseHelp(manual);
    const ok = (id: string) => !!findAnchor(chapters, id);
    const inManual = [...manual.matchAll(/\]\(#([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]!));
    expect(inManual.filter((id) => !ok(id))).toEqual([]);
    const code = sources(join(ROOT, 'apps/web/src'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const used = [
      ...[...code.matchAll(/help="([^"]+)"/g)].map((m) => m[1]!),
      ...[...code.matchAll(/openHelp\('([^']+)'(?!, 'api')/g)].map((m) => m[1]!),
      ...[...code.matchAll(/help=\{[^}]*'([^']+)'\s*:\s*'([^']+)'\}/g)].flatMap((m) => [m[1]!, m[2]!]),
      ...[...code.matchAll(/HelpButton anchor="([^"]+)"/g)].map((m) => m[1]!),
      // Input windows: inputDialog/promptDialog({ …, help: '…' }).
      ...[...code.matchAll(/\bhelp: '([^']+)'/g)].map((m) => m[1]!),
    ];
    // Settings → one section per tab.
    const tabs = /const HELP: Record<Page, string> = \{([\s\S]*?)\};/.exec(code)![1]!;
    used.push(...[...tabs.matchAll(/: '([^']+)'/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(30);
    expect([...new Set(used.filter((id) => !ok(id)))]).toEqual([]);
    // Translated manuals (docs/i18n/<lang>/, AD-046) keep the German anchors as explicit ids: same checks.
    const i18n = join(ROOT, 'docs/i18n');
    for (const l of existsSync(i18n) ? readdirSync(i18n).filter((n) => statSync(join(i18n, n)).isDirectory()) : []) {
      const file = join(i18n, l, 'BENUTZERHANDBUCH.md');
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const tr = parseHelp(text);
      const missing = [...new Set([...used, ...[...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]!))])].filter((id) => !findAnchor(tr, id));
      expect({ lang: l, missing }).toEqual({ lang: l, missing: [] });
      // Same chapters and sections as the German manual, in the same order: a section added in German needs its
      // translation too (owner 2026-10-22: English help is part of every release).
      const ids = (chapters: ReturnType<typeof parseHelp>) => chapters.flatMap((c) => [c.id, ...c.subs.map((x) => x.id), ...c.deep.map((x) => x.id)]);
      expect({ lang: l, ids: ids(tr) }).toEqual({ lang: l, ids: ids(parseHelp(manual)) });
      // The same pictures; drawn ones with text may come translated as handbuch/<lang>/<file> – then that file must exist.
      const own = [...text.matchAll(/\]\((handbuch\/[^)]+)\)/g)].map((m) => m[1]!);
      expect({ lang: l, missing: own.filter((f) => f.startsWith(`handbuch/${l}/`) && !existsSync(join(ROOT, 'docs', f))) }).toEqual({ lang: l, missing: [] });
      expect({ lang: l, pictures: own.map((f) => f.replace(`handbuch/${l}/`, 'handbuch/')) }).toEqual({ lang: l, pictures: [...manual.matchAll(/\]\((handbuch\/[^)]+)\)/g)].map((m) => m[1]) });
    }
    // Anchors into the API reference.
    const apiDoc = parseHelp(api);
    const inApi = [...code.matchAll(/openHelp\('([^']+)', 'api'\)/g)].map((m) => m[1]!);
    expect(inApi.length).toBeGreaterThan(0);
    expect(inApi.filter((id) => !findAnchor(apiDoc, id))).toEqual([]);
    // The API reference is a second document of the help.
    expect(parseHelp(api).length).toBeGreaterThan(3);
  });

  it('„Technik und Komponenten“ names every package Kaveyl Wiki uses', () => {
    const chapter = parseHelp(manual).find((c) => c.id === 'technik-und-komponenten')!.md;
    const pkgs = ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/core/package.json'].flatMap((f) => {
      const p = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, Record<string, string> | undefined>;
      return [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})];
    });
    // Type definitions and the workspace's own core are no components of their own.
    const named = pkgs.filter((n) => !n.startsWith('@types/') && !n.startsWith('@kaveyl-wiki/'));
    expect(named.length).toBeGreaterThan(40);
    expect([...new Set(named.filter((n) => !chapter.includes(`\`${n}\``)))]).toEqual([]);
    // The English manual names them too.
    const en = parseHelp(readFileSync(join(ROOT, 'docs/i18n/en/BENUTZERHANDBUCH.md'), 'utf8')).find((c) => c.id === 'technik-und-komponenten')!.md;
    expect([...new Set(named.filter((n) => !en.includes(`\`${n}\``)))]).toEqual([]);
  });
});
