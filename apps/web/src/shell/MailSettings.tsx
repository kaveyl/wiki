// Settings → Benachrichtigungen → E-Mail (admins): SMTP for „Passwort vergessen“, invitations and notices (AD-030, AD-035).
// The password/SMTP key is write-only: the server only says whether one is stored.
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Send } from 'lucide-react';
import { api, errorText, type MailSettings, type SmtpSecurity } from '../api';
import { Button, Field, Input, Spinner, useModalDirty } from '../ui';
import { t } from '../i18n';


const SECURITY: [SmtpSecurity, string][] = [
  ['starttls', t('STARTTLS (meist Port 587)')],
  ['tls', t('TLS von Anfang an (meist Port 465)')],
  ['none', t('keine (nur im eigenen Netz)')],
];

type Form = Omit<MailSettings, 'passwordSet' | 'configured'> & { password: string };

export function MailPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mail-settings'], queryFn: api.mailSettings });
  const [f, setF] = useState<Form | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [testTo, setTestTo] = useState('');
  useEffect(() => {
    if (q.data && !f) setF({ ...q.data, password: '' });
  }, [q.data, f]);
  const dirty = !!f && !!q.data && (f.password !== '' || (['host', 'port', 'security', 'user', 'fromAddress', 'fromName', 'publicUrl'] as const).some((k) => String(f[k]) !== String(q.data[k])));
  useModalDirty(dirty);
  if (!f || !q.data) return <Spinner />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy('save');
    setStatus(null);
    try {
      const { password, ...rest } = f;
      const saved = await api.saveMailSettings({ ...rest, ...(password ? { password } : {}) });
      setF({ ...saved, password: '' });
      qc.setQueryData(['mail-settings'], saved);
      await qc.invalidateQueries({ queryKey: ['session'] });
      setStatus({
        ok: true,
        text: saved.configured
          ? t('Gespeichert. Jetzt am besten eine Testmail schicken.')
          : t('Gespeichert – für den Versand fehlen noch Server, Absender oder öffentliche Adresse.'),
      });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    if (dirty) await save();
    setBusy('test');
    setStatus(null);
    try {
      const r = await api.testMail(testTo.trim() || undefined);
      setStatus({ ok: true, text: t('Testmail an {to} verschickt – bitte Postfach (und Spam-Ordner) prüfen.', { to: r.to }) });
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="max-w-xl space-y-4 text-sm" onSubmit={save}>
      <p className="text-fg-muted">
        {t(
          'Für „Passwort vergessen?“, Einladungen neuer Benutzer, das Teilen von Notizen per E-Mail und den Hinweis nach einer Passwortänderung – und für Benachrichtigungen an die Admins, wenn unter „Ereignisse“ eingeschaltet. Ohne Einrichtung funktioniert Kaveyl Wiki normal; diese Funktionen sind dann aus.',
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className={q.data.configured ? 'text-ok' : 'text-fg-muted'}>
          <Mail className="mr-1 inline h-4 w-4" />
          {q.data.configured ? t('E-Mail-Versand ist eingerichtet') : t('E-Mail-Versand ist nicht eingerichtet')}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
        <Field label={t('SMTP-Server')}>
          <Input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.org" autoComplete="off" />
        </Field>
        <Field label={t('Port')}>
          <Input type="number" min={1} max={65535} value={f.port} onChange={(e) => set('port', Number(e.target.value))} />
        </Field>
      </div>
      <Field label={t('Verschlüsselung')}>
        <select className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm" value={f.security} onChange={(e) => set('security', e.target.value as SmtpSecurity)}>
          {SECURITY.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Benutzer (SMTP-Login)')}>
          <Input value={f.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label={t('Passwort / SMTP-Schlüssel')}
          hint={q.data.passwordSet ? t('Gespeichert – leer lassen, um ihn zu behalten.') : t('Wird verschlüsselt gespeichert und nie wieder angezeigt.')}
        >
          <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={q.data.passwordSet ? '••••••••' : ''} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Absender-Adresse')} hint={t('Muss beim Mail-Anbieter als Absender erlaubt sein.')}>
          <Input type="email" value={f.fromAddress} onChange={(e) => set('fromAddress', e.target.value)} placeholder="wiki@example.org" />
        </Field>
        <Field label={t('Absender-Name')}>
          <Input value={f.fromName} onChange={(e) => set('fromName', e.target.value)} placeholder="Kaveyl Wiki" />
        </Field>
      </div>
      <Field
        label={t('Öffentliche Adresse von Kaveyl Wiki')}
        hint={
          <>
            {t('Alle Links in Mails zeigen hierhin – so, wie Empfänger Kaveyl Wiki erreichen.')}{' '}
            {f.publicUrl !== location.origin && (
              <button type="button" className="text-accent hover:underline" onClick={() => set('publicUrl', location.origin)}>
                {t('Diese Adresse übernehmen ({origin})', { origin: location.origin })}
              </button>
            )}
          </>
        }
      >
        <Input value={f.publicUrl} onChange={(e) => set('publicUrl', e.target.value)} placeholder="https://wiki.example.org" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={!!busy || !dirty}>
          {busy === 'save' && <Spinner />} {t('Speichern')}
        </Button>
        <span className="ml-auto text-xs text-fg-muted">{t('Testmail an')}</span>
        <div className="w-52">
          <Input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={t('leer = an dich selbst')}
            aria-label={t('Empfänger der Testmail')}
          />
        </div>
        <Button type="button" size="sm" disabled={!!busy || !f.host || !f.fromAddress} onClick={() => void test()}>
          {busy === 'test' ? <Spinner /> : <Send className="h-3.5 w-3.5" />} {t('Testmail senden')}
        </Button>
      </div>
      {status && (
        <p className={status.ok ? 'text-ok' : 'text-danger'} role="status">
          {status.text}
        </p>
      )}
    </form>
  );
}
