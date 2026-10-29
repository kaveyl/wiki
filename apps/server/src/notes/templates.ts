// Note templates: Markdown files in `.kaveyl-wiki/templates/` of a source (versioned with it,
// editable in VS Code). Variables: {{title}} {{date}} {{time}} {{datetime}} {{year}} {{month}}
// {{day}} {{weekday}} {{user}}. SEE-DOC: docs/PLAN.md §3a
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setFrontmatterKeys } from '@kaveyl-wiki/core';
import type { Author } from '../git/sync.js';
import type { MountManager } from '../mounts/manager.js';
import { absPath, PathError, type Mount } from '../mounts/model.js';
import { fileNameFor, ForbiddenError, NotFoundError } from './service.js';
import { META_DIR } from './meta.js';

export const TEMPLATE_DIR = `${META_DIR}/templates`;

export interface TemplateInfo {
  /** File name inside the template folder (the template's id). */
  name: string;
  title: string;
}

export async function listTemplates(mount: Mount, dataPath: string): Promise<TemplateInfo[]> {
  // Never through a link (AD-047): the template folder or the app folder could point anywhere.
  const files = await Promise.resolve()
    .then(() => readdir(absPath(mount, dataPath, TEMPLATE_DIR), { withFileTypes: true }))
    .catch(() => []);
  const out: TemplateInfo[] = [];
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.md') || f.name.startsWith('.')) continue;
    // Shown by file name like every note (AD-022): many templates start with „# {{title}}“.
    out.push({ name: f.name, title: f.name.replace(/\.md$/i, '') });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'de'));
}

function templatePath(mount: Mount, dataPath: string, name: string): string {
  if (!/^[^/\\]+\.md$/.test(name) || name.startsWith('.')) throw new PathError('Ungültiger Vorlagenname');
  return absPath(mount, dataPath, `${TEMPLATE_DIR}/${name}`);
}

export async function readTemplate(mount: Mount, dataPath: string, name: string): Promise<string> {
  const raw = await readFile(templatePath(mount, dataPath, name), 'utf8').catch(() => null);
  if (raw === null) throw new NotFoundError(name);
  return raw;
}

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** Replaces `{{var}}` placeholders; unknown ones stay as written. Local server time. */
export function renderTemplate(raw: string, vars: { title: string; user: string }, now = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const values: Record<string, string> = {
    title: vars.title,
    date,
    time,
    datetime: `${date} ${time}`,
    year: String(now.getFullYear()),
    month: pad(now.getMonth() + 1),
    day: pad(now.getDate()),
    weekday: WEEKDAYS[now.getDay()]!,
    user: vars.user,
  };
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => values[key.toLowerCase()] ?? m);
}

/** Saves a note's content as a template (without its id, so notes from it get their own). */
export async function saveAsTemplate(manager: MountManager, dataPath: string, mount: Mount, raw: string, title: string, author: Author): Promise<TemplateInfo> {
  if (mount.options.readonly) throw new ForbiddenError('Mount ist schreibgeschützt');
  const name = `${fileNameFor(title)}.md`;
  const abs = templatePath(mount, dataPath, name);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, setFrontmatterKeys(raw, { id: undefined }));
  await manager.touched(mount, [`${TEMPLATE_DIR}/${name}`], author, `Vorlage ${name} gespeichert`);
  return { name, title };
}
