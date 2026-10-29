// Screenshots of the local E2E suite for the user manual (copied with scripts/e2e-shots-to-handbook.mjs).
// The Gitea tests run against the owner's real Gitea (test branch); before a picture is taken, its
// address and account name are replaced on screen by neutral examples – the manual ships in the
// image and may be passed on (AD-043). Only the picture changes, the tests check the real values.
import type { Page } from '@playwright/test';
import { join, resolve } from 'node:path';

export const SHOTS = resolve(import.meta.dirname, '../.local/e2e-shots');
/** Where the test server's folders live on this machine (shown e.g. for local sources and backup targets). */
const E2E_DIR = resolve(import.meta.dirname, '../.local/e2e');

function replacements(): [string, string][] {
  const out: [string, string][] = [[E2E_DIR, '/srv/kaveyl-wiki']];
  if (!process.env.GITEA_API_URL) return out;
  const url = new URL(process.env.GITEA_API_URL);
  // gitea.example.com: not git.example.org, which the fake-server tests use themselves.
  const owner = process.env.GITEA_OWNER || url.pathname.split('/')[1];
  return [...out, [url.origin, 'https://gitea.example.com'], [url.host, 'gitea.example.com'], ...(owner ? ([[owner, 'demo']] as [string, string][]) : [])];
}

/**
 * Replaces real host/account names in text and form fields (display only) and returns a function
 * that puts the originals back – the test goes on with the real page after the picture.
 */
export async function neutralize(page: Page): Promise<() => Promise<void>> {
  const pairs = replacements();
  await page.evaluate((pairs) => {
    // API tokens of the throwaway test instance are shown once in plain text – not in the manual.
    const TOKEN = /kw_[A-Za-z0-9_-]{20,}/g;
    const swap = (s: string) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s).replace(TOKEN, 'kw_••••••••••••');
    const hit = (s: string) => pairs.some(([f]) => s.includes(f)) || /kw_[A-Za-z0-9_-]{20,}/.test(s);
    const undo: (() => void)[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const node = n;
      const old = node.nodeValue ?? '';
      if (!hit(old)) continue;
      node.nodeValue = swap(old);
      undo.push(() => (node.nodeValue = old));
    }
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      const old = el.value;
      if (!hit(old)) continue;
      el.value = swap(old);
      undo.push(() => (el.value = old));
    }
    (window as unknown as { __gwUndoNeutral?: () => void }).__gwUndoNeutral = () => undo.forEach((f) => f());
  }, pairs);
  return () => page.evaluate(() => (window as unknown as { __gwUndoNeutral?: () => void }).__gwUndoNeutral?.());
}

/**
 * A picture for the manual. Toasts left over from earlier steps are hidden – they had nothing to do with the picture
 * (handbook review 21.10.); `{ toasts: true }` keeps them where one is the point.
 */
export async function shot(page: Page, name: string, opts: { toasts?: boolean } = {}) {
  const restore = await neutralize(page);
  const hide = opts.toasts ? null : await page.addStyleTag({ content: '[data-toaster] { visibility: hidden !important; }' }).catch(() => null);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await hide?.evaluate((el) => (el as Element).remove()).catch(() => undefined);
  await restore();
}
