// Tags of a note (frontmatter `tags:`, Wiki.js-compatible): chips above the text, add with
// autocomplete, remove with ×; a click on a tag opens the search page filtered by it. Colors and
// renaming: right-click / long press on a tag (`tagColors.tsx`, AD-040).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as DM from '@radix-ui/react-dropdown-menu';
import { Check, Hash, Palette, Plus, Search, Trash2, X } from 'lucide-react';
import { TAG_COLORS, TAG_COLOR_NAMES, type TagColor } from '@kaveyl-wiki/core';
import { api } from '../api';
import { useSearchPage } from '../shell/Palette';
import { Button, ComboInput, DropdownContent, MENU_ITEM, MENU_SEP, cx } from '../ui';
import { TagMenu, useTagActions } from './tagColors';
import { TAG_DOT, tagChipClass, useTagColors } from './tagStyle';
import { lang, t, tn } from '../i18n';

/** „Bearbeitet heute, 20:38“ / „Bearbeitet gestern, …“ / „Bearbeitet 14. Nov., …“ (redesign 24.11.). */
export function editedText(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return t('Bearbeitet heute, {time}', { time });
  if (diff === 1) return t('Bearbeitet gestern, {time}', { time });
  const date = d.toLocaleDateString(lang, d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return t('Bearbeitet {date}, {time}', { date, time });
}

export function TagBar({ mountId, tags, readonly, edited, onChange }: { mountId: string; tags: string[]; readonly: boolean; edited?: number | null; onChange: (tags: string[]) => Promise<void> }) {
  const colorOf = useTagColors();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const all = useQuery({ queryKey: ['tags'], queryFn: api.tags, enabled: adding, staleTime: 30_000 });
  const openSearch = useSearchPage((s) => s.open);
  // A picked suggestion is added right away (its text is not in `value` yet).
  const add = async (raw = value) => {
    const name = raw.trim().replace(/^#/, '');
    setValue('');
    setAdding(false);
    if (name && !tags.some((x) => x.toLowerCase() === name.toLowerCase())) await onChange([...tags, name]);
  };
  if (!tags.length && readonly && !edited) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label={t('Tags')}>
      {tags.map((tag) => (
        <TagMenu key={tag} tag={tag} color={colorOf(mountId, tag)}>
        <span className={cx('group relative flex items-center rounded-full px-2.5 text-xs font-medium [@media(hover:none)]:pr-1', tagChipClass(colorOf(mountId, tag)))} data-tag-color={colorOf(mountId, tag) ?? ''}>
          <button className="flex items-center gap-0.5 py-1 hover:brightness-90" onClick={() => openSearch(`tag:${/\s/.test(tag) ? `"${tag}"` : tag}`)} title={t('Alle Notizen mit #{tag}', { tag })}>
            <Hash className="h-3 w-3" />
            {tag}
          </button>
          {!readonly && (
            // 24×24 px target (WCAG 2.5.8); negative margins keep the chip at its size, full chip color for contrast.
            // The × shows on hover/focus (design: plain chips); on touch always.
            // With a mouse it lies over the end of the chip (no gap while hidden); on touch it stands next to the name.
            <button className="group/x -my-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-inherit opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:absolute [@media(hover:hover)]:right-0 [@media(hover:hover)]:top-1/2 [@media(hover:hover)]:-translate-y-1/2 [@media(hover:none)]:-mr-1 [@media(hover:none)]:opacity-100" aria-label={t('Tag {tag} entfernen', { tag })} onClick={() => void onChange(tags.filter((x) => x !== tag))}>
              <span className="rounded-full p-0.5 group-hover/x:bg-active">
                <X className="h-3 w-3" />
              </span>
            </button>
          )}
        </span>
        </TagMenu>
      ))}
      {!readonly &&
        (adding ? (
          <ComboInput
            autoFocus
            compact
            value={value}
            options={all.data?.filter((x) => !tags.includes(x.tag)).map((x) => x.tag) ?? []}
            onValueChange={setValue}
            onPick={(tag) => void add(tag)}
            onBlur={() => void add()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              } else if (e.key === 'Escape') {
                setValue('');
                setAdding(false);
              }
            }}
            placeholder={t('Tag')}
            aria-label={t('Neuer Tag')}
            className="h-6 w-32 rounded-full border border-line bg-bg px-2 text-xs outline-none focus:border-accent"
          />
        ) : (
          // On touch 32 px high (design-013); the negative margins keep the row at chip height.
          <button className={cx('flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-fg-faint hover:bg-hover hover:text-fg-muted [@media(hover:none)]:-my-1.5 [@media(hover:none)]:min-h-8')} onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3" /> {t('Tag')}
          </button>
        ))}
      {!!edited && <span className="ml-1 text-xs text-fg-faint">{editedText(edited)}</span>}
    </div>
  );
}

/** All tags with counts; a click opens the search page for that tag. */
export function TagBrowser({ onPick }: { onPick: (tag: string) => void }) {
  // Fresh on every opening: tags of notes changed outside the app (Git, editor) show at once.
  const all = useQuery({ queryKey: ['tags'], queryFn: api.tags, staleTime: 0 });
  const [filter, setFilter] = useState('');
  // The tag picked in the grid (draft: framed tile, its actions in the bar below); a double click shows its notes.
  const [picked, setPicked] = useState<string | null>(null);
  const list = (all.data ?? []).filter((x) => x.tag.toLowerCase().includes(filter.toLowerCase()));
  const current = list.find((x) => x.tag === picked) ?? null;
  return (
    <div className="space-y-4">
      <p className="-mt-1 text-sm text-fg-muted">{t('Farben anpassen, umbenennen oder doppelte Tags zusammenführen.')}</p>
      <label className="flex h-10 w-full items-center gap-2 rounded-xl border border-line-control bg-bg px-3 focus-within:border-accent sm:max-w-[420px]">
        <Search className="h-4 w-4 shrink-0 text-icon-faint" aria-hidden />
        <input autoFocus data-autofocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Tags filtern …')} aria-label={t('Tags filtern')} className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      {all.data && !list.length && <p className="text-sm text-fg-muted">{t('Keine Tags. Tags stehen im Frontmatter (`tags:`) oder werden über „+ Tag“ oben in einer Notiz vergeben.')}</p>}
      {/* A grid of tags (redesign 23.11.): the colour as a dot, the number of notes on the right. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
        {list.map((x) => (
          <TagMenu key={x.tag} tag={x.tag} color={x.color}>
            <button
              className={cx(
                'flex min-h-[48px] min-w-0 items-center gap-2.5 rounded-xl border bg-card px-4 py-3 text-left text-sm',
                x.tag === picked ? 'border-accent ring-1 ring-accent' : 'border-line-soft hover:border-line-control hover:bg-hover',
              )}
              data-tag-color={x.color ?? ''}
              aria-pressed={x.tag === picked}
              onClick={() => setPicked(x.tag)}
              onDoubleClick={() => onPick(x.tag)}
              title={x.mixed ? t('In den Quellen unterschiedlich gefärbt – gezeigt wird die häufigste Farbe') : t('Doppelklick zeigt die Notizen mit #{tag}', { tag: x.tag })}
            >
              <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', x.color ? TAG_DOT[x.color] : 'bg-icon-faint')} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{x.tag}</span>
              <span className="shrink-0 rounded-full border border-line-soft bg-bg px-2 text-xs tabular-nums text-fg-muted">{x.count}</span>
            </button>
          </TagMenu>
        ))}
      </div>
      {current ? (
        <TagActions key={current.tag} tag={current.tag} color={current.color} count={current.count} onShow={() => onPick(current.tag)} />
      ) : (
        !!list.length && <p className="text-xs text-fg-faint">{t('Ein Tag anklicken: Notizen zeigen, Farbe wählen, umbenennen, zusammenführen oder löschen (auch per Rechtsklick).')}</p>
      )}
    </div>
  );
}

/** The bar under the tag list for the picked tag (draft „# Kaveyl-Notes · 12 Seiten  Farbe  Umbenennen  Zusammenführen“). */
function TagActions({ tag, color, count, onShow }: { tag: string; color: TagColor | null; count: number; onShow: () => void }) {
  const { setColor, rename, remove } = useTagActions(tag);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line-soft bg-card px-4 py-3" role="group" aria-label={t('Tag #{tag}', { tag })}>
      <span className={cx('h-3 w-3 shrink-0 rounded-full', color ? TAG_DOT[color] : 'bg-icon-faint')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          <span className="font-semibold"># {tag}</span> <span className="text-fg-muted">· {tn(count, '{n} Notiz', '{n} Notizen')}</span>
        </div>
        <div className="text-xs text-fg-muted">{t('Farbe, Name oder Zusammenführung für alle zugeordneten Notizen ändern – oder den Tag aus allen entfernen')}</div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="primary" onClick={onShow}>
          <Hash className="h-3.5 w-3.5" /> {t('Notizen zeigen')}
        </Button>
        <DM.Root>
          <DM.Trigger asChild>
            <Button size="sm" className="rounded-full">
              <Palette className="h-3.5 w-3.5" /> {t('Farbe')}
            </Button>
          </DM.Trigger>
          <DM.Portal>
            <DropdownContent align="end" sideOffset={6} className="z-[70]">
              {TAG_COLORS.map((c) => (
                <DM.Item key={c} className={MENU_ITEM} onSelect={() => void setColor(c)}>
                  <span className={cx('h-3 w-3 rounded-full', TAG_DOT[c])} aria-hidden />
                  <span className="flex-1">{t(TAG_COLOR_NAMES[c])}</span>
                  {color === c && <Check className="h-3.5 w-3.5 text-fg-muted" />}
                </DM.Item>
              ))}
              <DM.Separator className={MENU_SEP} />
              <DM.Item className={MENU_ITEM} onSelect={() => void setColor(null)}>
                <span className="h-3 w-3 rounded-full border border-fg-faint" aria-hidden />
                <span className="flex-1">{t('Keine Farbe')}</span>
                {!color && <Check className="h-3.5 w-3.5 text-fg-muted" />}
              </DM.Item>
            </DropdownContent>
          </DM.Portal>
        </DM.Root>
        <Button size="sm" className="rounded-full" onClick={() => void rename()}>
          {t('Umbenennen')}
        </Button>
        <Button size="sm" className="rounded-full" onClick={() => void rename(true)}>
          {t('Zusammenführen')}
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full text-danger" onClick={() => void remove()}>
          <Trash2 className="h-3.5 w-3.5" /> {t('Löschen')}
        </Button>
      </div>
    </div>
  );
}
