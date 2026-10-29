// Icon picker: Lucide symbols (common set, by category, or searched), emoji, and uploaded
// custom icons. The value format is described in icons.tsx.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Upload, X } from 'lucide-react';
import { api, errorText } from '../api';
import { cx, Spinner, useTabs, FormError } from '../ui';
import { customIconUrl, LUCIDE_ICONS, useAllIcons } from './icons';
import { t, tn } from '../i18n';

const EMOJI = ['📘', '📗', '📕', '📙', '📒', '📝', '📌', '📎', '🗂️', '📁', '🗃️', '📊', '📈', '🗓️', '✅', '⭐', '💡', '🔥', '🚀', '🎯', '🧠', '🛠️', '⚙️', '🔒', '🔑', '🌍', '🏠', '💼', '💰', '🧪', '🐛', '📦', '🖥️', '☁️', '🐳', '🤖', '❤️', '🎵', '📷', '✈️'];

type Tab = 'lucide' | 'emoji' | 'custom';
const TABS: readonly Tab[] = ['lucide', 'emoji', 'custom'];
const tabOf = (value: string | null): Tab => (value?.startsWith('custom:') ? 'custom' : value && !value.startsWith('lucide:') ? 'emoji' : 'lucide');

export function IconPicker({ value, onPick }: { value: string | null; onPick: (icon: string | null) => void }) {
  const [tab, setTab] = useState<Tab>(() => tabOf(value));
  const tabs = useTabs(TABS, tab, setTab);
  return (
    <div className="w-80 space-y-2">
      <div className="flex items-center gap-1 border-b border-line pb-2">
        {/* The row holds only the tabs; „Kein Icon“ is a plain button beside it. */}
        <div className="flex items-center gap-1" {...tabs.list} aria-label={t('Icon-Art')}>
          {(
            [
              ['lucide', t('Symbole')],
              ['emoji', t('Emoji')],
              ['custom', t('Eigene')],
            ] as const
          ).map(([id, label]) => (
            <button key={id} {...tabs.tab(id)} className={cx('rounded px-2 py-1 text-xs', tab === id ? 'bg-active text-fg' : 'text-fg-muted hover:bg-hover')}>
              {label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-hover" onClick={() => onPick(null)}>
          {t('Kein Icon')}
        </button>
      </div>
      <div {...tabs.panel}>
        {tab === 'lucide' && <LucideTab value={value} onPick={onPick} />}
        {tab === 'emoji' && <EmojiTab value={value} onPick={onPick} />}
        {tab === 'custom' && <CustomTab value={value} onPick={onPick} />}
      </div>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid max-h-56 grid-cols-9 content-start gap-0.5 overflow-y-auto">{children}</div>;
}

function Cell({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button title={label} aria-label={label} onClick={onClick} className={cx('flex h-8 w-8 items-center justify-center rounded hover:bg-hover', active && 'bg-active')}>
      {children}
    </button>
  );
}

const COMMON = '__common';

function LucideTab({ value, onPick }: { value: string | null; onPick: (icon: string) => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(COMMON);
  const all = useAllIcons();
  const q = query.trim().toLowerCase();

  // [value name, component] in display order.
  const list = useMemo(() => {
    if (!all || (category === COMMON && !q)) return Object.entries(LUCIDE_ICONS);
    const cat = all.categories.findIndex((c) => c.id === category);
    const titles = all.categories.map((c) => c.title.toLowerCase());
    return Object.entries(all.iconMeta)
      .filter(([name, [cats, tags]]) => {
        if (q) return name.includes(q) || tags.includes(q) || cats.some((c) => titles[c]!.includes(q));
        return category === '' || cats.includes(cat);
      })
      .map(([name]) => [name, all.icons[all.pascal(name) as keyof typeof all.icons]] as const)
      .filter(([, Icon]) => !!Icon);
  }, [all, category, q]);

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-bg px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Suchen (englisch) …')} aria-label={t('Symbol suchen')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" autoFocus data-autofocus />
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('Kategorie')} className="h-7 max-w-[130px] rounded border border-line bg-bg px-1 text-xs" disabled={!!q}>
          <option value={COMMON}>{t('Häufig')}</option>
          <option value="">{t('Alle')}</option>
          {all?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
      {!all && (category !== COMMON || q) ? (
        <div className="flex h-20 items-center justify-center">
          <Spinner />
        </div>
      ) : list.length ? (
        <Grid>
          {list.map(([name, Icon]) => (
            <Cell key={name} label={t('Symbol {name}', { name })} active={value === `lucide:${name}`} onClick={() => onPick(`lucide:${name}`)}>
              <Icon className="h-4 w-4" />
            </Cell>
          ))}
        </Grid>
      ) : (
        <p className="py-4 text-center text-xs text-fg-muted">{t('Kein Symbol gefunden')}</p>
      )}
      {all && <p className="text-[0.6875rem] text-fg-faint">{tn(list.length, '{n} Symbol · Lucide', '{n} Symbole · Lucide')}</p>}
    </div>
  );
}

function EmojiTab({ value, onPick }: { value: string | null; onPick: (icon: string) => void }) {
  const [own, setOwn] = useState('');
  return (
    <div className="space-y-2">
      <Grid>
        {EMOJI.map((e) => (
          <Cell key={e} label={t('Emoji {emoji}', { emoji: e })} active={value === `emoji:${e}`} onClick={() => onPick(`emoji:${e}`)}>
            <span className="text-base">{e}</span>
          </Cell>
        ))}
      </Grid>
      <div className="flex items-center gap-2">
        <input
          value={own}
          onChange={(e) => setOwn(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && own.trim() && onPick(`emoji:${own.trim()}`)}
          placeholder={t('Eigenes Emoji …')}
          aria-label={t('Eigenes Emoji')}
          className="h-7 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-sm"
        />
        <button className="h-7 rounded px-2 text-xs text-fg-muted hover:bg-hover" disabled={!own.trim()} onClick={() => onPick(`emoji:${own.trim()}`)}>
          {t('Setzen')}
        </button>
      </div>
    </div>
  );
}

function CustomTab({ value, onPick }: { value: string | null; onPick: (icon: string) => void }) {
  const qc = useQueryClient();
  const icons = useQuery({ queryKey: ['icons'], queryFn: api.icons });
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, staleTime: Infinity });
  const me = session.data?.user;
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      let last = null;
      for (const f of Array.from(files)) last = await api.uploadIcon(f);
      await qc.invalidateQueries({ queryKey: ['icons'] });
      if (last && files.length === 1) onPick(`custom:${last.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  const remove = async (id: string) => {
    setConfirm(null);
    try {
      await api.deleteIcon(id);
      await qc.invalidateQueries({ queryKey: ['icons'] });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="space-y-2">
      {icons.data?.length ? (
        <Grid>
          {icons.data.map((i) => (
            <div key={i.id} className="group relative">
              <Cell label={t('Eigenes Icon {name}', { name: i.name })} active={value === `custom:${i.id}`} onClick={() => onPick(`custom:${i.id}`)}>
                <img src={customIconUrl(i.id)} alt="" className="h-5 w-5 object-contain" draggable={false} />
              </Cell>
              {(me?.isAdmin || i.createdBy === me?.id) && (
                <button
                  className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-line-control bg-bg text-fg-muted hover:text-danger group-hover:flex"
                  aria-label={t('Icon {name} löschen', { name: i.name })}
                  onClick={() => setConfirm(i.id)}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ))}
        </Grid>
      ) : (
        <p className="py-3 text-center text-xs text-fg-muted">{icons.isPending ? t('Lädt …') : t('Noch keine eigenen Icons.')}</p>
      )}
      {confirm && (
        <div className="flex items-center gap-2 rounded bg-subtle px-2 py-1.5 text-xs">
          <span className="flex-1">{t('Icon „{name}“ löschen? Notizen damit zeigen dann ein leeres Feld.', { name: icons.data?.find((i) => i.id === confirm)?.name ?? '' })}</span>
          <button className="rounded px-1.5 py-0.5 text-danger hover:bg-hover" onClick={() => void remove(confirm)}>
            {t('Löschen')}
          </button>
          <button className="rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => setConfirm(null)}>
            {t('Abbrechen')}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input ref={file} type="file" accept="image/png,image/webp,image/jpeg,image/gif,image/svg+xml" multiple hidden onChange={(e) => void upload(e.target.files)} aria-label={t('Icon-Datei')} />
        <button className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-line-control px-2 text-xs hover:border-fg-faint hover:bg-hover" onClick={() => file.current?.click()} disabled={busy}>
          {busy ? <Spinner className="h-3 w-3" /> : <Upload className="h-3.5 w-3.5" />}
          {t('Hochladen …')}
        </button>
        <span className="text-[0.6875rem] text-fg-faint">{t('PNG, WebP, JPEG, GIF, SVG · max. 256 KB · für alle Quellen')}</span>
      </div>
      <FormError small>{error}</FormError>
    </div>
  );
}
