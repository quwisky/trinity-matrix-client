import { EngineRequestError } from '@trinity/util/matrix';
import type { AuthMetadata } from './auth-metadata';

/** The OAuth 2.0 grants the Matrix spec names (RFC 6749, RFC 8628). */
export const OAuthGrantType = {
  AuthorizationCode: 'authorization_code',
  RefreshToken: 'refresh_token',
  DeviceAuthorization: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

/** What a client registers as (RFC 7591), as the provider receives it. */
export interface OAuthClientMetadata {
  readonly client_name: string;
  readonly client_uri: string;
  readonly application_type: 'web' | 'native';
  readonly redirect_uris: readonly string[];
  readonly grant_types?: readonly string[];
}

/** A token endpoint's answer (RFC 6749 section 5.1), with `token_type` normalised. */
export interface BearerTokenResponse {
  readonly token_type: 'Bearer';
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
}

const ALPHANUMERIC =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is auth metadata the Matrix spec requires, by the rules of matrix-js-sdk's
 * `isValidAuthMetadata`: the five endpoints, the query and fragment response modes, the code
 * response type, the authorization-code and refresh grants, and S256 PKCE.
 */
export function isValidAuthMetadata(value: unknown): value is AuthMetadata {
  if (!isRecord(value)) return false;
  const required = (key: string) =>
    typeof value[key] === 'string' && value[key] !== '';
  const optional = (key: string) =>
    !value[key] || typeof value[key] === 'string';
  const optionalStrings = (key: string) => {
    const list = value[key];
    return (
      !list ||
      (Array.isArray(list) && list.every((item) => typeof item === 'string'))
    );
  };
  const lists = (key: string, item: string) => {
    const list = value[key];
    return Array.isArray(list) && list.includes(item);
  };
  return (
    required('issuer') &&
    required('authorization_endpoint') &&
    required('token_endpoint') &&
    required('revocation_endpoint') &&
    required('registration_endpoint') &&
    optional('account_management_uri') &&
    optional('device_authorization_endpoint') &&
    optionalStrings('account_management_actions_supported') &&
    optionalStrings('prompt_values_supported') &&
    lists('response_modes_supported', 'query') &&
    lists('response_modes_supported', 'fragment') &&
    lists('response_types_supported', 'code') &&
    lists('grant_types_supported', OAuthGrantType.AuthorizationCode) &&
    lists('grant_types_supported', OAuthGrantType.RefreshToken) &&
    lists('code_challenge_methods_supported', 'S256')
  );
}

/** Random alphanumerics, each equally likely: bytes past the last whole alphabet are dropped. */
function randomString(length: number): string {
  const cutoff = 256 - (256 % ALPHANUMERIC.length);
  let result = '';
  while (result.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < cutoff && result.length < length) {
        result += ALPHANUMERIC[byte % ALPHANUMERIC.length];
      }
    }
  }
  return result;
}

async function pkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/**
 * The authorization-code URL with a fresh S256 PKCE verifier (RFC 7636), for the device
 * given or a new one. The verifier and device come back for the caller to keep: nothing
 * here remembers them, so a callback in another process can still redeem the code.
 */
export async function authorizationCodeUrl(
  metadata: AuthMetadata,
  request: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly prompt?: string;
    readonly deviceId?: string;
  },
): Promise<{ url: string; deviceId: string; codeVerifier: string }> {
  const deviceId = request.deviceId ?? randomString(10);
  const codeVerifier = randomString(96);
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  // 'query' is LOAD-BEARING: every callback reader here takes query params only
  // (sso-callback.page.ts via queryParamMap, app.component.ts via searchParams). Moving to
  // 'fragment' (it keeps the code out of server logs) means teaching both readers first.
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set(
    'scope',
    `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`,
  );
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', await pkceChallenge(codeVerifier));
  if (request.prompt) url.searchParams.set('prompt', request.prompt);
  return { url: url.href, deviceId, codeVerifier };
}

/**
 * POST a form to an OAuth endpoint. An error answer throws `failureText`, or fails
 * `oauth-client-rejected` when the provider no longer knows the client (`invalid_client`).
 * Neither carries the response body.
 */
async function postForm(
  endpoint: string,
  form: Record<string, string>,
  failureText: string,
): Promise<Response> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form),
  });
  if (response.status < 400) return response;
  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && body['error'] === 'invalid_client') {
    throw new EngineRequestError({
      kind: 'http',
      code: 'oauth-client-rejected',
      diagnostic: { kind: 'http', httpStatus: response.status },
    });
  }
  throw new Error(failureText);
}

/** Redeem an authorization code at exactly `tokenEndpoint` (RFC 6749 section 4.1.3). */
export async function redeemAuthorizationCode(
  tokenEndpoint: string,
  grant: {
    readonly clientId: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly code: string;
  },
): Promise<BearerTokenResponse> {
  const response = await postForm(
    tokenEndpoint,
    {
      grant_type: OAuthGrantType.AuthorizationCode,
      client_id: grant.clientId,
      code_verifier: grant.codeVerifier,
      redirect_uri: grant.redirectUri,
      code: grant.code,
    },
    'Failed to exchange code for token',
  );
  const token: unknown = await response.json();
  if (
    !isRecord(token) ||
    typeof token['token_type'] !== 'string' ||
    token['token_type'].toLowerCase() !== 'bearer' ||
    typeof token['access_token'] !== 'string' ||
    token['access_token'] === '' ||
    (token['expires_in'] && typeof token['expires_in'] !== 'number') ||
    (token['refresh_token'] && typeof token['refresh_token'] !== 'string') ||
    (token['scope'] && typeof token['scope'] !== 'string')
  ) {
    throw new Error('Invalid bearer token response');
  }
  return { ...token, token_type: 'Bearer' } as BearerTokenResponse;
}

/** Revoke one token at `revocationEndpoint` (RFC 7009); the answer's body is ignored. */
export async function revokeToken(
  revocationEndpoint: string,
  clientId: string,
  token: string,
  hint: 'access_token' | 'refresh_token',
): Promise<void> {
  await postForm(
    revocationEndpoint,
    { token, client_id: clientId, token_type_hint: hint },
    'Failed to revoke token',
  );
}

/** The registration endpoint's JSON answer, or undefined when the request failed. */
async function registrationAnswer(
  endpoint: string,
  body: string,
): Promise<unknown> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    });
    return response.status >= 400 ? undefined : await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Register a public client for the authorization-code grant (RFC 7591), asking for the
 * device grant too where the provider has it unless `client.grant_types` says otherwise.
 * A failed registration is sent once more: MAS answers 500 to the loser of two
 * registrations racing to store the same client metadata, and the second try reuses the
 * winner's client.
 */
export async function registerClient(
  metadata: AuthMetadata,
  client: OAuthClientMetadata,
): Promise<string> {
  const supported = metadata.grant_types_supported;
  const grantTypes = client.grant_types ?? [
    OAuthGrantType.AuthorizationCode,
    OAuthGrantType.RefreshToken,
    ...(supported.includes(OAuthGrantType.DeviceAuthorization)
      ? [OAuthGrantType.DeviceAuthorization]
      : []),
  ];
  if (grantTypes.some((grant) => !supported.includes(grant))) {
    throw new Error('Dynamic registration not supported');
  }
  const body = JSON.stringify({
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...client,
    grant_types: grantTypes,
  });
  let registered = await registrationAnswer(
    metadata.registration_endpoint,
    body,
  );
  if (registered === undefined) {
    registered = await registrationAnswer(metadata.registration_endpoint, body);
  }
  if (registered === undefined) {
    throw new Error('Dynamic registration failed');
  }
  if (
    !isRecord(registered) ||
    typeof registered['client_id'] !== 'string' ||
    registered['client_id'] === ''
  ) {
    throw new Error('Dynamic registration invalid response');
  }
  return registered['client_id'];
}
