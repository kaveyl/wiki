// Helpers for the menus and the sidebar of the redesign (23.11.): entries that moved into a submenu
// („Öffnen & Neu anlegen“, „Kopieren / Ausschneiden / Pfad“ …) and the sidebar switch Baum | Zuletzt | KI-Freigaben.
import { expect, type Page } from '@playwright/test';

/** Clicks an entry inside a submenu of the open (context) menu: opens the submenu first. */
export async function subItem(page: Page, sub: string, name: string | RegExp, exact = false) {
  await page.getByRole('menuitem', { name: sub, exact: true }).click();
  const item = page.getByRole('menuitem', { name, exact });
  await expect(item.first()).toBeVisible();
  await item.first().click();
}

/** Shows a view of the sidebar: the tree, the recent notes or the AI shares. Stored per account – switch back to „Baum“. */
export async function sidebarView(page: Page, view: 'Baum' | 'Zuletzt' | 'KI-Freigaben') {
  const tab = page.locator('aside').getByRole('tab', { name: view, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
