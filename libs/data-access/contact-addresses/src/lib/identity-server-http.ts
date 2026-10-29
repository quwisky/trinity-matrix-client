import {
  type EngineFailure,
  EngineRequestError,
  type MatrixRequestFailureKind,
} from '@trinity/util/matrix';
import type { OpenIdToken } from './contact-addresses-engine';

// The identity-server API v2, over plain fetch. Failures are thrown as `EngineRequestError`
// carrying only the status, errcode and retry delay: never a URL, token or address.

const PREFIX = '/_matrix/identity/v2';
// The same limit as the homeserver requests.
const TIMEOUT_MS = 30_000;
const ERRCODE = /^[A-Z][A-Z0-9_.-]{0,127}$/;
// Longer delays are dropped, as describeMatrixRequestFailure drops the SDK's.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

type Json = Readonly<Record<string, unknown>>;

/** Trades the homeserver's OpenID token for an identity access token. */
export async function registerWithIdentityServer(
  base: string,
  openId: OpenIdToken,
): Promise<string> {
  const answer = await call(base, 'POST', '/account/register', {
    body: {
      access_token: openId.accessToken,
      token_type: openId.tokenType,
      matrix_server_name: openId.matrixServerName,
      expires_in: openId.expiresIn,
    },
  });
  // The spec names it `token`; Trinity read `access_token` before, which older servers send alone.
  const token = answer['token'] ?? answer['access_token'];
  if (typeof token !== 'string' || !token) {
    throw new Error('The identity server issued no token');
  }
  return token;
}

/** The server's policies by id, each with a `version` and one entry per language. */
export async function getTerms(
  base: string,
): Promise<Readonly<Record<string, Json>>> {
  const { policies } = await call(base, 'GET', '/terms');
  if (!isJson(policies) || !Object.values(policies).every(isJson)) {
    throw new Error('The identity server sent malformed terms');
  }
  return policies as Readonly<Record<string, Json>>;
}

export async function agreeToTerms(
  base: string,
  token: string,
  urls: readonly string[],
): Promise<void> {
  await call(base, 'POST', '/terms', {
    token,
    body: { user_accepts: [...urls] },
  });
}

/** Asks the identity server to mail a validation link; returns the session id. */
export async function requestEmailToken(
  base: string,
  token: string,
  request: {
    readonly email: string;
    readonly clientSecret: string;
    readonly sendAttempt: number;
  },
): Promise<string> {
  const { sid } = await call(base, 'POST', '/validate/email/requestToken', {
    token,
    body: {
      email: request.email,
      client_secret: request.clientSecret,
      send_attempt: request.sendAttempt,
    },
  });
  if (typeof sid !== 'string' || !sid) {
    throw new Error('The identity server opened no session');
  }
  return sid;
}

/**
 * The Matrix IDs the server maps `emails` to. Only sha256 hashes with the server's pepper
 * leave the device; a server that offers no sha256 is refused, never sent plain text.
 */
export async function hashedLookup(
  base: string,
  token: string,
  emails: readonly string[],
): Promise<readonly { readonly address: string; readonly mxid: string }[]> {
  const { algorithms, lookup_pepper: pepper } = await call(
    base,
    'GET',
    '/hash_details',
    { token },
  );
  if (
    typeof pepper !== 'string' ||
    !pepper ||
    !Array.isArray(algorithms) ||
    !algorithms.includes('sha256')
  ) {
    throw new Error('The identity server offers no sha256 lookup');
  }
  const byHash = new Map(
    await Promise.all(
      emails.map(
        async (email) =>
          [
            await sha256(`${email.toLowerCase()} email ${pepper}`),
            email,
          ] as const,
      ),
    ),
  );
  const { mappings } = await call(base, 'POST', '/lookup', {
    token,
    body: { addresses: [...byHash.keys()], algorithm: 'sha256', pepper },
  });
  if (mappings === undefined || mappings === null) return [];
  if (!isJson(mappings))
    throw new Error('The identity server sent malformed mappings');
  return Object.entries(mappings).map(([hash, mxid]) => {
    const address = byHash.get(hash);
    if (address === undefined || typeof mxid !== 'string') {
      throw new Error(
        'The identity server answered an address it was not asked',
      );
    }
    return { address, mxid };
  });
}

/** A fresh validation-session secret: 192 random bits as hex, no less than js-sdk's. */
export function newClientSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function call(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  { token, body }: { readonly token?: string; readonly body?: unknown } = {},
): Promise<Json> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${base}${PREFIX}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    const kind =
      (error as { name?: unknown } | null)?.name === 'TimeoutError'
        ? 'timeout'
        : 'network';
    throw new EngineRequestError({
      kind,
      code: 'request-failed',
      diagnostic: { kind },
    });
  }
  const json = parse(text);
  if (!response.ok) {
    throw new EngineRequestError(answerFailure(response.status, json));
  }
  if (!json) throw new Error('The identity server sent no JSON object');
  return json;
}

function answerFailure(httpStatus: number, json: Json | null): EngineFailure {
  const errcode =
    typeof json?.['errcode'] === 'string' && ERRCODE.test(json['errcode'])
      ? json['errcode']
      : undefined;
  const limited = httpStatus === 429 || errcode === 'M_LIMIT_EXCEEDED';
  // shortcut: reads retry_after_ms only, not a Retry-After header; parse it if a server sends one.
  const delay = json?.['retry_after_ms'];
  const retryAfterMs =
    limited &&
    typeof delay === 'number' &&
    delay >= 0 &&
    delay <= MAX_RETRY_AFTER_MS
      ? delay
      : undefined;
  const kind: MatrixRequestFailureKind = limited
    ? 'rate-limit'
    : httpStatus >= 500
      ? 'server'
      : 'http';
  return {
    kind,
    code: 'request-failed',
    diagnostic: {
      kind,
      httpStatus,
      ...(errcode ? { errcode } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  };
}

function parse(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isJson(value) ? value : null;
  } catch {
    return null;
  }
}

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
