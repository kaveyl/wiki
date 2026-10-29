// Settings → SSO & Proxy (AD-049): sign-in through Authentik (Pangolin removed, AD-058), the state of the reverse proxy, and the own
// account's connection to a provider (Settings → Konto).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, KeyRound, Link2, Unlink, XCircle } from 'lucide-react';
import { PROXY_FIELDS, PROXY_LABEL, type ProxyField, type ProxyAuthSettings, type ProxyProvider } from '@kaveyl-wiki/core';
import { api, ApiError, errorText } from '../api';
import { fmtDate, t } from '../i18n';
import { copyWithToast } from '../clipboard';
import { openHelp } from '../help/help';
import { Button, Field, Input, Spinner, confirmDialog, fillNodes, useModalDirty, FormError, FormStatus } from '../ui';


/** Form state: addresses as one text field (comma, space or line break). */
type Form = Omit<ProxyAuthSettings, 'proxies'> & { proxies: string };
const toForm = (c: ProxyAuthSettings): Form => ({ ...c, proxies: c.proxies.join(', ') });
const same = (a: Form, b: Form) => (Object.keys(a) as (keyof Form)[]).every((k) => a[k] === b[k]);

function Check({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  const Icon = ok ? CheckCircle2 : warn ? AlertTriangle : XCircle;
  return (
    <li className="flex items-start gap-2">
      <Icon className={ok ? 'mt-0.5 h-4 w-4 shrink-0 text-ok' : warn ? 'mt-0.5 h-4 w-4 shrink-0 text-warn' : 'mt-0.5 h-4 w-4 shrink-0 text-fg-faint'} aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/** One tab per provider, one shared server logic with the provider's defaults. */
export function ProxyAuthPanel({ provider }: { provider: ProxyProvider }) {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ['proxy-auth', provider], queryFn: () => api.proxyAuth(provider) });
  const [form, setForm] = useState<Form | null>(null);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; help?: string; field?: ProxyField }>({});
  /** The fields a refusal can point at: the message shows there and the field gets the focus (design-006). */
  const fields = useRef<Partial<Record<ProxyField, HTMLInputElement | null>>>({});
  /** The secret just made – shown only now, the server keeps its hash only. */
  const [secret, setSecret] = useState<string | null>(null);
  const saved = state.data ? toForm(state.data.config) : null;
  const f = form ?? saved;
  useModalDirty(!!form && !!saved && !same(form, saved));
  if (!f || !state.data) return <Spinner />;
  const req = state.data.request;
  const name = PROXY_LABEL[provider];
  /** Authentik's sign-out on the domain this tab was opened through – right when Kaveyl Wiki sits behind it. */
  const signOutHere = `${location.origin}/outpost.goauthentik.io/sign_out`;
  const set = (patch: Partial<Form>) => {
    setForm({ ...f, ...patch });
    // Changing the field that was refused takes its message away.
    if (result.field && result.field in patch) setResult({});
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const next = await api.saveProxyAuth(provider, { ...f, proxies: f.proxies.split(/[\s,]+/).filter(Boolean) });
      qc.setQueryData(['proxy-auth', provider], next);
      setForm(null);
      setResult({ ok: true });
    } catch (err) {
      const help = err instanceof ApiError && typeof err.body.help === 'string' ? err.body.help : undefined;
      const field = err instanceof ApiError && (PROXY_FIELDS as readonly string[]).includes(err.body.field as string) ? (err.body.field as ProxyField) : undefined;
      setResult({ error: errorText(err), help, field });
      if (field) fields.current[field]?.focus();
    }
  };
  const makeSecret = async () => {
    const again = state.data!.secretSet;
    const ok = await confirmDialog(
      again
        ? t('Neuen Geheimwert erzeugen? Der bisherige gilt sofort nicht mehr. Bis der neue im Proxy steht, meldet {name} niemanden an – Sitzungen, die über den Proxy entstanden sind, enden mit der nächsten Anfrage.', { name })
        : t('Geheimwert erzeugen? Ab sofort meldet {name} nur noch an, wenn der Proxy diesen Wert mitschickt. Bis er im Proxy eingetragen ist, meldet {name} niemanden an – Sitzungen, die über den Proxy entstanden sind, enden mit der nächsten Anfrage. Die Anmeldung mit Passwort bleibt.', { name }),
      { confirmLabel: t('Erzeugen') },
    );
    if (!ok) return;
    try {
      const r = await api.createProxySecret(provider);
      qc.setQueryData(['proxy-auth', provider], r.state);
      setSecret(r.secret);
    } catch (err) {
      setResult({ error: errorText(err) });
    }
  };
  const removeSecret = async () => {
    const ok = await confirmDialog(
      t('Geheimwert entfernen? Dann zählt wieder allein die Adresse des Proxys. Vergisst ein Weg zu Kaveyl Wiki, die Kopfzeilen zu leeren, kann sich darüber jemand als ein verbundenes Konto anmelden.'),
      { confirmLabel: t('Entfernen'), danger: true },
    );
    if (!ok) return;
    try {
      qc.setQueryData(['proxy-auth', provider], await api.removeProxySecret(provider));
      setSecret(null);
    } catch (err) {
      setResult({ error: errorText(err) });
    }
  };
  const message = result.error && (
    <>
      {result.error}
      {result.help && (
        <>
          {' '}
          <button type="button" className="text-accent hover:underline" onClick={() => openHelp(result.help)}>
            {t('Warum? (Hilfe)')}
          </button>
        </>
      )}
    </>
  );
  const errorAt = (field: ProxyField) => (result.field === field ? message : undefined);
  const secretLine = (v: string) => `proxy_set_header X-Kaveyl-Wiki-Proxy-Secret "${v}";`;
  return (
    <form className="space-y-4 text-sm" onSubmit={save} aria-label={name}>
      {state.data.loopback.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>
            {t('Als Proxy-Adresse ist {ip} eingetragen – der Rechner selbst. Dann zählt jedes Programm auf diesem Rechner als Proxy. Nur sinnvoll, wenn der Proxy auf demselben Rechner läuft und Kaveyl Wiki im Netz des Rechners; dann unbedingt einen Geheimwert setzen.', {
              // "::1" goes in as a value – inside the text "::" would read as a context key.
              ip: state.data.loopback.join(', '),
            })}
          </span>
        </div>
      )}
      <section className="space-y-1" aria-label={t('Automatische Anmeldung (Forward Auth)')}>
        <h4 className="font-medium">{t('Automatische Anmeldung (Forward Auth)')}</h4>
        <p className="text-fg-muted">
          {t('Wird Kaveyl Wiki hinter Authentik (Proxy-Provider / Forward Auth) betrieben, werden Benutzer automatisch angemeldet. Das Konto muss dazu einmalig unter Einstellungen → Konto verbunden werden. Wichtig: Es werden keine neuen Konten automatisch erstellt.')}
        </p>
      </section>
      <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-fg">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium">{t('Sicherheitshinweis zu Proxy-IPs')}</p>
          <p>{t('Der Proxy übermittelt den Benutzer als einfachen HTTP-Header. Da jeder im Netzwerk diesen Header bei einem Direktaufruf fälschen könnte, vertraut Kaveyl Wiki diesen Daten nur, wenn die Anfrage exakt von einer der unten stehenden IP-Adressen kommt.')}</p>
          <p>{t('Trage hier ausschließlich die Adresse ein, mit der der Proxy (oder Outpost) bei Kaveyl Wiki anklopft.')}</p>
        </div>
      </div>
      {state.data.problem && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-fg">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          <span>{t('Die gespeicherte Einstellung ist ungültig: {problem} – die Anmeldung über {name} ist deshalb aus. Bitte korrigieren und speichern.', { problem: state.data.problem, name })}</span>
        </div>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={f.enabled}
          // Switched on, a sign-out address is required (AD-058): suggest Authentik's on this very domain.
          onChange={(e) => set({ enabled: e.target.checked, ...(e.target.checked && !f.logoutUrl.trim() ? { logoutUrl: signOutHere } : {}) })}
        />
        {t('Anmeldung über {name} erlauben', { name })}
      </label>
      <Field label={t('Adresse des Proxys (Pflicht)')} error={errorAt('proxies')} hint={t('Einzelne IP-Adressen, mehrere mit Komma getrennt – keine Bereiche; z. B. die Adresse von {proxy}, unter der er bei Kaveyl Wiki ankommt. Diese Anfrage kam von {ip}.', { proxy: 'Nginx Proxy Manager', ip: req.socket })}>
        <Input ref={(el) => void (fields.current.proxies = el)} value={f.proxies} onChange={(e) => set({ proxies: e.target.value })} spellCheck={false} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Header mit der Kennung')} error={errorAt('idHeader')} hint={t('Feste Kennung der Person beim Anbieter – damit wird das Konto verbunden.')}>
          <Input ref={(el) => void (fields.current.idHeader = el)} value={f.idHeader} onChange={(e) => set({ idHeader: e.target.value })} spellCheck={false} />
        </Field>
        <Field label={t('Header mit der E-Mail-Adresse')} error={errorAt('emailHeader')} hint={t('Nur für „Konten automatisch über die E-Mail-Adresse verbinden“.')}>
          <Input ref={(el) => void (fields.current.emailHeader = el)} value={f.emailHeader} onChange={(e) => set({ emailHeader: e.target.value })} spellCheck={false} />
        </Field>
      </div>
      <Field
        label={t('Abmelde-Adresse (Pflicht)')}
        error={errorAt('logoutUrl')}
        hint={t('Hierhin schickt „Abmelden“ den Browser, damit Authentik ebenfalls abmeldet – sonst wäre man sofort wieder angemeldet. Meist {url}.', { url: signOutHere })}
      >
        <Input ref={(el) => void (fields.current.logoutUrl = el)} value={f.logoutUrl} onChange={(e) => set({ logoutUrl: e.target.value })} placeholder={signOutHere} spellCheck={false} />
      </Field>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={f.autoLinkByEmail} onChange={(e) => set({ autoLinkByEmail: e.target.checked })} />
        <span>
          {t('Konten automatisch über die E-Mail-Adresse verbinden')}
          <span className="block text-xs text-fg-muted">
            {t('Wer zum ersten Mal über Authentik kommt, wird mit dem Kaveyl-Wiki-Konto mit derselben E-Mail-Adresse verbunden – sonst tut das jede Person einmal selbst unter „Konto“. Administratoren verbinden sich immer selbst. Nur einschalten, wenn sich in Authentik niemand selbst ein Konto anlegen oder seine E-Mail-Adresse ohne Bestätigung ändern kann – sonst könnte sich jemand mit fremder Adresse als diese Person anmelden.')}
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm">
          {t('Speichern')}
        </Button>
        <FormStatus>{result.ok && t('Gespeichert.')}</FormStatus>
        <FormError>{!result.field && message}</FormError>
      </div>

      <section className="space-y-2 border-t border-line pt-4" aria-label={t('Geheimwert des Proxys')}>
        <h4 className="font-medium">{t('Geheimwert des Proxys (empfohlen)')}</h4>
        <p className="text-fg-muted">
          {fillNodes(
            t('Zweite Sicherung: Der Proxy schickt zusätzlich einen Wert mit, den nur er kennt ({header}). Vergisst ein Weg zu Kaveyl Wiki, die Kopfzeilen zu leeren (eine Ausnahme, ein zweiter Proxy-Host), meldet Kaveyl Wiki darüber trotzdem niemanden an. Kaveyl Wiki zeigt den Wert nur einmal und speichert nur einen Fingerabdruck.'),
            { header: <code>X-Kaveyl-Wiki-Proxy-Secret</code> },
          )}
        </p>
        {secret && (
          <div className="space-y-1 rounded-lg border border-accent bg-accent-soft p-3" role="status">
            <p className="font-medium">{t('Neuer Geheimwert – jetzt in den Proxy eintragen, er wird nicht wieder angezeigt:')}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1 text-xs" aria-label={t('Geheimwert')}>
                {secret}
              </code>
              <Button size="sm" onClick={() => void copyWithToast(secret, 'Geheimwert')}>
                <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
              </Button>
            </div>
            <p className="text-xs text-fg-muted">
              {t('Nginx Proxy Manager: zu den Zeilen mit auth_request (aktuelle Authentik-Anleitung: Custom Locations → / → Zahnrad):')}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1 text-xs">{secretLine(secret)}</code>
              <Button size="sm" onClick={() => void copyWithToast(secretLine(secret), 'Zeile')}>
                <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void makeSecret()}>
            <KeyRound className="h-3.5 w-3.5" /> {state.data.secretSet ? t('Neu erzeugen …') : t('Geheimwert erzeugen …')}
          </Button>
          {state.data.secretSet && (
            <Button size="sm" variant="ghost" onClick={() => void removeSecret()}>
              {t('Entfernen …')}
            </Button>
          )}
          <span className="text-fg-muted">{state.data.secretSet ? t('Gesetzt – ohne ihn meldet {name} niemanden an.', { name }) : t('Nicht gesetzt – es zählt allein die Adresse des Proxys.')}</span>
        </div>
      </section>

      <section className="space-y-2 border-t border-line pt-4" aria-label={t('Einrichtungshilfe')}>
        <h4 className="font-medium">{t('Einrichtungshilfe – diese Anfrage')}</h4>
        <ul className="space-y-1">
          <Check ok={req.trusted}>{req.trusted ? t('Kam von {ip} – einer eingetragenen Proxy-Adresse.', { ip: req.socket }) : t('Kam von {ip} – keine eingetragene Proxy-Adresse. Öffne Kaveyl Wiki über {name}, um hier den Proxy zu sehen.', { ip: req.socket, name })}</Check>
          <Check ok={req.idHeaderSeen}>{req.idHeaderSeen ? t('Header „{h}“ kam an.', { h: f.idHeader }) : t('Header „{h}“ kam nicht an.', { h: f.idHeader })}</Check>
          {state.data.secretSet && (
            <Check ok={req.secretOk}>{req.secretOk ? t('Geheimwert kam an und stimmt.') : req.secretSeen ? t('Geheimwert kam an, stimmt aber nicht – im Proxy den zuletzt erzeugten Wert eintragen.') : t('Geheimwert kam nicht an.')}</Check>
          )}
          {req.subject && <Check ok>{t('Kennung: {id}', { id: req.subject })}{req.email ? ` · ${req.email}` : ''}</Check>}
          {req.socketIsGateway && (
            <Check ok={false} warn>
              {t('Diese Adresse ist das Docker-Gateway ({ip}) und kann nicht als Proxy eingetragen werden: Über sie können auch andere Programme und Container dieses Rechners kommen. Den Proxy in dasselbe Docker-Netz wie Kaveyl Wiki hängen und die Adresse des Proxy-Containers eintragen.', { ip: req.socket })}
            </Check>
          )}
        </ul>
        <p className="text-xs text-fg-muted">
          {t('Verbundene Konten: {n}', { n: state.data.linked })} ·{' '}
          <button type="button" className="text-accent hover:underline" onClick={() => openHelp(provider)}>
            {t('Einrichtung Schritt für Schritt')}
          </button>
        </p>
      </section>
    </form>
  );
}

/** Reverse proxy (NPM): state only – TRUST_PROXY stays in the compose file (AD-031). */
export function ReverseProxyPanel() {
  const state = useQuery({ queryKey: ['reverse-proxy'], queryFn: api.reverseProxy });
  const [ws, setWs] = useState<'pending' | 'ok' | 'fail'>('pending');
  useEffect(() => {
    // Its own short test connection: the live updates need WebSockets through the proxy.
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`);
    const timer = setTimeout(() => setWs('fail'), 5000);
    sock.onopen = () => {
      clearTimeout(timer);
      setWs('ok');
      sock.close();
    };
    sock.onerror = () => setWs('fail');
    return () => {
      clearTimeout(timer);
      sock.close();
    };
  }, []);
  const s = state.data;
  if (!s) return <Spinner />;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {t('Hier gibt es nichts einzustellen – der Reiter zeigt, wie Kaveyl Wiki diese Anfrage sieht. Welchen Proxys Kaveyl Wiki die Besucher-Adresse glaubt, steht als TRUST_PROXY in der docker-compose.yml.')}
      </p>
      <ul className="space-y-1.5">
        <Check ok={!!s.trustProxy} warn={!s.trustProxy}>
          {s.trustProxy ? t('TRUST_PROXY: {list}', { list: s.trustProxy }) : t('TRUST_PROXY ist nicht gesetzt – jedem Proxy im eigenen Netz wird geglaubt. Hinter einem Reverse-Proxy dessen Adresse eintragen.')}
        </Check>
        <Check ok={s.viaTrustedProxy || !s.forwarded} warn={s.forwarded && !s.viaTrustedProxy}>
          {s.viaTrustedProxy
            ? t('Diese Anfrage kam über den Proxy {proxy}; Kaveyl Wiki sieht als Besucher {ip}.', { proxy: s.socket, ip: s.clientIp })
            : s.forwarded
              ? t('Diese Anfrage kam von {proxy} mit X-Forwarded-For, aber diese Adresse steht nicht in TRUST_PROXY – die Besucher-Adresse wird ignoriert.', { proxy: s.socket })
              : t('Diese Anfrage kam direkt von {ip} (ohne Proxy).', { ip: s.socket })}
        </Check>
        <Check ok={s.https} warn={!s.https}>
          {s.https ? t('https erkannt – die Anmeldung gilt nur für https.') : t('Aufruf über http – über einen Proxy mit https sollte hier „https erkannt“ stehen (TRUST_PROXY prüfen).')}
        </Check>
        <Check ok={ws === 'ok'} warn={ws === 'pending'}>
          {ws === 'ok' ? t('Live-Verbindung steht.') : ws === 'pending' ? t('Live-Verbindung wird geprüft …') : t('Live-Verbindung kommt nicht zustande – im Proxy „Websockets Support“ einschalten.')}
        </Check>
        {s.hint && (
          <Check ok={false} warn>
            {t('Proxy-Warnung seit dem Start: Anfragen mit X-Forwarded-For ohne TRUST_PROXY, zuerst von {ip}.', { ip: s.hint.proxy })}
          </Check>
        )}
      </ul>
      <button type="button" className="text-accent hover:underline" onClick={() => openHelp('zugriff-über-das-netz')}>
        {t('Reverse-Proxy einrichten (Handbuch)')}
      </button>
    </div>
  );
}

/** Settings → Konto: connect the own account to an auth proxy (only shown when one is switched on). */
export function ProxyConnections() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['my-proxies'], queryFn: api.myProxies });
  const [error, setError] = useState<string | null>(null);
  if (!mine.data?.length) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['my-proxies'] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="space-y-2 border-t border-line pt-4 text-sm" aria-label={t('Anmeldung über einen Proxy')}>
      <h3 className="font-medium">{t('Anmeldung über einen Proxy')}</h3>
      <p className="text-fg-muted">{t('Ist dein Konto verbunden, meldet dich der Proxy hier an, ohne Passwort. Verbinden geht nur, wenn du Kaveyl Wiki gerade über diesen Proxy geöffnet hast.')}</p>
      <ul className="space-y-2">
        {mine.data.map((p) => (
          <li key={p.provider} className="flex flex-wrap items-center gap-3">
            <span className="min-w-24 font-medium">{p.label}</span>
            {p.linkedAt ? (
              <>
                <span className="text-fg-muted">{t('verbunden seit {date}', { date: fmtDate(p.linkedAt) })}</span>
                <Button
                  size="sm"
                  onClick={async () => {
                    if (await confirmDialog(t('Verbindung zu {name} lösen? Danach meldet dich {name} nicht mehr an.', { name: p.label }))) await run(() => api.unlinkProxy(p.provider));
                  }}
                >
                  <Unlink className="h-3.5 w-3.5" /> {t('Verbindung lösen')}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" disabled={!p.available} onClick={() => void run(() => api.linkProxy(p.provider))}>
                  <Link2 className="h-3.5 w-3.5" /> {t('Mit {name} verbinden', { name: p.label })}
                </Button>
                {!p.available && <span className="text-xs text-fg-muted">{t('Öffne Kaveyl Wiki über {name}, dann geht es hier weiter.', { name: p.label })}</span>}
              </>
            )}
          </li>
        ))}
      </ul>
      <FormError>{error}</FormError>
    </section>
  );
}
