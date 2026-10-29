// Excalidraw drawings (PLAN Phase 6, AD-027): stored as `assets/<name>.excalidraw.svg` next to
// the note — an SVG with the scene embedded, so it shows as a plain image everywhere (Gitea,
// VS Code, Wiki.js) and opens again for editing here. Excalidraw itself is only loaded when a
// drawing is opened (own chunk).
import { Suspense } from 'react';
import { create } from 'zustand';
import type { Editor } from '@tiptap/react';
import { resolveHref } from '@kaveyl-wiki/core';
import { Modal, PartLoading } from '../ui';
import { toast } from '../toast';
import { isSealed } from './sealed';
import { t } from '../i18n';
import { lazyPart } from '../lazyPart';

export interface DrawingTarget {
  editor: Editor;
  mountId: string;
  notePath: string;
  /** An existing drawing (path in the source) — otherwise a new one is inserted at `pos`. */
  path?: string;
  pos?: number;
}

export const useDrawing = create<{ target: DrawingTarget | null; open(t: DrawingTarget): void; close(): void }>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** Source and note of each editor (registered by the note view; slash menu and image menu have no other context). */
export const drawingContexts = new WeakMap<Editor, { mountId: string; notePath: string }>();

/** Edited drawings get a new version number so the browser does not show the cached image. */
export const drawingVersions = new Map<string, number>();

// `name.excalidraw-2.svg`: how older versions numbered a second drawing of the same name.
export const isDrawingSrc = (src: string) => /\.excalidraw(-\d+)?\.svg$/i.test(safeDecode(src).split(/[?#]/)[0] ?? '');

function safeDecode(s: string) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Opens a new drawing (pos given) or the one behind an image source. */
export function openDrawing(editor: Editor, src?: string, pos?: number) {
  const ctx = drawingContexts.get(editor);
  if (!ctx) return;
  if (isSealed(ctx.mountId, ctx.notePath)) {
    toast({ kind: 'warn', title: t('Zeichnungen gibt es in verschlüsselten Notizen nicht'), text: t('Die Zeichnung läge unverschlüsselt in assets/.') });
    return;
  }
  if (src) {
    const target = resolveHref(src, ctx.notePath);
    if (!target) return;
    useDrawing.getState().open({ editor, ...ctx, path: target.path });
  } else useDrawing.getState().open({ editor, ...ctx, pos: pos ?? editor.state.selection.from });
}

const DrawingEditor = lazyPart(() => import('./DrawingEditor').then((m) => m.default));

export function DrawingDialog() {
  const target = useDrawing((s) => s.target);
  const close = useDrawing((s) => s.close);
  if (!target) return null;
  return (
    <Modal help="bearbeiten" open wide="xl" onOpenChange={(o) => !o && close()} title={target.path ? t('Zeichnung bearbeiten') : t('Neue Zeichnung')}>
      <Suspense fallback={<PartLoading className="h-[70vh]" text={t('Zeichenfläche wird geladen …')} />}>
        <DrawingEditor target={target} onClose={close} />
      </Suspense>
    </Modal>
  );
}
