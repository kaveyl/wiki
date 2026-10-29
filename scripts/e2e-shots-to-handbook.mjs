// Copies screenshots of the local E2E suite (.local/e2e-shots/*.png) into the user manual as
// WebP (docs/handbuch/*.webp) — only names given as arguments, or by default those that already
// exist in the manual. The live suite (e2e/live/99-screenshots.spec.ts) does the same for its
// own shots. Converted in Chromium (canvas → WebP), no extra image tool.
// Usage: node scripts/e2e-shots-to-handbook.mjs [57-kopieren-einfuegen ...]
import { chromium } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, '.local/e2e-shots');
const MANUAL = join(ROOT, 'docs/handbuch');
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(SHOTS)
      .filter((f) => f.endsWith('.png') && existsSync(join(MANUAL, f.replace(/\.png$/, '.webp'))))
      .map((f) => f.replace(/\.png$/, ''));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
for (const name of names) {
  const png = join(SHOTS, `${name}.png`);
  if (!existsSync(png)) {
    console.warn(`fehlt: ${png}`);
    continue;
  }
  const out = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', 0.82).split(',')[1];
  }, readFileSync(png).toString('base64'));
  writeFileSync(join(MANUAL, `${name}.webp`), Buffer.from(out, 'base64'));
  console.log(`${name}.webp`);
}
await browser.close();
