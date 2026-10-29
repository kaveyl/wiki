import { describe, expect, it } from 'vitest';
import { externalUrl, formatLink, isExternal, isScriptUrl, linkCandidates, normalizeLinkInput, noteCandidates, resolveHref, webAddress } from './links.js';
import { extractLinks } from './linkScan.js';

describe('links', () => {
  it('resolves relative, absolute and extension-less links', () => {
    expect(resolveHref('../a/b.md#x', 'docs/n.md')).toEqual({ path: 'a/b.md', anchor: 'x' });
    expect(resolveHref('/docs/home', 'x/y.md')).toEqual({ path: 'docs/home', anchor: null });
    expect(resolveHref('https://x.test', 'n.md')).toBeNull();
    expect(noteCandidates('docs/home', 'index.md')).toEqual(['docs/home.md', 'docs/home/index.md']);
  });

  it('names the files that make a link or an image lead somewhere (one rule for the check and the editor)', () => {
    // A link may leave out `.md` or point at a folder (its folder note); an image is only ever the file itself.
    expect(linkCandidates('docs/home', 'link', 'index.md')).toEqual(['docs/home', 'docs/home.md', 'docs/home/index.md']);
    expect(linkCandidates('docs/home.md', 'link', 'index.md')).toEqual(['docs/home.md']);
    expect(linkCandidates('', 'link', 'index.md')).toEqual(['index.md']);
    expect(linkCandidates('docs/bild', 'definition', 'README.md')).toEqual(['docs/bild', 'docs/bild.md', 'docs/bild/README.md']);
    expect(linkCandidates('docs/bild', 'image', 'index.md')).toEqual(['docs/bild']);
    expect(linkCandidates('docs/bild.png', 'image', 'index.md')).toEqual(['docs/bild.png']);
    expect(linkCandidates('', 'image', 'index.md')).toEqual([]);
  });

  it('treats a web address typed without https:// as external, never as a file next to the note', () => {
    for (const h of ['www.google.de', 'www.google.de/suche?q=x', 'example.org', 'docs.example.org/a/b', 'wiki.example.net:8443/x']) {
      expect(isExternal(h), h).toBe(true);
      expect(resolveHref(h, 'KI/notiz.md'), h).toBeNull();
    }
    expect(externalUrl('www.google.de')).toBe('https://www.google.de');
    expect(externalUrl('https://x.test/a')).toBe('https://x.test/a');
    for (const h of ['notiz.md', 'plan/roadmap.md', '../a.md', 'assets/bild.png', 'bericht.pdf', '/docs/home', 'roadmap', 'config.yaml', '#abschnitt', 'Ordner mit Leerzeichen.de']) {
      expect(webAddress(h), h).toBeNull();
      expect(isExternal(h), h).toBe(false);
    }
    expect(normalizeLinkInput(' www.google.de ')).toBe('https://www.google.de');
    expect(normalizeLinkInput('anna@example.org')).toBe('mailto:anna@example.org');
    expect(normalizeLinkInput('../notiz.md')).toBe('../notiz.md');
    expect(normalizeLinkInput('https://x.test')).toBe('https://x.test');
  });

  it('finds destinations with exact offsets (titles, brackets, references, encodings)', () => {
    const raw = '---\nt: 1\n---\n# H\n\n[a [b]](x/y.md "T") ![i](<bild mit leer.png>) [w](https://w.test) [r][ref] [p](a%20b.md#s) [q](f(1).md)\n\n[ref]: ../z.md\n';
    const links = extractLinks(raw);
    expect(links.map((l) => [l.kind, l.raw, raw.slice(l.start, l.end)])).toEqual([
      ['link', 'x/y.md', 'x/y.md'],
      ['image', '<bild mit leer.png>', '<bild mit leer.png>'],
      ['link', 'a%20b.md#s', 'a%20b.md#s'],
      ['link', 'f(1).md', 'f(1).md'],
      ['definition', '../z.md', '../z.md'],
    ]);
  });

  it('finds destinations when "](" appears in the text, title or destination', () => {
    const raw =
      '[a](x.md "see ](y)") [b](<x](y.md>) [c ](z)](c.md) [](e.md) ![i ](j)](k.png) ![m [n](o)](p.png) ![q \\]( r](s.png "t ](u)") ![`]( `](v.png)\n';
    expect(extractLinks(raw).map((l) => [l.kind, l.raw, raw.slice(l.start, l.end)])).toEqual([
      ['link', 'x.md', 'x.md'],
      ['link', '<x](y.md>', '<x](y.md>'],
      ['link', 'z', 'z'],
      ['link', 'e.md', 'e.md'],
      ['image', 'j', 'j'],
      ['image', 'p.png', 'p.png'],
      ['image', 's.png', 's.png'],
      ['image', 'v.png', 'v.png'],
    ]);
  });

  it('code spans in an image text: runs of other lengths and unclosed runs, ` ]( ` inside a span (linear search)', () => {
    // The second image's text runs up to `](z.png)`: its first span (one backtick) closes only after „![`` `“.
    const raw = '![``a ` ]( `` x](w.png) ![` a `` b ``` ]( ```](y.png) ![`` ` ```](z.png)\n';
    expect(extractLinks(raw).map((l) => l.raw)).toEqual(['w.png', 'z.png']);
  });

  it('counts <img src> written as HTML (resized images) as images, never HTML inside code', () => {
    const raw =
      '# H\n\n<img src="assets/logo.svg" width="220">\n\nText <img alt="x" src=\'assets/b%20c.png\' width="300">.\n\n' +
      '<p align="center"><img src="assets/e.svg" width="400"></p>\n\n`<img src="assets/code.png">`\n\n```html\n<img src="assets/block.png">\n```\n\n' +
      '<img src="https://example.org/x.png"> <img src="data:image/png;base64,AAAA">\n';
    expect(extractLinks(raw).map((l) => [l.kind, l.raw, raw.slice(l.start, l.end)])).toEqual([
      ['image', 'assets/logo.svg', 'assets/logo.svg'],
      ['image', 'assets/b%20c.png', 'assets/b%20c.png'],
      ['image', 'assets/e.svg', 'assets/e.svg'],
    ]);
  });

  it('formats replacements in the style of the original link', () => {
    // relative with extension
    expect(formatLink('../plan/a.md', 'docs/n.md', 'archiv/a.md', 'index.md', 'abs')).toBe('../archiv/a.md#abs');
    expect(formatLink('a.md', 'docs/n.md', 'docs/sub/a.md', 'index.md', null)).toBe('sub/a.md');
    // `#`, `?` and `%` in a name are part of the path, not an anchor, a query or an escape.
    for (const [raw, out] of [['a.md', 'Sitzung%20%233.md#t'], ['<a b.md>', '<Sitzung %233.md#t>'], ['a%20b.md', 'Sitzung%20%233.md#t']] as const) {
      expect(formatLink(raw, 'n.md', 'Sitzung #3.md', 'index.md', 't')).toBe(out);
      expect(resolveHref(out.replace(/^<|>$/g, ''), 'n.md')).toEqual({ path: 'Sitzung #3.md', anchor: 't' });
    }
    expect(formatLink('a.md', 'n.md', '100% sicher?.md', 'index.md', null)).toBe('100%25%20sicher%3F.md');
    expect(resolveHref('100%25%20sicher%3F.md', 'n.md')!.path).toBe('100% sicher?.md');
    // Wiki.js: absolute, extension-less, folder links stay folder links
    expect(formatLink('/docs/home', 'x.md', 'archiv/home.md', 'index.md', null)).toBe('/archiv/home');
    expect(formatLink('/docs', 'x.md', 'neu/home.md', 'home.md', null, true)).toBe('/neu');
    expect(formatLink('../docs/', 'a/x.md', 'b/index.md', 'index.md', null)).toBe('../b/');
    // encodings preserved
    expect(formatLink('<alt name.md>', 'n.md', 'neuer name.md', 'index.md', null)).toBe('<neuer name.md>');
    expect(formatLink('alt%20name.md', 'n.md', 'neu name.md', 'index.md', null)).toBe('neu%20name.md');
    expect(formatLink('alt.md', 'n.md', 'neu name.md', 'index.md', null)).toBe('neu%20name.md');
  });
});

describe('script links', () => {
  it('recognises javascript:, vbscript: and data: also with blanks or control characters in the scheme', () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:x', 'java\tscript:x', 'java\nscript:x', '\u0001javascript:x', 'vbscript:x', 'data:text/html,<script>x</script>']) {
      expect(isScriptUrl(href)).toBe(true);
    }
    for (const href of ['https://example.org', 'mailto:a@b.de', 'obsidian://open?vault=x', 'plan.md', 'www.javascript.com', '#javascript:x']) {
      expect(isScriptUrl(href)).toBe(false);
    }
  });
});
