// Large images (owner 2026-10-11): photos and screenshots are scaled down in the browser before
// they are uploaded (longest side: Einstellungen → Anhänge, default 2400 px, 0 = keep originals),
// so notes load and scroll quickly and repositories stay small. A full-size view („Lightbox“)
// shows an image as large as the window allows. EXIF data (e.g. GPS) is dropped on the way.
import { t } from '../i18n';

/** Formats the browser can decode and re-encode without losing anything that matters (no GIF/SVG). */
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);
/** Heavier files are re-encoded even when small enough in pixels (e.g. an uncompressed PNG). */
const HEAVY = 2 * 1024 * 1024;

export interface Shrunk {
  file: File;
  /** What happened, for a short note to the user; null = original kept. */
  info: { from: [number, number]; to: [number, number]; before: number; after: number } | null;
}

async function encode(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function shrinkImage(file: File, maxPx: number): Promise<Shrunk> {
  const keep: Shrunk = { file, info: null };
  if (!maxPx || !RESIZABLE.has(file.type)) return keep;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return keep;
  }
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (long <= maxPx && file.size <= HEAVY) return keep;
    const scale = Math.min(1, maxPx / long);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return keep;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    // WebP keeps transparency and text in screenshots sharp at a fraction of PNG's size.
    let blob = await encode(canvas, 'image/webp', file.type === 'image/png' ? 0.9 : 0.85);
    if (blob && blob.type !== 'image/webp') blob = file.type === 'image/jpeg' ? await encode(canvas, 'image/jpeg', 0.85) : null;
    if (!blob || blob.size >= file.size) return keep;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'bild'}.${ext}`;
    return { file: new File([blob], name, { type: blob.type, lastModified: file.lastModified }), info: { from: [bmp.width, bmp.height], to: [w, h], before: file.size, after: blob.size } };
  } finally {
    bmp.close();
  }
}

let open: HTMLElement | null = null;

/** Shows an image as large as the window allows; click, Esc or the × close it. */
export function openLightbox(src: string, alt: string) {
  open?.remove();
  const opener = document.activeElement as HTMLElement | null;
  // A <dialog> in the top layer: above everything, the whole window even inside a dialog box (transform, overflow).
  // Inside the topmost open `Modal` (help, versions) – it lets neither clicks nor the focus out of itself.
  const box = document.createElement('dialog');
  box.className = 'lightbox';
  box.setAttribute('aria-label', alt ? t('Bild: {alt}', { alt }) : t('Bild'));
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightbox-close';
  close.setAttribute('aria-label', t('Schließen'));
  close.textContent = '×';
  const caption = document.createElement('div');
  caption.className = 'lightbox-caption';
  caption.textContent = alt;
  const done = () => {
    if (box.open) box.close();
    box.remove();
    window.removeEventListener('keydown', key, true);
    if (open === box) open = null;
    opener?.focus?.();
  };
  // On `window` in the capture phase: before Radix (document) closes the dialog underneath.
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      done();
    }
  };
  box.addEventListener('click', done);
  window.addEventListener('keydown', key, true);
  box.append(img, close);
  if (alt) box.append(caption);
  const host = [...document.querySelectorAll<HTMLElement>('[data-modal][data-state="open"]')].at(-1) ?? document.body;
  host.append(box);
  box.showModal();
  open = box;
  close.focus();
}
