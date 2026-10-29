// The Excalidraw canvas (loaded lazily by Drawing.tsx). Saves an SVG with the scene embedded:
// new drawings are uploaded to `assets/` and inserted as an image, edited ones replace their
// file in place (the old version stays in git).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Excalidraw, exportToSvg, loadFromBlob } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { api, errorText } from '../api';
import { Button, Spinner, useModalDirty } from '../ui';
import { toast } from '../toast';
import { lang, t } from '../i18n';
import { drawingVersions, type DrawingTarget } from './Drawing';

// Fonts come from Kaveyl Wiki itself (copied at build time), not from a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';

export default function DrawingEditor({ target, onClose }: { target: DrawingTarget; onClose: () => void }) {
  const qc = useQueryClient();
  const excalidraw = useRef<ExcalidrawImperativeAPI | null>(null);
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null | undefined>(target.path ? undefined : null);
  const [busy, setBusy] = useState(false);
  // Drawn something: closing with Esc or × asks first. Excalidraw also reports the loaded scene.
  const baseVersion = useRef<number | null>(null);
  const [changed, setChanged] = useState(false);
  useModalDirty(changed);
  const dark = document.documentElement.classList.contains('dark');

  useEffect(() => {
    if (!target.path) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(api.fileUrl(target.mountId, target.path!), { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(t('Datei nicht lesbar ({status})', { status: res.status }));
        const scene = await loadFromBlob(await res.blob(), null, null);
        if (!cancelled) setInitial({ elements: scene.elements, appState: { ...scene.appState, collaborators: undefined }, files: scene.files, scrollToContent: true });
      } catch (e) {
        if (cancelled) return;
        toast({ kind: 'error', title: t('Zeichnung nicht lesbar'), text: t('Ist es eine Excalidraw-Datei mit eingebetteter Szene? {error}', { error: e instanceof Error ? e.message : '' }) });
        onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.mountId, target.path, onClose]);

  const save = async () => {
    const ex = excalidraw.current;
    if (!ex) return;
    const elements = ex.getSceneElements();
    if (!elements.length) {
      toast({ kind: 'warn', title: t('Die Zeichnung ist leer') });
      return;
    }
    setBusy(true);
    try {
      const svg = await exportToSvg({ elements, appState: { ...ex.getAppState(), exportEmbedScene: true, exportBackground: true }, files: ex.getFiles() });
      const file = new File([new XMLSerializer().serializeToString(svg)], 'zeichnung.excalidraw.svg', { type: 'image/svg+xml' });
      const { editor, mountId, notePath } = target;
      if (target.path) {
        await api.replaceAttachment(mountId, notePath, target.path, file);
        drawingVersions.set(`${mountId}:${target.path}`, Date.now());
        // Images already on screen: load the new version.
        const url = api.fileUrl(mountId, target.path);
        for (const img of document.querySelectorAll<HTMLImageElement>('.note-image img')) {
          if (img.src.split('?')[0]!.endsWith(url)) img.src = `${url}?v=${drawingVersions.get(`${mountId}:${target.path}`)}`;
        }
      } else {
        const stored = await api.upload(mountId, notePath, file);
        editor
          .chain()
          .focus()
          .insertContentAt(target.pos ?? editor.state.selection.from, [{ type: 'image', attrs: { src: stored.href, alt: 'Zeichnung' } }])
          .run();
      }
      await qc.invalidateQueries({ queryKey: ['attachments', mountId, notePath] });
      toast({ kind: 'ok', title: t('Zeichnung gespeichert') });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: t('Zeichnung nicht gespeichert'), text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (initial === undefined) {
    return (
      <div className="flex h-[70vh] items-center justify-center gap-2 text-sm text-fg-muted">
        <Spinner /> {t('Zeichnung wird geladen …')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="h-[70vh] overflow-hidden rounded-lg border border-line" data-testid="excalidraw">
        <Excalidraw
          excalidrawAPI={(a) => (excalidraw.current = a)}
          initialData={initial}
          theme={dark ? 'dark' : 'light'}
          langCode={lang === 'de' ? 'de-DE' : 'en'}
          onChange={(elements) => {
            const v = elements.reduce((n, e) => n + e.version, 0);
            if (baseVersion.current === null) baseVersion.current = v;
            else if (v !== baseVersion.current) setChanged(true);
          }}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-fg-muted">{t('Gespeichert als SVG in assets/ – überall als Bild sichtbar, hier wieder bearbeitbar.')}</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('Abbrechen')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy && <Spinner className="h-3.5 w-3.5" />} {t('Speichern')}
          </Button>
        </div>
      </div>
    </div>
  );
}
