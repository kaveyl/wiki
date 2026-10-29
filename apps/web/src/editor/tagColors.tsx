// The menu on every tag (AD-040; right-click, long press on touch): show notes, color, rename/merge.
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Hash, Palette, PenLine } from 'lucide-react';
import { TAG_COLORS, TAG_COLOR_NAMES, tagKey, type TagColor } from '@kaveyl-wiki/core';
import { TAG_DOT } from './tagStyle';
import { api, errorText } from '../api';
import { useSearchPage } from '../shell/Palette';
import { toast } from '../toast';
import { t, tn } from '../i18n';
import { confirmDialog, ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextSub, ContextTrigger, cx, promptDialog } from '../ui';

const searchFor = (tag: string) => `tag:${/\s/.test(tag) ? `"${tag}"` : tag}`;

/** Right-click (long press) menu of a tag; `color`: its current color (checked in the list). */
export function TagMenu({ tag, color, children }: { tag: string; color: TagColor | null; children: ReactNode }) {
  const qc = useQueryClient();
  const openSearch = useSearchPage((s) => s.open);
  const refresh = () => Promise.all(['tags', 'tag-colors', 'note', 'search-full'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const setColor = async (next: TagColor | null) => {
    try {
      const r = await api.setTagColor(tag, next);
      await refresh();
      if (r.skipped.length) toast({ kind: 'warn', title: r.saved.length ? t('Farbe teilweise gespeichert') : t('Farbe nicht gespeichert'), text: t('Keine Schreibrechte in: {sources}', { sources: r.skipped.join(', ') }) });
    } catch (e) {
      toast({ kind: 'error', title: t('Farbe nicht gespeichert'), text: errorText(e) });
    }
  };
  const rename = async () => {
    const all = await qc.fetchQuery({ queryKey: ['tags'], queryFn: api.tags, staleTime: 5_000 });
    const mine = all.find((x) => tagKey(x.tag) === tagKey(tag));
    const to = (
      await promptDialog(t('#{tag} umbenennen', { tag }), {
        label: t('Neuer Name'),
        value: tag,
        suggestions: all.filter((x) => tagKey(x.tag) !== tagKey(tag)).map((x) => x.tag),
        hint: tn(
          mine?.count ?? 0,
          'Ändert {n} Notiz mit #{tag}, die du bearbeiten darfst. Gibt es den neuen Namen schon, werden beide Tags zusammengeführt.',
          'Ändert {n} Notizen mit #{tag}, die du bearbeiten darfst. Gibt es den neuen Namen schon, werden beide Tags zusammengeführt.',
          { tag },
        ),
        confirmLabel: t('Umbenennen'),
        required: true,
      })
    )
      ?.trim()
      .replace(/^#/, '');
    if (!to || to === tag) return;
    const other = all.find((x) => tagKey(x.tag) === tagKey(to) && tagKey(x.tag) !== tagKey(tag));
    if (
      other &&
      !(await confirmDialog(
        tn(
          other.count,
          '#{other} gibt es schon ({n} Notiz). #{tag} damit zusammenführen? Notizen mit beiden Tags behalten es einmal.',
          '#{other} gibt es schon ({n} Notizen). #{tag} damit zusammenführen? Notizen mit beiden Tags behalten es einmal.',
          { other: other.tag, tag },
        ),
        { confirmLabel: t('Zusammenführen') },
      ))
    )
      return;
    try {
      const r = await api.renameTag(tag, other?.tag ?? to);
      await refresh();
      toast({
        kind: r.skipped ? 'warn' : 'ok',
        title: other ? t('#{tag} mit #{other} zusammengeführt', { tag, other: other.tag }) : t('#{tag} heißt jetzt #{to}', { tag, to }),
        text: r.skipped
          ? tn(r.notes, '{n} Notiz geändert, {skipped} ohne Schreibrecht unverändert.', '{n} Notizen geändert, {skipped} ohne Schreibrecht unverändert.', { skipped: r.skipped })
          : tn(r.notes, '{n} Notiz geändert.', '{n} Notizen geändert.'),
      });
    } catch (e) {
      toast({ kind: 'error', title: t('Umbenennen fehlgeschlagen'), text: errorText(e) });
    }
  };
  return (
    <ContextMenu>
      <ContextTrigger asChild>{children}</ContextTrigger>
      <ContextContent>
        <ContextItem icon={<Hash />} onSelect={() => openSearch(searchFor(tag))}>
          {t('Notizen mit #{tag} zeigen', { tag })}
        </ContextItem>
        <ContextSub icon={<Palette />} label={t('Farbe')}>
          {TAG_COLORS.map((c) => (
            <ContextItem key={c} icon={<span className={cx('h-3 w-3 rounded-full', TAG_DOT[c])} />} onSelect={() => void setColor(c)}>
              <span className="flex items-center justify-between gap-3">
                {t(TAG_COLOR_NAMES[c])} {color === c && <Check className="h-3.5 w-3.5 text-fg-muted" />}
              </span>
            </ContextItem>
          ))}
          <ContextSeparator />
          <ContextItem icon={<span className="h-3 w-3 rounded-full border border-fg-faint" />} onSelect={() => void setColor(null)}>
            <span className="flex items-center justify-between gap-3">
              {t('Keine Farbe')} {!color && <Check className="h-3.5 w-3.5 text-fg-muted" />}
            </span>
          </ContextItem>
        </ContextSub>
        <ContextSeparator />
        <ContextItem icon={<PenLine />} onSelect={() => void rename()}>
          {t('Umbenennen / zusammenführen …')}
        </ContextItem>
      </ContextContent>
    </ContextMenu>
  );
}
