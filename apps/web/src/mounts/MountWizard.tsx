// Mount wizard: pick a source (repository list of a Gitea/GitHub/GitLab connection, Git URL or
// local folder), a branch, choose what to include in a checkbox tree (whole repo, folders,
// single files) and set options. Editing an existing mount reuses the option and selection
// parts and can switch the connection. SEE-DOC: docs/PLAN.md §2.1, DECISIONS.md AD-029
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, FileText, GitBranch, Search, HardDrive, Globe, Database, Check, Minus, ArrowLeft, Lock, Plus } from 'lucide-react';
import { api, CONNECTION_LABEL, errorText, type Connection, type GiteaOwner, type GiteaRepo, type HostKind, type Mount, type TreeNode } from '../api';
import { ConnectionForm, connectionsFor, useConnections } from './Connections';
import { Button, Field, Input, Modal, PopoverContent, Spinner, cx, useModalDirty, Rich, FormError, confirmDialog, promptDialog } from '../ui';
import * as Popover from '@radix-ui/react-popover';
import { IconPicker } from '../editor/IconPicker';
import { IconGlyph } from '../editor/icons';
import { t, tn } from '../i18n';

type SourceKind = HostKind | 'url' | 'local';
interface Source {
  type: 'remote' | 'local';
  source: string;
  /** Connection with the access data; null = public repository / local folder. */
  connectionId: string | null;
  /** A token typed in the wizard for a Git URL — becomes a connection when the source is created. */
  credential?: { kind: 'token'; token: string; username?: string } | null;
  defaultBranch?: string;
  suggestedName: string;
  /** Local folder that is a Git repository itself (remote sources always are). */
  isRepo?: boolean;
}


/** The fixed code parts of the „no folder mounted“ hint. */
const DOCS_CODE = {
  roots: <code>LOCAL_ROOTS=/docs</code>,
  compose: <code>docker-compose.yml</code>,
  volumes: <code>volumes</code>,
  mount: <code>./docs:/docs</code>,
  docs: <code>/docs</code>,
};

/** What the wizard sends for branches, the first clone and the new source. */
const access = (src: Source) => (src.credential ? { credential: src.credential } : { connectionId: src.connectionId });

/** `onBack`: opened from another dialog (Settings) — "Zurück" in the header returns there. */
export function MountWizard({ open, onClose, edit, onBack }: { open: boolean; onClose: () => void; edit?: Mount | null; onBack?: () => void }) {
  return (
    <Modal help={edit ? 'eine-quelle-bearbeiten' : 'quellen-einbinden'} open={open} onOpenChange={(o) => !o && onClose()} title={edit ? t('Mount „{name}“ bearbeiten', { name: edit.name }) : t('Quelle einbinden')} wide trackInput onBack={onBack}>
      {open && (edit ? <EditMount mount={edit} onDone={onClose} /> : <NewMount onDone={onClose} />)}
    </Modal>
  );
}

function NewMount({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'source' | 'branch' | 'content' | 'options'>('source');
  const [src, setSrc] = useState<Source | null>(null);
  const [branch, setBranch] = useState<string>('main');
  const [include, setInclude] = useState<string[] | null>(null);
  const [count, setCount] = useState(0);
  // A source is picked: going back out would lose the choices made so far.
  useModalDirty(step !== 'source');
  const steps = src?.type === 'local' ? ['source', 'content', 'options'] : ['source', 'branch', 'content', 'options'];

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs">
        {steps.map((s, i) => (
          <li key={s} className={cx('flex items-center gap-1.5 rounded-full px-2.5 py-1', s === step ? 'bg-accent-soft text-accent' : 'bg-muted text-fg-muted')}>
            <span className="font-semibold">{i + 1}</span>
            {{ source: t('Quelle'), branch: t('Branch'), content: t('Inhalt'), options: t('Optionen') }[s]}
          </li>
        ))}
      </ol>
      {step === 'source' && (
        <SourceStep
          onPick={(s) => {
            setSrc(s);
            if (s.defaultBranch) setBranch(s.defaultBranch);
            setStep(s.type === 'local' ? 'content' : 'branch');
          }}
        />
      )}
      {step === 'branch' && src && (
        <BranchStep src={src} value={branch} onBack={() => setStep('source')} onNext={(b) => (setBranch(b), setStep('content'))} />
      )}
      {step === 'content' && src && (
        <ContentStep
          src={src}
          branch={branch}
          onBack={() => setStep(src.type === 'local' ? 'source' : 'branch')}
          onNext={(globs, n) => {
            setInclude(globs);
            setCount(n);
            setStep('options');
          }}
        />
      )}
      {step === 'options' && src && include && (
        <OptionsStep src={src} branch={branch} include={include} count={count} onBack={() => setStep('content')} onDone={onDone} />
      )}
    </div>
  );
}

// ── Step 1: source ──────────────────────────────────────────────────────────────
function SourceStep({ onPick }: { onPick: (s: Source) => void }) {
  const [kind, setKind] = useState<SourceKind>('gitea');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 text-sm">
        {(
          [
            ['gitea', 'Gitea', <Database key="g" className="h-4 w-4" />],
            ['github', 'GitHub', <Database key="h" className="h-4 w-4" />],
            ['gitlab', 'GitLab', <Database key="l" className="h-4 w-4" />],
            ['url', t('Git-URL'), <Globe key="u" className="h-4 w-4" />],
            ['local', t('Lokaler Ordner'), <HardDrive key="o" className="h-4 w-4" />],
          ] as const
        ).map(([k, label, icon]) => (
          <button key={k} className={cx('flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5', kind === k ? 'bg-bg shadow-sm' : 'text-fg-muted')} onClick={() => setKind(k)}>
            {icon}
            {label}
          </button>
        ))}
      </div>
      {(kind === 'gitea' || kind === 'github' || kind === 'gitlab') && <HostSource key={kind} kind={kind} onPick={onPick} />}
      {kind === 'url' && <UrlSource onPick={onPick} />}
      {kind === 'local' && <LocalSource onPick={onPick} />}
    </div>
  );
}

/** Repositories of a Gitea/GitHub/GitLab connection — or a form to set one up first. */
function HostSource({ kind, onPick }: { kind: HostKind; onPick: (s: Source) => void }) {
  const all = useConnections();
  const list = (all.data ?? []).filter((c) => c.kind === kind);
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const conn = list.find((c) => c.id === chosen) ?? list[0] ?? null;
  const repos = useQuery({ queryKey: ['host-repos', conn?.id, q], queryFn: () => api.hostRepos(conn!.id, q), enabled: !!conn && !adding, placeholderData: (p) => p, retry: false });
  if (all.isPending) return <Spinner />;
  if (!conn || adding)
    return (
      <div className="space-y-2">
        <p className="text-sm text-fg-muted">
          {list.length
            ? t('Weitere {host}-Verbindung anlegen', { host: CONNECTION_LABEL[kind] })
            : t('Noch keine {host}-Verbindung – einmal einrichten, dann erscheinen hier deine Repositories.', { host: CONNECTION_LABEL[kind] })}
        </p>
        <ConnectionForm
          kind={kind}
          onSaved={(c) => {
            setChosen(c.id);
            setAdding(false);
          }}
          onCancel={list.length ? () => setAdding(false) : undefined}
        />
      </div>
    );
  const pick = (r: GiteaRepo) =>
    onPick({ type: 'remote', source: r.cloneUrl, connectionId: conn.id, defaultBranch: r.defaultBranch, suggestedName: r.fullName.split('/').pop()! });
  if (creating) return <NewHostRepo connection={conn} onCancel={() => setCreating(false)} onCreated={pick} />;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <span className="text-fg-muted">{t('Verbindung')}</span>
          <select
            aria-label={t('Verbindung')}
            className="h-8 min-w-0 rounded-md border border-line bg-bg px-2 text-sm"
            value={conn.id}
            onChange={(e) => (e.target.value === '+' ? setAdding(true) : setChosen(e.target.value))}
            data-nodirty
          >
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="+">＋ {t('Weitere Verbindung …')}</option>
          </select>
        </label>
        <div className="relative min-w-40 flex-1">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-fg-faint" />
          <Input className="pl-8" autoFocus placeholder={t('Repository suchen …')} value={q} onChange={(e) => setQ(e.target.value)} data-nodirty />
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> {t('Neues Repository')}
        </Button>
      </div>
      <div className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {repos.isPending && (
          <div className="p-3">
            <Spinner />
          </div>
        )}
        <FormError className="p-3">{repos.isError && errorText(repos.error)}</FormError>
        {repos.data?.map((r) => (
          <button key={r.fullName} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover" onClick={() => pick(r)}>
            <Database className="h-4 w-4 shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{r.fullName}</span>
              {r.description && <span className="block truncate text-xs text-fg-muted">{r.description}</span>}
            </span>
            {r.private && <Lock className="h-3.5 w-3.5 text-fg-faint" />}
            <span className="text-xs text-fg-faint">{r.defaultBranch}</span>
          </button>
        ))}
        {repos.data?.length === 0 && <div className="p-3 text-sm text-fg-muted">{t('Keine Repositories gefunden')}</div>}
      </div>
    </div>
  );
}

/** Creates a repository on the hoster (with README) and continues the wizard with it. */
function NewHostRepo({ connection, onCancel, onCreated }: { connection: Connection; onCancel: () => void; onCreated: (r: GiteaRepo) => void }) {
  const qc = useQueryClient();
  const owners = useQuery({ queryKey: ['host-owners', connection.id], queryFn: () => api.hostOwners(connection.id) });
  const [owner, setOwner] = useState<GiteaOwner | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = owner ?? owners.data?.[0] ?? null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await api.createHostRepo(connection.id, { owner: chosen, name: name.trim(), description, private: isPrivate });
      await qc.invalidateQueries({ queryKey: ['host-repos'] });
      onCreated(repo);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
        <Field label={t('Besitzer')}>
          <select
            className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
            value={chosen ? `${chosen.kind}:${chosen.name}` : ''}
            disabled={!owners.data}
            onChange={(e) => setOwner(owners.data?.find((o) => `${o.kind}:${o.name}` === e.target.value) ?? null)}
          >
            {owners.data?.map((o) => (
              <option key={`${o.kind}:${o.name}`} value={`${o.kind}:${o.name}`}>
                {o.name}
                {o.kind === 'org' ? (connection.kind === 'gitlab' ? ` (${t('Gruppe')})` : ` (${t('Organisation')})`) : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Repository-Name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('z. B. notizen')} />
        </Field>
      </div>
      <Field label={t('Beschreibung (optional)')}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
        {t('Privat (nur für dich bzw. die Organisation sichtbar)')}
      </label>
      <p className="text-xs text-fg-faint">{t('Das Repository wird mit einer README angelegt und danach direkt eingebunden ({name}).', { name: connection.name })}</p>
      <FormError>{owners.isError && errorText(owners.error)}</FormError>
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('Abbrechen')}
        </Button>
        <Button variant="primary" disabled={busy || !chosen || !name.trim()}>
          {busy && <Spinner />} {t('Anlegen und weiter')}
        </Button>
      </div>
    </form>
  );
}

/** Any HTTPS Git URL: without sign-in, with a fitting connection, or with a new token. */
function UrlSource({ onPick }: { onPick: (s: Source) => void }) {
  const all = useConnections();
  const [url, setUrl] = useState('');
  const [choice, setChoice] = useState<string>('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const valid = /^https?:\/\/\S+$/i.test(url.trim());
  const fitting = valid ? connectionsFor(all.data, url.trim()) : [];
  // Default: the fitting connection if there is exactly one, else without sign-in. A connection
  // chosen for another address no longer counts once the URL changes (its token stays home).
  const kept = choice === 'none' || choice === 'token' || fitting.some((c) => c.id === choice) ? choice : '';
  const selected = kept || (fitting.length === 1 ? fitting[0]!.id : 'none');
  return (
    <div className="space-y-3">
      <Field label={t('Clone-URL (HTTPS)')}>
        <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/user/notes.git" />
      </Field>
      <Field label={t('Anmeldung')}>
        <select aria-label={t('Anmeldung')} className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm" value={selected} onChange={(e) => setChoice(e.target.value)}>
          <option value="none">{t('Ohne Anmeldung (öffentliches Repository)')}</option>
          {fitting.map((c) => (
            <option key={c.id} value={c.id}>
              {t('Verbindung „{name}“', { name: c.name })}
            </option>
          ))}
          <option value="token">{t('Neuer Token …')}</option>
        </select>
      </Field>
      {selected === 'token' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Benutzername (optional)')} hint={t('Nur für Server mit Basic-Anmeldung (Bitbucket, Azure DevOps …).')}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
          <Field label={t('Token')} hint={t('Wird verschlüsselt als Verbindung gespeichert, nie in die URL geschrieben.')}>
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!valid || (selected === 'token' && !token)}
          onClick={() =>
            onPick({
              type: 'remote',
              source: url.trim(),
              connectionId: selected === 'none' || selected === 'token' ? null : selected,
              credential: selected === 'token' ? { kind: 'token', token, ...(username.trim() ? { username: username.trim() } : {}) } : null,
              suggestedName: url.trim().split('/').pop()!.replace(/\.git$/, ''),
            })
          }
        >
          {t('Weiter')}
        </Button>
      </div>
    </div>
  );
}

function LocalSource({ onPick }: { onPick: (s: Source) => void }) {
  const qc = useQueryClient();
  const [path, setPath] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const listing = useQuery({ queryKey: ['local', path ?? ''], queryFn: () => api.browseLocal(path) });
  /** One folder per wiki without a terminal: created inside the open folder and opened at once. */
  const newFolder = async (parent: string) => {
    const name = await promptDialog(t('Neuer Ordner'), { label: t('Name des Ordners'), required: true, confirmLabel: t('Anlegen'), help: 'quellen-einbinden' });
    if (!name?.trim()) return;
    setError(null);
    try {
      const created = await api.createLocalFolder(parent, name);
      await qc.invalidateQueries({ queryKey: ['local', parent] });
      setPath(created.path);
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (listing.isPending) return <Spinner />;
  if (listing.isError) return <FormError>{errorText(listing.error)}</FormError>;
  const data = listing.data;
  if (!data.path && !data.dirs.length)
    return (
      <p className="text-sm text-fg-muted">
        {/* The server's hint names a missing LOCAL_ROOTS; a volume alone would not help then. */}
        {data.hint ? (
          <Rich
            parts={DOCS_CODE}
            text={t('{hint} – im Image ist {roots} vorgesehen; dazu in der {compose} unter {volumes} z. B. {mount} ergänzen (den Ordner auf dem Server vorher anlegen; er muss dem Benutzer gehören, unter dem der Container läuft – Standard 1000:1000) und den Container neu starten – danach erscheinen hier die Unterordner von {docs}. Für den Abgleich mit einem Git-Server ein Repository einbinden.', { hint: data.hint })}
          />
        ) : (
          <Rich
            parts={DOCS_CODE}
            text={t('Kein Ordner für lokale Notizen eingehängt. In der {compose} unter {volumes} z. B. {mount} ergänzen (den Ordner auf dem Server vorher anlegen; er muss dem Benutzer gehören, unter dem der Container läuft – Standard 1000:1000) und den Container neu starten – danach erscheinen hier die Unterordner von {docs}. Für den Abgleich mit einem Git-Server ein Repository einbinden.')}
          />
        )}
      </p>
    );
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        {data.path && (
          <Button size="sm" variant="ghost" aria-label={t('Übergeordneter Ordner')} title={t('Übergeordneter Ordner')} onClick={() => setPath(data.path!.split('/').slice(0, -1).join('/') || undefined)}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
        )}
        <code className="flex-1 truncate text-xs text-fg-muted">{data.path ?? t('Freigegebene Wurzeln')}</code>
        {data.path && (
          <Button size="sm" variant="ghost" onClick={() => void newFolder(data.path!)}>
            <Plus className="h-3.5 w-3.5" /> {t('Neuer Ordner …')}
          </Button>
        )}
      </div>
      <FormError>{error}</FormError>
      <div className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {data.dirs.map((d) => (
          <button key={d.path} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => setPath(d.path)}>
            <Folder className="h-4 w-4 text-fg-faint" />
            <span className="flex-1 truncate">{d.name}</span>
            {d.isRepo && <span className="rounded bg-muted px-1.5 text-[0.6875rem] text-fg-muted">git</span>}
            {d.writable === false && (
              <span
                className="text-[0.6875rem] text-warn"
                title={t('Kaveyl Wiki darf hier nicht schreiben – der Ordner muss auf dem Server dem Benutzer gehören, unter dem der Container läuft (Standard 1000:1000, sonst die Zeile user: in der docker-compose.yml)')}
              >
                {t('nicht beschreibbar')}
              </span>
            )}
            <ChevronRight className="h-4 w-4 text-fg-faint" />
          </button>
        ))}
        {!data.dirs.length && <div className="p-3 text-sm text-fg-muted">{t('Keine Unterordner')}</div>}
      </div>
      {/* Footer like the other steps: the primary button also closes the window off visually. */}
      <div className="flex items-center justify-end gap-2 pt-1">
        {!data.path && <span className="text-xs text-fg-faint">{t('Ordner öffnen, dann wählen')}</span>}
        <Button
          size="sm"
          variant="primary"
          disabled={!data.path}
          onClick={() => onPick({ type: 'local', source: data.path!, connectionId: null, suggestedName: data.path!.split('/').pop()!, isRepo: !!data.isRepo })}
        >
          {t('Diesen Ordner wählen')}
        </Button>
      </div>
    </div>
  );
}

// ── Step 2: branch ──────────────────────────────────────────────────────────────
function BranchStep({ src, value, onBack, onNext }: { src: Source; value: string; onBack: () => void; onNext: (b: string) => void }) {
  const branches = useQuery({ queryKey: ['branches', src.source, src.connectionId, !!src.credential], queryFn: () => api.branches(src.source, access(src)), retry: false });
  const [branch, setBranch] = useState(value);
  useEffect(() => {
    if (branches.data?.length && !branches.data.includes(branch)) setBranch(branches.data.includes('main') ? 'main' : branches.data[0]!);
  }, [branches.data, branch]);
  return (
    <div className="space-y-3">
      <p className="truncate text-sm text-fg-muted">{src.source}</p>
      {branches.isPending && <Spinner />}
      <FormError>{branches.isError && t('Branches konnten nicht gelesen werden: {error}', { error: String((branches.error as Error).message) })}</FormError>
      {/* An empty repository (no commit yet) has no branch – the hoster still names „main“ (owner 26.10.: Weiter stayed grey without a word). */}
      {branches.data?.length === 0 && (
        <div role="status" className="space-y-2 rounded-lg border border-line bg-subtle p-3 text-sm">
          <p>
            {t('Das Repository ist noch leer – es hat noch keinen Commit und keinen Branch. Lege beim Anbieter eine erste Datei an (z. B. eine README) oder erstelle das Repository hier über „Neues Repository“.')}
          </p>
          <Button size="sm" disabled={branches.isFetching} onClick={() => void branches.refetch()}>
            {branches.isFetching && <Spinner className="h-3.5 w-3.5" />} {t('Erneut prüfen')}
          </Button>
        </div>
      )}
      {!!branches.data?.length && (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
          {branches.data.map((b) => (
            <label key={b} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-hover">
              <input type="radio" name="branch" checked={b === branch} onChange={() => setBranch(b)} className="accent-[var(--accent)]" />
              <GitBranch className="h-4 w-4 text-fg-faint" />
              {b}
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          {t('Zurück')}
        </Button>
        <Button variant="primary" disabled={!branches.data?.length} onClick={() => onNext(branch)}>
          {t('Weiter')}
        </Button>
      </div>
    </div>
  );
}

// ── Step 3: content selection ───────────────────────────────────────────────────
function ContentStep({ src, branch, onBack, onNext }: { src: Source; branch: string; onBack: () => void; onNext: (globs: string[], count: number) => void }) {
  const tree = useQuery({
    queryKey: ['source-tree', src.type, src.source, branch],
    queryFn: () => api.sourceTree({ type: src.type, source: src.source, branch, ...access(src) }),
    retry: false,
    staleTime: Infinity,
  });
  if (tree.isPending)
    return (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Spinner /> {src.type === 'remote' ? t('Repository wird geklont …') : t('Ordner wird gelesen …')}
      </div>
    );
  if (tree.isError)
    return (
      <div className="space-y-3">
        <FormError>{String((tree.error as Error).message)}</FormError>
        <Button variant="ghost" onClick={onBack}>
          {t('Zurück')}
        </Button>
      </div>
    );
  return <Selection tree={tree.data} onBack={onBack} onNext={onNext} />;
}

function allFiles(node: TreeNode, out: string[] = []): string[] {
  if (node.kind === 'file') out.push(node.path);
  node.children?.forEach((c) => allFiles(c, out));
  return out;
}

export function Selection({ tree, onBack, onNext, nextLabel = t('Weiter') }: { tree: TreeNode; onBack?: () => void; onNext: (globs: string[], count: number) => void; nextLabel?: string }) {
  const files = useMemo(() => allFiles(tree), [tree]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(files));
  const [expert, setExpert] = useState<string | null>(null);
  const globs = useMemo(() => selectionGlobs(tree, selected), [tree, selected]);

  const toggle = (node: TreeNode) => {
    const fs = allFiles(node);
    const all = fs.every((f) => selected.has(f));
    const next = new Set(selected);
    for (const f of fs) all ? next.delete(f) : next.add(f);
    setSelected(next);
    setExpert(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-fg-muted">
          <Rich text={t('{n} von {total} Notizen ausgewählt', { total: files.length })} parts={{ n: <strong className="text-fg">{selected.size}</strong> }} />
        </span>
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => (setSelected(new Set(files)), setExpert(null))}>
            {t('Alle')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => (setSelected(new Set()), setExpert(null))}>
            {t('Keine')}
          </Button>
        </span>
      </div>
      <div className="max-h-[42vh] overflow-y-auto rounded-lg border border-line py-1">
        {files.length === 0 ? (
          <div className="p-3 text-sm text-fg-muted">{t('Noch keine Notizen – der Ordner wird ganz eingebunden, neue Notizen legst du danach in Kaveyl Wiki an.')}</div>
        ) : (
          <CheckNode node={tree} depth={0} selected={selected} onToggle={toggle} root />
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-fg-muted">{t('Experten: Glob-Muster')}</summary>
        <textarea
          className="mt-2 h-24 w-full rounded-md border border-line bg-bg p-2 font-mono text-xs"
          value={expert ?? globs.join('\n')}
          onChange={(e) => setExpert(e.target.value)}
        />
        <p className="text-xs text-fg-faint">
          <Rich text={t('Ein Muster pro Zeile, relativ zur Wurzel, z. B. {example}. Manuelle Änderungen haben Vorrang vor der Auswahl oben.')} parts={{ example: <code>docs/**</code> }} />
        </p>
      </details>
      <div className="flex justify-between">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            {t('Zurück')}
          </Button>
        ) : (
          <span />
        )}
        <Button
          variant="primary"
          // An empty folder or repository (e.g. just made with „Neuer Ordner …“) is taken as a whole – before, Weiter stayed grey.
          disabled={expert === null && selected.size === 0 && files.length > 0}
          onClick={() => onNext(expert !== null ? expert.split('\n').map((l) => l.trim()).filter(Boolean) : files.length ? globs : ['**'], selected.size)}
        >
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}

/** Compresses the selection: fully selected folders become `dir/**`, the root becomes `**`. */
function selectionGlobs(tree: TreeNode, selected: Set<string>): string[] {
  const out: string[] = [];
  const visit = (node: TreeNode) => {
    const fs = allFiles(node);
    if (fs.length && fs.every((f) => selected.has(f))) {
      out.push(node.kind === 'file' ? node.path : node.path ? `${node.path}/**` : '**');
      return;
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return out;
}

function CheckNode({ node, depth, selected, onToggle, root }: { node: TreeNode; depth: number; selected: Set<string>; onToggle: (n: TreeNode) => void; root?: boolean }) {
  const [open, setOpen] = useState(depth < 1);
  const fs = useMemo(() => allFiles(node), [node]);
  const n = fs.filter((f) => selected.has(f)).length;
  const state = n === 0 ? 'none' : n === fs.length ? 'all' : 'some';
  return (
    <div>
      <div className="flex h-7 items-center gap-1.5 pr-2 text-sm hover:bg-hover" style={{ paddingLeft: 8 + depth * 16 }}>
        {node.kind === 'dir' ? (
          <button className="flex h-4 w-4 items-center justify-center" onClick={() => setOpen(!open)} aria-label={open ? t('Zuklappen') : t('Aufklappen')}>
            <ChevronRight className={cx('h-3.5 w-3.5 text-fg-faint transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          role="checkbox"
          aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
          // Named like its row – screen readers said only „checkbox“ (checklist 20.10.).
          aria-label={root ? t('Gesamter Inhalt') : node.name}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
          onClick={() => onToggle(node)}
        >
          <span className={cx('flex h-4 w-4 items-center justify-center rounded border', state === 'none' ? 'border-line-control bg-bg' : 'border-accent bg-accent text-accent-fg')}>
            {state === 'all' && <Check className="h-3 w-3" />}
            {state === 'some' && <Minus className="h-3 w-3" />}
          </span>
        </button>
        {node.kind === 'dir' ? <Folder className="h-4 w-4 text-fg-faint" /> : <FileText className="h-4 w-4 text-fg-faint" />}
        <span className="flex-1 truncate" onClick={() => node.kind === 'dir' && setOpen(!open)}>
          {root ? t('Gesamter Inhalt') : node.name}
        </span>
        {node.kind === 'dir' && <span className="text-xs text-fg-faint">{node.notes}</span>}
      </div>
      {node.kind === 'dir' && open && node.children?.map((c) => <CheckNode key={c.path} node={c} depth={depth + 1} selected={selected} onToggle={onToggle} />)}
    </div>
  );
}

// ── Step 4: options ─────────────────────────────────────────────────────────────
function OptionsStep({ src, branch, include, count, onBack, onDone }: { src: Source; branch: string; include: string[]; count: number; onBack: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(src.suggestedName);
  const [icon, setIcon] = useState('');
  const [opts, setOpts] = useState<Opts>({ readonly: false, autoCommit: src.type === 'remote', writeMetadata: true, folderNote: 'index.md', commitIdleSec: 120 });
  // A local folder without Git gets its own for versions unless switched off (AD-071).
  const [versions, setVersions] = useState(true);
  const plainFolder = src.type === 'local' && !src.isRepo;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        <Rich
          text={
            src.type === 'remote'
              ? tn(count, '{n} Notiz aus {source} (Branch {branch})', '{n} Notizen aus {source} (Branch {branch})')
              : tn(count, '{n} Notiz aus {source}', '{n} Notizen aus {source}')
          }
          parts={{ source: <code className="text-xs">{src.source}</code>, branch: <code className="text-xs">{branch}</code> }}
        />
      </p>
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <Field label={t('Name in der Seitenleiste')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <IconField value={icon} onChange={setIcon} />
      </div>
      <MountOptionsForm
        type={src.type}
        git={!plainFolder}
        versions={plainFolder ? { on: versions, onChange: setVersions } : undefined}
        value={opts}
        onChange={setOpts}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          {t('Zurück')}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.createMount({
                type: src.type,
                source: src.source,
                branch: src.type === 'remote' ? branch : undefined,
                ...access(src),
                include,
                name: name.trim(),
                icon: icon.trim() || null,
                // A folder without Git has nothing to commit: never keep a stale auto-commit (with versions the server switches it on).
                options: plainFolder ? { ...opts, autoCommit: false } : opts,
                ...(plainFolder && versions ? { versions: true } : {}),
              });
              await qc.invalidateQueries({ queryKey: ['mounts'] });
              onDone();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />} {t('Einbinden')}
        </Button>
      </div>
    </div>
  );
}

type Opts = { readonly: boolean; autoCommit: boolean; writeMetadata: boolean; folderNote: string; commitIdleSec: number; aiMemory?: boolean; aiChatDays?: number };

/**
 * `git`: remote, or a local folder with `.git` — only then are there commits to make (plain folders just save files).
 * `versions`: a plain local folder in the wizard – the choice to give it its own Git (AD-071). `onVersions`: the
 * same for a plain folder already mounted (button, the server does it at once).
 */
function MountOptionsForm({
  type,
  git,
  versions,
  onVersions,
  value,
  onChange,
}: {
  type: 'remote' | 'local';
  git: boolean;
  versions?: { on: boolean; onChange: (on: boolean) => void };
  onVersions?: () => void;
  value: Opts;
  onChange: (o: Opts) => void;
}) {
  const check = (key: 'readonly' | 'autoCommit' | 'writeMetadata', label: string, hint: string) => (
    <label className="flex cursor-pointer gap-2.5 rounded-lg border border-line p-2.5 hover:bg-hover">
      <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.checked })} />
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-fg-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-2">
      {!git && versions && (
        <label className="flex cursor-pointer gap-2.5 rounded-lg border border-line p-2.5 hover:bg-hover">
          <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={versions.on} onChange={(e) => versions.onChange(e.target.checked)} />
          <span>
            <span className="block text-sm">{t('Versionen führen (empfohlen)')}</span>
            <span className="block text-xs text-fg-muted">
              {t('Kaveyl Wiki legt im Ordner ein eigenes Git an: jede Änderung wird eine Version, mit dir als Autor, Gelöschtes kommt aus dem Verlauf zurück – ohne Abgleich mit einem Git-Server. Aus = nur Dateien, ohne Versionen.')}
            </span>
          </span>
        </label>
      )}
      {!git && !versions && (
        <div className="space-y-2 rounded-lg bg-subtle p-2.5 text-xs text-fg-muted">
          <p>{t('Lokaler Ordner ohne Git: Änderungen werden direkt in die Dateien gespeichert – ohne Versionen.')}</p>
          {onVersions && (
            <Button size="sm" onClick={onVersions}>
              {t('Versionen einschalten …')}
            </Button>
          )}
        </div>
      )}
      {git &&
        check(
          'autoCommit',
          type === 'remote' ? t('Änderungen automatisch committen und pushen') : t('Änderungen automatisch committen'),
          type === 'remote'
            ? t('Gespeichert wird sofort; committet und gepusht (mit dir als Autor) wird gebündelt – siehe unten.')
            : t('Standardmäßig aus: Kaveyl Wiki schreibt nur Dateien, Commits machst du (oder deine KI-Session) selbst.'),
        )}
      {((git && value.autoCommit) || (!git && versions?.on)) && (
        <Field
          label={t('Wann deine Änderungen nach Git schreiben?')}
          hint={
            type === 'remote'
              ? t('Commit und Push: beim Verlassen der Notiz und mit Strg+S sofort, wer am Stück schreibt, spätestens alle 10 Minuten. Die andere Richtung – Änderungen anderer holen – läuft alle 5 Minuten, mit Webhook sofort.')
              : t('Commit: beim Verlassen der Notiz und mit Strg+S sofort, wer am Stück schreibt, spätestens alle 10 Minuten. Kein Push und kein Pull – der Ordner gleicht mit keinem Git-Server ab.')
          }
        >
          <select
            className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm"
            value={value.commitIdleSec}
            onChange={(e) => onChange({ ...value, commitIdleSec: Number(e.target.value) })}
          >
            {[
              [10, t('Nach 10 Sekunden Pause (fast sofort)')],
              [120, t('Nach 2 Minuten Pause (Standard)')],
              [300, t('Nach 5 Minuten Pause')],
              [900, t('Nach 15 Minuten Pause')],
            ].map(([sec, label]) => (
              <option key={sec} value={sec}>
                {label}
              </option>
            ))}
            {![10, 120, 300, 900].includes(value.commitIdleSec) && <option value={value.commitIdleSec}>{t('Nach {n} s Pause', { n: value.commitIdleSec })}</option>}
          </select>
        </Field>
      )}
      {check(
        'writeMetadata',
        t('Metadaten ins Frontmatter schreiben'),
        t('IDs/Icons bleiben so auch nach Umbenennen in VS Code erhalten. Aus = Dateien werden nie um Metadaten ergänzt.'),
      )}
      {check('readonly', t('Schreibgeschützt'), t('Inhalte nur lesen – kein Bearbeiten, Anlegen oder Löschen in Kaveyl Wiki.'))}
      <label className="flex cursor-pointer gap-2.5 rounded-lg border border-line p-2.5 hover:bg-hover">
        <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={value.aiMemory !== false} onChange={(e) => onChange({ ...value, aiMemory: e.target.checked })} />
        <span>
          <span className="block text-sm">{t('KI-Gedächtnis')}</span>
          <span className="block text-xs text-fg-muted">
            <Rich
              text={t('Anweisungen und bestätigte Merk-Einträge für die KI in {path} dieser Quelle (nur wirksam, wenn die Quelle für die KI freigegeben ist).')}
              parts={{ path: <code>.kaveyl-wiki/ai/</code> }}
            />
          </span>
        </span>
      </label>
      <AiChatDays value={value.aiChatDays} onChange={(aiChatDays) => onChange({ ...value, aiChatDays })} />
      <Field label={t('Ordner-Notiz')} hint={t('Datei, die als Inhalt ihres Ordners angezeigt wird (Wiki.js nutzt oft home.md).')}>
        <select
          className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm"
          value={value.folderNote}
          onChange={(e) => onChange({ ...value, folderNote: e.target.value })}
        >
          {['index.md', 'home.md', 'README.md', '_index.md'].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Löschregel je Quelle (AD-034): how long unused AI chats about this source stay. */
function AiChatDays({ value, onChange }: { value: number | undefined; onChange: (v: number) => void }) {
  const general = useQuery({ queryKey: ['ai-providers'], queryFn: api.aiProviders }).data?.retentionDays;
  const v = value === undefined || value < 0 ? -1 : value;
  const choices: [number, string][] = [
    [
      -1,
      general === undefined
        ? t('Wie in Einstellungen → KI')
        : general
          ? tn(general, 'Wie in Einstellungen → KI ({n} Tag)', 'Wie in Einstellungen → KI ({n} Tage)')
          : t('Wie in Einstellungen → KI (nie löschen)'),
    ],
    [7, tn(7, '{n} Tag', '{n} Tage')],
    [30, tn(30, '{n} Tag', '{n} Tage')],
    [90, tn(90, '{n} Tag', '{n} Tage')],
    [180, tn(180, '{n} Tag', '{n} Tage')],
    [365, t('1 Jahr')],
    [0, t('Nie löschen')],
  ];
  return (
    <Field label={t('KI-Chats aufbewahren')} hint={t('Chats über Notizen, Ordner oder diese ganze Quelle werden gelöscht, wenn sie so lange unbenutzt sind.')}>
      <select aria-label={t('KI-Chats aufbewahren')} className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm" value={v} onChange={(e) => onChange(Number(e.target.value))}>
        {choices.map(([n, label]) => (
          <option key={n} value={n}>
            {label}
          </option>
        ))}
        {!choices.some(([n]) => n === v) && <option value={v}>{tn(v, '{n} Tag', '{n} Tage')}</option>}
      </select>
    </Field>
  );
}

// ── Edit existing mount ─────────────────────────────────────────────────────────
function EditMount({ mount, onDone }: { mount: Mount; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(mount.name);
  const [icon, setIcon] = useState(mount.icon ?? '');
  const [opts, setOpts] = useState<Opts>(mount.options);
  const [include, setInclude] = useState(mount.include.join('\n'));
  const [exclude, setExclude] = useState(mount.exclude.join('\n'));
  const [paused, setPaused] = useState(mount.paused);
  const [connectionId, setConnectionId] = useState(mount.connection?.id ?? '');
  const connections = useConnections();
  const fitting = connectionsFor(connections.data, mount.source);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Switched on in this dialog: the mount passed in still says „no Git“ until the list is reloaded.
  const [hasGit, setHasGit] = useState(mount.type === 'remote' || !!mount.git);
  const [restored, setRestored] = useState(false);
  const enableVersions = async () => {
    const ok = await confirmDialog(
      t('Versionen für „{name}“ einschalten? Kaveyl Wiki legt im Ordner ein eigenes Git an (versteckter Ordner .git) und speichert ab jetzt jede Änderung als Version. Gelöschtes bleibt danach im Verlauf.', { name: mount.name }),
      { confirmLabel: t('Versionen einschalten') },
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.enableVersions(mount.id);
      setHasGit(true);
      setOpts((o) => ({ ...o, autoCommit: true }));
      await qc.invalidateQueries({ queryKey: ['mounts'] });
      setRestored(r.restored);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const tree = useQuery({
    queryKey: ['source-tree', mount.type, mount.source, mount.branch],
    queryFn: () => api.sourceTree({ type: mount.type, source: mount.source, branch: mount.branch ?? undefined, connectionId: mount.connection?.id ?? null }),
    enabled: picking,
    retry: false,
  });
  const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['mounts'] });
      await qc.invalidateQueries({ queryKey: ['tree', mount.id] });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (picking) {
    if (tree.isPending) return <Spinner />;
    if (tree.isError) return <FormError>{errorText(tree.error)}</FormError>;
    return (
      <Selection
        tree={tree.data}
        onBack={() => setPicking(false)}
        nextLabel={t('Auswahl übernehmen')}
        onNext={(globs) => {
          setInclude(globs.join('\n'));
          setPicking(false);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-subtle p-3 text-xs text-fg-muted">
        <div>
          <strong>{mount.type === 'remote' ? t('Repository:') : t('Ordner:')}</strong> <code>{mount.source}</code>
        </div>
        {mount.branch && (
          <div>
            <strong>{t('Branch:')}</strong> <code>{mount.branch}</code>
          </div>
        )}
        {mount.syncDetail && (
          <div className="mt-1 text-warn">
            <strong>{t('Status:')}</strong> {mount.syncStatus} – {mount.syncDetail}
          </div>
        )}
      </div>
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <IconField value={icon} onChange={setIcon} />
      </div>
      {mount.type === 'remote' && (
        <Field label={t('Verbindung')} hint={t('Zugangsdaten zum Klonen und Pushen. Verbindungen verwaltest du in Einstellungen → Quellen → Verbindungen.')}>
          <select aria-label={t('Verbindung')} className="h-8 w-full rounded-md border border-line bg-bg px-2 text-sm" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">{t('Ohne Anmeldung (öffentliches Repository)')}</option>
            {fitting.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({CONNECTION_LABEL[c.kind]})
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t('Einbinden (Glob-Muster)')}
          hint={
            <button className="text-accent underline" onClick={() => setPicking(true)}>
              {t('Im Baum neu auswählen …')}
            </button>
          }
        >
          <textarea className="h-24 w-full rounded-md border border-line bg-bg p-2 font-mono text-xs" value={include} onChange={(e) => setInclude(e.target.value)} />
        </Field>
        <Field label={t('Ausschließen (Glob-Muster)')}>
          <textarea className="h-24 w-full rounded-md border border-line bg-bg p-2 font-mono text-xs" value={exclude} onChange={(e) => setExclude(e.target.value)} />
        </Field>
      </div>
      <MountOptionsForm type={mount.type} git={hasGit} onVersions={() => void enableVersions()} value={opts} onChange={setOpts} />
      {restored && <p className="text-xs text-fg-muted">{t('Der Verlauf aus der Sicherung im Ordner ist übernommen.')}</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-[var(--accent)]" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
        {mount.type === 'remote' ? t('Pausiert (ausgeblendet, kein Sync)') : t('Pausiert (ausgeblendet)')}
      </label>
      <FormError>{error}</FormError>
      <div className="flex items-center justify-between border-t border-line pt-3">
        {confirmRemove ? (
          // Short on purpose (owner 26.10.): the rest of what happens to the files is in the help.
          <div className="mr-3 space-y-2 text-sm">
            <p>{t('Quelle „{name}“ aus Kaveyl Wiki aushängen?', { name: mount.name })}</p>
            {/* Only repositories leave a copy on the server; a local folder stays as it is. */}
            {mount.type === 'remote' && (
              <p className="text-fg-muted">
                {t('Die lokale Kopie auf dem Server wird nach der Frist unter Einstellungen → Werkzeuge → Aufräumen → „Verwaiste Kopien aufbewahren“ gelöscht.')}
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => api.deleteMount(mount.id))}>
                {t('Aushängen')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                {t('Nein')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" className="text-danger" onClick={() => setConfirmRemove(true)}>
            {t('Aushängen …')}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(() =>
              api.updateMount(mount.id, {
                name: name.trim(),
                icon: icon.trim() || null,
                options: hasGit ? opts : { ...opts, autoCommit: false },
                include: lines(include),
                exclude: lines(exclude),
                paused,
                ...(mount.type === 'remote' && connectionId !== (mount.connection?.id ?? '') ? { connectionId: connectionId || null } : {}),
              }),
            )
          }
        >
          {busy && <Spinner />} {t('Speichern')}
        </Button>
      </div>
    </div>
  );
}

/** Icon of a source: the same picker as for notes (symbols, emoji, own icons); empty = automatic (Git / folder). */
function IconField({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  const [open, setOpen] = useState(false);
  // Older sources store a bare emoji; the picker works with `emoji:…`.
  const current = value ? (/^(lucide|emoji|custom):/.test(value) ? value : `emoji:${value}`) : null;
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-fg-muted">{t('Icon')}</span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" aria-label={t('Icon der Quelle')} className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-line-control text-xs text-fg-muted hover:border-fg-faint hover:bg-hover">
            {current ? <IconGlyph icon={current} /> : t('automatisch')}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <PopoverContent align="end" sideOffset={4} className="z-[70] p-3">
            <IconPicker
              value={current}
              onPick={(i) => {
                setOpen(false);
                onChange(i ?? '');
              }}
            />
          </PopoverContent>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
