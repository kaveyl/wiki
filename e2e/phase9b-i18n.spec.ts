// Interface languages and the colour scheme switch (AD-046). The rest of the suite runs in German (locale de-DE);
// here browsers ask for English. Runs after the other specs in the seeded workspace (admin + "Notizen").
import { expect, test, type Page } from '@playwright/test';
import { openSettingsPage } from './settings-nav';

const ADMIN = { email: 'e2e@example.test', password: 'E2E-Passwort-12345' };
const html = (page: Page) => page.locator('html');

test.describe.configure({ mode: 'serial' });

// Whatever happens here, the specs after this one expect the admin's account in German.
test.afterAll(async ({ playwright }, info) => {
  const api = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  await api.post('/api/login', { data: ADMIN });
  const prefs = (await (await api.get('/api/state/prefs')).json()) as Record<string, unknown> | null;
  await api.put('/api/state/prefs', { data: { ...prefs, language: 'de' } });
  await api.dispose();
});

test('English browser: sign-in page in English, switch is kept, the choice goes into the account', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(html(page)).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // DE | EN on the sign-in page: reloads in German and stays so.
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'de', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  await page.reload();
  await expect(html(page)).toHaveAttribute('lang', 'de');
  await page.getByRole('group', { name: 'Sprache' }).getByRole('button', { name: 'en', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // Signing in: the app speaks English (the account had German before – the deliberate choice wins).
  await page.getByLabel('E-mail', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Sources' }).first()).toBeVisible();
  await expect(html(page)).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible();

  // The server answers in the interface's language – errors included (the app sends X-Kaveyl-Wiki-Lang).
  const err = await page.evaluate(() =>
    fetch('/api/mounts/gibt-es-nicht/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kaveyl-wiki-lang': document.documentElement.lang }, body: '{}' }).then((r) => r.json()),
  );
  expect(err).toEqual({ error: 'Not found' });
  // Without the header the server follows Accept-Language (scripts without either get German).
  const de = await page.evaluate(() =>
    fetch('/api/mounts/gibt-es-nicht/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'de-AT, en;q=0.5' }, body: '{}' }).then((r) => r.json()),
  );
  expect(de).toEqual({ error: 'Nicht gefunden' });

  // After a reload still English.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sources' }).first()).toBeVisible();
  await expect(html(page)).toHaveAttribute('lang', 'en');

  // Back to German through the command palette (every language is listed under its own name).
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog').getByLabel('Command palette')).toBeFocused();
  await page.keyboard.type('Deutsch');
  await page.getByRole('dialog').getByRole('option', { name: /Deutsch/ }).first().click();
  // The switch reloads the page, so it asks first (in the current language).
  await page.getByRole('alertdialog').getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Quellen' }).first()).toBeVisible();
  await expect(html(page)).toHaveAttribute('lang', 'de');
  await ctx.close();
});

test('the account language follows to another browser; Einstellungen → Darstellung → Sprache switches it after asking', async ({ browser }) => {
  // A fresh English browser without a choice of its own: after signing in the account's German wins.
  const ctx = await browser.newContext({ locale: 'en-GB' });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('E-mail', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Quellen' }).first()).toBeVisible();
  await expect(html(page)).toHaveAttribute('lang', 'de');

  // Settings → Darstellung → Sprache: asks first; „Abbrechen“ changes nothing.
  await openSettingsPage(page, 'Sprache');
  const settings = page.getByRole('dialog', { name: 'Einstellungen' });
  await settings.getByRole('button', { name: 'English', exact: true }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Sprache auf English umstellen?');
  await ask.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Deutsch', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(html(page)).toHaveAttribute('lang', 'de');

  // „Umstellen“: after the reload the settings are open again at the same page, now in English.
  await settings.getByRole('button', { name: 'English', exact: true }).click();
  await ask.getByRole('button', { name: 'Umstellen', exact: true }).click();
  const en = page.getByRole('dialog', { name: 'Settings' });
  await expect(en.getByRole('tab', { name: 'Language', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(html(page)).toHaveAttribute('lang', 'en');
  await expect(en.getByRole('button', { name: 'English', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await en.getByRole('button', { name: 'Deutsch', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Einstellungen' }).getByRole('tab', { name: 'Sprache', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(html(page)).toHaveAttribute('lang', 'de');
  // Only once: a later reload leaves the settings closed.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Quellen' }).first()).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Einstellungen' })).toBeHidden();
  await ctx.close();
});

test('colour scheme switch: light → dark → system, kept after a reload', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'de-DE', colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto('/');
  // On the sign-in page too.
  const onLogin = page.getByRole('button', { name: 'Farbschema wechseln' });
  await expect(onLogin).toHaveAttribute('data-theme-state', 'system');
  await page.getByLabel('E-Mail', { exact: true }).fill(ADMIN.email);
  await page.getByLabel('Passwort', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('navigation', { name: 'Quellen' }).first()).toBeVisible();

  const toggle = page.locator('main').getByRole('button', { name: 'Farbschema wechseln' });
  await expect(toggle).toHaveAttribute('data-theme-state', 'system');
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-theme-state', 'light');
  await expect(html(page)).not.toHaveClass(/\bdark\b/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-theme-state', 'dark');
  await expect(html(page)).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator('main').getByRole('button', { name: 'Farbschema wechseln' })).toHaveAttribute('data-theme-state', 'dark');
  await expect(html(page)).toHaveClass(/\bdark\b/);
  // Settings → Darstellung shows the same state (one shared store).
  await page.getByRole('button', { name: 'Einstellungen' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Einstellungen' });
  await settings.getByRole('button', { name: 'Darstellung' }).first().click();
  await expect(settings.getByRole('button', { name: 'Dunkel', exact: true })).toHaveClass(/border-accent/);
  await page.keyboard.press('Escape');
  await page.locator('main').getByRole('button', { name: 'Farbschema wechseln' }).click();
  await expect(page.locator('main').getByRole('button', { name: 'Farbschema wechseln' })).toHaveAttribute('data-theme-state', 'system');
  await expect(html(page)).not.toHaveClass(/\bdark\b/);
  await ctx.close();
});
