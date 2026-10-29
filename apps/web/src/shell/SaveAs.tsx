// „Speichern als“ (AD-039): one dialog wherever something old comes back as a new note — a
// version from the history, a trash entry, a file or folder from a backup. Folder picker (start:
// the original's folder, any source the user may write to) plus a name; `.md` is added for notes.
// Nothing is ever overwritten: a taken name is shown right away, with a free one to take.
// SEE-DOC: DECISIONS.md AD-039
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Folder, Save } from 'lucide-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, ApiError, errorText, type Entry, type Mount } from '../api';
import { collator, t } from '../i18n';
import { Button, Field, Input, Modal, PopoverContent, Spinner, cx, FormError } from '../ui';

export interface FolderTarget {
  mountId: string;
  folder: string;
}

/** Sources the user may write into, with their folders (for the picker) and all paths (taken names). */
export function useWritableFolders() {
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const targets = (mounts.data ?? []).filter((m) => !m.paused && !m.options.readonly && (m.access === undefined || m.access === 'write' || m.access === 'admin'));
  const trees = useQueries({ queries: targets.map((m) => ({ queryKey: ['tree', m.id], queryFn: () => api.tree(m.id) })) });
  const groups: FolderGroup[] = targets.map((m, i) => ({ mount: m, folders: (trees[i]?.data ?? []).filter((e) => e.kind === 'dir') }));
  const taken = (mountId: string, path: string) => {
    const i = targets.findIndex((m) => m.id === mountId);
    const p = path.toLowerCase();
    return !!trees[i]?.data?.some((e) => e.path.toLowerCase() === p);
  };
  return { groups, targets, taken, loading: mounts.isLoading || trees.some((q) => q.isLoading) };
}

/** Folder and name of a path; for notes without `.md`. */
export function splitPath(path: string, kind: 'note' | 'file' | 'folder'): { folder: string; name: string } {
  const i = path.lastIndexOf('/');
  const base = path.slice(i + 1);
  return { folder: i < 0 ? '' : path.slice(0, i), name: kind === 'note' ? base.replace(/\.md$/i, '') : base };
}

/** „name (Version 12.10.2026)“ next to the original — the suggestion in the dialog. */
export function nameWith(path: string, kind: 'note' | 'file' | 'folder', suffix: string): string {
  const { name } = splitPath(path, kind);
  if (kind !== 'file') return `${name} (${suffix})`;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`;
}

export function SaveAsDialog({
  title = t('Speichern als'),
  help,
  intro,
  kind,
  start,
  name: initialName,
  submitLabel = t('Speichern'),
  onSave,
  onClose,
  onBack,
}: {
  title?: string;
  help: string;
  intro?: ReactNode;
  kind: 'note' | 'file' | 'folder';
  /** Where the picker starts: the original's source and folder. */
  start: FolderTarget;
  name: string;
  submitLabel?: string;
  /** Saves at `path` (with `.md` for notes) in `mountId`; a 409 means the name is taken. */
  onSave: (target: { mountId: string; path: string }) => Promise<void>;
  onClose: () => void;
  onBack?: () => void;
}) {
  const { groups, targets, taken, loading } = useWritableFolders();
  const [dest, setDest] = useState<FolderTarget | null>(null);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Start at the original's folder; a source the user cannot write to → the first one they can.
  const current = dest ?? (targets.some((m) => m.id === start.mountId) ? start : targets[0] ? { mountId: targets[0].id, folder: '' } : null);
  const clean = name.trim();
  const badName = clean.includes('/') || clean === '.' || clean === '..';
  const file = kind === 'note' && !/\.md$/i.test(clean) ? `${clean}.md` : clean;
  const path = current && clean ? (current.folder ? `${current.folder}/${file}` : file) : '';
  const exists = !!current && !!path && taken(current.mountId, path);
  /** The first free „name (2)“, „name (3)“ … in the chosen folder. */
  const curMount = current?.mountId;
  const curFolder = current?.folder ?? '';
  const free = useMemo(() => {
    if (!exists || !curMount) return null;
    const ext = kind === 'note' ? '.md' : kind === 'file' && clean.lastIndexOf('.') > 0 ? clean.slice(clean.lastIndexOf('.')) : '';
    const stem = kind === 'note' ? clean.replace(/\.md$/i, '') : ext ? clean.slice(0, -ext.length) : clean;
    for (let i = 2; i < 100; i++) {
      const n = `${stem} (${i})`;
      const p = `${curFolder ? `${curFolder}/` : ''}${n}${ext}`;
      if (!taken(curMount, p)) return n + (kind === 'file' ? ext : '');
    }
    return null;
  }, [exists, curMount, curFolder, clean, kind, taken]);
  useEffect(() => setError(null), [name, current?.mountId, current?.folder]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !path || badName || exists) return;
    setBusy(true);
    try {
      await onSave({ mountId: current.mountId, path });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? t('Diesen Namen gibt es dort schon – bitte einen anderen wählen.') : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const label = kind === 'folder' ? t('Ordnername') : t('Dateiname');
  return (
    <Modal help={help} open onOpenChange={(o) => !o && onClose()} title={title} onBack={onBack} trackInput>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        {intro && <div className="text-fg-muted">{intro}</div>}
        <div className="space-y-1">
          <span className="block text-xs font-medium text-fg-muted">{t('Ordner')}</span>
          {current ? (
            <FolderPicker groups={groups} value={current} onChange={setDest} loading={loading} />
          ) : (
            <p className="text-fg-muted">{loading ? t('Lädt …') : t('Keine Quelle, in die du schreiben darfst.')}</p>
          )}
        </div>
        <Field
          label={label}
          error={
            badName ? (
              t('Der Name darf keinen „/“ enthalten – den Ordner bitte unter „Ordner“ wählen.')
            ) : exists ? (
              <>
                {t('„{file}“ gibt es in diesem Ordner schon.', { file })}{' '}
                {free && (
                  // On touch 24 px high (design-011); the negative margins keep the line height of the message.
                  <button
                    type="button"
                    className="text-accent hover:underline [@media(hover:none)]:-my-1 [@media(hover:none)]:inline-flex [@media(hover:none)]:min-h-6 [@media(hover:none)]:items-center"
                    onClick={() => {
                      setName(free);
                      // The button disappears with the error: keep the keyboard in the field (the new value puts the caret at the end).
                      nameRef.current?.focus();
                    }}
                  >
                    {t('„{name}“ verwenden', { name: free })}
                  </button>
                )}
              </>
            ) : undefined
          }
        >
          {(a11y) => (
            <div className="flex items-center gap-1.5">
              <Input ref={nameRef} autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} spellCheck={false} aria-label={label} {...a11y} />
              {kind === 'note' && <span className="shrink-0 text-fg-faint">.md</span>}
            </div>
          )}
        </Field>
        <FormError>{error}</FormError>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onBack ?? onClose}>
            {t('Abbrechen')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !path || badName || exists}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export interface FolderGroup {
  mount: Mount;
  folders: Entry[];
}

/** Dropdown with a filterable list of folders, grouped by mount; folder '' is a mount's top level. */
export function FolderPicker({ groups, value, onChange, loading }: { groups: FolderGroup[]; value: FolderTarget; onChange: (t: FolderTarget) => void; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const q = filter.trim().toLowerCase();
  const options = useMemo(() => {
    const out: { mountId: string; mountName: string; path: string; label: string; depth: number }[] = [];
    for (const { mount, folders } of groups) {
      const sorted = [...folders].sort((a, b) => collator.compare(a.path, b.path));
      const all = [
        { mountId: mount.id, mountName: mount.name, path: '', label: t('Oberste Ebene'), depth: 0 },
        ...sorted.map((f) => ({ mountId: mount.id, mountName: mount.name, path: f.path, label: f.name, depth: f.path.split('/').length })),
      ];
      out.push(...(q ? all.filter((o) => `${o.mountName}/${o.path}`.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)) : all));
    }
    return out;
  }, [groups, q]);
  useEffect(() => setActive(0), [filter]);
  const pick = (o: { mountId: string; path: string }) => {
    onChange({ mountId: o.mountId, folder: o.path });
    setOpen(false);
    setFilter('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, options.length - 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
    else if (e.key === 'Enter') {
      if (options[active]) pick(options[active]);
    } else return;
    e.preventDefault();
  };
  const current = groups.find((g) => g.mount.id === value.mountId)?.mount.name ?? '';
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t('Ordner wählen')}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-line-control bg-bg px-2.5 text-left text-sm text-fg hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
        >
          <Folder className="h-4 w-4 shrink-0 text-fg-muted" />
          <span className="flex-1 truncate">
            <span className="text-fg-muted">{current} › </span>
            {value.folder || t('Oberste Ebene')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-fg-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="z-[60] w-[var(--radix-popover-trigger-width)]"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="border-b border-line p-2">
            <Input autoFocus placeholder={t('Quelle oder Ordner suchen…')} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={onKey} aria-label={t('Ordner suchen')} />
          </div>
          <ul role="listbox" aria-label={t('Ordner')} className="max-h-72 overflow-y-auto py-1">
            {loading && <li className="px-3 py-1.5 text-sm text-fg-faint">{t('Lade…')}</li>}
            {!loading && options.length === 0 && <li className="px-3 py-1.5 text-sm text-fg-faint">{t('Kein Ordner gefunden')}</li>}
            {options.map((o, i) => {
              const selected = o.mountId === value.mountId && o.path === value.folder;
              return (
                <Fragment key={`${o.mountId}:${o.path}`}>
                  {(i === 0 || options[i - 1]!.mountId !== o.mountId) && (
                    <li role="presentation" className="px-3 pb-0.5 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-faint">
                      {o.mountName}
                    </li>
                  )}
                  <li
                    role="option"
                    aria-selected={selected}
                    data-mount={o.mountName}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                    title={`${o.mountName} › ${o.path || t('Oberste Ebene')}`}
                    className={cx('flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-sm', i === active && 'bg-active', selected && 'font-medium text-accent')}
                    style={{ paddingLeft: 12 + (q ? 0 : Math.max(o.depth - 1, 0) * 14) }}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{q ? o.path || o.label : o.label}</span>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  );
}

