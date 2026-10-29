// The sign-in picture is the largest element of the page (LCP): only the variant of the active colour
// scheme may be loaded, with its size known up front and a hashed name for the long-term cache (seo-002).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthLayout } from './AuthPages';

describe('sign-in picture', () => {
  it('renders one picture with size and high priority, bundled instead of /brand/', () => {
    const html = renderToStaticMarkup(createElement(AuthLayout, null));
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs).toHaveLength(1);
    const img = imgs[0]!;
    expect(img).toMatch(/src="[^"]*login-light[^"]*\.webp"/);
    expect(img).not.toContain('login-dark');
    expect(img).not.toMatch(/[" ]\/brand\//); // public/brand had no hash and max-age=0
    expect(img).toContain('width="1720"');
    expect(img).toContain('height="1536"');
    expect(img).toContain('fetchPriority="high"');
    expect(img).not.toContain('loading="lazy"');
  });
});
