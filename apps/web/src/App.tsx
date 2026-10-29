// Entry: shows first-run setup, login, a page behind a mail link, or the workspace.
import { Suspense, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText, type User } from './api';
import { t, tn } from './i18n';
import { Button, Modal, PartLoading, confirmDialog } from './ui';
import { WorkspaceUser, countUnsaved, discardUnsaved, saveAllUnsaved, sessionScreen, unsavedText, useUnsaved } from './unsaved';
import { copyText } from './clipboard';
import { toast } from './toast';
import { ForcePasswordChange, LoginPage, Logo, MailLinkPage, SetupPage, takeMailLink } from './auth/AuthPages';
import { lazyPart } from './lazyPart';
import { reloadingOnce } from './loading';

export { Logo };
/** main.tsx puts it around the app: whatever fails while rendering shows a message, never a blank page (code-004). */
export { PartBoundary } from './lazyPart';

const RELOADED = 'kaveyl-wiki-shell-reload';
/** The workspace (editor, highlighting, YAML …) loads only after sign-in, not with the login page (seo-005). */
const Shell = lazyPart(() => reloadingOnce(RELOADED, import('./shell/Shell')).then((m) => m.Shell));

function Loading() {
  return <PartLoading className="h-full" />;
}

/** Read once per page load (module scope: StrictMode would call a state initializer twice). */
const initialMailLink = takeMailLink();

export function App() {
  const [mailLink, setMailLink] = useState(initialMailLink);
  // A mail link opened in a tab where Kaveyl Wiki already runs only changes the hash.
  useEffect(() => {
    const onHash = () => {
      const link = takeMailLink();
      if (link) setMailLink(link);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, staleTime: Infinity });
  const unsaved = useUnsaved((s) => countUnsaved(s.notes));
  const discarded = useUnsaved((s) => s.discarded);
  // The user whose workspace is open: it stays while unsaved changes outlive the session (code-012).
  const [kept, setKept] = useState<User | null>(null);
  const user = session.data?.user ?? null;
  const signedIn = !!user && !user.mustChangePassword;
  const screen = sessionScreen({
    error: session.isError,
    signedIn,
    otherUser: signedIn && kept !== null && kept.id !== user.id,
    shellShown: kept !== null,
    unsaved,
    discarded,
  });
  // A discard applies to the workspace that was open: once it is gone (login, another account), the next starts afresh.
  // An effect, so the editors of the closed workspace still see it while unmounting (they then send nothing more).
  const shownId = screen === 'shell' ? user?.id : screen === 'login' || screen === 'error' ? undefined : kept?.id;
  useEffect(() => {
    if (useUnsaved.getState().discarded) useUnsaved.setState({ discarded: false });
  }, [shownId]);
  if (session.isPending) return <Loading />;
  if (screen === 'error') {
    // Also the offline shell of the installed app (Phase 7): no server, no notes.
    const offline = !navigator.onLine;
    return (
      <Centered title={offline ? t('Offline') : t('Server nicht erreichbar')}>
        <p className="mb-4 text-sm text-fg-muted">
          {offline ? t('Kaveyl braucht eine Verbindung zum Server – Notizen werden nicht auf dem Gerät gespeichert.') : errorText(session.error)}
        </p>
        <Button size="sm" onClick={() => void session.refetch()}>
          {t('Erneut versuchen')}
        </Button>
      </Centered>
    );
  }
  if (mailLink) return <MailLinkPage token={mailLink.token} onDone={() => setMailLink(null)} />;
  if (session.data?.setupRequired) return <SetupPage needsCode={!!session.data.setupCode} restoring={!!session.data.restoring} />;
  if (screen === 'login') {
    if (kept) setKept(null);
    if (!user) return <LoginPage mail={!!session.data?.mail} />;
    return <ForcePasswordChange user={user} />;
  }
  if (screen === 'shell' && kept !== user) setKept(user);
  // Another account signed in meanwhile: its own workspace, not the one of before – once nothing is left unsaved.
  const shown = screen === 'shell' ? user! : kept!;
  return (
    <>
      <WorkspaceUser.Provider value={shown.id}>
        <Suspense fallback={<Loading />}>
          <Shell key={shown.id} user={shown} />
        </Suspense>
      </WorkspaceUser.Provider>
      {screen === 'hold' && <SignedOutUnsaved count={unsaved} />}
      {screen === 'other' && <OtherAccountUnsaved count={unsaved} before={kept!} now={user!} />}
      {screen === 'offline' && <ServerGoneUnsaved count={unsaved} onRetry={() => void session.refetch()} />}
    </>
  );
}

/**
 * Another account signed in meanwhile (another tab – the cookie is shared) while editors hold changes of the account
 * before: they are never saved under the new one (code-012). Copy them out, sign in as before again, or discard them.
 */
function OtherAccountUnsaved({ count, before, now }: { count: number; before: User; now: User }) {
  const qc = useQueryClient();
  const copy = async () => {
    if (await copyText(unsavedText())) toast({ kind: 'ok', title: tn(count, '{n} Notiz in die Zwischenablage kopiert', '{n} Notizen in die Zwischenablage kopiert') });
    else toast({ kind: 'error', title: t('Nicht kopiert') });
  };
  const discard = async () => {
    const ok = await confirmDialog(tn(count, 'Die Änderungen an {n} Notiz gehen verloren. Trotzdem verwerfen?', 'Die Änderungen an {n} Notizen gehen verloren. Trotzdem verwerfen?'), {
      confirmLabel: t('Verwerfen'),
      danger: true,
    });
    if (ok) discardUnsaved();
  };
  return (
    <Modal open onOpenChange={() => undefined} noClose title={t('Anderes Konto angemeldet')} help="speichern-übertragen-und-synchronisieren">
      <p role="alert" className="text-sm">
        {t('Hier ist jetzt {now} angemeldet – die nicht gespeicherten Änderungen von {before} werden nicht gespeichert. Inhalte vorher herauskopieren oder als {before} anmelden.', {
          now: now.displayName,
          before: before.displayName,
        })}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => void copy()}>
          {t('Inhalte kopieren')}
        </Button>
        <Button size="sm" onClick={() => void qc.refetchQueries({ queryKey: ['session'] })}>
          {t('Erneut prüfen')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void discard()}>
          {t('Änderungen verwerfen')}
        </Button>
      </div>
    </Modal>
  );
}

/** The server is gone for a moment while editors hold unsaved changes: the workspace stays, they save once it is back. */
function ServerGoneUnsaved({ count, onRetry }: { count: number; onRetry: () => void }) {
  return (
    <div role="alert" className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-2 border-b border-line bg-bg px-3 py-2 text-sm shadow-pop" data-print="hide">
      <span>
        {tn(
          count,
          'Server nicht erreichbar. {n} Notiz ist noch nicht gespeichert – sie wird gespeichert, sobald der Server wieder da ist. Lass diesen Tab offen.',
          'Server nicht erreichbar. {n} Notizen sind noch nicht gespeichert – sie werden gespeichert, sobald der Server wieder da ist. Lass diesen Tab offen.',
        )}
      </span>
      <Button size="sm" onClick={onRetry}>
        {t('Erneut versuchen')}
      </Button>
    </div>
  );
}

/**
 * The session ended while editors hold unsaved changes: the workspace stays under this hint until they are saved
 * (signed in again in another tab – the cookie is shared) or discarded. Never put in storage (encrypted notes).
 */
function SignedOutUnsaved({ count }: { count: number }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const saveNow = async () => {
    setBusy(true);
    await saveAllUnsaved();
    // Signed in again: the workspace comes back (also by itself once the live connection is up again).
    await qc.refetchQueries({ queryKey: ['session'] });
    setBusy(false);
    setTried(true);
  };
  const discard = async () => {
    const ok = await confirmDialog(tn(count, 'Die Änderungen an {n} Notiz gehen verloren. Trotzdem abmelden?', 'Die Änderungen an {n} Notizen gehen verloren. Trotzdem abmelden?'), {
      confirmLabel: t('Verwerfen'),
      cancelLabel: t('Weiter bearbeiten'),
      danger: true,
    });
    if (ok) discardUnsaved();
  };
  return (
    <Modal open onOpenChange={() => undefined} noClose title={t('Abgemeldet')} help="speichern-übertragen-und-synchronisieren">
      <p role="alert" className="text-sm">
        {tn(
          count,
          'Du bist abgemeldet. {n} Notiz ist noch nicht gespeichert. Melde dich in einem neuen Tab an und klicke dann hier auf „Jetzt speichern“.',
          'Du bist abgemeldet. {n} Notizen sind noch nicht gespeichert. Melde dich in einem neuen Tab an und klicke dann hier auf „Jetzt speichern“.',
        )}
      </p>
      {tried && <p className="mt-2 text-sm text-fg-muted">{t('Noch nicht wieder angemeldet – bitte zuerst im neuen Tab anmelden.')}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => window.open('/', '_blank', 'noopener')}>
          {t('In neuem Tab anmelden')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void saveNow()}>
          {t('Jetzt speichern')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void discard()}>
          {t('Änderungen verwerfen und abmelden')}
        </Button>
      </div>
    </Modal>
  );
}

function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-subtle p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-bg p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <Logo />
          <h1 className="text-base font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
