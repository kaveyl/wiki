// Clipboard: `navigator.clipboard` only exists in secure contexts (https, localhost). Kaveyl Wiki
// often runs over plain http in the LAN, so fall back to a hidden textarea + execCommand.
import { t } from './i18n';
import { toast } from './toast';

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Copies and confirms with a toast (or says it failed, so stale clipboard content is no surprise). `what` is German and translated here. */
export async function copyWithToast(text: string, what = 'Pfad'): Promise<void> {
  if (await copyText(text)) toast({ kind: 'ok', title: t('{what} kopiert', { what: t(what) }), text });
  else toast({ kind: 'error', title: t('{what} nicht kopiert', { what: t(what) }), text: t('Der Browser hat den Zugriff auf die Zwischenablage verweigert.') });
}

/** Kaveyl Wiki's own clipboard format: Markdown that the note editor pastes 1:1 (callouts, math, tables). */
export const MARKDOWN_MIME = 'application/x-kaveyl-wiki-markdown';

/**
 * Copies formatted text: a Kaveyl Wiki note gets the Markdown itself, Word/mail the HTML, a text editor
 * the plain Markdown. Done through a copy event, which also works over plain http.
 */
export function copyRich(html: string, markdown: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', markdown);
    e.clipboardData.setData(MARKDOWN_MIME, markdown);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}
