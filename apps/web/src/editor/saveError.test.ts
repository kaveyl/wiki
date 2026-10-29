// Why autosave failed decides what the status line says and which way out it offers (design-003): no connection,
// signed out, note gone, server error – each with its own text instead of one "Speichern fehlgeschlagen".
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { saveFailure } from './saveError';

describe('saveFailure', () => {
  it('network failure or browser offline: no connection, saved automatically later', () => {
    const f = saveFailure(new TypeError('Failed to fetch'), true);
    expect(f.kind).toBe('offline');
    expect(f.label).toBe('Keine Verbindung');
    expect(f.detail).toMatch(/automatisch gespeichert, sobald der Server wieder erreichbar ist/);
    expect(saveFailure(new Error('egal'), false).kind).toBe('offline');
  });

  it('401: signed out, sign in again in a new tab', () => {
    const f = saveFailure(new ApiError(401, 'Nicht angemeldet', {}), true);
    expect(f.kind).toBe('signedOut');
    expect(f.label).toBe('Abgemeldet');
    expect(f.detail).toMatch(/neuen Tab an/);
  });

  it('404: the note is gone – the conflict banner above the text shows the way out', () => {
    const f = saveFailure(new ApiError(404, 'Nicht gefunden', {}), true);
    expect(f.kind).toBe('gone');
    expect(f.detail).toMatch(/Hinweis über dem Text/);
  });

  it('5xx: server error with its message, retried automatically', () => {
    const f = saveFailure(new ApiError(500, 'Interner Fehler', {}), true);
    expect(f.kind).toBe('server');
    expect(f.label).toBe('Serverfehler');
    expect(f.detail).toMatch(/^Interner Fehler – Kaveyl Wiki versucht es automatisch erneut/);
    expect(saveFailure(new ApiError(503, 'Server nicht erreichbar', {}), true).kind).toBe('server');
  });

  it('other refusals (no write access, too large …): the server message', () => {
    const f = saveFailure(new ApiError(403, 'Keine Schreibrechte', {}), true);
    expect(f.kind).toBe('rejected');
    expect(f.label).toBe('Nicht gespeichert');
    expect(f.detail).toBe('Keine Schreibrechte');
  });

  it('another account signed in (refused in the browser or by the server): says so, nothing is saved under it (code-012)', () => {
    const f = saveFailure(new ApiError(403, 'Inzwischen ist hier ein anderes Konto angemeldet – nichts gespeichert', { code: 'other-user' }), true);
    expect(f.kind).toBe('otherUser');
    expect(f.label).toBe('Anderes Konto angemeldet');
    expect(f.detail).toMatch(/nur unter dem Konto, mit dem die Notiz geöffnet wurde/);
  });
});
