// Links that lead nowhere are marked in the note while writing (red, dashed, „Ziel fehlt“), with the
// same rule the nightly check uses (server: /api/link-check). The file is never changed by this.
import { Extension, type Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMDocNode } from '@tiptap/pm/model';
import { isExternal } from '@kaveyl-wiki/core';
import { t } from '../i18n';

const KEY = new PluginKey<Set<string>>('brokenLinks');

/** Local link targets written in the note (what the server is asked about). */
export function localHrefs(doc: PMDocNode): string[] {
  const out = new Set<string>();
  doc.descendants((node) => {
    for (const m of node.marks) {
      const href = m.type.name === 'link' ? String(m.attrs.href ?? '') : '';
      if (href && !isExternal(href) && !href.startsWith('#')) out.add(href);
    }
  });
  return [...out];
}

function decorate(doc: PMDocNode, broken: Set<string>): DecorationSet {
  if (!broken.size) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((m) => m.type.name === 'link' && broken.has(String(m.attrs.href ?? '')));
    if (link) decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'link-broken', 'data-broken-link': '', title: t('Ziel fehlt – Klick: Notiz anlegen oder Link bearbeiten') }));
  });
  return DecorationSet.create(doc, decos);
}

export const BrokenLinks = Extension.create({
  name: 'brokenLinks',
  addProseMirrorPlugins() {
    return [
      new Plugin<Set<string>>({
        key: KEY,
        state: {
          init: () => new Set(),
          apply: (tr, value) => (tr.getMeta(KEY) as Set<string> | undefined) ?? value,
        },
        props: {
          decorations: (state) => decorate(state.doc, KEY.getState(state) ?? new Set()),
        },
      }),
    ];
  },
});

/** Sets which hrefs of the note lead nowhere (redraws the marks; no change to the document). */
export function setBrokenLinks(editor: Editor, broken: string[]) {
  if (editor.isDestroyed) return;
  const cur = KEY.getState(editor.state);
  if (cur && cur.size === broken.length && broken.every((h) => cur.has(h))) return;
  editor.view.dispatch(editor.state.tr.setMeta(KEY, new Set(broken)).setMeta('addToHistory', false));
}
