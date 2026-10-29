// Hover preview for links to other notes (Trilium "note tooltip"): title, path and the start
// of the text, shown after a short delay; stays open while the pointer is on the card.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isExternal, noteCandidates, noteMeta, resolveHref } from '@kaveyl-wiki/core';
import { FileText } from 'lucide-react';
import { api, type Mount } from '../api';
import { noteNameIn } from '../names';
import { t } from '../i18n';

interface Preview {
  x: number;
  y: number;
  title: string;
  path: string;
  text: string;
  missing?: boolean;
}

const cache = new Map<string, Promise<Omit<Preview, 'x' | 'y'>>>();

function load(mount: Mount, target: string): Promise<Omit<Preview, 'x' | 'y'>> {
  const key = `${mount.id}:${target}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      for (const candidate of noteCandidates(target, mount.options.folderNote)) {
        try {
          const n = await api.note(mount.id, candidate);
          const meta = noteMeta(n.raw, candidate.split('/').pop()!);
          // The text starts with the title heading — skip it.
          const text = meta.text.replace(/^\s*/, '').replace(meta.title, '').trim();
          return { title: n.title, path: candidate, text: text.length > 320 ? `${text.slice(0, 320)} …` : text };
        } catch {
          /* next candidate */
        }
      }
      return { title: target, path: target, text: '', missing: true };
    })();
    cache.set(key, p);
    // Previews may go stale; keep them for a minute.
    setTimeout(() => cache.delete(key), 60_000);
  }
  return p;
}

export function LinkPreview({ container, mount, notePath }: { container: HTMLElement | null; mount: Mount; notePath: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const overCard = useRef(false);

  useEffect(() => {
    if (!container) return;
    let current: HTMLAnchorElement | null = null;
    const onOver = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a || a === current) return;
      const href = a.getAttribute('href');
      if (!href || isExternal(href) || href.startsWith('#')) return;
      const target = resolveHref(href, notePath);
      if (!target || /\.(?!md$)[a-z0-9]+$/i.test(target.path)) return;
      current = a;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void load(mount, target.path).then((p) => {
          if (current !== a) return;
          const r = a.getBoundingClientRect();
          // The note is no longer on screen (another tab came to the front): no card in the corner.
          if (!r.width && !r.height) return;
          setPreview({ ...p, x: Math.min(r.left, window.innerWidth - 340), y: r.bottom + 6 });
        });
      }, 350);
    };
    const onOut = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a || a !== current || a.contains(e.relatedTarget as Node)) return;
      current = null;
      clearTimeout(timer.current);
      setTimeout(() => !overCard.current && setPreview(null), 150);
    };
    // A click (any button) follows the link or edits: the preview has done its job.
    const onDown = () => {
      current = null;
      clearTimeout(timer.current);
      setPreview(null);
    };
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);
    container.addEventListener('mousedown', onDown);
    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseout', onOut);
      container.removeEventListener('mousedown', onDown);
      clearTimeout(timer.current);
    };
  }, [container, mount, notePath]);

  if (!preview) return null;
  return createPortal(
    <div
      role="tooltip"
      aria-label={t('Vorschau: {name}', { name: noteNameIn(mount.id, preview.path) })}
      className="fixed z-[65] w-80 rounded-lg border border-line bg-bg p-3 shadow-pop"
      style={{ left: preview.x, top: preview.y }}
      onMouseEnter={() => (overCard.current = true)}
      onMouseLeave={() => {
        overCard.current = false;
        setPreview(null);
      }}
    >
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <FileText className="h-4 w-4 shrink-0 text-fg-faint" />
        <span className="truncate">{noteNameIn(mount.id, preview.path)}</span>
      </div>
      <div className="mt-0.5 truncate text-[0.6875rem] text-fg-faint">{preview.path}</div>
      <p className="mt-2 line-clamp-6 text-xs leading-relaxed text-fg-muted">{preview.missing ? t('Diese Notiz gibt es (noch) nicht.') : preview.text || t('Keine weiteren Inhalte.')}</p>
    </div>,
    document.body,
  );
}
