// „Importieren ▸ Aus anderem Programm …“ (docs/PLAN-IMPORT.md): the export (ZIP) of another program goes up, Kaveyl Wiki
// recognises the format and shows what it would bring – nothing is written before „Importieren“. Then a new folder with
// the notes and a report note in it (one commit); deleting the folder is the way back.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileArchive, Upload } from 'lucide-react';
import { api, errorText, type ImportPreview } from '../api';
import { t, tn } from '../i18n';
import { toast } from '../toast';
import { useWorkspace } from '../store';
import { Button, Field, FormError, Input, Modal, Spinner } from '../ui';

const MAX_BYTES = 500 * 1024 * 1024;

/** How to get the export out of each program – one sentence, the manual has the details. */
const HOW: Record<string, string> = {
  hedgedoc: t('HedgeDoc: oben rechts im Benutzermenü „Export user data“ (deutsch „Exportiere Nutzerdaten“) – lädt alle eigenen Notizen als ZIP. Bilder holt Kaveyl Wiki auf Wunsch vom HedgeDoc-Server.'),
  joplin: t('Joplin: im Menü Datei alles exportieren als „Markdown + Front Matter“, den Ordner danach als ZIP packen. Notizbücher, Bilder, Anhänge, Tags und To-dos kommen mit.'),
  logseq: t('Logseq (0.10.x): den Graph-Ordner (mit pages, journals und assets) als ZIP packen. Seiten, Namensräume, Journale, Eigenschaften, Aufgaben und Bilder kommen mit.'),
  silverbullet: t('SilverBullet: den Ordner des Space (die Seiten als .md-Dateien) als ZIP packen. Seiten, Unterordner, Bilder und [[Links]] kommen mit.'),
  obsidian: t('Obsidian: den Ordner des Tresors (Vault) als ZIP packen. Ordner, Bilder, Anhänge, [[Links]], Einbettungen, Callouts und Tags kommen mit.'),
  trilium: t('Trilium: Rechtsklick auf die oberste Notiz → Exportieren → „Markdown“ – lädt den Teilbaum als ZIP. Baum, Bilder, Anhänge, Labels, Links und eingebettete Notizen kommen mit; geschützte Notizen nur, wenn die geschützte Sitzung beim Export offen ist.'),
  wikijs: t('Wiki.js: unter Administration → Speicher „Local File System“ einschalten und „Dump all content to disk“ ausführen, den Ordner als ZIP packen (oder den Ordner des Git-Speichers). Seiten, Ordner, Sprachen, Bilder, Dateien, Tags und Links kommen mit.'),
  outline: t('Outline: in den Einstellungen unter Export den ganzen Arbeitsbereich oder im Menü einer Sammlung „Exportieren“ als Markdown exportieren und das ZIP herunterladen. Sammlungen, verschachtelte Dokumente, Bilder, Dateien, Hinweisboxen und Links kommen mit.'),
  markdown: t('Markdown-Ordner: ein Ordner mit .md-Dateien, gern mit Unterordnern und Bildern, als ZIP gepackt. Ordner, Bilder und Links bleiben erhalten.'),
};

export function ImportDialog({ mountId, parent, where, onClose }: { mountId: string; parent: string; where: string; onClose: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const token = useRef<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [name, setName] = useState('');
  const [pictures, setPictures] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Closing the dialog drops what is waiting on the server (or still going up).
  useEffect(
    () => () => {
      abort.current?.abort();
      if (token.current) void api.importCancel(token.current).catch(() => undefined);
    },
    [],
  );

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) return setError(t('Die Datei ist größer als 500 MB'));
    abort.current = new AbortController();
    setProgress(0);
    try {
      const p = await api.importUpload(mountId, parent, file, setProgress, abort.current.signal);
      token.current = p.token;
      setPreview(p);
      setName(p.name);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(errorText(e));
    } finally {
      setProgress(null);
      // The same file again after an error must count as a new choice.
      if (input.current) input.current.value = '';
    }
  };

  const changeFormat = async (format: string) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.importPreview(preview.token, format);
      if (name === preview.name) setName(p.name);
      setPreview(p);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importRun(preview.token, preview.format, name.trim() || preview.name, pictures && preview.remote.count > 0);
      token.current = null;
      await qc.invalidateQueries({ queryKey: ['tree', mountId] });
      const ws = useWorkspace.getState();
      ws.revealInTree(mountId, r.report);
      ws.openNote(mountId, r.report, t('Import-Bericht'));
      toast({ kind: 'ok', title: t('Import fertig'), text: `${tn(r.notes, '{n} Notiz', '{n} Notizen')}, ${tn(r.files, '{n} Datei', '{n} Dateien')} → ${r.folder}` });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    // While importing, the dialog stays: closing it would drop the waiting upload while the server is still writing.
    <Modal help="aus-anderen-programmen-importieren" open onOpenChange={(o) => !o && !busy && onClose()} title={t('Aus anderem Programm importieren')}>
      <div className="space-y-3 text-sm">
        {!preview ? (
          <>
            <p className="text-fg-muted">
              {t('Den Export des anderen Programms als ZIP wählen (höchstens 500 MB). Kaveyl Wiki erkennt das Format und zeigt, was übernommen wird – geschrieben wird erst nach „Importieren“, in einen neuen Ordner unter „{where}“.', { where })}
            </p>
            <ul className="space-y-1.5 text-xs text-fg-muted">
              {Object.values(HOW).map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            <input ref={input} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} data-testid="import-file" />
            <FormError>{error}</FormError>
            {progress !== null ? (
              <div className="space-y-1" role="status">
                <div className="h-2 overflow-hidden rounded bg-muted">
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <p className="text-xs text-fg-muted">{progress < 1 ? t('Wird hochgeladen … {p} %', { p: String(Math.round(progress * 100)) }) : t('Wird geprüft …')}</p>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  {t('Abbrechen')}
                </Button>
                <Button variant="primary" onClick={() => input.current?.click()} autoFocus>
                  <Upload className="h-3.5 w-3.5" /> {t('ZIP-Datei wählen …')}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <Field label={t('Format')} hint={HOW[preview.format]}>
              <select
                className="h-8 w-full rounded border border-line bg-bg px-2"
                value={preview.format}
                disabled={busy}
                onChange={(e) => void changeFormat(e.target.value)}
                aria-label={t('Format')}
              >
                {preview.formats.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.id === preview.detected ? t('{label} (erkannt)', { label: f.label }) : f.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Neuer Ordner')} hint={t('wird unter „{where}“ angelegt; gibt es ihn schon, kommt eine Nummer dazu', { where })}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Field>
            <p className="flex items-center gap-2" data-testid="import-counts">
              <FileArchive className="h-4 w-4 text-fg-muted" />
              {[tn(preview.notes, '{n} Notiz', '{n} Notizen'), tn(preview.files, '{n} Datei', '{n} Dateien'), tn(preview.folders, 'Ein Ordner', '{n} Ordner')].join(' · ')}
            </p>
            {preview.remote.count > 0 && (
              <div className="space-y-0.5">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={pictures} disabled={busy} onChange={(e) => setPictures(e.target.checked)} aria-describedby="import-pictures-hint" />
                  {tn(preview.remote.count, 'Das Bild vom alten Server holen ({servers})', '{n} Bilder vom alten Server holen ({servers})', { servers: preview.remote.servers.join(', ') })}
                </label>
                <p id="import-pictures-hint" className="text-xs text-fg-muted">
                  {t('Der Export enthält sie nicht. Kaveyl Wiki lädt sie beim Importieren einmal von dort; was nicht ankommt, bleibt ein Web-Link und steht im Import-Bericht.')}
                </p>
              </div>
            )}
            {preview.warnings.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-fg-muted">{t('Hinweise (stehen danach auch im Import-Bericht)')}</p>
                {preview.warnings.map((w) => (
                  <details key={w.text} className="rounded border border-line px-2 py-1 text-xs">
                    <summary className="cursor-pointer">
                      {w.text} ({w.items.length + w.more})
                    </summary>
                    <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-fg-muted">
                      {w.items.map((i) => (
                        <li key={i}>{i.replace(/\.md$/, '')}</li>
                      ))}
                      {w.more > 0 && <li>{t('… und {n} weitere', { n: String(w.more) })}</li>}
                    </ul>
                  </details>
                ))}
              </div>
            )}
            <FormError>{error}</FormError>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                {t('Abbrechen')}
              </Button>
              <Button variant="primary" onClick={() => void run()} disabled={busy || !preview.notes}>
                {busy ? <Spinner /> : <Upload className="h-3.5 w-3.5" />} {t('Importieren')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
