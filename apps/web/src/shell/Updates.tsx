// Update hint (AD-062, owner 2026-10-22): admins learn about a new public release – at the top right (closable per
// release), in Einstellungen → Hilfe and under Benachrichtigungen → Updates, where it is switched on and off.
// The server asks GitHub once a day; the browser never does.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, ShieldAlert, X } from 'lucide-react';
import { api, errorText, type UpdateState } from '../api';
import { usePrefs } from '../prefs';
import { Button, FormError, Spinner, cx } from '../ui';
import { fmtDateTime, t } from '../i18n';

const HOUR_MS = 3_600_000;

/** The last result of the server's check; only admins ask. */
export function useUpdates(isAdmin: boolean) {
  return useQuery({ queryKey: ['updates'], queryFn: api.updates, enabled: isAdmin, staleTime: HOUR_MS, refetchInterval: 6 * HOUR_MS });
}

/** The newer release worth a hint, if any (switched on, newer than this installation). */
export function newRelease(d: UpdateState | undefined) {
  return d?.enabled && d.newer && d.latest ? d.latest : null;
}

const label = (r: { version: string; security: boolean }) =>
  r.security ? t('Sicherheitsupdate {version}', { version: r.version }) : t('Neue Version {version}', { version: r.version });

/** Top right next to help and settings: the new release (opens its page on GitHub) and × to close it for this release. */
export function UpdateBadge({ isAdmin }: { isAdmin: boolean }) {
  const r = newRelease(useUpdates(isAdmin).data);
  const dismissed = usePrefs((p) => p.dismissedUpdate);
  if (!r || dismissed === r.version) return null;
  return (
    <span
      className={cx(
        'mr-1 flex h-6 shrink-0 items-center rounded-full text-xs font-medium',
        r.security ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent',
      )}
    >
      <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 hover:underline" title={t('Release-Notizen auf GitHub')}>
        {r.security ? <ShieldAlert className="h-3.5 w-3.5" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
        {label(r)}
      </a>
      <button
        className="mr-0.5 rounded-full p-0.5 opacity-70 hover:bg-hover hover:opacity-100"
        aria-label={t('Hinweis auf Version {version} ausblenden', { version: r.version })}
        title={t('Ausblenden – bei der nächsten Version kommt der Hinweis wieder')}
        onClick={() => usePrefs.getState().set({ dismissedUpdate: r.version })}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

/** Phones: the same hint as an entry of the account menu (no room at the top right). */
export function useUpdateMenuEntry(isAdmin: boolean) {
  const r = newRelease(useUpdates(isAdmin).data);
  const dismissed = usePrefs((p) => p.dismissedUpdate);
  return r && dismissed !== r.version ? { ...r, label: label(r), dismiss: () => usePrefs.getState().set({ dismissedUpdate: r.version }) } : null;
}

/** Einstellungen → Hilfe, under the version: the new release with a link (stays when the hint at the top was closed). */
export function UpdateLine({ isAdmin }: { isAdmin: boolean }) {
  const r = newRelease(useUpdates(isAdmin).data);
  if (!r) return null;
  return (
    <p className={cx('flex items-center gap-1.5', r.security ? 'text-danger' : 'text-fg')}>
      {r.security ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <ArrowUpCircle className="h-4 w-4 shrink-0 text-accent" />}
      <span>
        {r.security ? t('Sicherheitsupdate {version} ist erschienen –', { version: r.version }) : t('Version {version} ist erschienen –', { version: r.version })}{' '}
        <a className="text-accent hover:underline" href={r.url} target="_blank" rel="noreferrer">
          {t('Release-Notizen auf GitHub')}
        </a>
      </span>
    </p>
  );
}

const PROBLEM: Record<string, string> = {
  unreachable: t('GitHub war nicht erreichbar (kein Internet?).'),
  timeout: t('GitHub hat nicht rechtzeitig geantwortet.'),
  invalid: t('GitHub hat eine unerwartete Antwort geschickt.'),
};

/** Settings → Benachrichtigungen → Updates. */
export function UpdatesPanel() {
  const qc = useQueryClient();
  const q = useUpdates(true);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return q.isError ? <FormError>{errorText(q.error)}</FormError> : <Spinner />;
  const d = q.data;
  const run = async (kind: 'save' | 'check', fn: () => Promise<UpdateState>) => {
    setBusy(kind);
    setError(null);
    try {
      qc.setQueryData(['updates'], await fn());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const problem = d.problem && (d.problem.startsWith('status:') ? t('GitHub hat mit Fehler {status} geantwortet.', { status: d.problem.slice(7) }) : PROBLEM[d.problem]);
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {t(
          'Kaveyl Wiki kann dir als Admin zeigen, wenn eine neue Version erschienen ist: oben rechts neben Hilfe und Einstellungen und unter Einstellungen → Hilfe. Ein Klick führt zu den Release-Notizen auf GitHub. Sicherheitsupdates sind rot.',
        )}
      </p>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={d.enabled} disabled={busy !== null} onChange={(e) => void run('save', () => api.saveUpdates(e.target.checked))} />
        <span>
          {t('Bei Updates benachrichtigen')}
          <span className="block text-xs text-fg-muted">
            {t(
              'Dafür fragt der Server von Kaveyl Wiki einmal am Tag die öffentliche Release-Liste auf GitHub ab. Übertragen wird nichts außer dieser Anfrage; die Browser deiner Benutzer haben damit nichts zu tun. Ausgeschaltet fragt Kaveyl Wiki gar nicht mehr nach.',
            )}
          </span>
        </span>
      </label>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-fg-muted">{t('Diese Installation')}</dt>
        <dd className="font-mono">{d.current}</dd>
        {d.enabled && (
          <>
            <dt className="text-fg-muted">{t('Neueste Version')}</dt>
            <dd>
              {d.latest ? (
                <>
                  <a className="text-accent hover:underline" href={d.latest.url} target="_blank" rel="noreferrer">
                    {d.latest.version}
                  </a>
                  {/* a badge, not a message */ d.latest.security && <span className="text-danger"> – {t('Sicherheitsupdate')}</span>}
                  {!d.newer && <span className="text-fg-muted"> – {t('du bist auf dem neuesten Stand')}</span>}
                </>
              ) : (
                <span className="text-fg-muted">{d.checkedAt ? t('noch keine veröffentlicht') : t('noch nicht geprüft')}</span>
              )}
            </dd>
            <dt className="text-fg-muted">{t('Zuletzt geprüft')}</dt>
            <dd>{d.checkedAt ? fmtDateTime(d.checkedAt) : '–'}</dd>
          </>
        )}
      </dl>
      {d.enabled && problem && <p className="text-warn">{problem}</p>}
      {d.enabled && (
        <Button size="sm" disabled={busy !== null} onClick={() => void run('check', api.checkUpdates)}>
          {busy === 'check' ? <Spinner className="h-4 w-4" /> : null}
          {t('Jetzt prüfen')}
        </Button>
      )}
      <FormError>{error}</FormError>
    </div>
  );
}
