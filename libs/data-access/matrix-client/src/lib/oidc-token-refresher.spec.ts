import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStorageService } from '@trinity/platform-native';
import { TrinityOidcTokenRefresher } from './oidc-token-refresher';

// Only `createClient` is stubbed — discovery is the one network call the refresher makes
// before it can build anything. OAuth2 and TokenRefresher stay REAL, so these tests
// exercise the actual refresh-token grant rather than a re-description of it.
const getAuthMetadata = vi.fn();
const createClientSpy = vi.fn(() => ({ getAuthMetadata }));
vi.mock('matrix-js-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('matrix-js-sdk')>()),
  createClient: (opts: unknown) => createClientSpy(opts as never),
}));

const BINDING = {
  issuer: 'https://op',
  clientId: 'client-1',
  redirectUri: 'https://app/sso-callback',
};

const METADATA = {
  issuer: 'https://op',
  token_endpoint: 'https://op/token',
} as never;

function makeRefresher(updateTokens = vi.fn(() => of(undefined))) {
  const storage = { updateTokens } as unknown as SessionStorageService;
  const refresher = new TrinityOidcTokenRefresher(
    storage,
    '@me:hs',
    'https://hs',
    BINDING,
    'DEV',
  );
  return { refresher, updateTokens };
}

/** A token-endpoint response body, as the provider would return it. */
function tokenResponse(body: Record<string, unknown>): Response {
  return {
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

describe('TrinityOidcTokenRefresher', () => {
  beforeEach(() => {
    getAuthMetadata.mockReset();
    createClientSpy.mockClear();
    getAuthMetadata.mockResolvedValue(METADATA);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // setSystemTime below freezes the clock process-wide; without this it leaks into every
    // later test in the file (and vitest does not restore it on its own).
    vi.useRealTimers();
  });

  it('persists a full rotation under its own userId, with the expiry the provider gave', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse({
          token_type: 'Bearer',
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      ),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { refresher, updateTokens } = makeRefresher();

    const tokens = await refresher.tokenRefreshFunction('old-refresh');

    expect(tokens.accessToken).toBe('new-access');
    // The expiry is the regression test that matters here. The pre-42 shape declared a
    // narrower parameter than it passed, so this field was read through a cast and a
    // rename would have persisted `undefined` forever without failing anything.
    expect(updateTokens).toHaveBeenCalledWith(
      '@me:hs',
      'new-access',
      'new-refresh',
      1_700_000_000_000 + 3600 * 1000,
    );
  });

  it('persists no expiry when the provider returned none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse({ token_type: 'Bearer', access_token: 'new-access' }),
      ),
    );
    const { refresher, updateTokens } = makeRefresher();

    await refresher.tokenRefreshFunction('old-refresh');

    expect(updateTokens).toHaveBeenCalledWith(
      '@me:hs',
      'new-access',
      undefined,
      undefined,
    );
  });

  it('discovers through the account homeserver, not the issuer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse({ token_type: 'Bearer', access_token: 'a' }),
      ),
    );
    const { refresher } = makeRefresher();

    await refresher.tokenRefreshFunction('r');

    // matrix-js-sdk 42 dropped the issuer well-known probe, so metadata must come from the
    // account's own homeserver. Nothing else pins this: BINDING.issuer is a URL too, so
    // reverting to it — exactly what the pre-42 code did — stays type-correct and leaves
    // every other assertion in this file passing.
    expect(createClientSpy).toHaveBeenCalledWith({ baseUrl: 'https://hs' });
  });

  it('discovers once for two concurrent refreshes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse({ token_type: 'Bearer', access_token: 'a' }),
      ),
    );
    const { refresher } = makeRefresher();

    await Promise.all([
      refresher.tokenRefreshFunction('r1'),
      refresher.tokenRefreshFunction('r2'),
    ]);

    // The promise is memoized, not the result, so a burst of 401s costs one discovery.
    expect(getAuthMetadata).toHaveBeenCalledTimes(1);
  });

  it('retries discovery after a failure instead of wedging the session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse({ token_type: 'Bearer', access_token: 'a' }),
      ),
    );
    getAuthMetadata.mockRejectedValueOnce(new Error('homeserver unreachable'));
    const { refresher } = makeRefresher();

    await expect(refresher.tokenRefreshFunction('r1')).rejects.toThrow(
      /unreachable/,
    );

    // Memoizing the rejection would leave refresh permanently broken for the lifetime of
    // the client after a single transient blip — so the memo must be cleared on failure.
    await expect(refresher.tokenRefreshFunction('r2')).resolves.toMatchObject({
      accessToken: 'a',
    });
    expect(getAuthMetadata).toHaveBeenCalledTimes(2);
  });
});
