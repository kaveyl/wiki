// Release rules for the AI (AD-011) outside the dialog: one shared query for the sidebar
// overview „KI-Freigaben“ and the ✦ in the tree (admins only).
import { useQuery, type QueryClient } from '@tanstack/react-query';
import * as DM from '@radix-ui/react-dropdown-menu';
import { MessageCircleQuestion, Settings2, Sparkles } from 'lucide-react';
import { api, type AiLevel, type AiRule, type AiScope } from '../api';
import { DropdownContent, cx } from '../ui';
import { t } from '../i18n';
import { useAi } from './aiStore';

/** Names of the set-up AI providers, split by where the notes go (cloud is derived, AD-028). */
export interface ProviderKinds {
  local: string[];
  cloud: string[];
  /** The provider list has arrived (before that both lists are empty, not „no providers“). */
  loaded?: boolean;
}

export function useProviderKinds(): ProviderKinds {
  const q = useQuery({ queryKey: ['ai-providers'], queryFn: api.aiProviders, staleTime: 60_000 });
  const list = q.data?.providers ?? [];
  return { local: list.filter((p) => !p.cloud).map((p) => p.name), cloud: list.filter((p) => p.cloud).map((p) => p.name), loaded: q.isSuccess };
}

export type RuleState = 'released' | 'local' | 'ineffective' | 'blocked';

/**
 * What a release means with the providers actually set up (AD-031): the cloud flag only matters
 * when cloud providers exist — then a release without it reaches only providers in the own network,
 * and with none of those it reaches nobody.
 */
export function ruleState(r: { level: AiLevel; cloud: boolean }, kinds: ProviderKinds): RuleState {
  if (r.level === 'none') return 'blocked';
  if (r.cloud || !kinds.cloud.length) return 'released';
  return kinds.local.length ? 'local' : 'ineffective';
}

export const STATE_SHORT: Record<RuleState, string> = {
  released: t('freigegeben'),
  local: t('nur eigenes Netz'),
  ineffective: t('wirkt nicht'),
  blocked: t('nicht freigegeben'),
};

/** One sentence for tooltips and the dialog. */
export function stateText(r: { level: AiLevel; cloud: boolean }, kinds: ProviderKinds): string {
  const state = ruleState(r, kinds);
  const readOnly = r.level === 'read';
  const vars = { local: kinds.local.join(', '), cloud: kinds.cloud.join(', ') };
  if (state === 'blocked') return t('nicht freigegeben');
  if (state === 'local')
    return readOnly
      ? t('freigegeben (nur lesen), nur für KI im eigenen Netz ({local}) – nie an {cloud}', vars)
      : t('freigegeben, nur für KI im eigenen Netz ({local}) – nie an {cloud}', vars);
  if (state === 'ineffective')
    return t('nur für KI im eigenen Netz freigegeben – du hast keine eingerichtet, {cloud} sieht das nicht (wirkt wie nicht freigegeben)', vars);
  return readOnly ? t('freigegeben (nur lesen)') : t('freigegeben');
}

export const ruleText = (r: AiRule, kinds: ProviderKinds) => t('KI-Freigabe: {state}', { state: stateText(r, kinds) });

/** All rules of all sources, incl. orphaned ones (`GET /api/ai/rules`). */
export const useAiRules = (enabled: boolean) => useQuery({ queryKey: ['ai-rules'], queryFn: api.aiRules, enabled, staleTime: 30_000 });

/** After a rule changed: the overview, the ✦ in the tree, the dialog and what the assistant may do. */
export const invalidateAiRules = (qc: QueryClient) =>
  Promise.all([qc.invalidateQueries({ queryKey: ['ai-rules'] }), qc.invalidateQueries({ queryKey: ['ai-rule'] }), qc.invalidateQueries({ queryKey: ['ai-status'] })]);


const itemClass = 'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-fg outline-none data-[highlighted]:bg-hover';

/**
 * ✦ next to a source, folder or note with its own rule (like the lock of encrypted folders).
 * A click offers „KI fragen …“ about exactly this place, and editing the release.
 */
export function AiMark({ rule, scope, onEdit }: { rule: AiRule; scope: AiScope; onEdit?: () => void }) {
  const kinds = useProviderKinds();
  const text = ruleText(rule, kinds);
  const state = ruleState(rule, kinds);
  const blocked = rule.level === 'none';
  if (blocked && !onEdit)
    return (
      <span title={text} role="img" aria-label={text} className="flex shrink-0">
        <Sparkles className="h-3 w-3 text-danger" />
      </span>
    );
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button
          title={t('{text} – klicken für KI fragen', { text })}
          aria-label={text}
          className="flex shrink-0 rounded p-0.5 hover:bg-active"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Sparkles className={cx('h-3 w-3', blocked ? 'text-danger' : state === 'ineffective' ? 'text-warn' : 'text-accent')} />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DropdownContent align="start" sideOffset={4} minWidth={190} className="z-50" onClick={(e) => e.stopPropagation()}>
          {!blocked && (
            <DM.Item className={itemClass} onSelect={() => useAi.getState().openAsk(scope)}>
              <MessageCircleQuestion className="h-4 w-4 text-fg-muted" /> {t('KI fragen …')}
            </DM.Item>
          )}
          {onEdit && (
            <DM.Item className={itemClass} onSelect={onEdit}>
              <Settings2 className="h-4 w-4 text-fg-muted" /> {t('KI-Freigabe bearbeiten …')}
            </DM.Item>
          )}
        </DropdownContent>
      </DM.Portal>
    </DM.Root>
  );
}
