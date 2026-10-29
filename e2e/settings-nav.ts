// Settings since AD-035: main entries on the left (navigation „Bereiche“), related pages as tabs on top.
import type { Page } from '@playwright/test';

/** Page (tab) → its main entry; pages not listed are main entries of their own. */
const GROUP: Record<string, string> = {
  Verbindungen: 'Quellen',
  'Eingebundene Quellen': 'Quellen',
  Webhooks: 'Quellen',
  Aufräumen: 'Werkzeuge',
  Protokoll: 'Werkzeuge',
  Ziele: 'Backup',
  Zeitpläne: 'Backup',
  Sicherungen: 'Backup',
  Datenbank: 'Backup',
  Prüfung: 'Werkzeuge',
  Benutzer: 'Benutzer & Rechte',
  Gruppen: 'Benutzer & Rechte',
  Rechte: 'Benutzer & Rechte',
  'Cloudflare Access': 'SSO & Proxy',
  Authentik: 'SSO & Proxy',
  'Reverse-Proxy': 'SSO & Proxy',
  'E-Mail': 'Benachrichtigungen',
  Pushover: 'Benachrichtigungen',
  Ereignisse: 'Benachrichtigungen',
  Updates: 'Benachrichtigungen',
  KI: 'KI & APIs',
  'API-Tokens': 'KI & APIs',
  'Alle Tokens': 'KI & APIs',
  'Ereignis-Webhooks': 'KI & APIs',
  Beobachten: 'Konto',
  Sprache: 'Darstellung',
  Schriftgröße: 'Darstellung',
};

/** Opens the settings (if needed) at a page, e.g. 'Protokoll' → Werkzeuge → Protokoll. */
export async function openSettingsPage(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Einstellungen' });
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Einstellungen', exact: true }).first().click();
  await dialog.getByRole('navigation', { name: 'Bereiche' }).getByRole('button', { name: GROUP[name] ?? name, exact: true }).click();
  const tab = dialog.getByRole('tab', { name, exact: true });
  if (await tab.count()) await tab.click();
}
