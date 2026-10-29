// Welcome page in the main area while no note is open: first steps (ticked off from the real state) and what
// Kaveyl Wiki can do, each with a way into the settings page or the manual chapter. Built in, read-only – it writes
// nothing into the sources and is current with every version.
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, Check, CircleHelp, FolderGit2, HardDriveDownload, History, Lock, Plug, Plus, Smartphone, Sparkles } from 'lucide-react';
import { api, type User } from '../api';
import { Logo } from '../auth/AuthPages';
import { openHelp } from '../help/help';
import { t } from '../i18n';
import { usePersonal } from '../personal';
import { usePrefs } from '../prefs';
import { toast } from '../toast';
import { Button, cx } from '../ui';
import { openSettings } from './settingsNav';

interface Step {
  title: string;
  text: string;
  done?: boolean;
  action?: { label: string; run: () => void };
}

interface Feature {
  icon: ReactNode;
  title: string;
  text: string;
  setup?: () => void;
  help: () => void;
  /** Who it is for; all three when left out. */
  for?: Role[];
}

type Role = 'admin' | 'user' | 'guest';

/** Hides the welcome page and says where it comes back (people who hide hints often want them again later). */
function hide() {
  usePrefs.getState().set({ hideWelcome: true });
  toast({ kind: 'ok', title: t('Willkommensseite ausgeblendet'), text: t('Zurückholen: Einstellungen → Hilfe → „Willkommensseite wieder anzeigen“.') });
}

/**
 * How to put Kaveyl Wiki on this device like an app (installed web app) – only the way for this browser, ticked off when
 * it already runs installed. There is no app to download (AD-061).
 */
function installStep(): Pick<Step, 'text' | 'done'> {
  const nav = navigator as Navigator & { standalone?: boolean };
  const done = nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const how = !window.isSecureContext
    ? t('Dafür braucht Kaveyl Wiki eine https-Adresse – frag sonst die Person, die es betreut.')
    : ios
      ? t('Auf iPhone und iPad in Safari: Teilen → „Zum Home-Bildschirm“.')
      : /Android/.test(ua)
        ? t('Im Menü des Browsers (⋮): „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.')
        : /Firefox\//.test(ua)
          ? t('Firefox am Computer kann das nur teilweise – am einfachsten geht es mit Chrome oder Edge.')
          : /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)
            ? t('In Safari auf dem Mac: Ablage → „Zum Dock hinzufügen“.')
            : t('In Chrome oder Edge: das Installieren-Symbol rechts in der Adressleiste.');
  return {
    text: `${t('Kaveyl Wiki läuft im Browser – herunterladen musst du nichts. Wenn du möchtest, legst du es wie eine App auf Handy, Tablet oder Computer, mit eigenem Symbol und ohne Browserleisten.')} ${how}`,
    done,
  };
}

export function Welcome({ user, hasMounts, onAddMount, onSearch }: { user: User; hasMounts: boolean; onAddMount: () => void; onSearch: () => void }) {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session });
  const mail = !!session.data?.mail;
  const admin = user.isAdmin;
  const role: Role = admin ? 'admin' : user.isGuest ? 'guest' : 'user';
  // Ticked off from what the person did: opened a note, set a favorite (per account, on every device).
  const opened = usePersonal((p) => p.recent.length > 0);
  const starred = usePersonal((p) => p.favorites.length > 0);
  const find: Step = hasMounts
    ? {
        title: role === 'guest' ? t('Geteilte Notiz öffnen') : t('Notizen finden'),
        text:
          role === 'guest'
            ? t('Links im Baum steht, was mit dir geteilt wurde. Mit Strg K suchst du darin – auch im Text der Notizen.')
            : t('Links im Baum stöbern oder mit Strg K suchen – auch im Text der Notizen.'),
        done: opened,
        action: { label: t('Suchen'), run: onSearch },
      }
    : {
        title: t('Auf eine Freigabe warten'),
        text:
          role === 'guest'
            ? t('Noch ist nichts mit dir geteilt. Sobald dir jemand eine Notiz freigibt, steht sie links im Baum – du bekommst dazu eine E-Mail.')
            : t('Dir ist noch keine Quelle freigegeben. Ein Administrator gibt dir Quellen oder Ordner frei – danach erscheinen sie links im Baum.'),
      };
  // Admin-only lists (the routes answer 403 otherwise). Invited people count once they have accepted.
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, enabled: admin });
  const plans = useQuery({ queryKey: ['backup-plans'], queryFn: api.backupPlans, enabled: admin });
  // https is only seen behind a proxy named in TRUST_PROXY (or a direct https) – the same check as the Reverse-Proxy tab.
  const proxy = useQuery({ queryKey: ['reverse-proxy'], queryFn: api.reverseProxy, enabled: admin });

  const steps: Step[] = admin
    ? [
        {
          title: t('Quelle einbinden'),
          text: t('Ein Repository von Gitea, GitHub oder GitLab – oder ein Ordner mit Markdown-Dateien. Deine Notizen bleiben ganz normale Dateien.'),
          done: hasMounts,
          action: { label: t('Quelle einbinden'), run: onAddMount },
        },
        {
          title: t('E-Mail-Versand einrichten'),
          text: t('Nötig für Einladungen, „Passwort vergessen“ und Benachrichtigungen per Mail.'),
          done: mail,
          action: { label: t('E-Mail einrichten'), run: () => openSettings('mail') },
        },
        {
          title: t('Reverse-Proxy mit https einrichten'),
          text: t(
            'Ohne https gehen Passwörter und Notizen unverschlüsselt durchs Netz. Ein Reverse-Proxy (z. B. Nginx Proxy Manager, Pangolin, Cloudflare) sorgt für https und sagt Kaveyl Wiki, wer wirklich anfragt – wichtig für Protokoll und Anmeldebremse.',
          ),
          done: !!proxy.data?.https,
          action: { label: t('Reverse-Proxy'), run: () => openSettings('reverse-proxy') },
        },
        {
          title: t('Leute einladen'),
          text: t('Konten anlegen oder per Mail einladen; mit Gruppen steuerst du, wer welche Quelle sieht und bearbeitet.'),
          done: (users.data?.length ?? 0) > 1,
          action: { label: t('Benutzer verwalten'), run: () => openSettings('users') },
        },
        {
          title: t('Backup festlegen'),
          text: t('Ein Ziel (z. B. ein NAS) und ein Zeitplan – dann sichert Kaveyl Wiki Datenbank und Repositories von selbst.'),
          done: !!plans.data?.some((p) => p.enabled),
          action: { label: t('Backup einrichten'), run: () => openSettings('backup-targets') },
        },
      ]
    : [
        find,
        ...(role === 'user' && hasMounts
          ? [
              {
                title: t('Favoriten merken'),
                text: t('Der Stern oben rechts in einer Notiz legt sie unter „Favoriten“ ganz oben in die Seitenleiste – auf jedem Gerät, mit dem du dich anmeldest.'),
                done: starred,
                action: { label: t('Mehr dazu'), run: () => openHelp('notizen-finden-und-lesen') },
              },
            ]
          : []),
        {
          title: t('Darstellung anpassen'),
          text: t('Hell oder dunkel, Sprache, Schriftgrößen, Breite des Textes.'),
          action: { label: t('Darstellung'), run: () => openSettings('appearance') },
        },
        {
          title: t('Kaveyl Wiki wie eine App benutzen'),
          ...installStep(),
          action: { label: t('So geht’s'), run: () => openHelp('im-browser-und-als-app-handy-tablet-computer') },
        },
      ];

  // For users and guests „Wie eine App“ is a step above; admin-only features (backup, notifications) stay with admins.
  const features = ([
    {
      icon: <Sparkles />,
      title: t('KI-Assistent'),
      text: t('Zusammenfassen, umformulieren, übersetzen und Fragen an deine Notizen stellen – mit einem KI-Anbieter deiner Wahl.'),
      setup: () => openSettings('ai'),
      help: () => openHelp('ki-assistent'),
      for: ['admin', 'user'],
    },
    {
      icon: <Plug />,
      title: t('API und MCP'),
      text: t('Claude, Hermes oder eigene Skripte lesen und schreiben Notizen – mit einem persönlichen Token und genau den Rechten, die du vergibst.'),
      setup: () => openSettings('tokens'),
      help: () => openHelp('api-und-mcp-claude-hermes-skripte'),
      for: ['admin', 'user'],
    },
    {
      icon: <HardDriveDownload />,
      title: t('Backup'),
      text: t('Datenbank und Repositories nach Zeitplan sichern – lokal oder auf ein NAS, mit Prüfung und Wiederherstellen.'),
      setup: () => openSettings('backup-targets'),
      help: () => openHelp('backup'),
      for: ['admin'],
    },
    {
      icon: <Bell />,
      title: t('Benachrichtigungen'),
      text: t('Per E-Mail oder Pushover, wenn ein Abgleich hakt, ein Backup fehlschlägt oder sich jemand verdächtig oft falsch anmeldet.'),
      setup: () => openSettings('events'),
      help: () => openHelp('benachrichtigungen'),
      for: ['admin'],
    },
    {
      icon: <Lock />,
      title: t('Verschlüsselung'),
      text: t('Einzelne Notizen oder ganze Ordner im Browser verschlüsseln – im Repository liegt dann nur noch Geheimtext.'),
      help: () => openHelp('verschlüsselte-notizen-und-ordner'),
      for: ['admin', 'user'],
    },
    {
      icon: <History />,
      title: t('Versionen und Papierkorb'),
      text: t('Jede Änderung ist eine Git-Version zum Vergleichen und Zurückholen; Gelöschtes liegt erst im Papierkorb.'),
      help: () => openHelp('versionen-und-papierkorb'),
    },
    {
      icon: <FolderGit2 />,
      title: t('Mit jedem Editor'),
      text: t('VS Code, Obsidian oder die Kommandozeile arbeiten auf denselben Dateien – Kaveyl Wiki gleicht über Git ab.'),
      help: () => openHelp('was-ist-kaveyl-wiki'),
      for: ['admin', 'user'],
    },
    {
      icon: <Smartphone />,
      title: t('Wie eine App'),
      text: t('Läuft im Browser, ohne Download – und lässt sich auf Handy, Tablet und Computer wie eine App ablegen.'),
      help: () => openHelp('im-browser-und-als-app-handy-tablet-computer'),
      for: ['admin'],
    },
  ] satisfies Feature[] as Feature[]).filter((f) => !f.for || f.for.includes(role));

  return (
    <div className="h-full overflow-y-auto" data-testid="welcome">
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        <div className="flex items-center gap-3">
          <Logo className="h-10 w-10" detail />
        </div>
        <h1 className="mt-6 text-[1.75rem] font-semibold leading-tight text-fg">{t('Willkommen bei Kaveyl Wiki 👋')}</h1>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-fg-muted">
          {role === 'guest'
            ? t('Als Gast siehst du nur, was ausdrücklich mit dir geteilt wurde – und kannst es lesen oder, wenn freigegeben, bearbeiten. Jede Änderung bleibt als Version erhalten.')
            : t('Dein Wiki für Notizen und Wissen – gespeichert als Markdown-Dateien in Git. Hier und in jedem anderen Editor bearbeitbar, mit voller Versionsgeschichte.')}
        </p>

        <section className="mt-8" aria-labelledby="welcome-steps">
          <h2 id="welcome-steps" className="text-sm font-semibold uppercase tracking-wide text-fg-faint">
            {t('Erste Schritte')}
          </h2>
          <ol className="mt-3 space-y-2">
            {steps.map((s, i) => (
              <li key={s.title} className={cx('flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center', s.done ? 'border-line bg-subtle' : 'border-line')}>
                <span
                  className={cx(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                    s.done ? 'bg-ok/15 text-ok' : 'bg-accent-soft text-accent',
                  )}
                  aria-hidden="true"
                >
                  {s.done ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cx('font-medium', s.done ? 'text-fg-muted line-through decoration-fg-faint' : 'text-fg')}>
                    {s.title}
                    {s.done && <span className="sr-only"> {t('(erledigt)')}</span>}
                  </div>
                  <div className="mt-0.5 text-sm text-fg-muted">{s.text}</div>
                </div>
                {!s.done && s.action && (
                  <Button size="sm" variant={i === steps.findIndex((x) => !x.done && x.action) ? 'primary' : 'default'} className="shrink-0 self-start sm:self-center" onClick={s.action.run}>
                    {s.action.run === onAddMount && <Plus className="h-3.5 w-3.5" />}
                    {s.action.label}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-10" aria-labelledby="welcome-features">
          <h2 id="welcome-features" className="text-sm font-semibold uppercase tracking-wide text-fg-faint">
            {t('Was Kaveyl Wiki kann')}
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {features.map((f) => (
              <div key={f.title} className="flex flex-col rounded-lg border border-line p-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">
                    {f.icon}
                  </span>
                  <h3 className="font-medium text-fg">{f.title}</h3>
                </div>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-fg-muted">{f.text}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {f.setup && (
                    <Button size="sm" onClick={f.setup}>
                      {t('Einrichten')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={f.help} aria-label={t('Mehr zu {title}', { title: f.title })}>
                    <CircleHelp className="h-3.5 w-3.5" /> {t('Mehr dazu')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-5 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {/* Shortcuts only where a keyboard is likely – not on touch screens (design-017, like menu shortcuts in ui.tsx). */}
            <span className="[@media(hover:none)]:hidden">
              <Kbd>{t('Strg K')}</Kbd> {t('Suchen und Befehle')}
            </span>
            <span className="[@media(hover:none)]:hidden">
              <Kbd>F1</Kbd> {t('Hilfe')}
            </span>
            {session.data?.version && <span className="text-fg-faint">{t('Version {version}', { version: session.data.version })}</span>}
          </div>
          {hasMounts && (
            <Button size="sm" variant="ghost" className="self-start sm:self-auto" onClick={hide}>
              {t('Nicht mehr anzeigen')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mr-1 rounded border border-line px-1 text-[0.6875rem] text-fg-faint">{children}</kbd>;
}
