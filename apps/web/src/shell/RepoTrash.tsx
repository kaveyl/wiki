// Deleting a Gitea repository from Kaveyl Wiki (admin): into the repository trash (archived on
// Gitea, restorable for 30 days, then deleted by the nightly job) or deleted right away
// after typing its full name. A bundle backup is made before every final deletion.
// SEE-DOC: DECISIONS.md AD-014
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, RotateCcw, Trash2 } from 'lucide-react';
import { api, errorText } from '../api';
import { toast } from '../toast';
import { RuleRow } from './Cleanup';
import { Button, Field, Input, Modal, Spinner, cx, fillNodes } from '../ui';
import { fmtBytes, fmtDate, t, tn } from '../i18n';

const day = (iso: string) => fmtDate(iso, { dateStyle: 'medium' });

export function RepoDeleteDialog({ fullName, connectionId, onClose }: { fullName: string; connectionId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'trash' | 'now'>('trash');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (mode === 'trash') {
        const r = await api.trashRepo(connectionId, fullName);
        toast({
          kind: 'ok',
          title: t('In den Papierkorb gelegt'),
          text: t('{name} ist archiviert und wird am {date} endgültig gelöscht. Wiederherstellen unter Einstellungen → Quellen → Eingebundene Quellen.', {
            name: fullName,
            date: day(r.entry.deleteAfter),
          }),
        });
      } else {
        const r = await api.deleteRepo(connectionId, fullName, confirm);
        toast({ kind: 'ok', title: t('Repository gelöscht'), text: t('Sicherung: {bundle}', { bundle: r.bundle }) });
      }
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: t('Löschen fehlgeschlagen'), text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal help="repositories-löschen" open onOpenChange={(o) => !o && onClose()} title={t('Repository löschen')}>
      <div className="space-y-3 text-sm">
        <p>
          {fillNodes(
            t(
              '{name} auf dem Server löschen. Eingebundene Quellen dieses Repositorys werden vorher ausgehängt. Zum reinen Aushängen ohne Löschen: „Quelle bearbeiten …“ → Aushängen.',
            ),
            { name: <b>{fullName}</b> },
          )}
        </p>
        <div className="space-y-1.5" role="radiogroup" aria-label={t('Art des Löschens')}>
          {(
            [
              [
                'trash',
                <Archive key="a" className="h-4 w-4" />,
                t('In den Papierkorb (empfohlen)'),
                t('Wird archiviert (schreibgeschützt) und nach 30 Tagen endgültig gelöscht. Bis dahin wiederherstellbar.'),
              ],
              [
                'now',
                <Trash2 key="t" className="h-4 w-4" />,
                t('Sofort endgültig löschen'),
                t('Nicht rückgängig zu machen. Vorher wird eine Git-Sicherung (Bundle) für 30 Tage angelegt.'),
              ],
            ] as const
          ).map(([k, icon, label, hint]) => (
            <label key={k} className={cx('flex cursor-pointer gap-2.5 rounded-lg border p-2.5', mode === k ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}>
              <input type="radio" name="repo-delete" className="mt-0.5" checked={mode === k} onChange={() => setMode(k)} aria-label={label} />
              <span>
                <span className={cx('flex items-center gap-1.5 font-medium', k === 'now' && 'text-danger')}>
                  {icon} {label}
                </span>
                <span className="block text-xs text-fg-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {mode === 'now' && (
          <Field label={t('Zum Bestätigen „{name}“ eingeben', { name: fullName })}>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('Abbrechen')}
          </Button>
          <Button variant="primary" className={cx(mode === 'now' && 'bg-danger')} disabled={busy || (mode === 'now' && confirm !== fullName)} onClick={() => void run()}>
            {busy && <Spinner />} {mode === 'trash' ? t('In den Papierkorb') : t('Endgültig löschen')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Settings → Quellen: repositories in the trash and bundle backups. */
export function RepoTrashPanel() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['repo-trash'], queryFn: api.repoTrash });
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ kind: 'ok', title: ok });
      setDeleting(null);
      setConfirm('');
      await qc.invalidateQueries({ queryKey: ['repo-trash'] });
    } catch (e) {
      toast({ kind: 'error', title: t('Fehlgeschlagen'), text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
  const repos = data.data?.repos ?? [];
  const bundles = data.data?.bundles ?? [];
  return (
    <section className="space-y-3 border-t border-line pt-4 text-sm" aria-label={t('Gelöschte Repositories')}>
      <h3 className="font-medium">{t('Gelöschte Repositories (Papierkorb)')}</h3>
      <p className="text-fg-muted">
        {t(
          'Repositories, die du per Rechtsklick auf eine Quelle (Gitea, GitHub, GitLab) → „Repository löschen …“ in den Papierkorb gelegt hast. Sie sind dort archiviert und lassen sich bis zur endgültigen Löschung wiederherstellen.',
        )}
      </p>
      {data.isPending && <Spinner />}
      {data.data && repos.length === 0 && <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-fg-muted">{t('Keine gelöschten Repositories')}</p>}
      {repos.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {repos.map((r) => (
            <li key={r.fullName} className="space-y-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.fullName}</span>
                  <span className="block text-xs text-fg-muted">
                    {r.connectionName ? `${r.connectionName} · ` : ''}
                    {r.actor
                      ? t('gelöscht am {date} von {actor}', { date: day(r.archivedAt), actor: r.actor })
                      : t('gelöscht am {date}', { date: day(r.archivedAt) })}{' '}
                    ·{' '}
                    {r.deleteAfter
                      ? tn(daysLeft(r.deleteAfter), 'noch {n} Tag (bis {date})', 'noch {n} Tage (bis {date})', { date: day(r.deleteAfter) })
                      : t('bleibt, bis du es löschst')}
                  </span>
                </span>
                <Button size="sm" disabled={busy !== null} onClick={() => void act(`r-${r.fullName}`, () => api.restoreRepo(r.connectionId, r.fullName), t('{name} wiederhergestellt', { name: r.fullName }))}>
                  {busy === `r-${r.fullName}` ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />} {t('Wiederherstellen')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={busy !== null}
                  aria-expanded={deleting === r.fullName}
                  onClick={() => (setDeleting(deleting === r.fullName ? null : r.fullName), setConfirm(''))}
                >
                  <Trash2 className="h-3.5 w-3.5" /> {t('Endgültig löschen …')}
                </Button>
              </div>
              {deleting === r.fullName && (
                <div className="space-y-2 rounded-lg border border-danger/40 p-2.5">
                  <p className="text-xs text-fg-muted">{t('Nicht rückgängig zu machen. Vorher wird eine Git-Sicherung (Bundle) angelegt.')}</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label={t('Zum Bestätigen „{name}“ eingeben', { name: r.fullName })}>
                      <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
                    </Field>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                      {t('Abbrechen')}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      className="bg-danger"
                      disabled={confirm !== r.fullName || busy !== null}
                      onClick={() => void act(`d-${r.fullName}`, () => api.deleteRepo(r.connectionId, r.fullName, confirm), t('{name} endgültig gelöscht', { name: r.fullName }))}
                    >
                      {busy === `d-${r.fullName}` && <Spinner className="h-3.5 w-3.5" />} {t('Endgültig löschen')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer text-sm">
          {bundles.length > 0
            ? tn(bundles.length, 'Technische Details · {n} Sicherung', 'Technische Details · {n} Sicherungen')
            : t('Technische Details')}
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>{t('Ein Repository im Papierkorb wird nach der eingestellten Zeit (unten, Standard 30 Tage) von einem nächtlichen Job endgültig gelöscht.')}</li>
          <li>
            {fillNodes(t('Vor jeder endgültigen Löschung entsteht eine Git-Sicherung (Bundle) in {pfad}; wie lange sie bleibt, steht ebenfalls unten.'), {
              pfad: <code>/config/backups/repos</code>,
            })}
          </li>
          <li>{t('Manuell wiederherstellen aus einer Sicherung:')}</li>
        </ul>
        <pre className="mt-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono">{t('git clone /config/backups/repos/<datei>.bundle')}</pre>
        {bundles.length > 0 && (
          <>
            <div className="mt-2 font-medium text-fg">{t('Vorhandene Sicherungen')}</div>
            <ul className="mt-1 divide-y divide-line rounded-md border border-line">
              {bundles.map((b) => (
                <li key={b.name} className="flex gap-2 px-2 py-1">
                  <code className="min-w-0 flex-1 truncate">{b.name}</code>
                  <span className="shrink-0">
                    {day(b.createdAt)} · {fmtBytes(b.size)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
      <div className="space-y-3 rounded-lg border border-line p-3" aria-label={t('Löschregeln')}>
        <h4 className="text-sm font-medium">{t('Löschregeln')}</h4>
        <RuleRow rule="repoTrashDays" label={t('Im Repository-Papierkorb lassen')} hint={t('Gilt auch für Repositories, die schon im Papierkorb liegen.')} />
        <RuleRow rule="repoBundleDays" label={t('Git-Sicherungen (Bundles) aufbewahren')} />
        <RuleRow
          rule="orphanCloneDays"
          label={t('Verwaiste lokale Kopien aufbewahren')}
          hint={t('Kopien ausgehängter Quellen in /data/repos; vor dem Löschen entsteht eine Git-Sicherung. Übersicht: Einstellungen → Werkzeuge → Aufräumen.')}
        />
      </div>
    </section>
  );
}
