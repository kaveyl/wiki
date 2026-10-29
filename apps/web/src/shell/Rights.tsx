// Settings → Benutzer & Rechte → Rechte (owner 21.10.): who may what as a grid of people and groups × sources, the
// level chosen right in the cell; with many sources one source or one person as a list; and cleaning up.
// A cell is an ordinary rule at the top of a source (AD-020) – the same as under „Berechtigungen …“.
import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, LockOpen, Shield, Trash2 } from 'lucide-react';
import { api, errorText, type AccessLevel, type RightsOverview } from '../api';
import { fmtAgo, t, tn } from '../i18n';
import { useWorkspace } from '../store';
import { Button, Input, Spinner, confirmDialog, cx, FormError, useMediaQuery } from '../ui';
import { LEVEL_LABELS } from './Access';

type Overview = RightsOverview;
type Person = Overview['users'][number];
type Rule = Overview['rules'][number];
type Mount = Overview['mounts'][number];
/** `u:<id>`, `g:<id>` or `all`. */
type Who = string;
type View = { kind: 'grid' } | { kind: 'source'; id: string } | { kind: 'person'; who: Who };
type Filter = 'all' | 'user' | 'guest' | 'group' | 'tidy';

/** Not seen for this long: worth a look when cleaning up. */
const IDLE_DAYS = 90;
const LEVELS: AccessLevel[] = ['none', 'read', 'write', 'admin'];
const DEFAULT_LABELS = { none: t('nichts sehen'), read: t('lesen'), write: t('lesen & schreiben') } as const;
const SELECT = 'h-8 w-full min-w-0 max-w-[12rem] rounded border bg-bg px-1.5';

const subjectOf = (who: Who) =>
  who === 'all' ? { subject: 'all' as const, subjectId: null } : { subject: who.startsWith('g:') ? ('group' as const) : ('user' as const), subjectId: who.slice(2) };
const forWho = (r: Rule, who: Who) => {
  const s = subjectOf(who);
  return r.subject === s.subject && (r.subjectId ?? null) === s.subjectId;
};
/** A rule on the source itself (a cell of the grid); everything further down is an exception. */
const isTop = (r: Rule) => r.target === 'mount' || (r.target === 'folder' && r.path === '');
const topRule = (o: Overview, who: Who, mountId: string) => o.rules.find((r) => r.mountId === mountId && isTop(r) && !r.orphan && forWho(r, who));
const exceptionsOf = (o: Overview, who: Who, mountId?: string) => o.rules.filter((r) => !isTop(r) && forWho(r, who) && (!mountId || r.mountId === mountId));
const groupName = (o: Overview, id?: string) => o.groups.find((g) => g.id === id)?.name ?? '?';
const whoName = (o: Overview, who: Who) =>
  who === 'all' ? t('Alle Benutzer') : who.startsWith('g:') ? t('Gruppe {name}', { name: groupName(o, who.slice(2)) }) : (o.users.find((u) => u.id === who.slice(2))?.name ?? t('Unbekanntes Konto'));
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** Known to have been away this long. Unknown (never signed in, or not since the update that started recording) is not idle. */
function idle(u: { lastSeenAt: string | null }): boolean {
  return !!u.lastSeenAt && Date.now() - Date.parse(u.lastSeenAt) > IDLE_DAYS * 86_400_000;
}

/** What the parts below need: the data, a way to change it, and the navigation. */
interface Ctx {
  o: Overview;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  open: (v: View) => void;
  /** Show a rule's place in the tree (closes the settings). */
  show: (r: Rule) => void;
}

export function RightsPanel({ onShow }: { onShow: () => void }) {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['rights'], queryFn: api.rights });
  const phone = useMediaQuery('(max-width: 640px)');
  const [view, setView] = useState<View>({ kind: 'grid' });
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [qs, setQs] = useState('');
  const [error, setError] = useState<string | null>(null);
  const o = data.data;
  if (!o) return data.isPending ? <Spinner /> : <FormError>{data.error ? errorText(data.error) : null}</FormError>;

  const c: Ctx = {
    o,
    run: async (fn) => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      }
      await Promise.all(['rights', 'acl', 'users', 'groups', 'acl-default', 'acl-subjects'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    },
    open: (v) => setView(v),
    show: (r) => {
      useWorkspace.getState().revealInTree(r.mountId, r.target === 'mount' ? '' : r.path);
      onShow();
    },
  };
  const hit = (name: string) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());
  const mounts = o.mounts.filter((m) => !qs.trim() || m.name.toLowerCase().includes(qs.trim().toLowerCase()));
  const people = o.users.filter((u) => (filter === 'all' || (filter === 'user' ? !u.isGuest : filter === 'guest' && u.isGuest)) && hit(u.name));
  const groups: Who[] = filter === 'all' || filter === 'group' ? ['all', ...o.groups.map((g) => `g:${g.id}`)].filter((w) => hit(whoName(o, w))) : [];
  const tidy = tidyItems(c);
  const counts: Record<Filter, number> = {
    all: o.users.length + o.groups.length + 1,
    user: o.users.filter((u) => !u.isGuest).length,
    guest: o.users.filter((u) => u.isGuest).length,
    group: o.groups.length + 1,
    tidy: tidy.length,
  };
  const FILTERS: [Filter, string][] = [
    ['all', t('Alle')],
    ['user', t('Filter::Benutzer')],
    ['guest', t('Gäste')],
    ['group', t('Gruppen')],
    ['tidy', t('Aufräumen')],
  ];
  const risky = o.defaultLevel !== 'none';

  return (
    <div className="space-y-4 text-sm">
      <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2', risky ? 'border-warn bg-warn/10' : 'border-line bg-subtle')}>
        <label htmlFor="rights-default" className="font-medium">
          {t('Ohne Freigabe dürfen Benutzer:')}
        </label>
        <select
          id="rights-default"
          className="h-8 rounded border border-line-control bg-bg px-2"
          value={o.defaultLevel}
          onChange={(e) => void c.run(() => api.setAclDefault(e.target.value as AccessLevel))}
        >
          {(['none', 'read', 'write'] as const).map((l) => (
            <option key={l} value={l}>
              {DEFAULT_LABELS[l]}
            </option>
          ))}
        </select>
        <p className={cx('basis-full text-xs', risky ? 'text-warn' : 'text-fg-muted')}>
          {risky
            ? t('Jedes Konto außer Gästen darf ohne Freigabe in jeder Quelle {level}, auch jedes neue.', { level: DEFAULT_LABELS[o.defaultLevel as 'read' | 'write'] })
            : t('Neue Konten sehen erst etwas, wenn du ihnen hier, über eine Gruppe oder per E-Mail etwas freigibst. Gäste sehen ohnehin nur, was ausdrücklich für sie freigegeben ist. Administratoren dürfen immer alles.')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Auswahl')}>
          {FILTERS.map(([id, label]) => {
            const on = view.kind === 'grid' && filter === id;
            return (
              <Button
                key={id}
                size="sm"
                variant={on ? 'primary' : 'default'}
                aria-pressed={on}
                className={cx(id === 'tidy' && counts.tidy > 0 && !on && 'border-warn text-warn')}
                onClick={() => {
                  setFilter(id);
                  setView({ kind: 'grid' });
                }}
              >
                {label} <span className="tabular-nums opacity-70">{counts[id]}</span>
              </Button>
            );
          })}
        </div>
        <div className="ml-auto flex w-full flex-wrap gap-1.5 sm:w-auto">
          <Input className="h-8 min-w-0 flex-1 sm:w-40" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Person suchen')} aria-label={t('Person oder Gruppe suchen')} />
          <Input className="h-8 min-w-0 flex-1 sm:w-40" type="search" value={qs} onChange={(e) => setQs(e.target.value)} placeholder={t('Quelle suchen')} aria-label={t('Quelle suchen')} />
        </div>
      </div>

      {view.kind === 'person' ? (
        <PersonView c={c} who={view.who} mounts={mounts} />
      ) : view.kind === 'source' ? (
        <SourceView c={c} mount={o.mounts.find((m) => m.id === view.id)} people={o.users.filter((u) => hit(u.name))} groups={['all', ...o.groups.map((g) => `g:${g.id}`)].filter((w) => hit(whoName(o, w)))} />
      ) : filter === 'tidy' ? (
        <TidyList items={tidy} />
      ) : (
        <>
          {mounts.length < o.mounts.length && (
            <p className="text-xs text-fg-muted">
              {t('{n} von {total} Quellen', { n: mounts.length, total: o.mounts.length })} ·{' '}
              <button type="button" className="text-accent underline" onClick={() => setQs('')}>
                {t('alle zeigen')}
              </button>
            </p>
          )}
          {o.mounts.length === 0 ? (
            <p className="text-fg-muted">{t('Noch keine Quellen eingebunden.')}</p>
          ) : phone ? (
            <Cards c={c} people={people} groups={groups} mounts={mounts} />
          ) : (
            <Grid c={c} people={people} groups={groups} mounts={mounts} />
          )}
        </>
      )}

      <FormError>{error}</FormError>
      <dl className="grid gap-x-5 gap-y-1 text-xs text-fg-muted sm:grid-cols-2">
        {(
          [
            [LEVEL_LABELS.none, t('sieht die Quelle nicht.')],
            [LEVEL_LABELS.read, t('sehen, suchen, die KI fragen.')],
            [LEVEL_LABELS.write, t('auch anlegen, ändern, löschen.')],
            [LEVEL_LABELS.admin, t('zusätzlich hier Rechte vergeben und per E-Mail teilen. Nicht für Gäste.')],
            [t('kursiv, gestrichelt'), t('kommt von einer Gruppe, von „Alle Benutzer“ oder der Grundeinstellung. Wählst du etwas anderes, gilt das nur für diese Person.')],
            [t('gesperrt'), t('diese Person bekommt hier nichts, auch wenn ihre Gruppe etwas darf.')],
          ] as const
        ).map(([term, text]) => (
          <div key={term}>
            <dt className="inline font-medium text-fg">{term}</dt>: <dd className="inline">{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── The grid: people and groups × sources; the name column and the source row stay in place ─────────────────────
function Grid({ c, people, groups, mounts }: { c: Ctx; people: Person[]; groups: Who[]; mounts: Mount[] }) {
  const span = mounts.length + 2;
  return (
    <div className="max-h-[68vh] overflow-auto overscroll-contain rounded-lg border border-line">
      <table className="w-max min-w-full border-collapse text-left" aria-label={t('Rechte')}>
        <thead className="sticky top-0 z-[2] bg-subtle text-xs text-fg-muted">
          <tr>
            <th scope="col" className="sticky left-0 z-[3] w-56 border-r border-line bg-subtle px-2.5 py-2 font-normal">
              {t('Person / Gruppe')}
            </th>
            {mounts.map((m) => (
              <th key={m.id} scope="col" className="w-48 px-2 py-2">
                <button
                  type="button"
                  className="block max-w-[11rem] truncate text-left font-semibold text-fg hover:text-accent hover:underline"
                  title={t('{name}: wer hier was darf', { name: m.name })}
                  onClick={() => c.open({ kind: 'source', id: m.id })}
                >
                  {m.name}
                </button>
              </th>
            ))}
            <th scope="col" className="w-20">
              <span className="sr-only">{t('Aktionen')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {people.length > 0 && <SectionRow span={span} label={t('Personen')} />}
          {people.map((u) => (
            <tr key={u.id} className="border-t border-line">
              <th scope="row" className="sticky left-0 z-[1] border-r border-line bg-bg px-2.5 py-2 text-left font-normal">
                <PersonName c={c} u={u} />
              </th>
              {mounts.map((m) => (
                <td key={m.id} className="px-2 py-2 align-top">
                  <PersonLevel c={c} u={u} mount={m} />
                  <ExceptionsLink c={c} who={`u:${u.id}`} mountId={m.id} />
                </td>
              ))}
              <td className="px-1 py-2 align-top">
                <PersonActions c={c} u={u} />
              </td>
            </tr>
          ))}
          {groups.length > 0 && <SectionRow span={span} label={t('Gruppen')} />}
          {groups.map((who) => (
            <tr key={who} className="border-t border-line">
              <th scope="row" className="sticky left-0 z-[1] border-r border-line bg-bg px-2.5 py-2 text-left font-normal">
                <SubjectName c={c} who={who} />
              </th>
              {mounts.map((m) => (
                <td key={m.id} className="px-2 py-2 align-top">
                  <SubjectLevel c={c} who={who} mount={m} />
                  <ExceptionsLink c={c} who={who} mountId={m.id} />
                </td>
              ))}
              <td className="px-1 py-2 align-top">
                <GroupActions c={c} who={who} />
              </td>
            </tr>
          ))}
          {people.length === 0 && groups.length === 0 && (
            <tr>
              <td colSpan={span} className="px-3 py-3 text-fg-muted">
                {t('Niemand gefunden.')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SectionRow({ span, label }: { span: number; label: string }) {
  return (
    <tr className="border-t border-line bg-subtle">
      <td colSpan={span} className="px-2.5 py-1 text-[0.6875rem] uppercase tracking-wide text-fg-faint">
        <span className="sticky left-2.5">{label}</span>
      </td>
    </tr>
  );
}

// ── Phone: one card per person, only the sources where they may something; the rest one tap away ─────────────────
function Cards({ c, people, groups, mounts }: { c: Ctx; people: Person[]; groups: Who[]; mounts: Mount[] }) {
  const line = (key: string, m: Mount, control: ReactNode) => (
    <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,10rem)] items-start gap-x-3">
      <span className="truncate pt-1.5 text-fg-muted">{m.name}</span>
      {control}
    </div>
  );
  const allLink = (who: Who) => (
    <button type="button" className="text-xs text-accent underline" onClick={() => c.open({ kind: 'person', who })}>
      {t('Alle {n} Quellen', { n: mounts.length })} →
    </button>
  );
  return (
    <div className="space-y-2">
      {people.map((u) => {
        const who = `u:${u.id}`;
        const shown = u.isAdmin ? [] : mounts.filter((m) => u.sources[m.id] !== 'none' || u.why[m.id]?.own || exceptionsOf(c.o, who, m.id).length);
        return (
          <section key={u.id} className="space-y-2 rounded-lg border border-line p-3" aria-label={u.name}>
            <PersonName c={c} u={u} />
            {u.isAdmin ? (
              <p className="text-fg-muted">{t('Administratoren dürfen in allen Quellen alles.')}</p>
            ) : (
              <>
                {shown.length === 0 && <p className="text-fg-muted">{t('Noch keine Freigabe.')}</p>}
                {shown.map((m) =>
                  line(
                    m.id,
                    m,
                    <span>
                      <PersonLevel c={c} u={u} mount={m} />
                      <ExceptionsLink c={c} who={who} mountId={m.id} />
                    </span>,
                  ),
                )}
                <div className="flex items-center justify-between gap-2">
                  {allLink(who)}
                  <PersonActions c={c} u={u} />
                </div>
              </>
            )}
          </section>
        );
      })}
      {groups.map((who) => {
        const shown = mounts.filter((m) => topRule(c.o, who, m.id) || exceptionsOf(c.o, who, m.id).length);
        return (
          <section key={who} className="space-y-2 rounded-lg border border-line p-3" aria-label={whoName(c.o, who)}>
            <SubjectName c={c} who={who} />
            {shown.length === 0 && <p className="text-fg-muted">{t('Noch keine Freigabe.')}</p>}
            {shown.map((m) => line(m.id, m, <SubjectLevel c={c} who={who} mount={m} />))}
            <div className="flex items-center justify-between gap-2">
              {allLink(who)}
              <GroupActions c={c} who={who} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── One person (or group): every source below each other, the exceptions right under their source ────────────────
function PersonView({ c, who, mounts }: { c: Ctx; who: Who; mounts: Mount[] }) {
  const u = who.startsWith('u:') ? c.o.users.find((x) => x.id === who.slice(2)) : undefined;
  const back = <BackButton c={c} label={t('Alle Personen')} />;
  if (who.startsWith('u:') && !u) return back;
  const has = (m: Mount) => (u ? u.sources[m.id] !== 'none' || !!u.why[m.id]?.own : !!topRule(c.o, who, m.id)) || exceptionsOf(c.o, who, m.id).length > 0;
  const withAccess = mounts.filter(has);
  const without = mounts.filter((m) => !has(m));
  const rows = (list: Mount[]) =>
    list.map((m) => (
      <li key={m.id} className="space-y-1 px-3 py-2">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)] items-start gap-x-3">
          <span className="truncate pt-1.5 font-medium">{m.name}</span>
          {u ? <PersonLevel c={c} u={u} mount={m} /> : <SubjectLevel c={c} who={who} mount={m} />}
        </div>
        {exceptionsOf(c.o, who, m.id).map((r) => (
          <ExceptionRow key={r.id} c={c} r={r} guest={!!u?.isGuest} />
        ))}
      </li>
    ));
  return (
    <div className="space-y-3">
      {back}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {u ? <PersonName c={c} u={u} big /> : <SubjectName c={c} who={who} big />}
        <span className="ml-auto">{u ? <PersonActions c={c} u={u} /> : <GroupActions c={c} who={who} />}</span>
      </div>
      {u?.isAdmin ? (
        <p className="text-fg-muted">{t('Administratoren dürfen in allen Quellen alles – Freigaben brauchen sie nicht.')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Quellen von {name}', { name: whoName(c.o, who) })}>
          {withAccess.length > 0 && <ListSection label={t('Mit Zugriff ({n})', { n: withAccess.length })} />}
          {rows(withAccess)}
          {without.length > 0 && <ListSection label={t('Ohne Zugriff ({n})', { n: without.length })} />}
          {rows(without)}
          {mounts.length === 0 && <li className="px-3 py-2 text-fg-muted">{t('Keine Quelle gefunden.')}</li>}
        </ul>
      )}
    </div>
  );
}

// ── One source: everyone below each other ────────────────────────────────────────────────────────────────────────────
function SourceView({ c, mount, people, groups }: { c: Ctx; mount?: Mount; people: Person[]; groups: Who[] }) {
  const back = <BackButton c={c} label={t('Alle Quellen')} />;
  if (!mount) return back;
  const row = (key: string, name: ReactNode, control: ReactNode, who: Who) => (
    <li key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)] items-start gap-x-3 px-3 py-2">
      <span className="min-w-0">
        {name}
        <ExceptionsLink c={c} who={who} mountId={mount.id} />
      </span>
      {control}
    </li>
  );
  const nameButton = (who: Who, label: string, extra?: ReactNode) => (
    <span className="flex flex-wrap items-center gap-1.5 pt-1">
      <button type="button" className="truncate font-medium hover:text-accent hover:underline" onClick={() => c.open({ kind: 'person', who })}>
        {label}
      </button>
      {extra}
    </span>
  );
  return (
    <div className="space-y-3">
      {back}
      <div>
        <h3 className="text-base font-semibold">{mount.name}</h3>
        <p className="text-xs text-fg-muted">{t('Wer hier was darf – dasselbe wie Rechtsklick auf die Quelle → „Berechtigungen …“.')}</p>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Rechte in {name}', { name: mount.name })}>
        <ListSection label={t('Personen')} />
        {people.map((u) => row(u.id, nameButton(`u:${u.id}`, u.name, <Badges u={u} />), <PersonLevel c={c} u={u} mount={mount} />, `u:${u.id}`))}
        <ListSection label={t('Gruppen')} />
        {groups.map((who) => row(who, nameButton(who, who === 'all' ? t('Alle Benutzer') : groupName(c.o, who.slice(2))), <SubjectLevel c={c} who={who} mount={mount} />, who))}
      </ul>
    </div>
  );
}

function BackButton({ c, label }: { c: Ctx; label: string }) {
  return (
    <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => c.open({ kind: 'grid' })}>
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

function ListSection({ label }: { label: string }) {
  return <li className="bg-subtle px-3 py-1 text-[0.6875rem] uppercase tracking-wide text-fg-faint">{label}</li>;
}

// ── Names, badges, actions ───────────────────────────────────────────────────────────────────────────────────────
function Badges({ u }: { u: Person }) {
  return (
    <>
      {u.isAdmin && <Shield className="h-3.5 w-3.5 text-accent" aria-label={t('Administrator')} />}
      {u.isGuest && <span className="rounded bg-accent-soft px-1 text-[0.625rem] text-accent">{t('Gast')}</span>}
      {
        /* a badge beside the name, not a message */ u.disabled && (
          <span className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-[0.625rem] text-danger">
            <Lock className="h-2.5 w-2.5" aria-hidden="true" />
            {t('Konto gesperrt')}
          </span>
        )
      }
    </>
  );
}

function Avatar({ text, group }: { text: string; group?: boolean }) {
  return (
    <span aria-hidden="true" className={cx('grid h-7 w-7 flex-none place-items-center bg-muted text-[0.6875rem] font-semibold text-fg-muted', group ? 'rounded-md' : 'rounded-full')}>
      {text}
    </span>
  );
}

function PersonName({ c, u, big }: { c: Ctx; u: Person; big?: boolean }) {
  const groups = c.o.groups.filter((g) => u.groups.includes(g.id)).map((g) => g.name);
  const sub = [u.lastSeenAt ? t('zuletzt aktiv: {when}', { when: fmtAgo(u.lastSeenAt) }) : t('noch nie angemeldet'), groups.length ? t('Gruppe {names}', { names: groups.join(', ') }) : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={cx('flex min-w-0 items-center gap-2', u.disabled && 'opacity-70')}>
      <Avatar text={initials(u.name)} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          {big ? (
            <span className="text-base font-semibold">{u.name}</span>
          ) : (
            <button type="button" className="truncate font-medium hover:text-accent hover:underline" title={t('Alle Quellen von {name}', { name: u.name })} onClick={() => c.open({ kind: 'person', who: `u:${u.id}` })}>
              {u.name}
            </button>
          )}
          <Badges u={u} />
        </span>
        <span className="block max-w-[13rem] truncate text-xs text-fg-faint sm:max-w-none" title={sub}>
          {big && u.email ? `${u.email} · ` : ''}
          {sub}
        </span>
      </span>
    </span>
  );
}

function SubjectName({ c, who, big }: { c: Ctx; who: Who; big?: boolean }) {
  const g = who === 'all' ? null : c.o.groups.find((x) => x.id === who.slice(2));
  const name = g ? g.name : t('Alle Benutzer');
  const sub = g ? (g.members.length ? c.o.users.filter((u) => g.members.includes(u.id)).map((u) => u.name).join(', ') : t('keine Mitglieder')) : t('jedes Konto außer Gästen');
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar text={g ? initials(g.name) : '∗'} group />
      <span className="min-w-0">
        {big ? (
          <span className="block text-base font-semibold">{name}</span>
        ) : (
          <button type="button" className="block truncate font-medium hover:text-accent hover:underline" title={t('Alle Quellen von {name}', { name })} onClick={() => c.open({ kind: 'person', who })}>
            {name}
          </button>
        )}
        <span className="block max-w-[13rem] truncate text-xs text-fg-faint sm:max-w-none" title={sub}>
          {sub}
        </span>
      </span>
    </span>
  );
}

function PersonActions({ c, u }: { c: Ctx; u: Person }) {
  if (u.isAdmin) return null;
  return (
    <span className="flex justify-end gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        aria-label={u.disabled ? t('{name} entsperren', { name: u.name }) : t('{name} sperren', { name: u.name })}
        title={u.disabled ? t('Gesperrt – klicken zum Entsperren') : t('Aktiv – klicken zum Sperren')}
        onClick={() => void c.run(() => api.updateUser(u.id, { disabled: !u.disabled }))}
      >
        {/* The state, not the action: closed and red = locked, open and green = can sign in. */}
        {u.disabled ? <Lock className="h-3.5 w-3.5 text-danger" /> : <LockOpen className="h-3.5 w-3.5 text-ok" />}
      </Button>
      <Button size="sm" variant="ghost" aria-label={t('{name} löschen', { name: u.name })} title={t('Konto löschen')} onClick={() => void deleteAccount(c, u)}>
        <Trash2 className="h-3.5 w-3.5 text-danger" />
      </Button>
    </span>
  );
}

function GroupActions({ c, who }: { c: Ctx; who: Who }) {
  const g = who === 'all' ? null : c.o.groups.find((x) => x.id === who.slice(2));
  if (!g) return null;
  return (
    <span className="flex justify-end">
      <Button size="sm" variant="ghost" aria-label={t('Gruppe {name} löschen', { name: g.name })} title={t('Gruppe löschen')} onClick={() => void deleteGroup(c, g)}>
        <Trash2 className="h-3.5 w-3.5 text-danger" />
      </Button>
    </span>
  );
}

async function deleteAccount(c: Ctx, u: Person) {
  const ok = await confirmDialog(t('Konto {name} endgültig löschen? Seine Rechte-Regeln gehen mit, im Protokoll wird der Name entfernt. Notizen und Git-Historie bleiben.', { name: u.name }), {
    confirmLabel: t('Löschen'),
    danger: true,
  });
  if (ok) await c.run(() => api.deleteUser(u.id));
}

async function deleteGroup(c: Ctx, g: Overview['groups'][number]) {
  const ok = await confirmDialog(
    tn(
      g.members.length,
      'Gruppe „{name}“ mit {n} Mitglied löschen? Alle Regeln der Gruppe werden entfernt. Das lässt sich nicht rückgängig machen.',
      'Gruppe „{name}“ mit {n} Mitgliedern löschen? Alle Regeln der Gruppe werden entfernt. Das lässt sich nicht rückgängig machen.',
      { name: g.name },
    ),
    { confirmLabel: t('Löschen'), danger: true },
  );
  if (ok) await c.run(() => api.deleteGroup(g.id));
}

// ── The cells ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A person at the top of a source. Shows what applies; without an own rule in italics with where it comes from.
 * Choosing what would apply anyway removes the own rule – so „kein Zugriff“ without anything above is no rule at
 * all, and against a group it becomes a lock.
 */
function PersonLevel({ c, u, mount }: { c: Ctx; u: Person; mount: Mount }) {
  if (u.isAdmin) return <span className="block pt-1.5 text-fg-muted">{t('alles (Admin)')}</span>;
  const w = u.why[mount.id] ?? { own: null, inherited: 'none' as const, via: null };
  const level = u.sources[mount.id] ?? 'none';
  const ownLock = w.own === 'none' && w.inherited !== 'none';
  const from = w.via === 'group' ? t('Gruppe {name}', { name: groupName(c.o, w.viaId) }) : w.via === 'all' ? t('„Alle Benutzer“') : t('die Grundeinstellung');
  const origin = w.groupLock
    ? t('gesperrt über {from}', { from })
    : ownLock
      ? t('gesperrt – {from} hätte „{level}“', { from, level: LEVEL_LABELS[w.inherited] })
      : !w.own && w.inherited !== 'none'
        ? w.via === 'default'
          ? t('Grundeinstellung')
          : t('über {from}', { from })
        : '';
  const red = w.groupLock || ownLock;
  const set = (v: AccessLevel) =>
    c.run(async () => {
      const own = topRule(c.o, `u:${u.id}`, mount.id);
      if (v === w.inherited) {
        if (own) await api.deleteAclRule(own.id);
      } else await api.addAclRule(mount.id, { target: 'mount', path: '', subject: 'user', subjectId: u.id, level: v });
    });
  return (
    <span className="grid min-w-0 gap-0.5">
      <select
        aria-label={t('{name} in {source}', { name: u.name, source: mount.name })}
        value={level}
        disabled={w.groupLock}
        onChange={(e) => void set(e.target.value as AccessLevel)}
        className={cx(
          SELECT,
          red ? 'border-danger text-danger' : w.own ? 'border-line-control' : 'border-dashed border-line-control italic text-fg-muted',
          !red && level === 'none' && 'text-fg-faint',
        )}
      >
        {LEVELS.filter((l) => !(u.isGuest && l === 'admin')).map((l) => (
          <option key={l} value={l}>
            {l === 'none' && w.inherited !== 'none' ? t('gesperrt') : LEVEL_LABELS[l]}
          </option>
        ))}
      </select>
      {origin && (
        // where the level comes from, not a message
        <span className={cx('text-xs', red ? 'text-danger' : 'text-fg-faint')}>{origin}</span>
      )}
    </span>
  );
}

/** A group (or „Alle Benutzer“) at the top of a source: its rule there, or none. */
function SubjectLevel({ c, who, mount }: { c: Ctx; who: Who; mount: Mount }) {
  const r = topRule(c.o, who, mount.id);
  const all = who === 'all';
  const set = (v: string) =>
    c.run(async () => {
      if (v === '') {
        if (r) await api.deleteAclRule(r.id);
      } else await api.addAclRule(mount.id, { target: 'mount', path: '', ...subjectOf(who), level: v as AccessLevel });
    });
  return (
    <select
      aria-label={t('{name} in {source}', { name: whoName(c.o, who), source: mount.name })}
      value={r?.level ?? ''}
      onChange={(e) => void set(e.target.value)}
      className={cx(SELECT, !r ? 'border-dashed border-line-control italic text-fg-faint' : r.level === 'none' && !all ? 'border-danger text-danger' : 'border-line-control')}
    >
      <option value="">{all ? t('– Grundeinstellung') : t('– keine Freigabe')}</option>
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {l === 'none' && !all ? t('gesperrt') : LEVEL_LABELS[l]}
        </option>
      ))}
    </select>
  );
}

function ExceptionsLink({ c, who, mountId }: { c: Ctx; who: Who; mountId: string }) {
  const n = exceptionsOf(c.o, who, mountId).length;
  if (!n) return null;
  return (
    <button type="button" className="mt-0.5 block text-xs text-accent underline decoration-dotted underline-offset-2" onClick={() => c.open({ kind: 'person', who })}>
      {tn(n, '+{n} Ausnahme', '+{n} Ausnahmen')}
    </button>
  );
}

/** A rule on a folder or a note further down. */
function ExceptionRow({ c, r, guest }: { c: Ctx; r: Rule; guest: boolean }) {
  const kind = r.target === 'note' ? t('Notiz') : t('Ordner');
  const where = r.path || t('(unbekannt)');
  const remove = async () => {
    const ok = await confirmDialog(t('Freigabe entfernen? {who} verliert „{level}“ auf {where}.', { who: whoName(c.o, r.subject === 'all' ? 'all' : `${r.subject === 'group' ? 'g' : 'u'}:${r.subjectId}`), level: LEVEL_LABELS[r.level], where }), {
      confirmLabel: t('Entfernen'),
      danger: true,
    });
    if (ok) await c.run(() => api.deleteAclRule(r.id));
  };
  return (
    <div className="ml-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-line pl-3">
      <span className="min-w-0 flex-1 basis-48">
        {r.orphan ? (
          <span className="text-fg-muted">{where}</span>
        ) : (
          <button type="button" className="text-left hover:text-accent hover:underline" title={t('Im Baum anzeigen')} onClick={() => c.show(r)}>
            {where}
          </button>
        )}{' '}
        <span className="text-xs text-fg-faint">· {kind}</span>
        {r.orphan && <span className="ml-1.5 rounded bg-warn/10 px-1 text-[0.625rem] text-warn">{t('gibt es nicht mehr')}</span>}
      </span>
      <select
        aria-label={t('Recht auf {where}', { where })}
        value={r.level}
        disabled={r.orphan}
        onChange={(e) => void c.run(() => api.addAclRule(r.mountId, { target: r.target, path: r.path, subject: r.subject, subjectId: r.subjectId, level: e.target.value as AccessLevel }))}
        className={cx(SELECT, 'w-auto', r.level === 'none' && r.subject !== 'all' ? 'border-danger text-danger' : 'border-line-control')}
      >
        {LEVELS.filter((l) => !(guest && l === 'admin')).map((l) => (
          <option key={l} value={l}>
            {l === 'none' && r.subject !== 'all' ? t('gesperrt') : LEVEL_LABELS[l]}
          </option>
        ))}
      </select>
      <Button size="sm" variant="ghost" aria-label={t('Freigabe entfernen: {where}', { where })} title={t('Freigabe entfernen')} onClick={() => void remove()}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── Cleaning up: what can probably go, each with the button that does it ───────────────────────────────────────────
interface TidyItem {
  key: string;
  title: string;
  text: string;
  actions: { label: string; danger?: boolean; run: () => Promise<unknown> }[];
}

function tidyItems(c: Ctx): TidyItem[] {
  const { o } = c;
  const out: TidyItem[] = [];
  for (const u of o.users) {
    if (u.isAdmin) continue;
    const n = o.rules.filter((r) => forWho(r, `u:${u.id}`)).length;
    const del = { label: t('Konto löschen'), danger: true, run: () => deleteAccount(c, u) };
    if (u.disabled) out.push({ key: `off-${u.id}`, title: u.name, text: tn(n, 'Konto gesperrt, hat noch {n} Freigabe.', 'Konto gesperrt, hat noch {n} Freigaben.'), actions: [del] });
    else if (idle(u))
      out.push({
        key: `idle-${u.id}`,
        title: u.name,
        text: t('Zuletzt aktiv {when} – seit über {days} Tagen nicht mehr.', { when: fmtAgo(u.lastSeenAt!), days: IDLE_DAYS }),
        actions: [{ label: t('Sperren'), run: () => c.run(() => api.updateUser(u.id, { disabled: true })) }, del],
      });
    else if (!u.lastSeenAt)
      out.push({ key: `seen-${u.id}`, title: u.name, text: t('Hat sich noch nie angemeldet.'), actions: [del] });
  }
  for (const r of o.rules) {
    const lost = r.subject === 'user' && !o.users.some((u) => u.id === r.subjectId);
    if (!r.orphan && !lost) continue;
    const mount = o.mounts.find((m) => m.id === r.mountId)?.name ?? '?';
    const where = r.target === 'mount' ? mount : `${mount} / ${r.path || t('(unbekannt)')}`;
    out.push({
      key: `rule-${r.id}`,
      title: lost ? t('Gelöschtes Konto') : whoName(o, r.subject === 'all' ? 'all' : `${r.subject === 'group' ? 'g' : 'u'}:${r.subjectId}`),
      text: lost ? t('Freigabe auf {where} für ein Konto, das es nicht mehr gibt.', { where }) : t('Freigabe auf {where} – das Ziel gibt es nicht mehr.', { where }),
      actions: [{ label: t('Freigabe entfernen'), run: () => c.run(() => api.deleteAclRule(r.id)) }],
    });
  }
  for (const g of o.groups.filter((x) => x.members.length === 0))
    out.push({ key: `grp-${g.id}`, title: t('Gruppe {name}', { name: g.name }), text: t('Hat keine Mitglieder.'), actions: [{ label: t('Gruppe löschen'), danger: true, run: () => deleteGroup(c, g) }] });
  return out;
}

function TidyList({ items }: { items: TidyItem[] }) {
  if (!items.length) return <p className="rounded-lg border border-line px-3 py-3 text-fg-muted">{t('Nichts aufzuräumen.')}</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">{t('Hier sammelt die App, was vermutlich weg kann. Gelöscht wird nichts von selbst – du entscheidest je Zeile.')}</p>
      <ul className="space-y-2" aria-label={t('Aufräumen')}>
        {items.map((it) => (
          <li key={it.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line px-3 py-2">
            <span className="min-w-0 flex-1 basis-64">
              <span className="block font-medium">{it.title}</span>
              <span className="block text-xs text-fg-muted">{it.text}</span>
            </span>
            <span className="flex flex-wrap gap-1.5">
              {it.actions.map((a) => (
                <Button key={a.label} size="sm" variant={a.danger ? 'danger' : 'default'} onClick={() => void a.run()}>
                  {a.label}
                </Button>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
