// A folder of Markdown files, zipped (from any program that saves plain `.md`, or a folder from the computer): folders,
// notes and files stay as they are, relative links keep working, `[[Name]]` links become Markdown links. Hidden
// files and folders (`.git`, `.obsidian` …) are tool settings, not content.
import type { Draft, DraftFile, DraftNote, ImportFormat } from '../types.js';

export const markdown: ImportFormat = {
  id: 'markdown',
  label: 'Markdown-Ordner',
  async detect(files) {
    return files.some((f) => /\.(md|markdown)$/i.test(f.path)) ? 2 : 0;
  },
  async convert(files) {
    const notes: DraftNote[] = [];
    const out: DraftFile[] = [];
    const hidden: string[] = [];
    const notText: string[] = [];
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = f.path.split('/');
      if (parts.some((p) => p.startsWith('.'))) {
        hidden.push(f.path);
        continue;
      }
      const name = parts.pop()!;
      if (/\.(md|markdown)$/i.test(name)) {
        const content = await f.text();
        if (content === null) notText.push(f.path);
        // Line by line as written on Windows too (callouts, block ids and the like are found per line).
        else notes.push({ from: f.path, dir: parts, name: name.replace(/\.(md|markdown)$/i, ''), content: content.replace(/\r\n?/g, '\n') });
      } else out.push({ from: f.path, dir: parts, name, source: f });
    }
    const draft: Draft = { notes, files: out, warnings: [], wikiLinks: true };
    if (hidden.length) draft.warnings.push({ text: 'Versteckte Dateien (Einstellungen anderer Programme) – nicht übernommen', items: hidden });
    if (notText.length) draft.warnings.push({ text: 'Markdown-Dateien, die kein lesbarer Text (UTF-8) sind – nicht übernommen', items: notText });
    return draft;
  },
};
