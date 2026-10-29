// Settings → Benutzer & Rechte → Benutzer (admins) and Settings → Konto → API-Tokens (everyone). Phase 4, docs/PLAN.md §3.
import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Fingerprint, History, KeyRound, Lock, LockOpen, Pencil, RefreshCw, Shield, Trash2, UserPlus } from 'lucide-react';
import { passwordProblems, PROXY_LABEL } from '@kaveyl-wiki/core';
import { PasswordRules } from '../auth/AuthPages';
import { UserActivityDialog } from './Activity';
import { api, errorText, type TokenInfo, type TokenScope, type User } from '../api';
import { Button, Field, Input, Modal, Spinner, cx, confirmDialog, fillNodes, FormError, FormStatus } from '../ui';
import { copyWithToast } from '../clipboard';
import { openHelp } from '../help/help';
import { fmtAgo, fmtDate, t } from '../i18n';

const date = (iso: string | null) => (iso ? fmtDate(iso) : '–');

type Role = 'user' | 'admin' | 'guest';
const roleOf = (u: User): Role => (u.isAdmin ? 'admin' : u.isGuest ? 'guest' : 'user');
const ROLE_LABEL: Record<Role, string> = { user: t('Rolle::Benutzer'), admin: t('Administrator'), guest: t('Gast') };
const roleFlags = (r: Role) => ({ isAdmin: r === 'admin', isGuest: r === 'guest' });
type Filter = 'all' | Role | 'locked';
const FILTERS: { id: Filter; label: string; match: (u: User) => boolean }[] = [
  { id: 'all', label: t('Alle'), match: () => true },
  { id: 'admin', label: t('Admins'), match: (u) => u.isAdmin },
  { id: 'user', label: t('Filter::Benutzer'), match: (u) => roleOf(u) === 'user' },
  { id: 'guest', label: t('Gäste'), match: (u) => !!u.isGuest },
  { id: 'locked', label: t('Gesperrt'), match: (u) => !!u.disabled },
];

export function UsersPanel({ me }: { me: User }) {
  const qc = useQueryClient();
  // Accounts also appear from outside (accepted invitations): always fresh when the tab opens.
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, refetchOnMount: 'always' });
  const mail = useQuery({ queryKey: ['session'], queryFn: api.session }).data?.mail ?? false;
  const level = useQuery({ queryKey: ['acl-default'], queryFn: api.aclDefault }).data?.level;
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<User | null>(null);
  const [edit, setEdit] = useState<User | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  /** The form for a new account opens at the top – with many accounts nobody scrolls down for it (owner 21.10.). */
  const [adding, setAdding] = useState(false);
  // The server sends admins first, then users, then guests, each in the order they were created.
  const shown = users.data?.filter(FILTERS.find((f) => f.id === filter)!.match) ?? [];
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['users'] });
      if (done) setNote(done);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Angemeldet wird mit der E-Mail-Adresse; Änderungen erscheinen in Git mit dem Namen als Autor, ohne E-Mail-Adresse. {gaeste} sehen nur, was ihnen ausdrücklich freigegeben ist (z. B. eine per E-Mail geteilte Notiz). Gesperrte Konten können sich nicht anmelden, ihre Tokens werden ungültig. Was jemand sehen und ändern darf, stellst du im Reiter „Rechte“ ein (oder per Rechtsklick → „Berechtigungen …“).',
          ),
          { gaeste: <strong className="font-medium text-fg">{t('Gäste')}</strong> },
        )}
      </p>
      {level === 'none' && (
        <p className="rounded border border-line bg-subtle px-3 py-2 text-fg-muted" role="note">
          {fillNodes(t('Ohne Freigabe sehen Benutzer nichts. Freigeben im Reiter „Rechte“ oder per Rechtsklick auf Quelle oder Ordner → {menu}.'), {
            menu: <b>{t('Berechtigungen …')}</b>,
          })}
        </p>
      )}
      {adding ? (
        <NewUserForm
          mail={mail}
          onCancel={() => setAdding(false)}
          onDone={(text) => {
            setAdding(false);
            void act(async () => undefined, text);
          }}
        />
      ) : (
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
          <UserPlus className="h-3.5 w-3.5" /> {t('Neuer Benutzer')}
        </Button>
      )}
      <FormError>{error}</FormError>
      <FormStatus ok className="block">
        {note}
      </FormStatus>
      {users.isPending && <Spinner />}
      {logFor && <UserActivityDialog userId={logFor.id} name={`${logFor.displayName} (@${logFor.username})`} onClose={() => setLogFor(null)} />}
      {edit && <EditUserDialog user={edit} isMe={edit.id === me.id} mail={mail} onClose={() => setEdit(null)} onDone={(text) => void act(async () => undefined, text)} />}
      {(users.data?.length ?? 0) > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Benutzer filtern')}>
          {FILTERS.map((f) => {
            const n = users.data!.filter(f.match).length;
            if (f.id !== 'all' && f.id !== filter && n === 0) return null;
            return (
              <Button key={f.id} size="sm" variant={filter === f.id ? 'primary' : 'default'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} <span className="tabular-nums opacity-70">{n}</span>
              </Button>
            );
          })}
        </div>
      )}
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Benutzer')}>
        {users.data && shown.length === 0 && <li className="px-3 py-2 text-fg-muted">{t('Keine Konten in dieser Auswahl.')}</li>}
        {shown.map((u) => (
          <li key={u.id} className={cx('flex flex-wrap items-center gap-2 px-3 py-2', u.disabled && 'opacity-60')}>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 font-medium">
                {u.displayName} <span className="font-normal text-fg-faint">@{u.username}</span>
                {u.isAdmin && <Shield className="h-3.5 w-3.5 text-accent" aria-label={t('Administrator')} />}
                {u.isGuest && <span className="rounded bg-accent-soft px-1 text-[0.625rem] text-accent">{t('Gast')}</span>}
                {u.disabled && (
                  // a badge beside the name, not a message
                  <span className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 text-[0.625rem] text-danger">
                    <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                    {t('gesperrt')}
                  </span>
                )}
                {u.mustChangePassword && <span className="rounded bg-muted px-1 text-[0.625rem] text-fg-muted">{t('muss Passwort ändern')}</span>}
              </span>
              <span className="block truncate text-xs text-fg-faint">
                {u.email}
                {' · '}
                {u.lastSeenAt ? t('zuletzt aktiv: {when}', { when: fmtAgo(u.lastSeenAt) }) : t('noch nie angemeldet')}
              </span>
            </span>
            {/* The fixed id, e.g. for an agent's list of who may release actions (owner 28.10.) – names can change. */}
            <Button size="sm" variant="ghost" aria-label={t('Konto-ID von {name} kopieren', { name: u.username })} title={t('Konto-ID kopieren: {id}', { id: u.id })} onClick={() => void copyWithToast(u.id, 'Konto-ID')}>
              <Fingerprint className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" aria-label={t('Protokoll von {name}', { name: u.username })} title={t('Protokoll: was diese Person getan hat')} onClick={() => setLogFor(u)}>
              <History className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" aria-label={t('{name} bearbeiten', { name: u.username })} title={t('Name, E-Mail, Rolle, Passwort')} onClick={() => setEdit(u)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            {u.id !== me.id && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={u.disabled ? t('{name} entsperren', { name: u.username }) : t('{name} sperren', { name: u.username })}
                  title={u.disabled ? t('Gesperrt – klicken zum Entsperren') : t('Aktiv – klicken zum Sperren')}
                  onClick={() => void act(() => api.updateUser(u.id, { disabled: !u.disabled }))}
                >
                  {/* The state, not the action: closed and red = locked, open and green = can sign in. */}
                  {u.disabled ? <Lock className="h-3.5 w-3.5 text-danger" /> : <LockOpen className="h-3.5 w-3.5 text-ok" />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('{name} löschen', { name: u.username })}
                  onClick={() =>
                    void confirmDialog(t('Konto {name} endgültig löschen? Seine Rechte-Regeln gehen mit, im Protokoll wird der Name entfernt. Notizen und Git-Historie bleiben.', { name: u.username }), {
                      confirmLabel: t('Löschen'),
                      danger: true,
                    }).then((ok) => ok && void act(() => api.deleteUser(u.id)))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Unticked for accounts of agents or when the person may keep the password (owner 28.10.). */
function MustChange({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-1.5">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {t('Muss beim ersten Anmelden geändert werden')}
        <span className="block text-xs text-fg-muted">{t('Ohne Häkchen gilt das Passwort so, wie du es vergibst – z. B. für das Konto eines KI-Agenten.')}</span>
      </span>
    </label>
  );
}

/** Invite by mail (the person sets the password) or create with a start password – to be changed at the first login unless unticked (owner 28.10.). */
function NewUserForm({ mail, onDone, onCancel }: { mail: boolean; onDone: (text: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const empty = { displayName: '', email: '', password: '', role: 'user' as Role, mustChange: true };
  const [form, setForm] = useState(empty);
  const [how, setHow] = useState<'invite' | 'password'>(mail ? 'invite' : 'password');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const base = { email: form.email, displayName: form.displayName, ...roleFlags(form.role) };
      await api.createUser(how === 'invite' ? { ...base, invite: true } : { ...base, password: form.password, mustChange: form.mustChange });
      await qc.invalidateQueries({ queryKey: ['users'] });
      onDone(
        how === 'invite'
          ? t('Einladung an {email} verschickt – das Konto erscheint, sobald sie angenommen ist.', { email: form.email.trim() })
          : form.mustChange
            ? t('Konto {email} angelegt – beim ersten Anmelden muss das Startpasswort geändert werden.', { email: form.email.trim() })
            : t('Konto {email} angelegt – das Passwort gilt so, wie du es vergeben hast.', { email: form.email.trim() }),
      );
      setForm(empty);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const ok = form.email.includes('@') && (how === 'invite' || passwordProblems(form.password, [form.email, form.displayName]).length === 0);
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-dashed border-line p-3" aria-label={t('Neuer Benutzer')}>
      <div className="flex items-center gap-1.5 font-medium">
        <UserPlus className="h-4 w-4" /> {t('Neuer Benutzer')}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t('E-Mail (Anmeldung)')}>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" autoFocus />
        </Field>
        <Field label={t('Name (Commit-Autor)')}>
          <Input maxLength={100} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup" aria-label={t('Rolle')}>
        {(['user', 'admin', 'guest'] as Role[]).map((r) => (
          <label key={r} className="flex items-center gap-1.5">
            <input type="radio" name="new-role" checked={form.role === r} onChange={() => setForm({ ...form, role: r })} /> {ROLE_LABEL[r]}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup" aria-label={t('Zugang')}>
        <label className={cx('flex items-center gap-1.5', !mail && 'opacity-50')} title={mail ? undefined : t('Erst den E-Mail-Versand einrichten (Reiter „E-Mail“)')}>
          <input type="radio" name="new-how" disabled={!mail} checked={how === 'invite'} onChange={() => setHow('invite')} /> {t('Einladung per E-Mail')}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="new-how" checked={how === 'password'} onChange={() => setHow('password')} /> {t('Startpasswort selbst vergeben')}
        </label>
      </div>
      {how === 'password' && (
        <>
          <Field label={t('Startpasswort')} hint={<PasswordRules value={form.password} context={[form.email, form.displayName]} />}>
            <Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" spellCheck={false} />
          </Field>
          <MustChange checked={form.mustChange} onChange={(mustChange) => setForm({ ...form, mustChange })} />
        </>
      )}
      <FormError>{error}</FormError>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy || !ok}>
          {busy && <Spinner />} {how === 'invite' ? t('Einladung senden') : t('Anlegen')}
        </Button>
        <Button type="button" size="sm" onClick={onCancel}>
          {t('Abbrechen')}
        </Button>
      </div>
    </form>
  );
}

function EditUserDialog({ user, isMe, mail, onClose, onDone }: { user: User; isMe: boolean; mail: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ displayName: user.displayName, email: user.email, role: roleOf(user), password: '', mustChange: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['users'] });
      await qc.invalidateQueries({ queryKey: ['session'] });
      onDone(text);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const name = f.displayName || user.username;
    void run(
      async () => {
        await api.updateUser(user.id, { displayName: f.displayName, email: f.email, ...(isMe ? {} : roleFlags(f.role)) });
        if (f.password) await api.resetPassword(user.id, f.password, f.mustChange);
      },
      !f.password
        ? t('{name} gespeichert.', { name })
        : f.mustChange
          ? t('{name} gespeichert – das neue Passwort muss beim Anmelden geändert werden.', { name })
          : t('{name} gespeichert – das neue Passwort gilt so, wie du es vergeben hast.', { name }),
    );
  };
  return (
    <Modal help="konten-einladungen-und-teilen-per-e-mail" open onOpenChange={(o) => !o && onClose()} title={t('{name} bearbeiten', { name: user.displayName })}>
      <form className="space-y-3 text-sm" onSubmit={save}>
        <Field label={t('Name (Commit-Autor)')}>
          <Input maxLength={100} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
        </Field>
        <Field label={t('E-Mail (Anmeldung)')}>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        {!isMe && (
          <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup" aria-label={t('Rolle')}>
            {(['user', 'admin', 'guest'] as Role[]).map((r) => (
              <label key={r} className="flex items-center gap-1.5">
                <input type="radio" name="edit-role" checked={f.role === r} onChange={() => setF({ ...f, role: r })} /> {ROLE_LABEL[r]}
              </label>
            ))}
          </div>
        )}
        {!isMe && (
          <Field
            label={t('Neues Startpasswort (optional)')}
            hint={f.password ? <PasswordRules value={f.password} context={[f.email, user.username, user.displayName]} /> : t('Leer lassen, um das Passwort nicht zu ändern. Ein neues Startpasswort meldet die Person überall ab und löscht ihre API-Tokens.')}
          >
            <Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" spellCheck={false} />
          </Field>
        )}
        {!isMe && !!f.password && <MustChange checked={f.mustChange} onChange={(mustChange) => setF({ ...f, mustChange })} />}
        {!!user.proxyLinks?.length && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-fg-muted">{t('Anmeldung über einen Proxy')}</div>
            {user.proxyLinks.map((p) => (
              <div key={p} className="flex items-center gap-2">
                <span className="flex-1">{t('verbunden mit {name}', { name: PROXY_LABEL[p] })}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => api.unlinkUserProxy(user.id, p), t('Verbindung von {name} gelöst.', { name: user.displayName }))}
                >
                  {t('Verbindung lösen')}
                </Button>
              </div>
            ))}
          </div>
        )}
        <FormError>{error}</FormError>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {!isMe && mail ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => api.forgotPassword(user.email), t('Link zum Zurücksetzen an {email} verschickt.', { email: user.email }))}
            >
              <KeyRound className="h-3.5 w-3.5" /> {t('Link zum Zurücksetzen senden')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={onClose}>
              {t('Abbrechen')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy || !f.email.includes('@') || (!!f.password && passwordProblems(f.password, [f.email, user.username, user.displayName]).length > 0)}>
              {busy && <Spinner />} {t('Speichern')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

const mcpJson = (token: string) =>
  JSON.stringify({ mcpServers: { "kaveyl-wiki": { url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
const mcpCommand = (token: string) => `claude mcp add --transport http kaveyl-wiki ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;

const SCOPE_LABEL: Record<TokenScope, string> = { read: t('lesen'), write: t('schreiben'), mcp: 'MCP', admin: t('verwalten') };

/** A token value just made or renewed – shown once, with the MCP lines when it may use MCP. */
function NewTokenBox({ created }: { created: { token: string; scopes: TokenScope[]; forName?: string } }) {
  return (
    <div className="space-y-1 rounded-lg border border-accent bg-accent-soft p-3" role="status">
      <p className="font-medium">
        {created.forName
          ? t('Neuer Token für {name} – jetzt kopieren, er wird nicht wieder angezeigt:', { name: created.forName })
          : t('Neuer Token – jetzt kopieren, er wird nicht wieder angezeigt:')}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1 text-xs" aria-label={t('Token-Wert')}>
          {created.token}
        </code>
        <Button size="sm" onClick={() => void copyWithToast(created.token, 'Token')}>
          <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
        </Button>
      </div>
      {created.scopes.includes('mcp') && (
        <>
          <p className="pt-2 font-medium">{t('In Claude Code einbinden (enthält den Token):')}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1 text-xs" aria-label={t('MCP-Befehl')}>
              {mcpCommand(created.token)}
            </code>
            <Button size="sm" onClick={() => void copyWithToast(mcpCommand(created.token), 'Befehl')}>
              <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
            </Button>
          </div>
          <p className="pt-2 font-medium">{t('Andere MCP-Clients (Cursor, LM Studio, Hermes … – Format „mcpServers“, enthält den Token):')}</p>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-bg px-2 py-1 text-xs" aria-label={t('MCP-Konfiguration')}>
              {mcpJson(created.token)}
            </pre>
            <Button size="sm" onClick={() => void copyWithToast(mcpJson(created.token), 'Konfiguration')}>
              <Copy className="h-3.5 w-3.5" /> {t('Kopieren')}
            </Button>
          </div>
          <p className="text-xs text-fg-muted">
            {fillNodes(t('VS Code, Claude Desktop und Clients ohne HTTP-Kopfzeilen: siehe {link}.'), {
              link: (
                <button type="button" className="text-accent hover:underline" onClick={() => openHelp('mcp-clients-einrichten', 'api')}>
                  {t('Hilfe → API & MCP → MCP-Clients einrichten')}
                </button>
              ),
            })}
          </p>
        </>
      )}
    </div>
  );
}

/** One token in a list: rights and dates, „Erneuern“ and „Löschen“ (owner 28.10.: deleting is what it does). */
function TokenRow({ tok, person, onRenew, onDelete }: { tok: TokenInfo; person?: string; onRenew: () => void; onDelete: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="min-w-0 flex-1">
        {person && <span className="mr-1.5 text-fg-muted">{person} ·</span>}
        <span className="font-medium">{tok.name}</span> <code className="text-xs text-fg-faint">{tok.prefix}…</code>
        {expired(tok) && <span className="ml-1.5 rounded bg-muted px-1 text-[0.625rem] text-fg-muted">{t('abgelaufen')}</span>}
        <span className="block text-xs text-fg-faint">
          {t('{scopes} · erstellt {created} · läuft ab {expires} · zuletzt benutzt {used}', {
            scopes: tok.scopes.map((s) => SCOPE_LABEL[s]).join(', '),
            created: date(tok.createdAt),
            expires: date(tok.expiresAt),
            used: tok.lastUsedAt ? fmtAgo(tok.lastUsedAt) : '–',
          })}
          {tok.createdBy && ` · ${tok.createdBy.name ? t('angelegt von {name}', { name: tok.createdBy.name }) : t('angelegt von einem Admin')}`}
        </span>
      </span>
      <Button size="sm" variant="ghost" onClick={onRenew} aria-label={t('Token {name} erneuern', { name: tok.name })}>
        <RefreshCw className="h-3.5 w-3.5" /> {t('Erneuern')}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete} aria-label={t('Token {name} löschen', { name: tok.name })}>
        <Trash2 className="h-3.5 w-3.5 text-danger" /> {t('Löschen')}
      </Button>
    </li>
  );
}

const expired = (tok: TokenInfo) => !!tok.expiresAt && Date.parse(tok.expiresAt) <= Date.now();

const askRenew = (tok: TokenInfo, person?: string) =>
  confirmDialog(
    expired(tok)
      ? t('Token „{name}“ ist abgelaufen. Erneuern gibt ihm einen neuen Wert mit denselben Rechten und derselben Laufzeit, ab jetzt gezählt. Den neuen Wert siehst du einmal.', { name: tok.name })
      : person
      ? t('Token „{name}“ von {person} erneuern? Er bekommt einen neuen Wert mit denselben Rechten und derselben Laufzeit; Programme mit dem bisherigen Wert verlieren sofort den Zugang. Den neuen Wert siehst du einmal.', { name: tok.name, person })
      : t('Token „{name}“ erneuern? Er bekommt einen neuen Wert mit denselben Rechten und derselben Laufzeit; Programme mit dem bisherigen Wert verlieren sofort den Zugang. Den neuen Wert siehst du einmal.', { name: tok.name }),
    { confirmLabel: t('Erneuern') },
  );
/** Deletes an own token after asking; true when deleted. */
const deleteOwnToken = async (tok: TokenInfo) => {
  const ok = await confirmDialog(t('Token „{name}“ löschen? Programme, die ihn nutzen, verlieren sofort den Zugang. Das lässt sich nicht rückgängig machen.', { name: tok.name }), {
    confirmLabel: t('Löschen'),
    danger: true,
  });
  return ok && (await api.revokeToken(tok.id), true);
};
/** Admins: deletes someone's token after asking; true when deleted. */
const deleteTokenOf = async (tok: TokenInfo, person: string) => {
  const ok = await confirmDialog(t('Token „{name}“ von {person} löschen? Programme, die ihn nutzen, verlieren sofort den Zugang. Das lässt sich nicht rückgängig machen.', { name: tok.name, person }), {
    confirmLabel: t('Löschen'),
    danger: true,
  });
  return ok && (await api.deleteTokenOf(tok.id), true);
};

/** Name, rights, validity – for an own token or (admins) for someone else's. */
function NewTokenForm({ allowAdmin, onCreate, children, ready = true }: { allowAdmin: boolean; onCreate: (name: string, scopes: TokenScope[], days: number | null) => Promise<void>; children?: ReactNode; ready?: boolean }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['read']);
  const [days, setDays] = useState('90');
  const [error, setError] = useState<string | null>(null);
  const toggle = (s: TokenScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  return (
    <form
      className="space-y-2 rounded-lg border border-dashed border-line p-3"
      aria-label={t('Neuer Token')}
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await onCreate(name.trim(), allowAdmin ? scopes : scopes.filter((s) => s !== 'admin'), days ? Number(days) : null);
          setName('');
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      {children}
      <Field label={t('Name des Tokens')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('z. B. Claude Desktop, Backup-Skript')} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        {(['read', 'write', 'mcp', ...(allowAdmin ? ['admin'] : [])] as TokenScope[]).map((s) => (
          <label key={s} className="flex items-center gap-1.5">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /> {SCOPE_LABEL[s]}
          </label>
        ))}
        <label className="flex items-center gap-1.5">
          {t('Gültig')}
          <select className="h-7 rounded border border-line bg-bg px-1" value={days} onChange={(e) => setDays(e.target.value)} aria-label={t('Gültigkeit')}>
            <option value="30">{t('30 Tage')}</option>
            <option value="90">{t('90 Tage')}</option>
            <option value="365">{t('1 Jahr')}</option>
            <option value="">{t('unbegrenzt')}</option>
          </select>
        </label>
      </div>
      <FormError>{error}</FormError>
      <Button variant="primary" size="sm" disabled={!ready || !name.trim() || !scopes.some((s) => allowAdmin || s !== 'admin')}>
        {t('Token erstellen')}
      </Button>
    </form>
  );
}

export function TokensPanel({ me }: { me: User }) {
  const qc = useQueryClient();
  // „zuletzt benutzt“ moves while scripts work with a token: fresh when the panel opens and then every minute.
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens, refetchOnMount: 'always', refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const [created, setCreated] = useState<{ token: string; scopes: TokenScope[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tokens'] });
  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((err: unknown) => setError(errorText(err)));
  };
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {fillNodes(
          t(
            'Persönliche Tokens für Skripte, KI-Werkzeuge (MCP) und Apps: Sie handeln in deinem Namen, mit höchstens den gewählten Rechten. Übergabe als {header}. Der Token wird nur einmal angezeigt; gespeichert wird nur ein Fingerabdruck.',
          ),
          { header: <code>Authorization: Bearer kw_…</code> },
        )}
      </p>
      {created && <NewTokenBox created={created} />}
      <p className="text-xs text-fg-faint">
        {fillNodes(
          t(
            'REST-API v1: {api}, Beschreibung als OpenAPI unter {openapi}. MCP-Server: {mcp} (Token mit „MCP“, zum Ändern zusätzlich „schreiben“) – offener Standard, für jeden MCP-Client, nicht nur Claude. Ausführlich: {hilfe}.',
          ),
          {
            api: <code>{location.origin}/api/v1/…</code>,
            openapi: (
              <a className="text-accent underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
                /api/v1/openapi.json
              </a>
            ),
            mcp: <code>{location.origin}/mcp</code>,
            hilfe: (
              <button type="button" className="text-accent hover:underline" onClick={() => openHelp('', 'api')}>
                {t('Hilfe → API & MCP')}
              </button>
            ),
          },
        )}
      </p>
      <FormError>{error}</FormError>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Tokens')}>
        {tokens.data?.length === 0 && <li className="px-3 py-2 text-fg-muted">{t('Noch keine Tokens.')}</li>}
        {tokens.data?.map((tok) => (
          <TokenRow
            key={tok.id}
            tok={tok}
            onRenew={() =>
              void askRenew(tok).then(
                (ok) =>
                  ok &&
                  act(async () => {
                    const res = await api.renewToken(tok.id);
                    setCreated({ token: res.token, scopes: res.info.scopes });
                    await refresh();
                  }),
              )
            }
            onDelete={() => act(async () => (await deleteOwnToken(tok)) && (await refresh()))}
          />
        ))}
      </ul>
      <NewTokenForm
        allowAdmin={me.isAdmin}
        onCreate={async (name, scopes, days) => {
          const res = await api.createToken(name, scopes, days);
          setCreated({ token: res.token, scopes: res.info.scopes });
          await refresh();
        }}
      />
    </div>
  );
}

/**
 * Settings → KI & APIs → Alle Tokens (admins, owner 28.10.): everyone's tokens in one list, renew or delete them,
 * and make one for someone – e.g. the account of an AI agent – without signing in as them. The person sees in their
 * own list who made it.
 */
export function AllTokensPanel() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['all-tokens'], queryFn: api.allTokens, refetchOnMount: 'always', refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const users = useQuery({ queryKey: ['users'], queryFn: api.users, refetchOnMount: 'always' });
  const [filter, setFilter] = useState('');
  const [forUser, setForUser] = useState('');
  const [created, setCreated] = useState<{ token: string; scopes: TokenScope[]; forName?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (u: { displayName: string; username: string }) => u.displayName || u.username;
  // Guests have no tokens, a locked account's would not work.
  const candidates = (users.data ?? []).filter((u) => !u.isGuest && !u.disabled);
  const target = candidates.find((u) => u.id === forUser);
  const people = [...new Map((tokens.data ?? []).map((tok) => [tok.user.id, tok.user])).values()];
  // A person whose last token just went is no filter any more (otherwise the list would stay empty).
  const by = people.some((u) => u.id === filter) ? filter : '';
  const shown = (tokens.data ?? []).filter((tok) => !by || tok.user.id === by);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['all-tokens'] }), qc.invalidateQueries({ queryKey: ['tokens'] })]);
  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((err: unknown) => setError(errorText(err)));
  };
  return (
    <div className="space-y-4 text-sm">
      <p className="text-fg-muted">
        {t(
          'Alle API-Tokens aller Personen. Ein Token handelt immer als die Person, für die er gilt – mit höchstens ihren Rechten. Legst du einen für jemand anderen an (z. B. das Konto eines KI-Agenten), siehst du seinen Wert einmal; die Person sieht in ihrer Liste, dass du ihn angelegt hast.',
        )}
      </p>
      {created && <NewTokenBox created={created} />}
      <FormError>{error}</FormError>
      {people.length > 1 && (
        <label className="flex items-center gap-2">
          {t('Person')}
          <select className="h-8 rounded-md border border-line bg-bg px-2" value={by} onChange={(e) => setFilter(e.target.value)} aria-label={t('Nach Person filtern')}>
            <option value="">{t('Alle ({n})', { n: tokens.data?.length ?? 0 })}</option>
            {people.map((u) => (
              <option key={u.id} value={u.id}>
                {nameOf(u)}
              </option>
            ))}
          </select>
        </label>
      )}
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t('Tokens aller Personen')}>
        {tokens.isLoading && (
          <li className="px-3 py-2">
            <Spinner />
          </li>
        )}
        {tokens.data?.length === 0 && <li className="px-3 py-2 text-fg-muted">{t('Noch keine Tokens.')}</li>}
        {shown.map((tok) => (
          <TokenRow
            key={tok.id}
            tok={tok}
            person={nameOf(tok.user)}
            onRenew={() =>
              void askRenew(tok, nameOf(tok.user)).then(
                (ok) =>
                  ok &&
                  act(async () => {
                    const res = await api.renewTokenOf(tok.id);
                    setCreated({ token: res.token, scopes: res.info.scopes, forName: nameOf(tok.user) });
                    await refresh();
                  }),
              )
            }
            onDelete={() => act(async () => (await deleteTokenOf(tok, nameOf(tok.user))) && (await refresh()))}
          />
        ))}
      </ul>
      <NewTokenForm
        key={forUser}
        allowAdmin={!!target?.isAdmin}
        ready={!!target}
        onCreate={async (name, scopes, days) => {
          if (!target) return;
          const res = await api.createTokenFor(target.id, name, scopes, days);
          setCreated({ token: res.token, scopes: res.info.scopes, forName: nameOf(target) });
          await refresh();
        }}
      >
        <Field label={t('Für')}>
          <select className="block h-8 w-full max-w-xs rounded-md border border-line bg-bg px-2" value={forUser} onChange={(e) => setForUser(e.target.value)} aria-label={t('Token für')}>
            <option value="">{t('Person wählen …')}</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {nameOf(u)} ({u.email})
              </option>
            ))}
          </select>
        </Field>
      </NewTokenForm>
    </div>
  );
}
