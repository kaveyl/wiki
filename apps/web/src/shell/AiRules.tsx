// Sidebar overview „KI-Freigaben“ (admins): every release rule at a glance, a click shows the
// place in the tree, the context menu edits or removes the rule. Hidden while there are none.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LocateFixed, Pencil, Sparkles, Trash2 } from 'lucide-react';
import { api, errorText, type AiRule, type Mount } from '../api';
import { collator, t } from '../i18n';
import { invalidateAiRules, ruleState, ruleText, STATE_SHORT, useAiRules, useProviderKinds, type ProviderKinds, type RuleState } from '../ai/rules';
import { nodeKey, useWorkspace } from '../store';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger, cx } from '../ui';
import { toast } from '../toast';
import { noteNameIn } from '../names';
import { useActions } from './actions';
import { Section, unfoldSection } from './Personal';
import { EntryIcon, MountIcon } from './Tree';

// „nur eigenes Netz“ only appears while such rules exist (AD-031); it also lists the ineffective ones.
type Filter = 'all' | 'released' | 'local' | 'blocked';
// Short labels: the sidebar is narrow, the title must stay readable; the rows use the full words.
const FILTERS: [Filter, string, string][] = [
  ['all', t('alle'), t('alle Regeln')],
  ['released', t('aktiv'), t('freigegeben')],
  ['local', t('lokal'), t('nur für KI im eigenen Netz (auch die, die derzeit nicht wirken)')],
  ['blocked', t('gesperrt'), t('nicht freigegeben')],
];
const matches = (f: Filter, st: RuleState) => f === 'all' || (f === 'local' ? st === 'local' || st === 'ineffective' : st === f);
const TONE: Record<RuleState, string> = { released: 'text-fg-faint', local: 'text-fg-faint', ineffective: 'text-warn', blocked: 'text-danger' };

function RuleRow({ rule, mount, kinds }: { rule: AiRule; mount: Mount | undefined; kinds: ProviderKinds }) {
  const qc = useQueryClient();
  const openAction = useActions((s) => s.open);
  // Note moved away/deleted, or the source is gone: the rule applies nowhere.
  const orphan = !!rule.orphan || !mount;
  const name = rule.target === 'mount' ? (mount?.name ?? t('Unbekannte Quelle')) : noteNameIn(rule.mountId, rule.path);
  const show = () => {
    if (orphan) return;
    if (rule.target === 'note') return useWorkspace.getState().openNote(rule.mountId, rule.path, name);
    useWorkspace.getState().revealInTree(rule.mountId, rule.path);
    useWorkspace.getState().toggle(nodeKey(rule.mountId, rule.path), true);
  };
  const remove = async () => {
    try {
      await api.removeAiRule(rule.id);
      await invalidateAiRules(qc);
      toast({ kind: 'ok', title: t('KI-Freigabe für „{name}“ entfernt', { name }) });
    } catch (e) {
      toast({ kind: 'error', title: t('Entfernen nicht möglich'), text: errorText(e) });
    }
  };
  return (
    <ContextMenu>
      <ContextTrigger asChild>
        <div
          role="listitem"
          className={cx('flex min-h-7 cursor-default items-center gap-1.5 rounded-md pl-6 pr-1 text-tree hover:bg-hover', orphan && 'text-fg-faint')}
          title={`${mount?.name ?? '?'}${rule.target === 'mount' ? '' : ` / ${rule.path}`} — ${orphan ? t('verwaist') : ruleText(rule, kinds)}`}
          onClick={show}
        >
          {rule.target === 'mount' && mount ? <MountIcon mount={mount} /> : <EntryIcon icon={null} isDir={rule.target !== 'note'} />}
          <span className="flex-1 truncate">
            {name}
            {rule.target !== 'mount' && mount && <span className="text-fg-faint"> ({mount.name})</span>}
          </span>
          {orphan ? (
            <span className="text-[0.6875rem]">{t('verwaist')}</span>
          ) : (
            <span className={cx('shrink-0 text-[0.6875rem]', TONE[ruleState(rule, kinds)])}>{STATE_SHORT[ruleState(rule, kinds)]}</span>
          )}
        </div>
      </ContextTrigger>
      <ContextContent>
        {!orphan && (
          <>
            <ContextItem
              icon={<Pencil />}
              onSelect={() => openAction({ kind: 'ai-rule', mountId: rule.mountId, target: rule.target, path: rule.path, title: name })}
            >
              {t('Freigabe bearbeiten …')}
            </ContextItem>
            <ContextItem icon={<LocateFixed />} onSelect={() => useWorkspace.getState().revealInTree(rule.mountId, rule.path)}>
              {t('Im Baum anzeigen')}
            </ContextItem>
            <ContextSeparator />
          </>
        )}
        <ContextItem icon={<Trash2 />} danger onSelect={() => void remove()}>
          {t('Freigabe entfernen')}
        </ContextItem>
      </ContextContent>
    </ContextMenu>
  );
}

export function AiRulesSection({ mounts }: { mounts: Mount[] }) {
  const rules = useAiRules(true);
  const kinds = useProviderKinds();
  const [filter, setFilter] = useState<Filter>('all');
  const all = rules.data ?? [];
  const state = (r: AiRule) => ruleState(r, kinds);
  const filters = FILTERS.filter(([f]) => f !== 'local' || all.some((r) => matches('local', state(r))));
  // „lokal“ disappears with its last rule: then show everything instead of an invisible filter.
  const active: Filter = filters.some(([f]) => f === filter) ? filter : 'all';
  if (all.length === 0) return null;
  // Order of the sources in the tree, the source itself first, then by path.
  const rank = (r: AiRule) => {
    const i = mounts.findIndex((m) => m.id === r.mountId);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const shown = all
    .filter((r) => matches(active, state(r)))
    .sort((a, b) => rank(a) - rank(b) || (a.target === 'mount' ? -1 : b.target === 'mount' ? 1 : collator.compare(a.path, b.path)));
  return (
    <Section
      id="ai-rules"
      title={t('KI-Freigaben')}
      icon={<Sparkles className="h-3.5 w-3.5" />}
      extra={
        <span className="flex shrink-0 text-[0.6875rem] font-normal" onClick={(e) => e.stopPropagation()}>
          {filters.map(([f, label, hint]) => (
            <button
              key={f}
              title={hint}
              aria-pressed={active === f}
              className={cx('shrink-0 rounded px-0.5', active === f ? 'bg-active text-fg' : 'text-fg-faint hover:text-fg')}
              onClick={() => {
                setFilter(f);
                unfoldSection('ai-rules');
              }}
            >
              {label}
            </button>
          ))}
        </span>
      }
    >
      <div role="list" aria-label={t('KI-Freigaben')}>
        {shown.map((r) => (
          <RuleRow key={r.id} rule={r} mount={mounts.find((m) => m.id === r.mountId)} kinds={kinds} />
        ))}
        {shown.length === 0 && <div className="flex h-7 items-center pl-6 text-xs text-fg-faint">{t('Keine passende Freigabe')}</div>}
      </div>
    </Section>
  );
}
