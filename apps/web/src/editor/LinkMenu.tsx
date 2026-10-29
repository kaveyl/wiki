// Right-click on a link in a note: Kaveyl Wiki's own menu instead of the browser's (whose „open in new
// tab“ / „copy link“ would use the raw relative href, and which overlapped the selection bubble).
import * as DM from '@radix-ui/react-dropdown-menu';
import type { Editor } from '@tiptap/react';
import { Copy, ExternalLink, FilePlus, Link2Off, Pencil, SquareArrowOutUpRight } from 'lucide-react';
import { externalUrl, isExternal } from '@kaveyl-wiki/core';
import { copyWithToast } from '../clipboard';
import { promptLink } from './Toolbar';
import { t } from '../i18n';
import { DropdownContent } from '../ui';

export interface LinkMenuAt {
  x: number;
  y: number;
  href: string;
  /** Document position inside the link (for edit/remove). */
  pos: number;
  /** The target does not exist (marked red in the note). */
  broken?: boolean;
}

const item = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover';

export function LinkMenu({
  at,
  editor,
  isNote,
  onOpen,
  onCreate,
  onClose,
}: {
  at: LinkMenuAt;
  editor: Editor;
  /** The link points at a note (can open in a new tab). */
  isNote: boolean;
  onOpen: (href: string, newTab: boolean) => void;
  /** A missing note: create it where the link points. */
  onCreate?: () => void;
  onClose: () => void;
}) {
  const external = isExternal(at.href);
  const inLink = () => editor.chain().focus().setTextSelection(at.pos).extendMarkRange('link');
  return (
    <DM.Root open onOpenChange={(o) => !o && onClose()}>
      {/* An invisible anchor where the right-click happened. */}
      <DM.Trigger asChild>
        <span aria-hidden className="pointer-events-none fixed h-px w-px" style={{ left: at.x, top: at.y }} />
      </DM.Trigger>
      <DM.Portal>
        <DropdownContent align="start" sideOffset={2} aria-label={t('Link')} minWidth={220} className="z-50">
          <div className="max-w-[320px] truncate px-2 py-1 text-xs text-fg-faint" title={at.href}>
            {external ? externalUrl(at.href) : at.href}
          </div>
          {at.broken && (
            <>
              <div role="alert" className="px-2 pb-1 text-xs text-danger">{t('Ziel fehlt – dieser Link führt ins Leere.')}</div>
              {isNote && editor.isEditable && onCreate && (
                <DM.Item className={item} onSelect={onCreate}>
                  <FilePlus className="h-4 w-4 text-fg-muted" /> {t('Notiz anlegen')}
                </DM.Item>
              )}
            </>
          )}
          <DM.Item className={item} onSelect={() => onOpen(at.href, false)}>
            <ExternalLink className="h-4 w-4 text-fg-muted" /> {external ? t('Im Browser öffnen') : t('Öffnen')}
          </DM.Item>
          {isNote && (
            <DM.Item className={item} onSelect={() => onOpen(at.href, true)}>
              <SquareArrowOutUpRight className="h-4 w-4 text-fg-muted" /> {t('In neuem Tab öffnen')}
            </DM.Item>
          )}
          <DM.Item className={item} onSelect={() => void copyWithToast(external ? externalUrl(at.href) : at.href, 'Link')}>
            <Copy className="h-4 w-4 text-fg-muted" /> {t('Link kopieren')}
          </DM.Item>
          {editor.isEditable && (
            <>
              <DM.Separator className="my-1 h-px bg-line" />
              <DM.Item
                className={item}
                onSelect={() => {
                  inLink().run();
                  void promptLink(editor);
                }}
              >
                <Pencil className="h-4 w-4 text-fg-muted" /> {t('Link bearbeiten …')}
              </DM.Item>
              <DM.Item className={item} onSelect={() => inLink().unsetLink().run()}>
                <Link2Off className="h-4 w-4 text-fg-muted" /> {t('Link entfernen')}
              </DM.Item>
            </>
          )}
        </DropdownContent>
      </DM.Portal>
    </DM.Root>
  );
}
