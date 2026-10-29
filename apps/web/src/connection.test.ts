import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { afterClose, connectionLost, unreachable } from './connection';

describe('connection to the server (design-004)', () => {
  it('counts network errors and proxy/gateway failures as unreachable, not refusals', () => {
    expect(unreachable(new TypeError('Failed to fetch'))).toBe(true);
    for (const status of [502, 503, 504]) expect(unreachable(new ApiError(status, 'x', {}))).toBe(true);
    for (const status of [400, 401, 403, 404, 500]) expect(unreachable(new ApiError(status, 'x', {}))).toBe(false);
    expect(unreachable(null)).toBe(false);
  });

  it('a live connection that was open and closed is lost; one that never opened is not (proxy without WebSockets)', () => {
    expect(afterClose('open')).toBe('lost');
    expect(afterClose('lost')).toBe('lost');
    expect(afterClose('pending')).toBe('pending');
  });

  it('is lost when the live connection dropped or the status query found no server', () => {
    expect(connectionLost({ live: 'open', statusError: null })).toBe(false);
    expect(connectionLost({ live: 'pending', statusError: null })).toBe(false);
    expect(connectionLost({ live: 'lost', statusError: null })).toBe(true);
    expect(connectionLost({ live: 'open', statusError: new TypeError('Failed to fetch') })).toBe(true);
    expect(connectionLost({ live: 'pending', statusError: new ApiError(503, 'x', {}) })).toBe(true);
    // The server answered – it is there, the error is something else.
    expect(connectionLost({ live: 'open', statusError: new ApiError(500, 'x', {}) })).toBe(false);
    expect(connectionLost({ live: 'open', statusError: new ApiError(401, 'x', {}) })).toBe(false);
  });

  it('is lost as soon as the browser reports no network – status queries then pause instead of failing', () => {
    expect(connectionLost({ live: 'open', statusError: null, online: false })).toBe(true);
    expect(connectionLost({ live: 'pending', statusError: null, online: false })).toBe(true);
    expect(connectionLost({ live: 'open', statusError: null, online: true })).toBe(false);
  });
});
