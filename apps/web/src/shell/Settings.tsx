// Settings dialog: main entries on the left (Quellen, Werkzeuge, Backup, Benutzer & Rechte, Benachrichtigungen, …),
// related pages as tabs at the top (AD-035). Every page has its help (HELP → manual).
import { WatchingPanel } from './Watch';
import { EventHooksPanel } from './EventHooks';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Settings2, Plus, Copy, Monitor, Sun, Moon } from 'lucide-react';
import { api, errorText, type Mount } from '../api';
import { ConnectionsPanel } from '../mounts/Connections';
import { FsckPanel } from './Fsck';
import { BackupSettings, LogSettings } from './Activity';
import { RepoTrashPanel } from './RepoTrash';
import { MountIcon, MountKind } from './Tree';
import { AllTokensPanel, TokensPanel, UsersPanel } from './Users';
import { CloudflarePanel, GroupsPanel } from './Access';
import { RightsPanel } from './Rights';
import { ProxyAuthPanel, ProxyConnections, ReverseProxyPanel } from './Proxy';
import { useTheme, type Theme } from '../theme';
import { usePrefs, type EditorWidth } from '../prefs';
import { Button, Field, Input, Spinner, cx, useModalDirty, fillNodes, useTabs, FormError, FormStatus, MissingHint, useRepeatCheck } from '../ui';
import { copyWithToast } from '../clipboard';
import { scrollHint } from '../scrollHint';
import { AiPersonalPanel, AiProvidersPanel } from '../ai/AiSettings';
import { MailPanel } from './MailSettings';
import { CleanupPanel } from './Cleanup';
import { NotifyEventsPanel, PushoverPanel } from './Notifications';
import { UpdateLine, UpdatesPanel } from './Updates';
import { FontSizesPanel } from './FontSizes';
import { BackupFilesPanel, BackupPlansPanel, BackupTargetsPanel } from './Backup';
import { useSettingsNav } from './settingsNav';
import { LICENCE_URL, NOTICES_URL, SOURCE_URL, openHelp } from '../help/help';
import { PasswordRules } from '../auth/AuthPages';
import { passwordProblems, PROXY_LABEL } from '@kaveyl-wiki/core';
import { LanguageSetting } from '../Toggles';
import { fmtDateTime, t } from '../i18n';

/** One page of the settings; pages are grouped (left) and shown as tabs (top) inside their group. */
type Page =
  | 'connections'
  | 'mounts'
  | 'webhook'
  | 'attachments'
  | 'cleanup'
  | 'log'
  | 'backups'
  | 'backup-targets'
  | 'backup-plans'
  | 'backup-files'
  | 'check'
  | 'users'
  | 'groups'
  | 'rights'
  | 'all-tokens'
  | 'cloudflare'
  | 'authentik'
  | 'reverse-proxy'
  | 'events'
  | 'mail'
  | 'pushover'
  | 'updates'
  | 'ai'
  | 'appearance'
  | 'language'
  | 'fonts'
  | 'account'
  | 'watching'
  | 'tokens'
  | 'event-hooks'
  | 'help';

interface Group {
  label: string;
  pages: [Page, string][];
}

/** Where the help explains each page (manual: „Einstellungen im Überblick“, tabs as ####). */
const HELP: Record<Page, string> = {
  connections: 'verbindungen',
  mounts: 'eingebundene-quellen',
  webhook: 'webhooks',
  attachments: 'anhänge',
  cleanup: 'aufräumen',
  log: 'protokoll',
  backups: 'datenbank',
  'backup-targets': 'ziele',
  'backup-plans': 'zeitpläne',
  'backup-files': 'sicherungen',
  check: 'prüfung',
  users: 'benutzer',
  groups: 'gruppen',
  rights: 'rechte',
  'all-tokens': 'alle-tokens',
  cloudflare: 'cloudflare-access',
  authentik: 'authentik',
  'reverse-proxy': 'reverse-proxy',
  events: 'ereignisse',
  mail: 'e-mail',
  pushover: 'pushover',
  updates: 'updates',
  ai: 'ki',
  appearance: 'darstellung',
  language: 'sprache',
  fonts: 'schriftgröße',
  account: 'konto',
  watching: 'beobachten-und-pushover',
  tokens: 'api-tokens',
  'event-hooks': 'ereignis-webhooks',
  help: 'hilfe-in-kaveyl-wiki',
};

/** Pages with grids and long lists: the dialog grows to almost the full width (owner 28.10.: „Rechte“ with many sources). */
const WIDE = new Set<Page>(['rights']);

/**
 * Menu structure (AD-035): few main entries on the left, related pages as tabs. The labels stay German (keys for
 * lastInGroup and the e2e helpers) and are translated where they are shown.
 */
function groupsFor(isAdmin: boolean, isGuest: boolean): Group[] {
  const account: Group = {
    label: 'Konto',
    pages: [
      ['account', 'Konto'],
      ['watching', 'Beobachten'],
    ],
  };
  // API tokens sit with the AI: both are about letting programs at the notes (owner 2026-10-16). Guests have no tokens.
  // Everyone's tokens and event webhooks for agents (AD-066) next to them, for admins (owner 28.10.: tokens belong together).
  const ai: Group = {
    label: 'KI & APIs',
    pages: [
      ['ai', 'KI'],
      ...(isGuest ? [] : ([['tokens', 'API-Tokens']] as [Page, string][])),
      ...(isAdmin
        ? ([
            ['all-tokens', 'Alle Tokens'],
            ['event-hooks', 'Ereignis-Webhooks'],
          ] as [Page, string][])
        : []),
    ],
  };
  const appearance: Group = {
    label: 'Darstellung',
    pages: [
      ['appearance', 'Darstellung'],
      ['language', 'Sprache'],
      ['fonts', 'Schriftgröße'],
    ],
  };
  const personal: Group[] = [ai, appearance, account, { label: 'Hilfe', pages: [['help', 'Hilfe']] }];
  if (!isAdmin) return personal;
  return [
    {
      label: 'Quellen',
      pages: [
        ['connections', 'Verbindungen'],
        ['mounts', 'Eingebundene Quellen'],
        ['webhook', 'Webhooks'],
      ],
    },
    { label: 'Anhänge', pages: [['attachments', 'Anhänge']] },
    {
      label: 'Werkzeuge',
      pages: [
        ['cleanup', 'Aufräumen'],
        ['log', 'Protokoll'],
        ['check', 'Prüfung'],
      ],
    },
    {
      label: 'Backup',
      pages: [
        ['backup-targets', 'Ziele'],
        ['backup-plans', 'Zeitpläne'],
        ['backup-files', 'Sicherungen'],
        ['backups', 'Datenbank'],
      ],
    },
    {
      label: 'Benutzer & Rechte',
      pages: [
        ['users', 'Benutzer'],
        ['groups', 'Gruppen'],
        ['rights', 'Rechte'],
      ],
    },
    {
      // Sign-in through something in front of Kaveyl Wiki (AD-049; own entry, owner 2026-10-16).
      label: 'SSO & Proxy',
      pages: [
        ['cloudflare', 'Cloudflare Access'],
        ['authentik', PROXY_LABEL.authentik],
        ['reverse-proxy', 'Reverse-Proxy'],
      ],
    },
    {
      label: 'Benachrichtigungen',
      pages: [
        ['mail', 'E-Mail'],
        ['pushover', 'Pushover'],
        ['events', 'Ereignisse'],
        ['updates', 'Updates'],
      ],
    },
    ...personal,
  ];
}

/** The pages of the settings, inside the dialog the shell opens at once (pages load on first open, seo-001). */
export function SettingsBody({ open, onClose, onAddMount, onEditMount, isAdmin }: { open: boolean; onClose: () => void; onAddMount: () => void; onEditMount: (m: Mount) => void; isAdmin: boolean }) {
  const me = useQuery({ queryKey: ['session'], queryFn: api.session }).data?.user ?? null;
  const mountList = useQuery({ queryKey: ['mounts'], queryFn: api.mounts }).data ?? [];
  const groups = groupsFor(isAdmin, !!me?.isGuest);
  const [page, setPage] = useState<Page>(isAdmin ? 'connections' : 'appearance');
  /** Last tab per group: coming back to a group shows it again. */
  const [lastInGroup, setLastInGroup] = useState<Record<string, Page>>({});
  const group = groups.find((g) => g.pages.some(([k]) => k === page)) ?? groups[0]!;
  const pageLabel = group.pages.find(([k]) => k === page)?.[1] ?? group.label;
  const go = (p: Page) => {
    const g = groups.find((x) => x.pages.some(([k]) => k === p));
    if (g) setLastInGroup((cur) => ({ ...cur, [g.label]: p }));
    setPage(p);
  };
  const tabs = useTabs(
    group.pages.map(([k]) => k),
    page,
    go,
  );
  // Opened from elsewhere at a given page (e.g. the source menu → Backup).
  const request = useSettingsNav((s) => s.request);
  useEffect(() => {
    if (request && groups.some((g) => g.pages.some(([k]) => k === request.page))) go(request.page as Page);
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // A narrow row keeps its scroll position across a switch: bring the active area and tab into view
  // (once the dialog's content is mounted – it renders a frame later through the portal).
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() =>
      body.current
        ?.querySelectorAll<HTMLElement>(':scope > nav > [aria-current="page"], :scope > div > div > [role="tablist"] > [aria-selected="true"]')
        .forEach((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' })),
    );
    return () => cancelAnimationFrame(id);
  }, [open, page]);
  // The help sits in the dialog's title bar like in every other dialog, not in the tab row (design-005: it took the room
  // the tabs of „SSO & Proxy“ need). The help page itself has none.
  useEffect(() => {
    useSettingsNav.setState({ help: page === 'help' ? null : HELP[page], wide: WIDE.has(page) });
  }, [page]);
  return (
    <>
      <div ref={body} className="flex flex-col gap-4 sm:flex-row">
        <nav ref={scrollHint} className="scroll-hint flex shrink-0 gap-1 overflow-x-auto sm:w-44 sm:flex-col" aria-label={t('Bereiche')}>
          {groups.map((g) => (
            <button
              key={g.label}
              aria-current={g === group ? 'page' : undefined}
              className={cx('shrink-0 rounded-md px-2.5 py-1.5 text-left text-sm', g === group ? 'bg-active font-medium' : 'text-fg-muted hover:bg-hover')}
              onClick={() => setPage(lastInGroup[g.label] ?? g.pages[0]![0])}
            >
              {t(g.label)}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1" data-help={HELP[page]}>
          {/* The same header row on every page (tabs, or just the page name). The line is drawn behind the tabs
              instead of pulling them over it (-mb-px), which made the tab row scroll 1 px. */}
          <div className="relative mb-4 flex items-end gap-2 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-line">
            {group.pages.length > 1 ? (
              // One row: tabs never wrap under each other (narrow screens scroll sideways, the hidden side fades).
              <div ref={scrollHint} {...tabs.list} aria-label={t(group.label)} className="scroll-hint flex min-w-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden">
                {group.pages.map(([k, label]) => (
                  <button
                    key={k}
                    {...tabs.tab(k)}
                    className={cx('relative shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-sm', page === k ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg')}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            ) : (
              <div className="min-w-0 flex-1">
                <span className="relative inline-block whitespace-nowrap border-b-2 border-accent px-3 py-1.5 text-sm font-medium text-fg">{t(pageLabel)}</span>
              </div>
            )}
          </div>
          <div {...(group.pages.length > 1 ? tabs.panel : {})}>
            {page === 'help' && <HelpTab isAdmin={isAdmin} />}
            {page === 'connections' && <ConnectionsPanel />}
            {page === 'mounts' && (
              <div className="space-y-6">
                <Sources onEdit={onEditMount} onAdd={onAddMount} />
                <RepoTrashPanel />
              </div>
            )}
            {page === 'webhook' && <Webhook />}
            {page === 'attachments' && <AttachmentSettings />}
            {page === 'cleanup' && <CleanupPanel onOpenTab={go} />}
            {page === 'log' && <LogSettings />}
            {page === 'backups' && <BackupSettings />}
            {page === 'backup-targets' && <BackupTargetsPanel onOpenTab={go} />}
            {page === 'backup-plans' && <BackupPlansPanel onOpenTab={go} />}
            {page === 'backup-files' && <BackupFilesPanel onOpenTab={go} />}
            {page === 'check' && <FsckPanel onOpenNote={onClose} />}
            {page === 'users' && me && <UsersPanel me={me} />}
            {page === 'groups' && <GroupsPanel />}
            {page === 'rights' && <RightsPanel onShow={onClose} />}
            {page === 'cloudflare' && <CloudflarePanel />}
            {page === 'authentik' && <ProxyAuthPanel provider="authentik" />}
            {page === 'reverse-proxy' && <ReverseProxyPanel />}
            {page === 'events' && <NotifyEventsPanel onOpenTab={go} />}
            {page === 'mail' && <MailPanel />}
            {page === 'pushover' && <PushoverPanel />}
            {page === 'updates' && <UpdatesPanel />}
            {page === 'ai' && (
              <div className="space-y-6">
                {isAdmin && <AiProvidersPanel />}
                <div className={cx(isAdmin && 'border-t border-line pt-4')}>
                  <AiPersonalPanel />
                </div>
              </div>
            )}
            {page === 'tokens' && me && <TokensPanel me={me} />}
            {page === 'all-tokens' && <AllTokensPanel />}
            {page === 'event-hooks' && <EventHooksPanel mounts={mountList} />}
            {page === 'watching' && <WatchingPanel mounts={mountList} />}
            {page === 'appearance' && <Appearance />}
            {page === 'language' && <LanguageSetting />}
            {page === 'fonts' && <FontSizesPanel />}
            {page === 'account' && (
              <div className="space-y-6">
                <Account email={me?.email ?? ''} />
                <ProxyConnections />
                <AutoLockSetting />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Sources({ onEdit, onAdd }: { onEdit: (m: Mount) => void; onAdd: () => void }) {
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{t('Eingebundene Quellen')}</h3>
      <p className="text-sm text-fg-muted">
        {t('Repositories und Ordner, die links in der Seitenleiste erscheinen. Das Zahnrad bearbeitet eine Quelle, der Pfeil gleicht eine Git-Quelle sofort ab.')}
      </p>
      <div className="divide-y divide-line rounded-lg border border-line">
        {mounts.data?.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex w-4 shrink-0 justify-center text-fg-faint">
              <MountIcon mount={m} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {m.name}
                <MountKind mount={m} />
                {m.paused && <span className="rounded bg-muted px-1.5 text-[0.6875rem] font-normal text-fg-muted">{t('pausiert')}</span>}
                {m.options.readonly && <span className="rounded bg-muted px-1.5 text-[0.6875rem] font-normal text-fg-muted">{t('nur lesen')}</span>}
              </div>
              <div className="truncate text-xs text-fg-faint">
                {m.source}
                {m.branch ? ` · ${m.branch}` : ''}
                {m.include.join(',') !== '**' ? ` · ${m.include.join(', ')}` : ''}
              </div>
              <div className={cx('text-xs', m.syncStatus === 'error' ? 'text-danger' : m.syncStatus === 'conflict' ? 'text-warn' : 'text-fg-faint')}>
                {m.syncStatus === 'ok' && m.syncedAt && t('Stand: {when}', { when: fmtDateTime(m.syncedAt) })}
                {m.syncStatus === 'ok' &&
                  m.type === 'remote' &&
                  ' · ' +
                    (m.webhookAt
                      ? t('Sofort-Abgleich per Webhook (zuletzt {when})', { when: fmtDateTime(m.webhookAt) })
                      : t('Abgleich alle 5 Min. (kein Webhook)'))}
                {m.syncStatus === 'error' && t('Fehler: {detail}', { detail: m.syncDetail ?? '' })}
                {m.syncStatus === 'conflict' && t('Konflikt beim Synchronisieren – lokale Änderungen sind gesichert. Auflösen über das Sync-Symbol oben links.')}
              </div>
            </div>
            {m.type === 'remote' && (
              <Button
                size="sm"
                variant="ghost"
                title={t('Jetzt synchronisieren')}
                disabled={syncing === m.id}
                onClick={async () => {
                  setSyncing(m.id);
                  await api.syncMount(m.id).catch(() => undefined);
                  await qc.invalidateQueries({ queryKey: ['mounts'] });
                  setSyncing(null);
                }}
              >
                {syncing === m.id ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            )}
            <Button size="sm" variant="ghost" title={t('Bearbeiten')} aria-label={t('{name} bearbeiten', { name: m.name })} onClick={() => onEdit(m)}>
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {mounts.data?.length === 0 && <div className="p-4 text-sm text-fg-muted">{t('Noch keine Quelle eingebunden.')}</div>}
      </div>
      <Button size="sm" variant="primary" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" /> {t('Quelle einbinden')}
      </Button>
    </div>
  );
}

function AttachmentSettings() {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ['attachment-settings'], queryFn: api.attachmentSettings });
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = value ?? String(current.data?.maxMb ?? '');
  useModalDirty(value !== null && value !== String(current.data?.maxMb));
  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Dateien und Bilder, die in eine Notiz gezogen, eingefügt oder über die Büroklammer angehängt werden, landen im Ordner {ordner} neben der Notiz und werden mit committet. Große Dateien machen Repositories dauerhaft größer (Git vergisst nichts) – deshalb gibt es ein Limit.',
          ),
          { ordner: <code>assets/</code> },
        )}
      </p>
      <label className="flex items-center gap-2">
        <span className="w-48">{t('Größte erlaubte Datei (MB)')}</span>
        <input
          type="number"
          min={1}
          max={200}
          className="h-8 w-24 rounded-md border border-line bg-bg px-2"
          value={shown}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          size="sm"
          disabled={value === null || value === String(current.data?.maxMb)}
          onClick={async () => {
            try {
              await api.saveAttachmentSettings({ maxMb: Number(value) });
              setError(null);
              setValue(null);
              await qc.invalidateQueries({ queryKey: ['attachment-settings'] });
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          {t('Speichern')}
        </Button>
      </label>
      <FormError>{error}</FormError>
      <Field
        label={t('Große Bilder beim Einfügen verkleinern')}
        hint={t(
          'Fotos und Bildschirmfotos werden vor dem Hochladen im Browser auf diese Kantenlänge verkleinert und als WebP gespeichert – Notizen laden und scrollen schneller, das Repository bleibt klein. GPS- und Kameradaten fallen dabei weg. GIF und SVG bleiben unverändert.',
        )}
      >
        <select
          aria-label={t('Große Bilder beim Einfügen verkleinern')}
          className="h-8 w-full max-w-xs rounded-md border border-line bg-bg px-2 text-sm"
          value={current.data?.imageMaxPx ?? 2400}
          onChange={async (e) => {
            try {
              await api.saveAttachmentSettings({ imageMaxPx: Number(e.target.value) });
              setError(null);
              await qc.invalidateQueries({ queryKey: ['attachment-settings'] });
              await qc.invalidateQueries({ queryKey: ['attachment-limits'] });
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          {[
            [1600, t('Auf 1600 Pixel (klein)')],
            [2400, t('Auf 2400 Pixel (Standard)')],
            [3200, t('Auf {px} Pixel', { px: 3200 })],
            [4000, t('Auf 4000 Pixel (groß)')],
            [0, t('Nicht verkleinern (Originale)')],
          ].map(([px, label]) => (
            <option key={px} value={px}>
              {label}
            </option>
          ))}
          {current.data && ![0, 1600, 2400, 3200, 4000].includes(current.data.imageMaxPx) && (
            <option value={current.data.imageMaxPx}>{t('Auf {px} Pixel', { px: current.data.imageMaxPx })}</option>
          )}
        </select>
      </Field>
      <p className="text-xs text-fg-muted">
        {t(
          'In Notizen nimmt ein Bild ohne eigene Breite höchstens etwa zwei Drittel der Fensterhöhe ein; die Lupe (oder ein Klick in der Leseansicht) zeigt es groß. Die Breite lässt sich mit dem Anfasser unten rechts am ausgewählten Bild ändern.',
        )}
      </p>
      {current.data && <BlockedTypes blocked={current.data.blocked} blockedDefault={current.data.blockedDefault} />}
      <p className="text-xs text-fg-faint">
        {t('Gleichnamige Dateien werden durchnummeriert, nie überschrieben. Nicht mehr verlinkte Anhänge meldet die Prüfung (Einstellungen → Werkzeuge → Prüfung).')}
      </p>
    </div>
  );
}

/** File endings that may not be attached (owner 25.10.: a list instead of fixed blocks) – prefilled with the executables. */
function BlockedTypes({ blocked, blockedDefault }: { blocked: string[]; blockedDefault: string[] }) {
  const qc = useQueryClient();
  const stored = blocked.join(', ');
  const [value, setValue] = useState(stored);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useModalDirty(value !== stored);
  const save = async (next: string | string[]) => {
    setStatus(null);
    try {
      const r = await api.saveAttachmentSettings({ blocked: next });
      setValue(r.blocked.join(', '));
      await qc.invalidateQueries({ queryKey: ['attachment-settings'] });
      setStatus({ ok: true, text: r.blocked.length ? t('Gespeichert.') : t('Gespeichert – es ist keine Dateiendung mehr gesperrt.') });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    }
  };
  const isDefault = blocked.join(',') === blockedDefault.join(',');
  return (
    <Field
      label={t('Gesperrte Dateiendungen')}
      hint={t(
        'Dateien mit diesen Endungen lassen sich nicht anhängen – über die App, die API und MCP. Ab Werk sind es ausführbare Dateien, die ein Klick auf einem anderen Rechner starten könnte. Mit Komma oder Leerzeichen trennen; leer = alles erlaubt. Dateien, die über Git oder einen eingehängten Ordner kommen, sind davon nicht betroffen.',
      )}
    >
      <div className="space-y-2">
        <textarea
          aria-label={t('Gesperrte Dateiendungen')}
          className="h-20 w-full rounded-md border border-line bg-bg p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={value === stored} onClick={() => void save(value)}>
            {t('Speichern')}
          </Button>
          <Button size="sm" disabled={isDefault} onClick={() => void save(blockedDefault)}>
            {t('Standardliste')}
          </Button>
          {status && (
            <span className={status.ok ? 'text-ok' : 'text-danger'} role="status">
              {status.text}
            </span>
          )}
        </div>
      </div>
    </Field>
  );
}

/**
 * Where the hoster reaches Kaveyl Wiki (owner 25.10.): FQDN or IP with http(s) and port; the path /api/webhooks/git is
 * added. Empty = the public address (Benachrichtigungen → E-Mail), so mail links and webhooks may differ.
 */
function WebhookAddress({ base }: { base: string }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(base);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setValue(base), [base]);
  useModalDirty(value.trim() !== base);
  const save = async () => {
    setStatus(null);
    try {
      const r = await api.saveWebhookAddress(value.trim());
      setValue(r.base);
      await qc.invalidateQueries({ queryKey: ['webhook'] });
      setStatus({ ok: true, text: r.base ? t('Gespeichert. „Webhook einrichten“ bei der Verbindung stellt vorhandene Webhooks auf diese Adresse um.') : t('Gespeichert – es gilt wieder die öffentliche Adresse.') });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    }
  };
  return (
    <Field
      label={t('Adresse, unter der der Anbieter Kaveyl Wiki erreicht')}
      hint={t(
        'Zum Beispiel http://192.168.1.20:8093 oder https://wiki.example.org – ohne Pfad, /api/webhooks/git hängt Kaveyl Wiki an. Leer = die öffentliche Adresse (Einstellungen → Benachrichtigungen → E-Mail). HTTP reicht im eigenen Netz, über das Internet besser HTTPS; GitHub.com und GitLab.com brauchen eine Adresse aus dem Internet.',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-0 flex-1 font-mono text-xs" value={value} placeholder="http://192.168.1.20:8093" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save())} />
        <Button size="sm" variant="primary" disabled={value.trim() === base} onClick={() => void save()}>
          {t('Speichern')}
        </Button>
      </div>
      {status && (
        <p className={cx('mt-1 text-xs', status.ok ? 'text-ok' : 'text-danger')} role="status">
          {status.text}
        </p>
      )}
    </Field>
  );
}

/**
 * Settings → Quellen → Webhooks (AD-033): the address and secret for hooks set up by hand, how per hoster, and
 * what arrived lately. Setting them up automatically happens at each connection (Quellen → Verbindungen).
 */
function Webhook() {
  const hook = useQuery({ queryKey: ['webhook'], queryFn: api.webhookSettings });
  const d = hook.data;
  const url = d?.url ?? `${location.origin}/api/webhooks/git`;
  const step = (title: string, children: ReactNode) => (
    <details className="rounded-lg border border-line px-3 py-2">
      <summary className="cursor-pointer font-medium">{title}</summary>
      <div className="mt-2 space-y-1 text-fg-muted">{children}</div>
    </details>
  );
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Ohne Webhook holt Kaveyl Wiki Änderungen aus Repositories {fuenf}. Mit Webhook meldet der Anbieter jeden Push sofort. Am einfachsten: Einstellungen → Quellen → Verbindungen → {einrichten} (Gitea: einmal für das ganze Konto). Von Hand mit diesen Angaben:',
          ),
          { fuenf: <strong>{t('alle 5 Minuten')}</strong>, einrichten: <em>{t('Webhook einrichten')}</em> },
        )}
      </p>
      {d && <WebhookAddress base={d.base} />}
      <CopyRow label="Ziel-URL" value={url} />
      <CopyRow label="Secret" value={d?.secret ?? '…'} secret />
      {d && d.source === 'browser' && (
        <p className="text-xs text-warn">
          {t(
            'Die Adresse stammt aus dem Browser. Für Webhooks lieber oben die Adresse eintragen, unter der der Anbieter Kaveyl Wiki erreicht (oder die öffentliche Adresse unter Einstellungen → Benachrichtigungen → E-Mail).',
          )}
        </p>
      )}
      {d?.lan && (
        <p className="text-xs text-warn">
          {fillNodes(t('Adresse im eigenen Netz: GitHub.com und GitLab.com erreichen sie nicht, ein eigenes Gitea nur mit {setting} – ab Gitea 28 im Abschnitt {section} seiner {file}, davor {old} (in Docker {env} bzw. {envOld}), danach Gitea neu starten.'), {
            setting: <code>ALLOWED_HOST_LIST = private</code>,
            section: <code>[security]</code>,
            file: <code>app.ini</code>,
            old: <code>[webhook]</code>,
            env: <code>GITEA__security__ALLOWED_HOST_LIST</code>,
            envOld: <code>GITEA__webhook__ALLOWED_HOST_LIST</code>,
          })}
        </p>
      )}
      <div className="space-y-2">
        {step(
          'Gitea',
          <>
            <p>
              <strong>{t('Für alle eigenen Repositories:')}</strong>{' '}
              {fillNodes(
                t(
                  'Benutzer-Einstellungen → Webhooks → Webhook hinzufügen → {gitea}. Für Repositories einer Organisation: Organisation → Einstellungen → Webhooks. Für ein einzelnes Repository: Repository → Einstellungen → Webhooks.',
                ),
                { gitea: <em>Gitea</em> },
              )}
            </p>
            <p>{t('Ziel-URL und Secret von oben, HTTP-Methode POST, Inhaltstyp application/json, Auslöser: Push-Ereignisse, Branch-Filter *.')}</p>
            <p>{t('Nur eine Ebene pro Repository – Konto- und Repository-Webhook zugleich melden jeden Push doppelt (harmlos, aber unnötig).')}</p>
          </>,
        )}
        {step(
          'GitHub',
          <>
            <p>
              {t(
                'Pro Repository: Settings → Webhooks → Add webhook (für alle Repositories einer Organisation: Organisation → Settings → Webhooks). Persönliche Konten haben keinen kontoweiten Webhook.',
              )}
            </p>
            <p>{t('Payload URL und Secret von oben, Content type application/json, „Just the push event“. Braucht eine öffentlich erreichbare Adresse.')}</p>
          </>,
        )}
        {step(
          'GitLab',
          <>
            <p>
              {t(
                'Pro Projekt: Einstellungen → Webhooks (für eine ganze Gruppe nur in kostenpflichtigen Versionen). URL von oben, das Secret als „Secret token“, Auslöser: Push events.',
              )}
            </p>
          </>,
        )}
      </div>
      <section aria-label={t('Zuletzt empfangen')} className="space-y-1">
        <h3 className="text-xs font-medium text-fg-muted">{t('Zuletzt empfangen')}</h3>
        {d && d.recent.length === 0 && <p className="text-xs text-fg-faint">{t('Noch kein Webhook angekommen.')}</p>}
        <ul className="divide-y divide-line rounded-lg border border-line text-xs empty:hidden">
          {d?.recent.map((r, i) => (
            <li key={i} className={cx('flex gap-2 px-2.5 py-1.5', r.action === 'webhook-rejected' ? 'text-warn' : 'text-fg-muted')}>
              <span className="shrink-0 text-fg-faint">{fmtDateTime(r.at)}</span>
              <span className="min-w-0 flex-1">{r.message}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-fg-muted">{t(label)}</div>
      <div className="flex items-center gap-2 rounded-md border border-line bg-subtle px-2 py-1.5">
        <code className="flex-1 truncate text-xs">{shown ? value : '•'.repeat(24)}</code>
        {secret && (
          <button className="text-xs text-accent" onClick={() => setShown(!shown)}>
            {shown ? t('verbergen') : t('anzeigen')}
          </button>
        )}
        <button className="text-fg-muted hover:text-fg" onClick={() => void copyWithToast(value, label)} aria-label={t('Kopieren')}>
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Appearance() {
  const [theme, setTheme] = useTheme();
  const options: [Theme, string, React.ReactNode][] = [
    ['system', t('System'), <Monitor key="s" className="h-4 w-4" />],
    ['light', t('Hell'), <Sun key="l" className="h-4 w-4" />],
    ['dark', t('Dunkel'), <Moon key="d" className="h-4 w-4" />],
  ];
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-fg-muted">{t('Farbschema')}</div>
      <div className="flex gap-2">
        {options.map(([k, label, icon]) => (
          <button key={k} aria-pressed={theme === k} className={cx('flex flex-1 items-center justify-center gap-2 rounded-lg border py-3 text-sm', theme === k ? 'border-accent bg-accent-soft' : 'border-line-control hover:border-fg-faint hover:bg-hover')} onClick={() => setTheme(k)}>
            {icon}
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-fg-faint">{t('„System“ folgt automatisch der Einstellung deines Betriebssystems.')}</p>
      <EditorWidthSetting />
    </div>
  );
}

function EditorWidthSetting() {
  const { editorWidth, showToc, set } = usePrefs();
  const custom = typeof editorWidth === 'number';
  const [pct, setPct] = useState(custom ? editorWidth : 80);
  const options: [EditorWidth, string, string][] = [
    ['normal', t('Normal'), t('ca. 860 px – angenehme Lesebreite')],
    ['wide', t('Breit'), t('ca. 1200 px')],
    ['full', t('Volle Breite'), t('nutzt den ganzen Bereich')],
  ];
  return (
    <div className="space-y-2 pt-4">
      <div className="text-xs font-medium text-fg-muted">{t('Editorbreite')}</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {options.map(([k, label, hint]) => (
          <button
            key={String(k)}
            aria-pressed={editorWidth === k}
            className={cx('rounded-lg border px-2 py-2 text-left text-sm', editorWidth === k ? 'border-accent bg-accent-soft' : 'border-line-control hover:border-fg-faint hover:bg-hover')}
            onClick={() => set({ editorWidth: k })}
          >
            <span className="block">{label}</span>
            <span className="block text-[0.6875rem] text-fg-faint">{hint}</span>
          </button>
        ))}
        <button
          aria-pressed={custom}
          className={cx('rounded-lg border px-2 py-2 text-left text-sm', custom ? 'border-accent bg-accent-soft' : 'border-line-control hover:border-fg-faint hover:bg-hover')}
          onClick={() => set({ editorWidth: pct })}
        >
          <span className="block">{t('Eigene')}</span>
          <span className="block text-[0.6875rem] text-fg-faint">{t('{pct} % des Bereichs', { pct })}</span>
        </button>
      </div>
      {custom && (
        <label className="flex items-center gap-3 text-sm">
          <input
            type="range"
            min={30}
            max={100}
            step={5}
            value={pct}
            aria-label={t('Editorbreite in Prozent')}
            className="flex-1 accent-[var(--accent)]"
            onChange={(e) => {
              const v = Number(e.target.value);
              setPct(v);
              set({ editorWidth: v });
            }}
          />
          <span className="w-12 text-right tabular-nums">{pct} %</span>
        </label>
      )}
      <p className="text-xs text-fg-faint">{t('Prozentwerte skalieren mit dem Fenster. Schnell umschalten: Symbol ⤢ oben rechts in jeder Notiz.')}</p>
      <label className="flex items-center gap-2 pt-2 text-sm">
        <input type="checkbox" className="accent-[var(--accent)]" checked={showToc} onChange={(e) => set({ showToc: e.target.checked })} />
        {t('Inhaltsverzeichnis rechts neben der Notiz anzeigen (ab 2 Überschriften, wenn genug Platz ist)')}
      </label>
    </div>
  );
}

function Account({ email }: { email: string }) {
  const [f, setF] = useState({ current: '', next: '', repeat: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const repeat = useRepeatCheck(f.next, f.repeat);
  const missingId = useId();
  const missing = [
    !f.current && t('Aktuelles Passwort'),
    !f.next ? t('Neues Passwort') : passwordProblems(f.next, [email]).length > 0 && t('Anforderungen an das Passwort'),
    !!f.next && f.next !== f.repeat && t('Neues Passwort wiederholen'),
  ].filter((x): x is string => !!x);
  return (
    <form
      className="max-w-sm space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (f.next !== f.repeat) return setMsg({ ok: false, text: t('Neue Passwörter stimmen nicht überein') });
        setBusy(true);
        try {
          await api.changePassword(f.current, f.next);
          setF({ current: '', next: '', repeat: '' });
          setMsg({ ok: true, text: t('Passwort geändert. Andere Sitzungen wurden abgemeldet.') });
        } catch (err) {
          setMsg({ ok: false, text: errorText(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="text-sm">
        {fillNodes(t('Anmeldung mit {email}'), { email: <strong>{email}</strong> })}
      </div>
      <h3 className="text-sm font-medium">{t('Passwort ändern')}</h3>
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <Field label={t('Aktuelles Passwort')}>
        <Input type="password" autoComplete="current-password" value={f.current} onChange={set('current')} />
      </Field>
      <Field label={t('Neues Passwort')} hint={<PasswordRules value={f.next} context={[email]} />}>
        <Input type="password" autoComplete="new-password" value={f.next} onChange={set('next')} />
      </Field>
      <Field label={t('Neues Passwort wiederholen')} error={repeat.error}>
        <Input type="password" autoComplete="new-password" value={f.repeat} onChange={set('repeat')} onBlur={repeat.onBlur} />
      </Field>
      {msg?.ok ? <FormStatus ok className="block text-sm">{msg.text}</FormStatus> : <FormError>{msg?.text}</FormError>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="primary" disabled={busy || missing.length > 0} aria-describedby={missing.length ? missingId : undefined}>
          {busy && <Spinner />} {t('Passwort ändern')}
        </Button>
        <MissingHint id={missingId} items={missing} />
      </div>
      <h3 className="pt-3 text-sm font-medium">{t('Konto löschen')}</h3>
      <p className="text-sm text-fg-muted">
        {t('Löschen kann ein Administrator: bitte dort beantragen. Gelöscht werden Konto, Einstellungen, KI-Chats, Tokens und dein Name im Protokoll; deine Notizen bleiben, in der Git-Historie bleibt dein Name als Autor.')}
      </p>
    </form>
  );
}

/** Settings → Konto: when unlocked encrypted notes lock again (per user, AD-021). */
function AutoLockSetting() {
  const { autoLockMin, set } = usePrefs();
  const options: [number, string][] = [
    [5, t('{n} Minuten', { n: 5 })],
    [15, t('{n} Minuten', { n: 15 })],
    [30, t('{n} Minuten', { n: 30 })],
    [60, t('1 Stunde')],
    [0, t('erst beim Schließen der Seite')],
  ];
  return (
    <div className="space-y-2 border-t border-line pt-4 text-sm">
      <h3 className="font-medium">{t('Automatisch sperren')}</h3>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-muted">{t('Verschlüsselte Notizen wieder sperren nach')}</span>
        <select
          aria-label={t('Automatisch sperren nach')}
          value={autoLockMin}
          onChange={(e) => set({ autoLockMin: Number(e.target.value) })}
          className="h-8 w-60 rounded border border-line bg-bg px-2"
        >
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-fg-faint">{t('Gezählt wird ab der letzten Nutzung. Neu laden oder Schließen der Seite sperrt immer; „…“ → „Jetzt sperren“ sofort.')}</p>
    </div>
  );
}

/** Settings → Hilfe: what Kaveyl Wiki is, where help is found, good starting points. */
function HelpTab({ isAdmin }: { isAdmin: boolean }) {
  const link = (anchor: string, text: string, doc: 'handbuch' | 'api' = 'handbuch') => (
    <button className="text-accent hover:underline" onClick={() => openHelp(anchor, doc)}>
      {text}
    </button>
  );
  const external = (href: string, text: string) => (
    <a className="text-accent hover:underline" href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
  // Release images say „0.1.0 (685591d)“; the owner's development builds „0.1.0+dev (b7fba0a)“, local builds „dev“.
  const version = useQuery({ queryKey: ['session'], queryFn: api.session }).data?.version;
  const welcomeHidden = usePrefs((p) => p.hideWelcome);
  return (
    <div className="space-y-4 text-sm">
      {/* At the top (owner 22.10.): which version runs, and – for admins – whether a newer one is out (AD-062). */}
      {version && (
        <section className="space-y-1" aria-label={t('Version')}>
          <h3 className="font-medium">{t('Version')}</h3>
          <p className="text-fg-muted">
            Kaveyl Wiki <span className="font-mono text-fg">{version}</span>
            {version.includes('dev') && ` – ${t('Entwicklungsstand, kein veröffentlichtes Release')}`}
            {/* AD-070: the word comes with the version string of a beta release. */}
            {version.includes('Beta') && ` – ${t('Der Funktionsumfang steht, Fehler sind aber noch möglich. Sichere deine Daten regelmäßig.')}`}
          </p>
          <UpdateLine isAdmin={isAdmin} />
          {/* Licences in plain sight (owner 2026-10-22, AD-064): own licence, source code, third-party notices. */}
          <p className="text-fg-muted">
            {fillNodes(t('Freie Software unter der {agpl} · {source} · {notices}'), {
              agpl: external(LICENCE_URL, 'GNU AGPL-3.0'),
              source: external(SOURCE_URL, t('Quellcode')),
              notices: external(NOTICES_URL, t('Lizenzen der verwendeten Komponenten')),
            })}
          </p>
        </section>
      )}
      <section className="space-y-2" aria-label={t('Was ist Kaveyl Wiki?')}>
        <h3 className="font-medium">{t('Was ist Kaveyl Wiki?')}</h3>
        {/* Same text as „Auf einen Blick“ in the manual. */}
        <div className="space-y-2 text-fg-muted">
          <p>
            <b className="text-fg">{t('Dateien statt Datenbank.')}</b>{' '}
            {t(
              'Kaveyl Wiki ist ein Wiki für ganz normale Markdown-Dateien – eine eigene Datenbank für Inhalte gibt es nicht. Die Notizen liegen in Git-Repositories (Gitea, GitHub, GitLab oder jede Git-Adresse) oder in Ordnern, die in den Container eingehängt sind. Jede Quelle erscheint links als eigener Baum; die Sofort-Suche und die Befehlspalette (Strg+K) finden alles.',
            )}
          </p>
          <p>
            <b className="text-fg">{t('Schreiben und Abgleichen.')}</b>{' '}
            {t(
              'Geschrieben wird in einem Editor, der die Formatierung direkt zeigt, oder im Markdown-Quelltext. Gespeichert wird sofort; in Repositories macht Kaveyl Wiki daraus Commits mit dir als Autor und überträgt sie. Was du in VS Code, Wiki.js oder per git änderst, erscheint ebenso in Kaveyl Wiki – nichts wird still überschrieben, Konflikte zeigt Kaveyl Wiki an.',
            )}
          </p>
          <p>
            <b className="text-fg">{t('Schutz und Rechte.')}</b>{' '}
            {t(
              'Versionen, Papierkorb, Backups auf ein NAS oder einen eigenen Ordner, Link-Reparatur und eine nächtliche Prüfung schützen vor Verlust und gebrochenen Links. Rechte, Gruppen, Gäste und verschlüsselte Notizen regeln, wer was sehen und ändern darf.',
            )}
          </p>
          <p>
            <b className="text-fg">{t('KI und Schnittstellen.')}</b>{' '}
            {t(
              'Ein KI-Assistent hilft beim Schreiben und beantwortet Fragen aus freigegebenen Notizen – er schlägt nur vor, du entscheidest. Über REST-API und MCP arbeiten Skripte und KI-Werkzeuge wie Claude mit denselben Rechten mit.',
            )}
          </p>
        </div>
      </section>
      <section className="space-y-2" aria-label={t('Wo finde ich Hilfe?')}>
        <h3 className="font-medium">{t('Wo finde ich Hilfe?')}</h3>
        <ul className="list-disc space-y-1 pl-5 text-fg-muted">
          <li>
            {fillNodes(t('{hier}: oben rechts in jedem Bereich und Reiter „Hilfe“ – erklärt jeden Eintrag dort.'), {
              hier: <b className="text-fg">{t('Hier in den Einstellungen')}</b>,
            })}
          </li>
          <li>
            {fillNodes(t('{ueberall}: {f1} (in einem Einstellungsbereich: die Hilfe dazu), das {frage} oben rechts oder in der Befehlspalette (Strg+K) „Hilfe“.'), {
              ueberall: <b className="text-fg">{t('Überall')}</b>,
              f1: <kbd>F1</kbd>,
              frage: <b className="text-fg">?</b>,
            })}
          </li>
          <li>
            {fillNodes(t('{editor}: das {frage} am Ende der Formatierungsleiste öffnet die {hilfe} mit dem {spick}.'), {
              editor: <b className="text-fg">{t('Im Editor')}</b>,
              frage: <b className="text-fg">?</b>,
              hilfe: link('bearbeiten', t('Hilfe zum Editor')),
              spick: link('markdown-spickzettel', t('Markdown-Spickzettel')),
            })}
          </li>
          <li>
            {fillNodes(t('Die Hilfe ist das vollständige Benutzerhandbuch mit Bildern und einer Suche; daneben die {api}.'), {
              api: link('', t('Referenz für API und MCP'), 'api'),
            })}
          </li>
        </ul>
      </section>
      <section className="space-y-2" aria-label={t('Einstieg')}>
        <h3 className="font-medium">{t('Gute Einstiege')}</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => openHelp('was-ist-kaveyl-wiki')}>
            {t('Handbuch öffnen')}
          </Button>
          <Button size="sm" onClick={() => openHelp('anmelden-und-oberfläche')}>
            {t('Die Oberfläche')}
          </Button>
          <Button size="sm" onClick={() => openHelp('bearbeiten')}>
            {t('Bearbeiten')}
          </Button>
          <Button size="sm" onClick={() => openHelp('markdown-spickzettel')}>
            {t('Markdown-Spickzettel')}
          </Button>
          <Button size="sm" onClick={() => openHelp('menüs-im-überblick')}>
            {t('Menüs im Überblick')}
          </Button>
          <Button size="sm" onClick={() => openHelp('tastenkürzel')}>
            {t('Tastenkürzel')}
          </Button>
          <Button size="sm" onClick={() => openHelp('ki-assistent')}>
            {t('KI-Assistent')}
          </Button>
          {isAdmin && (
            <Button size="sm" onClick={() => openHelp('quellen-einbinden')}>
              {t('Quellen einbinden')}
            </Button>
          )}
          <Button size="sm" onClick={() => openHelp('fehlerbehebung')}>
            {t('Fehlerbehebung')}
          </Button>
          <Button size="sm" onClick={() => openHelp('technik-und-komponenten')}>
            {t('Technik und Komponenten')}
          </Button>
        </div>
      </section>
      <section className="space-y-2" aria-label={t('Willkommensseite')}>
        <h3 className="font-medium">{t('Willkommensseite')}</h3>
        <p className="text-fg-muted">
          {welcomeHidden
            ? t('Ausgeblendet. Sie zeigt erste Schritte und was Kaveyl Wiki kann, solange keine Notiz offen ist.')
            : t('Wird angezeigt, solange keine Notiz offen ist – mit ersten Schritten und dem, was Kaveyl Wiki kann.')}
        </p>
        {welcomeHidden && (
          <Button size="sm" onClick={() => usePrefs.getState().set({ hideWelcome: false })}>
            {t('Willkommensseite wieder anzeigen')}
          </Button>
        )}
      </section>
    </div>
  );
}
