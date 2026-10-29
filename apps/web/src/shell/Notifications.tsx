// Settings → Benachrichtigungen (admins, AD-035): which events reach the admins, by e-mail and/or
// Pushover. Account mails (password reset, invitations) are not part of this choice. The Pushover
// keys are write-only: the server only says whether they are stored.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Send } from 'lucide-react';
import { api, errorText, type NotifyChannel, type NotifyEvent, type NotifyOverview } from '../api';
import { Button, Field, Input, Spinner, cx, useModalDirty, fillNodes, FormError } from '../ui';
import { t } from '../i18n';


const EVENTS: [NotifyEvent, string, string][] = [
  ['sync', t('Sync-Probleme'), t('Eine Quelle kann nicht synchronisieren, ein Konflikt wartet auf Auflösung – und die Entwarnung, sobald es wieder geht.')],
  [
    'nightly',
    t('Nachtlauf'),
    t(
      'Prüfung, Aufräumen oder Sicherung um 3 Uhr ist fehlgeschlagen, die Prüfung hat etwas gefunden oder der Speicherplatz wird knapp. Eine Nachricht pro Nacht, nur wenn etwas ist.',
    ),
  ],
  ['backup', t('Backup'), t('Eine geplante oder von Hand gestartete Sicherung (Einstellungen → Backup) ist ganz oder teilweise fehlgeschlagen – mit Quelle und Grund.')],
  ['security', t('Sicherheit'), t('Viele fehlgeschlagene Anmeldungen (10 in 15 Minuten), ein neuer Administrator, ein neuer API-Token.')],
];

const CHANNELS: [NotifyChannel, string][] = [
  ['mail', t('E-Mail')],
  ['pushover', t('Pushover')],
];

export function useNotify() {
  return useQuery({ queryKey: ['notify'], queryFn: api.notify });
}

/** Settings → Benachrichtigungen → Ereignisse. */
export function NotifyEventsPanel({ onOpenTab }: { onOpenTab: (page: 'mail' | 'pushover') => void }) {
  const qc = useQueryClient();
  const q = useNotify();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return q.isError ? <FormError>{errorText(q.error)}</FormError> : <Spinner />;
  const d = q.data;
  const toggle = async (e: NotifyEvent, c: NotifyChannel, on: boolean) => {
    setBusy(`${e}:${c}`);
    setError(null);
    try {
      qc.setQueryData(['notify'], await api.saveNotify({ rules: { [e]: { [c]: on } } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {t(
          'Worüber Kaveyl Wiki die Admins von sich aus informiert – je Ereignis per E-Mail, Pushover oder beidem. Mails zum Konto (Passwort vergessen, Einladungen, Hinweis nach einer Passwortänderung) gehen davon unabhängig immer an die betroffene Person.',
        )}
      </p>
      <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-line" aria-label={t('Ereignisse')}>
        <thead>
          <tr className="bg-muted text-left text-xs text-fg-muted">
            <th className="px-3 py-2 font-medium">{t('Ereignis')}</th>
            {CHANNELS.map(([c, label]) => (
              <th key={c} className="w-24 px-3 py-2 text-center font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {EVENTS.map(([e, label, text]) => (
            <tr key={e} className="align-top">
              <td className="border-t border-line px-3 py-2">
                <div className="font-medium">{label}</div>
                <div className="text-xs text-fg-muted">{text}</div>
              </td>
              {CHANNELS.map(([c, cl]) => (
                <td key={c} className="border-t border-line px-3 py-2 text-center">
                  {busy === `${e}:${c}` ? (
                    <Spinner className="mx-auto h-4 w-4" />
                  ) : (
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      aria-label={t('{event} per {channel}', { event: label, channel: cl })}
                      checked={d.rules[e][c]}
                      disabled={busy !== null}
                      onChange={(ev) => void toggle(e, c, ev.target.checked)}
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      <ul className="space-y-1 text-xs text-fg-muted">
        <li>
          <b className="text-fg">{t('E-Mail:')}</b>{' '}
          {d.channels.mail ? (
            t('geht an alle Admins mit E-Mail-Adresse ({list}).', { list: d.recipients.join(', ') })
          ) : (
            <span className={cx(Object.values(d.rules).some((r) => r.mail) && 'text-warn')}>
              {fillNodes(
                d.recipients.length
                  ? t('noch nicht bereit – {link}.')
                  : t('noch nicht bereit – {link} (und bei einem Admin eine echte E-Mail-Adresse eintragen).'),
                {
                  link: (
                    <button className="text-accent hover:underline" onClick={() => onOpenTab('mail')}>
                      {t('E-Mail-Versand einrichten')}
                    </button>
                  ),
                },
              )}
            </span>
          )}
        </li>
        <li>
          <b className="text-fg">{t('Pushover:')}</b>{' '}
          {d.channels.pushover ? (
            d.pushover.device ? (
              t('an das eingetragene Pushover-Konto (Gerät: {device}).', { device: d.pushover.device })
            ) : (
              t('an das eingetragene Pushover-Konto.')
            )
          ) : (
            <span className={cx(Object.values(d.rules).some((r) => r.pushover) && 'text-warn')}>
              {fillNodes(t('noch nicht bereit – {link}.'), {
                link: (
                  <button className="text-accent hover:underline" onClick={() => onOpenTab('pushover')}>
                    {t('Pushover einrichten')}
                  </button>
                ),
              })}
            </span>
          )}
        </li>
        <li>{t('Gleiche Meldungen kommen nicht im Minutentakt: ein Sync-Fehler je Quelle höchstens alle 6 Stunden, ein fehlschlagender Zeitplan höchstens einmal am Tag, Anmelde-Warnungen höchstens stündlich – und insgesamt höchstens 10 Benachrichtigungen je Stunde. Ab Werk an: Nachtlauf, Backup, Sicherheit.')}</li>
        <li>{t('Klappt die Zustellung nicht, steht das unter Werkzeuge → Protokoll (Warnungen).')}</li>
      </ul>
      <FollowLimit perDay={d.followPerDay} />
    </div>
  );
}

/** Beobachten (AD-068): at most this many messages per person and day – protects the mail account; nothing is lost. */
function FollowLimit({ perDay }: { perDay: number }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(perDay));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      qc.setQueryData(['notify'], await api.saveNotify({ followPerDay: Number(value) }));
      void qc.invalidateQueries({ queryKey: ['watches'] });
      setStatus({ ok: true, text: t('Gespeichert.') });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-y-2 border-t border-line pt-4" onSubmit={save}>
      <h3 className="font-semibold">{t('Beobachten')}</h3>
      <p className="text-fg-muted">
        {t('Wer etwas beobachtet, wählt selbst, wie oft Nachrichten kommen (Einstellungen → Konto → Beobachten). Hier legst du fest, wie viele es pro Person und Tag höchstens sein dürfen – das schützt dein Mail-Konto, Gratis-Tarife erlauben oft nur einige hundert Mails am Tag. Was darüber hinaus kommt, geht nicht verloren: Es steht in der nächsten Nachricht.')}
      </p>
      <Field label={t('Höchstens Nachrichten je Person und Tag')} hint={t('1 bis 1000, ab Werk 100.')}>
        <Input type="number" min={1} max={1000} className="w-28" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={busy || value === String(perDay)}>
          {busy && <Spinner />} {t('Speichern')}
        </Button>
        {status && (
          <span className={status.ok ? 'text-ok' : 'text-danger'} role="status">
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}

/** Settings → Benachrichtigungen → Pushover. */
export function PushoverPanel() {
  const qc = useQueryClient();
  const q = useNotify();
  const [token, setToken] = useState('');
  const [userKey, setUserKey] = useState('');
  const [device, setDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const d: NotifyOverview | undefined = q.data;
  const dirty = !!token || !!userKey || (device !== null && device !== d?.pushover.device);
  useModalDirty(dirty);
  if (!d) return q.isError ? <FormError>{errorText(q.error)}</FormError> : <Spinner />;
  const p = d.pushover;

  const run = async (kind: 'save' | 'test' | 'remove', fn: () => Promise<string>) => {
    setBusy(kind);
    setStatus(null);
    try {
      setStatus({ ok: true, text: await fn() });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    void run('save', async () => {
      const next = await api.saveNotify({ pushover: { ...(token ? { token } : {}), ...(userKey ? { userKey } : {}), ...(device !== null ? { device } : {}) } });
      qc.setQueryData(['notify'], next);
      setToken('');
      setUserKey('');
      setDevice(null);
      return next.channels.pushover ? t('Gespeichert. Jetzt am besten eine Testnachricht senden.') : t('Gespeichert – es fehlt noch API-Token oder User-Key.');
    });
  };
  const test = () =>
    void run('test', async () => {
      await api.testNotify('pushover');
      return t('Testnachricht verschickt – sie sollte in ein paar Sekunden auf dem Handy sein.');
    });
  const remove = () =>
    void run('remove', async () => {
      qc.setQueryData(['notify'], await api.saveNotify({ pushover: { token: '', userKey: '', device: '' } }));
      return t('Pushover-Zugang entfernt.');
    });

  return (
    <form className="max-w-xl space-y-4 text-sm" onSubmit={save}>
      <p className="text-fg-muted">
        {fillNodes(t('{pushover} bringt Nachrichten als Push aufs Handy, Tablet oder in den Browser. Welche Ereignisse kommen, steht unter „Ereignisse“.'), {
          pushover: (
            <a className="text-accent hover:underline" href="https://pushover.net" target="_blank" rel="noreferrer">
              Pushover
            </a>
          ),
        })}
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-fg-muted">
        <li>{t('Bei pushover.net ein Konto anlegen und die Pushover-App auf dem Handy installieren und anmelden.')}</li>
        <li>
          {fillNodes(t('Den {key} zeigt pushover.net nach der Anmeldung oben rechts („Your User Key“).'), { key: <b className="text-fg">{t('User-Key')}</b> })}
        </li>
        <li>
          {fillNodes(t('Unter „Your Applications“ → „Create an Application/API Token“ eine Anwendung „Kaveyl Wiki“ anlegen – sie liefert den {token}.'), {
            token: <b className="text-fg">{t('API-Token')}</b>,
          })}
        </li>
      </ol>
      <div className="flex items-center gap-2">
        <span className={d.channels.pushover ? 'text-ok' : 'text-fg-muted'}>
          <BellRing className="mr-1 inline h-4 w-4" />
          {d.channels.pushover ? t('Pushover ist eingerichtet') : t('Pushover ist nicht eingerichtet')}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('API-Token der Anwendung')}
          hint={p.tokenSet ? t('Gespeichert – leer lassen, um ihn zu behalten.') : t('Wird verschlüsselt gespeichert und nie wieder angezeigt.')}
        >
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder={p.tokenSet ? '••••••••' : t('30 Zeichen')} />
        </Field>
        <Field
          label={t('User-Key (oder Gruppen-Key)')}
          hint={p.userKeySet ? t('Gespeichert – leer lassen, um ihn zu behalten.') : t('Ein Gruppen-Key erreicht mehrere Personen.')}
        >
          <Input type="password" value={userKey} onChange={(e) => setUserKey(e.target.value)} autoComplete="off" placeholder={p.userKeySet ? '••••••••' : t('30 Zeichen')} />
        </Field>
      </div>
      <Field label={t('Gerät (optional)')} hint={t('Leer = alle Geräte des Kontos. Mehrere Namen mit Komma trennen.')}>
        <Input value={device ?? p.device} onChange={(e) => setDevice(e.target.value)} placeholder={t('z. B. iphone')} autoComplete="off" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={!!busy || !dirty}>
          {busy === 'save' && <Spinner />} {t('Speichern')}
        </Button>
        <Button type="button" size="sm" disabled={!!busy || !d.channels.pushover || dirty} onClick={test}>
          {busy === 'test' ? <Spinner /> : <Send className="h-3.5 w-3.5" />} {t('Testnachricht senden')}
        </Button>
        {(p.tokenSet || p.userKeySet) && (
          <Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={!!busy} onClick={remove}>
            {busy === 'remove' && <Spinner />} {t('Zugang entfernen')}
          </Button>
        )}
      </div>
      {status && (
        <p className={status.ok ? 'text-ok' : 'text-danger'} role="status">
          {status.text}
        </p>
      )}
    </form>
  );
}
