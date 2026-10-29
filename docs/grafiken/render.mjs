// Drawn pictures of the manual: docs/grafiken/<name>.<lang>.svg → docs/handbuch/<name>.webp (German) and
// docs/handbuch/<lang>/<name>.webp (translations). Run after changing an SVG: node docs/grafiken/render.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const MANUAL = join(HERE, '..', 'handbuch');
const browser = await chromium.launch();
for (const file of readdirSync(HERE).filter((f) => f.endsWith('.svg'))) {
  const [, name, lang] = /^(.+)\.([a-z]{2})\.svg$/.exec(file) ?? [];
  if (!name) continue;
  const svg = readFileSync(join(HERE, file), 'utf8');
  const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1.5 });
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  const png = (await page.screenshot()).toString('base64');
  // WebP like the screenshots of the manual (scripts/e2e-shots-to-handbook.mjs).
  const webp = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', 0.85).split(',')[1];
  }, png);
  const dir = lang === 'de' ? MANUAL : join(MANUAL, lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.webp`), Buffer.from(webp, 'base64'));
  console.log(join(lang === 'de' ? '' : lang, `${name}.webp`));
  await page.close();
}
await browser.close();
