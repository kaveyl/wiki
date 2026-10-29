// Permissions (AD-020): the dialog for one source / folder / note, and Settings → Benutzer & Rechte → Gruppen.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Trash2, Users as UsersIcon } from 'lucide-react';
import { api, errorText, type AccessLevel, type AclRule, type AclTarget, type Group } from '../api';
import { t, tn } from '../i18n';
import { Button, Field, Input, Modal, Spinner, confirmDialog, cx, fillNodes, useModalDirty, FormError, FormStatus } from '../ui';


export const LEVEL_LABELS: Record<AccessLevel, string> = {
  none: t('kein Zugriff'),
  read: t('lesen'),
  write: t('lesen & schreiben'),
  admin: t('verwalten'),
};

function useSubjects() {
  return useQuery({ queryKey: ['acl-subjects'], queryFn: api.aclSubjects, staleTime: 30_000 });
}

function subjectName(rule: AclRule, subjects: ReturnType<typeof useSubjects>['data']): string {
  if (rule.subject === 'all') return t('Alle');
  if (rule.subject === 'group') return t('Gruppe {name}', { name: subjects?.groups.find((g) => g.id === rule.subjectId)?.name ?? '?' });
  return subjects?.users.find((u) => u.id === rule.subjectId)?.name ?? t('Unbekannter Benutzer');
}

const targetLabel = (r: AclRule) => (r.target === 'mount' ? t('Quelle') : r.target === 'folder' ? t('Ordner {path}', { path: r.path }) : t('Notiz {path}', { path: r.path }));

/** Rules on one target, plus what is inherited from above. Only for users with `verwalten` there. */
export function AclDialog({ mountId, target, path, title, onClose }: { mountId: string; target: AclTarget; path: string; title: string; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['acl', mountId, target, path];
  const data = useQuery({ queryKey: key, queryFn: () => api.acl(mountId, target, path) });
  const subjects = useSubjects();
  const [subject, setSubject] = useState('all');
  const [level, setLevel] = useState<AccessLevel>('read');
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: key });
      // The tree and open notes show the effective level: refresh them.
      await qc.invalidateQueries({ queryKey: ['tree', mountId] });
      await qc.invalidateQueries({ queryKey: ['mounts'] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  // Guests never get „verwalten“ (AD-048): not offered, and an older such rule works like „schreiben“.
  const isGuest = (userId: string | null | undefined) => !!subjects.data?.users.find((u) => u.id === userId)?.guest;
  const guestChosen = subject.startsWith('user:') && isGuest(subject.slice(5));
  const chosenLevel: AccessLevel = guestChosen && level === 'admin' ? 'write' : level;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const [kind, id] = subject.split(':') as ['all' | 'group' | 'user', string | undefined];
    void run(() => api.addAclRule(mountId, { target, path, subject: kind, subjectId: id ?? null, level: chosenLevel }));
  };
  const row = (r: AclRule, removable: boolean) => (
    <li key={r.id} className="flex items-center gap-2 py-1.5">
      <span className="flex-1">
        {subjectName(r, subjects.data)}
        {!removable && <span className="ml-2 text-xs text-fg-faint">{t('von {target}', { target: targetLabel(r) })}</span>}
        {r.orphan && <span className="ml-2 text-xs text-warn">{r.path ? t('Ziel fehlt ({path})', { path: r.path }) : t('Notiz gelöscht oder außerhalb umbenannt')}</span>}
      </span>
      <span className={cx('rounded px-1.5 py-0.5 text-xs', r.level === 'none' ? 'bg-danger/10 text-danger' : 'bg-subtle text-fg-muted')}>
        {r.level === 'admin' && r.subject === 'user' && isGuest(r.subjectId) ? t('lesen & schreiben (Gast)') : LEVEL_LABELS[r.level]}
      </span>
      {removable && (
        <button className="rounded p-1 text-fg-faint hover:bg-hover hover:text-danger" aria-label={t('Regel für {name} entfernen', { name: subjectName(r, subjects.data) })} onClick={() => void run(() => api.deleteAclRule(r.id))}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
  return (
    <Modal help="berechtigungen" open onOpenChange={(o) => !o && onClose()} title={t('Berechtigungen: {title}', { title })}>
      <div className="space-y-4 text-sm">
        {data.isPending && <Spinner />}
        {data.data && (
          <>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-faint">{t('Regeln hier')}</h3>
              {data.data.rules.length ? <ul className="divide-y divide-line">{data.data.rules.map((r) => row(r, true))}</ul> : <p className="text-fg-muted">{t('Keine – es gilt, was von oben kommt.')}</p>}
            </section>
            {data.data.inherited.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-faint">{t('Geerbt')}</h3>
                <ul className="divide-y divide-line">{data.data.inherited.map((r) => row(r, false))}</ul>
              </section>
            )}
            {data.data.orphans.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-faint">{t('Regeln ohne Ziel')}</h3>
                <ul className="divide-y divide-line">{data.data.orphans.map((r) => row(r, true))}</ul>
                {data.data.orphans.some((r) => r.folderMissing) && <p className="mt-1 text-xs text-fg-muted">{t('Eine Regel auf einem fehlenden Ordner gilt wieder, sobald es einen Ordner mit diesem Namen gibt – entfernen, wenn sie nicht mehr gebraucht wird.')}</p>}
              </section>
            )}
            <form onSubmit={add} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-xs text-fg-muted">{t('Für')}</span>
                <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label={t('Für')} className="h-8 rounded border border-line bg-bg px-2">
                  <option value="all">{t('Alle')}</option>
                  {subjects.data?.groups.map((g) => (
                    <option key={g.id} value={`group:${g.id}`}>
                      {t('Gruppe {name} ({size})', { name: g.name, size: g.size })}
                    </option>
                  ))}
                  {subjects.data?.users.map((u) => (
                    <option key={u.id} value={`user:${u.id}`}>
                      {u.name} ({u.username})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-fg-muted">{t('Recht')}</span>
                <select value={chosenLevel} onChange={(e) => setLevel(e.target.value as AccessLevel)} aria-label={t('Recht')} className="h-8 rounded border border-line bg-bg px-2">
                  {(Object.keys(LEVEL_LABELS) as AccessLevel[]).map((l) => (
                    <option key={l} value={l} disabled={l === 'admin' && guestChosen}>
                      {LEVEL_LABELS[l]}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm">
                {t('Hinzufügen')}
              </Button>
              {guestChosen && <p className="w-full text-xs text-fg-muted">{t('Gäste können keine Rechte verwalten – höchstens lesen & schreiben.')}</p>}
            </form>
            <p className="text-xs text-fg-faint">
              {t(
                'Die genaueste Regel gilt (Notiz vor Ordner vor Quelle), eine Person vor ihrer Gruppe vor „Alle“. „Kein Zugriff“ für eine Person oder Gruppe gilt immer, auch wenn weiter unten mehr erlaubt ist. Administratoren sehen alles. Wer direkt mit Git arbeitet, ist davon nicht betroffen.',
              )}
            </p>
          </>
        )}
        <FormError>{error}</FormError>
      </div>
    </Modal>
  );
}

/** Settings → Benutzer & Rechte → Gruppen (admins): groups and their members; what they may is under „Rechte“. */
export function GroupsPanel() {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups });
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['groups'] });
      await qc.invalidateQueries({ queryKey: ['acl-subjects'] });
      await qc.invalidateQueries({ queryKey: ['rights'] });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="space-y-5 text-sm">
      <p className="text-fg-muted">
        {fillNodes(t('Hier legst du Gruppen an und bestimmst ihre Mitglieder. Was eine Gruppe darf, stellst du im Reiter „Rechte“ ein oder per Rechtsklick auf eine Quelle, einen Ordner oder eine Notiz → {menu}.'), {
          menu: <b>{t('Berechtigungen …')}</b>,
        })}
      </p>
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 font-medium">
          <UsersIcon className="h-4 w-4" /> {t('Gruppen')}
        </h3>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {groups.data?.map((g) => (
            <li key={g.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <button className="flex-1 text-left font-medium" onClick={() => setOpen(open === g.id ? null : g.id)} aria-expanded={open === g.id}>
                  {g.name} <span className="font-normal text-fg-muted">· {tn(g.members.length, '{n} Mitglied', '{n} Mitglieder')}</span>
                </button>
                <button
                  className="rounded p-1 text-fg-faint hover:bg-hover hover:text-danger"
                  aria-label={t('Gruppe {name} löschen', { name: g.name })}
                  onClick={() =>
                    void confirmDialog(
                      tn(
                        g.members.length,
                        'Gruppe „{name}“ mit {n} Mitglied löschen? Alle Regeln der Gruppe werden entfernt. Das lässt sich nicht rückgängig machen.',
                        'Gruppe „{name}“ mit {n} Mitgliedern löschen? Alle Regeln der Gruppe werden entfernt. Das lässt sich nicht rückgängig machen.',
                        { name: g.name },
                      ),
                      { confirmLabel: t('Löschen'), danger: true },
                    ).then((ok) => ok && void run(() => api.deleteGroup(g.id)))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {open === g.id && (
                <div className="mt-2 grid grid-cols-2 gap-1">
                  {users.data?.map((u) => (
                    <label key={u.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={g.members.includes(u.id)}
                        onChange={(e) => {
                          const members = e.target.checked ? [...g.members, u.id] : g.members.filter((m) => m !== u.id);
                          // Show the tick at once; the server answer replaces it.
                          qc.setQueryData<Group[]>(['groups'], (list) => list?.map((x) => (x.id === g.id ? { ...x, members } : x)));
                          void run(() => api.updateGroup(g.id, { members }));
                        }}
                      />
                      {u.displayName || u.username}
                      {u.isAdmin && <ShieldCheck className="h-3.5 w-3.5 text-fg-faint" aria-label={t('Admin')} />}
                    </label>
                  ))}
                </div>
              )}
            </li>
          ))}
          {groups.data?.length === 0 && <li className="px-3 py-2 text-fg-muted">{t('Noch keine Gruppen.')}</li>}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void run(() => api.createGroup(name)).then(() => setName(''));
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Neue Gruppe …')} aria-label={t('Name der neuen Gruppe')} />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            {t('Anlegen')}
          </Button>
        </form>
      </section>
      <FormError>{error}</FormError>
    </div>
  );
}

/** Settings → Benutzer & Rechte → Cloudflare Access (admins): sign-in via the Access JWT, off by default. */
export function CloudflarePanel() {
  const qc = useQueryClient();
  const cf = useQuery({ queryKey: ['cloudflare'], queryFn: api.cloudflare });
  const [form, setForm] = useState<{ enabled: boolean; teamDomain: string; aud: string } | null>(null);
  const [state, setState] = useState<{ ok?: boolean; error?: string }>({});
  const f = form ?? cf.data;
  useModalDirty(!!form && !!cf.data && (['enabled', 'teamDomain', 'aud'] as const).some((k) => form[k] !== cf.data![k]));
  if (!f) return <Spinner />;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setForm(await api.saveCloudflare(f));
      setState({ ok: true });
      await qc.invalidateQueries({ queryKey: ['cloudflare'] });
    } catch (err) {
      setState({ error: errorText(err) });
    }
  };
  return (
    <form className="space-y-4 text-sm" onSubmit={save}>
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Liegt Kaveyl Wiki hinter einer {app}-Anwendung, meldet sich jeder automatisch an, dessen E-Mail-Adresse im Access-Token (bestätigt vom Anmeldedienst, z. B. Einmal-Code oder Google) zu einem aktiven Benutzer hier passt (Benutzer → E-Mail) – auch Administratoren. Unbekannte Adressen bekommen die normale Anmeldung. Geprüft wird die Signatur des Access-Tokens ({header}), Aussteller, AUD-Tag und Ablaufzeit. „Abmelden“ meldet auch bei Cloudflare Access ab.',
          ),
          { app: <b>{t('Cloudflare-Access')}</b>, header: <code>Cf-Access-Jwt-Assertion</code> },
        )}
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setForm({ ...f, enabled: e.target.checked })} />
        {t('Anmeldung über Cloudflare Access erlauben')}
      </label>
      <Field label={t('Team-Domain')} hint={t('Zero Trust → Settings (Team name and domain), z. B. meinteam.cloudflareaccess.com')}>
        <Input value={f.teamDomain} onChange={(e) => setForm({ ...f, teamDomain: e.target.value })} placeholder={t('meinteam.cloudflareaccess.com')} />
      </Field>
      <Field label="Application Audience (AUD) Tag" hint={t('Zero Trust → Access controls → Applications → Kaveyl Wiki → Configure → Additional settings')}>
        <Input value={f.aud} onChange={(e) => setForm({ ...f, aud: e.target.value })} placeholder={t('64 Zeichen')} />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm">
          {t('Speichern')}
        </Button>
        <FormStatus>{state.ok && t('Gespeichert.')}</FormStatus>
        <FormError>{state.error}</FormError>
      </div>
    </form>
  );
}
