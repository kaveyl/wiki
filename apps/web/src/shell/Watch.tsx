// „Beobachten“ (AD-066): follow a note, a folder or a whole source – a dot in the tree until one opens what is new,
// and/or e-mail and Pushover (in the person's rhythm, AD-068). The dialog from the context menu, the dots, „Neu für dich“ in the sidebar and
// the settings page „Beobachten“ (with the person's own Pushover key).
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Eye, EyeOff, Mail, Send } from 'lucide-react';
import { api, errorText, type Mount, type Unread, type WatchOverview, type WatchRhythm } from '../api';
import { fmtDate, t, tn } from '../i18n';
import { Button, Field, FormError, Input, Modal, Spinner, cx, fillNodes } from '../ui';
import { useWorkspace } from '../store';
import { noteNameIn } from '../names';
import { openSettings as openSettingsPage } from './settingsNav';

export function useWatches(enabled = true) {
  return useQuery({ queryKey: ['watches'], queryFn: api.watches, staleTime: 60_000, enabled });
}

const inside = (path: string, isDir: boolean, p: string) => (!path ? true : isDir ? p === path || p.startsWith(path + '/') : p === path);

/** Unread changes at a note, below a folder or in a whole source (path ''). */
export function unreadIn(data: WatchOverview | undefined, mountId: string, path: string, isDir: boolean): Unread[] {
  return (data?.unread ?? []).filter((u) => u.mountId === mountId && inside(path, isDir, u.path));
}

export function watchOf(data: WatchOverview | undefined, mountId: string, path: string) {
  return data?.watches.find((w) => w.mountId === mountId && w.path === path) ?? null;
}

const kind = (k: Unread['kind']) => (k === 'created' ? t('neu angelegt') : k === 'deleted' ? t('gelöscht') : k === 'moved' ? t('verschoben') : t('geändert'));

/** „geändert von Maria Chen“ for one, „3 neue Änderungen“ for more. */
export function unreadLabel(list: Unread[]): string {
  if (list.length === 1) {
    const u = list[0]!;
    return u.by ? t('Neu: {what} von {by}', { what: kind(u.kind), by: u.by }) : t('Neu: {what} von außen', { what: kind(u.kind) });
  }
  return tn(list.length, '{n} neue Änderung', '{n} neue Änderungen');
}

/** The dot next to a note, folder or source with something new; the eye for what is followed without news. */
export function WatchMark({ unread, watched }: { unread: Unread[]; watched: boolean }) {
  if (unread.length) {
    const label = unreadLabel(unread);
    // One change: a small dot; more: a small label with the number.
    return unread.length === 1 ? (
      <span role="img" aria-label={label} title={label} className="mx-1 h-2 w-2 shrink-0 rounded-full bg-accent" data-unread={1} />
    ) : (
      <span role="img" aria-label={label} title={label} className="mx-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] font-semibold leading-none text-accent-fg" data-unread={unread.length}>
        {unread.length > 99 ? '99+' : unread.length}
      </span>
    );
  }
  if (!watched) return null;
  return <Eye role="img" aria-label={t('Beobachtet')} className="mx-0.5 h-3 w-3 shrink-0 text-fg-faint" />;
}

/** An open note is read: its dot goes. */
export function useMarkRead(mountId: string, path: string, active: boolean) {
  const qc = useQueryClient();
  const data = useWatches().data;
  const has = !!data?.unread.some((u) => u.mountId === mountId && u.path === path);
  useEffect(() => {
    if (!active || !has) return;
    qc.setQueryData<WatchOverview>(['watches'], (d) => (d ? { ...d, unread: d.unread.filter((u) => !(u.mountId === mountId && u.path === path)) } : d));
    void api.markRead(mountId, path).catch(() => qc.invalidateQueries({ queryKey: ['watches'] }));
  }, [active, has, mountId, path, qc]);
}

/** „Beobachten …“ from the context menu of a note, folder or source. */
/** How often messages come (Einstellungen → Konto → Beobachten): name and what it means. */
export const RHYTHM_TEXT: Record<WatchRhythm, (dailyAt: string) => [string, string]> = {
  bundled: () => [t('Gebündelt'), t('Was innerhalb von 2 Minuten zusammenkommt, steht in einer Nachricht – höchstens 20 in der Stunde.')],
  hourly: () => [t('Höchstens einmal pro Stunde'), t('Eine Nachricht mit allem, was in der Stunde dazukam.')],
  daily: (time) => [t('Einmal am Tag'), t('Um {time} Uhr eine Zusammenfassung von allem, was seit der letzten dazukam.', { time })],
};

export function WatchDialog({ mountId, path, isDir, title, onClose }: { mountId: string; path: string; isDir: boolean; title: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useWatches();
  const current = watchOf(q.data, mountId, path);
  const [badge, setBadge] = useState(current?.badge ?? true);
  const [mail, setMail] = useState(current?.mail ?? false);
  const [push, setPush] = useState(current?.pushover ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!current) return;
    setBadge(current.badge);
    setMail(current.mail);
    setPush(current.pushover);
    // Only when it arrives, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!current]);
  const ch = q.data?.channels;
  const save = async (next: { badge: boolean; mail: boolean; pushover: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['watches'], await api.setWatch({ mountId, path, isDir, ...next }));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({ badge, mail, pushover: push });
  };
  const what = !path ? t('alles in dieser Quelle') : isDir ? t('alles in diesem Ordner') : t('diese Notiz');
  const openSettings = () => {
    onClose();
    openSettingsPage('watching');
  };
  return (
    <Modal help="beobachten" open onOpenChange={(o) => !o && onClose()} title={t('„{title}“ beobachten', { title })}>
      {!q.data ? (
        q.isError ? <FormError>{errorText(q.error)}</FormError> : <Spinner />
      ) : (
        <form className="space-y-3 text-sm" onSubmit={submit}>
          <p className="text-fg-muted">{t('Du erfährst, wenn andere {what} ändern – deine eigenen Änderungen zählen nicht.', { what })}</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={badge} onChange={(e) => setBadge(e.target.checked)} />
            <span>
              <span className="font-medium">{t('Punkt in der Seitenleiste')}</span>
              <span className="block text-xs text-fg-muted">{t('Bis du die Notiz öffnest; Neues steht auch unter „Neu für dich“.')}</span>
            </span>
          </label>
          <label className={cx('flex items-start gap-2', !ch?.mail && 'opacity-60')}>
            <input type="checkbox" className="mt-0.5" checked={mail && !!ch?.mail} disabled={!ch?.mail} onChange={(e) => setMail(e.target.checked)} />
            <span>
              <span className="font-medium">{t('E-Mail')}</span>
              <span className="block text-xs text-fg-muted">
                {ch?.mail ? (
                  <>
                    {RHYTHM_TEXT[q.data.rhythm](q.data.dailyAt).join(': ')}{' '}
                    <button type="button" className="text-accent hover:underline" onClick={openSettings}>
                      {t('Wie oft? ändern')}
                    </button>
                  </>
                ) : (
                  t('Nicht verfügbar: Der E-Mail-Versand ist nicht eingerichtet oder dein Konto hat keine Adresse.')
                )}
              </span>
            </span>
          </label>
          <label className={cx('flex items-start gap-2', !(ch?.pushover.available && ch.pushover.userKeySet) && 'opacity-60')}>
            <input type="checkbox" className="mt-0.5" checked={push && !!ch?.pushover.userKeySet} disabled={!(ch?.pushover.available && ch.pushover.userKeySet)} onChange={(e) => setPush(e.target.checked)} />
            <span>
              <span className="font-medium">{t('Pushover')}</span>
              <span className="block text-xs text-fg-muted">
                {!ch?.pushover.available ? (
                  t('Nicht verfügbar: Ein Admin muss Pushover zuerst einrichten.')
                ) : ch.pushover.userKeySet ? (
                  t('Push aufs Handy, gebündelt wie die E-Mail.')
                ) : (
                  <>
                    {t('Zuerst deinen Pushover-User-Key eintragen:')}{' '}
                    <button type="button" className="text-accent hover:underline" onClick={openSettings}>
                      {t('Einstellungen → Konto → Beobachten')}
                    </button>
                  </>
                )}
              </span>
            </span>
          </label>
          {error && <FormError>{error}</FormError>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" disabled={busy || (!badge && !mail && !push)}>
              {busy && <Spinner />} {current ? t('Speichern') : t('Beobachten')}
            </Button>
            {current && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void save({ badge: false, mail: false, pushover: false })}>
                <EyeOff className="h-4 w-4" /> {t('Nicht mehr beobachten')}
              </Button>
            )}
            <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
              {t('Abbrechen')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

const ago = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return t('gerade eben');
  if (min < 60) return tn(min, 'vor {n} Minute', 'vor {n} Minuten');
  const h = Math.round(min / 60);
  if (h < 24) return tn(h, 'vor {n} Stunde', 'vor {n} Stunden');
  return fmtDate(iso);
};

/** „Neu für dich“ in the sidebar: what changed in what one follows, newest first; opening reads it. */
export function NewForYou({ mounts }: { mounts: Mount[] }) {
  const qc = useQueryClient();
  const data = useWatches().data;
  const openNote = useWorkspace((w) => w.openNote);
  const list = (data?.unread ?? []).filter((u) => u.kind !== 'deleted' && mounts.some((m) => m.id === u.mountId));
  if (!list.length) return null;
  const readAll = async () => {
    const mountIds = [...new Set(list.map((u) => u.mountId))];
    qc.setQueryData<WatchOverview>(['watches'], (d) => (d ? { ...d, unread: [] } : d));
    await Promise.all(mountIds.map((id) => api.markRead(id, '').catch(() => undefined)));
    void qc.invalidateQueries({ queryKey: ['watches'] });
  };
  return (
    <div className="space-y-0.5" aria-label={t('Neu für dich')}>
      {list.slice(0, 12).map((u) => {
        const name = noteNameIn(u.mountId, u.path);
        const where = mounts.find((m) => m.id === u.mountId)?.name ?? '';
        return (
          <button
            key={`${u.mountId}:${u.path}`}
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-tree hover:bg-hover"
            title={`${where}: ${u.path}`}
            onClick={() => (/\.md$/i.test(u.path) ? openNote(u.mountId, u.path, name) : useWorkspace.getState().revealInTree(u.mountId, u.path))}
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="max-w-[55%] shrink-0 truncate text-xs text-fg-faint">{`${u.by ?? t('von außen')}, ${ago(u.at)}`}</span>
          </button>
        );
      })}
      {list.length > 12 && <p className="px-1 text-xs text-fg-faint">{t('… und {n} weitere', { n: list.length - 12 })}</p>}
      <button className="px-1 text-xs text-accent hover:underline" onClick={() => void readAll()}>
        {t('Alles als gelesen markieren')}
      </button>
    </div>
  );
}

/** Settings → Konto → Beobachten: what one follows, and one's own Pushover key. */
/** The time of the daily summary; saved when the field is left (a time field changes with every digit). */
function DailyAt({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="ml-6 flex items-center gap-2 text-xs text-fg-muted">
      {t('Uhrzeit der Zusammenfassung')}
      <Input
        type="time"
        className="h-7 w-28"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v && v !== value && onSave(v)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
      />
    </label>
  );
}

export function WatchingPanel({ mounts }: { mounts: Mount[] }) {
  const qc = useQueryClient();
  const q = useWatches();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  if (!q.data) return q.isError ? <FormError>{errorText(q.error)}</FormError> : <Spinner />;
  const d = q.data;
  const run = async (kind: string, fn: () => Promise<string | void>) => {
    setBusy(kind);
    setStatus(null);
    try {
      const text = await fn();
      if (text) setStatus({ ok: true, text });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const label = (mountId: string, path: string) => {
    const m = mounts.find((x) => x.id === mountId)?.name ?? '?';
    return path ? `${m}: ${path}` : t('{source} (ganze Quelle)', { source: m });
  };
  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <section className="space-y-2">
        <p className="text-fg-muted">
          {fillNodes(t('Beobachten startest du mit einem Rechtsklick auf eine Notiz, einen Ordner oder eine Quelle → {cmd}.'), { cmd: <b className="text-fg">{t('Beobachten …')}</b> })}
        </p>
        {!d.watches.length ? (
          <p className="text-fg-faint">{t('Du beobachtest noch nichts.')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Beobachtet')}>
            {d.watches.map((w) => (
              <li key={`${w.mountId}:${w.path}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate">{label(w.mountId, w.path)}</span>
                {w.unread > 0 && <span className="rounded-full bg-accent px-1.5 text-xs text-accent-fg">{w.unread}</span>}
                <span className="flex items-center gap-1 text-xs text-fg-muted">
                  {w.badge && <Eye className="h-3.5 w-3.5" aria-label={t('Punkt')} />}
                  {w.mail && <Mail className="h-3.5 w-3.5" aria-label={t('E-Mail')} />}
                  {w.pushover && <BellRing className="h-3.5 w-3.5" aria-label={t('Pushover')} />}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() =>
                    void run(`off:${w.mountId}:${w.path}`, async () => {
                      qc.setQueryData(['watches'], await api.setWatch({ mountId: w.mountId, path: w.path, isDir: w.isDir, badge: false, mail: false, pushover: false }));
                    })
                  }
                >
                  {t('Nicht mehr beobachten')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">{t('Wie oft?')}</h3>
        <p className="text-fg-muted">{t('Gilt für E-Mail und Pushover zu allem, was du beobachtest. Der Punkt in der Seitenleiste kommt immer sofort.')}</p>
        <div className="space-y-1.5" role="radiogroup" aria-label={t('Wie oft?')}>
          {(Object.keys(RHYTHM_TEXT) as WatchRhythm[]).map((r) => (
            <label key={r} className="flex items-start gap-2">
              <input
                type="radio"
                name="watch-rhythm"
                className="mt-0.5"
                checked={d.rhythm === r}
                onChange={() => {
                  // Shown at once; back to the stored choice if saving fails.
                  const before = d.rhythm;
                  const show = (rhythm: WatchRhythm) => qc.setQueryData<WatchOverview>(['watches'], (old) => (old ? { ...old, rhythm } : old));
                  show(r);
                  void run(`rhythm:${r}`, async () => {
                    try {
                      const next = await api.setWatchRhythm({ rhythm: r });
                      qc.setQueryData<WatchOverview>(['watches'], (old) => (old ? { ...old, ...next } : old));
                    } catch (e) {
                      show(before);
                      throw e;
                    }
                  });
                }}
              />
              <span>
                <span className="font-medium">{RHYTHM_TEXT[r](d.dailyAt)[0]}</span>
                <span className="block text-xs text-fg-muted">{RHYTHM_TEXT[r](d.dailyAt)[1]}</span>
              </span>
            </label>
          ))}
        </div>
        {d.rhythm === 'daily' && (
          <DailyAt
            value={d.dailyAt}
            onSave={(dailyAt) =>
              void run('daily-at', async () => {
                const next = await api.setWatchRhythm({ dailyAt });
                qc.setQueryData<WatchOverview>(['watches'], (old) => (old ? { ...old, ...next } : old));
                return t('Gespeichert: täglich um {time} Uhr.', { time: next.dailyAt });
              })
            }
          />
        )}
        <p className="text-xs text-fg-muted">
          {t('Höchstens {n} Nachrichten am Tag (vom Admin festgelegt). Was darüber hinaus dazukommt, geht nicht verloren – es steht in der nächsten Nachricht.', { n: d.perDay })}
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">{t('Pushover für dich')}</h3>
        {!d.channels.pushover.available ? (
          <p className="text-fg-muted">{t('Ein Admin muss Pushover zuerst einrichten (Einstellungen → Benachrichtigungen → Pushover). Danach trägst du hier deinen eigenen User-Key ein.')}</p>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run('save', async () => {
                const p = await api.savePersonalPushover(key);
                setKey('');
                void qc.invalidateQueries({ queryKey: ['watches'] });
                return p.userKeySet ? t('Gespeichert. Jetzt am besten eine Testnachricht senden.') : t('Entfernt.');
              });
            }}
          >
            <Field label={t('Dein Pushover-User-Key')} hint={d.channels.pushover.userKeySet ? t('Gespeichert – leer lassen und speichern, um ihn zu entfernen.') : t('Steht auf pushover.net nach der Anmeldung oben rechts („Your User Key“).')}>
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder={d.channels.pushover.userKeySet ? '••••••••' : t('30 Zeichen')} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" disabled={!!busy || (!key && !d.channels.pushover.userKeySet)}>
                {busy === 'save' && <Spinner />} {key || !d.channels.pushover.userKeySet ? t('Speichern') : t('Entfernen')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!!busy || !d.channels.pushover.userKeySet || !!key}
                onClick={() =>
                  void run('test', async () => {
                    await api.testPersonalPushover();
                    return t('Testnachricht verschickt – sie sollte in ein paar Sekunden auf dem Handy sein.');
                  })
                }
              >
                {busy === 'test' ? <Spinner /> : <Send className="h-3.5 w-3.5" />} {t('Testnachricht senden')}
              </Button>
            </div>
          </form>
        )}
      </section>
      {status && (
        <p className={status.ok ? 'text-ok' : 'text-danger'} role="status">
          {status.text}
        </p>
      )}
    </div>
  );
}
