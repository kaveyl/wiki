// Settings → KI: providers (admins) and the personal choice / instructions (everyone).
// API keys are only ever sent to the server, never shown again (AD-024).
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Trash2 } from 'lucide-react';
import { RuleRow } from '../shell/Cleanup';
import { api, errorText, type AiEffort, type AiProvider, type AiProviderKind } from '../api';
import { Button, ComboInput, Field, Input, Spinner, cx, useModalDirty, confirmDialog, Rich, FormError } from '../ui';
import { toast } from '../toast';
import { t } from '../i18n';

const KIND_LABEL: Record<AiProviderKind, string> = {
  ollama: t('Ollama (lokal)'),
  'ollama-cloud': 'Ollama Cloud (ollama.com)',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: t('OpenAI-kompatibel (Azure, LM Studio, vLLM …)'),
};
const DEFAULTS: Record<AiProviderKind, { baseUrl: string; model: string; cloud: boolean }> = {
  ollama: { baseUrl: 'http://ollama:11434', model: 'llama3.1', cloud: false },
  'ollama-cloud': { baseUrl: 'https://ollama.com', model: 'gpt-oss:120b', cloud: true },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', cloud: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-5.5', cloud: true },
  openai: { baseUrl: 'http://localhost:1234', model: '', cloud: false },
};
// Same rules as the server (providers.ts, AD-028): cloud is a fact, derived — not a setting.
function isLocalAddress(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || /\.(localhost|local|internal|lan)$/.test(host) || host === '::1' || /^(f[cd][0-9a-f]{2}|fe80):/.test(host)) return true;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return !host.includes('.');
}
const isCloudModel = (model: string) => /(^|[-:])cloud$/i.test(model.trim());
const ALWAYS_CLOUD: AiProviderKind[] = ['ollama-cloud', 'anthropic', 'openrouter'];
/** Why this provider is a cloud provider, or null when the data stays in the own network. */
function cloudReason(p: { kind: AiProviderKind; baseUrl?: string; model?: string }): string | null {
  const host = (() => {
    try {
      return new URL(p.baseUrl ?? '').hostname;
    } catch {
      return p.baseUrl ?? '';
    }
  })();
  if (ALWAYS_CLOUD.includes(p.kind)) return host ? t('Seiten gehen an {host}', { host }) : t('Seiten gehen an den Anbieter');
  if (!isLocalAddress(p.baseUrl ?? '')) return t('die Adresse {host} liegt im Internet', { host });
  if (p.kind === 'ollama' && isCloudModel(p.model ?? '')) return t('{model} ist ein Cloud-Modell – Ollama leitet es an ollama.com weiter', { model: p.model ?? '' });
  return null;
}



export function AiProvidersPanel() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['ai-providers'], queryFn: api.aiProviders });
  const [edit, setEdit] = useState<ProviderDraft | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ai-providers'] });
  const providers = data.data?.providers ?? [];
  const privateCount = providers.filter((p) => p.private).length;
  return (
    <div className="space-y-4 text-sm">
      <h3 className="font-medium">{t('Für alle: Anbieter und Aufbewahrung')}</h3>
      <p className="text-fg-muted">
        <Rich
          text={t(
            'Die KI sieht zunächst {nothing}: Quellen, Ordner oder Seiten gibst du per Rechtsklick → {menu} frei (lesen oder lesen + vorschlagen, für alle Anbieter oder nur private KI). Jede Anfrage steht im Protokoll (Anbieter, Modell, übertragene Seiten).',
          )}
          parts={{ nothing: <b>{t('nichts')}</b>, menu: <b>{t('KI-Freigabe …')}</b> }}
        />
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('KI-Anbieter')}>
        {providers.map((p) => (
          <li key={p.id} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{p.name}</span>
              <span className="ml-2 text-xs text-fg-faint">
                {KIND_LABEL[p.kind]} · {p.model || t('kein Modell')}
                {p.effort ? ` · ${t('Aufwand: {level}', { level: effortLabel(p.effort) })}` : ''} · {p.cloud ? t('Cloud') : t('lokal')}
                {p.hasKey ? ` · ${t('Key gespeichert')}` : ''}
              </span>
              {p.private && (
                <span className="ml-2 inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-px text-xs text-fg" title={t('Darf Seiten sehen, die nur für private KI freigegeben sind.')}>
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  {t('privat')}
                </span>
              )}
            </span>
            <label className="flex items-center gap-1 text-xs text-fg-muted">
              <input
                type="radio"
                name="ai-default"
                checked={data.data?.defaultId === p.id}
                onChange={() => void api.aiSettings({ defaultId: p.id }).then(refresh)}
              />
              {t('Standard')}
            </label>
            {/* Only when there is a choice (AD-079, AD-031): two or more providers for private notes. */}
            {privateCount > 1 && p.private && (
              <label className="flex items-center gap-1 text-xs text-fg-muted" title={t('Wird für private Seiten genommen, wenn der Benutzer nichts anderes gewählt hat.')}>
                <input
                  type="radio"
                  name="ai-private-default"
                  checked={data.data?.privateDefaultId === p.id}
                  onChange={() => void api.aiSettings({ privateDefaultId: p.id }).then(refresh)}
                />
                {t('Standard privat')}
              </label>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEdit({ ...p })}>
              {t('Bearbeiten')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('{name} entfernen', { name: p.name })}
              onClick={() => {
                void confirmDialog(t('Anbieter „{name}“ entfernen? Der gespeicherte Key wird gelöscht.', { name: p.name }), { confirmLabel: t('Entfernen'), danger: true }).then(
                  (ok) => ok && void api.removeAiProvider(p.id).then(refresh),
                );
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
        {!providers.length && <li className="px-3 py-3 text-fg-muted">{t('Noch kein Anbieter eingerichtet.')}</li>}
      </ul>
      {!edit && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(KIND_LABEL) as AiProviderKind[]).map((k) => (
            <Button key={k} size="sm" onClick={() => setEdit({ kind: k, name: KIND_LABEL[k].split(' (')[0], ...DEFAULTS[k] })}>
              + {KIND_LABEL[k].split(' (')[0]}
            </Button>
          ))}
        </div>
      )}
      {/* One form per provider: without the key React kept the first one's fields when „Bearbeiten“ was clicked on
          another provider – „Speichern“ then wrote the wrong provider (owner 16.11.). */}
      {edit && <ProviderForm key={edit.id ?? `neu-${edit.kind}`} value={edit} onDone={() => (setEdit(null), void refresh())} />}
      <RuleRow
        rule="aiChatDays"
        label={t('Unbenutzte Chats aufbewahren')}
        hint={t('Gilt für alle Benutzer, gezählt ab der letzten Nachricht. Je Quelle abweichend: Quelle bearbeiten → „KI-Chats aufbewahren“.')}
      />
    </div>
  );
}

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'xhigh'];
const hostOf = (url?: string) => {
  try {
    return new URL(url ?? '').host || url || '';
  } catch {
    return url ?? '';
  }
};
const effortLabel = (e: AiEffort) => ({ low: t('Niedrig'), medium: t('Mittel'), high: t('Hoch'), xhigh: t('Sehr hoch') })[e];

type ProviderDraft = Omit<Partial<AiProvider>, 'effort'> & { kind: AiProviderKind; apiKey?: string; effort?: AiEffort | '' };

function ProviderForm({ value, onDone }: { value: ProviderDraft; onDone: () => void }) {
  const [p, setP] = useState<ProviderDraft>(value);
  useModalDirty(JSON.stringify(p) !== JSON.stringify(value));
  const [models, setModels] = useState<string[]>([]);
  // Effort levels the chosen model knows, after „Test connection“ (null = not asked yet → all levels).
  const [efforts, setEfforts] = useState<AiEffort[] | null>(null);
  const [effortNote, setEffortNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const needsKey = p.kind === 'anthropic' || p.kind === 'openrouter' || p.kind === 'ollama-cloud';
  const cloud = cloudReason(p);
  // The tick goes along only when changed here: otherwise the server keeps it – and derives it anew when the
  // address moves the provider into the cloud (or back), so no tick is carried over unnoticed (AD-079).
  const [privTouched, setPrivTouched] = useState(false);
  const privateShown = privTouched ? !!p.private : value.id && !!value.cloud === !!cloud ? (value.private ?? !cloud) : !cloud;
  const privateBody = { private: privTouched ? !!p.private : undefined };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { cloud: _derived, private: _private, ...body } = p;
      const saved = await api.saveAiProvider({ ...body, ...privateBody, apiKey: p.apiKey || undefined, effort: p.effort ?? '' });
      toast({ kind: 'ok', title: t('Anbieter „{name}“ gespeichert', { name: saved.name }) });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const loadModels = async () => {
    if (testing || busy) return;
    setError(null);
    setTesting(true);
    try {
      // Save first (the server talks to the provider with the stored key), then list.
      const { private: _private, ...rest } = p;
      const saved = await api.saveAiProvider({ ...rest, ...privateBody, apiKey: p.apiKey || undefined, effort: p.effort ?? '' });
      const res = await api.aiModels(saved.id);
      const known = res.efforts ?? null;
      // A level the model does not know falls back to the model's default (saved with the next „Save“).
      const keep = !p.effort || !known || known.includes(p.effort);
      setEffortNote(
        res.warning ?? (keep ? null : t('{model} kennt die Stufe „{level}“ nicht – zurück auf „Standard des Modells“.', { model: p.model ?? '', level: effortLabel(p.effort as AiEffort) })),
      );
      // Saved at once: also after „Cancel“ no level stays stored that the model would refuse (diff check 0.2.14).
      if (!keep) await api.saveAiProvider({ id: saved.id, kind: p.kind, effort: '' });
      setP({ ...p, id: saved.id, apiKey: '', effort: keep ? p.effort : '' });
      setModels(res.models);
      setEfforts(known);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTesting(false);
    }
  };
  return (
    <form className="space-y-2 rounded-lg border border-dashed border-line p-3" aria-label={t('KI-Anbieter')} onSubmit={save}>
      <div className="text-xs font-medium text-fg-muted">{KIND_LABEL[p.kind]}</div>
      <Field label={t('Name')}>
        <Input value={p.name ?? ''} onChange={(e) => setP({ ...p, name: e.target.value })} />
      </Field>
      <Field
        label={t('Adresse')}
        hint={
          p.kind === 'ollama'
            ? t('z. B. http://ollama:11434 (Docker) oder http://<Rechner>:11434 – für ollama.com den Typ „Ollama Cloud“ nehmen')
            : p.kind === 'ollama-cloud'
              ? t('https://ollama.com – API-Key unter ollama.com → Settings → Keys anlegen')
              : undefined
        }
      >
        <Input value={p.baseUrl ?? ''} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} />
      </Field>
      <Field label={needsKey ? t('API-Key') : t('API-Key (optional)')} hint={p.hasKey ? t('Gespeichert – leer lassen, um ihn zu behalten.') : undefined}>
        <Input type="password" autoComplete="off" value={p.apiKey ?? ''} onChange={(e) => setP({ ...p, apiKey: e.target.value })} placeholder={p.hasKey ? '••••••••' : ''} />
      </Field>
      <Field label={t('Modell')}>
        {/* Wraps below the field when narrow instead of squeezing the button. */}
        <div className="flex flex-wrap gap-2">
          <ComboInput boxClassName="min-w-48 flex-1" value={p.model ?? ''} options={models} onValueChange={(model) => (setP({ ...p, model }), model !== p.model && (setEfforts(null), setEffortNote(null)))} />
          <Button type="button" className="shrink-0 whitespace-nowrap" disabled={testing || busy} onClick={() => void loadModels()}>
            {testing && <Spinner />} {t('Verbindung testen')}
          </Button>
        </div>
      </Field>
      {models.length > 0 && <p className="text-xs text-ok">{t('Verbunden – {n} Modelle zur Auswahl.', { n: models.length })}</p>}
      {p.kind === 'anthropic' && efforts?.length !== 0 && (
        <Field label={t('Aufwand')} hint={t('Wie gründlich das Modell nachdenkt. Höher hilft bei schwierigen Fragen, dauert aber länger und kostet mehr.')}>
          <select
            className="h-8 w-full rounded-md border border-line bg-bg px-2"
            value={p.effort ?? ''}
            onChange={(e) => (setP({ ...p, effort: e.target.value as AiEffort | '' }), setEffortNote(null))}
          >
            <option value="">{t('Standard des Modells')}</option>
            {EFFORTS.filter((e) => !efforts || efforts.includes(e)).map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {p.kind === 'anthropic' && efforts?.length === 0 && <p className="text-xs text-fg-muted">{t('Dieses Modell hat keine Stufen für den Aufwand.')}</p>}
      {effortNote && <p className="text-xs text-warn">{effortNote}</p>}
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={privateShown} onChange={(e) => (setP({ ...p, private: e.target.checked }), setPrivTouched(true))} />
        <span>
          {t('Für private Seiten zulassen')}
          <span className="block text-xs text-fg-muted">
            {cloud
              ? t('Diese KI sieht dann auch Seiten, die nur für private KI freigegeben sind – sie gehen dafür an {host}. Ob dort nichts gespeichert wird (z. B. Zero Data Retention), kann Kaveyl Wiki nicht prüfen.', { host: hostOf(p.baseUrl) })
              : t('Diese KI sieht dann auch Seiten, die nur für private KI freigegeben sind. Sie läuft im eigenen Netz.')}
          </span>
        </span>
      </label>
      {cloud && (
        <p className="rounded-md bg-accent-soft px-2.5 py-2 text-xs text-fg" role="note">
          ☁ <b>{t('Cloud-Anbieter')}</b> – {t('{reason}. Die KI sieht hier nur, was du per KI-Freigabe ausdrücklich auch für Cloud-Anbieter freigibst.', { reason: cloud })}
        </p>
      )}
      <FormError>{error}</FormError>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy || testing}>
          {t('Speichern')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('Abbrechen')}
        </Button>
      </div>
    </form>
  );
}

/** For every user: which provider, own instructions, delete own chats. */
export function AiPersonalPanel() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['ai-providers'], queryFn: api.aiProviders });
  const mine = useQuery({ queryKey: ['state', 'ai'], queryFn: () => api.getState<{ providerId?: string; privateProviderId?: string; instructions?: string }>('ai') });
  const [instructions, setInstructions] = useState('');
  const [providerId, setProviderId] = useState('');
  const [privateId, setPrivateId] = useState('');
  useEffect(() => {
    setInstructions(mine.data?.instructions ?? '');
    setProviderId(mine.data?.providerId ?? '');
    setPrivateId(mine.data?.privateProviderId ?? '');
  }, [mine.data]);
  // Only own edits count (the effect above copies the saved values in one render later).
  const [touched, setTouched] = useState(false);
  useModalDirty(
    touched &&
      !!mine.data &&
      (instructions !== (mine.data.instructions ?? '') || providerId !== (mine.data.providerId ?? '') || privateId !== (mine.data.privateProviderId ?? '')),
  );
  const save = async () => {
    await api.putState('ai', { providerId: providerId || undefined, privateProviderId: privateId || undefined, instructions: instructions.trim() || undefined });
    await qc.invalidateQueries({ queryKey: ['state', 'ai'] });
    toast({ kind: 'ok', title: t('KI-Einstellungen gespeichert') });
  };
  const list = providers.data?.providers ?? [];
  const privates = list.filter((p) => p.private);
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">{t('Mein KI-Assistent')}</h3>
      {!list.length && <p className="text-fg-muted">{t('Noch kein Anbieter eingerichtet – das macht ein Admin unter Einstellungen → KI.')}</p>}
      {list.length > 0 && (
        <Field label={t('Anbieter')}>
          <select className={cx('h-8 w-full rounded-md border border-line bg-bg px-2')} value={providerId} onChange={(e) => (setProviderId(e.target.value), setTouched(true))} aria-label={t('Mein Anbieter')}>
            <option value="">{t('Standard ({name})', { name: list.find((p) => p.id === providers.data?.defaultId)?.name ?? '–' })}</option>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.cloud ? t('Cloud') : t('lokal')})
              </option>
            ))}
          </select>
        </Field>
      )}
      {/* Only when there is a choice (AD-079): two or more providers may see private notes. */}
      {privates.length > 1 && (
        <Field label={t('Für private Seiten')} hint={t('Seiten, die nur für private KI freigegeben sind, gehen immer an diese KI – egal, welcher Anbieter oben gewählt ist.')}>
          <select className={cx('h-8 w-full rounded-md border border-line bg-bg px-2')} value={privateId} onChange={(e) => (setPrivateId(e.target.value), setTouched(true))} aria-label={t('Meine KI für private Seiten')}>
            <option value="">{t('Standard ({name})', { name: privates.find((p) => p.id === providers.data?.privateDefaultId)?.name ?? '–' })}</option>
            {privates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.cloud ? t('Cloud') : t('lokal')})
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t('Persönliche Anweisungen')} hint={t('Gehen bei jeder Anfrage mit, z. B. „Antworte knapp, duze mich, Fachbegriffe auf Englisch lassen“.')}>
        <textarea className="min-h-20 w-full rounded-md border border-line bg-bg p-2" value={instructions} onChange={(e) => (setInstructions(e.target.value), setTouched(true))} aria-label={t('Persönliche Anweisungen')} />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => void save()}>
          {t('Speichern')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void confirmDialog(t('Alle eigenen KI-Chatverläufe löschen?'), { confirmLabel: t('Löschen'), danger: true }).then(
              (ok) => ok && void api.deleteAiChat('all').then(() => toast({ kind: 'ok', title: t('Chatverläufe gelöscht') })),
            );
          }}
        >
          {t('Meine Chatverläufe löschen')}
        </Button>
      </div>
    </div>
  );
}
