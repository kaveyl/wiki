// Responses that are not JSON (error pages of a proxy in front) arrive as ApiError with the status, not as SyntaxError.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

const respond = (status: number, body: string, type = 'application/json') =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(status === 204 ? null : body, { status, headers: { 'content-type': type } })));

const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';

async function failure(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  it('passes JSON through', async () => {
    respond(200, '{"user":null,"setupRequired":false,"mail":false}');
    expect(await api.session()).toEqual({ user: null, setupRequired: false, mail: false });
  });

  it('accepts an empty success (204)', async () => {
    respond(204, '');
    expect(await api.logout()).toBeNull();
  });

  it('keeps the error text of the server', async () => {
    respond(409, '{"error":"Konflikt"}');
    const e = await failure(api.session());
    expect([e.status, e.message, e.body]).toEqual([409, 'Konflikt', { error: 'Konflikt' }]);
  });

  it('turns a proxy error page into an ApiError with the status', async () => {
    respond(502, html, 'text/html');
    const e = await failure(api.session());
    expect([e.status, e.message]).toEqual([502, 'Server nicht erreichbar']);
  });

  it('names a gateway timeout and other statuses understandably', async () => {
    respond(504, html, 'text/html');
    expect((await failure(api.session())).message).toBe('Server nicht erreichbar');
    respond(500, html, 'text/html');
    expect((await failure(api.session())).message).toBe('Unerwartete Antwort vom Server (HTTP 500)');
  });

  it('reports a sign-in page that came instead of JSON', async () => {
    respond(200, '<html>Sign in</html>', 'text/html');
    const e = await failure(api.session());
    expect(e.message).toBe('Unerwartete Antwort vom Server (HTTP 200)');
  });
});

describe('uploadBinary', () => {
  const file = new File(['x'], 'a.png');

  it('turns 413 from the proxy into "too large"', async () => {
    respond(413, '<html><h1>413 Request Entity Too Large</h1></html>', 'text/html');
    const e = await failure(api.uploadIcon(file));
    expect([e.status, e.message]).toEqual([413, 'Zu groß für den Server']);
  });

  it('keeps the error text of the server', async () => {
    respond(400, '{"error":"Kein Bild"}');
    const e = await failure(api.uploadIcon(file));
    expect([e.status, e.message]).toEqual([400, 'Kein Bild']);
  });
});

describe('aiAgent', () => {
  // Under HTTP/2 there is no status text, so the message must not depend on it.
  it('turns a proxy error page into an ApiError with the status', async () => {
    respond(502, html, 'text/html');
    const e = await failure(api.aiAgent({ question: 'x', scope: { kind: 'all' } }, () => {}));
    expect([e.status, e.message]).toEqual([502, 'Server nicht erreichbar']);
  });

  it('keeps the error text of the server', async () => {
    respond(403, '{"error":"Keine Freigabe"}');
    const e = await failure(api.aiAgent({ question: 'x', scope: { kind: 'all' } }, () => {}));
    expect([e.status, e.message]).toEqual([403, 'Keine Freigabe']);
  });
});
