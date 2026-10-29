// Resolves links and image sources inside a note to mount-relative paths, finds them in
// the source text and formats replacements. Supports relative links with `.md`
// (VS Code/Gitea style) and Wiki.js-style absolute, extension-less links (`/docs/home`).
// Shared by the web app (link clicks) and the server (link index, repair).
// SEE-DOC: docs/PLAN.md §2.5, §2.5a, DECISION: AD-006

// Finding links in a whole note (needs the Markdown parser) is in linkScan.ts – the web app's shell uses the
// helpers here without loading the parser.

export interface LinkTarget {
  path: string;
  anchor: string | null;
}

/** File endings that make „name.xyz“ a file next to the note, not a web address. */
const FILE_ENDING =
  /\.(md|markdown|txt|png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|zip|gz|tgz|tar|7z|rar|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|tsv|json|ya?ml|toml|ini|conf|cfg|env|xml|html?|css|js|mjs|ts|tsx|py|sh|ps1|bat|sql|log|bak|db|drawio|excalidraw|mp3|mp4|m4a|wav|mov|webm|age)$/i;

/**
 * A web address typed without its scheme (`www.google.de`, `example.org/doku`) as the full URL,
 * else null. Without this such a link counts as a file next to the note (owner 2026-10-11).
 */
export function webAddress(href: string): string | null {
  const h = href.trim();
  if (!h || /\s/.test(h) || isSchemeOrProtocolRelative(h)) return null;
  if (/^www\.[^./]/i.test(h)) return `https://${h}`;
  const host = h.split(/[/?#]/)[0]!;
  if (/^([a-z0-9-]+\.)+[a-z]{2,24}(:\d{1,5})?$/i.test(host) && !FILE_ENDING.test(host)) return `https://${h}`;
  return null;
}

const isSchemeOrProtocolRelative = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');

/** Outside the wiki: a URL with scheme (https:, mailto: …), `//host/…` or a bare web address. */
export const isExternal = (href: string) => isSchemeOrProtocolRelative(href) || webAddress(href) !== null;

/** What to open for an external link: bare web addresses get `https://`. */
export const externalUrl = (href: string) => webAddress(href) ?? href;

/**
 * Links that would run code instead of opening a page (`javascript:`, `vbscript:`, `data:`) – never opened on a
 * click, even if one gets past the editor. Browsers ignore blanks and control characters inside the scheme.
 */
export const isScriptUrl = (href: string) => /^(javascript|vbscript|data):/i.test(href.replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000\ufeff]/g, ''));

/**
 * What a user typed as link target, as it goes into the note: `www.…`/`domain.tld/…` → `https://…`,
 * `name@domain.tld` → `mailto:…`; paths and URLs stay as they are.
 */
export function normalizeLinkInput(input: string): string {
  const h = input.trim();
  if (/^[^\s@/:]+@[^\s@/]+\.[a-z]{2,24}$/i.test(h)) return `mailto:${h}`;
  return webAddress(h) ?? h;
}

export function normalizePath(parts: string[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join('/');
}

/** Mount-relative path for `href` written in the note at `notePath`, or null if external/invalid. */
export function resolveHref(href: string, notePath: string): LinkTarget | null {
  if (!href || isExternal(href)) return null;
  const hashIdx = href.indexOf('#');
  const anchor = hashIdx >= 0 ? href.slice(hashIdx + 1) : null;
  let target = (hashIdx >= 0 ? href.slice(0, hashIdx) : href).split('?')[0]!;
  try {
    target = decodeURIComponent(target);
  } catch {
    /* keep as is */
  }
  if (!target) return { path: notePath, anchor };
  const base = target.startsWith('/') ? [] : notePath.split('/').slice(0, -1);
  const path = normalizePath([...base, ...target.split('/')]);
  return path === null ? null : { path, anchor };
}

/** Candidate note paths for a link target (adds `.md` / folder note for extension-less links). */
export function noteCandidates(path: string, folderNote: string): string[] {
  if (/\.md$/i.test(path)) return [path];
  if (!path) return [folderNote];
  return [`${path}.md`, `${path}/${folderNote}`];
}

export type LinkKind = 'link' | 'image' | 'definition';

/**
 * Files whose existence makes a link lead somewhere – the one rule for „Link ins Leere“ (nightly check and
 * the marks in the editor, AD-037). A link may leave out `.md` or name a folder (its folder note);
 * an image is shown from exactly its file, so a note of that name does not count.
 */
export function linkCandidates(path: string, kind: LinkKind, folderNote: string): string[] {
  const all = kind === 'image' ? [path] : [path, ...noteCandidates(path, folderNote)];
  return [...new Set(all)].filter(Boolean);
}

/** A local link as written in a file, with the exact character range of its destination. */
export interface LocalLink {
  kind: LinkKind;
  /** Destination as written (may be `<…>`-wrapped or percent-encoded). */
  raw: string;
  /** Destination as Markdown understands it (decoded, without angle brackets). */
  href: string;
  /** Offsets of `raw` in the whole file text (frontmatter included). */
  start: number;
  end: number;
}

/** `src` values of `<img …>` tags in a piece of raw HTML, with their offset in it (quotes excluded). */
export function htmlImageSources(html: string): { raw: string; index: number }[] {
  const out: { raw: string; index: number }[] = [];
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    out.push({ raw: value, index: m.index! + m[0].length - value.length - (quoted ? 1 : 0) });
  }
  return out;
}

/** A link destination without its `<…>` brackets. */
export const unwrapDestination = (raw: string) => (raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw);

/** decodeURI that keeps the text when it is no valid escape. */
export function decodeUriSafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** How a link is written — repairs keep the style of the file (docs/PLAN.md §2.5a). */
export interface LinkStyle {
  absolute: boolean;
  /** `.md` written out (false for Wiki.js-style extension-less links). */
  extension: boolean;
  /** Link to a folder note written as the folder (`../docs/` or `/docs`). */
  folder: boolean;
}

export function linkStyle(href: string): LinkStyle {
  const path = href.split('#')[0]!.split('?')[0]!;
  return { absolute: path.startsWith('/'), extension: /\.md$/i.test(path), folder: path === '' || path.endsWith('/') };
}

/**
 * Destination text for a link from `fromNote` to `targetPath` in the given style, with the
 * anchor and the original's encoding (`<…>` or percent-encoding) preserved.
 */
export function formatLink(
  rawOriginal: string,
  fromNote: string,
  targetPath: string,
  folderNote: string,
  anchor: string | null,
  /** The original pointed at a folder note via the folder name (`/docs` → `docs/home.md`). */
  wasFolderLink = false,
): string {
  const original = unwrapDestination(rawOriginal);
  const style = linkStyle(decodeUriSafe(original));
  let target = targetPath;
  const isFolderNote = target === folderNote || target.endsWith(`/${folderNote}`);
  const asFolder = isFolderNote && (style.folder || wasFolderLink);
  if (asFolder) target = target.slice(0, -folderNote.length);
  else if (!style.extension) target = target.replace(/\.md$/i, '');
  if (asFolder && !style.folder) target = target.replace(/\/$/, '');
  let path: string;
  if (style.absolute) path = `/${target}`;
  else {
    const fromDir = fromNote.split('/').slice(0, -1);
    const to = target.split('/');
    let common = 0;
    while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common]) common++;
    const up = fromDir.length - common;
    path = [...Array<string>(up).fill('..'), ...to.slice(common)].join('/');
    if (asFolder && !path) path = style.folder ? './' : '.';
  }
  // `#`, `?` and `%` in a name would end the path or start an escape – always encoded (`Sitzung #3.md`).
  const reserved = (p: string) => p.replace(/[%#?]/g, (c) => encodeURIComponent(c));
  const hash = anchor !== null ? `#${anchor}` : '';
  if (rawOriginal.startsWith('<')) return `<${reserved(path)}${hash}>`;
  // Keep percent-encoding if the original used it; otherwise only encode what would break the link.
  if (/%[0-9a-f]{2}/i.test(original)) return `${encodeURI(path).replace(/[#?]/g, (c) => encodeURIComponent(c))}${anchor !== null ? `#${encodeURI(anchor)}` : ''}`;
  return `${reserved(path)}${hash}`.replace(/[ ()<>]/g, (c) => encodeURIComponent(c));
}

/** Heading → anchor as GitHub/Gitea (and Kaveyl Wiki's manual) build it. */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}
