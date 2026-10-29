// Event log (sync, errors, security, system) with filters, plus the admin settings for
// retention and database backups. SEE-DOC: DECISIONS.md AD-013
import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ChevronRight, CircleHelp, Info } from 'lucide-react';
import { RuleRow } from './Cleanup';
import { openHelp } from '../help/help';
import { api, type ActivityEntry, type ActivityQuery, type BackupFile } from '../api';
import { Button, Modal, Spinner, cx, fillNodes } from '../ui';
import { fmtBytes, fmtDateTime, t, tn } from '../i18n';

const CATEGORY: Record<ActivityEntry['category'], string> = { sync: t('Sync'), error: t('Fehler'), audit: t('Sicherheit'), system: t('System') };
const when = (iso: string) => fmtDateTime(iso, { dateStyle: 'short', timeStyle: 'medium' });

export function ActivityList({ fixedMountId, fixedUserId, isAdmin }: { fixedMountId?: string; fixedUserId?: string; isAdmin: boolean }) {
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: isAdmin && !fixedUserId });
  const [mountId, setMountId] = useState(fixedMountId ?? '');
  const [userId, setUserId] = useState(fixedUserId ?? '');
  const [category, setCategory] = useState<'' | ActivityEntry['category']>('');
  const [problems, setProblems] = useState(false);
  const filter: ActivityQuery = { mountId: mountId || undefined, userId: userId || undefined, category: category || undefined, problems };
  const list = useInfiniteQuery({
    queryKey: ['activity', filter],
    queryFn: ({ pageParam }) => api.activity({ ...filter, before: pageParam, limit: 100 }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]!.id : undefined),
  });
  const entries = list.data?.pages.flat() ?? [];
  const select = 'h-8 rounded-md border border-line bg-bg px-2 text-sm';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {!fixedMountId && (
          <select className={select} aria-label={t('Quelle')} value={mountId} onChange={(e) => setMountId(e.target.value)}>
            <option value="">{t('Alle Quellen')}</option>
            {mounts.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        {isAdmin && !fixedUserId && (
          <select className={select} aria-label={t('Person')} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('Alle Personen')}</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} (@{u.username})
              </option>
            ))}
          </select>
        )}
        <select className={select} aria-label={t('Kategorie')} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
          <option value="">{t('Alle Arten')}</option>
          {(Object.keys(CATEGORY) as ActivityEntry['category'][])
            .filter((c) => isAdmin || c !== 'audit')
            .map((c) => (
              <option key={c} value={c}>
                {CATEGORY[c]}
              </option>
            ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} /> {t('Nur Warnungen und Fehler')}
        </label>
      </div>
      <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-lg border border-line" aria-label={t('Protokoll')}>
        {list.isPending && (
          <li className="p-3">
            <Spinner />
          </li>
        )}
        {list.data && entries.length === 0 && <li className="p-3 text-sm text-fg-muted">{t('Keine Einträge.')}</li>}
        {entries.map((e) => (
          <li key={e.id} className="flex gap-2 px-3 py-1.5 text-sm">
            {e.level === 'error' ? (
              <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            ) : e.level === 'warn' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-faint" />
            )}
            <div className="min-w-0 flex-1">
              <div className={cx('break-words', e.level === 'error' && 'text-danger')}>{e.message}</div>
              <div className="text-xs text-fg-faint">
                {when(e.at)} · {CATEGORY[e.category]}
                {e.mountName && !fixedMountId ? ` · ${e.mountName}` : ''}
                {e.actor ? ` · ${e.actor}` : ''}
              </div>
              {e.detail && Object.keys(e.detail).length > 0 && (
                <details className="text-xs text-fg-muted">
                  <summary className="cursor-pointer select-none text-fg-faint">{t('Details')}</summary>
                  <pre className="whitespace-pre-wrap break-words">{JSON.stringify(e.detail, null, 2)}</pre>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <Button size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {list.isFetchingNextPage && <Spinner className="h-3.5 w-3.5" />} {t('Ältere laden')}
        </Button>
      )}
    </div>
  );
}

export function ActivityDialog({ mountId, onClose, isAdmin }: { mountId: string; onClose: () => void; isAdmin: boolean }) {
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const name = mounts.data?.find((m) => m.id === mountId)?.name ?? '';
  return (
    <Modal help="daten-protokoll-und-sicherungen" open wide onOpenChange={(o) => !o && onClose()} title={name ? t('Verlauf: {name}', { name }) : t('Verlauf')}>
      <ActivityList fixedMountId={mountId} isAdmin={isAdmin} />
    </Modal>
  );
}

/** Settings → Werkzeuge → Protokoll: the log and its retention (admin) – the same deletion rules as „Aufräumen“. */
export function LogSettings() {
  return (
    <div className="space-y-5 text-sm">
      <p className="text-fg-muted">
        {t(
          'Was Kaveyl Wiki getan hat: Synchronisierungen, Konflikte, Link-Reparaturen, Fehler, Anmeldungen und Änderungen an Quellen. Inhaltliche Änderungen stehen in der Git-Historie (Versionen). Passwörter, Tokens und Notizinhalte werden nie protokolliert.',
        )}
      </p>
      <ActivityList isAdmin />
      <section className="space-y-2" aria-label={t('Aufbewahrung')}>
        <h3 className="font-medium">{t('Aufbewahrung')}</h3>
        <RuleRow rule="logInfoDays" label={t('Normale Einträge aufbewahren')} />
        <RuleRow rule="logProblemDays" label={t('Warnungen und Fehler aufbewahren')} />
        <RuleRow rule="logAuditDays" label={t('Sicherheitseinträge aufbewahren')} hint={t('Anmeldungen, Rechte, Löschungen – für Nachweise eher lang.')} />
        <p className="text-xs text-fg-faint">{t('Ältere Einträge werden jede Nacht um 3 Uhr gelöscht. Alle Löschregeln: Werkzeuge → Aufräumen.')}</p>
      </section>
    </div>
  );
}

/** Settings → Backup → Datenbank: nightly database backups (what the database holds: in the help). */
export function BackupSettings() {
  const qc = useQueryClient();
  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const backupNow = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['backups'], await api.backupNow());
      await qc.invalidateQueries({ queryKey: ['activity'] });
      // Show the new file.
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };
  const list = backups.data ?? [];
  const total = list.reduce((n, b) => n + b.size, 0);
  const groups = KINDS.map(([kind, label]) => ({ kind, label, items: list.filter((b) => b.kind === kind) })).filter((g) => g.items.length);
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Jede Nacht um 3 Uhr eine tägliche Sicherung der Kaveyl-Wiki-Datenbank, sonntags zusätzlich eine wöchentliche. Ablage: {pfad} – derselbe Datenträger, ersetzt kein externes Backup; {key} daneben mitsichern.',
          ),
          { pfad: <code>/config/backups</code>, key: <code>secret.key</code> },
        )}
      </p>
      <div className="space-y-2 rounded-lg border border-line p-3">
        <RuleRow rule="backupDaily" label={t('Tägliche Sicherungen behalten')} />
        <RuleRow rule="backupWeekly" label={t('Wöchentliche Sicherungen behalten')} />
        <RuleRow
          rule="backupManualDays"
          label={t('Andere Sicherungen aufbewahren')}
          hint={t('Von Hand abgelegte .db-Dateien (z. B. vor einem Update).')}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void backupNow()}>
          {busy && <Spinner className="h-3.5 w-3.5" />} {t('Jetzt sichern')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openHelp('was-steht-in-der-datenbank')} title={t('Hilfe: was die Datenbank enthält und was nicht (F1)')}>
          <CircleHelp className="h-3.5 w-3.5" /> {t('Was steht in der Datenbank?')}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-fg-muted">{t('Noch keine Sicherung.')}</p>
      ) : (
        <section className="rounded-lg border border-line" aria-label={t('Vorhandene Backups')}>
          <button
            type="button"
            aria-expanded={open}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover"
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
            <span className="font-medium">{t('Vorhandene Backups')}</span>
            <span className="text-xs text-fg-faint">
              {tn(list.length, '{n} Datei', '{n} Dateien')} · {fmtBytes(total)} ·{' '}
              {groups.map((g) => `${g.items.length} ${g.label.toLowerCase()}`).join(', ')}
            </span>
          </button>
          {open && (
            <ul className="divide-y divide-line border-t border-line" aria-label={t('Backups')}>
              {groups.map((g) => (
                <li key={g.kind}>
                  <div className="bg-muted/50 px-3 py-1 text-xs font-medium text-fg-muted">
                    {g.label} ({g.items.length})
                  </div>
                  <ul className="divide-y divide-line">
                    {[...g.items]
                      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
                      .map((b) => (
                        <li key={b.name} className="flex justify-between gap-2 px-3 py-1.5">
                          <span className="truncate">{b.name}</span>
                          <span className="shrink-0 text-xs text-fg-faint">
                            {when(b.createdAt)} · {fmtBytes(b.size)}
                          </span>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

const KINDS: [BackupFile['kind'], string][] = [
  ['daily', t('Täglich')],
  ['weekly', t('Wöchentlich')],
  ['manual', t('Von Hand')],
];

/** What one person did (admins, Settings → Benutzer & Rechte → Benutzer): log entries and their commits. */
/** Opened from Settings → Benutzer & Rechte → Benutzer, on top of the settings: "Zurück" returns there. */
export function UserActivityDialog({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  return (
    <Modal help="daten-protokoll-und-sicherungen" open wide onOpenChange={(o) => !o && onClose()} title={t('Protokoll: {name}', { name })} onBack={onClose}>
      <ActivityList fixedUserId={userId} isAdmin />
    </Modal>
  );
}
