// AI in the editor and „Frag die Wissensbasis“ (AD-024), the latter as an agent that looks
// things up itself (AD-026). Results are always suggestions: only the user's click changes notes.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DM from '@radix-ui/react-dropdown-menu';
import type { Editor } from '@tiptap/react';
import { ArrowRight, Brain, Check, Columns2, Copy, Plus, ExternalLink, FileCode2, FilePen, FilePlus, History, ListChecks, MessageCircleQuestion, PanelTop, Sparkles, Trash2, X } from 'lucide-react';
import { loadMarkdown, saveMarkdown, type PMNode } from '@kaveyl-wiki/core';
import { MarkdownView } from '../editor/MarkdownView';
import { api, errorText, type AiAction, type AiChatMessage, type AiProposal, type AiScope, type AiSource } from '../api';
import { toast } from '../toast';
import { t, tn } from '../i18n';
import { DiffView } from '../shell/history';
import { useWorkspace } from '../store';
import { fullPath, noteName, noteNameIn } from '../names';
import { copyRich, copyWithToast } from '../clipboard';
import { useActions } from '../shell/actions';
import { useAi, useAiAvailable, type Suggestion } from './aiStore';
import { Button, ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger, DropdownContent, Modal, Spinner, cx, confirmDialog, promptDialog } from '../ui';

export const ACTION_LABEL: Record<AiAction, string> = {
  rewrite: t('Umformulieren'),
  shorten: t('Kürzen'),
  expand: t('Ausbauen'),
  grammar: t('Rechtschreibung korrigieren'),
  translate: t('Übersetzen …'),
  summarize: t('Zusammenfassen'),
  continue: t('Weiterschreiben'),
  custom: t('Eigene Anweisung …'),
};


/** Runs an action on the selection (or the whole note) and opens the suggestion dialog. */
export async function runAiAction(editor: Editor | null, mountId: string, path: string, action: AiAction) {
  let instruction: string | undefined;
  let language: string | undefined;
  if (action === 'custom') {
    instruction = (
      await promptDialog(t('Eigene Anweisung an die KI'), {
        label: t('Was soll die KI mit dem Text machen?'),
        placeholder: t('z. B. in Stichpunkte fassen'),
        required: true,
        confirmLabel: t('Los'),
        help: 'ki-im-editor',
      })
    )?.trim();
    if (!instruction) return;
  }
  if (action === 'translate') {
    language = (
      await promptDialog(t('Übersetzen'), {
        label: t('In welche Sprache?'),
        // The chosen name goes to the AI as it is – any language's name works there.
        value: t('Englisch'),
        suggestions: [t('Englisch'), t('Deutsch'), t('Französisch'), t('Spanisch'), t('Italienisch'), t('Niederländisch'), t('Polnisch')],
        required: true,
        confirmLabel: t('Übersetzen'),
        help: 'ki-im-editor',
      })
    )?.trim();
    if (!language) return;
  }
  const sel = editor?.state.selection;
  const hasSel = !!sel && !sel.empty && action !== 'summarize' && action !== 'continue';
  // „Weiterschreiben“ gets the note as Markdown (lists, code, headings stay recognisable).
  const text = hasSel
    ? editor!.state.doc.textBetween(sel!.from, sel!.to, '\n\n')
    : action === 'continue' && editor
      ? saveMarkdown(loadMarkdown('').source, editor.getJSON() as PMNode).slice(-6000)
      : '';
  const base: Suggestion = {
    action,
    mountId,
    path,
    original: hasSel ? text : '',
    from: hasSel ? sel!.from : (editor?.state.doc.content.size ?? 0),
    to: hasSel ? sel!.to : (editor?.state.doc.content.size ?? 0),
    editor,
    docAtRequest: editor?.state.doc,
    result: null,
    error: null,
    meta: '',
  };
  useAi.setState({ suggestion: base });
  try {
    const res = await api.aiTransform({ action, mountId, path, text: text || undefined, instruction, language });
    if (useAi.getState().suggestion === base) useAi.setState({ suggestion: { ...base, result: res.text, meta: `${res.provider} · ${res.model}` } });
  } catch (e) {
    if (useAi.getState().suggestion === base) useAi.setState({ suggestion: { ...base, error: errorText(e) } });
  }
}

/** The note ends in an unfinished sentence (no closing punctuation) or a bare „3.“ of a numbering. */
function midSentence(editor: Editor) {
  const last = editor.state.doc.lastChild;
  const text = last?.type.name === 'paragraph' ? last.textContent.trim() : '';
  return /[\p{L}\p{N},]$/u.test(text) || /^\d+[.)]$/.test(text);
}

/** Markdown → editor content; a single paragraph stays inline (fits into a sentence). */
function contentOf(markdown: string) {
  const doc = loadMarkdown(markdown).doc as { content?: { type: string; content?: unknown[] }[] };
  const blocks = doc.content ?? [];
  return blocks.length === 1 && blocks[0]!.type === 'paragraph' ? (blocks[0]!.content ?? []) : blocks;
}

export function AiSuggestionDialog() {
  const s = useAi((x) => x.suggestion);
  const close = useAi((x) => x.close);
  if (!s) return null;
  const editor = s.editor;
  const unchanged = !!editor && editor.state.doc === s.docAtRequest;
  const insert = (mode: 'replace' | 'after' | 'end' | 'start') => {
    if (!editor || !s.result) return;
    const content = contentOf(s.result);
    const chain = editor.chain().focus();
    if (mode === 'replace' && unchanged) chain.insertContentAt({ from: s.from, to: s.to }, content).run();
    else if (mode === 'after' && unchanged) chain.insertContentAt(s.to, content).run();
    else if (mode === 'start') chain.insertContentAt(0, loadMarkdown(s.result).doc.content ?? []).run();
    else if (s.action === 'continue' && midSentence(editor)) {
      // The note breaks off mid-sentence: the first paragraph of the continuation finishes it.
      const [first, ...rest] = (loadMarkdown(s.result).doc.content ?? []) as { type: string; content?: { type: string; text?: string }[] }[];
      const end = editor.state.doc.content.size;
      if (first?.type === 'paragraph' && first.content?.length) {
        const lead = first.content[0]!;
        if (lead.type === 'text' && lead.text && !/^[\s,.;:!?)]/.test(lead.text)) lead.text = ` ${lead.text}`;
        chain.insertContentAt(end - 1, first.content);
        if (rest.length) chain.insertContentAt(end + first.content.reduce((n, c) => n + (c.text?.length ?? 1), 0), rest);
        chain.run();
      } else chain.insertContentAt(end, loadMarkdown(s.result).doc.content ?? []).run();
    } else chain.insertContentAt(editor.state.doc.content.size, loadMarkdown(s.result).doc.content ?? []).run();
    close();
  };
  const selection = !!s.original;
  return (
    <Modal help="ki-im-editor" open onOpenChange={(o) => !o && close()} title={t('KI: {action}', { action: ACTION_LABEL[s.action].replace(' …', '') })} wide>
      <div className="space-y-3 text-sm">
        {selection && (
          <div>
            <div className="mb-1 text-xs font-medium text-fg-muted">{t('Markierter Text')}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-muted p-2 font-sans text-[0.8125rem]">{s.original}</pre>
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-fg-muted">
            {t('Vorschlag')} {s.meta && <span className="font-normal text-fg-faint">({s.meta})</span>}
          </div>
          {s.error ? (
            <p className="rounded-md border border-danger/40 p-2 text-danger" role="alert">
              {s.error}
            </p>
          ) : s.result === null ? (
            <div className="flex items-center gap-2 p-2 text-fg-muted">
              <Spinner className="h-4 w-4" /> {t('Die KI arbeitet …')}
            </div>
          ) : (
            <div className="max-h-[45vh] overflow-auto rounded-md border border-accent/50 bg-accent-soft p-2">
              <MarkdownView markdown={s.result} label={t('KI-Vorschlag')} />
            </div>
          )}
        </div>
        {s.result && /\[[^\]\d][^\]]*\](?!\()/.test(s.result) && (
          <p className="text-xs text-fg-muted">{t('Angaben in [eckigen Klammern] sind Platzhalter der KI – bitte ausfüllen.')}</p>
        )}
        {selection && !unchanged && s.result && <p className="text-xs text-warn">{t('Die Notiz wurde inzwischen geändert – Ersetzen ist nicht mehr möglich, Einfügen am Ende schon.')}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {s.result && <Button size="sm" variant="ghost" onClick={() => void copyWithToast(s.result!, 'Vorschlag')}>{t('Kopieren')}</Button>}
          <Button size="sm" variant="ghost" onClick={close}>
            {t('Verwerfen')}
          </Button>
          {s.result && editor?.isEditable && (
            <>
              {selection ? (
                <>
                  <Button size="sm" onClick={() => insert(unchanged ? 'after' : 'end')}>
                    {t('Darunter einfügen')}
                  </Button>
                  <Button size="sm" variant="primary" disabled={!unchanged} onClick={() => insert('replace')}>
                    {t('Ersetzen')}
                  </Button>
                </>
              ) : s.action === 'summarize' ? (
                <>
                  <Button size="sm" onClick={() => insert('end')}>
                    {t('Am Ende einfügen')}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => insert('start')}>
                    {t('Am Anfang einfügen')}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" onClick={() => insert('end')}>
                  {t('Am Ende einfügen')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** „KI“ button with the actions, for the selection menu and the toolbar. */
export function AiMenuButton({ editor, mountId, path, className }: { editor: Editor; mountId: string; path: string; className?: string }) {
  const available = useAiAvailable();
  if (!available) return null;
  const actions: AiAction[] = editor.state.selection.empty ? ['continue', 'summarize'] : ['rewrite', 'shorten', 'expand', 'grammar', 'translate', 'custom'];
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button className={cx('flex h-7 items-center gap-1 rounded px-1.5 text-[0.8125rem] text-accent hover:bg-hover', className)} aria-label={t('KI')} title={t('KI-Assistent')} onMouseDown={(e) => e.preventDefault()}>
          <Sparkles className="h-4 w-4" /> {t('KI')}
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DropdownContent align="start" sideOffset={4} className="z-50">
          {actions.map((a) => (
            <DM.Item key={a} onSelect={() => void runAiAction(editor, mountId, path, a)} className="cursor-default rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover">
              {ACTION_LABEL[a]}
            </DM.Item>
          ))}
          <DM.Separator className="my-1 h-px bg-line" />
          {/* The same dialog as ✦ in the sidebar, with this note as the default scope. */}
          <DM.Item
            onSelect={() => useAi.getState().openAsk({ kind: 'note', mountId, path })}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover"
          >
            <MessageCircleQuestion className="h-4 w-4 text-fg-muted" /> {t('KI fragen …')}
          </DM.Item>
        </DropdownContent>
      </DM.Portal>
    </DM.Root>
  );
}

const SCOPE_LABEL: Record<AiScope['kind'], string> = {
  note: t('Diese Notiz'),
  folder: t('Dieser Ordner'),
  source: t('Diese Quelle'),
  all: t('Alles Freigegebene'),
  general: t('Allgemein (ohne Wiki)'),
};

/**
 * „Frag die Wissensbasis“: the AI agent (AD-026) searches and reads released notes itself and
 * may propose changes; steps show while it works. Earlier chats on the left.
 */
export function AiAskDialog() {
  const ask = useAi((x) => x.ask);
  const close = useAi((x) => x.close);
  const current = useAi((x) => x.current);
  const qc = useQueryClient();
  const [scope, setScope] = useState<AiScope>({ kind: 'all' });
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{ question: string; steps: string[]; proposals: AiProposal[]; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chats = useQuery({ queryKey: ['ai-chats'], queryFn: api.aiChats, enabled: !!ask });
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts, enabled: !!ask });
  const chat = useQuery({ queryKey: ['ai-chat', chatId], queryFn: () => api.aiChat(chatId!), enabled: !!ask && !!chatId });
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ask) return;
    setScope(ask.scope);
    setChatId(ask.chatId);
    setQuestion('');
    setError(null);
  }, [ask]);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would take as cleanup.
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat.data, busy, live]);
  if (!ask) return null;

  // Scope choices relative to the active note.
  const here = current ? { mountId: current.mountId, path: current.path } : null;
  const folder = here ? here.path.split('/').slice(0, -1).join('/') : '';
  const options: AiScope[] = [
    ...(here ? [{ kind: 'note' as const, ...here }] : []),
    ...(here && folder ? [{ kind: 'folder' as const, mountId: here.mountId, path: folder }] : []),
    ...(here ? [{ kind: 'source' as const, mountId: here.mountId }] : []),
    { kind: 'all' },
    { kind: 'general' },
  ];
  // Opened for another place (✦ in the tree): that place is a choice too.
  if (!options.some((o) => JSON.stringify(o) === JSON.stringify(scope))) options.unshift(scope);
  const sourceName = (id: string) => mounts.data?.find((m) => m.id === id)?.name;
  const scopeText = (o: AiScope) =>
    SCOPE_LABEL[o.kind] +
    (o.kind === 'note' || o.kind === 'folder' ? ` (${o.kind === 'note' ? noteNameIn(o.mountId, o.path) : noteName(o.path)})` : o.kind === 'source' && sourceName(o.mountId) ? ` (${sourceName(o.mountId)})` : '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setLive({ question: q, steps: [], proposals: [], text: '' });
    let done: string | null = null;
    let failed: string | null = null;
    try {
      await api.aiAgent({ question: q, scope, chatId }, (ev) => {
        // Text before a tool call was only thinking aloud: a step replaces it.
        if (ev.type === 'step') setLive((l) => l && { ...l, steps: [...l.steps, ev.label], text: '' });
        else if (ev.type === 'delta') setLive((l) => l && { ...l, text: l.text + ev.text });
        else if (ev.type === 'proposal') setLive((l) => l && { ...l, proposals: [...l.proposals, ev.proposal] });
        else if (ev.type === 'answer') done = ev.chatId;
        else if (ev.type === 'error') failed = ev.error;
      });
      if (failed) setError(failed);
      if (done) {
        const id: string = done;
        // Load the stored chat first, then swap the live view for it in one go (no flash, no duplicates).
        await qc.fetchQuery({ queryKey: ['ai-chat', id], queryFn: () => api.aiChat(id) });
        setQuestion('');
        setLive(null);
        setChatId(id);
        void qc.invalidateQueries({ queryKey: ['ai-chats'] });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setLive(null);
    }
  };
  const messages = chatId ? (chat.data?.messages ?? []) : [];
  const proposals = chat.data?.proposals ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: ['ai-chat', chatId] });
  const removeChat = (c: { id: string; title: string }) =>
    void confirmDialog(t('Chat „{title}“ endgültig löschen? Das lässt sich nicht rückgängig machen.', { title: c.title }), { confirmLabel: t('Löschen'), danger: true }).then(
      (ok) => ok && void api.deleteAiChat(c.id).then(() => (c.id === chatId && setChatId(undefined), qc.invalidateQueries({ queryKey: ['ai-chats'] }))),
    );
  const cleared = () => (setChatId(undefined), void qc.invalidateQueries({ queryKey: ['ai-chats'] }));
  const openChat = chats.data?.find((c) => c.id === chatId);
  return (
    <Modal help="frag-die-wissensbasis" open onOpenChange={(o) => !o && close()} title={t('Frag die Wissensbasis')} wide="xl">
      <div className="flex h-[66vh] gap-4 text-sm">
        {/* Fixed head and foot, only the list scrolls: nothing slides under the buttons. */}
        <aside className="hidden w-52 shrink-0 flex-col gap-2 border-r border-line pr-3 md:flex" aria-label={t('Frühere Chats')}>
          <Button size="sm" className="justify-start" onClick={() => setChatId(undefined)}>
            <Plus className="h-3.5 w-3.5" /> {t('Neuer Chat')}
          </Button>
          <div className="-mr-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
            {(chats.data ?? []).map((c) => (
              <div key={c.id} className={cx('group flex items-center rounded-md', c.id === chatId ? 'bg-active' : 'hover:bg-hover')}>
                <button className="min-w-0 flex-1 truncate px-2 py-1 text-left" title={c.title} onClick={() => (setChatId(c.id), setScope(c.scope))}>
                  {c.title}
                </button>
                <button
                  className="hidden px-1 text-fg-faint hover:text-danger group-hover:block [@media(hover:none)]:block"
                  aria-label={t('Chat löschen')}
                  onClick={() => removeChat(c)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          {!!chats.data?.length && <ClearHistory onCleared={cleared} />}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Narrow screens: the chat list above the conversation instead of the side column. */}
          <div className="mb-2 flex items-center gap-2 md:hidden">
            <select
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2"
              aria-label={t('Chat auswählen')}
              value={openChat?.id ?? ''}
              onChange={(e) => {
                const c = chats.data?.find((x) => x.id === e.target.value);
                if (c) (setChatId(c.id), setScope(c.scope));
                else setChatId(undefined);
              }}
            >
              <option value="">{t('Neuer Chat')}</option>
              {(chats.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <Button className="shrink-0 px-2" aria-label={t('Neuer Chat')} title={t('Neuer Chat')} onClick={() => setChatId(undefined)}>
              <Plus className="h-4 w-4" />
            </Button>
            {openChat && (
              <Button className="shrink-0 px-2" aria-label={t('Chat löschen')} title={t('Chat löschen')} onClick={() => removeChat(openChat)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            {!!chats.data?.length && <ClearHistory compact onCleared={cleared} />}
          </div>
          <div className="mb-2 flex items-center gap-2">
            <span className="shrink-0 text-fg-muted">{t('Bezug:')}</span>
            {/* A chat keeps its scope (it comes back with the chat): shown as text, a new chat changes it (owner 21.10.). */}
            {chatId || busy ? (
              <>
                <span className="min-w-0 truncate font-medium" data-testid="ai-scope">
                  {scopeText(scope)}
                </span>
                {chatId && !busy && (
                  <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => setChatId(undefined)}>
                    {t('Anderer Bezug: neuer Chat')}
                  </button>
                )}
              </>
            ) : (
              <select
                className="h-8 min-w-0 rounded-md border border-line bg-bg px-2"
                aria-label={t('Bezug')}
                value={JSON.stringify(scope)}
                onChange={(e) => setScope(JSON.parse(e.target.value) as AiScope)}
              >
                {options.map((o) => (
                  <option key={JSON.stringify(o)} value={JSON.stringify(o)}>
                    {scopeText(o)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" aria-label={t('Chat')}>
            {!messages.length && !live && scope.kind === 'general' && (
              <p className="text-fg-muted">
                {t(
                  'Allgemeine Frage an das Sprachmodell – ohne Wiki: Es geht keine Notiz an den Anbieter, die Antwort kommt aus dem Wissen des Modells und hat keine Quellen. Sie kann veraltet oder falsch sein; für Fragen zu deinen Notizen einen anderen Bezug wählen.',
                )}
              </p>
            )}
            {!messages.length && !live && scope.kind !== 'general' && (
              <p className="text-fg-muted">
                {t(
                  'Die KI sucht und liest selbst – nur in Notizen, die für sie freigegeben sind und die du lesen darfst. Auf Wunsch schlägt sie Änderungen vor (neue Notiz, Text ändern, verschieben, sich etwas merken); ausgeführt wird erst, wenn du „Übernehmen“ klickst. Quellen stehen unter der Antwort.',
                )}
              </p>
            )}
            {messages.map((m, i) => (
              <Message
                key={i}
                message={m}
                question={messages[i - 1]?.role === 'user' ? messages[i - 1]!.content : t('KI-Antwort')}
                scope={scope}
                proposals={proposals.filter((p) => m.meta.proposals?.includes(p.id))}
                onChanged={refresh}
                onClose={close}
              />
            ))}
            {live && (
              <>
                <div className="ml-10 rounded-lg bg-muted p-2.5 whitespace-pre-wrap">{live.question}</div>
                <div className="mr-4 space-y-1.5 rounded-lg border border-line p-2.5" aria-label={t('KI arbeitet')}>
                  {live.steps.map((st, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-fg-muted">
                      <Check className="h-3.5 w-3.5 text-ok" /> {st}
                    </div>
                  ))}
                  {live.text ? (
                    <div aria-live="polite">
                      <MarkdownView markdown={live.text} />
                      <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-fg-faint align-text-bottom" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-fg-muted">
                      <Spinner className="h-4 w-4" /> {live.steps.length ? t('Arbeitet weiter …') : t('Die KI denkt nach …')}
                    </div>
                  )}
                  {live.proposals.map((p) => (
                    <ProposalCard key={p.id} proposal={p} onChanged={() => undefined} onClose={close} />
                  ))}
                </div>
              </>
            )}
            <div ref={bottom} />
          </div>
          {error && (
            <p className="mt-2 text-danger" role="alert">
              {error}
            </p>
          )}
          <form className="mt-2 flex gap-2" onSubmit={submit}>
            <textarea
              className="min-h-[44px] flex-1 resize-y rounded-md border border-line bg-bg p-2 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
              placeholder={t('Frage oder Auftrag … (Strg+Enter sendet)')}
              aria-label={t('Frage')}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e as unknown as FormEvent);
              }}
              autoFocus
              data-autofocus
            />
            <Button variant="primary" disabled={busy || !question.trim()}>
              {t('Fragen')}
            </Button>
          </form>
        </div>
      </div>
    </Modal>
  );
}

/** „Verlauf löschen …“ like a browser history: the last hour, day, week, month or everything. */
function ClearHistory({ onCleared, compact }: { onCleared: () => void; /** Icon only (narrow screens). */ compact?: boolean }) {
  const ranges: [string, number][] = [
    [t('Letzte Stunde'), 1],
    [t('Letzte 24 Stunden'), 24],
    [t('Letzte 7 Tage'), 24 * 7],
    [t('Letzte 30 Tage'), 24 * 30],
    [t('Alle Chats'), 0],
  ];
  const clear = async (label: string, hours: number) => {
    const question = hours
      ? t('Chats: {range} endgültig löschen? Das lässt sich nicht rückgängig machen.', { range: label })
      : t('Alle Chats endgültig löschen? Das lässt sich nicht rückgängig machen.');
    if (!(await confirmDialog(question, { confirmLabel: t('Löschen'), danger: true }))) return;
    try {
      const { deleted } = await api.deleteAiChat('all', hours || undefined);
      toast({ kind: 'ok', title: tn(deleted, '{n} Chat gelöscht', '{n} Chats gelöscht') });
      onCleared();
    } catch (e) {
      toast({ kind: 'error', title: t('Nicht gelöscht'), text: errorText(e) });
    }
  };
  return (
    <DM.Root>
      <DM.Trigger asChild>
        {compact ? (
          <Button className="shrink-0 px-2" aria-label={t('Verlauf löschen …')} title={t('Verlauf löschen …')}>
            <History className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="sm" className="justify-start">
            <Trash2 className="h-3.5 w-3.5" /> {t('Verlauf löschen …')}
          </Button>
        )}
      </DM.Trigger>
      <DM.Portal>
        <DropdownContent align={compact ? 'end' : 'start'} side={compact ? 'bottom' : 'top'} sideOffset={4} minWidth={180} className="z-[70]">
          {ranges.map(([label, hours]) => (
            <DM.Item key={label} className="cursor-default rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover" onSelect={() => void clear(label, hours)}>
              {label}
            </DM.Item>
          ))}
        </DropdownContent>
      </DM.Portal>
    </DM.Root>
  );
}

function Message({
  message: m,
  question,
  scope,
  proposals,
  onChanged,
  onClose,
}: {
  message: AiChatMessage;
  /** The question this answers (title when saved as a note). */
  question: string;
  scope: AiScope;
  proposals: AiProposal[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const steps = m.meta.steps ?? [];
  const [raw, setRaw] = useState(false);
  const view = useRef<Editor | null>(null);
  const copy = () => {
    const ok = copyRich(view.current?.getHTML() ?? '', m.content);
    toast(
      ok
        ? { kind: 'ok', title: t('Antwort kopiert'), text: t('In eine Notiz einfügen: formatiert; in einen Texteditor: als Markdown.') }
        : { kind: 'error', title: t('Nicht kopiert'), text: t('Der Browser hat den Zugriff auf die Zwischenablage verweigert.') },
    );
  };
  const save = () =>
    useActions.getState().open({
      kind: 'save-answer',
      markdown: m.content,
      title: question,
      sources: m.sources,
      ...(scope.kind === 'note' || scope.kind === 'folder' ? { mountId: scope.mountId, folder: scope.kind === 'folder' ? scope.path : scope.path.split('/').slice(0, -1).join('/') } : scope.kind === 'source' ? { mountId: scope.mountId, folder: '' } : {}),
      onSaved: onClose,
    });
  return (
    <div className={cx('rounded-lg p-2.5', m.role === 'user' ? 'ml-10 bg-muted' : 'mr-4 border border-line')}>
      {m.role === 'assistant' && steps.length > 0 && (
        <details className="mb-2 text-xs text-fg-muted">
          <summary className="flex cursor-pointer items-center gap-1.5">
            <ListChecks className="h-3.5 w-3.5" /> {tn(steps.length, '{n} Schritt', '{n} Schritte')}
          </summary>
          <ol className="ml-5 mt-1 list-decimal space-y-0.5">
            {steps.map((st, i) => (
              <li key={i}>{st}</li>
            ))}
          </ol>
        </details>
      )}
      {m.role !== 'assistant' ? (
        <div className="whitespace-pre-wrap">{m.content}</div>
      ) : raw ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs" aria-label={t('Antwort als Markdown')}>
          {m.content}
        </pre>
      ) : (
        <MarkdownView markdown={m.content} editorRef={view} />
      )}
      {m.role === 'assistant' && (
        <div className="mt-1.5 flex flex-wrap gap-1" aria-label={t('Antwort verwenden')}>
          <Button size="sm" variant="ghost" onClick={copy} title={t('Formatiert kopieren (in Texteditoren kommt Markdown an)')}>
            <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRaw((r) => !r)} aria-pressed={raw}>
            <FileCode2 className="h-3.5 w-3.5" /> {raw ? t('Formatiert') : 'Markdown'}
          </Button>
          <Button size="sm" variant="ghost" onClick={save}>
            <FilePlus className="h-3.5 w-3.5" /> {t('Als Notiz speichern …')}
          </Button>
        </div>
      )}
      {proposals.length > 0 && (
        <div className="mt-2 space-y-2">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onChanged={onChanged} onClose={onClose} />
          ))}
        </div>
      )}
      {m.role === 'assistant' && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {m.sources.map((s) => (
            <SourceChip key={s.n} source={s} onClose={onClose} />
          ))}
          {m.sources.length > 1 && (
            <button
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-muted hover:bg-hover hover:text-fg"
              title={t('Jede Quelle in einem eigenen Tab öffnen')}
              onClick={() => {
                // Background tabs for all, then the first one in front.
                for (const s of m.sources.slice(1)) openSource(s, true);
                openSource(m.sources[0]!);
                onClose();
              }}
            >
              <PanelTop className="h-3.5 w-3.5" /> {t('Alle {n} in Tabs öffnen', { n: m.sources.length })}
            </button>
          )}
          {m.meta.model && (
            <span className="text-fg-faint">
              {m.meta.provider} · {m.meta.model}
              {m.meta.mode === 'agent' ? ' · Agent' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const PROPOSAL_ICON = { create: FilePlus, write: FilePen, move: ArrowRight, remember: Brain } as const;

/** A change the AI proposed: preview (diff/content), then apply or discard. */
function ProposalCard({ proposal, onChanged, onClose }: { proposal: AiProposal; onChanged: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const openNote = useWorkspace((s) => s.openNote);
  const [p, setP] = useState(proposal);
  useEffect(() => setP(proposal), [proposal]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({ queryKey: ['ai-proposal', p.id], queryFn: () => api.aiProposalPreview(p.id), enabled: show });
  const Icon = PROPOSAL_ICON[p.kind];
  const where = (path: string) => `${p.mountName} / ${path || t('oberste Ebene')}`;
  const title =
    p.kind === 'create'
      ? t('Neue Notiz „{title}“ in {where}', { title: p.title ?? '', where: where(p.path) })
      : p.kind === 'write'
        ? t('Ändern: {where}', { where: where(p.path) })
        : p.kind === 'move'
          ? t('Verschieben: {from} → {to}', { from: p.path, to: p.toPath ?? '' })
          : t('Merken für „{source}“: {content}', { source: p.mountName, content: p.content ?? '' });
  const decide = async (apply: boolean) => {
    setBusy(true);
    try {
      const next = apply ? await api.applyAiProposal(p.id) : await api.rejectAiProposal(p.id);
      setP(next);
      if (apply) {
        toast({ kind: 'ok', title: t('Vorschlag übernommen'), text: next.result ?? undefined });
        await qc.invalidateQueries({ queryKey: ['tree', p.mountId] });
        await qc.invalidateQueries({ queryKey: ['note', p.mountId] });
      }
      onChanged();
    } catch (e) {
      toast({ kind: 'error', title: t('Nicht übernommen'), text: errorText(e) });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const opens = p.status === 'applied' && p.result && /\.md$/i.test(p.result) && p.kind !== 'remember';
  return (
    <div className="rounded-md border border-dashed border-line bg-subtle p-2" aria-label={t('Vorschlag')}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="break-words font-medium">{title}</div>
          {p.reason && <div className="text-xs text-fg-muted">{p.reason}</div>}
        </div>
        {p.status === 'open' ? (
          <div className="flex shrink-0 gap-1">
            {p.kind !== 'move' && (
              <Button size="sm" variant="ghost" onClick={() => setShow((x) => !x)}>
                {show ? t('Ausblenden') : t('Vorschau')}
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(true)}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />} {t('Übernehmen')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(false)} aria-label={t('Verwerfen')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <span className={cx('shrink-0 text-xs', p.status === 'applied' ? 'text-ok' : p.status === 'failed' ? 'text-danger' : 'text-fg-faint')}>
            {p.status === 'applied'
              ? t('Übernommen')
              : p.status === 'rejected'
                ? t('Verworfen')
                : p.result
                  ? t('Fehlgeschlagen: {error}', { error: p.result })
                  : t('Fehlgeschlagen')}
            {opens && (
              <button
                className="ml-2 text-accent hover:underline"
                onClick={() => {
                  openNote(p.mountId, p.result!, noteNameIn(p.mountId, p.result!), { newTab: true });
                  onClose();
                }}
              >
                {t('Öffnen')}
              </button>
            )}
          </span>
        )}
      </div>
      {show && p.status === 'open' && (
        <div className="mt-2">
          {preview.data?.diff !== undefined && preview.data?.diff !== null ? (
            <DiffView text={preview.data.diff} loading={preview.isPending} empty={t('Keine Änderung.')} />
          ) : (
            <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap">{preview.isPending ? '…' : preview.data?.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** A source in its own tab — the tab it already has if it is open (no duplicates from AI answers). */
function openSource(s: AiSource, background = false) {
  const { tabs, openNote } = useWorkspace.getState();
  const open = tabs.some((tab) => tab.mountId === s.mountId && tab.path === s.path);
  if (open) {
    if (!background) openNote(s.mountId, s.path, s.title);
  } else openNote(s.mountId, s.path, s.title, { newTab: true, background });
}

/**
 * A source under an answer. Click: open it and close the dialog. Right-click (long press on
 * touch) or middle click: open in a new tab and stay here — to look at several sources.
 */
function SourceChip({ source: s, onClose }: { source: AiSource; onClose: () => void }) {
  const inTab = () => openSource(s, true);
  return (
    <ContextMenu>
      <ContextTrigger asChild>
        <button
          className="rounded bg-accent-soft px-1.5 py-0.5 text-accent hover:underline"
          title={t('{path} – Rechtsklick: weitere Möglichkeiten', { path: s.path })}
          onClick={() => {
            openSource(s);
            onClose();
          }}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            inTab();
            toast({ kind: 'ok', title: t('In neuem Tab geöffnet'), text: noteNameIn(s.mountId, s.path) });
          }}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        >
          [{s.n}] {noteNameIn(s.mountId, s.path)}
        </button>
      </ContextTrigger>
      <ContextContent>
        <ContextItem icon={<ExternalLink />} onSelect={() => (inTab(), toast({ kind: 'ok', title: t('In neuem Tab geöffnet'), text: noteNameIn(s.mountId, s.path) }))} shortcut={t('Mittelklick')}>
          {t('In neuem Tab öffnen')}
        </ContextItem>
        <ContextItem icon={<ArrowRight />} onSelect={() => (openSource(s), onClose())}>
          {t('Öffnen und Dialog schließen')}
        </ContextItem>
        <ContextItem icon={<Columns2 />} onSelect={() => (useWorkspace.getState().openSplit(s.mountId, s.path, s.title), onClose())}>
          {t('Rechts daneben öffnen')}
        </ContextItem>
        <ContextSeparator />
        <ContextItem icon={<Copy />} onSelect={() => void copyWithToast(fullPath(s.mountId, s.path))}>
          {t('Pfad kopieren')}
        </ContextItem>
      </ContextContent>
    </ContextMenu>
  );
}
