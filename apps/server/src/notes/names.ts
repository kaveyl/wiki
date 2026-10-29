// Names and kinds of files – pure functions without the server around them (the import worker uses them too and must
// not load the database).
import { posix } from 'node:path';

export const ASSETS_DIR = 'assets';

/** Content types for inline display; everything else is served as a download. */
export const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

/** "Mein Angebot (v2).PDF" → "Mein-Angebot-(v2).pdf"; never empty, never a dotfile. */
export function attachmentName(original: string): string {
  const base = original.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"|?*#%[\]()`{}^~]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 100);
  return `${stem || 'datei'}${ext ? `.${ext}` : ''}`;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isAttachmentPath(rel: string): boolean {
  return rel.split('/').slice(0, -1).includes(ASSETS_DIR);
}

/**
 * What /api/files serves: images/PDF anywhere, other files only as attachments in `assets/`;
 * never dotfiles (.env, .kaveyl-wiki.yml …). Files that come along with a copied note follow it too.
 */
export function isServable(rel: string): boolean {
  return !rel.split('/').some((seg) => seg.startsWith('.')) && (Object.hasOwn(INLINE_TYPES, posix.extname(rel).slice(1).toLowerCase()) || isAttachmentPath(rel));
}

/** File-system-safe name that stays readable in VS Code/Gitea ("Mein Plan: v2" → "Mein Plan - v2"). */
export function fileNameFor(title: string): string {
  const name = title
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/ -(?: -)+ /g, ' - ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 120)
    .replace(/[.\s-]+$/, '');
  return name || 'Neue Notiz';
}
