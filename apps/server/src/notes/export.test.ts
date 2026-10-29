import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './export.js';

const keep = { href: () => null, src: () => null };

describe('markdownToHtml', () => {
  it('drops link and image targets that would run code, keeps the text and ordinary targets', () => {
    const md = [
      '[a](javascript:alert(1)) [b](JavaScript:alert(1)) [c](vbscript:x) [d](data:text/html,x) <javascript:alert(2)>',
      '',
      '[e][ref]',
      '',
      '[ref]: javascript:alert(3)',
      '',
      '![f](javascript:alert(4)) ![g](data:text/html,x) ![h](data:image/png;base64,iVBORw==)',
      '',
      '[i](https://example.test) [j](mailto:a@b.de) [k](tel:+49) [l](plan.md#x) [m](#oben)',
    ].join('\n');
    const { html } = markdownToHtml(md, keep);
    expect(html).not.toMatch(/(href|src)="[^"]*(javascript|vbscript|data:text)/i);
    for (const text of ['>a<', '>b<', '>c<', '>d<', '>e<']) expect(html).toContain(text);
    expect(html).toContain('src="data:image/png;base64,iVBORw=="');
    for (const href of ['https://example.test', 'mailto:a@b.de', 'tel:+49', 'plan.md#x', '#oben']) expect(html).toContain(`href="${href}"`);
  });
});
