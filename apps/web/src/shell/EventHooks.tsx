// Settings → KI & APIs → Ereignis-Webhooks (admins, AD-066): Kaveyl Wiki tells an agent at once what changed – a signed
// POST per batch, with the rights of one person. The secret is shown once, right after creating or renewing it.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, Send, Trash2 } from 'lucide-react';
import { api, errorText, type EventHook, type Mount } from '../api';
import { t } from '../i18n';
import { copyWithToast } from '../clipboard';
import { Button, Field, FormError, Input, Spinner, confirmDialog, cx } from '../ui';

export function EventHooksPanel({ mounts }: { mounts: Mount[] }) {
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: ['event-hooks'], queryFn: api.eventHooks });
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (kind: string, fn: () => Promise<string | void>) => {
    setBusy(kind);
    setStatus(null);
    try {
      const text = await fn();
      if (text) setStatus({ ok: true, text });
      void qc.invalidateQueries({ queryKey: ['event-hooks'] });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  if (!hooks.data) return hooks.isError ? <FormError>{errorText(hooks.error)}</FormError> : <Spinner />;
  const userName = (id: string) => users.data?.find((u) => u.id === id)?.displayName ?? '?';
  const scope = (h: EventHook) => {
    const m = h.mountId ? (mounts.find((x) => x.id === h.mountId)?.name ?? '?') : t('alle Quellen');
    return h.path ? `${m}: ${h.path}` : m;
  };
  return (
    <div className="max-w-3xl space-y-4 text-sm">
      <p className="text-fg-muted">
        {t('Schickt Änderungen sofort an ein anderes System – etwa einen Agenten, der auf Antworten in einer Notiz wartet. Jede Lieferung ist mit dem Geheimnis signiert (Kopfzeile X-Kaveyl-Signature: sha256=…); der Empfänger prüft sie. Es geht nur hinaus, was die gewählte Person lesen darf.')}
      </p>
      {secret && (
        <div className="space-y-1 rounded-lg border border-accent bg-accent-soft p-3" role="status">
          <p className="font-medium">{t('Geheimnis für „{name}“ – wird nur jetzt angezeigt:', { name: secret.name })}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1 text-xs" aria-label={t('Geheimnis')}>
              {secret.value}
            </code>
            <Button size="sm" onClick={() => void copyWithToast(secret.value, t('Geheimnis'))}>
              <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
            </Button>
          </div>
        </div>
      )}
      {!adding && (
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> {t('Neuer Ereignis-Webhook')}
        </Button>
      )}
      {adding && (
        <HookForm
          mounts={mounts}
          users={(users.data ?? []).filter((u) => !u.disabled)}
          onCancel={() => setAdding(false)}
          onCreated={(name, value) => {
            setAdding(false);
            setSecret({ name, value });
            void qc.invalidateQueries({ queryKey: ['event-hooks'] });
          }}
        />
      )}
      {!hooks.data.length ? (
        <p className="text-fg-faint">{t('Noch keine Ereignis-Webhooks.')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Ereignis-Webhooks')}>
          {hooks.data.map((h) => (
            <li key={h.id} className="space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cx('font-medium', !h.active && 'text-fg-faint line-through')}>{h.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{h.url}</span>
                {!h.active && <span className="rounded bg-muted px-1.5 text-xs text-warn">{t('aus')}</span>}
              </div>
              <p className="text-xs text-fg-muted">
                {t('Rechte von {person} · {scope}{own}', { person: userName(h.userId), scope: scope(h), own: h.includeOwn ? ` · ${t('mit eigenen Änderungen')}` : '' })}
                {h.lastAt && ` · ${t('zuletzt {status}', { status: h.lastStatus ?? '' })}${h.failures ? ` (${t('{n}× fehlgeschlagen', { n: h.failures })})` : ''}`}
              </p>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(`test:${h.id}`, async () => t('Test: {status}', { status: (await api.testEventHook(h.id)).status }))}>
                  {busy === `test:${h.id}` ? <Spinner /> : <Send className="h-3.5 w-3.5" />} {t('Testen')}
                </Button>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(`toggle:${h.id}`, async () => void (await api.updateEventHook(h.id, { active: !h.active })))}>
                  {h.active ? t('Ausschalten') : t('Einschalten')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() =>
                    void run(`secret:${h.id}`, async () => {
                      if (!(await confirmDialog(t('Neues Geheimnis für „{name}“? Der Empfänger braucht es danach, das alte gilt nicht mehr.', { name: h.name }), { confirmLabel: t('Neues Geheimnis') }))) return;
                      setSecret({ name: h.name, value: (await api.eventHookSecret(h.id)).secret });
                    })
                  }
                >
                  <KeyRound className="h-3.5 w-3.5" /> {t('Neues Geheimnis')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() =>
                    void run(`del:${h.id}`, async () => {
                      if (!(await confirmDialog(t('Ereignis-Webhook „{name}“ löschen?', { name: h.name }), { confirmLabel: t('Löschen'), danger: true }))) return;
                      await api.deleteEventHook(h.id);
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" /> {t('Löschen')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p className={status.ok ? 'text-ok' : 'text-danger'} role="status">
          {status.text}
        </p>
      )}
    </div>
  );
}

function HookForm({ mounts, users, onCancel, onCreated }: { mounts: Mount[]; users: { id: string; displayName: string; username: string }[]; onCancel: () => void; onCreated: (name: string, secret: string) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [userId, setUserId] = useState(users[0]?.id ?? '');
  const [mountId, setMountId] = useState('');
  const [path, setPath] = useState('');
  const [includeOwn, setIncludeOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createEventHook({ name, url, userId, mountId: mountId || null, path, includeOwn });
      onCreated(r.hook.name, r.secret);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-y-3 rounded-lg border border-line p-3" aria-label={t('Neuer Ereignis-Webhook')} onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('z. B. Server-Agent')} required autoFocus />
        </Field>
        <Field label={t('Adresse des Empfängers')} hint={t('http:// oder https://; Weiterleitungen werden nicht befolgt.')}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://agent.example.org/kaveyl" required />
        </Field>
        <Field label={t('Mit den Rechten von')} hint={t('Nur was diese Person lesen darf, geht hinaus – meist das Konto des Agenten.')}>
          {(a) => (
            <select {...a} className="h-9 w-full rounded-md border border-line bg-bg px-2" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.username}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('Quelle')}>
          {(a) => (
            <select {...a} className="h-9 w-full rounded-md border border-line bg-bg px-2" value={mountId} onChange={(e) => setMountId(e.target.value)}>
              <option value="">{t('alle Quellen')}</option>
              {mounts.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('Nur dieser Ordner oder diese Notiz (optional)')}>
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('z. B. Vorfälle')} />
        </Field>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={includeOwn} onChange={(e) => setIncludeOwn(e.target.checked)} /> {t('Auch Änderungen dieser Person selbst schicken (sonst hört ein Agent seine eigenen nicht)')}
      </label>
      {error && <FormError>{error}</FormError>}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy || !name || !url || !userId}>
          {busy && <Spinner />} {t('Anlegen')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('Abbrechen')}
        </Button>
      </div>
    </form>
  );
}
