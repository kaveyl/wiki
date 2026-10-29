// The HTML mail keeps the WCAG minimum contrast for its text (1.4.3: 4.5:1) – mail clients show it as is (rest-d5).
import { describe, expect, it } from 'vitest';
import { mailHtml } from './mailer.js';

function luminance(hex: string): number {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i) ?? hex.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (!m) throw new Error(`not a #rgb/#rrggbb colour: ${hex}`);
  const lin = (h: string) => {
    const v = parseInt(h.length === 1 ? h + h : h, 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]!) + 0.7152 * lin(m[2]!) + 0.0722 * lin(m[3]!);
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const html = mailHtml({ to: 'a@example.org', subject: 'S', text: 'Hallo\n\nzweiter Absatz', action: { label: 'Öffnen', url: 'https://wiki.example.org/x' } });
const style = (re: RegExp) => html.match(re)?.[1] ?? '';
const prop = (css: string, name: string) => css.match(new RegExp(`(?:^|;)${name}:(#[0-9a-f]{3,6})\\b`, 'i'))?.[1] ?? '';

describe('mail template colours (rest-d5)', () => {
  const body = style(/<body style="([^"]*)"/);
  const card = style(/<div style="(background:#fff;[^"]*)"/);
  const pageBg = prop(body, 'background');
  const cardBg = prop(card, 'background');

  it('body text on the card and on the page reaches 4.5:1', () => {
    expect(contrast(prop(body, 'color'), cardBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(prop(body, 'color'), pageBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('the footer under the card (on the page background) reaches 4.5:1', () => {
    const footer = style(/<p style="([^"]*)">Diese Nachricht wurde automatisch/);
    expect(footer).not.toBe('');
    expect(contrast(prop(footer, 'color'), pageBg)).toBeGreaterThanOrEqual(4.5);
  });

  it('the link fallback inside the card and the button label reach 4.5:1', () => {
    const hint = style(/<p style="([^"]*)">Falls der Knopf nicht funktioniert/);
    expect(contrast(prop(hint, 'color'), cardBg)).toBeGreaterThanOrEqual(4.5);
    const button = style(/<a href="[^"]*" style="([^"]*)"/);
    expect(contrast(prop(button, 'color'), prop(button, 'background'))).toBeGreaterThanOrEqual(4.5);
  });
});
