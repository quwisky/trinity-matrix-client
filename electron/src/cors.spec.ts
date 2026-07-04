import { beforeEach, describe, expect, it, vi } from 'vitest';

// cors.ts pulls APP_ORIGIN from ./scheme, whose module load imports `electron`.
// Stub it so the graph resolves under the node test env (protocol is only used
// inside scheme.ts functions we never call here).
vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import { installMatrixCors } from './cors';

const APP_ORIGIN = 'trinity://app';

type Details = { method: string; responseHeaders?: Record<string, string[]> };
type Handler = (
  details: Details,
  callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
) => void;

/** Fake session capturing the onHeadersReceived filter + handler, with a helper
 * to drive the handler and return the headers it hands back via `callback`. */
function fakeSession() {
  let filter: { urls: string[] } | undefined;
  let handler: Handler | undefined;
  const session = {
    webRequest: {
      onHeadersReceived: vi.fn((f: { urls: string[] }, h: Handler) => {
        filter = f;
        handler = h;
      }),
    },
  };
  return {
    session: session as unknown as Electron.Session,
    onHeadersReceived: session.webRequest.onHeadersReceived,
    getFilter: () => filter,
    run: (details: Details): Record<string, string[]> => {
      let out: { responseHeaders?: Record<string, string[]> } | undefined;
      handler?.(details, (r) => (out = r));
      return out?.responseHeaders ?? {};
    },
  };
}

/** Case-insensitive lookup of a single header's values. */
function pick(headers: Record<string, string[]>, name: string): string[] {
  const key = Object.keys(headers).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : [];
}

/** All keys (any casing) matching a header name — to catch duplicates. */
function keysFor(headers: Record<string, string[]>, name: string): string[] {
  return Object.keys(headers).filter(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
}

describe('installMatrixCors', () => {
  let s: ReturnType<typeof fakeSession>;

  beforeEach(() => {
    s = fakeSession();
    installMatrixCors(s.session);
  });

  it('scopes the interceptor to remote http(s) URLs only (never trinity://app)', () => {
    expect(s.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(s.getFilter()).toEqual({ urls: ['https://*/*', 'http://*/*'] });
  });

  it('adds Access-Control-Allow-Origin: trinity://app to a normal GET response', () => {
    const headers = s.run({
      method: 'GET',
      responseHeaders: { 'Content-Type': ['application/json'] },
    });
    expect(pick(headers, 'Access-Control-Allow-Origin')).toEqual([APP_ORIGIN]);
    // Unrelated headers are preserved.
    expect(pick(headers, 'Content-Type')).toEqual(['application/json']);
    // A GET is not a preflight — no methods/headers/max-age injected.
    expect(pick(headers, 'Access-Control-Allow-Methods')).toEqual([]);
    expect(pick(headers, 'Access-Control-Allow-Headers')).toEqual([]);
    expect(pick(headers, 'Access-Control-Max-Age')).toEqual([]);
  });

  it('adds only Access-Control-Allow-Origin to a non-preflight POST (no preflight headers)', () => {
    const headers = s.run({ method: 'POST', responseHeaders: {} });
    expect(pick(headers, 'Access-Control-Allow-Origin')).toEqual([APP_ORIGIN]);
    // POST is not a preflight — the OPTIONS-only headers must NOT be injected.
    expect(pick(headers, 'Access-Control-Allow-Methods')).toEqual([]);
    expect(pick(headers, 'Access-Control-Allow-Headers')).toEqual([]);
    expect(pick(headers, 'Access-Control-Max-Age')).toEqual([]);
  });

  it('handles a missing responseHeaders object', () => {
    const headers = s.run({ method: 'GET' });
    expect(pick(headers, 'Access-Control-Allow-Origin')).toEqual([APP_ORIGIN]);
  });

  it('answers an OPTIONS preflight with the methods, headers and max-age', () => {
    const headers = s.run({ method: 'OPTIONS', responseHeaders: {} });
    expect(pick(headers, 'Access-Control-Allow-Origin')).toEqual([APP_ORIGIN]);
    expect(pick(headers, 'Access-Control-Allow-Methods')).toEqual([
      'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    ]);
    // Authorization must be listed explicitly — `*` never covers it.
    expect(pick(headers, 'Access-Control-Allow-Headers')).toEqual([
      'Authorization, Content-Type',
    ]);
    expect(pick(headers, 'Access-Control-Max-Age')).toEqual(['86400']);
  });

  it('replaces server-supplied CORS headers instead of duplicating them', () => {
    const headers = s.run({
      method: 'GET',
      responseHeaders: {
        // A server that already answers CORS — and a differently-cased dupe.
        'Access-Control-Allow-Origin': ['https://homeserver.example'],
        'access-control-allow-origin': ['https://other.example'],
        'Access-Control-Allow-Methods': ['GET'],
        'X-Keep': ['1'],
      },
    });
    // Exactly ONE ACAO survives (a duplicate makes Chromium reject the response)…
    expect(keysFor(headers, 'Access-Control-Allow-Origin')).toHaveLength(1);
    // …and it's ours, not the origin's.
    expect(pick(headers, 'Access-Control-Allow-Origin')).toEqual([APP_ORIGIN]);
    // The server's stale ACAM is dropped on a non-preflight request.
    expect(pick(headers, 'Access-Control-Allow-Methods')).toEqual([]);
    // Non-CORS headers are untouched.
    expect(pick(headers, 'X-Keep')).toEqual(['1']);
  });
});
