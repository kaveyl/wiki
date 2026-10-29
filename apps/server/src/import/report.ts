// The report note of an import (`Import-Bericht.md` in the new folder): what came over, what did not and where to look.
// Written in the language of the person importing; German sentences, translated line by line (server i18n).
import { formatLink, type Lang } from '@kaveyl-wiki/core';
import { translateMessage } from '../i18n/index.js';
import { REPORT_NAME } from './build.js';
import { UNREAD } from './service.js';
import type { Warning } from './types.js';

const MAX_ITEMS = 200;

export interface ReportInput {
  lang: Lang;
  format: string;
  fileName: string;
  by: string;
  at: Date;
  notes: number;
  files: number;
  folders: number;
  warnings: Warning[];
  /** Left out when writing (encrypted marking, mount filter). */
  skipped: string[];
  /** Entries of the ZIP not read (encrypted, invalid name, too big). */
  unread: string[];
}

export function reportText(r: ReportInput): string {
  const t = (s: string) => translateMessage(r.lang, s);
  const date = r.at.toISOString().slice(0, 10);
  const lines = [
    `# ${t('Import-Bericht')}`,
    '',
    t(`Importiert aus ${t(r.format)} am ${date} von ${r.by} (Datei „${r.fileName}“).`),
    '',
    `- ${t('Notizen')}: ${r.notes}`,
    `- ${t('Dateien')}: ${r.files}`,
    `- ${t('Ordner')}: ${r.folders}`,
    '',
  ];
  const all: Warning[] = [...r.warnings];
  if (r.unread.length) all.push({ text: UNREAD, notes: [], items: r.unread });
  if (r.skipped.length) all.push({ text: 'Nicht geschrieben (als verschlüsselt markiert oder vom Filter der Quelle ausgeblendet)', notes: [], items: r.skipped });
  if (!all.length) lines.push(t('Alles übernommen – keine Hinweise.'), '');
  else lines.push(`## ${t('Hinweise')}`, '');
  for (const w of all) {
    const entries = [
      ...w.notes.map((p) => `- [${escapeText(p.replace(/\.md$/, ''))}](${formatLink('x.md', REPORT_NAME, p, 'index.md', null)})`),
      ...w.items.map((i) => `- ${escapeText(i)}`),
    ];
    lines.push(`### ${t(w.text)} (${entries.length})`, '', ...entries.slice(0, MAX_ITEMS));
    if (entries.length > MAX_ITEMS) lines.push(`- ${t(`… und ${entries.length - MAX_ITEMS} weitere`)}`);
    lines.push('');
  }
  return lines.join('\n');
}

const escapeText = (s: string) => s.replace(/[\\`*_[\]<>#|]/g, '\\$&');
