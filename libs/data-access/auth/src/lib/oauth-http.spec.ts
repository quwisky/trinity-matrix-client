import { isValidAuthMetadata as sdkIsValidAuthMetadata } from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineRequestError } from '@trinity/util/matrix';
import { AUTH_METADATA } from './auth-metadata.fixture';
import {
  OAuthGrantType,
  authorizationCodeUrl,
  isValidAuthMetadata,
  redeemAuthorizationCode,
  registerClient,
  revokeToken,
} from './oauth-http';

/** A provider answer as `fetch` resolves it: status, headers and a JSON (or broken) body. */
function answer(body: unknown, status = 200) {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

const CLIENT = {
  client_name: 'Trinity',
  client_uri: 'https://trinity.trinityproject.dev',
  application_type: 'web' as const,
  redirect_uris: ['https://app/sso-callback'],
};

describe('oauth-http', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
  });

  describe('isValidAuthMetadata', () => {
    const { response_modes_supported: _modes, ...noModes } = AUTH_METADATA;
    const cases: Record<string, unknown> = {
      'the complete fixture': AUTH_METADATA,
      'no metadata': null,
      'an array': [AUTH_METADATA],
      'no response modes': noModes,
      'an empty issuer': { ...AUTH_METADATA, issuer: '' },
      'a numeric token endpoint': { ...AUTH_METADATA, token_endpoint: 7 },
      'no revocation endpoint': {
        ...AUTH_METADATA,
        revocation_endpoint: undefined,
      },
      'no registration endpoint': {
        ...AUTH_METADATA,
        registration_endpoint: undefined,
      },
      'a numeric account page': { ...AUTH_METADATA, account_management_uri: 1 },
      'an empty account page': { ...AUTH_METADATA, account_management_uri: '' },
      'a numeric device endpoint': {
        ...AUTH_METADATA,
        device_authorization_endpoint: 3,
      },
      'mixed prompt values': {
        ...AUTH_METADATA,
        prompt_values_supported: ['create', 2],
      },
      'account actions that are not a list': {
        ...AUTH_METADATA,
        account_management_actions_supported: 'org.matrix.profile',
      },
      'no fragment response mode': {
        ...AUTH_METADATA,
        response_modes_supported: ['query'],
      },
      'no code response type': {
        ...AUTH_METADATA,
        response_types_supported: ['token'],
      },
      'no refresh grant': {
        ...AUTH_METADATA,
        grant_types_supported: ['authorization_code'],
      },
      'no authorization-code grant': {
        ...AUTH_METADATA,
        grant_types_supported: ['refresh_token'],
      },
      'only plain PKCE': {
        ...AUTH_METADATA,
        code_challenge_methods_supported: ['plain'],
      },
      'PKCE methods as a string': {
        ...AUTH_METADATA,
        code_challenge_methods_supported: 'S256',
      },
    };

    it.each(Object.entries(cases))(
      'agrees with matrix-js-sdk on %s',
      (_, metadata) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(isValidAuthMetadata(metadata)).toBe(
          sdkIsValidAuthMetadata(metadata),
        );
      },
    );

    it('accepts the fixture the specs share', () => {
      expect(isValidAuthMetadata(AUTH_METADATA)).toBe(true);
    });
  });

  describe('authorizationCodeUrl', () => {
    it('asks for a code by S256 PKCE, answered in the query, for a scoped device', async () => {
      const request = await authorizationCodeUrl(AUTH_METADATA, {
        clientId: 'client-1',
        redirectUri: 'https://app/sso-callback',
        state: 'state-1',
        prompt: 'create',
      });

      const url = new URL(request.url);
      expect(`${url.origin}${url.pathname}`).toBe(
        AUTH_METADATA.authorization_endpoint,
      );
      expect([...url.searchParams.keys()]).toEqual([
        'response_type',
        'response_mode',
        'client_id',
        'redirect_uri',
        'scope',
        'state',
        'code_challenge_method',
        'code_challenge',
        'prompt',
      ]);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        response_type: 'code',
        response_mode: 'query',
        client_id: 'client-1',
        redirect_uri: 'https://app/sso-callback',
        scope: `urn:matrix:client:api:* urn:matrix:client:device:${request.deviceId}`,
        state: 'state-1',
        code_challenge_method: 'S256',
        prompt: 'create',
      });
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(request.codeVerifier),
        ),
      );
      expect(url.searchParams.get('code_challenge')).toBe(
        btoa(String.fromCharCode(...digest))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/u, ''),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('mints a 96-character verifier and a 10-character device, both alphanumeric', async () => {
      const first = await authorizationCodeUrl(AUTH_METADATA, {
        clientId: 'c',
        redirectUri: 'https://app/cb',
        state: 's',
      });
      const second = await authorizationCodeUrl(AUTH_METADATA, {
        clientId: 'c',
        redirectUri: 'https://app/cb',
        state: 's',
      });

      expect(first.codeVerifier).toMatch(/^[A-Za-z0-9]{96}$/u);
      expect(first.deviceId).toMatch(/^[A-Za-z0-9]{10}$/u);
      expect(second.codeVerifier).not.toBe(first.codeVerifier);
      expect(second.deviceId).not.toBe(first.deviceId);
      expect(new URL(first.url).searchParams.has('prompt')).toBe(false);
    });

    it('keeps a device it is given', async () => {
      const request = await authorizationCodeUrl(AUTH_METADATA, {
        clientId: 'c',
        redirectUri: 'https://app/cb',
        state: 's',
        deviceId: 'OLDDEV',
      });

      expect(request.deviceId).toBe('OLDDEV');
    });
  });

  describe('redeemAuthorizationCode', () => {
    const GRANT = {
      clientId: 'client-1',
      codeVerifier: 'verifier',
      redirectUri: 'https://app/sso-callback',
      code: 'CODE',
    };

    it('posts the code and verifier as a form to the endpoint it is given', async () => {
      fetchMock.mockResolvedValue(
        answer({
          token_type: 'bearer',
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 300,
        }),
      );

      const token = await redeemAuthorizationCode(
        'https://stashed.example/token',
        GRANT,
      );

      expect(token).toEqual({
        token_type: 'Bearer',
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 300,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://stashed.example/token');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      });
      expect([...new URLSearchParams(String(init.body))]).toEqual([
        ['grant_type', 'authorization_code'],
        ['client_id', 'client-1'],
        ['code_verifier', 'verifier'],
        ['redirect_uri', 'https://app/sso-callback'],
        ['code', 'CODE'],
      ]);
    });

    it('fails oauth-client-rejected when the provider answers invalid_client', async () => {
      fetchMock.mockResolvedValue(
        answer(
          { error: 'invalid_client', error_description: 'unknown client' },
          401,
        ),
      );

      const error = await redeemAuthorizationCode(
        'https://op/token',
        GRANT,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EngineRequestError);
      expect((error as EngineRequestError).failure).toEqual({
        kind: 'http',
        code: 'oauth-client-rejected',
        diagnostic: { kind: 'http', httpStatus: 401 },
      });
      expect((error as Error).message).toBe(
        'The sign-in provider no longer recognises this app. Try signing in again.',
      );
    });

    it.each([
      ['another OAuth error', answer({ error: 'invalid_grant' }, 400)],
      ['a Matrix error', answer({ errcode: 'M_UNKNOWN', error: 'nope' }, 500)],
      ['a body that is not JSON', answer(new SyntaxError('bad json'), 502)],
    ])('fails the exchange plainly on %s', async (_, response) => {
      fetchMock.mockResolvedValue(response);

      const error = await redeemAuthorizationCode(
        'https://op/token',
        GRANT,
      ).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(EngineRequestError);
      expect((error as Error).message).toBe(
        'Failed to exchange code for token',
      );
    });

    it.each([
      ['no access token', { token_type: 'Bearer' }],
      ['a MAC token', { token_type: 'mac', access_token: 'at' }],
      [
        'a lifetime that is not a number',
        { token_type: 'Bearer', access_token: 'at', expires_in: '300' },
      ],
      [
        'a refresh token that is not a string',
        { token_type: 'Bearer', access_token: 'at', refresh_token: 1 },
      ],
    ])('refuses a token answer with %s', async (_, body) => {
      fetchMock.mockResolvedValue(answer(body));

      await expect(
        redeemAuthorizationCode('https://op/token', GRANT),
      ).rejects.toThrow('Invalid bearer token response');
    });

    it('lets a connection failure through as it is', async () => {
      const offline = new TypeError('Failed to fetch');
      fetchMock.mockRejectedValue(offline);

      await expect(
        redeemAuthorizationCode('https://op/token', GRANT),
      ).rejects.toBe(offline);
    });
  });

  describe('revokeToken', () => {
    it('posts the token, client and hint as a form (RFC 7009)', async () => {
      fetchMock.mockResolvedValue(answer({}));

      await revokeToken('https://op/revoke', 'client-1', 'rt', 'refresh_token');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://op/revoke');
      expect([...new URLSearchParams(String(init.body))]).toEqual([
        ['token', 'rt'],
        ['client_id', 'client-1'],
        ['token_type_hint', 'refresh_token'],
      ]);
    });

    it('fails when the provider refuses', async () => {
      fetchMock.mockResolvedValue(answer({ error: 'unsupported' }, 400));

      await expect(
        revokeToken('https://op/revoke', 'client-1', 'at', 'access_token'),
      ).rejects.toThrow('Failed to revoke token');
    });
  });

  describe('registerClient', () => {
    it('registers a public code client, adding the device grant the provider supports', async () => {
      fetchMock.mockResolvedValue(answer({ client_id: 'client-1' }));

      await expect(registerClient(AUTH_METADATA, CLIENT)).resolves.toBe(
        'client-1',
      );

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(AUTH_METADATA.registration_endpoint);
      expect(init.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init.body))).toEqual({
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...CLIENT,
        grant_types: [
          OAuthGrantType.AuthorizationCode,
          OAuthGrantType.RefreshToken,
          OAuthGrantType.DeviceAuthorization,
        ],
      });
    });

    it('asks only for the code and refresh grants of a provider without the device grant', async () => {
      fetchMock.mockResolvedValue(answer({ client_id: 'client-1' }));

      await registerClient(
        {
          ...AUTH_METADATA,
          grant_types_supported: ['authorization_code', 'refresh_token'],
        },
        CLIENT,
      );

      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject(
        { grant_types: ['authorization_code', 'refresh_token'] },
      );
    });

    it('refuses grants the provider does not support, before any request', async () => {
      await expect(
        registerClient(
          {
            ...AUTH_METADATA,
            grant_types_supported: ['authorization_code', 'refresh_token'],
          },
          { ...CLIENT, grant_types: [OAuthGrantType.DeviceAuthorization] },
        ),
      ).rejects.toThrow('Dynamic registration not supported');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a refusal', () => answer({ error: 'server_error' }, 500)],
      [
        'no connection',
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
      ['a body that is not JSON', () => answer(new SyntaxError('bad json'))],
    ])('registers once more after %s', async (_, first) => {
      fetchMock
        .mockImplementationOnce(async () => first())
        .mockResolvedValueOnce(answer({ client_id: 'client-1' }));

      await expect(registerClient(AUTH_METADATA, CLIENT)).resolves.toBe(
        'client-1',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails when the second registration fails too', async () => {
      fetchMock.mockResolvedValue(answer({ error: 'server_error' }, 500));

      await expect(registerClient(AUTH_METADATA, CLIENT)).rejects.toThrow(
        'Dynamic registration failed',
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['no client id', {}],
      ['a JSON null', null],
      ['an empty client id', { client_id: '' }],
    ])('does not register again after an answer with %s', async (_, body) => {
      fetchMock.mockResolvedValue(answer(body));

      await expect(registerClient(AUTH_METADATA, CLIENT)).rejects.toThrow(
        'Dynamic registration invalid response',
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
