// Why autosave failed – decides what the status line says and which way out it offers (design-003).
import { ApiError, errorText } from '../api';
import { t } from '../i18n';

export type SaveFailureKind = 'offline' | 'signedOut' | 'otherUser' | 'gone' | 'server' | 'rejected';
export interface SaveFailure {
  kind: SaveFailureKind;
  /** Short, shown in the header. */
  label: string;
  /** Cause and way out, shown on click and read by screen readers. */
  detail: string;
}

export function saveFailure(e: unknown, online = typeof navigator === 'undefined' || navigator.onLine): SaveFailure {
  // fetch() rejects with a TypeError when the server cannot be reached at all.
  if (!(e instanceof ApiError) && (!online || e instanceof TypeError))
    return { kind: 'offline', label: t('Keine Verbindung'), detail: t('Deine Änderungen bleiben in diesem Tab und werden automatisch gespeichert, sobald der Server wieder erreichbar ist.') };
  const message = errorText(e);
  if (!(e instanceof ApiError)) return { kind: 'rejected', label: t('Nicht gespeichert'), detail: message };
  if (e.status === 401)
    return { kind: 'signedOut', label: t('Abgemeldet'), detail: t('Deine Sitzung ist abgelaufen. Melde dich in einem neuen Tab an – danach speichert Kaveyl Wiki hier automatisch.') };
  // Refused in the browser before sending or by the server (code-012): never under another account's session.
  if (e.status === 403 && e.body.code === 'other-user')
    return {
      kind: 'otherUser',
      label: t('Anderes Konto angemeldet'),
      detail: t('In diesem Browser ist inzwischen ein anderes Konto angemeldet. Gespeichert wird nur unter dem Konto, mit dem die Notiz geöffnet wurde.'),
    };
  if (e.status === 404)
    return { kind: 'gone', label: t('Notiz nicht mehr vorhanden'), detail: t('Die Notiz wurde gelöscht oder verschoben – wie du deine Fassung sicherst, steht im Hinweis über dem Text.') };
  if (e.status >= 500)
    return {
      kind: 'server',
      label: t('Serverfehler'),
      detail: t('{message} – Kaveyl Wiki versucht es automatisch erneut. Hält der Fehler an, findet ein Administrator die Ursache im Server-Protokoll.', { message }),
    };
  return { kind: 'rejected', label: t('Nicht gespeichert'), detail: message };
}
