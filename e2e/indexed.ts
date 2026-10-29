// Files written directly to disk reach Kaveyl Wiki through the file watcher and the index, which can lag under load
// (debounce, re-subscribe after an interrupted watch). Tests wait for the server to list them instead of hoping a
// live update arrives within the default 5 s.
import { expect, type Page } from '@playwright/test';

export async function waitIndexed(page: Page, mountName: string, paths: string[]) {
  const mounts = (await (await page.request.get('/api/mounts')).json()) as { id: string; name: string }[];
  const id = mounts.find((m) => m.name === mountName)!.id;
  const listed = async () => ((await (await page.request.get(`/api/tree/${id}`)).json()) as { path: string }[]).map((e) => e.path);
  await expect.poll(listed, { timeout: 45_000 }).toEqual(expect.arrayContaining(paths));
}
