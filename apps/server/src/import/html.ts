// HTML in imported notes → Markdown: Kaveyl Wiki shows no raw HTML, so a web clipping or a resized picture would
// otherwise appear as source text. Scripts, styles, frames and forms are dropped with their content.
import { NodeHtmlMarkdown } from 'node-html-markdown';

const converter = new NodeHtmlMarkdown({
  bulletMarker: '-',
  codeBlockStyle: 'fenced',
  ignore: ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'form', 'button', 'input', 'select', 'textarea', 'head', 'title', 'meta', 'link'],
});

/** A whole HTML document or fragment as Markdown (trimmed). */
export const htmlToMarkdown = (html: string): string => converter.translate(html).trim();

/** `<img src="x" alt="y" width="120">` inside Markdown text → `![y](x)` (the size is lost; a picture without `src` stays). */
export function imgTagsToMarkdown(text: string): string {
  return text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, 'src');
    if (!src) return tag;
    const alt = (attr(tag, 'alt') ?? '').replace(/[[\]\\]/g, '\\$&');
    return `![${alt}](${/[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, encodeURIComponent)}>` : src})`;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  const v = m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
  // One pass: `&amp;quot;` stays `&quot;` (one after the other turned it into `"`, CodeQL js/double-escaping).
  return v === null ? null : v.replace(/&(amp|quot|#39);/g, (_, e: string) => (e === 'amp' ? '&' : e === 'quot' ? '"' : "'")).trim();
}
