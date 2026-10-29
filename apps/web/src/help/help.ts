// In-app help (owner 2026-10-11): the user manual (docs/BENUTZERHANDBUCH.md) and the API
// reference (docs/API.md) are the only source; the build copies them to /hilfe/… (vite.config.ts).
// They are split into chapters (##) with their sections (###; #### only as anchors), addressed by GitHub-style slugs —
// the same anchors the manual's own links use, so `#versionen-und-papierkorb` works everywhere.
// Other languages (AD-046): docs/i18n/<lang>/BENUTZERHANDBUCH.md and API.md, served as /hilfe/<lang>/…; a translated
// heading keeps the German anchor with an explicit id – `## Backup and restore {#backup}` – so every help anchor in
// the code works in every language. Without a translation the German manual is shown.
import { create } from 'zustand';
import { SOURCE_LANG, headingSlug } from '@kaveyl-wiki/core';
import { lang, t } from '../i18n';

export type HelpDoc = 'handbuch' | 'api';

/** Licence of Kaveyl Wiki and the third-party notices, served by every installation (AD-064). */
export const LICENCE_URL = '/LICENSE.txt';
export const NOTICES_URL = '/THIRD-PARTY-NOTICES.txt';
export const LICENCE_FILES = [LICENCE_URL, NOTICES_URL];
/** The example agent the manual offers (built into /hilfe/, apps/web/vite.config.ts) – opens in a new tab like the licences. */
export const EXAMPLE_FILES = ['/hilfe/beispiele/incident-agent/agent.mjs', '/hilfe/beispiele/incident-agent/README.md'];
/** Public source code (AGPL-3.0 §13: users of the service can get it). */
export const SOURCE_URL = 'https://github.com/kaveyl/wiki';

export interface HelpChapter {
  id: string;
  title: string;
  /** Markdown of the chapter, with picture paths made absolute. */
  md: string;
  /** Plain text for the search (lower case). */
  text: string;
  subs: { id: string; title: string; text: string }[];
  /** Headings below a section (####), e.g. the tabs of a settings group: anchor → its section. */
  deep: { id: string; title: string; parent: string | null }[];
}

/** A heading's text and anchor: an explicit `{#id}` at the end wins over the slug of the text. */
export function heading(raw: string): { title: string; id: string } {
  const m = /^(.*?)\s*\{#([\p{L}\p{N}_-]+)\}\s*$/u.exec(raw);
  return m ? { title: m[1]!.trim(), id: m[2]! } : { title: raw.trim(), id: slug(raw) };
}

/** Anchor of a rendered heading (by its text) – also for headings with an explicit id. */
export function anchorOf(chapter: HelpChapter, text: string): string {
  const title = text.trim();
  if (chapter.title === title) return chapter.id;
  return chapter.subs.find((s) => s.title === title)?.id ?? chapter.deep.find((d) => d.title === title)?.id ?? slug(title);
}

/** Heading → anchor as GitHub (and the manual's table of contents) builds it. */
export const slug = headingSlug;

const plain = (md: string) =>
  md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * The address of a spot in the help: opens the app with the help there. Links inside the help use it – an anchor
 * alone (`#…`) resolved against the address of the open note, so the browser showed (and a new tab opened) that note.
 */
export const helpHref = (anchor: string, doc: HelpDoc = 'handbuch') => `/?hilfe=${doc === 'api' ? 'api:' : ''}${encodeURIComponent(anchor)}`;

/** The spot a help link names: `/?hilfe=[api:]anchor`, `#anchor`, `API.md#anchor`; null for anything else. */
export function helpTarget(href: string, current: HelpDoc): { doc: HelpDoc; anchor: string } | null {
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const q = /^\/?\?hilfe=(api:)?(.*)$/.exec(href);
  if (q) return { doc: q[1] ? 'api' : 'handbuch', anchor: decode(q[2] ?? '') };
  const m = /^(?:(?:\.\/)?(BENUTZERHANDBUCH|API)\.md)?#?(.*)$/i.exec(href);
  if (!m || (!m[1] && !href.startsWith('#'))) return null;
  return { doc: m[1] ? (m[1].toUpperCase() === 'API' ? 'api' : 'handbuch') : current, anchor: decode(m[2] ?? '') };
}

/** Splits a manual into chapters; leaves out the frontmatter, the title and its table of contents. */
export function parseHelp(raw: string, doc: HelpDoc = 'handbuch'): HelpChapter[] {
  const body = raw
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/\]\(handbuch\//g, '](/hilfe/handbuch/')
    // Links to a spot in the help get the help's own address (see helpHref).
    .replace(/\]\(((?:(?:\.\/)?(?:BENUTZERHANDBUCH|API)\.md)?#[^)\s]*|(?:\.\/)?(?:BENUTZERHANDBUCH|API)\.md)\)/gi, (_m, href: string) => {
      const target = helpTarget(href.includes('#') ? href : `${href}#`, doc)!;
      return `](${helpHref(target.anchor, target.doc)})`;
    });
  const chapters: HelpChapter[] = [];
  let cur: HelpChapter | null = null;
  let inCode = false;
  const lines: string[] = [];
  const flush = () => {
    if (cur) {
      cur.md = lines.join('\n').trim();
      cur.text = plain(cur.md);
      chapters.push(cur);
    }
    lines.length = 0;
  };
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) inCode = !inCode;
    const h2 = !inCode && /^## (.+)$/.exec(line);
    const h3 = !inCode && /^### (.+)$/.exec(line);
    if (h2) {
      flush();
      const h = heading(h2[1]!);
      cur = { id: h.id, title: h.title, md: '', text: '', subs: [], deep: [] };
      lines.push(`## ${h.title}`);
      continue;
    }
    if (!cur) continue;
    const h4 = !inCode && /^#### (.+)$/.exec(line);
    if (h3) {
      const h = heading(h3[1]!);
      cur.subs.push({ id: h.id, title: h.title, text: '' });
      lines.push(`### ${h.title}`);
    } else if (h4) {
      const h = heading(h4[1]!);
      cur.deep.push({ id: h.id, title: h.title, parent: cur.subs.at(-1)?.id ?? null });
      lines.push(`#### ${h.title}`);
    } else lines.push(line);
  }
  flush();
  // Section texts for the search: everything from its heading to the next one.
  for (const c of chapters) {
    const parts = c.md.split(/^### .+$/m);
    c.subs.forEach((s, i) => (s.text = plain(parts[i + 1] ?? '')));
  }
  return chapters.filter((c) => c.id !== 'inhalt');
}

/** Chapter and (optional) section an anchor points at. */
export function findAnchor(chapters: HelpChapter[], id: string): { chapter: HelpChapter; sub: string | null } | null {
  for (const c of chapters) {
    if (c.id === id) return { chapter: c, sub: null };
    if (c.subs.some((s) => s.id === id)) return { chapter: c, sub: id };
  }
  for (const c of chapters) if (c.deep.some((d) => d.id === id)) return { chapter: c, sub: id };
  return null;
}

/** Where the help is open: which document and anchor; null = closed. */
interface HelpState {
  open: { doc: HelpDoc; anchor: string | null } | null;
  show: (anchor?: string | null, doc?: HelpDoc) => void;
  close: () => void;
}

export const useHelp = create<HelpState>((set) => ({
  open: null,
  show: (anchor = null, doc = 'handbuch') => set({ open: { doc, anchor } }),
  close: () => set({ open: null }),
}));

/** Opens the help at a chapter or section of the manual (or the API reference). */
export const openHelp = (anchor?: string | null, doc: HelpDoc = 'handbuch') => useHelp.getState().show(anchor, doc);

/** The manual in the interface's language if there is one (`translated`), else the German one. */
export async function fetchHelp(doc: HelpDoc): Promise<{ chapters: HelpChapter[]; translated: boolean }> {
  if (lang !== SOURCE_LANG) {
    const res = await fetch(`/hilfe/${lang}/${doc}.md`, { cache: 'no-cache' }).catch(() => null);
    const text = res?.ok ? await res.text() : '';
    // A missing file may come back as the app's index.html.
    if (text && !text.trimStart().startsWith('<')) return { chapters: parseHelp(text, doc), translated: true };
  }
  const res = await fetch(`/hilfe/${doc}.md`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(t('Hilfe nicht gefunden ({status})', { status: res.status }));
  return { chapters: parseHelp(await res.text(), doc), translated: lang === SOURCE_LANG };
}

/** The help anchor of the setting or dialog in front (`data-help` on its content), if any. */
export function helpAnchorInFront(): string | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const top = dialogs.at(-1);
  if (!top) return null;
  // The innermost hint wins (a settings tab), else the dialog's own.
  return [...top.querySelectorAll<HTMLElement>('[data-help]')].at(-1)?.dataset.help ?? top.dataset.help ?? null;
}
