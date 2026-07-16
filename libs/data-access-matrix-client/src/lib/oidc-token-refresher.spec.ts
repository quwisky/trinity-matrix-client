import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { SessionStorageService } from '@trinity/platform-native';
import { TrinityOidcTokenRefresher } from './oidc-token-refresher';

const BINDING = {
  issuer: 'https://op',
  clientId: 'client-1',
  redirectUri: 'https://app/sso-callback',
  idTokenClaims: {
    iss: 'https://op',
    sub: 'u',
    aud: 'client-1',
    exp: 1,
    iat: 0,
  },
};

/** Reach the protected persistTokens override the SDK calls after a refresh. */
type Persistable = {
  persistTokens(tokens: {
    accessToken: string;
    refreshToken?: string;
    expiry?: Date;
  }): Promise<void>;
};

function makeRefresher(updateTokens = vi.fn(() => of(undefined))) {
  const storage = { updateTokens } as unknown as SessionStorageService;
  const refresher = new TrinityOidcTokenRefresher(
    storage,
    '@me:hs',
    BINDING,
    'DEV',
  );
  return { refresher: refresher as unknown as Persistable, updateTokens };
}

describe('TrinityOidcTokenRefresher', () => {
  it('persists a full rotation (access + refresh + expiry) under its own userId', async () => {
    const { refresher, updateTokens } = makeRefresher();

    await refresher.persistTokens({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiry: new Date(1_700_000_000_000),
    });

    expect(updateTokens).toHaveBeenCalledWith(
      '@me:hs',
      'new-access',
      'new-refresh',
      1_700_000_000_000, // Date → epoch ms
    );
  });

  it('persists with no expiry when the provider returned none', async () => {
    const { refresher, updateTokens } = makeRefresher();

    await refresher.persistTokens({ accessToken: 'new-access' });

    expect(updateTokens).toHaveBeenCalledWith(
      '@me:hs',
      'new-access',
      undefined,
      undefined,
    );
  });
});
