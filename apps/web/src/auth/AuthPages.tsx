// Sign-in pages in the brand design (PLAN §3e, AD-030): login with „Angemeldet bleiben“ and
// „Passwort vergessen?“, first-run setup, links from mails (#reset=…, #invite=…) and the forced
// password change. Light/dark follows the app theme (system by default).
import { cloneElement, useEffect, useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, EyeOff, X } from 'lucide-react';
import { PASSWORD_RULES, passwordProblems, type PasswordContext } from '@kaveyl-wiki/core';
import { api, errorText, type MailTokenInfo, type SetupRestoreResult, type User } from '../api';
import { useDark, useTheme } from '../theme';
import lightUrl from './brand/login-light.webp';
import light860Url from './brand/login-light-860.webp';
import darkUrl from './brand/login-dark.webp';
import dark860Url from './brand/login-dark-860.webp';
import { Button, Spinner, Rich, useRepeatCheck } from '../ui';
import { LanguageSwitch, ThemeToggle } from '../Toggles';
import { t, tn } from '../i18n';
import { LOGO_ARMS, LOGO_DETAIL, LOGO_FRAME, LOGO_STEM, LOGO_TRANSFORM, PRODUCT_NAME } from '../logo';

const REMEMBER_KEY = 'kaveyl-wiki.remember';


/** The Kaveyl mark (logo.ts). `detail` = the full drawing for about 40 px and up; smaller sizes get the simpler one. */
export function Logo({ className = 'h-6 w-6', detail = false }: { className?: string; detail?: boolean }) {
  const d = detail ? LOGO_DETAIL.full : LOGO_DETAIL.small;
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-accent" />
      <g transform={LOGO_TRANSFORM} className="stroke-accent-fg" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={LOGO_FRAME} strokeWidth="1.4" />
        <path d={LOGO_STEM} strokeWidth={d.kw} strokeLinecap="butt" />
        <path d={LOGO_ARMS} strokeWidth={d.kw} />
        <path d={d.lines} strokeWidth={d.lw} />
      </g>
    </svg>
  );
}

/**
 * A card in the middle of the page — picture | form side by side on wide screens — on the grey of
 * the sidebar (almost black in dark mode). Phones: no card, a picture strip above the form.
 */
export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  useTheme(); // follows system changes live, like the app
  return (
    <div className="flex min-h-full flex-col bg-subtle text-fg sm:items-center sm:justify-center sm:p-6">
      <div
        data-testid="auth-card"
        className="auth relative flex w-full flex-1 flex-col overflow-hidden bg-[var(--auth-card)] sm:max-w-[420px] sm:flex-none sm:rounded-2xl sm:border sm:border-line sm:shadow-[var(--auth-shadow)] md:min-h-[440px] md:max-w-[680px] md:flex-row"
      >
        {/* Language and colour scheme before signing in – the whole setup can run in another language.
            Over the picture on phones; on wide screens md:pt-14 on <main> keeps the logo row below it (design-012). */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-lg bg-[var(--auth-card)] p-1 shadow-sm">
          <LanguageSwitch />
          <ThemeToggle className="h-6 w-6" />
        </div>
        <div className="relative h-36 shrink-0 overflow-hidden sm:h-40 md:h-auto md:w-[45%]" aria-hidden>
          <Picture className="absolute inset-0 h-full w-full object-cover object-[30%_50%] md:object-[62%_50%]" />
          {/* Soft edge into the form side (below on phones, to the right on wide screens). */}
          <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-[var(--auth-card)] md:inset-x-auto md:inset-y-0 md:right-0 md:h-auto md:w-14 md:bg-gradient-to-r" />
        </div>
        <main className="flex flex-1 flex-col items-center justify-start px-6 pt-6 pb-10 sm:px-8 sm:pt-6 sm:pb-8 md:justify-center md:pb-8 md:pt-14">
          <div className="w-full max-w-[320px]">
            <div className="mb-6 flex items-center justify-center gap-2.5">
              <Logo className="h-10 w-10 md:h-9 md:w-9" detail />
              <span className="text-[2rem] font-bold leading-none tracking-tight md:text-[1.75rem]">{PRODUCT_NAME}</span>
            </div>
            {children}
            {footer && <div className="mt-5 text-center text-sm">{footer}</div>}
          </div>
        </main>
      </div>
    </div>
  );
}

// Bundled (hashed name under /assets/ → long-term cache), not from public/ (seo-002).
const PICTURE = {
  light: { src: lightUrl, srcSet: `${light860Url} 860w, ${lightUrl} 1720w` },
  dark: { src: darkUrl, srcSet: `${dark860Url} 860w, ${darkUrl} 1720w` },
};

/** The page's largest element (LCP): only the variant of the scheme in effect is loaded, size known up front. */
function Picture({ className }: { className: string }) {
  const { src, srcSet } = PICTURE[useDark() ? 'dark' : 'light'];
  return (
    <img
      src={src}
      srcSet={srcSet}
      sizes="(min-width: 768px) 310px, 100vw"
      width={1720}
      height={1536}
      fetchPriority="high"
      alt=""
      className={className}
    />
  );
}

/** Label above the control, linked by id — the eye button and the checklist stay out of the field's name. */
/** Like `Field` in the larger auth layout: `error` marks the field invalid, describes it and is announced. */
function AuthField({ label, children, hint, error }: { label: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>; hint?: ReactNode; error?: ReactNode }) {
  const id = useId();
  const describedBy = [error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && (
        <span id={`${id}-error`} role="alert" className="block text-xs text-danger">
          {error}
        </span>
      )}
      {hint && <div id={`${id}-hint`}>{hint}</div>}
    </div>
  );
}

const inputCls =
  'h-11 w-full rounded-lg border border-line bg-bg px-3 text-[0.9375rem] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft';

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputCls} />;
}

/** Password field with the eye from the design (show/hide). */
function PasswordInput(props: Omit<React.ComponentProps<'input'>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={show ? 'text' : 'password'} className={`${inputCls} pr-11`} />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-fg-faint hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={show ? t('Eingabe verbergen') : t('Eingabe anzeigen')}
        title={show ? t('Passwort verbergen') : t('Passwort anzeigen')}
        aria-pressed={show}
      >
        {show ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
      </button>
    </div>
  );
}

/** Live checklist of the password policy (same rules as the server); `context` = own e-mail, name … */
export function PasswordRules({ value, context }: { value: string; context?: PasswordContext }) {
  return (
    <ul className="grid grid-cols-1 gap-x-3 gap-y-0.5 pt-1 text-xs sm:grid-cols-2" aria-label={t('Anforderungen an das Passwort')}>
      {PASSWORD_RULES.filter((r) => !r.onlyWhenMissed || !r.ok(value, context)).map((r) => {
        const ok = r.ok(value, context);
        return (
          <li key={r.id} className={`flex items-center gap-1.5 ${ok ? 'text-ok' : 'text-fg-muted'}`}>
            {ok ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <X className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />}
            <span>
              {t(r.label).replace(/ \((z\. B\.|e\.g\.).*\)$/, '')}
              <span className="sr-only">{ok ? ` – ${t('erfüllt')}` : ` – ${t('fehlt')}`}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** New password twice + checklist; valid only when the policy is met and both match. */
function NewPassword({ value, repeat, onValue, onRepeat, label = t('Neues Passwort'), context }: { value: string; repeat: string; onValue: (v: string) => void; onRepeat: (v: string) => void; label?: string; context?: PasswordContext }) {
  const check = useRepeatCheck(value, repeat);
  return (
    <>
      <AuthField label={label} hint={<PasswordRules value={value} context={context} />}>
        <PasswordInput autoComplete="new-password" value={value} onChange={(e) => onValue(e.target.value)} />
      </AuthField>
      <AuthField label={t('Passwort wiederholen')} error={check.error}>
        <PasswordInput autoComplete="new-password" value={repeat} onChange={(e) => onRepeat(e.target.value)} onBlur={check.onBlur} />
      </AuthField>
    </>
  );
}
/** What a new password still lacks, as items for `SubmitButton` (empty exactly when the password may be sent). */
const passwordMissing = (pw: string, repeat: string, label: string, context?: PasswordContext) => [
  !pw ? label : passwordProblems(pw, context).length > 0 && t('Anforderungen an das Passwort'),
  !!pw && repeat !== pw && t('Passwort wiederholen'),
];

function useSubmit<T>(fn: () => Promise<T>, done?: (r: T) => void | Promise<void>) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      await done?.(r);
      await qc.invalidateQueries({ queryKey: ['session'] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

function Heading({ title, text }: { title: string; text?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-lg font-semibold">{title}</h1>
      {text && <p className="mt-1 text-sm text-fg-muted">{text}</p>}
    </div>
  );
}

/**
 * Disabled while something is `missing` – and then says below what (never a silent grey button).
 * `error` (when given) shows in the same reserved line, in a live region that is always there (design-009).
 */
function SubmitButton({ busy, missing = [], error, children }: { busy: boolean; missing?: (string | false)[]; error?: string | null; children: ReactNode }) {
  const hintId = useId();
  const open = missing.filter((x): x is string => !!x);
  // The button is disabled while sending and drops the focus: after a failure it goes back into the form (first
  // field, content selected) – a form that knows better (login: the password) moves it on afterwards.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!error || (document.activeElement && document.activeElement !== document.body)) return;
    const field = ref.current?.closest('form')?.querySelector<HTMLInputElement>('input:not([type=checkbox]):not([type=hidden]):not(:disabled)');
    field?.focus();
    field?.select();
  }, [error]);
  return (
    <div ref={ref} className="space-y-1.5">
      <Button variant="primary" className="h-11 w-full rounded-lg text-[0.9375rem]" disabled={busy || open.length > 0} aria-describedby={open.length ? hintId : undefined}>
        {busy && <Spinner />} {children}
      </Button>
      {/* The line keeps its place when it empties (e.g. a password manager fills both fields) – the card must not jump. */}
      <div className="min-h-4 text-center text-xs">
        {error !== undefined && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <p id={hintId} className="text-fg-muted" aria-hidden={open.length ? undefined : true}>
          {open.length > 0 && t('Es fehlt noch: {list}', { list: open.join(', ') })}
        </p>
      </div>
    </div>
  );
}

const linkCls = 'font-medium text-[var(--auth-link)] hover:underline focus-visible:outline-2 focus-visible:outline-accent rounded';

// ── Login / Passwort vergessen ──────────────────────────────────────────────────────

export function LoginPage({ mail }: { mail: boolean }) {
  const [view, setView] = useState<'login' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  if (view === 'forgot') return <ForgotPage mail={mail} email={email} onEmail={setEmail} onBack={() => setView('login')} />;
  return <LoginForm email={email} onEmail={setEmail} onForgot={() => setView('forgot')} />;
}

function LoginForm({ email, onEmail, onForgot }: { email: string; onEmail: (v: string) => void; onForgot: () => void }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => {
    try {
      return localStorage.getItem(REMEMBER_KEY) === '1';
    } catch {
      return false;
    }
  });
  const { submit, error, busy } = useSubmit(() => {
    try {
      localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
    } catch {
      /* private mode */
    }
    return api.login(email, password, remember);
  });
  // The button is disabled while signing in and drops the focus: after a failure it goes to the password, selected.
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!error) return;
    passwordRef.current?.focus();
    passwordRef.current?.select();
  }, [error]);
  return (
    <AuthLayout
      footer={
        <button type="button" className={linkCls} onClick={onForgot}>
          {t('Passwort vergessen?')}
        </button>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        <h1 className="sr-only">{t('Anmelden bei Kaveyl Wiki')}</h1>
        <AuthField label={t('E-Mail')}>
          <TextInput type="email" autoFocus autoComplete="username" inputMode="email" placeholder={t('name@beispiel.de')} value={email} onChange={(e) => onEmail(e.target.value)} />
        </AuthField>
        <AuthField label={t('Passwort')}>
          <PasswordInput ref={passwordRef} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </AuthField>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 rounded" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t('Angemeldet bleiben')}
        </label>
        <SubmitButton busy={busy} error={error} missing={[!email.trim() && t('E-Mail'), !password && t('Passwort')]}>
          {t('Anmelden')}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

function ForgotPage({ mail, email, onEmail, onBack }: { mail: boolean; email: string; onEmail: (v: string) => void; onBack: () => void }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const back = (
    <button type="button" className={linkCls} onClick={onBack}>
      {t('Zurück zur Anmeldung')}
    </button>
  );
  if (!mail) {
    return (
      <AuthLayout footer={back}>
        <Heading
          title={t('Passwort vergessen?')}
          text={t('E-Mail-Versand ist in dieser Kaveyl-Wiki-Installation nicht eingerichtet. Bitte den Administrator, dein Passwort zurückzusetzen.')}
        />
      </AuthLayout>
    );
  }
  if (sent) {
    return (
      <AuthLayout footer={back}>
        <Heading
          title={t('Bitte Postfach prüfen')}
          text={
            <Rich
              text={t('Wenn es ein Konto mit {email} gibt, ist eine E-Mail mit einem Link unterwegs. Er gilt 30 Minuten und nur einmal. Nichts angekommen? Auch im Spam-Ordner nachsehen.')}
              parts={{ email: <strong className="text-fg">{email.trim()}</strong> }}
            />
          }
        />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout footer={back}>
      <Heading title={t('Passwort vergessen?')} text={t('Gib deine E-Mail-Adresse ein. Du bekommst einen Link, mit dem du ein neues Passwort festlegst.')} />
      <form className="space-y-4" onSubmit={submit}>
        <AuthField label={t('E-Mail')}>
          <TextInput type="email" autoFocus autoComplete="username" inputMode="email" value={email} onChange={(e) => onEmail(e.target.value)} />
        </AuthField>
        <SubmitButton busy={busy} error={error} missing={[!email.trim() && t('E-Mail')]}>
          {t('Link anfordern')}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

// ── Ersteinrichtung ─────────────────────────────────────────────────────────────────

/**
 * `needsCode`: a fresh instance asks for the one-time code from the container log (AD-043). Instead of a new
 * administrator, the database of a backup can come back (AD-075); `restoring`: it was taken, the server starts again.
 */
export function SetupPage({ needsCode = false, restoring = false }: { needsCode?: boolean; restoring?: boolean }) {
  const [view, setView] = useState<'new' | 'restore'>('new');
  const [code, setCode] = useState('');
  const [restored, setRestored] = useState<SetupRestoreResult | null>(null);
  if (restoring || restored) return <RestartWait result={restored ?? undefined} />;
  if (view === 'restore') return <RestoreForm needsCode={needsCode} code={code} onCode={setCode} onBack={() => setView('new')} onDone={setRestored} />;
  return <NewAdminForm needsCode={needsCode} code={code} onCode={setCode} onRestore={() => setView('restore')} />;
}

function SetupCodeField({ code, onCode, autoFocus }: { code: string; onCode: (v: string) => void; autoFocus?: boolean }) {
  return (
    <AuthField
      label={t('Einrichtungscode')}
      hint={<span className="text-xs text-fg-muted">{t('Steht im Log des Containers, z. B. mit „docker logs kaveyl-wiki“. Schützt davor, dass jemand anderes zuerst einrichtet.')}</span>}
    >
      <TextInput autoFocus={autoFocus} autoComplete="off" spellCheck={false} value={code} onChange={(e) => onCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" />
    </AuthField>
  );
}

/** A new server from the backups of the old one: the database backup (ZIP from the target, or kaveyl-wiki.db). */
function RestoreForm({
  needsCode,
  code,
  onCode,
  onBack,
  onDone,
}: {
  needsCode: boolean;
  code: string;
  onCode: (v: string) => void;
  onBack: () => void;
  onDone: (r: SetupRestoreResult) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(() => api.setupRestore(file!, needsCode ? code : undefined, password), onDone);
  return (
    <AuthLayout
      footer={
        <button type="button" className={linkCls} onClick={onBack}>
          {t('Doch ein neues Konto anlegen')}
        </button>
      }
    >
      <Heading
        title={t('Aus einer Sicherung wiederherstellen')}
        text={t(
          'Für einen neuen Server: Lade die Datenbank-Sicherung des alten hoch – die ZIP-Datei aus dem Ordner „kaveyl-wiki-datenbank“ auf dem Backup-Ziel oder eine kaveyl-wiki.db. Konten, Rechte, Quellen, Einstellungen und Backup-Ziele kommen zurück; danach startet Kaveyl Wiki neu und du meldest dich mit deinem bisherigen Konto an.',
        )}
      />
      <form className="space-y-4" onSubmit={submit}>
        {needsCode && <SetupCodeField code={code} onCode={onCode} autoFocus />}
        <AuthField label={t('Datenbank-Sicherung')}>
          <input type="file" accept=".zip,.db,application/zip" className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-bg file:px-3 file:py-1.5 file:text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </AuthField>
        <AuthField label={t('Backup-Passwort')} hint={<span className="text-xs text-fg-muted">{t('Nur wenn das Backup-Ziel verschlüsselt war. Dann kommt auch der Schlüssel der gespeicherten Zugangsdaten mit.')}</span>}>
          <PasswordInput autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </AuthField>
        <SubmitButton busy={busy} error={error} missing={[needsCode && !code.trim() && t('Einrichtungscode'), !file && t('Datenbank-Sicherung')]}>
          {t('Datenbank zurückspielen')}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

/** After the database was taken: wait until the server answers again, then on to the sign-in. */
function RestartWait({ result }: { result?: SetupRestoreResult }) {
  const qc = useQueryClient();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 90_000) setSlow(true);
      void api
        .session()
        .then((s) => (s.setupRequired ? undefined : qc.invalidateQueries({ queryKey: ['session'] })))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [qc]);
  return (
    <AuthLayout>
      <Heading
        title={t('Datenbank wird übernommen')}
        text={
          result
            ? `${tn(result.users, 'Die Sicherung ist geprüft: {n} Konto, Datenbank v{v}.', 'Die Sicherung ist geprüft: {n} Konten, Datenbank v{v}.', { v: String(result.version) })} ${result.key ? t('Der Schlüssel für die gespeicherten Zugangsdaten kommt mit.') : t('Ohne Backup-Passwort fehlt der Schlüssel: Zugangsdaten (Verbindungen, Mail, KI, SMB-Passwörter) trägst du danach neu ein.')}`
            : undefined
        }
      />
      <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
        <Spinner className="h-4 w-4" /> {t('Kaveyl Wiki startet neu – gleich geht es mit der Anmeldung weiter.')}
      </p>
      {(slow || result?.restart === false) && (
        <p className="mt-3 text-sm text-warn">{t('Startet Kaveyl Wiki nicht von selbst neu (ohne „restart: unless-stopped“), starte den Container von Hand.')}</p>
      )}
    </AuthLayout>
  );
}

function NewAdminForm({ needsCode, code, onCode, onRestore }: { needsCode: boolean; code: string; onCode: (v: string) => void; onRestore: () => void }) {
  const [f, setF] = useState({ displayName: '', email: '', password: '', repeat: '' });
  const { submit, error, busy } = useSubmit(() =>
    api.setup({ email: f.email, displayName: f.displayName, password: f.password, code: needsCode ? code : undefined }),
  );
  return (
    <AuthLayout
      footer={
        <button type="button" className={linkCls} onClick={onRestore}>
          {t('Neuer Server? Aus einer Sicherung wiederherstellen')}
        </button>
      }
    >
      <Heading
        title={t('Kaveyl Wiki einrichten')}
        text={t('Leg das Administrator-Konto an. Der Name erscheint als Autor in den Git-Commits (die E-Mail-Adresse nicht); mit der E-Mail meldest du dich an.')}
      />
      <form className="space-y-4" onSubmit={submit}>
        {needsCode && <SetupCodeField code={code} onCode={onCode} autoFocus />}
        <AuthField label={t('Name')}>
          <TextInput autoFocus={!needsCode} autoComplete="name" maxLength={100} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={t('z. B. Alex Muster')} />
        </AuthField>
        <AuthField label={t('E-Mail')}>
          <TextInput type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </AuthField>
        <NewPassword label={t('Passwort')} value={f.password} repeat={f.repeat} onValue={(v) => setF({ ...f, password: v })} onRepeat={(v) => setF({ ...f, repeat: v })} context={[f.email, f.displayName]} />
        <SubmitButton busy={busy} error={error} missing={[needsCode && !code.trim() && t('Einrichtungscode'), !f.email.trim() && t('E-Mail'), ...passwordMissing(f.password, f.repeat, t('Passwort'), [f.email, f.displayName])]}>
          {t('Konto anlegen')}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

// ── Links aus Mails ─────────────────────────────────────────────────────────────────

/** #reset=… / #invite=… — read once, then removed from the address bar (and history). */
export function takeMailLink(): { kind: 'reset' | 'invite'; token: string } | null {
  const m = /^#(reset|invite)=([A-Za-z0-9_-]{30,80})$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return { kind: m[1] as 'reset' | 'invite', token: m[2]! };
}

export function MailLinkPage({ token, onDone }: { token: string; onDone: () => void }) {
  // Asked afresh at every visit (gcTime 0): a link used meanwhile in this tab must show as used, not as the cached form.
  const info = useQuery({ queryKey: ['mail-token', token], queryFn: () => api.mailTokenInfo(token), retry: false, staleTime: Infinity, gcTime: 0 });
  const back = (
    <button type="button" className={linkCls} onClick={onDone}>
      {t('Zur Anmeldung')}
    </button>
  );
  if (info.isPending) {
    return (
      <AuthLayout>
        <div className="flex justify-center py-6 text-fg-muted">
          <Spinner />
        </div>
      </AuthLayout>
    );
  }
  if (info.isError) {
    return (
      <AuthLayout footer={back}>
        <Heading
          title={t('Link nicht mehr gültig')}
          text={t('Der Link ist abgelaufen oder wurde schon benutzt. Fordere über „Passwort vergessen?“ einen neuen an oder bitte um eine neue Einladung.')}
        />
      </AuthLayout>
    );
  }
  return info.data.kind === 'reset' ? <ResetForm token={token} email={info.data.email} onDone={onDone} back={back} /> : <InviteForm token={token} info={info.data} onDone={onDone} back={back} />;
}

function ResetForm({ token, email, onDone, back }: { token: string; email: string; onDone: () => void; back: ReactNode }) {
  const [pw, setPw] = useState('');
  const [repeat, setRepeat] = useState('');
  const { submit, error, busy } = useSubmit(() => api.resetPasswordByLink(token, pw), onDone);
  return (
    <AuthLayout footer={back}>
      <Heading title={t('Neues Passwort festlegen')} text={t('für {email}. Danach bist du angemeldet; alle anderen Anmeldungen werden beendet.', { email })} />
      <form className="space-y-4" onSubmit={submit}>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <NewPassword value={pw} repeat={repeat} onValue={setPw} onRepeat={setRepeat} context={[email]} />
        <SubmitButton busy={busy} error={error} missing={passwordMissing(pw, repeat, t('Neues Passwort'), [email])}>
          {t('Passwort speichern')}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

function InviteForm({ token, info, onDone, back }: { token: string; info: MailTokenInfo; onDone: () => void; back: ReactNode }) {
  const [name, setName] = useState(info.displayName);
  const [pw, setPw] = useState('');
  const [repeat, setRepeat] = useState('');
  const { submit, error, busy } = useSubmit(
    () => api.acceptInvite(token, pw, name),
    (r) => {
      // Open the shared note right away, or show the shared folder or source in the tree.
      if (r.note) history.replaceState(null, '', `/n/${r.note.mountId}/${r.note.path.split('/').map(encodeURIComponent).join('/')}`);
      else if (r.folder) history.replaceState(null, '', `/t/${r.folder.mountId}/${r.folder.path.split('/').map(encodeURIComponent).join('/')}`);
      onDone();
    },
  );
  const shared = info.note ?? info.folder ?? info.source;
  const what = shared ? (
    <Rich
      text={
        info.note
          ? t('{inviter} hat die Notiz {note} mit dir geteilt.', { inviter: info.inviter ?? t('Jemand') })
          : info.folder
            ? t('{inviter} hat den Ordner {note} mit dir geteilt, mit allem, was darin liegt.', { inviter: info.inviter ?? t('Jemand') })
            : t('{inviter} hat die Quelle {note} mit dir geteilt, mit allem, was darin liegt.', { inviter: info.inviter ?? t('Jemand') })
      }
      parts={{ note: <strong className="text-fg">{t('„{name}“', { name: shared })}</strong> }}
    />
  ) : (
    <>{t('{inviter} hat ein Kaveyl-Wiki-Konto für dich vorbereitet.', { inviter: info.inviter ?? t('Der Administrator') })}</>
  );
  if (info.accountExists) {
    return (
      <AuthLayout footer={back}>
        <Heading
          title={t('Einladung annehmen')}
          text={
            <>
              {what} {t('Für {email} gibt es schon ein Konto – bitte mit dessen Passwort bestätigen.', { email: info.email })}
            </>
          }
        />
        <form className="space-y-4" onSubmit={submit}>
          <input type="email" autoComplete="username" value={info.email} readOnly hidden />
          <AuthField label={t('Passwort')}>
            <PasswordInput autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </AuthField>
          <SubmitButton busy={busy} error={error} missing={[!pw && t('Passwort')]}>
            {t('Annehmen')}
          </SubmitButton>
        </form>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout footer={back}>
      <Heading
        title={t('Willkommen bei Kaveyl Wiki')}
        text={
          <>
            {what} {t('Leg deinen Namen und ein Passwort fest – angemeldet wird mit {email}.', { email: info.email })}
          </>
        }
      />
      <form className="space-y-4" onSubmit={submit}>
        <input type="email" autoComplete="username" value={info.email} readOnly hidden />
        <AuthField label={t('Dein Name')}>
          <TextInput autoFocus autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </AuthField>
        <NewPassword label={t('Passwort')} value={pw} repeat={repeat} onValue={setPw} onRepeat={setRepeat} context={[info.email, name]} />
        <SubmitButton busy={busy} error={error} missing={[!name.trim() && t('Dein Name'), ...passwordMissing(pw, repeat, t('Passwort'), [info.email, name])]}>
          {t('Konto einrichten')}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

// ── Pflicht: neues Passwort ─────────────────────────────────────────────────────────

export function ForcePasswordChange({ user }: { user: User }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [repeat, setRepeat] = useState('');
  const { submit, error, busy } = useSubmit(() => api.changePassword(current, pw));
  const logout = async () => {
    const res = await api.logout().catch(() => undefined);
    if (res?.redirect) return window.location.assign(res.redirect);
    await qc.invalidateQueries({ queryKey: ['session'] });
  };
  useEffect(() => {
    document.title = t('Neues Passwort · Kaveyl');
  }, []);
  return (
    <AuthLayout
      footer={
        <button type="button" className={linkCls} onClick={() => void logout()}>
          {t('Abmelden')}
        </button>
      }
    >
      <Heading
        title={t('Bitte ein neues Passwort festlegen')}
        text={t('Dein bisheriges Passwort wurde vom Administrator vergeben, oder dein Konto ist für einen Passwortwechsel vorgemerkt. Erst mit einem eigenen Passwort geht es weiter.')}
      />
      <form className="space-y-4" onSubmit={submit}>
        <input type="email" autoComplete="username" value={user.email} readOnly hidden />
        <AuthField label={t('Bisheriges Passwort')}>
          <PasswordInput autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </AuthField>
        <NewPassword value={pw} repeat={repeat} onValue={setPw} onRepeat={setRepeat} context={[user.email, user.username, user.displayName]} />
        <SubmitButton busy={busy} error={error} missing={[!current && t('Bisheriges Passwort'), ...passwordMissing(pw, repeat, t('Neues Passwort'), [user.email, user.username, user.displayName])]}>
          {t('Passwort speichern')}
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}
