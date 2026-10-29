// What can be done with several marked notes and folders (owner 28.10.): the same list in the row's context menu and in
// the bar above the tree (also for touch, where „Auswählen“ shows boxes). The dialogs: MarkedDialogs.tsx.
import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as DM from '@radix-ui/react-dropdown-menu';
import { FileDown, FolderInput, Mail, Send, Trash2, X } from 'lucide-react';
import { api, type Mount } from '../api';
import { downloadPicked } from '../editor/exporting';
import { t, tn } from '../i18n';
import { Button, ContextItem, ContextSeparator, DropdownContent } from '../ui';
import { useActions } from './actions';
import { useMarked, type MarkedItem } from './marked';

const NONE: MarkedItem[] = [];

interface MarkedAction {
  key: string;
  label: string;
  icon?: ReactNode;
  run: () => void;
  disabled?: boolean;
  /** Why it is greyed out. */
  hint?: string;
  danger?: boolean;
  /** A line above this entry. */
  apart?: boolean;
}

/** The actions for the marked rows of `mount`, as far as the person may do them there. */
export function useMarkedActions(mount: Mount | undefined): MarkedAction[] {
  // A fixed empty list: a new [] on every call would make the store selector loop.
  const items = useMarked((s) => (mount && s.mountId === mount.id ? s.items : NONE));
  const session = useQuery({ queryKey: ['session'], queryFn: api.session }).data;
  const openAction = useActions((s) => s.open);
  if (!mount || !items.length) return [];
  const guest = !!session?.user?.isGuest;
  const notes = items.filter((i) => !i.isDir);
  const writable = !mount.options.readonly && items.every((i) => i.access === 'write' || i.access === 'admin');
  const out: MarkedAction[] = [];
  if (!guest) {
    const why = !session?.mail
      ? t('E-Mail-Versand ist nicht eingerichtet')
      : notes.length < items.length
        ? t('Nur Notizen lassen sich per Mail versenden, keine Ordner')
        : notes.some((n) => n.encrypted)
          ? t('Verschlüsselte Notizen lassen sich nicht per Mail versenden')
          : undefined;
    out.push({ key: 'mail', label: t('Per Mail versenden …'), icon: <Mail />, disabled: !!why, hint: why, run: () => openAction({ kind: 'mail-notes', mountId: mount.id, notes }) });
    if (items.every((i) => i.access === 'admin')) {
      const [first, ...rest] = items;
      out.push({
        key: 'share',
        label: t('Zugriff per E-Mail geben …'),
        icon: <Send />,
        run: () =>
          openAction({
            kind: 'share',
            mountId: mount.id,
            target: first!.isDir ? 'folder' : 'note',
            path: first!.path,
            title: first!.title,
            more: rest.map((i) => ({ target: i.isDir ? 'folder' : 'note', path: i.path, title: i.title })),
          }),
      });
    }
  }
  if (writable) out.push({ key: 'move', label: t('Verschieben …'), icon: <FolderInput />, run: () => openAction({ kind: 'move-many', mountId: mount.id, items }) });
  const paths = items.map((i) => i.path);
  out.push({ key: 'md', label: t('Exportieren: Markdown (ZIP)'), icon: <FileDown />, run: () => void downloadPicked(mount.id, paths, 'md'), apart: true });
  // HTML leaves encrypted notes out: with only those there would be nothing.
  const onlyEncrypted = items.every((i) => i.encrypted);
  out.push({
    key: 'html',
    label: t('Exportieren: HTML (ZIP)'),
    icon: <FileDown />,
    disabled: onlyEncrypted,
    hint: onlyEncrypted ? t('Verschlüsselte Notizen gibt es nur als Markdown') : undefined,
    run: () => void downloadPicked(mount.id, paths),
  });
  if (writable) out.push({ key: 'delete', label: t('Löschen …'), icon: <Trash2 />, danger: true, apart: true, run: () => openAction({ kind: 'delete-many', mountId: mount.id, items }) });
  out.push({ key: 'clear', label: t('Auswahl aufheben'), icon: <X />, run: () => useMarked.getState().clear(), apart: true });
  return out;
}

/** The marked rows' actions inside a row's context menu. */
export function MarkedMenuItems({ mount }: { mount: Mount }) {
  const actions = useMarkedActions(mount);
  const n = useMarked((s) => s.items.length);
  return (
    <>
      <div className="px-2 py-1 text-xs text-fg-muted">{tn(n, '{n} markiert', '{n} markiert')}</div>
      {actions.map((a) => (
        <span key={a.key} className="contents">
          {a.apart && <ContextSeparator />}
          <ContextItem icon={a.icon} onSelect={a.run} danger={a.danger} disabled={a.disabled} title={a.hint}>
            {a.label}
          </ContextItem>
        </span>
      ))}
    </>
  );
}

/** Above the tree while something is marked: how many, the actions (also on touch), done. */
export function MarkedBar() {
  const { mountId, items, picking } = useMarked();
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts }).data;
  const mount = mounts?.find((m) => m.id === mountId);
  const actions = useMarkedActions(mount);
  // The source is gone (unmounted, no longer visible): nothing stays marked.
  useEffect(() => {
    if (mountId && mounts && !mount) useMarked.getState().clear();
  }, [mountId, mounts, mount]);
  if (!mount || (!items.length && !picking)) return null;
  return (
    <div className="sticky top-0 z-10 mb-1 flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft px-2 py-1 text-xs" role="toolbar" aria-label={t('Auswahl')}>
      <span className="flex-1 truncate">
        {tn(items.length, '{n} markiert', '{n} markiert')} · {mount.name}
      </span>
      <DM.Root>
        <DM.Trigger asChild>
          <Button size="sm" variant="ghost">
            {t('Aktionen')}
          </Button>
        </DM.Trigger>
        <DM.Portal>
          <DropdownContent align="end" minWidth={220} className="z-50">
            {actions.map((a) => (
              <span key={a.key} className="contents">
                {a.apart && <DM.Separator className="my-1 h-px bg-line" />}
                <DM.Item
                  onSelect={a.run}
                  disabled={a.disabled}
                  title={a.hint}
                  className={`flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover ${a.danger ? 'text-danger' : 'text-fg'}`}
                >
                  <span className="flex h-4 w-4 items-center justify-center text-fg-muted [&>svg]:h-4 [&>svg]:w-4">{a.icon}</span>
                  {a.label}
                </DM.Item>
              </span>
            ))}
          </DropdownContent>
        </DM.Portal>
      </DM.Root>
      <Button size="sm" variant="ghost" onClick={() => useMarked.getState().clear()}>
        {t('Fertig')}
      </Button>
    </div>
  );
}
