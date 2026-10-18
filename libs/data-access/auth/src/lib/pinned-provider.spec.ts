import { describe, expect, it } from 'vitest';
import { matchesPinnedProvider } from './pinned-provider';

const PINNED = {
  issuer: 'https://account.matrix.org/',
  clientId: 'c1',
  redirectUri: 'https://app/cb',
  tokenEndpoint: 'https://account.matrix.org/oauth2/token',
  revocationEndpoint: 'https://account.matrix.org/oauth2/revoke',
};
const METADATA = {
  issuer: 'https://account.matrix.org/',
  authorization_endpoint: 'https://account.matrix.org/authorize',
  token_endpoint: 'https://account.matrix.org/oauth2/token',
  revocation_endpoint: 'https://account.matrix.org/oauth2/revoke',
};

describe('matchesPinnedProvider', () => {
  it('matches the provider the account signed in with', () => {
    expect(matchesPinnedProvider(METADATA, PINNED)).toBe(true);
    expect(
      matchesPinnedProvider(
        {
          ...METADATA,
          issuer: 'HTTPS://Account.Matrix.org:443/',
          token_endpoint: 'https://ACCOUNT.matrix.org/oauth2/token',
        },
        PINNED,
      ),
    ).toBe(true);
  });

  it.each([
    ['issuer', { issuer: 'https://account.matrix.org/other/' }],
    ['token endpoint', { token_endpoint: 'https://hs.example/token' }],
    [
      'authorization host',
      { authorization_endpoint: 'https://login.example/authorize' },
    ],
  ])('refuses another %s', (_, change) => {
    expect(matchesPinnedProvider({ ...METADATA, ...change }, PINNED)).toBe(
      false,
    );
  });

  it('refuses a sign-in page on the pinned token host but not the issuer host', () => {
    const binding = {
      ...PINNED,
      issuer: 'https://auth.hs.example/',
      tokenEndpoint: 'https://account.matrix.org/oauth2/token',
    };

    expect(
      matchesPinnedProvider(
        { ...METADATA, issuer: 'https://auth.hs.example/' },
        binding,
      ),
    ).toBe(false);
  });

  it('refuses another revocation endpoint than the pinned one', () => {
    expect(
      matchesPinnedProvider(
        { ...METADATA, revocation_endpoint: 'https://hs.example/revoke' },
        PINNED,
      ),
    ).toBe(false);
  });

  it('refuses a binding saved before endpoints were pinned', () => {
    const { tokenEndpoint: _t, revocationEndpoint: _r, ...unpinned } = PINNED;
    expect(matchesPinnedProvider(METADATA, unpinned)).toBe(false);
  });
});
