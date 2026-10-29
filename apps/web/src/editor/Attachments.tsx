// Attachments: upload (button, drag & drop, paste) into `assets/` next to the note, inserted as
// a normal image or link; plus the "Anhänge" list below the note. SEE-DOC: docs/PLAN.md §2.6
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { Editor } from '@tiptap/react';
import { Download, Eye, FileText, Image as ImageIcon, Paperclip, AlertTriangle } from 'lucide-react';
import { api, errorText, type Mount } from '../api';
import { toast } from '../toast';
import { fmtBytes, t } from '../i18n';
import { encryptBytes, isSealed, passphraseFor } from './crypto';
import { shrinkImage } from './images';

/** Uploads files and inserts them at `pos` (default: cursor). Images become images, other files links. */
export async function uploadFiles(editor: Editor, qc: QueryClient, mount: Mount, notePath: string, files: File[], pos?: number) {
  let at = pos;
  // Decided now, before anything is awaited: locking meanwhile unmarks the note, and the file must not go out plain then.
  const sealedAtStart = isSealed(mount.id, notePath);
  const limits = await qc.fetchQuery({ queryKey: ['attachment-limits'], queryFn: api.attachmentLimits, staleTime: 60_000 }).catch(() => ({ imageMaxPx: 2400 }));
  for (const original of files) {
    try {
      // Large photos/screenshots: scaled down before upload (Einstellungen → Anhänge).
      const shrunk = await shrinkImage(original, limits.imageMaxPx);
      const file = shrunk.file;
      if (shrunk.info) {
        const { from, to, before, after } = shrunk.info;
        toast({ kind: 'ok', title: t('Bild verkleinert'), text: t('{name}: {from} → {to} Pixel, {before} → {after}', { name: original.name, from: `${from[0]}×${from[1]}`, to: `${to[0]}×${to[1]}`, before: size(before), after: size(after) }) });
      }
      // In an encrypted note the file is encrypted in the browser too (`name.png.age`).
      const sealed = sealedAtStart || isSealed(mount.id, notePath);
      const passphrase = sealed ? passphraseFor(mount.id, notePath) : null;
      // Locked in the meantime: never fall back to a plain upload.
      if (sealed && !passphrase) throw new Error(t('Die Notiz wurde gesperrt – entsperren und die Datei erneut hinzufügen.'));
      const a = passphrase
        ? await api.upload(mount.id, notePath, new File([(await encryptBytes(passphrase, new Uint8Array(await file.arrayBuffer()))) as BlobPart], `${file.name}.age`))
        : await api.upload(mount.id, notePath, file);
      const isImage = a.image || (!!passphrase && file.type.startsWith('image/'));
      const content: Record<string, unknown>[] = isImage
        ? [{ type: 'image', attrs: { src: a.href, alt: a.name.replace(/(\.[^.]+)?(\.age)?$/, '') } }]
        : [{ type: 'text', text: a.name, marks: [{ type: 'link', attrs: { href: a.href } }] }];
      // Keep a space between preceding text and the inserted file ("Ende. Angebot.pdf").
      const where = at ?? editor.state.selection.from;
      const before = where > 1 ? editor.state.doc.textBetween(where - 1, where, '\n', '\n') : '';
      if (before && !/\s/.test(before)) content.unshift({ type: 'text', text: ' ' });
      editor.chain().focus().insertContentAt(where, content).unsetMark('link').run();
      at = undefined;
    } catch (e) {
      toast({ kind: 'error', title: t('„{name}“ nicht angehängt', { name: original.name }), text: errorText(e) });
    }
  }
  await qc.invalidateQueries({ queryKey: ['attachments', mount.id, notePath] });
}

/** Opens a linked non-note file: images/PDF as preview in a new tab, everything else as download. */
export function openFile(mount: Mount, path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const preview = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'pdf'].includes(ext);
  window.open(preview ? api.fileUrl(mount.id, path) : api.downloadUrl(mount.id, path), '_blank', 'noopener');
}

/** Opens the file chooser and uploads the chosen files at the cursor. */
export function chooseFiles(editor: Editor, qc: QueryClient, mount: Mount, notePath: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (files.length) void uploadFiles(editor, qc, mount, notePath, files);
  };
  input.click();
}

const size = (n: number | null) => (n === null ? t('fehlt') : fmtBytes(n));

export function AttachmentList({ mount, path }: { mount: Mount; path: string }) {
  const list = useQuery({ queryKey: ['attachments', mount.id, path], queryFn: () => api.attachments(mount.id, path) });
  if (!list.data?.length) return null;
  return (
    <section className="mt-12 border-t border-line pt-4" aria-label={t('Anhänge')}>
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        <Paperclip className="h-3.5 w-3.5" /> {t('Anhänge ({n})', { n: list.data.length })}
      </h2>
      <ul className="space-y-0.5">
        {list.data.map((a) => (
          <li key={a.path} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-hover">
            {a.kind === 'image' ? <ImageIcon className="h-4 w-4 shrink-0 text-fg-faint" /> : <FileText className="h-4 w-4 shrink-0 text-fg-faint" />}
            <span className="truncate" title={a.path}>
              {a.name}
            </span>
            <span className="text-xs text-fg-faint">{size(a.size)}</span>
            {a.size === null ? (
              <span className="ml-auto flex items-center gap-1 text-xs text-warn">
                <AlertTriangle className="h-3.5 w-3.5" /> {t('Datei fehlt')}
              </span>
            ) : (
              <span className="ml-auto flex items-center gap-1">
                {a.kind !== 'file' && (
                  <a className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-active" href={api.fileUrl(mount.id, a.path)} target="_blank" rel="noopener" title={t('Vorschau')} aria-label={t('Vorschau {name}', { name: a.name })}>
                    <Eye className="h-3.5 w-3.5" />
                  </a>
                )}
                <a className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-active" href={api.downloadUrl(mount.id, a.path)} title={t('Herunterladen')} aria-label={t('Herunterladen {name}', { name: a.name })}>
                  <Download className="h-3.5 w-3.5" />
                </a>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
