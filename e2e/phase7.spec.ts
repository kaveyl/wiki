// Phase 7: installable web app (manifest, service worker) and the phone layout.
// Runs after phase1–6 in the same seeded workspace (admin + local mount "Notizen").
import { expect, test, type Browser } from '@playwright/test';


async function phone(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  return page;
}

test('installable: manifest with icons, service worker, theme color', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const m = (await manifest.json()) as { name: string; display: string; icons: { src: string; purpose?: string }[] };
  expect(m).toMatchObject({ name: 'Kaveyl Wiki', short_name: 'Kaveyl', display: 'standalone' });
  expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const i of m.icons) expect((await request.get(i.src)).headers()['content-type']).toBe('image/png');
  const sw = await request.get('/sw.js');
  expect(sw.headers()['content-type']).toContain('javascript');
  // Notes and the API are never cached by the service worker.
  expect(await sw.text()).toContain("url.pathname.startsWith('/api/')");
  const html = await (await request.get('/')).text();
  expect(html).toContain('rel="manifest"');
  expect(html).toContain('name="theme-color"');
});

test('phone: the sidebar is a drawer that closes when a note opens; tree actions without hover', async ({ browser }) => {
  const page = await phone(browser);
  const drawer = page.getByRole('complementary', { name: 'Seitenleiste' });
  await expect(page.getByRole('button', { name: 'Seitenleiste einblenden' })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.getByRole('button', { name: 'Seitenleiste einblenden' }).tap();
  await expect(drawer).toBeVisible();
  const box = (await drawer.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(345);
  // Touch screens have no hover: the source row shows its actions right away.
  const source = drawer.locator('[data-mount]', { hasText: 'Notizen' }).first();
  await expect(source.getByRole('button', { name: 'Neu …' })).toBeVisible();
  const tree = drawer.locator('nav[aria-label="Quellen"]');
  if (!(await tree.getByText('roadmap', { exact: true }).first().isVisible())) await tree.getByText('plan', { exact: true }).first().tap();
  await tree.getByText('roadmap', { exact: true }).first().tap();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('.prose-note').filter({ visible: true })).toContainText('Roadmap');
  // Tapping beside the drawer closes it, too.
  await page.getByRole('button', { name: 'Seitenleiste einblenden' }).tap();
  await expect(drawer).toBeVisible();
  await page.mouse.click(380, 400);
  await expect(drawer).toHaveCount(0);
  await page.context().close();
});

test('no network: the sync indicator says so at once and is back to normal online (Owner-Checkliste 8)', async ({ browser }) => {
  // Offline, React Query pauses the status query instead of failing it, and the live connection may still look open.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  const sync = page.getByRole('button', { name: /^Sync-Status/ }).first();
  await expect(sync).toBeVisible();
  await ctx.setOffline(true);
  await expect(sync).toHaveAccessibleName('Sync-Status: Keine Verbindung zum Server', { timeout: 5_000 });
  await ctx.setOffline(false);
  await expect(sync).not.toHaveAccessibleName('Sync-Status: Keine Verbindung zum Server', { timeout: 15_000 });
  await ctx.close();
});

test('signed out elsewhere while the live connection is silent: the first failed save brings the „Abgemeldet“ dialog', async ({ browser }) => {
  // The dialog must not hang on the live connection alone (its 4401 close) – a save answered with 401 asks again.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.routeWebSocket('**/api/events', () => undefined); // accepted, never closed, never says anything
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByLabel('Notizen durchsuchen')).toBeVisible();
  // Opening a note changes this account's tabs, recent list and tree – the later specs share the account: put it back.
  const KEYS = ['workspace', 'personal', 'prefs'];
  const before = await Promise.all(KEYS.map(async (k) => (await page.request.get(`/api/state/${k}`)).json()));
  await page.getByLabel('Notizen durchsuchen').fill('roadm');
  await page.locator('div.mx-1').filter({ hasText: 'roadmap' }).first().click();
  await page.keyboard.press('Escape');
  const editor = page.locator('.prose-note').filter({ visible: true }).first();
  await expect(editor).toContainText('Roadmap');
  await page.request.post('/api/logout', { data: {} });
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' nach dem Abmelden');
  await expect(page.getByRole('dialog', { name: 'Abgemeldet' })).toBeVisible({ timeout: 15_000 });
  await page.close();
  await ctx.request.post('/api/login', { data: { email: 'e2e@example.test', password: 'E2E-Passwort-12345' } });
  for (const [i, k] of KEYS.entries()) await ctx.request.put(`/api/state/${k}`, { data: before[i] });
  await ctx.request.post('/api/logout', { data: {} });
  await ctx.close();
});

test('locked by an admin while signed in: the login page comes at once – also when the live connection keeps dropping', async ({ browser }) => {
  const admin = await browser.newContext();
  await admin.request.post('/api/login', { data: { email: 'e2e@example.test', password: 'E2E-Passwort-12345' } });
  const make = async (name: string) => {
    const r = await admin.request.post('/api/admin/users', { data: { email: `${name}@example.test`, displayName: name, password: 'Start-Passwort-0001' } });
    const user = (await r.json()) as { id: string };
    const ctx = await browser.newContext();
    await ctx.request.post('/api/login', { data: { email: `${name}@example.test`, password: 'Start-Passwort-0001' } });
    await ctx.request.post('/api/account/password', { data: { current: 'Start-Passwort-0001', next: 'Eigenes-Passwort-0001' } });
    await ctx.request.post('/api/login', { data: { email: `${name}@example.test`, password: 'Eigenes-Passwort-0001' } });
    return { user, ctx };
  };
  const lock = (id: string) => admin.request.patch(`/api/admin/users/${id}`, { data: { disabled: true } });
  try {
    // Live connection open: the server closes it with 4401 when the account is locked, no event needed.
    const a = await make('sperr-a');
    const pa = await a.ctx.newPage();
    await pa.goto('/');
    await expect(pa.getByLabel('Notizen durchsuchen')).toBeVisible();
    await lock(a.user.id);
    await expect(pa.getByRole('button', { name: 'Anmelden' })).toBeVisible({ timeout: 10_000 });
    // The right password: told that the account is locked (a wrong one still hears the usual answer).
    await pa.getByLabel('E-Mail').fill('sperr-a@example.test');
    await pa.getByLabel('Passwort', { exact: true }).fill('Eigenes-Passwort-0001');
    await pa.getByRole('button', { name: 'Anmelden' }).click();
    await expect(pa.getByText('Dieses Konto ist gesperrt – bitte wende dich an einen Administrator')).toBeVisible();
    // Live connection that never stays open (proxy, flaky network): no „Keine Verbindung“ forever, the session is asked.
    const b = await make('sperr-b');
    const pb = await b.ctx.newPage();
    await pb.routeWebSocket('**/api/events', (ws) => ws.close({ code: 1011 }));
    await pb.goto('/');
    await expect(pb.getByLabel('Notizen durchsuchen')).toBeVisible();
    await lock(b.user.id);
    await expect(pb.getByRole('button', { name: 'Anmelden' })).toBeVisible({ timeout: 20_000 });
    await a.ctx.close();
    await b.ctx.close();
  } finally {
    const users = (await (await admin.request.get('/api/admin/users')).json()) as { id: string; email: string }[];
    for (const u of users.filter((x) => /^sperr-[ab]@/.test(x.email))) await admin.request.delete(`/api/admin/users/${u.id}`, { data: {} });
    await admin.close();
  }
});

test('help, settings and the account menu sit at the top right – also with the sidebar closed; on phones all in the account menu', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('E-Mail').fill('e2e@example.test');
  await page.getByLabel('Passwort').fill('E2E-Passwort-12345');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  const sidebar = page.getByRole('complementary', { name: 'Seitenleiste' });
  await expect(sidebar).toBeVisible();
  // Not in the sidebar header any more.
  await expect(sidebar.getByRole('button', { name: 'Einstellungen' })).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'Seitenleiste ausblenden' }).click();
  await expect(page.getByRole('button', { name: 'Hilfe (F1)' })).toBeVisible();
  await page.getByRole('button', { name: /^Konto/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toContainText('e2e@example.test');
  await expect(menu.getByRole('menuitem', { name: 'Abmelden' })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Mein Konto/ }).click();
  await expect(page.getByRole('dialog', { name: /Einstellungen/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Seitenleiste einblenden' }).click();
  await ctx.close();

  const phonePage = await phone(browser);
  await expect(phonePage.getByRole('button', { name: 'Einstellungen' })).toHaveCount(0);
  await phonePage.getByRole('button', { name: /^Konto/ }).tap();
  await expect(phonePage.getByRole('menuitem', { name: 'Hilfe / Handbuch' })).toBeVisible();
  await phonePage.getByRole('menuitem', { name: 'Einstellungen' }).tap();
  await expect(phonePage.getByRole('dialog', { name: /Einstellungen/ })).toBeVisible();
  await phonePage.context().close();
});
