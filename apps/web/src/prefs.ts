// Per-user display preferences (editor width, table of contents), stored on the server
// (/api/state/prefs) so they follow the user across devices.
import { create } from 'zustand';
import { api } from './api';
import { isLang, lang, rememberLang, takeChosenLang, type Lang } from './i18n';

/** 'normal' ≈ 860px reading width, 'wide' ≈ 1200px, 'full' = 100%, number = percent of the pane. */
export type EditorWidth = 'normal' | 'wide' | 'full' | number;

export interface Prefs {
  editorWidth: EditorWidth;
  showToc: boolean;
  /** Sidebar sections the user folded (favorites, recent). */
  collapsedSections: string[];
  /** Encrypted notes lock again after this many minutes without use (0 = only when the page closes). */
  autoLockMin: number;
  /** Font sizes in percent (100 = standard): interface, sidebar, note text, code. */
  fontScale: FontScale;
  /** The welcome page (main area without an open note) is replaced by the short hint. */
  hideWelcome: boolean;
  /** Interface language of the account (AD-046); also the language of mails to this person. */
  language?: Lang;
  /** Admins: the release whose hint at the top right was closed (AD-062); the next release shows again. */
  dismissedUpdate?: string;
}

export interface FontScale {
  ui: number;
  tree: number;
  doc: number;
  mono: number;
}
export const FONT_DEFAULT: FontScale = { ui: 100, tree: 100, doc: 100, mono: 100 };
export const FONT_MIN = 80;
export const FONT_MAX = 150;

const DEFAULTS: Prefs = { editorWidth: 'normal', showToc: true, collapsedSections: [], autoLockMin: 15, fontScale: FONT_DEFAULT, hideWelcome: false };

/** Applies the font sizes at once (CSS variables on <html>, see styles.css): the whole app is the preview. */
export function applyFontScale(f: Partial<FontScale> | undefined) {
  const s = document.documentElement.style;
  for (const k of ['ui', 'tree', 'doc', 'mono'] as const) {
    const v = Math.min(FONT_MAX, Math.max(FONT_MIN, Number(f?.[k]) || 100));
    if (v === 100) s.removeProperty(`--fs-${k}`);
    else s.setProperty(`--fs-${k}`, String(v / 100));
  }
}

interface PrefsStore extends Prefs {
  loaded: boolean;
  load(): Promise<void>;
  set(p: Partial<Prefs>): void;
  /** Sets and stores at once (before a reload). */
  saveNow(p: Partial<Prefs>): Promise<void>;
}

const stored = (p: Prefs) => {
  const { editorWidth, showToc, collapsedSections, autoLockMin, fontScale, hideWelcome, language, dismissedUpdate } = p;
  return { editorWidth, showToc, collapsedSections, autoLockMin, fontScale, hideWelcome, language, dismissedUpdate };
};

let timer: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
/** Pause before the next attempt after a failed load (doubles up to a minute). */
let wait = 0;

export const usePrefs = create<PrefsStore>((set, get) => ({
  ...DEFAULTS,
  loaded: false,
  async load() {
    clearTimeout(retry);
    let saved: Partial<Prefs> | null;
    try {
      saved = await api.getState<Partial<Prefs>>('prefs'); // null = never stored
    } catch {
      // Not "nothing stored": nothing is written until the stored prefs arrived (the defaults would replace them).
      set({ loaded: false });
      wait = Math.min(60_000, wait ? wait * 2 : 2_000);
      retry = setTimeout(() => void get().load(), wait);
      return;
    }
    wait = 0;
    const fontScale = { ...FONT_DEFAULT, ...saved?.fontScale };
    set({ ...DEFAULTS, ...saved, fontScale, loaded: true });
    applyFontScale(fontScale);
    // The last deliberate choice wins: picked on the sign-in page → into the account; otherwise the account's
    // language (chosen on another device) comes to this browser. An account without one takes this page's.
    const chosen = takeChosenLang();
    if (chosen || !isLang(saved?.language)) {
      // At once, not debounced: a reload right after signing in must not lose the choice.
      if (saved?.language !== lang) void get().saveNow({ language: lang }).catch(() => undefined);
    } else if (saved!.language !== lang && rememberLang(saved!.language!)) location.reload();
  },
  set(p) {
    set(p);
    if (p.fontScale) applyFontScale(p.fontScale);
    clearTimeout(timer);
    if (!get().loaded) return;
    timer = setTimeout(() => void api.putState('prefs', stored(get())).catch(() => undefined), 400);
  },
  async saveNow(p) {
    clearTimeout(timer);
    set(p);
    if (!get().loaded) throw new Error('preferences not loaded yet');
    await api.putState('prefs', stored(get()));
  },
}));

/** CSS max-width of the editor column for a width preference. */
export function editorMaxWidth(w: EditorWidth): string {
  if (w === 'full') return '100%';
  if (w === 'wide') return '1200px';
  if (typeof w === 'number') return `${Math.min(100, Math.max(30, w))}%`;
  return '860px';
}
