// Settings → Backup (AD-038): targets (folder below /backup or SMB share, with „Testen“), plans
// (sources, time and the keep table), the archives with restore (overwrite, copy, compare) and
// the run history. Passwords are write-only: the server only says whether one is stored.
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Lock,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Server,
  Trash2,
  XCircle,
} from 'lucide-react';
import { diffLines, mergeBlocks, type DiffBlock } from '@kaveyl-wiki/core';
import {
  api,
  ApiError,
  errorText,
  type BackupArchive,
  type BackupEntry,
  type BackupKeep,
  type BackupPlan,
  type BackupRun,
  type BackupScan,
  type BackupTarget,
  type BackupTargetInput,
  type BackupTargetKind,
  type BackupTestResult,
  type Mount,
} from '../api';
import { Button, Field, Input, MissingHint, Modal, Spinner, confirmDialog, cx, useModalDirty, fillNodes, FormError, useRepeatCheck } from '../ui';
import { toast } from '../toast';
import { copyWithToast } from '../clipboard';
import { useWorkspace } from '../store';
import { noteName, noteNameIn } from '../names';
import { openSettings, useSettingsNav } from './settingsNav';
import { fmtBytes, fmtDate, fmtDateTime, locale, t, tn } from '../i18n';
import { nameWith, SaveAsDialog, splitPath } from './SaveAs';

const when = (iso: string) => fmtDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' });
const day = (iso: string) => fmtDate(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
/** Local year and month („2026-10“), the group of an archive in the list. */
const monthKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (iso: string) => fmtDate(iso, { month: 'long', year: 'numeric' });
/** „nur die letzten …“ in the list of archives. */
const LATEST = 10;

export type BackupPage = 'backup-targets' | 'backup-plans' | 'backup-files' | 'backups';

const useTargets = () => useQuery({ queryKey: ['backup-targets'], queryFn: api.backupTargets });
const usePlans = () => useQuery({ queryKey: ['backup-plans'], queryFn: api.backupPlans });
const useMounts = () => useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
/** Runs; polled while one is going. */
function useRuns() {
  const q = useQuery({ queryKey: ['backup-runs'], queryFn: api.backupRuns, refetchInterval: (query) => (query.state.data?.running || query.state.data?.runs.some((r) => r.status === 'running') ? 1500 : false) });
  const qc = useQueryClient();
  const busy = !!q.data?.running;
  // When a run ends, the list of archives changes – also a run so short that the poll never saw it going.
  const last = q.data?.runs[0];
  const lastSeen = last ? `${last.id}:${last.status}` : '';
  useEffect(() => {
    if (!busy) void qc.invalidateQueries({ queryKey: ['backup-files'] });
  }, [busy, lastSeen, qc]);
  return q;
}

/** The start request (source/path from the tree menu), read once by the page that opens. */
function useStartRequest() {
  const req = useSettingsNav((s) => s.request);
  return req;
}

// ── Ziele ──────────────────────────────────────────────────────────────────────────────
export function BackupTargetsPanel({ onOpenTab }: { onOpenTab: (p: BackupPage) => void }) {
  const qc = useQueryClient();
  const targets = useTargets();
  const status = useQuery({ queryKey: ['backup-status'], queryFn: api.backupStatus });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [checks, setChecks] = useState<Record<string, BackupTestResult | { error: string } | 'busy'>>({});
  const [scans, setScans] = useState<Record<string, BackupScan | { error: string } | 'busy'>>({});
  const [error, setError] = useState<string | null>(null);
  const check = async (tg: BackupTarget) => {
    setChecks((s) => ({ ...s, [tg.id]: 'busy' }));
    const r = await api.testBackupTarget({ id: tg.id, kind: tg.kind, location: tg.location, username: tg.username, domain: tg.domain }).catch((e: unknown) => ({ error: errorText(e) }));
    setChecks((s) => ({ ...s, [tg.id]: r }));
  };
  // „Ziel durchsuchen“ (AD-075): archives lying there into the list – after the target was added again, on a new server.
  const scan = async (tg: BackupTarget) => {
    setScans((s) => ({ ...s, [tg.id]: 'busy' }));
    const r = await api.scanBackupTarget(tg.id).catch((e: unknown) => ({ error: errorText(e) }));
    setScans((s) => ({ ...s, [tg.id]: r }));
    await qc.invalidateQueries({ queryKey: ['backup-files'] });
  };
  const remove = async (tg: BackupTarget) => {
    const text = tg.plans.length
      ? tn(
          tg.plans.length,
          'Ziel „{name}“ entfernen und den Zeitplan {plans}, der es nutzt, mit löschen? Die Sicherungen dort bleiben liegen; „Durchsuchen“ findet sie wieder, wenn du das Ziel neu anlegst.',
          'Ziel „{name}“ entfernen und die Zeitpläne {plans}, die es nutzen, mit löschen? Die Sicherungen dort bleiben liegen; „Durchsuchen“ findet sie wieder, wenn du das Ziel neu anlegst.',
          { name: tg.name, plans: tg.plans.map((p) => `„${p}“`).join(', ') },
        )
      : t('Ziel „{name}“ entfernen? Die Sicherungen dort bleiben liegen; „Durchsuchen“ findet sie wieder, wenn du das Ziel neu anlegst.', { name: tg.name });
    if (!(await confirmDialog(text, { confirmLabel: tg.plans.length ? t('Ziel und Zeitplan löschen') : t('Entfernen'), danger: true }))) return;
    setError(null);
    try {
      await api.removeBackupTarget(tg.id, tg.plans.length > 0);
      await qc.invalidateQueries({ queryKey: ['backup-targets'] });
      await qc.invalidateQueries({ queryKey: ['backup-plans'] });
      await qc.invalidateQueries({ queryKey: ['backup-files'] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="space-y-3 text-sm" aria-label={t('Backup-Ziele')}>
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Wohin gesichert wird: ein Ordner im Backup-Verzeichnis des Containers ({root}) oder eine SMB-Freigabe (Windows, NAS). Jedes Ziel lässt sich vor dem Speichern testen. Was wann gesichert wird, legen die {plans} fest.',
          ),
          { root: <code>{status.data?.root ?? '/backup'}</code>, plans: tabLink(onOpenTab, 'backup-plans', t('Zeitpläne')) },
        )}
      </p>
      {status.data && !status.data.root && (
        <p className="flex gap-1.5 text-xs text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{' '}
          {t('Kein Backup-Verzeichnis eingehängt – lokale Ziele gehen erst, wenn in docker-compose.yml ein Host-Ordner nach /backup eingehängt ist.')}
        </p>
      )}
      {targets.isPending && <Spinner />}
      {targets.data?.length === 0 && editing !== 'new' && <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-fg-muted">{t('Noch kein Ziel.')}</p>}
      {!!targets.data?.length && (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Ziele')}>
          {targets.data.map((tg) => {
            const st = checks[tg.id];
            return (
              <li key={tg.id} className="space-y-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-fg-faint">{tg.kind === 'smb' ? <Server className="h-4 w-4" /> : <HardDrive className="h-4 w-4" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <span className="truncate">{tg.name}</span>
                      {tg.encrypted && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[0.6875rem] font-normal text-fg-muted" title={t('Sicherungen mit Backup-Passwort verschlüsselt')}>
                          <Lock className="h-3 w-3" /> {t('verschlüsselt')}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-fg-muted">
                      {tg.kind === 'smb'
                        ? `SMB · ${tg.location} · ${tg.username ?? ''}`
                        : t('Ordner · {path}', { path: `${status.data?.root ?? '/backup'}${tg.location ? `/${tg.location}` : ''}` })}
                      {' · '}
                      {tg.plans.length ? t('genutzt von {plans}', { plans: tg.plans.join(', ') }) : t('von keinem Zeitplan genutzt')}
                    </span>
                    <TestResult result={st} />
                    <ScanResult result={scans[tg.id]} onOpenTab={onOpenTab} />
                  </span>
                  <Button size="sm" variant="ghost" disabled={st === 'busy'} onClick={() => void check(tg)}>
                    {st === 'busy' && <Spinner className="h-3.5 w-3.5" />} {t('Testen')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={scans[tg.id] === 'busy'} title={t('Sicherungen, die dort schon liegen, in die Liste aufnehmen')} onClick={() => void scan(tg)}>
                    {scans[tg.id] === 'busy' ? <Spinner className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />} {t('Durchsuchen')}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={t('{name} bearbeiten', { name: tg.name })} title={t('Bearbeiten')} onClick={() => setEditing(editing === tg.id ? null : tg.id)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    aria-label={t('{name} entfernen', { name: tg.name })}
                    title={t('Entfernen')}
                    onClick={() => void remove(tg)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {editing === tg.id && <TargetForm value={tg} root={status.data?.root ?? '/backup'} onDone={() => setEditing(null)} />}
              </li>
            );
          })}
        </ul>
      )}
      <FormError>{error}</FormError>
      {editing === 'new' ? (
        <TargetForm
          root={status.data?.root ?? '/backup'}
          onDone={(added) => {
            setEditing(null);
            if (added) setScans((s) => ({ ...s, [added.id]: added.scan }));
          }}
        />
      ) : (
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> {t('Ziel hinzufügen')}
        </Button>
      )}
    </section>
  );
}

/** What „Durchsuchen“ (or adding the target) found there. */
function ScanResult({ result, onOpenTab }: { result?: BackupScan | { error: string } | 'busy'; onOpenTab: (p: BackupPage) => void }) {
  if (!result || result === 'busy') return null;
  if ('error' in result)
    return (
      <span className="mt-0.5 flex items-start gap-1 text-xs text-danger" role="status">
        <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {t('Durchsuchen ging nicht: {error}', { error: result.error })}
      </span>
    );
  const text =
    result.added > 0
      ? tn(result.added, '{n} Sicherung, die dort schon lag, steht jetzt in der Liste.', '{n} Sicherungen, die dort schon lagen, stehen jetzt in der Liste.')
      : result.found > 0
        ? tn(result.found, 'Nichts Neues – die {n} Sicherung dort steht schon in der Liste.', 'Nichts Neues – die {n} Sicherungen dort stehen schon in der Liste.')
        : t('Dort liegen keine Sicherungen von Kaveyl Wiki.');
  return (
    <span className="mt-0.5 block space-y-0.5 text-xs" role="status">
      <span className="flex items-start gap-1 text-fg-muted">
        <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-ok" />
        <span>
          {text} {result.found > 0 && tabLink(onOpenTab, 'backup-files', t('Zu den Sicherungen'))}
        </span>
      </span>
      {result.unmatched.length > 0 && (
        <span className="flex items-start gap-1 text-warn">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {tn(
            result.unmatched.length,
            'Zum Ordner {names} gibt es keine Quelle mit diesem Namen – seine Sicherungen holst du mit „Öffnen“ → „Speichern als“ in einen Ordner deiner Wahl.',
            'Zu den Ordnern {names} gibt es keine Quelle mit diesem Namen – ihre Sicherungen holst du mit „Öffnen“ → „Speichern als“ in einen Ordner deiner Wahl.',
            { names: result.unmatched.map((n) => `„${n}“`).join(', ') },
          )}
        </span>
      )}
    </span>
  );
}

function TestResult({ result }: { result?: BackupTestResult | { error: string } | 'busy' }) {
  if (!result || result === 'busy') return null;
  if ('error' in result)
    return (
      <span className="mt-0.5 flex items-start gap-1 text-xs text-danger" role="status">
        <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {result.error}
      </span>
    );
  return (
    <span className="mt-0.5 block space-y-0.5 text-xs" role="status">
      <span className="flex items-center gap-1 text-ok">
        <CheckCircle2 className="h-3.5 w-3.5" />{' '}
        {result.free !== null
          ? t('Test erfolgreich: schreiben, lesen und löschen gehen · frei: {free}', { free: fmtBytes(result.free) })
          : t('Test erfolgreich: schreiben, lesen und löschen gehen')}
      </span>
      {result.warnings.map((w) => (
        <span key={w} className="flex items-start gap-1 text-warn">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {w}
        </span>
      ))}
    </span>
  );
}

/** `onDone(added)`: a new target with what the search there found (AD-075). */
function TargetForm({ value, root, onDone }: { value?: BackupTarget; root: string; onDone: (added?: { id: string; scan: BackupScan | { error: string } }) => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<BackupTargetKind>(value?.kind ?? 'smb');
  const [name, setName] = useState(value?.name ?? '');
  const [location, setLocation] = useState(value?.location ?? '');
  const [username, setUsername] = useState(value?.username ?? '');
  const [domain, setDomain] = useState(value?.domain ?? '');
  const [password, setPassword] = useState('');
  const [encrypt, setEncrypt] = useState(value?.encrypted ?? false);
  const [archivePw, setArchivePw] = useState('');
  const [archivePw2, setArchivePw2] = useState('');
  const [test, setTest] = useState<BackupTestResult | { error: string } | 'busy' | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !!password || !!archivePw || name !== (value?.name ?? '') || location !== (value?.location ?? '') || username !== (value?.username ?? '') || encrypt !== (value?.encrypted ?? false);
  useModalDirty(dirty);
  const input = (): BackupTargetInput => ({ kind, name, location, username: kind === 'smb' ? username : null, domain: kind === 'smb' ? domain : null, ...(password ? { password } : {}) });
  const runTest = async (): Promise<boolean> => {
    setTest('busy');
    try {
      setTest(await api.testBackupTarget({ ...input(), id: value?.id }));
      return true;
    } catch (e) {
      setTest({ error: errorText(e) });
      return false;
    }
  };
  const pwProblem = encrypt && (!value?.encrypted || archivePw) ? (archivePw.length < 8 ? t('Das Backup-Passwort braucht mindestens 8 Zeichen') : archivePw !== archivePw2 ? t('Die beiden Passwörter stimmen nicht überein') : null) : null;
  const repeat = useRepeatCheck(archivePw, archivePw2);
  const save = async (skipTest = false) => {
    setError(null);
    // A differing repeat is said at its field (design-002); too short or not repeated at all, here.
    if (pwProblem) return archivePw.length >= 8 && archivePw2 ? repeat.reveal() : setError(pwProblem);
    if (
      value?.encrypted &&
      !encrypt &&
      !(await confirmDialog(t('Verschlüsselung ausschalten? Neue Sicherungen sind dann ohne Passwort lesbar; bestehende bleiben verschlüsselt.'), {
        confirmLabel: t('Ausschalten'),
        danger: true,
      }))
    )
      return;
    if (!skipTest && !(await runTest())) return;
    setBusy(true);
    try {
      const archivePassword = encrypt ? (archivePw ? archivePw : undefined) : value?.encrypted ? '' : undefined;
      let added: { id: string; scan: BackupScan | { error: string } } | undefined;
      if (value) await api.saveBackupTarget(value.id, { ...input(), ...(archivePassword !== undefined ? { archivePassword } : {}) });
      else added = await api.addBackupTarget({ ...input(), ...(archivePassword ? { archivePassword } : {}) });
      await qc.invalidateQueries({ queryKey: ['backup-targets'] });
      if (added) await qc.invalidateQueries({ queryKey: ['backup-files'] });
      onDone(added);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void save();
  };
  const testFailed = test && test !== 'busy' && 'error' in test;
  const missingId = useId();
  const missing =
    kind === 'smb'
      ? [!location.trim() && t('Adresse der Freigabe'), !username.trim() && t('Benutzername'), !value?.passwordSet && !password && t('Passwort')].filter((x): x is string => !!x)
      : [];
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-line p-3" aria-label={value ? t('Ziel {name} bearbeiten', { name: value.name }) : t('Neues Ziel')}>
      {!value && (
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 text-sm" role="radiogroup" aria-label={t('Art des Ziels')}>
          {(
            [
              ['smb', t('SMB-Freigabe (NAS, Windows)')],
              ['local', t('Lokaler Ordner')],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={cx('flex-1 rounded-md px-2 py-1', kind === k ? 'bg-bg shadow-sm' : 'text-fg-muted')}
              onClick={() => {
                setKind(k);
                setTest(undefined);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {kind === 'smb' ? (
        <>
          <Field
            label={t('Adresse der Freigabe')}
            hint={t('Server, Freigabe und optional ein Ordner darin, z. B. \\\\nas\\backup\\kaveyl-wiki – fehlende Ordner legt Kaveyl Wiki an.')}
          >
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="\\nas\backup\kaveyl-wiki" autoComplete="off" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Benutzername')}>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            </Field>
            <Field
              label={t('Passwort')}
              hint={value?.passwordSet ? t('Gespeichert (verschlüsselt) – nur ausfüllen, um es zu ersetzen.') : t('Wird verschlüsselt gespeichert und nie wieder angezeigt.')}
            >
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Domäne / Arbeitsgruppe (optional)')} hint={t('Nur nötig, wenn der Server es verlangt (Windows-Domäne).')}>
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" />
            </Field>
            <Field label={t('Name (optional)')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('z. B. NAS im Keller')} />
            </Field>
          </div>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Unterordner (optional)')} hint={t('Ordner in {root}, z. B. kaveyl-wiki – leer = direkt in {root}. Fehlende Ordner legt Kaveyl Wiki an.', { root })}>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="kaveyl-wiki" autoComplete="off" />
          </Field>
          <Field label={t('Name (optional)')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Backup-Ordner')} />
          </Field>
        </div>
      )}
      <div className="space-y-2 rounded-lg bg-muted/50 p-2.5">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-[var(--accent)]" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
          {t('Sicherungen mit einem Backup-Passwort verschlüsseln')}
        </label>
        {encrypt && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={value?.encrypted ? t('Neues Backup-Passwort (leer = beibehalten)') : t('Backup-Passwort')}>
                <Input type="password" value={archivePw} onChange={(e) => setArchivePw(e.target.value)} autoComplete="new-password" />
              </Field>
              <Field label={t('Backup-Passwort wiederholen')} error={repeat.error}>
                <Input type="password" value={archivePw2} onChange={(e) => setArchivePw2(e.target.value)} onBlur={repeat.onBlur} autoComplete="new-password" />
              </Field>
            </div>
            <p className="text-xs text-fg-muted">
              {t(
                'ZIP mit AES-256: öffnen mit 7-Zip, Keka oder WinRAR (nicht mit dem eingebauten Entpacker von Windows oder macOS). Die Dateinamen bleiben sichtbar, die Inhalte nicht.',
              )}{' '}
              {fillNodes(
                t(
                  '{aufheben} – ohne es ist eine Sicherung wertlos, wenn Kaveyl Wiki selbst verloren ist. Nur mit Passwort werden auch gespeicherte Zugangsdaten (Tokens, Passwörter) mitgesichert.',
                ),
                { aufheben: <strong>{t('Passwort gut aufheben')}</strong> },
              )}
            </p>
          </>
        )}
      </div>
      <TestResult result={test} />
      <FormError>{error}</FormError>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <MissingHint id={missingId} items={missing} className="mr-auto" />
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {t('Abbrechen')}
        </Button>
        <Button type="button" disabled={test === 'busy' || (!location.trim() && kind === 'smb')} onClick={() => void runTest()}>
          {test === 'busy' && <Spinner />} {t('Testen')}
        </Button>
        {testFailed && (
          <Button type="button" disabled={busy} onClick={() => void save(true)} title={t('Speichern, obwohl der Test fehlschlug (z. B. Server gerade aus)')}>
            {t('Ohne Test speichern')}
          </Button>
        )}
        <Button variant="primary" disabled={busy || test === 'busy' || missing.length > 0} aria-describedby={missing.length ? missingId : undefined}>
          {busy && <Spinner />} {value ? t('Testen und speichern') : t('Testen und anlegen')}
        </Button>
      </div>
    </form>
  );
}

const tabLink = (go: (p: BackupPage) => void, page: BackupPage, text: string) => (
  <button type="button" className="text-accent hover:underline" onClick={() => go(page)}>
    {text}
  </button>
);

// ── Zeitpläne ──────────────────────────────────────────────────────────────────────────
const TIERS: [keyof BackupKeep, string, string, number][] = [
  ['daily', t('Täglich'), t('jeden Tag'), 7],
  ['weekly', t('Wöchentlich'), t('sonntags'), 4],
  ['monthly', t('Monatlich'), t('am 1. des Monats'), 12],
  ['yearly', t('Jährlich'), t('am 1. Januar'), 3],
];

const keepText = (k: BackupKeep) =>
  TIERS.filter(([tier]) => k[tier] > 0)
    .map(([tier, label]) => t('{label} ({n} behalten)', { label, n: k[tier] }))
    .join(' · ');

function reach(k: BackupKeep): string {
  const days = Math.max(k.daily, k.weekly * 7, k.monthly * 30, k.yearly * 365);
  if (days >= 730) return t('etwa {n} Jahre', { n: Math.round(days / 365) });
  if (days >= 60) return t('etwa {n} Monate', { n: Math.round(days / 30) });
  if (days >= 14) return t('etwa {n} Wochen', { n: Math.round(days / 7) });
  return tn(days, '{n} Tag', '{n} Tage');
}

export function BackupPlansPanel({ onOpenTab }: { onOpenTab: (p: BackupPage) => void }) {
  const qc = useQueryClient();
  const plans = usePlans();
  const targets = useTargets();
  const mounts = useMounts();
  const runs = useRuns();
  const start = useStartRequest();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [preset, setPreset] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  // From the source menu: show its plans – or start a new one with this source, if none has it.
  useEffect(() => {
    if (start?.page !== 'backup-plans' || !start.mountId || !plans.data) return;
    if (!plans.data.some((p) => p.sources.includes('*') || p.sources.includes(start.mountId!))) {
      setPreset(start.mountId);
      setEditing('new');
    }
  }, [start?.n, plans.data === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastRun = (planId: string) => runs.data?.runs.find((r) => r.planId === planId);
  const sourceText = (p: BackupPlan) => {
    const names = p.sources.includes('*') ? [t('Alle Quellen')] : p.sources.map((id) => mounts.data?.find((m) => m.id === id)?.name ?? '?');
    return [...names, ...(p.includeDb ? [t('Kaveyl-Wiki-Datenbank')] : [])].join(', ');
  };
  const run = async (p: BackupPlan) => {
    setError(null);
    try {
      await api.runBackupPlan(p.id);
      toast({ kind: 'ok', title: t('Sicherung gestartet'), text: t('„{name}“ läuft im Hintergrund – Fortschritt unter Backup → Sicherungen.', { name: p.name }) });
      await qc.invalidateQueries({ queryKey: ['backup-runs'] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const toggle = async (p: BackupPlan) => {
    await api.saveBackupPlan(p.id, { enabled: !p.enabled }).catch((e: unknown) => setError(errorText(e)));
    await qc.invalidateQueries({ queryKey: ['backup-plans'] });
  };
  const remove = async (p: BackupPlan) => {
    if (
      !(await confirmDialog(t('Zeitplan „{name}“ löschen? Seine Sicherungen bleiben am Ziel und in der Liste, werden aber nicht mehr aufgeräumt.', { name: p.name }), {
        confirmLabel: t('Löschen'),
        danger: true,
      }))
    )
      return;
    await api.removeBackupPlan(p.id).catch((e: unknown) => setError(errorText(e)));
    await qc.invalidateQueries({ queryKey: ['backup-plans'] });
    await qc.invalidateQueries({ queryKey: ['backup-targets'] });
  };
  const noTargets = targets.data?.length === 0;
  // A failed run is only worth anything if someone hears of it: say so when no way is on and ready.
  const notify = useQuery({ queryKey: ['notify'], queryFn: api.notify, enabled: !!plans.data?.length });
  const silent = !!notify.data && !(['mail', 'pushover'] as const).some((c) => notify.data!.rules.backup[c] && notify.data!.channels[c]);
  return (
    <section className="space-y-3 text-sm" aria-label={t('Zeitpläne')}>
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Ein Zeitplan sichert Quellen (einzelne oder alle, auch künftige) und auf Wunsch die Kaveyl-Wiki-Datenbank auf ein {ziel} – je Quelle eine ZIP-Datei. Wie viele Sicherungen bleiben, sagt die Tabelle: von jedem Tag, jeder Woche, jedem Monat, jedem Jahr die neueste.',
          ),
          { ziel: tabLink(onOpenTab, 'backup-targets', t('Ziel')) },
        )}
      </p>
      {silent && (
        <p className="rounded-lg border border-line bg-subtle px-3 py-2 text-fg-muted" role="note">
          {fillNodes(t('Schlägt eine Sicherung fehl, erfährt das niemand: unter {link} ist für „Backup“ kein eingerichteter Weg (E-Mail oder Pushover) eingeschaltet.'), {
            link: (
              <button type="button" className="text-accent hover:underline" onClick={() => openSettings('events')}>
                {t('Benachrichtigungen')}
              </button>
            ),
          })}
        </p>
      )}
      {plans.isPending && <Spinner />}
      {plans.data?.length === 0 && editing !== 'new' && <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-fg-muted">{t('Noch kein Zeitplan.')}</p>}
      {!!plans.data?.length && (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Zeitpläne')}>
          {plans.data.map((p) => {
            const last = lastRun(p.id);
            const target = targets.data?.find((tg) => tg.id === p.targetId);
            const highlight = start?.page === 'backup-plans' && !!start.mountId && (p.sources.includes('*') || p.sources.includes(start.mountId));
            return (
              <li key={p.id} className={cx('space-y-2 px-3 py-2.5', highlight && 'bg-accent-soft/40')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-medium">
                      {p.name}
                      {!p.enabled && <span className="rounded bg-muted px-1.5 text-[0.6875rem] font-normal text-fg-muted">{t('pausiert')}</span>}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {sourceText(p)} → {target?.name ?? '?'}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {t('{keep} · um {time} Uhr · reicht {reach} zurück', { keep: keepText(p.keep), time: p.time, reach: reach(p.keep) })}
                    </span>
                    <span className="block text-xs text-fg-faint">
                      {p.enabled && p.nextRun ? t('Nächste Sicherung: {when}', { when: when(p.nextRun) }) : t('Keine geplante Sicherung')}
                      {last && (
                        <>
                          {' · '}
                          <span className={cx(last.status === 'error' && 'text-danger', last.status === 'partial' && 'text-warn')}>
                            {t('zuletzt {when}: {status}', { when: when(last.startedAt), status: RUN_STATUS[last.status] })}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void run(p)} disabled={!!runs.data?.running} title={t('Jetzt sichern')}>
                    <Play className="h-3.5 w-3.5" /> {t('Jetzt sichern')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(p)}>
                    {p.enabled ? t('Pausieren') : t('Fortsetzen')}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={t('{name} bearbeiten', { name: p.name })} title={t('Bearbeiten')} onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" aria-label={t('{name} löschen', { name: p.name })} title={t('Löschen')} onClick={() => void remove(p)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {editing === p.id && <PlanForm value={p} targets={targets.data ?? []} mounts={mounts.data ?? []} onDone={() => setEditing(null)} />}
              </li>
            );
          })}
        </ul>
      )}
      <FormError>{error}</FormError>
      {noTargets ? (
        <p className="text-fg-muted">
          {fillNodes(t('Zuerst unter {ziele} ein Ziel anlegen – dann lässt sich hier ein Zeitplan einrichten.'), {
            ziele: tabLink(onOpenTab, 'backup-targets', t('Ziele')),
          })}
        </p>
      ) : editing === 'new' ? (
        <PlanForm
          targets={targets.data ?? []}
          mounts={mounts.data ?? []}
          preset={preset}
          onDone={() => {
            setEditing(null);
            setPreset(undefined);
          }}
        />
      ) : (
        <Button size="sm" variant="primary" onClick={() => setEditing('new')} disabled={!targets.data}>
          <Plus className="h-3.5 w-3.5" /> {t('Zeitplan hinzufügen')}
        </Button>
      )}
    </section>
  );
}

const RUN_STATUS: Record<BackupRun['status'], string> = {
  running: t('läuft'),
  ok: t('erfolgreich'),
  partial: t('teilweise fehlgeschlagen'),
  error: t('fehlgeschlagen'),
};

function PlanForm({ value, targets, mounts, preset, onDone }: { value?: BackupPlan; targets: BackupTarget[]; mounts: Mount[]; preset?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(value?.name ?? '');
  const [targetId, setTargetId] = useState(value?.targetId ?? targets[0]?.id ?? '');
  const [all, setAll] = useState(value ? value.sources.includes('*') : !preset);
  const [sources, setSources] = useState<string[]>(value && !value.sources.includes('*') ? value.sources : preset ? [preset] : []);
  const [includeDb, setIncludeDb] = useState(value?.includeDb ?? !preset);
  const [keep, setKeep] = useState<BackupKeep>(value?.keep ?? { daily: 7, weekly: 4, monthly: 12, yearly: 0 });
  const [time, setTime] = useState(value?.time ?? '02:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverZone = useQuery({ queryKey: ['backup-status'], queryFn: api.backupStatus }).data?.timeZone;
  const otherZone = serverZone && serverZone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? serverZone : null;
  useModalDirty(!value || name !== value.name || targetId !== value.targetId || JSON.stringify(keep) !== JSON.stringify(value.keep) || time !== value.time);
  const target = targets.find((tg) => tg.id === targetId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      const body = { name, targetId, sources: all ? ['*'] : sources, includeDb, keep, time };
      if (value) await api.saveBackupPlan(value.id, body);
      else await api.addBackupPlan(body);
      await qc.invalidateQueries({ queryKey: ['backup-plans'] });
      await qc.invalidateQueries({ queryKey: ['backup-targets'] });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const any = keep.daily + keep.weekly + keep.monthly + keep.yearly > 0;
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-lg border border-line p-3"
      aria-label={value ? t('Zeitplan {name} bearbeiten', { name: value.name }) : t('Neuer Zeitplan')}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Ziel')}>
          <select aria-label={t('Ziel')} className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {targets.map((tg) => (
              <option key={tg.id} value={tg.id}>
                {tg.name}
                {tg.encrypted ? ` (${t('verschlüsselt')})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Name (optional)')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={target ? t('Sicherung nach {name}', { name: target.name }) : ''} />
        </Field>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-fg-muted">{t('Was wird gesichert?')}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="sources" className="accent-[var(--accent)]" checked={all} onChange={() => setAll(true)} />
          {t('Alle Quellen – auch solche, die später dazukommen')}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="sources" className="accent-[var(--accent)]" checked={!all} onChange={() => setAll(false)} />
          {t('Ausgewählte Quellen')}
        </label>
        {!all && (
          <div className="ml-6 grid gap-1 sm:grid-cols-2">
            {mounts.map((m) => (
              <label key={m.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={sources.includes(m.id)}
                  onChange={(e) => setSources((s) => (e.target.checked ? [...s, m.id] : s.filter((x) => x !== m.id)))}
                />
                <span className="truncate">{m.name}</span>
              </label>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 pt-1">
          <input type="checkbox" className="accent-[var(--accent)]" checked={includeDb} onChange={(e) => setIncludeDb(e.target.checked)} />
          {t('Auch die Kaveyl-Wiki-Datenbank (Benutzer, Rechte, Einstellungen, Quellen)')}
        </label>
        {includeDb && target && !target.encrypted && (
          <p className="ml-6 text-xs text-warn">
            {t(
              'Dieses Ziel hat kein Backup-Passwort. Gespeicherte Zugangsdaten wie Tokens und Passwörter kommen deshalb nicht mit in die Sicherung. Nach einem Rückspielen gibst du sie neu ein. Sollen sie mitgesichert werden, setze am Ziel ein Backup-Passwort.',
            )}
          </p>
        )}
      </fieldset>
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">{t('Wann und wie viele behalten?')}</div>
        <table className="w-full max-w-md text-sm" aria-label={t('Rhythmus und Aufbewahrung')}>
          <tbody>
            {TIERS.map(([tier, label, hint, def]) => (
              <tr key={tier}>
                <td className="py-1 pr-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={keep[tier] > 0} onChange={(e) => setKeep({ ...keep, [tier]: e.target.checked ? def : 0 })} />
                    <span>
                      {label} <span className="text-xs text-fg-faint">({hint})</span>
                    </span>
                  </label>
                </td>
                <td className="py-1 text-right">
                  {keep[tier] > 0 && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                      {t('behalten')}
                      <input
                        type="number"
                        min={1}
                        max={366}
                        aria-label={t('{label} behalten', { label })}
                        className="h-7 w-16 rounded-md border border-line bg-bg px-1.5 text-sm text-fg"
                        value={keep[tier]}
                        onChange={(e) => setKeep({ ...keep, [tier]: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </label>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2">
            {t('Uhrzeit')}
            <input type="time" aria-label={t('Uhrzeit')} className="h-8 rounded-md border border-line bg-bg px-2" value={time} onChange={(e) => setTime(e.target.value)} />
            {otherZone && <span className="text-xs text-warn">{t('Zeitzone des Servers: {zone}', { zone: otherZone })}</span>}
          </label>
          <span className="text-xs text-fg-muted">
            {any
              ? t('Höchstens {n} Sicherungen je Quelle, sie reichen {reach} zurück.', { n: keep.daily + keep.weekly + keep.monthly + keep.yearly, reach: reach(keep) })
              : t('Mindestens eine Zeile wählen.')}
          </span>
        </div>
        <p className="mt-1 text-xs text-fg-faint">
          {t(
            'Gesichert wird im feinsten gewählten Rhythmus. Wer nur „Wöchentlich“ wählt, sichert sonntags. War Kaveyl Wiki zur Uhrzeit aus, holt es die Sicherung beim nächsten Start nach.',
          )}
        </p>
      </div>
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('Abbrechen')}
        </Button>
        <Button variant="primary" disabled={busy || !targetId || !any || (!all && !sources.length && !includeDb)}>
          {busy && <Spinner />} {value ? t('Speichern') : t('Zeitplan anlegen')}
        </Button>
      </div>
    </form>
  );
}

// ── Sicherungen (Verlauf + Wiederherstellen) ─────────────────────────────────────────────
export function BackupFilesPanel({ onOpenTab }: { onOpenTab: (p: BackupPage) => void }) {
  const qc = useQueryClient();
  const start = useStartRequest();
  const fromTree = start?.page === 'backup-files' ? start : null;
  const [mountId, setMountId] = useState<string>(fromTree?.mountId ?? '');
  const [opened, setOpened] = useState<BackupArchive | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const runs = useRuns();
  const mounts = useMounts();
  const targets = useTargets();
  const [targetId, setTargetId] = useState('');
  const [onlyLatest, setOnlyLatest] = useState(false);
  // Always fresh when the tab opens: archives come from runs started elsewhere (tree menu, schedule).
  const files = useQuery({ queryKey: ['backup-files', mountId], queryFn: () => api.backupArchives({ mountId: mountId || undefined }), refetchOnMount: 'always' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (fromTree?.mountId) setMountId(fromTree.mountId);
  }, [fromTree?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // „Zurückspielen“ (AD-075): the whole source over its old place; without that source (or with another backup password)
  // the archive opens instead – „Speichern als“ there, or the password.
  const restoreWhole = async (f: BackupArchive) => {
    const mount = mounts.data?.find((m) => m.id === f.mountId);
    if (!mount) return setOpened(f);
    if (
      !(await confirmDialog(
        // Only a source with Git keeps what is replaced – a folder without versions does not (code-008 0.2.7).
        mount.git
          ? t(
              'Die ganze Quelle „{name}“ mit dem Stand vom {when} zurückspielen? Vorhandene Dateien werden ersetzt, neuere Dateien bleiben, nichts wird gelöscht. Der jetzige Stand bleibt in den Versionen erhalten.',
              { name: mount.name, when: when(f.createdAt) },
            )
          : t(
              'Die ganze Quelle „{name}“ mit dem Stand vom {when} zurückspielen? Vorhandene Dateien werden ersetzt, neuere Dateien bleiben, nichts wird gelöscht. Dieser Ordner führt keine Versionen – was ersetzt wird, ist danach nicht mehr da.',
              { name: mount.name, when: when(f.createdAt) },
            ),
        { confirmLabel: t('Zurückspielen'), danger: true },
      ))
    )
      return;
    setError(null);
    setRestoring(f.id);
    try {
      const r = await api.restoreBackup(f.id, '', 'overwrite');
      await qc.invalidateQueries({ queryKey: ['tree', r.mountId] });
      await qc.invalidateQueries({ queryKey: ['mounts'] });
      const skipped = r.skipped.length
        ? ` ${tn(r.skipped.length, '{n} unverschlüsselte Notiz im verschlüsselten Ordner ausgelassen.', '{n} unverschlüsselte Notizen im verschlüsselten Ordner ausgelassen.')}`
        : '';
      toast({
        kind: 'ok',
        title: tn(r.paths.length, '„{name}“ zurückgespielt ({n} Datei)', '„{name}“ zurückgespielt ({n} Dateien)', { name: mount.name }),
        text: `${r.history ? t('Der Verlauf (Versionen) ist auch wieder da.') : ''}${skipped}`.trim() || undefined,
      });
    } catch (e) {
      if (e instanceof ApiError && (e.body.code === 'backup-password' || e.body.code === 'backup-unencrypted')) setOpened(f);
      else setError(errorText(e));
    } finally {
      setRestoring(null);
    }
  };
  const remove = async (f: BackupArchive) => {
    if (
      !(await confirmDialog(t('Sicherung vom {when} ({label}) am Ziel „{target}“ endgültig löschen?', { when: when(f.createdAt), label: f.label, target: f.targetName }), {
        confirmLabel: t('Löschen'),
        danger: true,
      }))
    )
      return;
    setError(null);
    try {
      await api.removeBackupArchive(f.id);
      await qc.invalidateQueries({ queryKey: ['backup-files'] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  // Per source, newest first (as the server sends them), then by month – a list of years stays short.
  const groups = useMemo(() => {
    const out = new Map<string, BackupArchive[]>();
    for (const f of files.data ?? []) {
      if (targetId && f.targetId !== targetId) continue;
      const key = f.mountId ?? 'db';
      out.set(key, [...(out.get(key) ?? []), f]);
    }
    return [...out].map(([key, all]) => {
      const list = onlyLatest ? all.slice(0, LATEST) : all;
      const months = new Map<string, BackupArchive[]>();
      for (const f of list) {
        const m = monthKey(f.createdAt);
        months.set(m, [...(months.get(m) ?? []), f]);
      }
      return { key, all, months: [...months] };
    });
  }, [files.data, targetId, onlyLatest]);
  const running = runs.data?.running;
  return (
    <section className="space-y-4 text-sm" aria-label={t('Sicherungen')}>
      {running && (
        <p className="flex items-center gap-2 rounded-lg border border-line bg-accent-soft/40 px-3 py-2" role="status">
          <Spinner className="h-3.5 w-3.5" /> {t('„{name}“ läuft: {step} …', { name: running.planName, step: running.step })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <span className="text-fg-muted">{t('Quelle')}</span>
          <select aria-label={t('Quelle')} className="h-8 rounded-md border border-line bg-bg px-2" value={mountId} onChange={(e) => setMountId(e.target.value)}>
            <option value="">{t('Alle')}</option>
            {mounts.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value="db">{t('Kaveyl-Wiki-Datenbank')}</option>
          </select>
        </label>
        {(targets.data?.length ?? 0) > 1 && (
          <label className="flex items-center gap-2">
            <span className="text-fg-muted">{t('Ziel')}</span>
            <select aria-label={t('Ziel')} className="h-8 rounded-md border border-line bg-bg px-2" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">{t('Alle')}</option>
              {targets.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={onlyLatest} onChange={(e) => setOnlyLatest(e.target.checked)} />
          {t('nur die neuesten {n} zeigen', { n: LATEST })}
        </label>
        {fromTree?.path && mountId === fromTree.mountId && (
          <span className="text-xs text-fg-muted">{t('Gesucht: „{name}“ – Sicherung öffnen, die Stelle ist ausgewählt.', { name: noteName(fromTree.path) })}</span>
        )}
      </div>
      {files.isPending && <Spinner />}
      {files.data?.length === 0 && (
        <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-fg-muted">
          {fillNodes(
            mountId
              ? t('Noch keine Sicherung dieser Quelle. Sicherungen entstehen durch die {plans}.')
              : t('Noch keine Sicherung. Sicherungen entstehen durch die {plans}.'),
            { plans: tabLink(onOpenTab, 'backup-plans', t('Zeitpläne')) },
          )}
        </p>
      )}
      {groups.map(({ key, all, months }) => (
        <section key={key} className="rounded-lg border border-line" aria-label={t('Sicherungen {label}', { label: all[0]!.label })}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-muted/50 px-3 py-1.5 text-xs font-medium text-fg-muted">
            {key === 'db'
              ? t('Kaveyl-Wiki-Datenbank')
              : (mounts.data?.find((m) => m.id === key)?.name ??
                (key.startsWith('ordner:') ? t('{label} (keine Quelle mit diesem Namen)', { label: all[0]!.label }) : t('{label} (Quelle entfernt)', { label: all[0]!.label })))}
            <span className="font-normal text-fg-faint">
              {tn(all.length, '{n} Sicherung', '{n} Sicherungen')} · {fmtBytes(all.reduce((n, f) => n + f.size, 0))}
            </span>
          </div>
          {key === 'db' && (
            <p className="border-b border-line px-3 py-1.5 text-xs text-fg-muted">
              {fillNodes(
                t(
                  'Hier: Sicherungen auf die Ziele. Die Tageskopien auf dem Server selbst stehen im Reiter {db}. Zurückspielen lässt sich eine Datenbank-Sicherung auf einem neuen Server in der Ersteinrichtung: herunterladen und dort hochladen.',
                ),
                { db: tabLink(onOpenTab, 'backups', t('Datenbank')) },
              )}
            </p>
          )}
          {months.map(([month, list], i) => (
            <details key={month} open={i === 0} className="group border-b border-line last:border-b-0">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs text-fg-muted hover:bg-hover">
                <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden="true" />
                <span className="font-medium text-fg">{monthLabel(list[0]!.createdAt)}</span>
                <span className="text-fg-faint">
                  {tn(list.length, '{n} Sicherung', '{n} Sicherungen')} · {fmtBytes(list.reduce((n, f) => n + f.size, 0))}
                </span>
              </summary>
              <ul className="divide-y divide-line border-t border-line">
                {list.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {when(f.createdAt)}
                        {f.encrypted && <Lock className="h-3 w-3 text-fg-faint" aria-label={t('verschlüsselt')} />}
                      </span>
                      <span className="block truncate text-xs text-fg-faint">
                        {f.targetName} · {fmtBytes(f.size)} · {f.path}
                      </span>
                    </span>
                    {f.mountId && (
                      <Button size="sm" variant="ghost" onClick={() => setOpened(f)}>
                        <FolderOpen className="h-3.5 w-3.5" /> {t('Öffnen')}
                      </Button>
                    )}
                    {f.mountId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={restoring !== null}
                        title={mounts.data?.some((m) => m.id === f.mountId) ? t('Die ganze Quelle mit diesem Stand zurückspielen') : t('Ohne passende Quelle: öffnen und „Speichern als“')}
                        onClick={() => void restoreWhole(f)}
                      >
                        {restoring === f.id ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />} {t('Zurückspielen')}
                      </Button>
                    )}
                    <a className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-fg-muted hover:bg-hover hover:text-fg" href={api.backupArchiveUrl(f.id)}
                      download
                      title={t('ZIP herunterladen')}
                    >
                      <Download className="h-3.5 w-3.5" /> {t('Herunterladen')}
                    </a>
                    <Button size="sm" variant="ghost" className="text-danger" aria-label={t('Sicherung vom {when} löschen', { when: when(f.createdAt) })}
                      title={t('Löschen')} onClick={() => void remove(f)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      ))}
      <FormError>{error}</FormError>
      <RunHistory runs={runs.data?.runs ?? []} />
      {opened && <ArchiveBrowser archive={opened} focus={fromTree?.mountId === opened.mountId ? fromTree?.path : undefined} onClose={() => setOpened(null)} />}
    </section>
  );
}

function RunHistory({ runs }: { runs: BackupRun[] }) {
  const [open, setOpen] = useState(false);
  if (!runs.length) return null;
  const problems = runs.filter((r) => r.status === 'error' || r.status === 'partial').length;
  return (
    <section className="rounded-lg border border-line" aria-label={t('Verlauf')}>
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover" onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
        <span className="font-medium">{t('Verlauf')}</span>
        <span className="text-xs text-fg-faint">
          {tn(runs.length, '{n} Lauf', '{n} Läufe')}
          {problems ? ` · ${t('{n} mit Fehlern', { n: problems })}` : ''}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-line border-t border-line text-xs" aria-label={t('Läufe')}>
          {runs.map((r) => (
            <li key={r.id} className="flex gap-2 px-3 py-1.5">
              <span className="shrink-0 text-fg-faint">{when(r.startedAt)}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r.planName}</span> → {r.targetName} · {r.trigger === 'manual' ? t('von Hand') : t('geplant')} ·{' '}
                <span className={cx(r.status === 'error' && 'text-danger', r.status === 'partial' && 'text-warn', r.status === 'ok' && 'text-ok')}>{RUN_STATUS[r.status]}</span>
                {/* A clean run in the app's number format (like the list above); problems as the server wrote them. */}
                {r.status === 'ok' ? (
                  <span className="block text-fg-muted">
                    {tn(r.archives, '{n} Sicherung', '{n} Sicherungen')} · {fmtBytes(r.bytes)}
                  </span>
                ) : (
                  r.message && <span className="block whitespace-pre-wrap text-fg-muted">{r.message}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Sicherung öffnen: Dateibaum und Wiederherstellen ───────────────────────────────────
interface Node {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  children: Node[];
}

const byName = new Intl.Collator(locale);

function buildTree(entries: BackupEntry[], hidden: boolean): Node {
  const root: Node = { name: '', path: '', dir: true, size: 0, children: [] };
  for (const e of entries) {
    const parts = e.path.split('/');
    if (!hidden && parts.some((p) => p.startsWith('.'))) continue;
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      let child = cur.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path, dir: !last, size: 0, children: [] };
        cur.children.push(child);
      }
      child.size += e.size;
      cur = child;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.dir === b.dir ? byName.compare(a.name, b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

function ArchiveBrowser({ archive, focus, onClose }: { archive: BackupArchive; focus?: string; onClose: () => void }) {
  const entries = useQuery({ queryKey: ['backup-entries', archive.id], queryFn: () => api.backupEntries(archive.id), retry: false });
  const code = entries.error instanceof ApiError ? entries.error.body.code : null;
  const needsPassword = code === 'backup-password' || code === 'backup-unencrypted';
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string>(focus ?? '');
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? focus.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')) : []));
  const [compare, setCompare] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(entries.data ?? [], hidden), [entries.data, hidden]);
  const isFile = !!entries.data?.some((e) => e.path === selected);
  const render = (n: Node, depth: number): ReactNode =>
    n.children.map((c) => (
      <div key={c.path}>
        <button
          type="button"
          className={cx('flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-hover', selected === c.path && 'bg-active font-medium')}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          aria-current={selected === c.path ? 'true' : undefined}
          onClick={() => {
            setSelected(c.path);
            if (c.dir) setOpen((s) => new Set(s.has(c.path) ? [...s].filter((x) => x !== c.path) : [...s, c.path]));
          }}
        >
          {c.dir ? <ChevronRight className={cx('h-3 w-3 shrink-0 text-fg-faint transition-transform', open.has(c.path) && 'rotate-90')} /> : <span className="w-3" />}
          {c.dir ? <Folder className="h-3.5 w-3.5 shrink-0 text-fg-faint" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-fg-faint" />}
          <span className="truncate">{c.dir ? c.name : noteName(c.name)}</span>
        </button>
        {c.dir && open.has(c.path) && render(c, depth + 1)}
      </div>
    ));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t('Sicherung vom {when} – {label}', { when: when(archive.createdAt), label: archive.label })} wide="xl" help="sicherungen">
      {entries.isPending && <Spinner />}
      {needsPassword ? <UnlockForm archive={archive} unencrypted={code === 'backup-unencrypted'} message={errorText(entries.error)} onDone={() => void entries.refetch()} /> : <FormError>{entries.error && errorText(entries.error)}</FormError>}
      {entries.data && (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="min-w-0 sm:w-1/2">
            <div className="max-h-[55vh] overflow-auto rounded-lg border border-line p-1 text-sm" aria-label={t('Inhalt der Sicherung')} role="tree">
              <button
                type="button"
                className={cx('flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-hover', selected === '' && 'bg-active font-medium')}
                onClick={() => setSelected('')}
              >
                <FolderOpen className="h-3.5 w-3.5 text-fg-faint" /> {tn(entries.data.length, 'Ganze Quelle ({n} Datei)', 'Ganze Quelle ({n} Dateien)')}
              </button>
              {render(tree, 1)}
            </div>
            <label className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
              <input type="checkbox" className="accent-[var(--accent)]" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
              {t('Versteckte Dateien zeigen (.kaveyl-wiki, Ordner-Einstellungen)')}
            </label>
          </div>
          <div className="min-w-0 flex-1">
            <RestoreActions archive={archive} path={selected} isFile={isFile} entries={entries.data} onCompare={() => setCompare(selected)} />
          </div>
        </div>
      )}
      {compare && <CompareDialog archive={archive} path={compare} onClose={() => setCompare(null)} />}
    </Modal>
  );
}

/** An archive the target's backup password does not open (an older one, a target added again without it, AD-075). */
/** `unencrypted`: not encrypted although the target has a password – opened only when the admin decides so (planted?). */
function UnlockForm({ archive, unencrypted, message, onDone }: { archive: BackupArchive; unencrypted: boolean; message: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await api.unlockBackupArchive(archive.id, unencrypted ? null : password);
      await qc.invalidateQueries({ queryKey: ['backup-files'] });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (unencrypted)
    return (
      <form className="max-w-md space-y-3 text-sm" aria-label={t('Unverschlüsselte Sicherung')} onSubmit={(e) => void submit(e)}>
        <p className="flex items-start gap-1.5 text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
        </p>
        <p className="text-fg-muted">
          {t(
            'Das kann eine ältere Sicherung aus der Zeit sein, bevor du am Ziel ein Backup-Passwort eingetragen hast. Hat außer dir jemand Zugriff auf das Ziel, kann sie auch untergeschoben sein. Öffne sie nur, wenn du weißt, woher sie stammt.',
          )}
        </p>
        <FormError>{error}</FormError>
        <Button type="submit" variant="danger" size="sm" disabled={busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />} {t('Trotzdem ohne Passwort öffnen')}
        </Button>
      </form>
    );
  return (
    <form className="max-w-md space-y-3 text-sm" aria-label={t('Backup-Passwort eingeben')} onSubmit={(e) => void submit(e)}>
      <p className="flex items-start gap-1.5 text-warn">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" /> {message}
      </p>
      <p className="text-fg-muted">
        {t('Diese Sicherung wurde mit einem anderen Backup-Passwort verschlüsselt als dem, das jetzt am Ziel steht. Gib das Passwort ein, mit dem sie gesichert wurde – Kaveyl Wiki merkt es sich für diese Sicherung.')}
      </p>
      <Field label={t('Backup-Passwort dieser Sicherung')}>
        <Input type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <FormError>{error}</FormError>
      <Button type="submit" variant="primary" size="sm" disabled={busy || !password}>
        {busy && <Spinner className="h-3.5 w-3.5" />} {t('Öffnen')}
      </Button>
    </form>
  );
}

function RestoreActions({ archive, path, isFile, entries, onCompare }: { archive: BackupArchive; path: string; isFile: boolean; entries: BackupEntry[]; onCompare: () => void }) {
  const qc = useQueryClient();
  const isNote = isFile && /\.md$/i.test(path);
  const mountId = archive.mountId!;
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: api.mounts });
  // The source is gone or never was on this server (a folder found on the target, AD-075): only „Speichern als“.
  const sourceThere = !!mounts.data?.some((m) => m.id === mountId);
  const git = !!mounts.data?.find((m) => m.id === mountId)?.git;
  // What the note looks like now (for „unverändert / geändert / gelöscht“).
  const current = useQuery({
    queryKey: ['backup-current', mountId, path],
    queryFn: () => api.note(mountId, path).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
    enabled: isNote && sourceThere,
    retry: false,
  });
  const backup = useQuery({ queryKey: ['backup-entry', archive.id, path], queryFn: () => api.backupEntryText(archive.id, path), enabled: isNote, retry: false });
  const [busy, setBusy] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; open?: { mountId: string; path: string } } | null>(null);
  useEffect(() => setResult(null), [path]);
  const kind = isNote ? 'note' : isFile ? 'file' : 'folder';
  const count = isFile ? 1 : entries.filter((e) => !path || e.path.startsWith(`${path}/`)).length;
  const encrypted = isNote && /^---[\s\S]*?\nencrypted:\s*age/m.test(backup.data?.text ?? '');
  const state = !isNote ? null : current.data === null ? 'gelöscht' : current.data && backup.data ? (current.data.raw === backup.data.text ? 'unverändert' : 'geändert') : null;
  const done = async (r: { paths: string[]; skipped: string[]; root: string; mountId: string; warnings: string[] }, copy: boolean) => {
    await qc.invalidateQueries({ queryKey: ['tree', r.mountId] });
    await qc.invalidateQueries({ queryKey: ['backup-current'] });
    await qc.invalidateQueries({ queryKey: ['note', r.mountId] });
    const skipped = r.skipped.length
      ? ` ${tn(r.skipped.length, '{n} unverschlüsselte Notiz im verschlüsselten Ordner ausgelassen.', '{n} unverschlüsselte Notizen im verschlüsselten Ordner ausgelassen.')}`
      : '';
    const n = r.paths.length;
    const other = r.mountId !== mountId ? (mounts.data?.find((m) => m.id === r.mountId)?.name ?? '') : null;
    const warnings = r.warnings.length ? ` ${r.warnings.join(' ')}` : '';
    const saved =
      other !== null
        ? tn(n, 'Als „{root}“ in „{mount}“ gespeichert ({n} Datei).', 'Als „{root}“ in „{mount}“ gespeichert ({n} Dateien).', { root: r.root, mount: other })
        : tn(n, 'Als „{root}“ gespeichert ({n} Datei).', 'Als „{root}“ gespeichert ({n} Dateien).', { root: r.root });
    setResult({
      ok: true,
      text: copy ? `${saved}${skipped}${warnings}` : `${tn(n, 'Wiederhergestellt ({n} Datei).', 'Wiederhergestellt ({n} Dateien).')}${skipped}`,
      open: /\.md$/i.test(r.root) ? { mountId: r.mountId, path: r.root } : undefined,
    });
  };
  const overwrite = async () => {
    const date = day(archive.createdAt);
    const base = isFile
      ? t('„{name}“ mit dem Stand vom {date} überschreiben?', { name: noteName(path), date })
      : path
        ? tn(
            count,
            'Den Ordner „{path}“ ({n} Datei) mit dem Stand vom {date} überschreiben? Vorhandene Dateien werden ersetzt, neuere Dateien bleiben, nichts wird gelöscht.',
            'Den Ordner „{path}“ ({n} Dateien) mit dem Stand vom {date} überschreiben? Vorhandene Dateien werden ersetzt, neuere Dateien bleiben, nichts wird gelöscht.',
            { path, date },
          )
        : tn(
            count,
            'Die ganze Quelle ({n} Datei) mit dem Stand vom {date} überschreiben? Vorhandene Dateien werden ersetzt, neuere Dateien bleiben, nichts wird gelöscht.',
            'Die ganze Quelle ({n} Dateien) mit dem Stand vom {date} überschreiben? Vorhandene Dateien werden ersetzt, neuere Dateien bleiben, nichts wird gelöscht.',
            { date },
          );
    // Only a source with Git keeps what is replaced (code-008 0.2.7).
    const text = `${base} ${git ? t('Der jetzige Stand bleibt in den Versionen (Git) erhalten.') : t('Dieser Ordner führt keine Versionen – was ersetzt wird, ist danach nicht mehr da.')}`;
    if (!(await confirmDialog(text, { confirmLabel: t('Überschreiben'), danger: true }))) return;
    setBusy(true);
    setResult(null);
    try {
      await done(await api.restoreBackup(archive.id, path, 'overwrite'), false);
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 text-sm" aria-label={t('Wiederherstellen')}>
      <div>
        <div className="font-medium">{isFile ? noteName(path.split('/').pop()!) : path ? path.split('/').pop() : t('Ganze Quelle')}</div>
        <div className="text-xs text-fg-muted">
          {isFile ? path : tn(count, '{n} Datei', '{n} Dateien')} · {t('Stand {when}', { when: when(archive.createdAt) })}
          {state && (
            <>
              {' · '}
              {t('jetzt:')}{' '}
              <span className={cx(state === 'gelöscht' && 'text-warn', state === 'geändert' && 'text-accent')}>{STATE_LABEL[state]}</span>
            </>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {isNote && state === 'geändert' && !encrypted && (
          <ActionRow
            title={t('Vergleichen')}
            text={t('Beide Fassungen nebeneinander. Geänderte Abschnitte einzeln aus der Sicherung übernehmen oder Text herauskopieren, dann speichern oder abbrechen.')}
            button={
              <Button size="sm" variant="primary" onClick={onCompare}>
                {t('Vergleichen …')}
              </Button>
            }
          />
        )}
        <ActionRow
          title={t('Speichern als')}
          text={
            kind === 'folder'
              ? t('Als neuer Ordner – Quelle, Ordner und Name wählst du; vorgeschlagen wird „… (Sicherung {date})“ neben dem Original. Nichts wird überschrieben.', {
                  date: day(archive.createdAt),
                })
              : kind === 'note'
                ? t('Als neue Notiz – Quelle, Ordner und Name wählst du; vorgeschlagen wird „… (Sicherung {date})“ neben dem Original. Nichts wird überschrieben.', {
                    date: day(archive.createdAt),
                  })
                : t('Als neue Datei – Quelle, Ordner und Name wählst du; vorgeschlagen wird „… (Sicherung {date})“ neben dem Original. Nichts wird überschrieben.', {
                    date: day(archive.createdAt),
                  })
          }
          button={
            <Button size="sm" disabled={busy} onClick={() => setSavingAs(true)}>
              {t('Speichern als …')}
            </Button>
          }
        />
        {sourceThere && (
          <ActionRow
            title={t('Überschreiben')}
            text={
              isNote
                ? git
                  ? t('Ersetzt den jetzigen Stand (bleibt in den Versionen). Fehlende Anhänge, auf die die Notiz verweist, kommen mit.')
                  : t('Ersetzt den jetzigen Stand – dieser Ordner führt keine Versionen, er ist danach nicht mehr da. Fehlende Anhänge, auf die die Notiz verweist, kommen mit.')
                : isFile
                  ? git
                    ? t('Ersetzt den jetzigen Stand (bleibt in den Versionen).')
                    : t('Ersetzt den jetzigen Stand – dieser Ordner führt keine Versionen, er ist danach nicht mehr da.')
                  : t('Ersetzt vorhandene Dateien, löscht nichts.')
            }
            button={
              <Button size="sm" disabled={busy || state === 'unverändert'} onClick={() => void overwrite()}>
                {t('Überschreiben')}
              </Button>
            }
          />
        )}
        {!sourceThere && mounts.data && (
          <p className="text-xs text-fg-muted">{t('Die Quelle dieser Sicherung gibt es hier nicht – mit „Speichern als“ holst du sie in einen Ordner deiner Wahl.')}</p>
        )}
        {isFile && !isNote && (
          <ActionRow
            title={t('Herunterladen')}
            text={t('Nur diese Datei aus der Sicherung.')}
            button={
              <a className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs font-medium hover:bg-hover" href={api.backupEntryUrl(archive.id, path)} download>
                <Download className="h-3.5 w-3.5" /> {t('Datei')}
              </a>
            }
          />
        )}
      </div>
      {busy && <Spinner />}
      {result && (
        <p className={cx('flex items-start gap-1.5 text-sm', result.ok ? 'text-ok' : 'text-danger')} role="status">
          {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>
            {result.text}{' '}
            {result.open && (
              <button type="button" className="text-accent hover:underline" onClick={() => useWorkspace.getState().openNote(result.open!.mountId, result.open!.path, noteNameIn(result.open!.mountId, result.open!.path), { newTab: true })}>
                {t('Öffnen')}
              </button>
            )}
          </span>
        </p>
      )}
      {savingAs && (
        <SaveAsDialog
          help="sicherungen"
          kind={kind}
          intro={
            isNote
              ? t('Die Datei mit dem Stand vom {when} kommt als Kopie zurück, mit den Bildern und Anhängen, auf die die Notiz verweist. Das Original bleibt, wie es ist.', {
                  when: when(archive.createdAt),
                })
              : isFile
                ? t('Die Datei mit dem Stand vom {when} kommt als Kopie zurück. Das Original bleibt, wie es ist.', { when: when(archive.createdAt) })
                : path
                  ? tn(
                      count,
                      'Der Ordner ({n} Datei) mit dem Stand vom {when} kommt als Kopie zurück. Das Original bleibt, wie es ist.',
                      'Der Ordner ({n} Dateien) mit dem Stand vom {when} kommt als Kopie zurück. Das Original bleibt, wie es ist.',
                      { when: when(archive.createdAt) },
                    )
                  : tn(
                      count,
                      'Die ganze Quelle ({n} Datei) mit dem Stand vom {when} kommt als Kopie zurück. Das Original bleibt, wie es ist.',
                      'Die ganze Quelle ({n} Dateien) mit dem Stand vom {when} kommt als Kopie zurück. Das Original bleibt, wie es ist.',
                      { when: when(archive.createdAt) },
                    )
          }
          start={{ mountId: sourceThere ? mountId : (mounts.data?.[0]?.id ?? mountId), folder: path && sourceThere ? splitPath(path, kind).folder : '' }}
          name={
            path
              ? nameWith(path, kind, t('Sicherung {date}', { date: day(archive.createdAt) }))
              : sourceThere
                ? t('Sicherung {date}', { date: day(archive.createdAt) })
                : `${archive.label} (${t('Sicherung {date}', { date: day(archive.createdAt) })})`
          }
          onBack={() => setSavingAs(false)}
          onClose={() => setSavingAs(false)}
          onSave={async (dest) => {
            const r = await api.restoreBackup(archive.id, path, 'copy', dest);
            setSavingAs(false);
            await done(r, true);
          }}
        />
      )}
    </div>
  );
}

const STATE_LABEL: Record<'gelöscht' | 'unverändert' | 'geändert', string> = {
  gelöscht: t('gelöscht'),
  unverändert: t('unverändert'),
  geändert: t('geändert'),
};

function ActionRow({ title, text, button }: { title: string; text: string; button: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-fg-muted">{text}</div>
      </div>
      <div className="shrink-0">{button}</div>
    </div>
  );
}

// ── Vergleichen: Abschnitte einzeln übernehmen ─────────────────────────────────────────
function CompareDialog({ archive, path, onClose }: { archive: BackupArchive; path: string; onClose: () => void }) {
  const qc = useQueryClient();
  const mountId = archive.mountId!;
  const backup = useQuery({ queryKey: ['backup-entry', archive.id, path], queryFn: () => api.backupEntryText(archive.id, path) });
  const current = useQuery({ queryKey: ['backup-current-raw', mountId, path], queryFn: () => api.note(mountId, path) });
  const blocks = useMemo<DiffBlock[]>(() => (backup.data && current.data ? diffLines(backup.data.text, current.data.raw) : []), [backup.data, current.data]);
  const [take, setTake] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useModalDirty(take.size > 0);
  const changes = blocks.map((b, i) => (b.kind === 'change' ? i : -1)).filter((i) => i >= 0);
  const save = async () => {
    if (!current.data) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveRaw(mountId, path, mergeBlocks(blocks, (i) => take.has(i)), current.data.hash);
      await qc.invalidateQueries({ queryKey: ['note', mountId] });
      await qc.invalidateQueries({ queryKey: ['backup-current'] });
      toast({
        kind: 'ok',
        title: t('Gespeichert'),
        text: tn(take.size, '{n} Abschnitt aus der Sicherung übernommen.', '{n} Abschnitte aus der Sicherung übernommen.'),
      });
      setTake(new Set());
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t('Die Notiz wurde inzwischen geändert – Vergleich schließen und neu öffnen.') : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t('Vergleichen: {name}', { name: noteName(path.split('/').pop()!) })} wide="xl" help="sicherungen">
      {(backup.isPending || current.isPending) && <Spinner />}
      <FormError>{(backup.error || current.error) && errorText(backup.error ?? current.error)}</FormError>
      {blocks.length > 0 && (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 text-xs font-medium text-fg-muted">
            <span>{t('Sicherung vom {when}', { when: when(archive.createdAt) })}</span>
            <span>{t('Jetziger Stand')}</span>
          </div>
          <div className="max-h-[60vh] space-y-1 overflow-auto rounded-lg border border-line p-2 font-mono text-xs leading-5" aria-label={t('Unterschiede')}>
            {blocks.map((b, i) => (b.kind === 'same' ? <SameBlock key={i} lines={b.lines} /> : <ChangeBlock key={i} block={b} taken={take.has(i)} onToggle={() => setTake((s) => new Set(s.has(i) ? [...s].filter((x) => x !== i) : [...s, i]))} />))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-muted">
              {tn(changes.length, '{taken} von {n} Abschnitt aus der Sicherung übernommen', '{taken} von {n} Abschnitten aus der Sicherung übernommen', { taken: take.size })}
            </span>
            <span className="flex-1" />
            {changes.length > 1 && (
              <Button size="sm" variant="ghost" onClick={() => setTake(take.size === changes.length ? new Set() : new Set(changes))}>
                {take.size === changes.length ? t('Keinen übernehmen') : t('Alle übernehmen')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('Abbrechen')}
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !take.size} onClick={() => void save()}>
              {busy && <Spinner />} {t('Speichern')}
            </Button>
          </div>
          <FormError>{error}</FormError>
        </div>
      )}
    </Modal>
  );
}

function SameBlock({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  if (lines.length <= 6 || open)
    return (
      <div className="text-fg-muted">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-words px-1">
            {l || ' '}
          </div>
        ))}
      </div>
    );
  return (
    <div className="text-fg-muted">
      {lines.slice(0, 2).map((l, i) => (
        <div key={i} className="whitespace-pre-wrap break-words px-1">
          {l || ' '}
        </div>
      ))}
      <button type="button" className="w-full rounded bg-muted px-1 py-0.5 text-left font-sans text-fg-faint hover:text-fg" onClick={() => setOpen(true)}>
        {t('… {n} gleiche Zeilen', { n: lines.length - 4 })}
      </button>
      {lines.slice(-2).map((l, i) => (
        <div key={i} className="whitespace-pre-wrap break-words px-1">
          {l || ' '}
        </div>
      ))}
    </div>
  );
}

function ChangeBlock({ block, taken, onToggle }: { block: Extract<DiffBlock, { kind: 'change' }>; taken: boolean; onToggle: () => void }) {
  const side = (lines: string[], tone: 'old' | 'new', active: boolean) => (
    <div
      className={cx(
        'min-h-5 rounded px-1',
        tone === 'old' ? 'bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]' : 'bg-[color-mix(in_srgb,var(--color-ok,#16a34a)_12%,transparent)]',
        !active && 'opacity-45',
      )}
    >
      {lines.length ? (
        lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {l || ' '}
          </div>
        ))
      ) : (
        <div className="italic text-fg-faint">{t('(nichts)')}</div>
      )}
    </div>
  );
  return (
    <div className="rounded-md border border-line p-1" data-testid="change">
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {side(block.left, 'old', taken)}
        {side(block.right, 'new', !taken)}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 font-sans">
        <Button size="sm" variant={taken ? 'primary' : 'default'} onClick={onToggle} aria-pressed={taken}>
          {taken ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ArrowLeft className="h-3.5 w-3.5" />} {taken ? t('Aus der Sicherung übernommen') : t('Aus der Sicherung übernehmen')}
        </Button>
        {block.left.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void copyWithToast(block.left.join('\n'), 'Text aus der Sicherung')}>
            <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
          </Button>
        )}
      </div>
    </div>
  );
}
