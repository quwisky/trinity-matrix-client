import { beforeEach, describe, expect, it, vi } from 'vitest';

// cors.ts pulls APP_ORIGIN from ./scheme, whose module load imports `electron`.
// Stub it so the graph resolves under the node test env (protocol is only used
// inside scheme.ts functions we never call here).
vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('./cors-probe', () => ({ probeMatrixOrigin: probe }));

import {
  allowCorsOrigin,
  allowedCorsOrigins,
  installMatrixCors,
  setAllowedCorsOrigins,
} from './cors';

const APP_ORIGIN = 'trinity://app';
/** A homeserver the renderer has declared (the only kind the shim rewrites for). */
const HS = 'https://hs.example';
const ACAO_NAME = 'access-control-allow-origin';

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
    handle: (details: Details, callback: Parameters<Handler>[1]): void =>
      handler?.(details, callback),
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

/** Let every probe that has answered reach the shim. */
const probesSettled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

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

  beforeEach(async () => {
    probe.mockReset().mockResolvedValue('homeserver');
    s = fakeSession();
    installMatrixCors(s.session);
    // The renderer declares its live origin set; without it nothing is rewritten.
    setAllowedCorsOrigins([HS]);
    await probesSettled();
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

  beforeEach(async () => {
    probe.mockReset().mockResolvedValue('homeserver');
    s = fakeSession();
    installMatrixCors(s.session);
    setAllowedCorsOrigins([HS]);
    await probesSettled();
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

  it('follows the renderer as its origin set changes (account switch / sign-out)', async () => {
    const other = 'https://other.example';
    expect(
      s.run({ method: 'GET', url: `${other}/x`, responseHeaders: {} }),
    ).toEqual({});

    setAllowedCorsOrigins([HS, other]); // a second account signs in
    await probesSettled();
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

describe('CORS boundary (main confirms an origin is a Matrix server itself)', () => {
  let s: ReturnType<typeof fakeSession>;
  let n = 0;
  /** A fresh origin per case: what main learned about one lasts the session. */
  const freshOrigin = (): string => `https://fresh-${(n += 1)}.example`;

  beforeEach(() => {
    probe.mockReset().mockResolvedValue('homeserver');
    s = fakeSession();
    installMatrixCors(s.session);
    setAllowedCorsOrigins([]);
  });

  // The audit's case: script in the page names an intranet host and reads it.
  it('does not rewrite an origin the renderer named when the probe refuses it', async () => {
    const intranet = 'https://10.0.0.5';
    probe.mockResolvedValue('refused');

    allowCorsOrigin(intranet);
    await probesSettled();

    expect(probe).toHaveBeenCalledWith(intranet);
    expect(
      s.run({ method: 'GET', url: `${intranet}/admin`, responseHeaders: {} }),
    ).toEqual({});
  });

  it('holds a response that arrives while the probe is pending, then rewrites it', async () => {
    const origin = freshOrigin();
    let answer: (result: string) => void = () => undefined;
    probe.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let out: { responseHeaders?: Record<string, string[]> } | undefined;

    allowCorsOrigin(origin);
    s.handle(
      { method: 'GET', url: `${origin}/_matrix/client/versions` },
      (r) => (out = r),
    );
    await probesSettled();
    expect(out).toBeUndefined();

    answer('homeserver');
    await probesSettled();
    expect(pick(out?.responseHeaders ?? {}, ACAO_NAME)).toEqual([APP_ORIGIN]);
  });

  it('releases a held response untouched when the probe refuses', async () => {
    const origin = freshOrigin();
    probe.mockResolvedValue('refused');
    let out: { responseHeaders?: Record<string, string[]> } | undefined;

    allowCorsOrigin(origin);
    s.handle({ method: 'GET', url: `${origin}/x` }, (r) => (out = r));
    await probesSettled();

    expect(out).toEqual({});
  });

  it('releases a held response untouched when the origin was withdrawn meanwhile', async () => {
    const origin = freshOrigin();
    let out: { responseHeaders?: Record<string, string[]> } | undefined;

    allowCorsOrigin(origin);
    s.handle({ method: 'GET', url: `${origin}/x` }, (r) => (out = r));
    setAllowedCorsOrigins([]);
    await probesSettled();

    expect(out).toEqual({});
  });

  // Offline start: the stored account's homeserver cannot be reached yet.
  it('asks again once an unreachable origin answers, instead of remembering the failure', async () => {
    const origin = freshOrigin();
    probe.mockResolvedValue('unreachable');
    setAllowedCorsOrigins([origin]);
    await probesSettled();

    probe.mockResolvedValue('homeserver');
    let out: { responseHeaders?: Record<string, string[]> } | undefined;
    s.handle({ method: 'GET', url: `${origin}/x` }, (r) => (out = r));
    await probesSettled();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(pick(out?.responseHeaders ?? {}, ACAO_NAME)).toEqual([APP_ORIGIN]);
  });

  it('does not probe a refused origin again straight away', async () => {
    const origin = freshOrigin();
    probe.mockResolvedValue('refused');

    allowCorsOrigin(origin);
    await probesSettled();
    allowCorsOrigin(origin);
    s.run({ method: 'GET', url: `${origin}/x` });
    await probesSettled();

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('probes a confirmed origin once for the session', async () => {
    const origin = freshOrigin();

    allowCorsOrigin(origin);
    await probesSettled();
    setAllowedCorsOrigins([origin]);
    setAllowedCorsOrigins([]);
    setAllowedCorsOrigins([origin]);
    await probesSettled();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(
      pick(s.run({ method: 'GET', url: `${origin}/x` }), ACAO_NAME),
    ).toEqual([APP_ORIGIN]);
  });

  it('rewrites only the well-known documents of a host that is not itself a homeserver', async () => {
    const origin = freshOrigin();
    probe.mockResolvedValue('well-known');

    allowCorsOrigin(origin);
    await probesSettled();

    expect(
      pick(
        s.run({ method: 'GET', url: `${origin}/.well-known/matrix/client` }),
        ACAO_NAME,
      ),
    ).toEqual([APP_ORIGIN]);
    expect(s.run({ method: 'GET', url: `${origin}/index.html` })).toEqual({});
  });

  it('never allows an http origin', async () => {
    allowCorsOrigin('http://hs.example');
    setAllowedCorsOrigins(['http://hs.example']);
    await probesSettled();

    expect(probe).not.toHaveBeenCalled();
    expect(allowedCorsOrigins()).toEqual([]);
  });

  // Last: it spends the session's budget.
  it('stops probing new origins once the session has probed its share', async () => {
    probe.mockResolvedValue('refused');

    for (let i = 0; i < 150; i += 1) {
      allowCorsOrigin(`https://scan-${i}.example`);
    }
    await probesSettled();

    expect(probe.mock.calls.length).toBeLessThanOrEqual(100);
    expect(probe).not.toHaveBeenCalledWith('https://scan-149.example');
  });
});
