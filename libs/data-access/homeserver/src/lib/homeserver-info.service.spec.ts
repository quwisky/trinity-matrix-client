import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { HomeserverInfoService } from './homeserver-info.service';

/**
 * A client stub for one account.
 *
 * `baseUrl` and `getDomain()` differ per account on purpose: every probe here is addressed
 * from one of them, so a service that read the wrong account's client would produce a
 * cross-account leak that a stub answering identically for everyone could not see. Same
 * reasoning as `AccountIdentitiesService`'s argument-respecting `getUser`.
 */
function fakeClient(
  userId: string,
  host: string,
  /** Distinct per account in the fan-out tests: a shared token hides a cross-account swap. */
  token: string | null = 'tok',
) {
  return {
    baseUrl: `https://${host}`,
    getDomain: () => userId.replace(/^.*?:/, ''),
    getAccessToken: () => token,
  };
}

function setup(
  accounts: Record<string, ReturnType<typeof fakeClient>>,
  /** Signed-in ids whose client is not created yet — `clientFor` returns null for these. */
  idsWithoutClients: string[] = [],
) {
  const ids = signal<readonly string[]>([
    ...Object.keys(accounts),
    ...idsWithoutClients,
  ]);
  const active = signal<string | null>(Object.keys(accounts)[0] ?? null);
  const clients = new Map(Object.entries(accounts));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      HomeserverInfoService,
      MockProvider(MatrixClientService, {
        accountIds: ids.asReadonly(),
        activeUserId: active.asReadonly(),
        clientFor: (userId: string) => (clients.get(userId) ?? null) as never,
      }),
    ],
  });
  const svc = TestBed.inject(HomeserverInfoService);
  // The eviction pass wires itself from a constructor effect, which has not run yet.
  TestBed.tick();
  return { svc, ids, active, clients };
}

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const fail = () => ({ ok: false, status: 404, json: async () => null });

const software = (name: string, version: string) => ({
  server: { name, version },
});

/**
 * Route `fetch` by URL, throwing on anything unrouted so a request to the wrong account's
 * host cannot pass as a clean "unknown".
 */
function stubFetch(routes: Record<string, () => unknown>) {
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

/** Every endpoint one account is asked for, answering plausibly. */
function routesFor(host: string, name: string, version: string) {
  return {
    [`https://${host}/_matrix/federation/v1/version`]: () =>
      ok(software(name, version)),
    [`https://${host}/_matrix/client/versions`]: () =>
      ok({ versions: ['v1.11'], unstable_features: {} }),
    [`https://${host}/_matrix/client/v3/capabilities`]: () =>
      ok({ capabilities: { 'm.room_versions': { default: '10' } } }),
  };
}

/**
 * Read an account's record the way the real consumers do — both of #171's read
 * `infos().get(...)` — rather than through an accessor that exists only for tests.
 */
const infoFor = (svc: HomeserverInfoService, userId: string) =>
  svc.infos().get(userId) ?? null;

describe('HomeserverInfoService', () => {
  // Restore only `fetch`: vi.unstubAllGlobals() would also drop the matchMedia /
  // PointerEvent stubs test-setup.base installs once for the whole file.
  const realFetch = globalThis.fetch;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.stubGlobal('fetch', realFetch));

  it('probes every signed-in account through its own client', async () => {
    stubFetch({
      ...routesFor('matrix.one.org', 'Synapse', '1.157.2'),
      ...routesFor('matrix.two.org', 'Dendrite', '0.13.8'),
    });
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'matrix.one.org'),
      '@alt:two.org': fakeClient('@alt:two.org', 'matrix.two.org'),
    });

    await firstValueFrom(svc.loadAll());

    expect(infoFor(svc, '@me:one.org')?.software).toMatchObject({
      name: 'Synapse',
      version: '1.157.2',
    });
    // Not "Synapse": a second account on a different server is the whole point of the
    // surface, and reading the active client for both is the bug this pins.
    expect(infoFor(svc, '@alt:two.org')?.software).toMatchObject({
      name: 'Dendrite',
      version: '0.13.8',
    });
  });

  it('sends each account its OWN token, to its own host', async () => {
    // Both halves matter and neither was covered: every account used to share one token, and
    // the stub never received `init`, so a service that read the active client for all
    // accounts — or leaked one account's bearer to another's homeserver — passed.
    const fetchMock = stubFetch({
      ...routesFor('one.example', 'Synapse', '1.1.0'),
      ...routesFor('two.example', 'Synapse', '1.2.0'),
    });
    const { svc } = setup({
      '@me:one.example': fakeClient(
        '@me:one.example',
        'one.example',
        'tok-one',
      ),
      '@alt:two.example': fakeClient(
        '@alt:two.example',
        'two.example',
        'tok-two',
      ),
    });

    await firstValueFrom(svc.loadAll());

    const authFor = (host: string) =>
      (fetchMock.mock.calls as [URL, RequestInit][])
        .filter(([url]) =>
          String(url).startsWith(`https://${host}/_matrix/client/`),
        )
        .map(
          ([, init]) =>
            (init.headers as Record<string, string>)?.['Authorization'],
        );

    expect(authFor('one.example')).toEqual([
      'Bearer tok-one',
      'Bearer tok-one',
    ]);
    expect(authFor('two.example')).toEqual([
      'Bearer tok-two',
      'Bearer tok-two',
    ]);
  });

  it('records the spec versions, unstable flags and capabilities it was given', async () => {
    // These three fields were asserted only as NULL anywhere in this spec, so replacing any
    // of them with a literal `null` in the service could not fail.
    stubFetch({
      'https://one.example/_matrix/federation/v1/version': () =>
        ok(software('Synapse', '1.1.0')),
      'https://one.example/_matrix/client/versions': () =>
        ok({
          versions: ['v1.11', 'v1.12'],
          unstable_features: { 'org.matrix.msc4028': true },
        }),
      'https://one.example/_matrix/client/v3/capabilities': () =>
        ok({
          capabilities: {
            'm.room_versions': { default: '10' },
            'm.change_password': { enabled: false },
          },
        }),
    });
    const { svc } = setup({
      '@me:one.example': fakeClient('@me:one.example', 'one.example'),
    });

    await firstValueFrom(svc.load('@me:one.example'));

    expect(infoFor(svc, '@me:one.example')).toMatchObject({
      specVersions: ['v1.11', 'v1.12'],
      unstableFeatures: ['org.matrix.msc4028'],
      capabilities: { defaultRoomVersion: '10', canChangePassword: false },
    });
  });

  it('shares one in-flight probe rather than starting a second', async () => {
    // The cache is only written when the whole probe settles, so without this every caller
    // arriving during those seconds starts its own set of requests — and #171 reaches that
    // directly: each block loads on init, and the account menu re-triggers on every toggle.
    // Sharing also removes the ordering hazard, since an older response can no longer land
    // on top of a newer one.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = stubFetch({
      'https://one.example/_matrix/federation/v1/version': async () => {
        await gate;
        return ok(software('Synapse', '1.1.0'));
      },
      'https://one.example/_matrix/client/versions': () =>
        ok({ versions: ['v1.11'] }),
      'https://one.example/_matrix/client/v3/capabilities': () => fail(),
    });
    const { svc } = setup({
      '@me:one.example': fakeClient('@me:one.example', 'one.example'),
    });

    const first = firstValueFrom(svc.load('@me:one.example'));
    const second = firstValueFrom(svc.refresh('@me:one.example'));
    release?.();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(3); // one probe, not two
    expect(infoFor(svc, '@me:one.example')?.software).toMatchObject({
      version: '1.1.0',
    });
  });

  it('probes again once the shared request has finished', async () => {
    // The in-flight entry must be released on completion, or it would become a permanent
    // cache and "Check again" would stop asking anything.
    const fetchMock = stubFetch(routesFor('one.example', 'Synapse', '1.1.0'));
    const { svc } = setup({
      '@me:one.example': fakeClient('@me:one.example', 'one.example'),
    });

    await firstValueFrom(svc.refresh('@me:one.example'));
    await firstValueFrom(svc.refresh('@me:one.example'));

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('reads a token no earlier than subscribe', async () => {
    // Documented as cold. Reading the token when the observable is BUILT would replay a
    // stale bearer after an OIDC rotation between build and subscribe.
    stubFetch(routesFor('one.example', 'Synapse', '1.1.0'));
    const client = fakeClient('@me:one.example', 'one.example');
    const getAccessToken = vi.fn(() => 'tok');
    const { svc } = setup({
      '@me:one.example': { ...client, getAccessToken },
    });

    const pending = svc.refresh('@me:one.example');
    expect(getAccessToken).not.toHaveBeenCalled();

    await firstValueFrom(pending);
    expect(getAccessToken).toHaveBeenCalled();
  });

  it.each([
    ['a differently-cased host', 'https://One.Example', 'one.example'],
    ['an explicit default port', 'https://one.example:443', 'one.example'],
  ])('does not read %s as delegation', async (_label, baseUrl, serverName) => {
    // `discovered` drives a sentence in #171 about the homeserver having been discovered
    // rather than typed. A raw string compare reports both of these as delegated.
    stubFetch(routesFor(new URL(baseUrl).host, 'Synapse', '1.1.0'));
    const { svc } = setup({
      [`@me:${serverName}`]: {
        ...fakeClient(`@me:${serverName}`, serverName),
        baseUrl,
      },
    });

    await firstValueFrom(svc.load(`@me:${serverName}`));

    expect(infoFor(svc, `@me:${serverName}`)?.discovered).toBe(false);
  });

  it('records the server name and base URL, and notes when they differ', async () => {
    stubFetch(routesFor('matrix.one.org', 'Synapse', '1.157.2'));
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'matrix.one.org'),
    });

    await firstValueFrom(svc.load('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')).toMatchObject({
      serverName: 'one.org',
      baseUrl: 'https://matrix.one.org',
      discovered: true,
    });
  });

  it('does not claim discovery when the homeserver IS the server name', async () => {
    stubFetch(routesFor('one.org', 'Synapse', '1.157.2'));
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });

    await firstValueFrom(svc.load('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')?.discovered).toBe(false);
  });

  it('does not read a trailing slash as delegation', async () => {
    // `discovered` is a string comparison, so `https://one.org/` vs `https://one.org` would
    // report a plain single-host account as delegated — and the URL row would show the
    // slash too. Cheap to get wrong, invisible when it is.
    stubFetch(routesFor('one.org', 'Synapse', '1.157.2'));
    const client = fakeClient('@me:one.org', 'one.org');
    const { svc } = setup({
      '@me:one.org': { ...client, baseUrl: 'https://one.org/' },
    });

    await firstValueFrom(svc.load('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')).toMatchObject({
      baseUrl: 'https://one.org',
      discovered: false,
    });
  });

  it('records an answer even when every probe came back empty', async () => {
    // The distinction the UI depends on: an ABSENT record is a spinner, a record full of
    // nulls is "Unknown". Collapsing them would leave an unreachable server spinning
    // forever, which is the failure mode the issue explicitly rules out.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });
    expect(infoFor(svc, '@me:one.org')).toBeNull();

    await firstValueFrom(svc.load('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')).toMatchObject({
      software: null,
      specVersions: null,
      capabilities: null,
      // The local facts are still known — they never needed the network.
      serverName: 'one.org',
      baseUrl: 'https://one.org',
    });
  });

  it('never rejects, whatever the servers do', async () => {
    // The section's error branch is meant to be unreachable rather than merely unused, so
    // this is asserted rather than assumed: nothing downstream needs a catch.
    stubFetch({});
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });

    await expect(firstValueFrom(svc.loadAll())).resolves.toBeUndefined();
  });

  it('caches per session — a second load makes no request', async () => {
    const fetchMock = stubFetch(routesFor('one.org', 'Synapse', '1.157.2'));
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });

    await firstValueFrom(svc.load('@me:one.org'));
    const afterFirst = fetchMock.mock.calls.length;
    await firstValueFrom(svc.load('@me:one.org'));

    expect(afterFirst).toBe(3); // federation + versions + capabilities
    expect(fetchMock).toHaveBeenCalledTimes(afterFirst);
  });

  it('re-probes on refresh, and picks up a version that changed', async () => {
    // The motivating use case verbatim: a deploy landed while the app was open, and the
    // question is whether the client can see it without being restarted.
    let version = '1.157.2';
    stubFetch({
      'https://one.org/_matrix/federation/v1/version': () =>
        ok(software('Synapse', version)),
      'https://one.org/_matrix/client/versions': () =>
        ok({ versions: ['v1.11'] }),
      'https://one.org/_matrix/client/v3/capabilities': () => fail(),
    });
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')?.software?.version).toBe('1.157.2');

    version = '1.158.0';
    await firstValueFrom(svc.refresh('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')?.software?.version).toBe('1.158.0');
  });

  it('lets a refresh succeed after a first attempt found nothing', async () => {
    let reachable = false;
    stubFetch({
      'https://one.org/_matrix/federation/v1/version': () =>
        reachable ? ok(software('Synapse', '1.157.2')) : fail(),
      'https://one.org/.well-known/matrix/server': () => fail(),
      'https://one.org/_matrix/client/versions': () => fail(),
      'https://one.org/_matrix/client/v3/capabilities': () => fail(),
    });
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')?.software).toBeNull();

    reachable = true;
    await firstValueFrom(svc.refresh('@me:one.org'));

    expect(infoFor(svc, '@me:one.org')?.software).toMatchObject({
      version: '1.157.2',
    });
  });

  it('skips an account that is signed in but has no client yet', async () => {
    // Warming an account in the background is normal on cold start; it is not an error and
    // must not crash the fan-out for the accounts that ARE ready.
    stubFetch(routesFor('one.org', 'Synapse', '1.157.2'));
    const { svc } = setup(
      { '@me:one.org': fakeClient('@me:one.org', 'one.org') },
      ['@pending:two.org'],
    );

    await firstValueFrom(svc.loadAll());

    expect(infoFor(svc, '@me:one.org')).not.toBeNull();
    expect(infoFor(svc, '@pending:two.org')).toBeNull();
  });

  it('drops an account that signs out', async () => {
    stubFetch(routesFor('one.org', 'Synapse', '1.157.2'));
    const { svc, ids, clients } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')).not.toBeNull();

    clients.delete('@me:one.org');
    ids.set([]);
    TestBed.tick();

    expect(infoFor(svc, '@me:one.org')).toBeNull();
  });

  it('re-probes when the same user id gets a NEW client object', async () => {
    // The trap a user-id-keyed cache walks straight into: re-adding an already signed-in
    // account stops and re-creates its client, possibly against a different homeserver.
    // The id is identical, so nothing about the account SET changes — only the object does.
    stubFetch({
      ...routesFor('old.example', 'Synapse', '1.100.0'),
      ...routesFor('new.example', 'Synapse', '1.158.0'),
    });
    const { svc, ids, clients } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'old.example'),
    });
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')?.baseUrl).toBe('https://old.example');

    clients.set('@me:one.org', fakeClient('@me:one.org', 'new.example'));
    ids.set(['@me:one.org']); // same set, different client object
    TestBed.tick();

    expect(infoFor(svc, '@me:one.org')).toBeNull(); // stale answer dropped, not kept
    await firstValueFrom(svc.load('@me:one.org'));
    expect(infoFor(svc, '@me:one.org')?.baseUrl).toBe('https://new.example');
  });

  it('discards a probe that finished after its account was removed', async () => {
    // The in-flight case the eviction pass alone cannot cover: the request was made while
    // the account existed and resolves after it is gone. Writing it then would resurrect a
    // signed-out account's row.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubFetch({
      'https://one.org/_matrix/federation/v1/version': async () => {
        await gate;
        return ok(software('Synapse', '1.157.2'));
      },
      'https://one.org/_matrix/client/versions': () =>
        ok({ versions: ['v1.11'] }),
      'https://one.org/_matrix/client/v3/capabilities': () => fail(),
    });
    const { svc, ids, clients } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
    });

    const inFlight = firstValueFrom(svc.load('@me:one.org'));
    clients.delete('@me:one.org');
    ids.set([]);
    TestBed.tick();
    release?.();
    await inFlight;

    expect(infoFor(svc, '@me:one.org')).toBeNull();
  });

  it('refreshes every account at once', async () => {
    const fetchMock = stubFetch({
      ...routesFor('one.org', 'Synapse', '1.157.2'),
      ...routesFor('two.org', 'Synapse', '1.157.2'),
    });
    const { svc } = setup({
      '@me:one.org': fakeClient('@me:one.org', 'one.org'),
      '@alt:two.org': fakeClient('@alt:two.org', 'two.org'),
    });

    await firstValueFrom(svc.refreshAll());

    expect(fetchMock).toHaveBeenCalledTimes(6); // three endpoints × two accounts
    expect(svc.infos().size).toBe(2);
  });

  it('resolves with nothing to do when no account is signed in', async () => {
    stubFetch({});
    const { svc } = setup({});

    await expect(firstValueFrom(svc.loadAll())).resolves.toBeUndefined();
    await expect(firstValueFrom(svc.refreshAll())).resolves.toBeUndefined();
    expect(svc.infos().size).toBe(0);
  });
});
