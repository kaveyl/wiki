// „KI-Freigabe …“ on a source, folder or note (admins, AD-011, AD-031): released or not, plus what
// applies without an own rule (inherited, and from where). „Only the own network“ is offered only
// where it changes something — when local and cloud providers are both set up. On a source also
// its AI memory in `.kaveyl-wiki/ai/` (instructions, confirmed entries; AD-026).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText, type AclTarget } from '../api';
import { Button, Modal, Rich, Spinner, FormError } from '../ui';
import { toast } from '../toast';
import { t } from '../i18n';
import { invalidateAiRules, ruleState, stateText, useProviderKinds } from './rules';

type Choice = 'inherit' | 'released' | 'local' | 'blocked';

const list = (names: string[]) => names.join(', ');


function Option({ value, choice, set, label, children }: { value: Choice; choice: Choice; set: (c: Choice) => void; label: string; children?: ReactNode }) {
  const id = useId();
  return (
    <label className="flex items-start gap-2">
      <input type="radio" name="ai-release" className="mt-1" aria-label={label} aria-describedby={id} checked={choice === value} onChange={() => set(value)} />
      <span>
        {label}
        <span id={id} className="block text-xs text-fg-muted">
          {children}
        </span>
      </span>
    </label>
  );
}

export function AiRuleDialog({ mountId, target, path, title, onClose }: { mountId: string; target: AclTarget; path: string; title: string; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['ai-rule', mountId, target, path];
  const data = useQuery({ queryKey: key, queryFn: () => api.aiRule(mountId, target, path) });
  const kinds = useProviderKinds();
  const both = kinds.local.length > 0 && kinds.cloud.length > 0;
  const [choice, setChoice] = useState<Choice>('inherit');
  const [error, setError] = useState<string | null>(null);
  const rule = data.data?.rule ?? null;
  // Preselect once, when rule and providers are both there — later refetches never overwrite the admin's pick.
  const initialised = useRef(false);
  useEffect(() => {
    if (!data.data || !kinds.loaded || initialised.current) return;
    initialised.current = true;
    const r = data.data.rule;
    if (!r) setChoice('inherit');
    else if (r.level === 'none') setChoice('blocked');
    else setChoice(ruleState(r, kinds) === 'released' ? 'released' : 'local');
  }, [data.data, kinds]);
  // An existing „own network only“ rule stays visible even without a local provider (it then does nothing).
  const showLocal = both || (!!rule && rule.level !== 'none' && ruleState(rule, kinds) === 'ineffective');
  const save = async () => {
    setError(null);
    try {
      if (choice === 'inherit') {
        if (rule) await api.removeAiRule(rule.id);
      } else
        await api.setAiRule(mountId, {
          target,
          path,
          level: choice === 'blocked' ? 'none' : 'suggest',
          // Without cloud providers the flag stays off (adding one later sends nothing on its own) —
          // unless the rule already allowed the cloud: saving unchanged must not take that back.
          cloud: choice === 'released' && (kinds.cloud.length > 0 || (rule?.level !== 'none' && !!rule?.cloud)),
        });
      await invalidateAiRules(qc);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const inh = data.data?.inherited;
  const from = inh?.from
    ? inh.from.target === 'mount'
      ? t('von der Quelle')
      : inh.from.target === 'folder'
        ? t('von Ordner „{path}“', { path: inh.from.path })
        : t('von der Notiz')
    : null;
  const inheritedText = !inh || !from ? t('nicht freigegeben (Standard)') : t('{state} ({from})', { state: stateText(inh, kinds), from });
  // A block above wins over any release here (AD-011).
  const blockedAbove = !!inh?.from && inh.level === 'none' && (choice === 'released' || choice === 'local');
  const all = [...kinds.local, ...kinds.cloud];
  return (
    <Modal help="ki-freigaben" open onOpenChange={(o) => !o && onClose()} title={t('KI-Freigabe: {title}', { title })} trackInput>
      <div className="space-y-3 text-sm">
        <p className="text-fg-muted">
          {target === 'mount'
            ? t('Darf der KI-Assistent diese Quelle (und alles darin) verwenden?')
            : target === 'folder'
              ? t('Darf der KI-Assistent diesen Ordner (und alles darin) verwenden?')
              : t('Darf der KI-Assistent diese Notiz verwenden?')}{' '}
          {t('Ohne Freigabe sieht er nichts.')}{' '}
          <Rich text={t('Verschlüsselte Notizen und {code} im Frontmatter bleiben immer tabu.')} parts={{ code: <code>ai: false</code> }} />
        </p>
        {data.isPending || !kinds.loaded ? (
          <Spinner />
        ) : (
          <fieldset className="space-y-2" aria-label={t('KI-Freigabe')}>
            <Option value="inherit" choice={choice} set={setChoice} label={target === 'mount' ? t('Keine Regel') : t('Wie darüber')}>
              {t('derzeit: {state}', { state: inheritedText })}
            </Option>
            <Option value="released" choice={choice} set={setChoice} label={t('Freigegeben')}>
              {t('Die KI darf die Inhalte lesen (Fragen, Zusammenfassen) und Änderungen vorschlagen – übernommen wird nur, was du bestätigst.')}{' '}
              {all.length === 0
                ? t('Noch kein KI-Anbieter eingerichtet (Einstellungen → KI).')
                : kinds.cloud.length === 0
                  ? t('Die Inhalte bleiben im eigenen Netz ({local}).', { local: list(kinds.local) })
                  : t('Die Inhalte gehen dafür an: {all}.', { all: list(all) })}
            </Option>
            {showLocal && (
              <Option value="local" choice={choice} set={setChoice} label={t('Freigegeben – nur für KI im eigenen Netz')}>
                {kinds.local.length
                  ? t('Nur {local} sieht die Inhalte, nie {cloud}.', { local: list(kinds.local), cloud: list(kinds.cloud) })
                  : t('Du hast keine KI im eigenen Netz eingerichtet – {cloud} sieht diese Inhalte nicht, die Freigabe wirkt derzeit nicht.', { cloud: list(kinds.cloud) })}
              </Option>
            )}
            <Option value="blocked" choice={choice} set={setChoice} label={target === 'mount' ? t('Nicht freigegeben') : t('Nicht freigegeben (Ausnahme)')}>
              {target === 'mount' ? t('Sperrt die ganze Quelle, auch wenn darin etwas freigegeben ist.') : t('Sperrt hier, auch wenn darüber etwas freigegeben ist.')}
            </Option>
          </fieldset>
        )}
        {choice === 'local' && !kinds.local.length && (
          <p className="text-xs text-warn">{t('Diese Freigabe wirkt derzeit nicht. Wähle „Freigegeben“, damit {cloud} die Inhalte sieht.', { cloud: list(kinds.cloud) })}</p>
        )}
        {blockedAbove && <p className="text-xs text-warn">{t('Darüber ist die KI gesperrt ({from}) – eine Sperre gewinnt immer, die Freigabe hier wirkt nicht.', { from: from ?? '' })}</p>}
        <FormError>{error}</FormError>
        {target === 'mount' && <MemoryPanel mountId={mountId} />}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('Abbrechen')}
          </Button>
          <Button size="sm" variant="primary" disabled={!data.data || !kinds.loaded} onClick={() => void save()}>
            {t('Speichern')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Instructions and memory of a source (`.kaveyl-wiki/ai/`), versioned with it. */
function MemoryPanel({ mountId }: { mountId: string }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['ai-memory', mountId], queryFn: () => api.aiMemory(mountId) });
  const [instructions, setInstructions] = useState<string | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (data.isPending) return <Spinner />;
  if (!data.data) return null;
  if (!data.data.enabled) return <p className="text-xs text-fg-muted">{t('KI-Gedächtnis ist für diese Quelle abgeschaltet (Quelle bearbeiten → „KI-Gedächtnis“).')}</p>;
  const save = async () => {
    setBusy(true);
    try {
      await api.saveAiMemory(mountId, { ...(instructions !== null ? { instructions } : {}), ...(memory !== null ? { memory } : {}) });
      await qc.invalidateQueries({ queryKey: ['ai-memory', mountId] });
      setInstructions(null);
      setMemory(null);
      toast({ kind: 'ok', title: t('KI-Gedächtnis gespeichert') });
    } catch (e) {
      toast({ kind: 'error', title: t('Nicht gespeichert'), text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="rounded-lg border border-line p-2" open={!!data.data.instructions || !!data.data.memory}>
      <summary className="cursor-pointer font-medium">{t('KI-Gedächtnis dieser Quelle')}</summary>
      <p className="mt-1 text-xs text-fg-muted">
        <Rich
          text={t(
            'Liegt als Markdown in {code} der Quelle (mit ihr versioniert, auch für Claude Code und Hermes lesbar) und geht bei jeder KI-Anfrage zu dieser Quelle mit, solange die Quelle selbst freigegeben ist.',
          )}
         parts={{ code: <code>.kaveyl-wiki/ai/</code> }} />
      </p>
      <label className="mt-2 block text-xs font-medium">
        {t('Anweisungen (anweisungen.md)')}
        <textarea
          className="mt-1 min-h-20 w-full rounded-md border border-line bg-bg p-2 font-normal"
          aria-label={t('Anweisungen für die KI')}
          placeholder={t('z. B. „Fachbegriffe auf Englisch lassen. Neue Notizen immer mit Datum im Titel.“')}
          value={instructions ?? data.data.instructions ?? ''}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <label className="mt-2 block text-xs font-medium">
        {t('Gedächtnis (gedaechtnis.md) – neue Einträge schlägt die KI vor, du bestätigst sie')}
        <textarea
          className="mt-1 min-h-20 w-full rounded-md border border-line bg-bg p-2 font-mono font-normal"
          aria-label={t('Gedächtnis der KI')}
          value={memory ?? data.data.memory ?? ''}
          onChange={(e) => setMemory(e.target.value)}
        />
      </label>
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={busy || (instructions === null && memory === null)} onClick={() => void save()}>
          {t('Gedächtnis speichern')}
        </Button>
      </div>
    </details>
  );
}
