// Connections (AD-029): reusable access data for repositories — Gitea, GitHub, GitLab or plain
// Git. Managed in Settings → Quellen; the source wizard picks one or creates it on the way.
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, GitBranch, KeyRound, Pencil, Plus, Trash2, Webhook, XCircle } from 'lucide-react';
import { api, CONNECTION_LABEL, errorText, type Connection, type ConnectionKind, type WebhookStatus, type WebhookStep } from '../api';
import { Button, Field, Input, Spinner, cx, useModalDirty, choiceDialog, confirmDialog, FormError } from '../ui';
import { fmtAgo, t, tn } from '../i18n';

export const DEFAULT_BASE: Partial<Record<ConnectionKind, string>> = { github: 'https://github.com', gitlab: 'https://gitlab.com' };

const TOKEN_HINT: Record<ConnectionKind, string> = {
  gitea: t('Gitea → Einstellungen → Anwendungen. Rechte: repository lesen + schreiben, user lesen (für Besitzer/Organisationen; für „Webhook einrichten“ user schreiben).'),
  github: t(
    'GitHub → Settings → Developer settings → Personal access tokens. Fine-grained: Contents lesen + schreiben (Anlegen/Archivieren/Löschen zusätzlich Administration, Webhooks: Webhooks schreiben); classic: repo (Löschen: delete_repo, Webhooks: admin:repo_hook).',
  ),
  gitlab: t('GitLab → Einstellungen → Zugriffstoken. Bereich api (Repo-Liste, Anlegen, Archivieren); nur zum Klonen/Pushen reicht read_repository + write_repository.'),
  git: t('Optional – nur für private Repositories. Mit Benutzername meldet sich Kaveyl Wiki per Basic-Anmeldung an (z. B. Bitbucket, Azure DevOps).'),
};

const queryKey = ['connections'];
export const useConnections = () => useQuery({ queryKey, queryFn: api.connections });

export function KindIcon({ kind, className }: { kind: ConnectionKind; className?: string }) {
  return kind === 'git' ? <GitBranch className={cx('h-4 w-4 shrink-0 text-fg-faint', className)} /> : <KeyRound className={cx('h-4 w-4 shrink-0 text-fg-faint', className)} />;
}

/** Create (no `value`) or edit a connection. The token is never shown, only replaced. */
export function ConnectionForm({
  value,
  kind: fixedKind,
  onSaved,
  onCancel,
}: {
  value?: Connection;
  /** Fixed kind (wizard tab) — otherwise the user picks it. */
  kind?: ConnectionKind;
  onSaved: (c: Connection) => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<ConnectionKind>(value?.kind ?? fixedKind ?? 'gitea');
  const [name, setName] = useState(value?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(value?.baseUrl ?? DEFAULT_BASE[fixedKind ?? 'gitea'] ?? '');
  const [username, setUsername] = useState(value?.username ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !!token || name !== (value?.name ?? '') || username !== (value?.username ?? '') || baseUrl !== (value?.baseUrl ?? DEFAULT_BASE[kind] ?? '');
  useModalDirty(dirty);
  const needsToken = kind !== 'git' && !value?.hasToken;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      const body = { name, baseUrl, username: kind === 'git' ? username || null : null, ...(token ? { token } : {}) };
      const saved = value ? await api.updateConnection(value.id, body) : await api.createConnection({ kind, ...body });
      await qc.invalidateQueries({ queryKey });
      await qc.invalidateQueries({ queryKey: ['mounts'] });
      setToken('');
      onSaved(saved);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border border-line p-3" aria-label={value ? t('Verbindung {name} bearbeiten', { name: value.name }) : t('Neue Verbindung')}>
      {!value && !fixedKind && (
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 text-sm" role="radiogroup" aria-label={t('Art')}>
          {(['gitea', 'github', 'gitlab', 'git'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={cx('flex-1 rounded-md px-2 py-1', kind === k ? 'bg-bg shadow-sm' : 'text-fg-muted')}
              onClick={() => {
                setKind(k);
                setBaseUrl(DEFAULT_BASE[k] ?? '');
              }}
            >
              {CONNECTION_LABEL[k]}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Adresse')} hint={kind === 'github' ? t('github.com oder GitHub Enterprise') : kind === 'gitlab' ? t('gitlab.com oder eigene Instanz') : undefined}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={kind === 'gitea' ? 'https://gitea.example.com' : 'https://git.example.com'} disabled={!!value && value.mounts > 0} />
        </Field>
        <Field label={t('Name (optional)')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${CONNECTION_LABEL[kind]} (${hostOf(baseUrl) || '…'})`} />
        </Field>
      </div>
      {value && value.mounts > 0 && <p className="text-xs text-fg-faint">{t('Die Adresse ist fest, solange Quellen diese Verbindung nutzen.')}</p>}
      <div className={cx('grid gap-3', kind === 'git' && 'sm:grid-cols-2')}>
        {kind === 'git' && (
          <Field label={t('Benutzername (optional)')}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
        )}
        <Field label={t('Token')} hint={value?.hasToken ? t('Gespeichert – nur ausfüllen, um ihn zu ersetzen.') : TOKEN_HINT[kind]}>
          <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
      </div>
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('Abbrechen')}
          </Button>
        )}
        <Button variant="primary" disabled={busy || !baseUrl.trim() || (needsToken && !token)}>
          {busy && <Spinner />} {value ? t('Speichern') : t('Verbindung anlegen')}
        </Button>
      </div>
    </form>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Settings → Quellen: all connections with check, edit and delete. */
export function ConnectionsPanel() {
  const qc = useQueryClient();
  const list = useConnections();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; detail: string } | 'busy'>>({});
  const [error, setError] = useState<string | null>(null);
  const check = async (c: Connection) => {
    setChecks((s) => ({ ...s, [c.id]: 'busy' }));
    const r = await api.checkConnection(c.id).catch((e: unknown) => ({ ok: false, detail: errorText(e) }));
    setChecks((s) => ({ ...s, [c.id]: r }));
  };
  const remove = async (c: Connection) => {
    if (!(await confirmDialog(t('Verbindung „{name}“ löschen? Der gespeicherte Token wird entfernt.', { name: c.name }), { confirmLabel: t('Löschen'), danger: true }))) return;
    setError(null);
    try {
      await api.deleteConnection(c.id);
      await qc.invalidateQueries({ queryKey });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="space-y-3 text-sm" aria-label={t('Verbindungen')}>
      <h3 className="font-medium">{t('Verbindungen')}</h3>
      <p className="text-fg-muted">
        {t(
          'Zugangsdaten für Repositories – Gitea, GitHub, GitLab oder Git allgemein. Quellen nutzen eine Verbindung; ein neuer Token wirkt sofort für alle. Tokens werden verschlüsselt gespeichert und nie angezeigt.',
        )}
      </p>
      {list.isPending && <Spinner />}
      {list.data && list.data.length === 0 && editing !== 'new' && (
        <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-fg-muted">{t('Noch keine Verbindung. Öffentliche Repositories und lokale Ordner brauchen keine.')}</p>
      )}
      {!!list.data?.length && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.data.map((c) => {
            const st = checks[c.id];
            return (
              <li key={c.id} className="space-y-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <KindIcon kind={c.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-fg-muted">
                      {CONNECTION_LABEL[c.kind]} · {c.baseUrl}
                      {c.username ? ` · ${c.username}` : ''} · {c.hasToken ? t('mit Token') : t('ohne Token')} · {tn(c.mounts, '{n} Quelle', '{n} Quellen')}
                    </span>
                    {st && st !== 'busy' && (
                      <span className={cx('mt-0.5 flex items-center gap-1 text-xs', st.ok ? 'text-ok' : 'text-danger')}>
                        {st.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />} {st.detail}
                      </span>
                    )}
                  </span>
                  <Button size="sm" variant="ghost" disabled={st === 'busy'} onClick={() => void check(c)}>
                    {st === 'busy' && <Spinner className="h-3.5 w-3.5" />} {t('Prüfen')}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={t('{name} bearbeiten', { name: c.name })} title={t('Bearbeiten')} onClick={() => setEditing(editing === c.id ? null : c.id)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    aria-label={t('{name} löschen', { name: c.name })}
                    title={c.mounts ? t('Wird von Quellen genutzt') : t('Löschen')}
                    disabled={c.mounts > 0 || c.trash > 0}
                    onClick={() => void remove(c)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {(c.kind === 'gitea' || c.kind === 'github' || c.kind === 'gitlab') && c.hasToken && <WebhookRow c={c} />}
                {editing === c.id && <ConnectionForm value={c} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
              </li>
            );
          })}
        </ul>
      )}
      <FormError>{error}</FormError>
      {/* The main action below the list, on the left – like everywhere in the settings. */}
      {editing === 'new' ? (
        <ConnectionForm onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
      ) : (
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> {t('Verbindung hinzufügen')}
        </Button>
      )}
    </section>
  );
}

/**
 * Push webhook of a connection (AD-033): without one, sources sync every 5 minutes. „Prüfen“ asks the
 * hoster where our hook is; „Einrichten“ creates the missing ones (Gitea: on the account for all own
 * repositories) or moves ours from an earlier address; „Entfernen“ deletes ours — only on a click, never by itself.
 */
function WebhookRow({ c }: { c: Connection }) {
  const qc = useQueryClient();
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // What the last click was, so „nothing changed“ can be said in the right words.
  const [action, setAction] = useState<'install' | 'remove'>('install');
  const [error, setError] = useState<string | null>(null);
  const last = (mounts.data ?? [])
    .filter((m) => m.hostedRepo?.connectionId === c.id && m.webhookAt)
    .map((m) => m.webhookAt!)
    .sort()
    .at(-1);
  const run = async (fn: () => Promise<WebhookStatus>) => {
    setError(null);
    setBusy(true);
    try {
      setStatus(await fn());
      await qc.invalidateQueries({ queryKey: ['webhook'] });
    } catch (e) {
      setStatus(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // The state is asked for when the row appears and again when the window comes back (e.g. from the hoster, where a
  // hook was deleted by hand) – the row shows what is really there (owner 26.10.).
  useEffect(() => {
    void run(() => api.connectionWebhook(c.id));
    const back = () => {
      if (document.visibilityState === 'visible') void api.connectionWebhook(c.id).then(setStatus, () => undefined);
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);
  /** The current state from the hoster, for a question that names exactly what happens; null on an error. */
  const fresh = async (): Promise<WebhookStatus | null> => {
    setError(null);
    setBusy(true);
    try {
      return await api.connectionWebhook(c.id);
    } catch (e) {
      setStatus(null);
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const none = { created: [], moved: [], removed: [] };
  /** Asks only when there is something to do, and names exactly what (owner 25.10.: no question for nothing). */
  const install = async () => {
    setAction('install');
    const now = await fresh();
    if (!now) return;
    if (setUp(now) || !now.plans.repos.length) return setStatus({ ...now, changes: none });
    setStatus(now);
    const host = CONNECTION_LABEL[c.kind];
    let way: 'account' | 'repos' = 'repos';
    if (now.plans.account && now.account) {
      // Gitea: the account hook covers every own repository – the admin should know that before choosing (owner 25.10.).
      const picked = await choiceDialog(
        t('Webhook bei {host} – wofür?', { host }),
        [
          {
            value: 'repos',
            label: t('Nur die eingebundenen Repositories'),
            detail: `${steps(now.plans.repos, now.url)}\n${t('Nur Pushes in diesen Repositories werden gemeldet. Kommt später eines dazu, hier noch einmal einrichten.')}`,
          },
          {
            value: 'account',
            label: t('Dein ganzes Konto {name}', { name: now.account }),
            detail: `${steps(now.plans.account, now.url)}\n${t('Gilt für alle Repositories von {name}, auch künftige: Jeder Push wird an Kaveyl Wiki gemeldet, abgeglichen werden nur eingebundene Quellen.', { name: now.account })}`,
          },
        ],
        { confirmLabel: t('Einrichten') },
      );
      if (!picked) return;
      way = picked === 'account' ? 'account' : 'repos';
    } else {
      const question = `${t('Webhook bei {host} – das passiert:', { host })}\n${steps(now.plans.repos, now.url)}\n${t('Er meldet jeden Push sofort an Kaveyl Wiki.')}`;
      if (!(await confirmDialog(question, { confirmLabel: t('Einrichten') }))) return;
    }
    await run(() => api.installWebhook(c.id, way));
  };
  /**
   * Removes one hook (`only`) or all of them: asks with exactly that place, nothing when it is already gone at the
   * hoster (owner 25./26.10.).
   */
  const remove = async (only?: { scope: 'account' | 'repo'; name: string }) => {
    setAction('remove');
    const now = await fresh();
    if (!now) return;
    const todo = now.plans.remove.filter((x) => !only || (x.scope === only.scope && x.name === only.name));
    if (!todo.length) return setStatus({ ...now, changes: none });
    setStatus(now);
    const host = CONNECTION_LABEL[c.kind];
    const left = now.hooks.filter((h) => !h.foreign).length > todo.length;
    const question = `${t('Webhook bei {host} entfernen – das passiert:', { host })}\n${steps(todo, now.url)}\n${
      left ? t('Die anderen Webhooks bleiben.') : t('Danach holt Kaveyl Wiki Änderungen wieder alle 5 Minuten.')
    }`;
    if (!(await confirmDialog(question, { confirmLabel: t('Entfernen'), danger: true }))) return;
    await run(() => api.removeWebhook(c.id, only));
  };
  const st = status;
  const list = (names: string[]) => names.map(placeName).join(', ');
  const allSet = !!st && setUp(st);
  const host = CONNECTION_LABEL[c.kind];
  // Another Kaveyl Wiki instance's hooks are only shown (code-004): they count nowhere and have no button.
  const own = st ? st.hooks.filter((h) => !h.foreign) : [];
  // Nothing of ours at the hoster (e.g. just removed): the header says so instead of the last push received.
  const noHook = !!st && own.length === 0;
  return (
    <div className="ml-6 space-y-1 rounded-md bg-subtle px-2.5 py-1.5 text-xs" aria-label={t('Webhook {name}', { name: c.name })}>
      <div className="flex flex-wrap items-center gap-2">
        <Webhook className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1 text-fg-muted">
          {noHook
            ? t('Kein Webhook eingerichtet – Abgleich alle 5 Min.')
            : last
              ? t('Sofort-Abgleich per Webhook – zuletzt {ago}', { ago: fmtAgo(last) })
              : t('Kein Webhook empfangen – Abgleich alle 5 Min.')}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.connectionWebhook(c.id))}>
          {busy && <Spinner className="h-3.5 w-3.5" />} {t('Webhook prüfen')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void install()}>
          {allSet ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> {t('Webhook eingerichtet')}
            </>
          ) : (
            t('Webhook einrichten')
          )}
        </Button>
        {own.length > 1 && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
            {t('Alle entfernen')}
          </Button>
        )}
      </div>
      {st && (
        <ul className="space-y-0.5 pl-5">
          {st.repos.length === 0 && <li className="text-fg-muted">{t('Keine eingebundenen Repositories über diese Verbindung.')}</li>}
          {/* Only the hooks that exist at the hoster – one line each, each with its own button (owner 26.10.). */}
          {st.hooks.map((h) => {
            const where = h.scope === 'account' ? t('Webhook am Konto {name}', { name: h.name }) : t('Webhook am Repository {name}', { name: h.name });
            if (h.foreign)
              return (
                <li key={`${h.scope}:${h.name}:${h.at}`} className="flex items-center gap-1 text-fg-faint">
                  <Webhook className="h-3 w-3 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {where} – {t('gehört zu einer anderen Kaveyl-Wiki-Instanz ({host})', { host: hostOf(h.at) || h.at })}
                  </span>
                </li>
              );
            const warn = !h.current || !h.active || h.double;
            return (
              <li key={`${h.scope}:${h.name}`} className={cx('flex items-center gap-1', warn ? 'text-warn' : 'text-ok')}>
                {warn ? <XCircle className="h-3 w-3 shrink-0" /> : <CheckCircle2 className="h-3 w-3 shrink-0" />}
                <span className="min-w-0 flex-1">
                  {where}
                  {h.scope === 'account' && ` – ${t('meldet Pushes aus allen deinen Repositories')}`}
                  {!h.current && ` – ${t('zeigt noch auf {url} – „Webhook einrichten“ stellt ihn auf die Adresse unten um', { url: h.at })}`}
                  {!h.active && ` – ${t('ist in {host} ausgeschaltet', { host })}`}
                  {h.double && ` – ${t('jeder Push kommt doppelt an (Konto und Repository), einen davon entfernen')}`}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t('{place} entfernen', { place: where })}
                  title={t('{place} entfernen', { place: where })}
                  onClick={() => void remove({ scope: h.scope, name: h.name })}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </li>
            );
          })}
          {!noHook && st.uncovered.length > 0 && (
            <li className="text-fg-muted">{t('Ohne Webhook (Abgleich alle 5 Min.): {list}', { list: st.uncovered.join(', ') })}</li>
          )}
          {st.unreachable && <li><span role="alert" className="text-danger">
              {t('{host} erreicht {url} nicht (Adresse im eigenen Netz) – öffentliche Adresse unter Einstellungen → Quellen → Webhooks eintragen.', {
                host,
                url: st.url,
              })}
            </span></li>}
          {!noHook && <li className="text-fg-faint">{t('Ziel: {url}', { url: st.url })}</li>}
          {st.changes && (
            <li role="status" className="text-fg-muted">
              {[
                st.changes.created.length > 0 && t('Angelegt: {list}', { list: list(st.changes.created) }),
                st.changes.moved.length > 0 && t('Auf die neue Adresse umgestellt: {list}', { list: list(st.changes.moved) }),
                st.changes.removed.length > 0 && t('Entfernt: {list}', { list: list(st.changes.removed) }),
              ]
                .filter(Boolean)
                .join(' · ') || (action === 'remove' ? t('Nichts zu entfernen – es gibt keinen Webhook von Kaveyl Wiki.') : t('Nichts zu tun – alles war schon so eingerichtet.'))}
            </li>
          )}
        </ul>
      )}
      <FormError>{error}</FormError>
    </div>
  );
}

/**
 * Every added repository is reached (by its own hook or the account hook), and every hook of ours calls the current address
 * and is on – another instance's hooks do not count (code-004).
 */
function setUp(st: WebhookStatus): boolean {
  return st.repos.length > 0 && st.uncovered.length === 0 && st.hooks.every((h) => h.foreign || (h.current && h.active));
}

/** The Gitea account as „Konto …“, a repository (always with a „/“) by its name. */
function placeName(name: string): string {
  return name.includes('/') ? name : t('Konto {name}', { name });
}

/** What a click does, one bullet per place. */
function steps(list: WebhookStep[], url: string): string {
  return list
    .map((s) => {
      const place = s.scope === 'account' ? t('Konto {name}', { name: s.name }) : s.name;
      if (s.action === 'move') return t('{place}: von {old} auf {url} umstellen', { place, old: s.from ?? '', url });
      if (s.action === 'remove') return t('{place}: entfernen', { place });
      return t('{place}: anlegen', { place });
    })
    .map((l) => `• ${l}`)
    .join('\n');
}

/** Connections whose address fits a clone URL (same origin). */
export function connectionsFor(list: Connection[] | undefined, url: string): Connection[] {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  })();
  return origin ? (list ?? []).filter((c) => new URL(c.baseUrl).origin === origin) : [];
}
