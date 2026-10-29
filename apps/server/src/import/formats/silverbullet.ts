// SilverBullet: the space is a folder of Markdown pages – zip that folder. Page names are paths from the space's top
// (`[[Touren/2026/Plan]]`), so the shared wiki-link converter resolves them. Checked with a space of SilverBullet 2.12.1
// written through its own server (28.10.2026). System pages (CONFIG, SETTINGS, the standard library, plugs) stay out;
// `> **note**` boxes become callouts; Lua expressions and queries stay as text and are named in the report.
import type { SourceFile } from '../zip.js';
import type { Draft, ImportFormat } from '../types.js';
import { CALLOUT_KINDS, outsideCode } from '../text.js';
import { markdown } from './markdown.js';

/** SilverBullet's own pages and folders: configuration and code, no content. */
const SYSTEM = /^(CONFIG|SETTINGS|SECRETS|PLUGS)\.md$|^(_plug|Library\/Std)\//;
const DYNAMIC = /\$\{[\s\S]*?\}|```(space-lua|query|template)\b|\bquery\[\[/;

export const silverbullet: ImportFormat = {
  id: 'silverbullet',
  label: 'SilverBullet',
  async detect(files) {
    if (files.some((f) => /^(CONFIG|SETTINGS)\.md$/.test(f.path) || f.path.startsWith('_plug/'))) return 3;
    for (const f of files.filter((x) => /\.md$/i.test(x.path)).slice(0, 100)) if (/```space-lua\b|\$\{(query|template|widgets)\b/.test((await f.text()) ?? '')) return 3;
    return 0;
  },
  async convert(files) {
    const system = files.filter((f: SourceFile) => SYSTEM.test(f.path));
    const draft: Draft = await markdown.convert(files.filter((f) => !SYSTEM.test(f.path)));
    const dynamic: string[] = [];
    for (const n of draft.notes) {
      if (DYNAMIC.test(n.content)) dynamic.push(n.from);
      n.content = outsideCode(n.content, admonitions, false);
    }
    if (system.length) draft.warnings.push({ text: 'Einstellungen und Erweiterungen von SilverBullet (CONFIG, Bibliothek, Plugs) – nicht übernommen', items: system.map((f) => f.path) });
    if (dynamic.length) draft.warnings.push({ text: 'Lua-Ausdrücke und Abfragen von SilverBullet – sie stehen als Text in der Notiz und werden nicht ausgeführt', notes: dynamic });
    return draft;
  },
};

/** `> **note** Titel` (SilverBullet's admonition) → `> [!NOTE]` with the title as first line. */
function admonitions(part: string): string {
  return part.replace(/^>[ \t]*\*\*(note|info|tip|warning|danger)\*\*[ \t]*(.*)$/gim, (_all, kind: string, title: string) => `> [!${CALLOUT_KINDS[kind.toLowerCase()]}]${title.trim() ? `\n> **${title.trim()}**` : ''}`);
}
