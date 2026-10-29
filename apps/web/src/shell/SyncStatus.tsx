// Sync indicator in the sidebar header plus an overview per source: synced / syncing /
// pending commits / unpushed commits / uncommitted local changes / errors and conflicts.
import { useState, useSyncExternalStore } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, AlertTriangle, AlertOctagon, GitBranch, FolderGit2, HardDrive, CircleDot, CloudOff } from 'lucide-react';
import { api, type MountStatus } from '../api';
import { fmtAgo, t, tn } from '../i18n';
import { Button, PopoverContent, Spinner, cx } from '../ui';
import { useActions } from './actions';
import { connectionLost, useConnection } from '../connection';

type Level = 'ok' | 'busy' | 'info' | 'warn' | 'error';

const relTime = (iso: string | null): string => (iso ? fmtAgo(iso) : t('noch nie'));

/** Human-readable state of one source: level + lines. */
export function describe(m: MountStatus): { level: Level; lines: string[] } {
  const lines: string[] = [];
  let level: Level = 'ok';
  const raise = (l: Level) => {
    const order: Level[] = ['ok', 'info', 'busy', 'warn', 'error'];
    if (order.indexOf(l) > order.indexOf(level)) level = l;
  };
  if (m.syncStatus === 'error') {
    raise('error');
    lines.push(t('Fehler: {detail}', { detail: m.syncDetail ?? t('unbekannt') }));
  }
  if (m.syncStatus === 'conflict') {
    raise('warn');
    let files = '';
    try {
      files = (JSON.parse(m.syncDetail ?? '{}') as { files?: string[] }).files?.join(', ') ?? '';
    } catch {
      /* detail is not JSON */
    }
    lines.push(
      files
        ? t('Konflikt mit Änderungen auf dem Server ({files}). Deine Version ist gesichert, Push pausiert.', { files })
        : t('Konflikt mit Änderungen auf dem Server. Deine Version ist gesichert, Push pausiert.'),
    );
  }
  if (m.syncStatus === 'syncing') {
    raise('busy');
    lines.push(t('Synchronisiert …'));
  }
  if (m.linkRepairs > 0) {
    raise('warn');
    lines.push(tn(m.linkRepairs, 'Umbenennung außerhalb erkannt: {n} Link zeigt ins Leere', 'Umbenennung außerhalb erkannt: {n} Links zeigen ins Leere'));
  }
  if (m.pending > 0) {
    // Saved already — only the commit/push is still to come. Not "busy": nothing runs yet.
    raise('info');
    const idle = m.commitIdleSec >= 60 ? t('{n} Min.', { n: Math.round(m.commitIdleSec / 60) }) : t('{n} s', { n: m.commitIdleSec });
    lines.push(
      tn(
        m.pending,
        '{n} Änderung gespeichert, Übertragung beim Verlassen der Notiz oder nach {idle} Pause',
        '{n} Änderungen gespeichert, Übertragung beim Verlassen der Notiz oder nach {idle} Pause',
        { idle },
      ),
    );
  }
  if (m.type === 'remote') {
    if (m.git?.ahead) {
      raise('info');
      lines.push(tn(m.git.ahead, '{n} Commit noch nicht gepusht', '{n} Commits noch nicht gepusht'));
    }
    if (m.git?.behind) {
      raise('info');
      lines.push(tn(m.git.behind, '{n} neuer Commit auf dem Server', '{n} neue Commits auf dem Server'));
    }
    if (level === 'ok') lines.push(t('Synchron · {when}', { when: relTime(m.syncedAt) }));
  } else {
    if (!m.git) lines.push(t('Ordner ohne Git – Änderungen werden direkt gespeichert, es gibt nichts zu synchronisieren'));
    else {
      // A working copy of its own (e.g. a project edited in VS Code): Kaveyl Wiki leaves committing to its owner.
      if (!m.autoCommit) lines.push(t('Ordner mit eigenem Git-Repository – Kaveyl Wiki committet hier nicht selbst'));
      if (m.git.uncommitted) {
        raise('info');
        lines.push(
          m.autoCommit
            ? tn(m.git.uncommitted, '{n} Datei geändert, nicht committet', '{n} Dateien geändert, nicht committet')
            : tn(
                m.git.uncommitted,
                '{n} Datei geändert, nicht committet (z. B. in VS Code oder per git committen)',
                '{n} Dateien geändert, nicht committet (z. B. in VS Code oder per git committen)',
              ),
        );
      }
      if (m.git.ahead) {
        raise('info');
        lines.push(tn(m.git.ahead, '{n} lokaler Commit nicht gepusht', '{n} lokale Commits nicht gepusht'));
      }
      if (level === 'ok') lines.push(m.git.branch ? t('Alles committet · {branch}', { branch: m.git.branch }) : t('Alles committet'));
    }
  }
  return { level, lines };
}

function LevelIcon({ level, className }: { level: Level; className?: string }) {
  const c = cx('h-4 w-4 shrink-0', className);
  if (level === 'error') return <AlertOctagon className={cx(c, 'text-danger')} />;
  if (level === 'warn') return <AlertTriangle className={cx(c, 'text-warn')} />;
  if (level === 'busy') return <RefreshCw className={cx(c, 'animate-spin text-accent')} />;
  if (level === 'info') return <CircleDot className={cx(c, 'text-accent')} />;
  return <CheckCircle2 className={cx(c, 'text-ok')} />;
}

/** The overall symbol: no connection to the server comes before any state of the sources (those are the last known). */
function OverallIcon({ level, lost }: { level: Level; lost: boolean }) {
  return lost ? <CloudOff className="h-4 w-4 shrink-0 text-warn" /> : <LevelIcon level={level} />;
}

/** The browser's network state, as React Query sees it (it pauses queries while offline). */
const subscribeOnline = (cb: () => void) => onlineManager.subscribe(cb);
const isOnline = () => onlineManager.isOnline();

export function SyncStatus({ isAdmin = false }: { isAdmin?: boolean }) {
  const [open, setOpen] = useState(false);
  const openAction = useActions((s) => s.open);
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: open ? 5_000 : 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const live = useConnection((s) => s.live);
  const online = useSyncExternalStore(subscribeOnline, isOnline);
  const lost = connectionLost({ live, statusError: status.isError ? status.error : null, online });
  const all = (status.data ?? []).map((m) => ({ m, ...describe(m) }));
  // Plain local folders have nothing to sync: listed only when something needs attention, otherwise in one line below.
  const quiet = all.filter((i) => i.m.type === 'local' && !i.m.git && i.level === 'ok');
  const items = all.filter((i) => !quiet.includes(i));
  const order: Level[] = ['ok', 'info', 'busy', 'warn', 'error'];
  const overall = items.reduce<Level>((acc, i) => (order.indexOf(i.level) > order.indexOf(acc) ? i.level : acc), 'ok');
  const problems = items.filter((i) => i.level === 'error' || i.level === 'warn').length;
  const label = lost
    ? t('Keine Verbindung zum Server')
    : overall === 'error' || overall === 'warn'
      ? tn(problems, '{n} Quelle braucht Aufmerksamkeit', '{n} Quellen brauchen Aufmerksamkeit')
      : overall === 'busy'
        ? t('Synchronisiert …')
        : t('Alle Quellen synchron');

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    await fn().catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['status'] });
    await qc.invalidateQueries({ queryKey: ['mounts'] });
    setBusy(null);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <span role="status" className="sr-only">
        {lost ? label : ''}
      </span>
      <Popover.Trigger asChild>
        <button className="flex h-6 items-center gap-1 rounded px-1 text-fg-muted hover:bg-active hover:text-fg" aria-label={t('Sync-Status: {label}', { label })} title={label}>
          <OverallIcon level={overall} lost={lost} />
          {/* a count in the button's name, not a message */ !lost && problems > 0 && <span className="text-xs font-semibold text-danger">{problems}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverContent align="start" sideOffset={6} className="z-50 w-[min(420px,calc(100vw-24px))]">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <OverallIcon level={overall} lost={lost} />
            <span className="flex-1 text-sm font-medium">{label}</span>
            {all.some((i) => i.m.type === 'remote') && (
              <Button size="sm" disabled={!!busy} onClick={() => void run('all', api.syncAll)}>
                {busy === 'all' ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />} {t('Alle synchronisieren')}
              </Button>
            )}
          </div>
          {lost && (
            <div className="border-b border-line px-3 py-2 text-xs text-fg-muted">
              {t('Kaveyl Wiki verbindet sich von selbst neu. Ungespeicherte Änderungen werden gespeichert, sobald der Server wieder erreichbar ist; unten steht der letzte bekannte Stand.')}
            </div>
          )}
          <div className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {items.map(({ m, level, lines }) => (
              <div key={m.id} className="flex gap-2.5 px-3 py-2.5">
                <LevelIcon level={level} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {/* Same symbols as the automatic source icons in the tree. */}
                    {m.type === 'remote' ? (
                      <GitBranch className="h-3.5 w-3.5 text-fg-faint" />
                    ) : m.git ? (
                      <FolderGit2 className="h-3.5 w-3.5 text-fg-faint" />
                    ) : (
                      <HardDrive className="h-3.5 w-3.5 text-fg-faint" />
                    )}
                    <span className="truncate">{m.name}</span>
                  </div>
                  {lines.map((l, i) => (
                    <div key={i} className={cx('break-words text-xs', level === 'error' && i === 0 ? 'text-danger' : 'text-fg-muted')}>
                      {l}
                    </div>
                  ))}
                  {m.syncStatus === 'conflict' && (
                    <Button size="sm" variant="primary" className="mr-1.5 mt-1.5" onClick={() => (setOpen(false), openAction({ kind: 'conflict', mountId: m.id }))}>
                      {t('Konflikt lösen')}
                    </Button>
                  )}
                  <button
                    className="mt-0.5 block text-xs text-fg-faint underline-offset-2 hover:text-fg hover:underline"
                    onClick={() => (setOpen(false), openAction({ kind: 'activity', mountId: m.id, isAdmin }))}
                    aria-label={t('Verlauf von {name}', { name: m.name })}
                  >
                    {t('Verlauf')}
                  </button>
                  {m.linkRepairs > 0 && (
                    <Button size="sm" className="mt-1.5" disabled={!!busy} onClick={() => void run(`links-${m.id}`, () => api.repairLinks(m.id))}>
                      {busy === `links-${m.id}` && <Spinner className="h-3.5 w-3.5" />} {t('Links reparieren')}
                    </Button>
                  )}
                </div>
                {m.type === 'remote' && m.canSync && (
                  <button
                    className="h-7 w-7 shrink-0 rounded text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                    disabled={!!busy}
                    title={t('Jetzt synchronisieren')}
                    aria-label={t('{name} jetzt synchronisieren', { name: m.name })}
                    onClick={() => void run(m.id, () => api.syncMount(m.id))}
                  >
                    {busy === m.id ? <Spinner className="mx-auto h-3.5 w-3.5" /> : <RefreshCw className="mx-auto h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            ))}
            {status.data?.length === 0 && <div className="p-3 text-sm text-fg-muted">{t('Keine Quellen eingebunden.')}</div>}
          </div>
          {quiet.length > 0 && (
            <div className="flex gap-2.5 border-t border-line px-3 py-2 text-xs text-fg-muted">
              <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint" />
              <div>
                {t('Lokale Ordner ohne Git – nichts zu synchronisieren:')}{' '}
                {quiet.map(({ m }, i) => (
                  <span key={m.id}>
                    {i > 0 && ' · '}
                    <button
                      className="underline-offset-2 hover:text-fg hover:underline"
                      title={t('Verlauf')}
                      aria-label={t('Verlauf von {name}', { name: m.name })}
                      onClick={() => (setOpen(false), openAction({ kind: 'activity', mountId: m.id, isAdmin }))}
                    >
                      {m.name}
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="border-t border-line px-3 py-1.5 text-[0.6875rem] text-fg-faint">
            {t('Repositories: automatischer Commit nach kurzer Pause, Abgleich alle 5 Min. oder sofort per Webhook.')}
          </div>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  );
}
