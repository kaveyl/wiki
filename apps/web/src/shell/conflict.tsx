// Sync conflict of a remote mount: per file the three versions (base / mine / theirs) and
// a choice — keep mine, take theirs, or merge by hand (prefilled with git's conflict
// markers). Resolving creates a merge commit and pushes; nothing is overwritten silently.
// SEE-DOC: docs/PLAN.md §2.8
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText, type ConflictFile } from '../api';
import { t } from '../i18n';
import { toast } from '../toast';
import { Button, Modal, Spinner, cx, useTabs, FormError } from '../ui';

type Choice = 'mine' | 'theirs' | 'manual';

/** Encrypted note (age block): only taken as a whole – merged lines could never be decrypted again. */
const sealed = (f: ConflictFile) => [f.mine, f.theirs, f.base].some((x) => x?.includes('-----BEGIN AGE ENCRYPTED FILE-----'));

export function ConflictDialog({ mountId, onClose }: { mountId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const conflict = useQuery({ queryKey: ['conflict', mountId], queryFn: () => api.conflict(mountId) });
  const files = conflict.data?.files ?? [];
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState<Record<string, { choice: Choice; manual: string }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setChoices(Object.fromEntries(files.map((f) => [f.path, { choice: (sealed(f) ? 'mine' : 'manual') as Choice, manual: f.merged ?? f.mine ?? f.theirs ?? '' }])));
    setIndex(0);
  }, [conflict.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const file = files[index];
  const tabs = useTabs(
    files.map((_, i) => i),
    index,
    setIndex,
  );
  const state = file ? choices[file.path] : undefined;
  const set = (path: string, patch: Partial<{ choice: Choice; manual: string }>) => setChoices((c) => ({ ...c, [path]: { ...c[path]!, ...patch } }));
  const unresolvedMarkers = files.filter((f) => choices[f.path]?.choice === 'manual' && /^(<{7}|>{7}|={7})( |$)/m.test(choices[f.path]!.manual));

  const resolve = async () => {
    setBusy(true);
    try {
      const resolutions = files.map((f) => {
        const c = choices[f.path]!;
        return { path: f.path, content: c.choice === 'mine' ? f.mine : c.choice === 'theirs' ? f.theirs : c.manual };
      });
      await api.resolveConflict(mountId, resolutions);
      await qc.invalidateQueries();
      toast({ kind: 'ok', title: t('Konflikt aufgelöst'), text: t('Zusammengeführt und synchronisiert.') });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: t('Auflösen fehlgeschlagen'), text: errorText(e) });
      if (e instanceof ApiError && e.status === 409) void conflict.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal help="konflikte-auflösen" open wide="xl" onOpenChange={(o) => !o && onClose()} title={t('Konflikt auflösen')}>
      {conflict.isPending && <Spinner />}
      <FormError>{conflict.isError && errorText(conflict.error)}</FormError>
      {conflict.data && files.length === 0 && (
        <p className="text-sm text-fg-muted">{t('Kein Konflikt mehr – die Änderungen lassen sich inzwischen automatisch zusammenführen. Einfach synchronisieren.')}</p>
      )}
      {file && state && (
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">
            {t(
              'Deine Änderungen und Änderungen auf dem Server betreffen dieselben Stellen. Wähle pro Datei, welche Fassung gilt – oder führe sie von Hand zusammen. Deine Version ist bis dahin gesichert.',
            )}
          </p>
          {files.length > 1 && (
            <div className="flex flex-wrap gap-1" {...tabs.list} aria-label={t('Dateien mit Konflikt')}>
              {files.map((f, i) => (
                <button key={f.path} {...tabs.tab(i)} className={cx('rounded-md px-2 py-1 text-xs', i === index ? 'bg-accent-soft text-accent' : 'bg-muted text-fg-muted')}>
                  {f.path}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-3" {...(files.length > 1 ? tabs.panel : {})}>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <Version title={t('Basis (gemeinsamer Stand)')} text={file.base} />
              <Version title={t('Meine Version')} text={file.mine} />
              <Version title={t('Fremde Version (Server)')} text={file.theirs} />
            </div>
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1 text-sm" role="radiogroup" aria-label={t('Auflösung für {path}', { path: file.path })}>
              {(
                [
                  ['mine', t('Meine behalten')],
                  ['theirs', t('Fremde übernehmen')],
                  ['manual', t('Manuell zusammenführen')],
                ] as const
              )
                .filter(([k]) => k !== 'manual' || !sealed(file))
                .map(([k, label]) => (
                  <button key={k} role="radio" aria-checked={state.choice === k} className={cx('rounded-md px-3 py-1', state.choice === k ? 'bg-bg shadow-sm' : 'text-fg-muted')} onClick={() => set(file.path, { choice: k })}>
                    {label}
                  </button>
                ))}
            </div>
            {sealed(file) && (
              <p className="text-xs text-fg-muted">{t('Verschlüsselte Notiz: nur eine Fassung ganz übernehmen. Was in der anderen stand, lässt sich danach über die Versionen der Notiz zurückholen.')}</p>
            )}
            {state.choice === 'manual' && (
              <textarea
                aria-label={t('Zusammengeführter Text')}
                className="h-48 w-full rounded-md border border-line bg-bg p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
                value={state.manual}
                onChange={(e) => set(file.path, { manual: e.target.value })}
              />
            )}
          </div>
          {unresolvedMarkers.length > 0 && <p className="text-xs text-warn">{t('Noch Konfliktmarker (<<<<<<< / =======) in: {files}', { files: unresolvedMarkers.map((f) => f.path).join(', ') })}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('Später')}
            </Button>
            <Button variant="primary" disabled={busy || unresolvedMarkers.length > 0} onClick={() => void resolve()}>
              {busy && <Spinner />} {t('Auflösen und synchronisieren')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Version({ title, text }: { title: string; text: string | null }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-fg-muted">{title}</div>
      <pre className="h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-muted p-2 font-mono text-xs" aria-label={title}>
        {text ?? t('(Datei gelöscht)')}
      </pre>
    </div>
  );
}
