// HTML export and print (Phase 6, AD-027): the server renders a clean HTML page of the note
// (or a ZIP of a folder); printing loads that page in a hidden frame and opens the browser's
// print dialog there — „Als PDF speichern“ makes the PDF. Encrypted notes exist in plain text
// only in this browser: they are printed from the app view itself (print CSS).
import { api, errorText } from '../api';
import { t } from '../i18n';
import { toast } from '../toast';

/**
 * HTML: the note as HTML file, a folder/source (path '' = whole source) as ZIP of HTML pages.
 * Markdown: the .md files as they are, with the pictures and files they use, as ZIP – a note that uses none comes as its .md.
 */
export function downloadExport(mountId: string, path: string, format: 'html' | 'md' = 'html') {
  download(api.exportUrl(mountId, path, format));
}

/** Several notes and folders marked in the tree, as one ZIP (owner 28.10.); a failure is a message, the app stays. */
export async function downloadPicked(mountId: string, paths: string[], format: 'html' | 'md' = 'html') {
  try {
    const { blob, name } = await api.exportPick(mountId, paths, format);
    const url = URL.createObjectURL(blob);
    download(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    toast({ kind: 'error', title: t('Export fehlgeschlagen'), text: errorText(e) });
  }
}

function download(href: string, name?: string) {
  const a = document.createElement('a');
  a.href = href;
  if (name) a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Opens the print dialog for a note (clean layout without the app around it). */
export function printNote(mountId: string, path: string, encrypted = false) {
  if (encrypted) return window.print();
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = `${api.exportUrl(mountId, path)}?inline=1`;
  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) return frame.remove();
    w.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500));
    w.focus();
    w.print();
    // Browsers without afterprint: clean up after a while anyway.
    setTimeout(() => frame.isConnected && frame.remove(), 120_000);
  };
  document.body.append(frame);
}
