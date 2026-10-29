// Small global switches: colour scheme (header of the app and the sign-in pages) and language (sign-in pages,
// Einstellungen → Darstellung, palette).
import { Monitor, Moon, Sun } from 'lucide-react';
import { LANGUAGES, lang, switchLanguage, t, type Lang } from './i18n';
import { usePrefs } from './prefs';
import { openSettings } from './shell/settingsNav';
import { NEXT_THEME, useTheme, type Theme } from './theme';
import { IconButton, confirmDialog, cx } from './ui';

export const themeName = (th: Theme) => ({ light: t('Hell'), dark: t('Dunkel'), system: t('System') })[th];

/** Sun / moon / monitor: light → dark → system in turn. The name avoids „Dunkel“ (tests look for that button). */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const next = NEXT_THEME[theme];
  return (
    <IconButton
      label={t('Farbschema wechseln')}
      title={t('Farbschema: {now} – Klick: {next}', { now: themeName(theme), next: themeName(next) })}
      className={className}
      onClick={() => setTheme(next)}
      data-theme-state={theme}
    >
      <Icon className="h-4 w-4" />
    </IconButton>
  );
}

/** Chooses the language: remembers it here and – when signed in – in the account, then reloads. */
export function chooseLanguage(l: Lang, signedIn: boolean) {
  if (l === lang) return;
  switchLanguage(l, signedIn ? () => usePrefs.getState().saveNow({ language: l }) : undefined);
}

/** Settings page to show again after the reload of a language switch (this tab only). */
const REOPEN = 'kaveyl-wiki.lang.reopen';

/**
 * Switching inside the app reloads the page, so it asks first. Picked in the settings, the settings open again at
 * the same page after the reload – the open notes come back anyway (workspace).
 */
export async function askLanguage(l: Lang, reopen?: string) {
  if (l === lang) return;
  const name = LANGUAGES.find((x) => x.code === l)!.name;
  if (!(await confirmDialog(t('Sprache auf {name} umstellen? Die Seite lädt dafür kurz neu.', { name }), { confirmLabel: t('Umstellen') }))) return;
  try {
    if (reopen) sessionStorage.setItem(REOPEN, reopen);
  } catch {
    /* without storage the settings simply stay closed */
  }
  chooseLanguage(l, true);
}

/** After a language switch from the settings: opens them again where they were (once). */
export function reopenAfterLanguageSwitch() {
  try {
    const page = sessionStorage.getItem(REOPEN);
    sessionStorage.removeItem(REOPEN);
    if (page) openSettings(page);
  } catch {
    /* nothing to reopen */
  }
}

/** Compact language switch for the sign-in pages (DE | EN …). */
export function LanguageSwitch({ className }: { className?: string }) {
  return (
    <div role="group" aria-label={t('Sprache')} className={cx('flex items-center rounded-md border border-line p-0.5 text-xs', className)}>
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={l.code === lang}
          title={l.name}
          className={cx('rounded px-1.5 py-0.5 font-medium uppercase', l.code === lang ? 'bg-accent-soft text-[var(--auth-link)]' : 'text-fg-muted hover:text-fg')}
          onClick={() => chooseLanguage(l.code, false)}
        >
          {l.code}
        </button>
      ))}
    </div>
  );
}

/** Einstellungen → Darstellung → Sprache: every language under its own name. */
export function LanguageSetting() {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-fg-muted">{t('Sprache der Oberfläche')}</div>
      <div className={cx('gap-2', LANGUAGES.length <= 3 ? 'flex' : 'grid grid-cols-2')}>
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            lang={l.code}
            aria-pressed={l.code === lang}
            className={cx('flex flex-1 items-center justify-center gap-2 rounded-lg border py-3 text-sm', l.code === lang ? 'border-accent bg-accent-soft' : 'border-line-control hover:border-fg-faint hover:bg-hover')}
            onClick={() => void askLanguage(l.code, 'language')}
          >
            {l.name}
          </button>
        ))}
      </div>
      <p className="text-xs text-fg-faint">{t('Gilt für dein Konto auf allen Geräten, auch für E-Mails an dich. Die Seite lädt dafür kurz neu.')}</p>
      <p className="text-xs text-fg-faint">{t('Notizen werden nie übersetzt.')}</p>
    </div>
  );
}
