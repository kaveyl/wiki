// Settings → Werkzeuge → Prüfung: the consistency report (index vs. disk vs. git, links, ids).
// Read-only — it shows problems, it does not fix them. SEE-DOC: docs/PLAN.md §2.8
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, ShieldCheck } from 'lucide-react';
import { api, type FsckIssue } from '../api';
import { useWorkspace } from '../store';
import { Button, Spinner, cx } from '../ui';
import { fmtDateTime, t, tn } from '../i18n';

const LABELS: Record<FsckIssue['kind'], string> = {
  'broken-link': t('Gebrochener Link'),
  'orphaned-attachment': t('Verwaister Anhang'),
  'plain-in-encrypted': t('Unverschlüsselt im verschlüsselten Ordner'),
  'duplicate-id': t('Doppelte ID'),
  'not-indexed': t('Fehlt im Index'),
  'orphaned-index': t('Verwaister Index-Eintrag'),
  'git-in-progress': t('Hängende Git-Operation'),
  'conflict-ref': t('Alte Konflikt-Sicherung'),
  error: t('Fehler'),
};
const COUNT: Record<FsckIssue['kind'], (n: number) => string> = {
  'broken-link': (n) => tn(n, '{n} Gebrochener Link', '{n} Gebrochene Links'),
  'orphaned-attachment': (n) => tn(n, '{n} Verwaister Anhang', '{n} Verwaiste Anhänge'),
  'plain-in-encrypted': (n) => tn(n, '{n} Unverschlüsselt im verschlüsselten Ordner', '{n} Unverschlüsselt im verschlüsselten Ordner'),
  'duplicate-id': (n) => tn(n, '{n} Doppelte ID', '{n} Doppelte IDs'),
  'not-indexed': (n) => tn(n, '{n} Fehlt im Index', '{n} Fehlen im Index'),
  'orphaned-index': (n) => tn(n, '{n} Verwaister Index-Eintrag', '{n} Verwaiste Index-Einträge'),
  'git-in-progress': (n) => tn(n, '{n} Hängende Git-Operation', '{n} Hängende Git-Operationen'),
  'conflict-ref': (n) => tn(n, '{n} Alte Konflikt-Sicherung', '{n} Alte Konflikt-Sicherungen'),
  // German has one form for both; a key of its own for the singular.
  error: (n) => (n === 1 ? t('1 Fehler') : t('{n} Fehler', { n })),
};

/** „2 Gebrochene Links · 1 Doppelte ID“ */
function summary(issues: FsckIssue[]): string {
  const counts = new Map<FsckIssue['kind'], number>();
  for (const i of issues) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => COUNT[k](n)).join(' · ');
}

export function FsckPanel({ onOpenNote }: { onOpenNote: () => void }) {
  const qc = useQueryClient();
  const openNote = useWorkspace((s) => s.openNote);
  const report = useQuery({ queryKey: ['fsck'], queryFn: api.fsckReport });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const run = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['fsck'], await api.runFsck());
    } finally {
      setBusy(false);
    }
  };
  const total = report.data?.mounts.reduce((n, m) => n + m.issues.length, 0) ?? 0;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg-muted">
        {t(
          'Gleicht Index, Dateien und Git ab: gebrochene Links, doppelte IDs, fehlende oder verwaiste Index-Einträge, hängende Rebases. Die Prüfung ändert nichts – sie läuft zusätzlich jede Nacht um 3 Uhr. Es gibt immer nur den letzten Bericht; das Protokoll vermerkt jede Prüfung.',
        )}
      </p>
      <div className="flex items-center gap-3">
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />} {t('Jetzt prüfen')}
        </Button>
        {report.data && <span className="text-xs text-fg-faint">{t('Letzte Prüfung: {when}', { when: fmtDateTime(report.data.checkedAt) })}</span>}
      </div>
      {report.data && total === 0 && (
        <p className="flex items-center gap-2 text-ok">
          <CheckCircle2 className="h-4 w-4" /> {t('Keine Probleme gefunden.')}
        </p>
      )}
      {/* One folded row per source with its count — the list only on demand (owner 2026-10-11). */}
      {report.data && total > 0 && (
        <div className="divide-y divide-line rounded-lg border border-line">
          {report.data.mounts.map((m) => {
            const isOpen = open.has(m.mountId);
            return (
              <section key={m.mountId} aria-label={t('Prüfbericht {name}', { name: m.name })}>
                <button
                  className={cx('flex w-full items-center gap-2 px-3 py-2 text-left', m.issues.length ? 'hover:bg-hover' : 'cursor-default')}
                  aria-expanded={m.issues.length ? isOpen : undefined}
                  disabled={!m.issues.length}
                  onClick={() => setOpen((o) => (o.has(m.mountId) ? new Set([...o].filter((x) => x !== m.mountId)) : new Set([...o, m.mountId])))}
                >
                  <ChevronRight className={cx('h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform', isOpen && 'rotate-90', !m.issues.length && 'invisible')} />
                  <span className="font-medium">{m.name}</span>
                  <span className={cx('ml-auto text-xs', m.issues.length ? 'text-warn' : 'text-ok')}>{m.issues.length ? summary(m.issues) : t('keine Auffälligkeiten')}</span>
                </button>
                {isOpen && (
                  <ul className="divide-y divide-line border-t border-line bg-subtle/40">
                    {m.issues.map((i, n) => (
                      <li key={n} className="py-1.5 pl-8 pr-3">
                        <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-fg-muted">{LABELS[i.kind]}</span>
                        {i.path && /\.md$/i.test(i.path) && i.kind !== 'orphaned-index' ? (
                          <button
                            className="text-accent hover:underline"
                            onClick={() => {
                              openNote(m.mountId, i.path, i.path.split('/').pop()!.replace(/\.md$/i, ''));
                              onOpenNote();
                            }}
                          >
                            {i.path}
                          </button>
                        ) : (
                          <span>{i.path}</span>
                        )}
                        <span className="block text-xs text-fg-muted">{i.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
