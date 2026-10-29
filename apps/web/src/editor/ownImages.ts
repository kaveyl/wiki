// Pictures from other hosts in AI answers are shown as links instead of being loaded: text in a
// note can steer the model, and an image URL would carry data to that host without a click (sec-003).
// Notes themselves are not filtered — there users may embed outside pictures on purpose.
import { isScriptUrl, type PMNode } from '@kaveyl-wiki/core';

/** Loads from this app only: same origin (relative paths too), data: or blob:. */
function isOwn(src: string, origin: string): boolean {
  try {
    const url = new URL(src, origin);
    return url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === origin;
  } catch {
    return false;
  }
}

export function withoutForeignImages(doc: PMNode, origin: string): PMNode {
  const clean = (node: PMNode): PMNode => {
    if (node.type === 'image') {
      const src = String(node.attrs?.src ?? '');
      if (isOwn(src, origin)) return node;
      const marks = node.marks ?? [];
      const linked = marks.some((m) => m.type === 'link') || isScriptUrl(src)
        ? marks
        : [...marks, { type: 'link', attrs: { href: src, title: null } }];
      const text = String(node.attrs?.alt || src || '?');
      return linked.length ? { type: 'text', text, marks: linked } : { type: 'text', text };
    }
    return node.content ? { ...node, content: node.content.map(clean) } : node;
  };
  return clean(doc);
}
