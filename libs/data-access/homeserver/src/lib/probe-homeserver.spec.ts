import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCapabilities,
  fetchSpecVersions,
  probeServerSoftware,
} from './probe-homeserver';

/**
 * The fixtures below are the real answers, measured against the live network while this was
 * written, not invented shapes. Two of them are the reason the probe has a second attempt at
 * all — see `probe-homeserver.ts`.
 */
const BASE_URL = 'https://matrix-client.example.org';
const SERVER_NAME = 'example.org';

/** matrix.org's actual answer. Note the build suffix: this is not semver. */
const MATRIX_ORG_VERSION = '1.158.0 (b=matrix-org-hotfixes-priv,5569b9e479)';

/** What `matrix-client.matrix.org` really returns for the federation endpoint. */
const HTML_404 =
  '<html><body><h1>404 Not Found</h1>\nThe resource could not be found.';

type Handler = () => unknown;

/** Minimal stand-in for a `Response` — the probe reads only these three members. */
const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 404,
  json: async () => body,
});

/** A 200 whose body is not JSON, which is how an HTML error page under a 200 arrives. */
const htmlResponse = (body: string) => ({
  ok: true,
  status: 200,
  json: async () => JSON.parse(body),
});

/**
 * Route `globalThis.fetch` by URL. An **unrouted** URL throws rather than resolving, so a
 * request the probe should never have made cannot hide inside its best-effort `catchError`
 * and pass as a clean "unknown". That is the whole reason this is routed rather than a
 * blanket `mockResolvedValue`.
 */
function stubFetch(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (url: URL | string, _init?: RequestInit) => {
    const key = String(url);
    const handler = routes[key];
    if (!handler) {
      throw new Error(`unexpected fetch to ${key}`);
    }
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const FEDERATION_AT_BASE = `${BASE_URL}/_matrix/federation/v1/version`;
const WELL_KNOWN = `https://${SERVER_NAME}/.well-known/matrix/server`;
const FEDERATION_DELEGATED =
  'https://matrix-federation.example.org/_matrix/federation/v1/version';

describe('probeServerSoftware', () => {
  // Restore only `fetch`: vi.unstubAllGlobals() would also drop the matchMedia /
  // PointerEvent stubs test-setup.base installs once for the whole file.
  const realFetch = globalThis.fetch;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.stubGlobal('fetch', realFetch));

  it('reads the version from the client base URL when that host serves it', async () => {
    // The single-host deployment the issue describes: one origin answers both APIs.
    // Measured shape, from a real delegating-but-single-host server (tchncs.de).
    const fetchMock = stubFetch({
      [FEDERATION_AT_BASE]: () =>
        jsonResponse({ server: { name: 'Synapse', version: '1.157.2' } }),
    });

    const software = await firstValueFrom(
      probeServerSoftware(BASE_URL, SERVER_NAME),
    );

    expect(software).toEqual({
      name: 'Synapse',
      version: '1.157.2',
      source: 'base-url',
      host: BASE_URL,
    });
    // The well-known attempt must not run once the first one answered — it is a second
    // request to a third-party host, and the routed stub above would throw if it did.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back through .well-known when the base URL does not serve federation', async () => {
    // THE matrix.org shape, and the reason this fallback is not optional: its client base
    // URL answers 404 with an HTML body, and the version lives on a different host entirely.
    const fetchMock = stubFetch({
      [FEDERATION_AT_BASE]: () => jsonResponse(null, false),
      [WELL_KNOWN]: () =>
        jsonResponse({ 'm.server': 'matrix-federation.example.org:443' }),
      [FEDERATION_DELEGATED]: () =>
        jsonResponse({
          server: { name: 'Synapse', version: MATRIX_ORG_VERSION },
        }),
    });

    const software = await firstValueFrom(
      probeServerSoftware(BASE_URL, SERVER_NAME),
    );

    expect(software).toMatchObject({
      name: 'Synapse',
      // Verbatim, build suffix and all: that suffix is exactly what tells you whether the
      // overnight deploy landed, which is the use case that asked for this feature.
      version: MATRIX_ORG_VERSION,
      source: 'delegated',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keys the .well-known lookup on the server name, not the base URL', async () => {
    // The one place a copy-paste slip would be invisible: for a single-host server the two
    // are the same string, and only a delegating account tells them apart — which is the
    // only case the fallback ever runs in. The stub throws on any other host.
    stubFetch({
      [FEDERATION_AT_BASE]: () => jsonResponse(null, false),
      [WELL_KNOWN]: () => jsonResponse({}),
    });

    await expect(
      firstValueFrom(probeServerSoftware(BASE_URL, SERVER_NAME)),
    ).resolves.toBeNull();
  });

  it('resolves null when fetch rejects, which is what a CORS refusal looks like', async () => {
    // Measured: both failing servers answer 404 with NO Access-Control-Allow-Origin, so a
    // browser never sees the status — `fetch` rejects with a bare TypeError carrying
    // nothing. Being offline is indistinguishable. All of it must read as "unknown".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(
      firstValueFrom(probeServerSoftware(BASE_URL, SERVER_NAME)),
    ).resolves.toBeNull();
  });

  it('resolves null when a 200 carries a body that is not JSON', async () => {
    // A separate failure from `res.ok`, and one that only bites after the status looked
    // fine: an HTML error page served with a 200, or a stream that dies mid-body.
    stubFetch({
      [FEDERATION_AT_BASE]: () => htmlResponse(HTML_404),
      [WELL_KNOWN]: () => jsonResponse({}),
    });

    await expect(
      firstValueFrom(probeServerSoftware(BASE_URL, SERVER_NAME)),
    ).resolves.toBeNull();
  });

  it.each([
    ['no server object', {}],
    ['an empty server object', { server: {} }],
    ['a name but no version', { server: { name: 'Synapse' } }],
    ['a version but no name', { server: { version: '1.2.3' } }],
    ['a numeric version', { server: { name: 'Synapse', version: 42 } }],
    ['a blank version', { server: { name: 'Synapse', version: '  ' } }],
    ['a null body', null],
  ])('resolves null for a response with %s', async (_label, body) => {
    // Rendering "Synapse undefined" would be worse than the honest "Unknown", so a
    // half-answer is not an answer.
    stubFetch({
      [FEDERATION_AT_BASE]: () => jsonResponse(body),
      [WELL_KNOWN]: () => jsonResponse({}),
    });

    await expect(
      firstValueFrom(probeServerSoftware(BASE_URL, SERVER_NAME)),
    ).resolves.toBeNull();
  });

  it.each([
    ['a scheme baked in', 'http://insecure.example.org'],
    ['an https scheme baked in', 'https://matrix.example.org'],
    ['a path', 'matrix.example.org/../admin'],
    ['userinfo', 'user:pw@matrix.example.org'],
    ['a query', 'matrix.example.org?x=1'],
    ['nothing parseable', '://://'],
    ['whitespace', '   '],
  ])(
    'makes no delegated request when m.server carries %s',
    async (_label, mServer) => {
      // `m.server` is server-chosen data, and prefixing `https://` and trusting `new URL` is
      // NOT enough on its own: 'https://' + 'http://insecure.example.org' parses cleanly into
      // the host `http`, so a naive version spends a request on a host nobody named. The
      // routed stub throws on any request, so each row here fails if the value is coerced
      // rather than rejected.
      const fetchMock = stubFetch({
        [FEDERATION_AT_BASE]: () => jsonResponse(null, false),
        [WELL_KNOWN]: () => jsonResponse({ 'm.server': mServer }),
      });

      await expect(
        firstValueFrom(probeServerSoftware(BASE_URL, SERVER_NAME)),
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2); // the base URL and the well-known, no more
    },
  );

  it('accepts the host:port form the spec actually uses', async () => {
    // The counterpart to the rejections above: matrix.org really does answer
    // `matrix-federation.matrix.org:443`, so the validation must not be so strict that the
    // one shape in the wild is thrown away. Without this, every row above would still pass
    // against a probe that rejected everything.
    stubFetch({
      [FEDERATION_AT_BASE]: () => jsonResponse(null, false),
      [WELL_KNOWN]: () =>
        jsonResponse({ 'm.server': 'matrix-federation.example.org:443' }),
      [FEDERATION_DELEGATED]: () =>
        jsonResponse({ server: { name: 'Synapse', version: '1.2.3' } }),
    });

    await expect(
      firstValueFrom(probeServerSoftware(BASE_URL, SERVER_NAME)),
    ).resolves.toMatchObject({ version: '1.2.3', source: 'delegated' });
  });

  it('does not ask a plain-http base URL, but still tries the well-known host', async () => {
    // Two behaviours in one, because they are easy to conflate: attempt 1 is dropped
    // unrequested (see the authenticated calls below for why plain http is refused), while
    // attempt 2 is unaffected — it addresses `https://<serverName>` no matter what scheme
    // the base URL had, so a misconfigured account can still get an answer.
    const fetchMock = stubFetch({ [WELL_KNOWN]: () => jsonResponse({}) });

    await expect(
      firstValueFrom(
        probeServerSoftware('http://insecure.example.org', SERVER_NAME),
      ),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(WELL_KNOWN);
  });

  it('sends no credentials and follows no redirect to the federation host', async () => {
    // The two hosts reached here are named by the server itself, so neither a cookie nor a
    // redirect may travel with the request. Asserted on the real init object rather than
    // trusted, because both are silent if they regress.
    const fetchMock = stubFetch({
      [FEDERATION_AT_BASE]: () =>
        jsonResponse({ server: { name: 'Synapse', version: '1.2.3' } }),
    });

    await firstValueFrom(probeServerSoftware(BASE_URL, SERVER_NAME));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.headers).toBeUndefined(); // no bearer token off-origin
    expect(init.signal).toBeInstanceOf(AbortSignal); // a hung server cannot hang the block
  });

  it('re-issues the request on every subscribe, so "Check again" really checks', async () => {
    // The `defer` this pins is invisible when it is wrong: handing `from()` an already-made
    // promise replays the settled result, so a second subscribe would make no request and
    // the refresh button would silently show a stale answer forever.
    const fetchMock = stubFetch({
      [FEDERATION_AT_BASE]: () =>
        jsonResponse({ server: { name: 'Synapse', version: '1.2.3' } }),
    });
    const probe = probeServerSoftware(BASE_URL, SERVER_NAME);

    await firstValueFrom(probe);
    await firstValueFrom(probe);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchSpecVersions', () => {
  const realFetch = globalThis.fetch;
  const VERSIONS_URL = `${BASE_URL}/_matrix/client/versions`;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.stubGlobal('fetch', realFetch));

  it('returns the advertised versions and only the enabled unstable flags', async () => {
    const fetchMock = stubFetch({
      [VERSIONS_URL]: () =>
        jsonResponse({
          versions: ['v1.11', 'v1.12'],
          unstable_features: {
            'org.matrix.msc3916': true,
            'org.matrix.msc2716': false,
            'org.matrix.msc4028': true,
          },
        }),
    });

    const result = await firstValueFrom(fetchSpecVersions(BASE_URL, 'tok'));

    expect(result?.versions).toEqual(['v1.11', 'v1.12']);
    // Only the ones actually on, and sorted, so the rendered list does not reorder itself
    // between two identical answers.
    expect(result?.unstableFeatures).toEqual([
      'org.matrix.msc3916',
      'org.matrix.msc4028',
    ]);
    // This endpoint is on the account's OWN base URL, so the token goes with it — unlike
    // the federation probe above.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it.each([
    ['no versions key', {}],
    ['versions that is not an array', { versions: 'v1.11' }],
    ['an empty version list', { versions: [] }],
    ['non-string entries only', { versions: [1, 2] }],
  ])('resolves null for a response with %s', async (_label, body) => {
    stubFetch({ [VERSIONS_URL]: () => jsonResponse(body) });

    await expect(
      firstValueFrom(fetchSpecVersions(BASE_URL, 'tok')),
    ).resolves.toBeNull();
  });

  it('resolves null rather than throwing when the request fails', async () => {
    stubFetch({ [VERSIONS_URL]: () => jsonResponse(null, false) });

    await expect(
      firstValueFrom(fetchSpecVersions(BASE_URL, 'tok')),
    ).resolves.toBeNull();
  });

  it('never puts the access token on a plain-http connection', async () => {
    // This is the reason the https check exists at all. The app's own CSP
    // (`connect-src 'self' https: wss:`) already blocks it on the web, but the check makes
    // sending the account's bearer token in the clear impossible rather than merely
    // unlikely — on a platform whose CSP is enforced differently, or in a test harness.
    const fetchMock = stubFetch({});

    await expect(
      firstValueFrom(fetchSpecVersions('http://insecure.example.org', 'tok')),
    ).resolves.toBeNull();
    await expect(
      firstValueFrom(fetchCapabilities('http://insecure.example.org', 'tok')),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchCapabilities', () => {
  const realFetch = globalThis.fetch;
  const CAPS_URL = `${BASE_URL}/_matrix/client/v3/capabilities`;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.stubGlobal('fetch', realFetch));

  it('reads the default room version and the password-change flag', async () => {
    stubFetch({
      [CAPS_URL]: () =>
        jsonResponse({
          capabilities: {
            'm.room_versions': { default: '10', available: { '10': 'stable' } },
            'm.change_password': { enabled: false },
          },
        }),
    });

    await expect(
      firstValueFrom(fetchCapabilities(BASE_URL, 'tok')),
    ).resolves.toEqual({ defaultRoomVersion: '10', canChangePassword: false });
  });

  it('reports an unstated password capability as unknown, not as allowed', async () => {
    // The spec says an absent `m.change_password` means it IS supported — but absent also
    // covers a server that never mentioned capabilities at all, and the two are the same
    // bytes here. Claiming "you can change your password" on that basis would be a guess
    // presented as a fact.
    stubFetch({
      [CAPS_URL]: () =>
        jsonResponse({ capabilities: { 'm.room_versions': { default: '9' } } }),
    });

    await expect(
      firstValueFrom(fetchCapabilities(BASE_URL, 'tok')),
    ).resolves.toEqual({ defaultRoomVersion: '9', canChangePassword: null });
  });

  it('resolves null when the server states neither capability', async () => {
    stubFetch({ [CAPS_URL]: () => jsonResponse({ capabilities: {} }) });

    await expect(
      firstValueFrom(fetchCapabilities(BASE_URL, 'tok')),
    ).resolves.toBeNull();
  });

  it('makes no request at all without an access token', async () => {
    // Unlike the other two, this endpoint is authenticated: asking without a token is a
    // guaranteed 401, so it is not worth the round trip.
    const fetchMock = stubFetch({});

    await expect(
      firstValueFrom(fetchCapabilities(BASE_URL, null)),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
