import { vi } from 'vitest';

export const OP = 'https://op.example';
export const METADATA = {
  issuer: `${OP}/`,
  authorization_endpoint: `${OP}/authorize`,
  token_endpoint: `${OP}/token`,
  revocation_endpoint: `${OP}/revoke`,
  registration_endpoint: `${OP}/register`,
  response_modes_supported: ['query', 'fragment'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
};

/** How the fake provider answers a refresh grant. */
type Rotation = 'rotate' | 'omit' | 'empty';

/** `up` answers normally, `down` drops the connection, anything else is the error sent instead. */
type Endpoint = 'up' | 'down' | { status: number; body: unknown };

/** The provider can also `hang`: never answer, until the caller aborts. */
type ProviderEndpoint = Endpoint | 'hang';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A homeserver that accepts only the tokens the fake provider issued, and that provider. */
export function fakeNetwork(
  rotation: Rotation = 'rotate',
  expiresIn: number | null = 30,
) {
  const live = new Set<string>();
  const grants: URLSearchParams[] = [];
  const revocations: string[] = [];
  const calls: string[] = [];
  const state = {
    discovery: 'up' as Endpoint,
    provider: 'up' as ProviderEndpoint,
    /** Rotate at the provider, then drop the answer, as when iOS suspends the app mid-grant. */
    loseGrantResponse: false,
    /** How long auth metadata discovery takes to answer. */
    discoveryDelayMs: 0,
    /** The issuer's own RFC 8414 document; null answers 404 and `down` drops the connection. */
    issuerDocument: null as unknown,
  };
  // Like MAS, a grant revokes the access token issued with the refresh token it spends.
  const issuedWith = new Map<string, string>();
  let whoamiGate: Promise<void> | undefined;
  let whoamiHeld = 0;
  let whoamiRefused = 0;
  let issued = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const form = new URLSearchParams(String(init.body ?? ''));
      calls.push(`${init.method ?? 'GET'} ${url.host}${url.pathname}`);
      // The homeserver also answers under a base path or a doubled slash.
      const path = url.pathname
        .replace(/\/{2,}/g, '/')
        .replace(/^\/mx(?=\/)/, '');
      if (path === '/_matrix/client/v1/auth_metadata') {
        if (state.discoveryDelayMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, state.discoveryDelayMs),
          );
        }
        if (state.discovery === 'down') throw new TypeError('Failed to fetch');
        if (state.discovery !== 'up') {
          return json(state.discovery.body, state.discovery.status);
        }
        return json(METADATA);
      }
      if (url.href === `${OP}/.well-known/oauth-authorization-server`) {
        if (state.issuerDocument === 'down') {
          throw new TypeError('Failed to fetch');
        }
        return state.issuerDocument === null
          ? json({}, 404)
          : json(state.issuerDocument);
      }
      if (url.href === METADATA.token_endpoint) {
        // Like fetch, an already aborted signal sends nothing.
        if (init.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (state.provider === 'down') throw new TypeError('Failed to fetch');
        if (state.provider === 'hang') {
          return new Promise<Response>((_, reject) => {
            const abort = () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              );
            if (init.signal?.aborted) abort();
            init.signal?.addEventListener('abort', abort);
          });
        }
        if (state.provider !== 'up') {
          return json(state.provider.body, state.provider.status);
        }
        grants.push(form);
        issued += 1;
        const spent = form.get('refresh_token') ?? '';
        live.delete(issuedWith.get(spent) ?? '');
        issuedWith.set(
          rotation === 'rotate' ? `rt-${issued}` : spent,
          `at-${issued}`,
        );
        live.add(`at-${issued}`);
        if (state.loseGrantResponse) throw new TypeError('Failed to fetch');
        return json({
          token_type: 'Bearer',
          access_token: `at-${issued}`,
          // Under the SDK's 60 s window, so a later 401 reads as expiry, not revocation.
          ...(expiresIn === null ? {} : { expires_in: expiresIn }),
          ...(rotation === 'rotate'
            ? { refresh_token: `rt-${issued}` }
            : rotation === 'empty'
              ? { refresh_token: '' }
              : {}),
        });
      }
      if (url.href === METADATA.revocation_endpoint) {
        revocations.push(form.get('token_type_hint') ?? '');
        return new Response('', { status: 200 });
      }
      if (path === '/_matrix/client/v3/account/whoami') {
        if (whoamiGate) {
          whoamiHeld += 1;
          await whoamiGate;
        }
        const bearer = new Headers(init.headers).get('authorization') ?? '';
        const known = live.has(bearer.replace(/^Bearer /, ''));
        if (!known) whoamiRefused += 1;
        return known
          ? json({ user_id: '@me:hs', device_id: 'DEV' })
          : json(
              {
                errcode: 'M_UNKNOWN_TOKEN',
                error: 'expired',
                soft_logout: false,
              },
              401,
            );
      }
      if (path.endsWith('/logout')) return json({});
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url.href}`);
    }),
  );
  return {
    live,
    grants,
    revocations,
    calls,
    state,
    expireAll: () => live.clear(),
    /** Hold whoami at the homeserver, before it reads the token; returns the release. */
    holdWhoami: (): (() => void) => {
      let release!: () => void;
      whoamiGate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        whoamiGate = undefined;
        release();
      };
    },
    whoamiHeld: () => whoamiHeld,
    whoamiRefused: () => whoamiRefused,
  };
}
