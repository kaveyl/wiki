// Löschregeln (AD-034): Einstellungen → Werkzeuge → Aufräumen shows everything that grows, what it holds
// now and the rule for it; the same rules also sit next to what they concern (Protokoll,
// Papierkorb, KI, Quellen) through <RuleRow>. One server endpoint for all of them.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Eraser, Save } from 'lucide-react';
import { api, errorText, type CleanupOverview, type RuleKey } from '../api';
import { toast } from '../toast';
import { Button, Input, Spinner, cx, useModalDirty, fillNodes, FormError } from '../ui';
import { fmtBytes, fmtDate, t, tn } from '../i18n';

const day = (iso: string) => fmtDate(iso, { dateStyle: 'medium' });

export const useCleanup = () => useQuery({ queryKey: ['cleanup'], queryFn: api.cleanup });

/** Everything that shows a rule or what it removed. */
export async function refreshAfterRules(qc: QueryClient) {
  for (const key of ['cleanup', 'trash', 'ai-providers', 'repo-trash', 'backups', 'activity', 'mounts']) await qc.invalidateQueries({ queryKey: [key] });
}

/**
 * One rule as „label · [number] Tage · Speichern“. 0 means „nie“ where the rule allows it
 * (shown next to the field). Saves only this rule.
 */
export function RuleRow({ rule, label, hint }: { rule: RuleKey; label: string; hint?: string }) {
  const qc = useQueryClient();
  const data = useCleanup().data;
  const current = data?.rules[rule];
  const limit = data?.limits[rule];
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(null), [current]);
  const shown = value ?? (current === undefined ? '' : String(current));
  const dirty = value !== null && value !== String(current);
  useModalDirty(dirty);
  const save = async () => {
    const n = Number(value);
    if (!limit || !Number.isFinite(n) || n < limit.min || n > limit.max) {
      setError(
        limit?.min === 0 ? t('Erlaubt: 0 (nie) bis {max}', { max: limit.max }) : t('Erlaubt: {min} bis {max}', { min: limit?.min ?? 0, max: limit?.max ?? '' }),
      );
      return;
    }
    setBusy(true);
    try {
      await api.saveCleanup({ [rule]: n });
      setError(null);
      setValue(null);
      await refreshAfterRules(qc);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const unit = limit?.unit === 'count' ? t('Stück') : t('Tage');
  const id = `rule-${rule}`;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 basis-48 text-sm">
          {label}
        </label>
        <span className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={limit?.min}
            max={limit?.max}
            className="w-24"
            value={shown}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && dirty && void save()}
          />
          <span className="w-10 text-xs text-fg-muted">{unit}</span>
          <Button size="sm" disabled={!dirty || busy} onClick={() => void save()} aria-label={t('{label} speichern', { label })}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {t('Speichern')}
          </Button>
        </span>
      </div>
      {(() => {
        // For a count 0 means „keine“ (no weekly copies), for days „nie löschen“.
        const zero = limit?.min === 0 ? (limit.unit === 'count' ? t('0 = keine.') : t('0 = nie automatisch löschen.')) : '';
        const def = limit && current !== undefined && current !== limit.def ? t('Standard: {n}.', { n: limit.def }) : '';
        const text = [hint, zero, def].filter(Boolean).join(' ');
        return text ? <p className="text-xs text-fg-faint">{text}</p> : null;
      })()}
      <FormError small>{error}</FormError>
    </div>
  );
}

function Section({ title, now, children }: { title: string; now?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-line p-3" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{title}</h3>
        {now && <span className="text-xs text-fg-muted">{now}</span>}
      </div>
      {children}
    </section>
  );
}

const DONE_LABELS: Record<string, (n: number) => string> = {
  log: (n) => tn(n, '{n} Protokolleintrag', '{n} Protokolleinträge'),
  trash: (n) => tn(n, '{n} Papierkorb-Eintrag', '{n} Papierkorb-Einträge'),
  aiChats: (n) => tn(n, '{n} KI-Chat', '{n} KI-Chats'),
  repos: (n) => tn(n, '{n} Repository', '{n} Repositories'),
  clones: (n) => tn(n, '{n} verwaiste Kopie', '{n} verwaiste Kopien'),
  bundles: (n) => tn(n, '{n} Repository-Sicherung', '{n} Repository-Sicherungen'),
  manualBackups: (n) => tn(n, '{n} manuelle Sicherung', '{n} manuelle Sicherungen'),
  temp: (n) => tn(n, '{n} temporärer Ordner', '{n} temporäre Ordner'),
};

export type CleanupLink = 'log' | 'backups' | 'ai' | 'mounts';

/** Settings → Werkzeuge → Aufräumen (admins). */
export function CleanupPanel({ onOpenTab }: { onOpenTab?: (page: CleanupLink) => void }) {
  const qc = useQueryClient();
  const q = useCleanup();
  const [running, setRunning] = useState(false);
  const data: CleanupOverview | undefined = q.data;
  const run = async () => {
    setRunning(true);
    try {
      const res = await api.runCleanup();
      const parts = Object.entries(res.done)
        .filter(([k, n]) => n > 0 && DONE_LABELS[k])
        .map(([k, n]) => DONE_LABELS[k]!(n));
      if (res.done.compacted) parts.push(t('Datenbank um {size} verkleinert', { size: fmtBytes(res.done.compacted) }));
      toast({
        kind: res.failed.length ? 'error' : 'ok',
        title: res.failed.length ? t('Aufräumen teilweise fehlgeschlagen') : t('Aufgeräumt'),
        text: [
          parts.length ? t('Gelöscht: {list}', { list: parts.join(', ') }) : t('Nichts war fällig.'),
          res.failed.length ? t('Fehler bei: {list} – siehe Protokoll', { list: res.failed.join(', ') }) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      await refreshAfterRules(qc);
    } catch (e) {
      toast({ kind: 'error', title: t('Aufräumen fehlgeschlagen'), text: errorText(e) });
    } finally {
      setRunning(false);
    }
  };
  if (q.isPending) return <Spinner />;
  if (!data) return <FormError>{t('Übersicht konnte nicht geladen werden.')}</FormError>;
  const u = data.usage;
  const folderTrash = u.trash.filter((m) => m.mode === 'folder');
  const trashSize = folderTrash.reduce((a, m) => a + m.size, 0);
  const trashEntries = folderTrash.reduce((a, m) => a + m.entries, 0);
  const orphanSize = u.clones.orphans.reduce((a, o) => a + o.size, 0);
  const backupSize = u.backups.daily.size + u.backups.weekly.size + u.backups.manual.size;
  const link = (tab: CleanupLink, text: string) =>
    onOpenTab ? (
      <button className="text-accent hover:underline" onClick={() => onOpenTab(tab)}>
        {text}
      </button>
    ) : (
      text
    );
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {t(
          'Kaveyl Wiki läuft im Container und legt neben deinen Notizen eigene Daten ab: Protokoll, Papierkorb, KI-Chats, Sicherungen, lokale Kopien der Repositories. Damit nichts unbegrenzt wächst, gilt für jede Art eine Löschregel. Aufgeräumt wird jede Nacht um 3 Uhr – oder hier auf Knopfdruck. Deine Notizen und die Git-Historie löscht keine dieser Regeln.',
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={running} onClick={() => void run()}>
          {running ? <Spinner className="h-3.5 w-3.5" /> : <Eraser className="h-3.5 w-3.5" />} {t('Jetzt aufräumen')}
        </Button>
        <span className="text-xs text-fg-faint">{t('Wendet alle Regeln sofort an (ohne Sicherung und Prüfung, die laufen nachts).')}</span>
      </div>

      <Section
        title={t('Protokoll')}
        now={
          u.log.oldest
            ? tn(u.log.count, '{n} Eintrag seit {date}', '{n} Einträge seit {date}', { date: day(u.log.oldest) })
            : tn(u.log.count, '{n} Eintrag', '{n} Einträge')
        }
      >
        <RuleRow rule="logInfoDays" label={t('Normale Einträge aufbewahren')} />
        <RuleRow rule="logProblemDays" label={t('Warnungen und Fehler aufbewahren')} />
        <RuleRow rule="logAuditDays" label={t('Sicherheitseinträge aufbewahren')} hint={t('Anmeldungen, Rechte, Löschungen – für Nachweise eher lang.')} />
        <p className="text-xs text-fg-faint">{fillNodes(t('Auch unter {link}.'), { link: link('log', t('Werkzeuge → Protokoll')) })}</p>
      </Section>

      <Section
        title={t('Papierkorb der Notizen')}
        now={
          folderTrash.length
            ? tn(trashEntries, '{n} Eintrag · {size} in .kaveyl-wiki/trash', '{n} Einträge · {size} in .kaveyl-wiki/trash', { size: fmtBytes(trashSize) })
            : t('Nur Git-Quellen: der Papierkorb ist die Git-Historie')
        }
      >
        <p className="text-xs text-fg-muted">
          {fillNodes(
            t(
              'Gelöschte Notizen und Ordner landen im Papierkorb ihrer Quelle (Symbol unten in der Seitenleiste oder Rechtsklick auf die Quelle). Quellen ohne Auto-Commit bewahren sie im versteckten Ordner {ordner} auf; bei Git-Quellen mit Auto-Commit ist die Git-Historie der Papierkorb. Liegt am alten Platz inzwischen eine andere Datei, lässt sich ein Eintrag mit „Speichern als“ unter anderem Namen, in einem anderen Ordner oder einer anderen Quelle wiederherstellen.',
            ),
            { ordner: <code>.kaveyl-wiki/trash</code> },
          )}
        </p>
        <RuleRow
          rule="trashDays"
          label={t('Gelöschte Notizen aufbewahren')}
          hint={t('Ordner ohne Auto-Commit: danach endgültig gelöscht. Git-Quellen: nur ausgeblendet, die Historie bleibt.')}
        />
      </Section>

      <Section
        title={t('KI-Chats')}
        now={`${tn(u.aiChats.count, '{n} Chat', '{n} Chats')} · ${tn(u.aiChats.messages, '{n} Nachricht', '{n} Nachrichten')}`}
      >
        <RuleRow
          rule="aiChatDays"
          label={t('Unbenutzte Chats aufbewahren')}
          hint={t('Gezählt ab der letzten Nachricht. Je Quelle abweichend: Quelle bearbeiten → „KI-Chats aufbewahren“.')}
        />
        {u.trash.some((m) => m.aiChatDays >= 0) && (
          <ul className="text-xs text-fg-muted">
            {u.trash
              .filter((m) => m.aiChatDays >= 0)
              .map((m) => (
                <li key={m.mountId}>
                  {m.name}: {m.aiChatDays ? tn(m.aiChatDays, '{n} Tag', '{n} Tage') : t('nie löschen')}
                </li>
              ))}
          </ul>
        )}
        <p className="text-xs text-fg-faint">{fillNodes(t('Auch unter {link}.'), { link: link('ai', t('Einstellungen → KI')) })}</p>
      </Section>

      <Section
        title={t('Datenbank-Sicherungen')}
        now={`${tn(u.backups.daily.count + u.backups.weekly.count + u.backups.manual.count, '{n} Datei', '{n} Dateien')} · ${fmtBytes(backupSize)}`}
      >
        <RuleRow rule="backupDaily" label={t('Tägliche Sicherungen behalten')} />
        <RuleRow rule="backupWeekly" label={t('Wöchentliche Sicherungen behalten (sonntags)')} />
        <RuleRow
          rule="backupManualDays"
          label={t('Andere Sicherungen aufbewahren')}
          hint={
            u.backups.manual.count
              ? t('Von Hand abgelegte .db-Dateien in /config/backups (z. B. vor einem Update) – derzeit {n}, {size}.', {
                  n: u.backups.manual.count,
                  size: fmtBytes(u.backups.manual.size),
                })
              : t('Von Hand abgelegte .db-Dateien in /config/backups (z. B. vor einem Update).')
          }
        />
        <p className="text-xs text-fg-faint">
          {fillNodes(t('Liste, „Jetzt sichern“ und was in der Datenbank steht: {link}.'), { link: link('backups', t('Backup → Datenbank')) })}
        </p>
      </Section>

      <Section title={t('Backup-Verlauf')} now={tn(u.backupRuns.count, '{n} Lauf', '{n} Läufe')}>
        <RuleRow
          rule="backupRunDays"
          label={t('Sicherungsläufe in der Liste behalten')}
          hint={t('Nur die Liste der Läufe (Backup → Sicherungen). Wie lange die Sicherungen selbst am Ziel bleiben, legt ihr Zeitplan fest.')}
        />
      </Section>

      <Section
        title={t('Gelöschte Repositories')}
        now={`${t('{n} im Papierkorb', { n: u.repoTrash.count })} · ${tn(u.bundles.count, '{n} Sicherung', '{n} Sicherungen')} (${fmtBytes(u.bundles.size)})`}
      >
        <RuleRow
          rule="repoTrashDays"
          label={t('Im Repository-Papierkorb lassen')}
          hint={t('Archiviert beim Anbieter, danach endgültig gelöscht (vorher eine Git-Sicherung). Gilt auch für Einträge, die schon dort liegen.')}
        />
        <RuleRow
          rule="repoBundleDays"
          label={t('Git-Sicherungen (Bundles) aufbewahren')}
          hint={t('In /config/backups/repos – von gelöschten Repositories und aufgeräumten lokalen Kopien.')}
        />
        <p className="text-xs text-fg-faint">{fillNodes(t('Auch unter {link}.'), { link: link('mounts', t('Quellen → Eingebundene Quellen')) })}</p>
      </Section>

      <Section
        title={t('Lokale Kopien der Repositories')}
        now={
          u.clones.orphans.length
            ? t('{size} in /data/repos · {used} in Gebrauch · {n} verwaist ({orphanSize})', {
                size: fmtBytes(u.clones.size),
                used: u.clones.used,
                n: u.clones.orphans.length,
                orphanSize: fmtBytes(orphanSize),
              })
            : t('{size} in /data/repos · {used} in Gebrauch', { size: fmtBytes(u.clones.size), used: u.clones.used })
        }
      >
        <RuleRow
          rule="orphanCloneDays"
          label={t('Verwaiste Kopien aufbewahren')}
          hint={t(
            'Kopien ausgehängter Quellen und beiseitegelegte „.alt“-Kopien. Gezählt ab dem Tag, an dem Kaveyl Wiki sie verwaist vorfindet; vor dem Löschen entsteht eine Git-Sicherung.',
          )}
        />
        {!!u.clones.orphans.length && (
          <ul className={cx('max-h-32 overflow-y-auto rounded-md border border-line text-xs')} aria-label={t('Verwaiste Kopien')}>
            {u.clones.orphans.map((o) => (
              <li key={o.name} className="flex justify-between gap-2 px-2 py-1">
                <span className="truncate font-mono">{o.name}</span>
                <span className="shrink-0 text-fg-faint">
                  {t('verwaist seit {date}', { date: day(o.since) })} · {fmtBytes(o.size)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t('Feste Regeln')}
        now={
          u.db.free
            ? t('Datenbank {size}, davon {free} frei', { size: fmtBytes(u.db.size), free: fmtBytes(u.db.free) })
            : t('Datenbank {size}', { size: fmtBytes(u.db.size) })
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-xs text-fg-muted">
          <li>{t('Datenbank-Datei: wird nachts verkleinert, sobald mindestens ein Viertel (und 1 MB) frei ist.')}</li>
          <li>
            {t('Anmeldungen ({n} aktiv) enden nach 30 Tagen („Angemeldet bleiben“) bzw. einem Tag; abgelaufene werden sofort entfernt.', {
              n: u.sessions.count,
            })}
          </li>
          <li>{t('Links aus Mails (Passwort vergessen 30 Minuten, Einladung 7 Tage) werden eine Woche nach Ablauf oder Benutzung gelöscht.')}</li>
          <li>{t('Abgelaufene API-Tokens bleiben 30 Tage sichtbar, dann verschwinden sie.')}</li>
          <li>{t('Temporäre Ordner von Kaveyl Wiki, die ein Absturz zurückgelassen hat, werden nach einem Tag gelöscht.')}</li>
          <li>{t('Technisches Container-Log: höchstens 5 × 10 MB (Docker rotiert es, Einstellung in docker-compose.yml).')}</li>
        </ul>
      </Section>
    </div>
  );
}
