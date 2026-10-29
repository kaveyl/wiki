// Tags of a note (frontmatter `tags:`, Wiki.js-compatible): chips above the text, add with
// autocomplete, remove with ×; a click on a tag opens the search page filtered by it. Colors and
// renaming: right-click / long press on a tag (`tagColors.tsx`, AD-040).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Hash, Plus, X } from 'lucide-react';
import { api } from '../api';
import { useSearchPage } from '../shell/Palette';
import { ComboInput, cx } from '../ui';
import { TagMenu } from './tagColors';
import { tagChipClass, useTagColors } from './tagStyle';
import { t } from '../i18n';

export function TagBar({ mountId, tags, readonly, onChange }: { mountId: string; tags: string[]; readonly: boolean; onChange: (tags: string[]) => Promise<void> }) {
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
  if (!tags.length && readonly) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label={t('Tags')}>
      {tags.map((tag) => (
        <TagMenu key={tag} tag={tag} color={colorOf(mountId, tag)}>
        <span className={cx('group flex items-center rounded-full pl-2 pr-1 text-xs', tagChipClass(colorOf(mountId, tag)))} data-tag-color={colorOf(mountId, tag) ?? ''}>
          <button className="flex items-center gap-0.5 py-0.5 hover:brightness-90" onClick={() => openSearch(`tag:${/\s/.test(tag) ? `"${tag}"` : tag}`)} title={t('Alle Notizen mit #{tag}', { tag })}>
            <Hash className="h-3 w-3" />
            {tag}
          </button>
          {!readonly && (
            // 24×24 px target (WCAG 2.5.8); negative margins keep the chip at its size, full chip color for contrast.
            <button className="group/x -my-0.5 -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" aria-label={t('Tag {tag} entfernen', { tag })} onClick={() => void onChange(tags.filter((x) => x !== tag))}>
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
    </div>
  );
}

/** All tags with counts; a click opens the search page for that tag. */
export function TagBrowser({ onPick }: { onPick: (tag: string) => void }) {
  const all = useQuery({ queryKey: ['tags'], queryFn: api.tags });
  const [filter, setFilter] = useState('');
  const list = (all.data ?? []).filter((x) => x.tag.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-3">
      <input autoFocus data-autofocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Tags filtern …')} aria-label={t('Tags filtern')} className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm outline-none focus:border-accent" />
      {all.data && !list.length && <p className="text-sm text-fg-muted">{t('Keine Tags. Tags stehen im Frontmatter (`tags:`) oder werden über „+ Tag“ oben in einer Notiz vergeben.')}</p>}
      <div className="flex flex-wrap gap-1.5">
        {list.map((x) => (
          <TagMenu key={x.tag} tag={x.tag} color={x.color}>
            <button
              className={cx('flex items-center gap-1 rounded-full px-2.5 py-1 text-sm hover:brightness-95', tagChipClass(x.color))}
              data-tag-color={x.color ?? ''}
              onClick={() => onPick(x.tag)}
              title={x.mixed ? t('In den Quellen unterschiedlich gefärbt – gezeigt wird die häufigste Farbe') : undefined}
            >
              <Hash className="h-3.5 w-3.5 opacity-60" />
              {x.tag}
              <span className="text-xs opacity-70">{x.count}</span>
            </button>
          </TagMenu>
        ))}
      </div>
      {!!list.length && <p className="text-xs text-fg-faint">{t('Rechtsklick (auf dem Handy: lange drücken) auf ein Tag: Farbe wählen, umbenennen oder mit einem anderen zusammenführen.')}</p>}
    </div>
  );
}
