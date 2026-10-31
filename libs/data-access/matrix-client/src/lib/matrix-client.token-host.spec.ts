import { HttpApiEvent, TokenRefreshError, createClient } from 'matrix-js-sdk';
import type { HostTokenAnswer, MatrixClient, TokenHost } from 'matrix-js-sdk';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixSession } from '@trinity/util/matrix';
import { OIDC_SESSION, setup } from './matrix-client.spec-harness';
import { fakeNetwork } from './matrix-client.oauth-network.spec-harness';

const storeMock = vi.hoisted(() => ({ startup: vi.fn(), destroy: vi.fn() }));

vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class {
      startup = storeMock.startup;
      destroy = storeMock.destroy;
    },
  };
});

vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

const NATIVE_REFRESH_MARKER = 'trinity-native-vault';
const HOUR_MS = 3_600_000;
const NATIVE_SESSION: MatrixSession = {
  ...OIDC_SESSION,
  accessTokenExpiresAt: undefined,
  refreshToken: NATIVE_REFRESH_MARKER,
};

const inAnHour = (): Date => new Date(Date.now() + HOUR_MS);

function fakeHost(answer?: HostTokenAnswer) {
  return {
    refresh: vi.fn<TokenHost['refresh']>(async () => {
      if (!answer) throw new Error('refresh was not expected');
      return answer;
    }),
    current: vi.fn<TokenHost['current']>(async () => undefined),
    revoke: vi.fn<TokenHost['revoke']>(async () => false),
  } satisfies TokenHost;
}

describe('a session whose token exchanges a host makes', () => {
  async function startReal(session: MatrixSession = NATIVE_SESSION) {
    const actual =
      await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk');
    vi.mocked(createClient).mockImplementation((opts) => {
      const client = actual.createClient(opts);
      vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined);
      vi.spyOn(client, 'startClient').mockResolvedValue(undefined);
      vi.spyOn(client, 'clearStores').mockResolvedValue(undefined);
      return client;
    });
    vi.stubGlobal('indexedDB', undefined);
    const ctx = setup();
    vi.mocked(ctx.storage.updateTokens).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.updateOidcBinding).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.remove).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.invalidateToken).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.setActive).mockReturnValue(of(undefined));
    await firstValueFrom(ctx.svc.init(session));
    const client = ctx.svc.instance;
    const loggedOut = vi.fn();
    client.on(HttpApiEvent.SessionLoggedOut, loggedOut);
    return { ...ctx, client, loggedOut };
  }

  async function startWithHost(host: TokenHost) {
    const started = await startReal();
    started.client.http.opts.tokenHost = host;
    return started;
  }

  /** The client holds `at-1`, good for an hour, and the server has stopped accepting it. */
  async function rejectedWithFarExpiry(client: MatrixClient) {
    await client.http.adoptOAuthTokens({
      accessToken: 'at-1',
      expiry: inAnHour(),
    });
  }

  beforeEach(() => {
    vi.mocked(createClient).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Run past the SDK's backoff between attempts, which is up to 60 s over five attempts. */
  async function pastBackoff<T>(run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = run();
    result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    return result;
  }

  it('sends no grant and no discovery when a host refreshes', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-2');
    const host = fakeHost({
      kind: 'tokens',
      granted: true,
      accessToken: 'at-2',
      expiry: inAnHour(),
    });
    const { client, loggedOut } = await startWithHost(host);

    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });

    expect(host.refresh).toHaveBeenCalledExactlyOnceWith(
      OIDC_SESSION.accessToken,
    );
    expect(net.grants).toHaveLength(0);
    expect(net.calls.filter((call) => call.endsWith('/auth_metadata'))).toEqual(
      [],
    );
    expect(client.getAccessToken()).toBe('at-2');
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it('persists the pair a host refreshed, with no refresh token', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-2');
    const expiry = inAnHour();
    const { client, storage } = await startWithHost(
      fakeHost({ kind: 'tokens', granted: true, accessToken: 'at-2', expiry }),
    );

    await client.whoami();

    expect(storage.updateTokens).toHaveBeenCalledExactlyOnceWith(
      '@me:hs',
      undefined,
      'at-2',
      undefined,
      expiry.getTime(),
    );
    expect(client.getRefreshToken()).toBe(NATIVE_REFRESH_MARKER);
  });

  it('refreshes through a host on request, and never signs out when refused', async () => {
    fakeNetwork('rotate');
    const host = fakeHost({ kind: 'refused' });
    const { client, loggedOut } = await startWithHost(host);

    await expect(client.http.refreshOAuthTokens()).resolves.toBe(false);

    expect(host.refresh).toHaveBeenCalledOnce();
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it('adopts the pair a host holds before the far-expiry shortcut (failure 4)', async () => {
    const net = fakeNetwork('rotate');
    const host = fakeHost();
    const { client, loggedOut } = await startWithHost(host);
    await rejectedWithFarExpiry(client);
    net.live.add('at-2');
    host.current.mockResolvedValue({
      accessToken: 'at-2',
      expiry: inAnHour(),
    });

    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });

    expect(host.refresh).not.toHaveBeenCalled();
    expect(client.getAccessToken()).toBe('at-2');
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it.each([
    ['the host cannot say', undefined],
    ['the host holds the same token', { accessToken: 'at-1' }],
    [
      'the host holds the same token with a new expiry',
      { accessToken: 'at-1', expiry: new Date(Date.now() + 2 * HOUR_MS) },
    ],
  ])(
    'refreshes on a first rejection with a far expiry and an unchanged pair: %s',
    async (_, held) => {
      const net = fakeNetwork('rotate');
      net.live.add('at-2');
      const host = fakeHost({
        kind: 'tokens',
        granted: true,
        accessToken: 'at-2',
        expiry: inAnHour(),
      });
      const { client, loggedOut } = await startWithHost(host);
      await rejectedWithFarExpiry(client);
      host.current.mockResolvedValue(held);

      await expect(client.whoami()).resolves.toMatchObject({
        user_id: '@me:hs',
      });

      expect(host.refresh).toHaveBeenCalledExactlyOnceWith('at-1');
      expect(loggedOut).not.toHaveBeenCalled();
    },
  );

  it('reaches the shortcut on a rejection of the refreshed token, so it cannot loop (failure 11)', async () => {
    fakeNetwork('rotate');
    const host = fakeHost({
      kind: 'tokens',
      granted: true,
      accessToken: 'at-refused',
      expiry: inAnHour(),
    });
    const { client, loggedOut } = await startWithHost(host);
    await rejectedWithFarExpiry(client);
    // What the host says it holds after that refresh: its own copy of the pair.
    host.current.mockImplementation(async () =>
      host.refresh.mock.calls.length > 0
        ? { accessToken: 'at-refused', expiry: inAnHour() }
        : { accessToken: 'at-1', expiry: inAnHour() },
    );

    await expect(client.whoami()).rejects.toMatchObject({
      errcode: 'M_UNKNOWN_TOKEN',
    });

    expect(loggedOut).toHaveBeenCalledOnce();
    expect(host.refresh).toHaveBeenCalledOnce();
  });

  it('treats a thrown host call as transient', async () => {
    fakeNetwork('rotate');
    const host = fakeHost();
    host.refresh.mockRejectedValue(new Error('bridge died'));
    const { svc, client, loggedOut } = await startWithHost(host);

    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

    expect(loggedOut).not.toHaveBeenCalled();
    expect(svc.accountIds()).toContain('@me:hs');
    expect(client.clearStores).not.toHaveBeenCalled();
  });

  it('treats a failed read of the held pair as unchanged', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-2');
    const host = fakeHost({
      kind: 'tokens',
      granted: true,
      accessToken: 'at-2',
      expiry: inAnHour(),
    });
    host.current.mockRejectedValue(new Error('bridge died'));
    const { client, loggedOut } = await startWithHost(host);
    await rejectedWithFarExpiry(client);

    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });

    expect(host.refresh).toHaveBeenCalledOnce();
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it('a refused host answer emits SessionLoggedOut once', async () => {
    fakeNetwork('rotate');
    const host = fakeHost({ kind: 'refused' });
    const { client, loggedOut } = await startWithHost(host);

    await expect(client.whoami()).rejects.toMatchObject({
      errcode: 'M_UNKNOWN_TOKEN',
    });

    expect(host.refresh).toHaveBeenCalledOnce();
    expect(loggedOut).toHaveBeenCalledOnce();
  });

  it('a transient host answer rejects TokenRefreshError with no SessionLoggedOut', async () => {
    fakeNetwork('rotate');
    const host = fakeHost({ kind: 'transient' });
    const { svc, client, loggedOut } = await startWithHost(host);

    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

    expect(host.refresh).toHaveBeenCalledOnce();
    expect(loggedOut).not.toHaveBeenCalled();
    expect(svc.accountIds()).toContain('@me:hs');
    expect(client.clearStores).not.toHaveBeenCalled();
  });

  it('does not adopt a pair read before a rotation', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-2');
    const host = fakeHost({
      kind: 'tokens',
      granted: true,
      accessToken: 'at-2',
      expiry: inAnHour(),
    });
    const { client, loggedOut } = await startWithHost(host);
    let deliver!: (held: { accessToken: string }) => void;
    host.current.mockReturnValueOnce(
      new Promise((resolve) => (deliver = resolve)),
    );

    const pending = client.whoami();
    await vi.waitFor(() => expect(host.current).toHaveBeenCalledOnce());
    await expect(client.http.refreshOAuthTokens()).resolves.toBe(true);
    deliver({ accessToken: OIDC_SESSION.accessToken });

    await expect(pending).resolves.toMatchObject({ user_id: '@me:hs' });
    expect(client.getAccessToken()).toBe('at-2');
    expect(host.refresh).toHaveBeenCalledOnce();
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it('keeps an adopted token when onTokenRefresh fails', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-2');
    const { client, storage, loggedOut } = await startWithHost(
      fakeHost({
        kind: 'tokens',
        granted: true,
        accessToken: 'at-2',
        expiry: inAnHour(),
      }),
    );
    vi.mocked(storage.updateTokens).mockReturnValue(
      throwError(() => new Error('secure store locked')),
    );

    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });

    expect(storage.updateTokens).toHaveBeenCalledOnce();
    expect(client.getAccessToken()).toBe('at-2');
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it('never sends the marker to the revocation endpoint', async () => {
    const net = fakeNetwork('rotate');
    const host = fakeHost();
    const { client } = await startWithHost(host);

    await client.http.revokeOAuthTokens();

    expect(host.revoke).toHaveBeenCalledOnce();
    expect(net.revocations).toEqual(['access_token']);
    expect(net.grants).toHaveLength(0);
  });

  it('revokes nothing itself when the host revoked', async () => {
    const net = fakeNetwork('rotate');
    const host = fakeHost();
    host.revoke.mockResolvedValue(true);
    const { client } = await startWithHost(host);

    await client.http.revokeOAuthTokens();

    expect(net.revocations).toEqual([]);
    expect(net.calls.filter((call) => call.endsWith('/auth_metadata'))).toEqual(
      [],
    );
  });

  describe('learning an expiry for the same token', () => {
    const anHourAgo = (): Date => new Date(Date.now() - HOUR_MS);

    it('takes one when none is known, without reporting a rotation', async () => {
      const net = fakeNetwork('rotate');
      net.live.add('at-2');
      const host = fakeHost({
        kind: 'tokens',
        granted: true,
        accessToken: 'at-2',
        expiry: inAnHour(),
      });
      const { client, storage } = await startWithHost(host);

      await client.http.adoptOAuthTokens({
        accessToken: OIDC_SESSION.accessToken,
        expiry: anHourAgo(),
      });

      expect(storage.updateTokens).not.toHaveBeenCalled();
      // A known, past expiry is what makes the SDK refresh before sending.
      await client.whoami();
      expect(host.refresh).toHaveBeenCalledOnce();
    });

    it('does not replace a known one', async () => {
      const net = fakeNetwork('rotate');
      net.live.add('at-1');
      const host = fakeHost();
      const { client } = await startWithHost(host);
      await rejectedWithFarExpiry(client);

      await client.http.adoptOAuthTokens({
        accessToken: 'at-1',
        expiry: anHourAgo(),
      });

      await expect(client.whoami()).resolves.toBeDefined();
      expect(host.refresh).not.toHaveBeenCalled();
    });
  });

  it('refreshes when the pair a host held is rejected, without signing out', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-3');
    const host = fakeHost({
      kind: 'tokens',
      granted: true,
      accessToken: 'at-3',
      expiry: inAnHour(),
    });
    const { client, loggedOut } = await startWithHost(host);
    await rejectedWithFarExpiry(client);
    // Left by a process suspended mid-grant: the provider has revoked this rotation.
    host.current.mockResolvedValue({
      accessToken: 'at-2',
      expiry: inAnHour(),
    });

    await expect(pastBackoff(() => client.whoami())).resolves.toMatchObject({
      user_id: '@me:hs',
    });

    expect(host.refresh).toHaveBeenCalledExactlyOnceWith('at-2');
    expect(client.getAccessToken()).toBe('at-3');
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it.each([
    ['fails', () => Promise.reject(new Error('bridge died'))],
    ['cannot say', () => Promise.resolve(undefined)],
  ])(
    'does not sign out when the refreshed token is rejected and the read of the held pair %s',
    async (_, secondRead) => {
      fakeNetwork('rotate');
      const host = fakeHost({
        kind: 'tokens',
        granted: true,
        accessToken: 'at-refused',
        expiry: inAnHour(),
      });
      const { svc, client, loggedOut } = await startWithHost(host);
      await rejectedWithFarExpiry(client);
      host.current
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(secondRead);

      await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

      expect(host.refresh).toHaveBeenCalledOnce();
      expect(loggedOut).not.toHaveBeenCalled();
      expect(svc.accountIds()).toContain('@me:hs');
      expect(client.clearStores).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['no expiry', () => undefined],
    ['an expiry under the shortcut', () => new Date(Date.now() + 30_000)],
  ])(
    'stops after three refreshes whose tokens the server refuses, with %s',
    async (_, expiry) => {
      fakeNetwork('rotate');
      const host = fakeHost();
      const { svc, client, loggedOut } = await startWithHost(host);
      let issued = 1;
      host.refresh.mockImplementation(async () => ({
        kind: 'tokens',
        granted: true,
        accessToken: `at-${(issued += 1)}`,
        expiry: expiry(),
      }));
      host.current.mockImplementation(async () => ({
        accessToken: client.getAccessToken() ?? '',
      }));

      await expect(pastBackoff(() => client.whoami())).rejects.toBeInstanceOf(
        TokenRefreshError,
      );

      expect(host.refresh).toHaveBeenCalledTimes(3);
      expect(loggedOut).not.toHaveBeenCalled();
      expect(svc.accountIds()).toContain('@me:hs');
    },
  );

  it('does not let a late refresh answer overwrite a newer pair', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-3');
    const host = fakeHost();
    const { client, storage, loggedOut } = await startWithHost(host);
    let answer!: (answer: HostTokenAnswer) => void;
    host.refresh.mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );

    const pending = client.whoami();
    await vi.waitFor(() => expect(host.refresh).toHaveBeenCalledOnce());
    await client.http.adoptOAuthTokens({
      accessToken: 'at-3',
      expiry: inAnHour(),
    });
    answer({
      kind: 'tokens',
      granted: true,
      accessToken: 'at-2',
      expiry: inAnHour(),
    });

    await expect(pending).resolves.toMatchObject({ user_id: '@me:hs' });
    expect(client.getAccessToken()).toBe('at-3');
    expect(
      vi.mocked(storage.updateTokens).mock.calls.map(([, , at]) => at),
    ).toEqual(['at-3']);
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it('refreshes again when a token no grant returned is rejected, without signing out', async () => {
    const net = fakeNetwork('rotate');
    net.live.add('at-3');
    const host = fakeHost();
    const { client, loggedOut } = await startWithHost(host);
    await rejectedWithFarExpiry(client);
    host.current
      .mockRejectedValueOnce(new Error('bridge died'))
      .mockResolvedValue({ accessToken: 'at-2', expiry: inAnHour() });
    host.refresh
      .mockResolvedValueOnce({
        kind: 'tokens',
        granted: false,
        accessToken: 'at-2',
        expiry: inAnHour(),
      })
      .mockResolvedValueOnce({
        kind: 'tokens',
        granted: true,
        accessToken: 'at-3',
        expiry: inAnHour(),
      });

    await expect(pastBackoff(() => client.whoami())).resolves.toMatchObject({
      user_id: '@me:hs',
    });

    expect(host.refresh.mock.calls).toEqual([['at-1'], ['at-2']]);
    expect(client.getAccessToken()).toBe('at-3');
    expect(loggedOut).not.toHaveBeenCalled();
  });

  it.each(['refused', 'transient'] as const)(
    'retries on the newer token when a %s answer arrives late',
    async (kind) => {
      const net = fakeNetwork('rotate');
      net.live.add('at-3');
      const host = fakeHost();
      const { svc, client, loggedOut } = await startWithHost(host);
      let answer!: (answer: HostTokenAnswer) => void;
      host.refresh.mockReturnValueOnce(
        new Promise((resolve) => (answer = resolve)),
      );

      const pending = client.whoami();
      await vi.waitFor(() => expect(host.refresh).toHaveBeenCalledOnce());
      await client.http.adoptOAuthTokens({
        accessToken: 'at-3',
        expiry: inAnHour(),
      });
      answer({ kind });

      await expect(pending).resolves.toMatchObject({ user_id: '@me:hs' });
      expect(client.getAccessToken()).toBe('at-3');
      expect(loggedOut).not.toHaveBeenCalled();
      expect(svc.accountIds()).toContain('@me:hs');
    },
  );

  it('a refused host answer signs out with a far expiry too', async () => {
    fakeNetwork('rotate');
    const host = fakeHost({ kind: 'refused' });
    const { svc, client, loggedOut } = await startWithHost(host);
    await rejectedWithFarExpiry(client);

    await expect(client.whoami()).rejects.toMatchObject({
      errcode: 'M_UNKNOWN_TOKEN',
    });

    expect(host.refresh).toHaveBeenCalledExactlyOnceWith('at-1');
    expect(loggedOut).toHaveBeenCalledOnce();
    expect(svc.accountIds()).not.toContain('@me:hs');
  });

  it('wipes once for a burst of requests that a refused host answer signs out', async () => {
    fakeNetwork('rotate');
    const host = fakeHost();
    const { svc, client, storage, loggedOut } = await startWithHost(host);
    await rejectedWithFarExpiry(client);
    let answer!: (answer: HostTokenAnswer) => void;
    host.refresh.mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );

    const burst = [client.whoami(), client.whoami(), client.whoami()];
    await vi.waitFor(() => expect(host.current).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(host.refresh).toHaveBeenCalledOnce());
    answer({ kind: 'refused' });
    const settled = await Promise.allSettled(burst);

    expect(settled.map(({ status }) => status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    // The SDK emits once per request; the service acts on the first and has left by the next.
    expect(loggedOut).toHaveBeenCalledTimes(3);
    expect(client.clearStores).toHaveBeenCalledOnce();
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith('@me:hs');
    expect(svc.accountIds()).not.toContain('@me:hs');
  });

  describe('without a host', () => {
    it('still signs out at once on a rejection with a far expiry', async () => {
      const net = fakeNetwork('rotate', 3600);
      const { client, loggedOut } = await startReal(OIDC_SESSION);
      await client.whoami(); // the first refresh: at-2, an hour to run

      net.expireAll();
      await expect(client.whoami()).rejects.toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
      });

      expect(net.grants).toHaveLength(1);
      expect(loggedOut).toHaveBeenCalledOnce();
    });

    it('still retries past three refreshes whose tokens the server refuses', async () => {
      const net = fakeNetwork('rotate', null);
      vi.spyOn(net.live, 'has').mockImplementation(
        () => net.grants.length >= 5,
      );
      const { client, loggedOut } = await startReal(OIDC_SESSION);

      await expect(pastBackoff(() => client.whoami())).resolves.toBeDefined();

      expect(net.grants).toHaveLength(5);
      expect(loggedOut).not.toHaveBeenCalled();
    });

    it('still sends the grant and revokes both tokens itself', async () => {
      const net = fakeNetwork('rotate');
      const { client } = await startReal(OIDC_SESSION);

      await client.whoami();
      await client.http.revokeOAuthTokens();

      expect(net.grants[0].get('refresh_token')).toBe(
        OIDC_SESSION.refreshToken,
      );
      expect([...net.revocations].sort()).toEqual([
        'access_token',
        'refresh_token',
      ]);
    });
  });
});
