// Builds the login illustrations (apps/web/src/auth/brand/login-{light,dark}[-860].webp) from the
// design picture (left part of kaveyl_login2.jpg, 2752×1536). The dark variant blends the
// picture with a hue-preserving inversion tinted indigo (right side). In Chromium, no image tool.
// Usage: node scripts/brand-login-images.mjs <path/to/kaveyl_login2.jpg>
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('Pfad zum Entwurfsbild angeben');
const OUT = resolve(import.meta.dirname, '../apps/web/src/auth/brand');
const browser = await chromium.launch();
const page = await browser.newPage();
const data = `data:image/jpeg;base64,${readFileSync(src).toString('base64')}`;
const out = await page.evaluate(async (data) => {
  const img = new Image();
  img.src = data;
  await img.decode();
  const W = 1720; // the illustration; the form part of the design is cut off
  const H = 1536;
  const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const base = canvas(W, H);
  base.getContext('2d').drawImage(img, 0, 0, W, H, 0, 0, W, H);
  const inv = canvas(W, H);
  const i = inv.getContext('2d');
  i.filter = 'invert(1) hue-rotate(180deg) brightness(0.85)';
  i.drawImage(base, 0, 0);
  i.filter = 'none';
  i.globalCompositeOperation = 'color';
  i.globalAlpha = 0.55;
  i.fillStyle = '#312e81';
  i.fillRect(0, 0, W, H);
  i.globalCompositeOperation = 'multiply';
  i.globalAlpha = 0.35;
  i.fillStyle = '#1e1b4b';
  i.fillRect(0, 0, W, H);
  const mask = canvas(W, H);
  const m = mask.getContext('2d');
  const grad = m.createLinearGradient(W * 0.2, 0, W * 0.55, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,1)');
  m.fillStyle = grad;
  m.fillRect(0, 0, W, H);
  m.globalCompositeOperation = 'source-in';
  m.drawImage(inv, 0, 0);
  const dark = canvas(W, H);
  const d = dark.getContext('2d');
  d.drawImage(base, 0, 0);
  d.drawImage(mask, 0, 0);
  const webp = (c, w) => {
    const s = canvas(w, Math.round((H * w) / W));
    s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
    return s.toDataURL('image/webp', 0.8).split(',')[1];
  };
  return { 'login-light': webp(base, W), 'login-light-860': webp(base, 860), 'login-dark': webp(dark, W), 'login-dark-860': webp(dark, 860) };
}, data);
for (const [name, b64] of Object.entries(out)) {
  writeFileSync(join(OUT, `${name}.webp`), Buffer.from(b64, 'base64'));
  console.log(`${name}.webp`);
}
await browser.close();
