import { beforeEach, describe, expect, it, vi } from 'vitest';

// cors.ts pulls APP_ORIGIN from ./scheme, whose module load imports `electron`.
// Stub it so the graph resolves under the node test env (protocol is only used
// inside scheme.ts functions we never call here).
vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import {
  allowedCorsOrigins,
  installMatrixCors,
  setAllowedCorsOrigins,
} from './cors';

const APP_ORIGIN = 'trinity://app';
/** A homeserver the renderer has declared (the only kind the shim rewrites for). */
const HS = 'https://hs.example';

type Details = {
  method: string;
  url?: string;
  responseHeaders?: Record<string, string[]>;
};
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
      // Default to the declared homeserver so the existing cases keep testing the
      // rewrite itself; the scoping cases pass an explicit url.
      handler?.(
        { url: `${HS}/_matrix/client/v3/sync`, ...details },
        (r) => (out = r),
      );
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
    // The renderer declares its live origin set; without it nothing is rewritten.
    setAllowedCorsOrigins([HS]);
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

describe('CORS scoping (the shim only serves declared origins)', () => {
  let s: ReturnType<typeof fakeSession>;

  beforeEach(() => {
    s = fakeSession();
    installMatrixCors(s.session);
    setAllowedCorsOrigins([HS]);
  });

  // The point of the allowlist. The app renders untrusted federated message HTML, so a
  // future sanitizer bypass must NOT inherit a read-anywhere primitive: without this,
  // the shim told the renderer it could read cross-origin bodies from ANY https origin.
  it('does not rewrite a third-party origin', () => {
    const headers = s.run({
      method: 'GET',
      url: 'https://evil.example/secrets',
      responseHeaders: { 'content-type': ['application/json'] },
    });

    // `callback({})` with no responseHeaders is Electron's "leave this response
    // alone" — the server's own headers stand, and we inject no ACAO.
    expect(headers).toEqual({});
    expect(pick(headers, 'access-control-allow-origin')).toEqual([]);
  });

  it('rewrites the declared homeserver', () => {
    const headers = s.run({
      method: 'GET',
      url: `${HS}/_matrix/client/v3/sync`,
      responseHeaders: {},
    });

    expect(pick(headers, 'access-control-allow-origin')).toEqual([APP_ORIGIN]);
  });

  it('follows the renderer as its origin set changes (account switch / sign-out)', () => {
    const other = 'https://other.example';
    expect(
      s.run({ method: 'GET', url: `${other}/x`, responseHeaders: {} }),
    ).toEqual({});

    setAllowedCorsOrigins([HS, other]); // a second account signs in
    expect(
      pick(
        s.run({ method: 'GET', url: `${other}/x`, responseHeaders: {} }),
        'access-control-allow-origin',
      ),
    ).toEqual([APP_ORIGIN]);

    setAllowedCorsOrigins([]); // …and everyone signs out
    expect(
      s.run({ method: 'GET', url: `${HS}/x`, responseHeaders: {} }),
    ).toEqual({});
  });

  it('normalises what the renderer publishes to bare origins', () => {
    setAllowedCorsOrigins([`${HS}/_matrix/client/`, 'https://two.example:443']);

    expect(allowedCorsOrigins()).toEqual([HS, 'https://two.example']);
  });

  it('ignores junk rather than throwing or wiping the list open', () => {
    setAllowedCorsOrigins(['not a url', '', HS]);

    expect(allowedCorsOrigins()).toEqual([HS]);
  });

  it('rewrites nothing at all before the renderer has declared anything', () => {
    setAllowedCorsOrigins([]);

    expect(
      s.run({ method: 'GET', url: `${HS}/x`, responseHeaders: {} }),
    ).toEqual({});
  });
});
