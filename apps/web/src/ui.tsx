// Small shared UI primitives (buttons, inputs, dialog, menus) on top of Radix + Tailwind.
import * as Dialog from '@radix-ui/react-dialog';
import * as CM from '@radix-ui/react-context-menu';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { create } from 'zustand';
import { X, Loader2, ChevronRight, ChevronDown, Check, ArrowLeft, CircleHelp } from 'lucide-react';
import { comboShown, comboStep } from './combo';
import { afterMenus } from './afterMenus';
import { tabKeyTarget } from './tabKeys';
import { openHelp } from './help/help';
import { t } from './i18n';
import {
  cloneElement,
  createContext,
  forwardRef,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

/**
 * A translated text with elements inside: `{name}` placeholders left open by t() are replaced by the
 * given nodes, e.g. fillNodes(t('{title} wirklich löschen?'), { title: <strong>{x}</strong> }).
 */
export function fillNodes(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return key && key in nodes ? <Fragment key={i}>{nodes[key]}</Fragment> : part;
  });
}

/** A translated sentence with elements in it: `<Rich text={t('Mit {link} öffnen')} parts={{ link: <a …/> }} />`. */
export function Rich({ text, parts }: { text: string; parts: Record<string, ReactNode> }) {
  return <>{fillNodes(text, parts)}</>;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'default'; size?: 'sm' | 'md' };

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'default', size = 'md', className, ...rest }, ref) {
  // A ghost button with its own colour (e.g. `text-danger` for removing) keeps it – the muted grey would win otherwise.
  const ownColour = /(^|\s)text-(danger|warn|ok|accent)\b/.test(className ?? '');
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        variant === 'ghost' && (ownColour ? 'hover:bg-hover' : 'text-fg-muted hover:bg-hover hover:text-fg'),
        variant === 'default' && 'border border-line-control bg-bg text-fg hover:border-fg-faint hover:bg-hover',
        className,
      )}
      {...rest}
    />
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton(
  { label, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cx('inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-active hover:text-fg', className)}
      {...rest}
    />
  );
});

const INPUT_BOX =
  'h-8 w-full rounded-md border border-line bg-bg px-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      // React renders no autofocus attribute; `Modal` finds the field to start on by this marker.
      data-autofocus={rest.autoFocus || undefined}
      className={cx(INPUT_BOX, className)}
      {...rest}
    />
  );
});

/**
 * A labelled field. `error` shows below the field what is wrong with it (design-006): the field is
 * marked invalid, describes itself by hint and error, and the error is announced as it appears.
 * When the field sits inside other markup (e.g. with „.md“ beside it), pass a function: it gets
 * those attributes for the field.
 */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode | ((a11y: FieldA11y) => ReactNode) }) {
  const hintId = useId();
  const errorId = useId();
  const a11y: FieldA11y = {
    'aria-describedby': [error ? errorId : '', hint ? hintId : ''].filter(Boolean).join(' ') || undefined,
    'aria-invalid': error ? true : undefined,
  };
  // The hint stays outside the <label> so the field's accessible name is just the label.
  const control =
    typeof children === 'function' ? children(a11y) : a11y['aria-describedby'] && isValidElement<FieldA11y>(children) ? cloneElement(children, a11y) : children;
  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-fg-muted">{label}</span>
        {control}
      </label>
      {error && (
        <span id={errorId} role="alert" className="block text-xs text-danger">
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className="block text-xs text-fg-faint">
          {hint}
        </span>
      )}
    </div>
  );
}

type FieldA11y = { 'aria-describedby'?: string; 'aria-invalid'?: boolean };

/** What went wrong with a whole form or action (not one field): shown in place and announced (design-006). */
export function FormError({ children, className, small }: { children?: ReactNode; className?: string; small?: boolean }) {
  if (!children) return null;
  return (
    <p role="alert" className={cx(small ? 'text-xs' : 'text-sm', 'text-danger', className)}>
      {children}
    </p>
  );
}

/** A quiet confirmation such as „Gespeichert.“ – announced without moving the focus. */
export function FormStatus({ children, className, ok }: { children?: ReactNode; className?: string; ok?: boolean }) {
  return (
    <span role="status" className={cx(ok ? 'text-ok' : 'text-fg-muted', className)}>
      {children}
    </span>
  );
}

/**
 * Whether the repeat of a password or passphrase is shown as not matching (design-002): once it is as long as the
 * first entry or the field was left – not at the first typed character, and not only on saving. An empty repeat
 * is no mismatch but „missing“ (said beside the button, `MissingHint`).
 */
export function repeatMismatch(first: string, repeat: string, left: boolean): boolean {
  return repeat !== '' && repeat !== first && (left || repeat.length >= first.length);
}

/** The one check for every repeat field: `error` goes to `Field error`, `onBlur` to the repeat field; `reveal` on saving. */
export function useRepeatCheck(first: string, repeat: string) {
  const [left, setLeft] = useState(false);
  if (left && !repeat) setLeft(false); // cleared: start over, typing again says nothing at the first character
  return {
    error: repeatMismatch(first, repeat, left) ? t('Stimmt nicht überein') : undefined,
    onBlur: () => setLeft(repeat !== ''),
    reveal: () => setLeft(true),
  };
}

/** Beside a grey button: what is still missing – never a silent grey button. The button gets `aria-describedby={id}` while there is something. */
export function MissingHint({ id, items, className }: { id: string; items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <span id={id} className={cx('text-xs text-fg-muted', className)}>
      {t('Es fehlt noch: {list}', { list: items.join(', ') })}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-4 w-4 animate-spin', className)} />;
}

/**
 * What a part shows while it loads (design-010): a spinner announced as „Lade…“ – or `text`, then also visible.
 * `big` for whole areas (note, settings); `className` sets the size of the place it fills.
 */
export function PartLoading({ text, big, className }: { text?: string; big?: boolean; className?: string }) {
  return (
    <div role="status" className={cx('flex items-center justify-center gap-2 text-fg-muted', text && 'text-sm', className)}>
      <Spinner className={big ? 'h-6 w-6' : undefined} />
      {text ? <span>{text}</span> : <span className="sr-only">{t('Lade…')}</span>}
    </div>
  );
}

const DirtyContext = createContext<((id: string, dirty: boolean) => void) | null>(null);

/**
 * Open modals, in the order they opened. Esc always closes the last one: Radix decides that per
 * render and, with two dialogs side by side (Settings + wizard), sometimes still let the lower one
 * handle the key — Esc then closed the settings below the wizard.
 */
const openModals: { id: string; close: () => void }[] = [];
const escHandled = new WeakSet<Event>();

/**
 * The element that had the focus before a menu took it. A dialog opened from a menu item returns
 * the focus there – the item itself is gone by the time the dialog closes.
 */
let beforeMenu: HTMLElement | null = null;
const MENU = '[role="menu"]';
if (typeof document !== 'undefined')
  document.addEventListener(
    'focusin',
    (e) => {
      const from = e.relatedTarget;
      if ((e.target as Element | null)?.closest?.(MENU) && from instanceof HTMLElement && !from.closest(MENU)) beforeMenu = from;
    },
    true,
  );

/** Whether a media query matches, updated live (e.g. phone layout). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    m.addEventListener('change', on);
    on();
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/**
 * Marks the surrounding modal as holding unsaved input: closing it with Esc or × asks first.
 * For state that is not typed into a field (a drawing, a pending value of a settings form).
 */
export function useModalDirty(dirty: boolean) {
  const set = useContext(DirtyContext);
  const id = useId();
  useEffect(() => {
    set?.(id, dirty);
    return () => set?.(id, false);
  }, [set, id, dirty]);
}

/**
 * The one dialog of the app, so every dialog behaves the same (Owner 2026-10-08):
 * - a click beside it closes nothing; × or Esc close it, Esc only the topmost dialog;
 * - with unsaved input (`trackInput`: anything typed or ticked; or `useModalDirty`) closing asks first;
 *   saving closes it through the caller, without asking;
 * - focus starts on the field marked `data-autofocus` (`Input` sets it for `autoFocus`; else on the
 *   dialog itself), stays inside while open and returns to the element that opened it (opened from a
 *   menu: to the element focused before the menu);
 * - `onBack`: "Zurück" in the header for a dialog opened from another one (e.g. from Settings).
 * - `noClose`: no × – for a dialog answered only through its own buttons (its `onOpenChange` ignores false, so Esc does nothing).
 * Fields with `data-nodirty` (search boxes) do not count as input.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  children,
  wide,
  trackInput,
  onBack,
  help,
  noClose,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: ReactNode;
  /** 'full': almost the whole window (grids with many columns). */
  wide?: boolean | 'xl' | 'full';
  trackInput?: boolean;
  onBack?: () => void;
  /** Anchor in the user manual: a „?“ in the title bar (and F1) opens the help there. */
  help?: string;
  noClose?: boolean;
  /** Where the focus goes on closing instead of the opener (e.g. the opener was just deleted). */
  returnFocus?: () => HTMLElement | null;
}) {
  const dirty = useRef(new Set<string>());
  const opener = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const modalId = useId();
  const setDirty = useCallback((id: string, d: boolean) => void (d ? dirty.current.add(id) : dirty.current.delete(id)), []);
  const leave = (then: () => void) => {
    // A question is open above this dialog: Esc/clicks there are meant for the question only.
    if (useAsk.getState().ask) return;
    const go = () => {
      dirty.current.clear();
      then();
    };
    if (dirty.current.size === 0) return go();
    void confirmDialog(t('Ungespeicherte Eingaben verwerfen?'), { confirmLabel: t('Verwerfen'), cancelLabel: t('Weiter bearbeiten'), danger: true }).then((ok) => ok && go());
  };
  const close = useRef(() => {});
  close.current = () => leave(() => onOpenChange(false));
  // Runs before the dialog moves the focus inside (that happens in a passive effect).
  useLayoutEffect(() => {
    if (!open) return void dirty.current.clear();
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? (active.closest(MENU) ? beforeMenu : active) : null;
    const entry = { id: modalId, close: () => close.current() };
    openModals.push(entry);
    return () => {
      openModals.splice(openModals.indexOf(entry), 1);
    };
  }, [open, modalId]);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : leave(() => onOpenChange(false)))}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <Dialog.Content
          ref={content}
          className={cx(
            'fixed left-1/2 z-50 w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-bg shadow-pop flex flex-col focus:outline-none',
            wide === 'full' ? 'top-[4vh] max-h-[92vh] max-w-[1400px]' : 'top-[8vh] max-h-[84vh]',
            wide === 'xl' ? 'max-w-6xl' : wide === 'full' ? '' : wide ? 'max-w-3xl' : 'max-w-md',
          )}
          aria-describedby={undefined}
          data-help={help}
          // Where an image opens full size (`openLightbox`): this dialog keeps clicks and the focus inside itself.
          data-modal=""
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            if (escHandled.has(e)) return;
            escHandled.add(e);
            openModals.at(-1)?.close();
          }}
          // React focuses `autoFocus` fields as they mount, but a menu still open at that moment takes
          // the focus straight back; Radix would then start on the first button (the „?“). Start on
          // the marked field instead, or on the dialog itself – never on a header button.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (content.current?.querySelector<HTMLElement>('[data-autofocus]') ?? content.current)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const to = returnFocus?.() ?? opener.current;
            if (to?.isConnected) to.focus();
          }}
          onInput={(e) => {
            const el = e.target as HTMLElement;
            if (trackInput && !el.closest('[data-nodirty]')) dirty.current.add('input');
          }}
        >
          <div className="flex items-center gap-1 border-b border-line px-4 py-3">
            {onBack && (
              <IconButton label={t('Zurück')} onClick={() => leave(onBack)} className="-ml-1.5">
                <ArrowLeft className="h-4 w-4" />
              </IconButton>
            )}
            <Dialog.Title className="flex-1 text-sm font-semibold">{title}</Dialog.Title>
            {help && (
              // A name without the dialog's words: tests and screen readers look for its buttons by name.
              <IconButton label={t('Hilfe zu diesem Fenster')} title={t('Hilfe (F1): {title}', { title })} onClick={() => openHelp(help)}>
                <CircleHelp className="h-4 w-4" />
              </IconButton>
            )}
            {!noClose && (
              <Dialog.Close asChild>
                <IconButton label={t('Schließen')}>
                  <X className="h-4 w-4" />
                </IconButton>
              </Dialog.Close>
            )}
          </div>
          <DirtyContext.Provider value={setDirty}>
            {/* Wide dialogs switch between long and short pages: space for the scroll bar is always kept, so nothing shifts sideways. */}
            <div className={cx('overflow-y-auto p-4', wide && '[scrollbar-gutter:stable]')}>{children}</div>
          </DirtyContext.Provider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Questions in an app window instead of the browser's confirm() ────────────────────
interface Ask {
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  /** choiceDialog: the ways to pick from (the first is preselected). */
  choices?: Choice[];
  resolve: (ok: boolean, choice?: string) => void;
  /** Where the focus was when asked (e.g. the editor while typing) – it goes back there afterwards. */
  returnTo: Element | null;
}
const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

/**
 * Asks in a Kaveyl Wiki window (above any open dialog) and resolves true/false. The focus starts on
 * „cancel“ (Enter changes nothing), Esc keeps everything as it was. `ConfirmHost` renders it.
 */
export function confirmDialog(text: string, opts: { confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  useAsk.getState().ask?.resolve(false);
  return new Promise((resolve) =>
    useAsk.setState({ ask: { text, confirmLabel: opts.confirmLabel ?? 'OK', cancelLabel: opts.cancelLabel ?? t('Abbrechen'), danger: opts.danger, resolve, returnTo: document.activeElement } }),
  );
}

export interface Choice {
  value: string;
  label: string;
  /** What this way does, one line each. */
  detail: string;
}

/**
 * Like confirmDialog, with ways to choose from (radio buttons, the first preselected). Resolves the chosen value, or
 * null when cancelled.
 */
export function choiceDialog(text: string, choices: Choice[], opts: { confirmLabel?: string; cancelLabel?: string } = {}): Promise<string | null> {
  useAsk.getState().ask?.resolve(false);
  return new Promise((resolve) =>
    useAsk.setState({
      ask: {
        text,
        choices,
        confirmLabel: opts.confirmLabel ?? 'OK',
        cancelLabel: opts.cancelLabel ?? t('Abbrechen'),
        resolve: (ok, choice) => resolve(ok ? (choice ?? choices[0]!.value) : null),
        returnTo: document.activeElement,
      },
    }),
  );
}

export function ConfirmHost() {
  const ask = useAsk((s) => s.ask);
  const returnTo = useRef<Element | null>(null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  if (ask) returnTo.current = ask.returnTo;
  // A new question starts on its first way.
  useEffect(() => setPicked(ask?.choices?.[0]?.value), [ask]);
  const answer = (ok: boolean) => {
    ask?.resolve(ok, picked);
    useAsk.setState({ ask: null });
  };
  // Esc belongs to the question alone: caught on window in the capture phase, before the dialogs
  // below (Radix listens on document) can see it.
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ask.resolve(false);
      useAsk.setState({ ask: null });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ask]);
  return (
    <Dialog.Root open={!!ask} onOpenChange={(o) => !o && answer(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/20" />
        <Dialog.Content
          role="alertdialog"
          aria-describedby={undefined}
          className={cx(
            'fixed left-1/2 top-[22vh] z-[61] w-[calc(100vw-32px)] -translate-x-1/2 rounded-xl border border-line bg-bg p-4 shadow-pop',
            ask?.choices ? 'max-w-md' : 'max-w-sm',
          )}
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            const el = returnTo.current;
            returnTo.current = null;
            if (el instanceof HTMLElement && el.isConnected && el !== document.body) {
              e.preventDefault();
              el.focus({ preventScroll: true });
            }
          }}

        >
          <Dialog.Title className="whitespace-pre-line break-words text-sm">{ask?.text}</Dialog.Title>
          {ask?.choices && (
            <div role="radiogroup" aria-label={ask.text} className="mt-3 space-y-2">
              {ask.choices.map((c) => (
                <label
                  key={c.value}
                  className={cx('flex cursor-pointer gap-2 rounded-lg border p-2.5 text-sm', picked === c.value ? 'border-accent bg-accent-soft' : 'border-line')}
                >
                  <input type="radio" name="ask-choice" className="mt-0.5 accent-[var(--accent)]" checked={picked === c.value} onChange={() => setPicked(c.value)} />
                  <span className="min-w-0">
                    <span className="font-medium">{c.label}</span>
                    <span className="mt-0.5 block whitespace-pre-line break-words text-xs text-fg-muted">{c.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => answer(false)}>
              {ask?.cancelLabel}
            </Button>
            <Button size="sm" variant={ask?.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
              {ask?.confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── Input in an app window instead of the browser's prompt() ─────────────────────────
export interface InputField {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  /** Required fields keep the confirm button disabled while empty. */
  required?: boolean;
  /** Code-like input (LaTeX, paths): monospace, no spell check. */
  mono?: boolean;
  /** Offered while typing (free text stays possible). */
  suggestions?: string[];
}
interface InputAsk {
  title: string;
  fields: InputField[];
  confirmLabel: string;
  help?: string;
  resolve: (values: Record<string, string> | null) => void;
}
const useInput = create<{ ask: InputAsk | null }>(() => ({ ask: null }));

/**
 * Asks for one or more values in a Kaveyl Wiki window (never the browser's prompt()). Resolves the
 * values (untrimmed) or null when cancelled (Esc, ×, „Abbrechen“). `InputHost` renders it.
 */
export function inputDialog(opts: { title: string; fields: InputField[]; confirmLabel?: string; help?: string }): Promise<Record<string, string> | null> {
  useInput.getState().ask?.resolve(null);
  return new Promise((resolve) => afterMenus(() => useInput.setState({ ask: { ...opts, confirmLabel: opts.confirmLabel ?? 'OK', resolve } })));
}

/** One value; null when cancelled. */
export async function promptDialog(title: string, field: Omit<InputField, 'name' | 'label'> & { label?: string; confirmLabel?: string; help?: string } = {}): Promise<string | null> {
  const { confirmLabel, help, ...rest } = field;
  const r = await inputDialog({ title, confirmLabel, help, fields: [{ name: 'value', label: rest.label ?? title, ...rest }] });
  return r ? r.value! : null;
}

export function InputHost() {
  const ask = useInput((s) => s.ask);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (ask) setValues(Object.fromEntries(ask.fields.map((f) => [f.name, f.value ?? ''])));
  }, [ask]);
  const answer = (ok: boolean) => {
    ask?.resolve(ok ? values : null);
    useInput.setState({ ask: null });
  };
  // Esc closes only this window (capture on window, before Radix dialogs below see it).
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An open suggestion list closes first (ComboInput).
      if ((e.target as Element | null)?.closest?.('[role="combobox"][aria-expanded="true"]')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ask.resolve(null);
      useInput.setState({ ask: null });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ask]);
  const missing = !!ask?.fields.some((f) => f.required && !(values[f.name] ?? '').trim());
  return (
    <Dialog.Root open={!!ask} onOpenChange={(o) => !o && answer(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/20" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[18vh] z-[61] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 rounded-xl border border-line bg-bg p-4 shadow-pop"
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            // First field focused with its text selected: type to replace, arrows to edit.
            e.preventDefault();
            const input = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('input');
            setTimeout(() => (input?.focus(), input?.select()), 0);
          }}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">{ask?.title}</Dialog.Title>
            {ask?.help && (
              <IconButton label={t('Hilfe zu diesem Fenster')} title={t('Hilfe (F1)')} onClick={() => openHelp(ask.help)}>
                <CircleHelp className="h-4 w-4" />
              </IconButton>
            )}
          </div>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!missing) answer(true);
            }}
          >
            {ask?.fields.map((f) => (
              <Field key={f.name} label={f.label} hint={f.hint}>
                {f.suggestions ? (
                  <ComboInput
                    value={values[f.name] ?? ''}
                    options={f.suggestions}
                    placeholder={f.placeholder}
                    spellCheck={f.mono ? false : undefined}
                    className={f.mono ? `${INPUT_BOX} font-mono` : undefined}
                    onValueChange={(value) => setValues((v) => ({ ...v, [f.name]: value }))}
                  />
                ) : (
                  <Input
                    value={values[f.name] ?? ''}
                    placeholder={f.placeholder}
                    spellCheck={f.mono ? false : undefined}
                    className={f.mono ? 'font-mono' : undefined}
                    autoComplete="off"
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" size="sm" variant="ghost" onClick={() => answer(false)}>
                {t('Abbrechen')}
              </Button>
              <Button type="submit" size="sm" variant="primary" disabled={missing}>
                {ask?.confirmLabel}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ContextMenu = CM.Root;
export const ContextTrigger = CM.Trigger;

/**
 * Context menus and their submenus stay inside the viewport (phones): 8 px margin, never wider or
 * taller than the space Radix measures on the chosen side – entries wrap and the list scrolls instead.
 */
const MENU_BOX =
  'z-50 min-w-[min(200px,var(--radix-context-menu-content-available-width))] max-w-[var(--radix-context-menu-content-available-width)] max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto rounded-lg border border-line bg-bg p-1 text-sm shadow-pop';

export function ContextContent({ children }: { children: ReactNode }) {
  return (
    <CM.Portal>
      <CM.Content collisionPadding={8} className={MENU_BOX}>{children}</CM.Content>
    </CM.Portal>
  );
}

/** A trailing " …" (opens a dialog) keeps to the word before it – never alone on a line in a narrow menu (design-015). */
export const glueEllipsis = (text: string) => text.replace(/ …$/, '\u00a0…');

/** `disabled` greys the entry out (it stays visible, `title` says why – e.g. no mail server). */
export function ContextItem({ icon, children, onSelect, danger, shortcut, disabled, title }: { icon?: ReactNode; children: ReactNode; onSelect: () => void; danger?: boolean; shortcut?: string; disabled?: boolean; title?: string }) {
  return (
    <CM.Item
      onSelect={onSelect}
      disabled={disabled}
      title={title}
      className={cx(
        'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-50',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center text-fg-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span className="min-w-0 flex-1 break-words">{typeof children === 'string' ? glueEllipsis(children) : children}</span>
      {/* Never wider than the menu; left out on touch and very narrow screens, where it is of no use. */}
      {shortcut && <span className="shrink-0 whitespace-nowrap text-xs text-fg-faint max-[360px]:hidden [@media(hover:none)]:hidden">{shortcut}</span>}
    </CM.Item>
  );
}

/**
 * A submenu closes when the focus moves to another entry of its menu (that is how hovering a sibling
 * closes it). Focus moving anywhere else – live updates of the note or tree pull it back into the
 * menu for a moment – must not close it.
 */
export const keepSubOpen = (e: Event) => {
  if (!(e.target instanceof Element && e.target.closest('[role="menuitem"]'))) e.preventDefault();
};

/** A submenu in a context menu (opens on hover, tap or arrow key). */
export function ContextSub({ icon, label, children }: { icon?: ReactNode; label: string; children: ReactNode }) {
  return (
    <CM.Sub>
      <CM.SubTrigger className="flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-fg outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover">
        <span className="flex h-4 w-4 items-center justify-center text-fg-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        <span className="flex-1">{label}</span>
        <ChevronRight className="h-3.5 w-3.5 text-fg-faint" />
      </CM.SubTrigger>
      <CM.Portal>
        <CM.SubContent collisionPadding={8} className={MENU_BOX} onFocusOutside={keepSubOpen}>
          {children}
        </CM.SubContent>
      </CM.Portal>
    </CM.Sub>
  );
}

export function ContextSeparator() {
  return <CM.Separator className="my-1 h-px bg-line" />;
}

/**
 * Dropdown menus (… buttons, „Neu …“, link and AI menus) follow the same rules as context menus:
 * 8 px margin, never wider or taller than the available space; `minWidth` (px) gives way on phones.
 */
const DROPDOWN_BOX =
  'max-w-[var(--radix-dropdown-menu-content-available-width)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-lg border border-line bg-bg p-1 text-sm shadow-pop';
const dropdownMin = (minWidth: number) => ({ minWidth: `min(${minWidth}px, var(--radix-dropdown-menu-content-available-width))` });
type DropdownBoxProps = { minWidth?: number; className?: string };

/** `className` carries the layer (`z-50`, `z-[70]`). */
export const DropdownContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.Content> & DropdownBoxProps>(function DropdownContent(
  { minWidth = 200, className, style, ...rest },
  ref,
) {
  return <DM.Content ref={ref} collisionPadding={8} {...rest} className={cx(DROPDOWN_BOX, className)} style={{ ...dropdownMin(minWidth), ...style }} />;
});

export const DropdownSubContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.SubContent> & DropdownBoxProps>(function DropdownSubContent(
  { minWidth = 200, className, style, ...rest },
  ref,
) {
  return <DM.SubContent ref={ref} collisionPadding={8} {...rest} className={cx(DROPDOWN_BOX, className)} style={{ ...dropdownMin(minWidth), ...style }} />;
});

/**
 * Popovers (icon and emoji picker, note path, folder picker, sync status) follow the same rules:
 * 8 px margin, never wider or taller than the available space – the content scrolls instead.
 * `className` carries the layer, padding and width.
 */
const POPOVER_BOX =
  'max-w-[var(--radix-popover-content-available-width)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-lg border border-line bg-bg shadow-pop';

export const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Popover.Content>>(function PopoverContent({ className, ...rest }, ref) {
  return <Popover.Content ref={ref} collisionPadding={8} {...rest} className={cx(POPOVER_BOX, className)} />;
});

// ── Tab rows (WAI-ARIA tabs pattern, design-007) ──────────────────────────────────────
/**
 * Props for a row of tabs: ←/→ (wrapping) and Home/End move to the neighbour and open it at once; only the
 * open tab is in the Tab order. Spread `list` on the row (it holds nothing but the tabs), `tab(key)` on each
 * tab button and `panel` on the element showing the open tab's content.
 */
export function useTabs<K extends string | number>(keys: readonly K[], active: K, onSelect: (key: K) => void) {
  const id = useId();
  const at = keys.indexOf(active);
  const tabId = (i: number) => `${id}tab${i}`;
  const panelId = `${id}panel`;
  return {
    list: { role: 'tablist' as const },
    tab: (key: K) => {
      const i = keys.indexOf(key);
      return {
        role: 'tab' as const,
        id: tabId(i),
        'aria-selected': key === active,
        'aria-controls': panelId,
        tabIndex: i === (at < 0 ? 0 : at) ? 0 : -1,
        onClick: () => onSelect(key),
        onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
          const next = e.altKey || e.ctrlKey || e.metaKey ? null : tabKeyTarget(e.key, i, keys.length);
          if (next === null) return;
          e.preventDefault();
          e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(':scope > [role="tab"]')[next]?.focus();
          onSelect(keys[next]!);
        },
      };
    },
    panel: { role: 'tabpanel' as const, id: panelId, 'aria-labelledby': at >= 0 ? tabId(at) : undefined },
  };
}

// ── Text field with suggestions, instead of the browser's datalist menu ──────────────
type ComboProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Suggestions; any other text may still be entered. */
  options: readonly string[];
  /** A suggestion was chosen (click, tap or Enter); `onValueChange` has already run. */
  onPick?: (value: string) => void;
  /** Small field (tags, 24 px high): narrower button. */
  compact?: boolean;
  /** The wrapper around field and button (width, flex). */
  boxClassName?: string;
};

/**
 * A text field with suggestions in a list of the app (the browser's datalist shows only the entries
 * matching the text, in its own style): the button or ↓ lists all of them with the current value
 * marked, typing filters, free text stays possible. ↑/↓ move, Enter picks, Esc closes just the list;
 * mouse and touch pick by click. ARIA combobox pattern; the list follows the popover rules (rest-e3)
 * and scrolls. `className` replaces the field's look (default: like `Input`).
 */
export function ComboInput({ value, onValueChange, options, onPick, compact, boxClassName, className, style, onKeyDown, onBlur, ...rest }: ComboProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const shown = comboShown(options, value, filter);
  const expanded = open && shown.length > 0;
  const optionId = (i: number) => `${listId}-${i}`;
  useEffect(() => {
    if (expanded && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [expanded, active, listId]);
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const showAll = (dir: 1 | -1 = 1) => {
    const at = options.indexOf(value);
    setFilter(false);
    setActive(at >= 0 ? at : comboStep(-1, options.length, dir));
    setOpen(true);
  };
  const pick = (o: string) => {
    onValueChange(o);
    close();
    onPick?.(o);
  };
  // Clicks and focus on the field or its button belong to the combobox, not "outside" the list.
  const inside = (e: Event) => {
    if (e.target instanceof Node && box.current?.contains(e.target)) e.preventDefault();
  };
  return (
    <Popover.Root open={expanded} onOpenChange={(o) => !o && close()}>
      <Popover.Anchor asChild>
        <div ref={box} className={cx('relative', boxClassName)}>
          <input
            ref={input}
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
            autoComplete="off"
            data-autofocus={rest.autoFocus || undefined}
            {...rest}
            value={value}
            className={className ?? INPUT_BOX}
            // Room for the button; inline, so it wins over any padding in `className`.
            style={options.length ? { paddingRight: compact ? '1.5rem' : '2rem', ...style } : style}
            onChange={(e) => {
              onValueChange(e.target.value);
              setFilter(true);
              setActive(-1);
              setOpen(true);
            }}
            onBlur={(e) => {
              close();
              onBlur?.(e);
            }}
            onKeyDown={(e) => {
              if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options.length) {
                e.preventDefault();
                const dir = e.key === 'ArrowDown' ? 1 : -1;
                if (expanded) setActive(comboStep(active, shown.length, dir));
                else showAll(dir);
                return;
              }
              const hit = expanded && active >= 0 ? shown[active] : undefined;
              if (e.key === 'Enter' && hit !== undefined) {
                e.preventDefault();
                pick(hit);
                return;
              }
              if (e.key === 'Escape' && expanded) {
                e.preventDefault();
                e.stopPropagation();
                close();
                return;
              }
              if (e.key === 'Enter') close();
              onKeyDown?.(e);
            }}
          />
          {options.length > 0 && (
            <button
              type="button"
              // Not a tab stop (↓ in the field opens the list too); the focus stays in the field.
              tabIndex={-1}
              aria-label={t('Vorschläge anzeigen')}
              title={t('Vorschläge anzeigen')}
              aria-controls={listId}
              aria-expanded={expanded}
              className={cx('absolute inset-y-0 right-0 flex items-center justify-center rounded-r-md text-fg-muted hover:text-fg', compact ? 'w-6' : 'w-8')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                input.current?.focus();
                if (expanded) close();
                else showAll();
              }}
            >
              <ChevronDown className={compact ? 'h-3 w-3' : 'h-4 w-4'} />
            </button>
          )}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <PopoverContent
          align="start"
          sideOffset={4}
          role="presentation"
          className="z-[70] p-1"
          style={{
            minWidth: 'min(max(12rem, var(--radix-popover-trigger-width)), var(--radix-popover-content-available-width))',
            maxHeight: 'min(16rem, var(--radix-popover-content-available-height))',
          }}
          // The focus stays in the field; Esc is handled there (closes only the list, not a dialog below).
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={inside}
          onFocusOutside={inside}
        >
          <ul role="listbox" id={listId} aria-label={t('Vorschläge')}>
            {shown.map((o, i) => (
              <li
                key={o}
                id={optionId(i)}
                role="option"
                aria-selected={o === value}
                // Keeps the focus in the field (a blur would end tag entry before the pick).
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={cx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-active', o === value && 'font-medium text-accent')}
              >
                <Check className={cx('h-3.5 w-3.5 shrink-0', o !== value && 'invisible')} />
                <span className="min-w-0 flex-1 break-words">{o}</span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  );
}
