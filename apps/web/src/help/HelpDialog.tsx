// The help window: the user manual (and the API reference) inside Kaveyl Wiki — chapters on the left,
// the chapter on the right, a search over everything. Opened from „?“ next to a setting, the
// editor's help button, Einstellungen → Hilfe, the command palette or F1.
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleHelp, Search, X } from 'lucide-react';
import { Input, Modal, PartLoading, Spinner, cx, useTabs, FormError } from '../ui';
import { t } from '../i18n';
import { lazyPart } from '../lazyPart';
import { EXAMPLE_FILES, LICENCE_FILES, anchorOf, fetchHelp, findAnchor, helpTarget, useHelp, type HelpChapter, type HelpDoc } from './help';

/** Chapters are shown by the editor's read-only view – it loads with the first help page, not with the app. */
const MarkdownView = lazyPart(
  () => import('../editor/MarkdownView').then((m) => m.MarkdownView),
  () => <FormError>{t('Dieser Teil der App konnte nicht geladen werden. Bitte die Seite neu laden.')}</FormError>,
);

const DOCS: [HelpDoc, string][] = [
  ['handbuch', t('Handbuch')],
  ['api', 'API & MCP'],
];

export function HelpDialog() {
  const state = useHelp((s) => s.open);
  const close = useHelp((s) => s.close);
  if (!state) return null;
  return <HelpWindow key={`${state.doc}:${state.anchor ?? ''}`} doc={state.doc} anchor={state.anchor} onClose={close} />;
}

function HelpWindow({ doc: initialDoc, anchor, onClose }: { doc: HelpDoc; anchor: string | null; onClose: () => void }) {
  const [doc, setDoc] = useState<HelpDoc>(initialDoc);
  const [where, setWhere] = useState<{ chapter: string | null; sub: string | null }>({ chapter: null, sub: anchor });
  const [q, setQ] = useState('');
  const help = useQuery({ queryKey: ['help', doc], queryFn: () => fetchHelp(doc), staleTime: 5 * 60_000 });
  const chapters = help.data?.chapters ?? NO_CHAPTERS;
  const content = useRef<HTMLDivElement>(null);

  // Resolve the requested anchor once the document is there.
  useEffect(() => {
    if (!help.data || where.chapter) return;
    const list = help.data.chapters;
    const hit = where.sub ? findAnchor(list, where.sub) : null;
    setWhere({ chapter: hit?.chapter.id ?? list[0]?.id ?? null, sub: hit?.sub ?? null });
  }, [help.data, where]);

  const chapter = chapters.find((c) => c.id === where.chapter) ?? null;
  /** Section to highlight: a #### anchor lights up the section it belongs to. */
  const activeSub = chapter?.deep.find((d) => d.id === where.sub)?.parent ?? where.sub;

  // Scroll to the section (or the top) when the chapter or section changes.
  useEffect(() => {
    if (!chapter) return;
    const box = content.current;
    if (!box) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {};
    const go = () => {
      const target = where.sub ? [...box.querySelectorAll('h2, h3, h4')].find((h) => anchorOf(chapter, h.textContent ?? '') === where.sub) : null;
      // Up to 3 s: the chapter view loads with the first help page (lazy), then renders.
      if (where.sub && !target && tries++ < 60) return void (timer = setTimeout(go, 50));
      if (!target) return void (box.scrollTop = 0);
      target.scrollIntoView({ block: 'start' });
      // Images above the heading load afterwards and push it down: keep it at the top while the text grows,
      // for a few seconds or until the reader scrolls themselves.
      const inner = box.firstElementChild;
      if (!inner) return;
      const ro = new ResizeObserver(() => target.scrollIntoView({ block: 'start' }));
      ro.observe(inner);
      const until = setTimeout(() => stop(), 3000);
      stop = () => {
        ro.disconnect();
        clearTimeout(until);
        for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) box.removeEventListener(e, stop);
      };
      for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) box.addEventListener(e, stop, { passive: true });
    };
    go();
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [chapter, where.sub]);

  // The search term stays until the reader changes it: the results remain to try the next one (owner 25.10.).
  const goto = (id: string, inDoc: HelpDoc = doc) => {
    if (inDoc !== doc) {
      setDoc(inDoc);
      setWhere({ chapter: null, sub: id || null });
      return;
    }
    const hit = findAnchor(chapters, id);
    if (hit) setWhere({ chapter: hit.chapter.id, sub: hit.sub });
  };

  /** Links inside the help: anchors, the other document; the licence files and the example agent open in a new tab (AD-064). Nothing else. */
  const onLink = (href: string) => {
    const target = helpTarget(href, doc);
    if (!target) {
      if (!LICENCE_FILES.includes(href) && !EXAMPLE_FILES.includes(href)) return false;
      window.open(href, '_blank', 'noopener,noreferrer');
      return true;
    }
    goto(target.anchor, target.doc);
    return true;
  };

  const results = useMemo(() => search(chapters, q), [chapters, q]);
  const tabs = useTabs(
    DOCS.map(([k]) => k),
    doc,
    (k) => (setDoc(k), setWhere({ chapter: null, sub: null })),
  );

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t('Hilfe')} wide="xl">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
            <Input className="pl-7 pr-7" placeholder={t('Hilfe durchsuchen …')} aria-label={t('Hilfe durchsuchen')} value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-faint hover:bg-hover hover:text-fg" aria-label={t('Suche leeren')} onClick={() => setQ('')}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs" {...tabs.list} aria-label={t('Dokument')}>
            {DOCS.map(([k, label]) => (
              <button key={k} {...tabs.tab(k)} className={cx('rounded-md px-2 py-1', doc === k ? 'bg-bg shadow-sm' : 'text-fg-muted')}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* Narrow screens: chapters as a list box instead of the side column. */}
        {!q && chapters.length > 0 && (
          <select
            aria-label={t('Kapitel')}
            className="h-8 rounded-md border border-line bg-bg px-2 text-sm md:hidden"
            value={where.chapter ?? ''}
            onChange={(e) => setWhere({ chapter: e.target.value, sub: null })}
          >
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
        {help.data && !help.data.translated && (
          <p className="rounded-md bg-subtle px-3 py-2 text-xs text-fg-muted">
            {t('Das Handbuch gibt es bisher nur auf Deutsch.')}
          </p>
        )}
        <div {...tabs.panel} className="grid min-h-[60vh] grid-cols-1 gap-4 md:grid-cols-[230px_minmax(0,1fr)]">
          <nav className={cx('max-h-[70vh] overflow-y-auto pr-1 text-sm', !q && 'hidden md:block')} aria-label={q ? t('Suchergebnisse') : t('Kapitel')}>
            {help.isPending && <Spinner />}
            <FormError>{help.isError && t('Die Hilfe konnte nicht geladen werden.')}</FormError>
            {q ? (
              results.length ? (
                <ul className="space-y-0.5">
                  {results.map((r) => {
                    const open = r.chapter.id === where.chapter && (r.sub ? r.sub === where.sub || r.sub === activeSub : !where.sub);
                    return (
                      <li key={`${r.chapter.id}:${r.sub ?? ''}`}>
                        <button
                          className={cx('w-full rounded-md px-2 py-1 text-left hover:bg-hover', open && 'bg-active')}
                          aria-current={open ? 'true' : undefined}
                          onClick={() => goto(r.sub ?? r.chapter.id)}
                        >
                          <span className="block truncate">{r.title}</span>
                          {r.sub && <span className="block truncate text-xs text-fg-faint">{r.chapter.title}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-2 text-fg-muted">{t('Nichts gefunden.')}</p>
              )
            ) : (
              <ul className="space-y-0.5">
                {chapters.map((c) => (
                  <li key={c.id}>
                    <button
                      className={cx('w-full rounded-md px-2 py-1 text-left hover:bg-hover', c.id === where.chapter && 'bg-active font-medium')}
                      aria-current={c.id === where.chapter ? 'true' : undefined}
                      onClick={() => setWhere({ chapter: c.id, sub: null })}
                    >
                      {c.title}
                    </button>
                    {c.id === where.chapter && c.subs.length > 0 && (
                      <ul className="mb-1 ml-3 border-l border-line pl-2">
                        {c.subs.map((s) => (
                          <li key={s.id}>
                            <button
                              className={cx('w-full rounded-md px-2 py-0.5 text-left text-xs hover:bg-hover', s.id === activeSub ? 'text-fg' : 'text-fg-muted')}
                              onClick={() => setWhere({ chapter: c.id, sub: s.id })}
                            >
                              {s.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <div ref={content} className="max-h-[70vh] min-w-0 overflow-y-auto pr-1" data-help-content>
            {chapter ? (
              <Suspense fallback={<PartLoading className="min-h-40" />}>
                <MarkdownView key={chapter.id} markdown={chapter.md} compact={false} label={t('Hilfe: {chapter}', { chapter: chapter.title })} onLink={onLink} />
              </Suspense>
            ) : (
              help.data && <p className="text-sm text-fg-muted">{t('Kapitel nicht gefunden.')}</p>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Stable while loading – a new [] each render would make every memo below recompute. */
const NO_CHAPTERS: HelpChapter[] = [];

function search(chapters: HelpChapter[], q: string) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hit = (title: string, text: string) => words.every((w) => title.toLowerCase().includes(w) || text.includes(w));
  const out: { chapter: HelpChapter; sub: string | null; title: string; score: number }[] = [];
  for (const c of chapters) {
    for (const s of c.subs) if (hit(s.title, s.text)) out.push({ chapter: c, sub: s.id, title: s.title, score: words.every((w) => s.title.toLowerCase().includes(w)) ? 2 : 1 });
    if (hit(c.title, c.text)) out.push({ chapter: c, sub: null, title: c.title, score: words.every((w) => c.title.toLowerCase().includes(w)) ? 3 : 0.5 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40);
}

/**
 * Small „? Hilfe“ that opens the help at a chapter or section. Its accessible name stays fixed
 * (`name`): it must not repeat words of the buttons next to it (tests and screen readers find
 * those by name); what it explains goes into the tooltip.
 */
export function HelpButton({
  anchor,
  label,
  name = t('Hilfe zu diesem Bereich'),
  doc = 'handbuch',
  className,
}: {
  anchor: string;
  label?: string;
  name?: string;
  doc?: HelpDoc;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={name}
      className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-hover hover:text-fg', className)}
      onClick={() => useHelp.getState().show(anchor, doc)}
      title={`${label ?? t('Hilfe')} (F1)`}
    >
      <CircleHelp className="h-3.5 w-3.5" />
      <span aria-hidden="true">{t('Hilfe')}</span>
    </button>
  );
}
