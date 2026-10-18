import type { AuthenticationHomeserverDiscovery } from './homeserver-discovery.port';
import {
  AuthenticatedAccountGrant,
  type AccountEstablishmentIntent,
} from '@trinity/data-access/accounts';
import { Observable, catchError, map, of, throwError } from 'rxjs';
import { sameHomeserver } from '@trinity/platform-native';
import {
  isValidServerName,
  type MatrixSession,
  type OidcSessionBinding,
} from '@trinity/util/matrix';

export type LoginMode = 'replace' | 'add';

/**
 * A sign-in came back as a different account than the one being re-authenticated.
 * Nothing is persisted for it, so the saved account keeps its device and crypto store.
 */
export class ReauthAccountMismatchError extends Error {
  constructor(
    readonly actualUserId: string,
    readonly expectedUserId: string,
  ) {
    super(
      `The server signed you in as ${actualUserId}, not ${expectedUserId}. ` +
        'Sign in to that account instead.',
    );
  }
}

const UNACCEPTABLE_ACCOUNT_MESSAGES = {
  malformed: () =>
    "The server returned an account Trinity can't use. Nothing was saved.",
  'other-server': (userId: string) =>
    `The server signed you in as ${userId}, an account on a different server. ` +
    "Sign in through that account's own server instead.",
  unconfirmed: (userId: string) =>
    `Trinity couldn't confirm that ${userId} belongs to this server. ` +
    "Try again later, or sign in through that account's own server.",
};

/**
 * The server returned an account Trinity will not store: an ID outside the Matrix
 * grammar, or a user ID on a server other than the one signed in to.
 */
export class UnacceptableAccountError extends Error {
  constructor(
    readonly reason: 'malformed' | 'other-server' | 'unconfirmed',
    readonly userId: string,
  ) {
    super(UNACCEPTABLE_ACCOUNT_MESSAGES[reason](userId));
  }
}

const MAX_ID_LENGTH = 255;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The server name of a user ID in the `@localpart:server_name` grammar, or null. The
 * localpart may hold any character of the spec's historical range, U+0021 to U+007E
 * except `:`, which also keeps out whitespace, zero-width and bidi characters.
 */
export function userIdServerName(userId: string): string | null {
  const match = /^@[\x21-\x39\x3b-\x7e]+:(.+)$/.exec(userId);
  return match && userId.length <= MAX_ID_LENGTH && isValidServerName(match[1])
    ? match[1]
    : null;
}

/**
 * Store names join the user and device IDs with `:` (`trinity-crypto:<user>:<device>`),
 * so a device ID holding a `:` could spell another account's store.
 */
export function isValidDeviceId(deviceId: string): boolean {
  return (
    deviceId.length > 0 &&
    deviceId.length <= MAX_ID_LENGTH &&
    !deviceId.includes(':') &&
    !CONTROL_CHARACTER.test(deviceId)
  );
}

/**
 * Refuse a user ID whose server is not the homeserver signed in to, so one server cannot
 * file an account under another server's name. The server is accepted when the base URL's
 * host is its name or a subdomain of it, when it is the server the person entered, or
 * when its well-known names this base URL. `userId` must already have passed
 * {@link userIdServerName}.
 */
export function verifyAccountServer(
  baseUrl: string,
  userId: string,
  discovery: AuthenticationHomeserverDiscovery,
  enteredServerName?: string,
): Observable<void> {
  const serverName = userIdServerName(userId) ?? '';
  if (
    hostWithinServerName(baseUrl, serverName) ||
    serverName.toLowerCase() === enteredServerName?.trim().toLowerCase()
  ) {
    return of(undefined);
  }
  // Discovery takes the whole user ID: a bare server name with a port would lose its host.
  return discovery.lookUp(userId).pipe(
    catchError(() =>
      throwError(() => new UnacceptableAccountError('unconfirmed', userId)),
    ),
    map((found) => {
      if (!sameHomeserver(found.baseUrl, baseUrl)) {
        throw new UnacceptableAccountError('other-server', userId);
      }
    }),
  );
}

function hostWithinServerName(baseUrl: string, serverName: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/\.$/, '');
  } catch {
    return false;
  }
  const name = new URL(`matrix://${serverName}`).hostname.toLowerCase();
  // An IP address has no subdomains: `1.2.3.4` must not pass as part of `2.3.4`.
  const isIp = name.startsWith('[') || /^[\d.]+$/.test(name);
  return host === name || (!isIp && host.endsWith(`.${name}`));
}

export interface AuthenticatedSessionResponse {
  user_id: string;
  device_id: string;
  access_token: string;
  refresh_token?: string;
  accessTokenExpiresAt?: number;
  oidc?: OidcSessionBinding;
}

export function accountEstablishment(
  baseUrl: string,
  response: AuthenticatedSessionResponse,
  mode: LoginMode,
  accountRecord: AccountEstablishmentIntent['accountRecord'],
): {
  readonly grant: AuthenticatedAccountGrant;
  readonly intent: AccountEstablishmentIntent;
} {
  if (
    userIdServerName(response.user_id) === null ||
    !isValidDeviceId(response.device_id)
  ) {
    throw new UnacceptableAccountError('malformed', response.user_id);
  }
  const session: MatrixSession = {
    baseUrl,
    userId: response.user_id,
    deviceId: response.device_id,
    accessToken: response.access_token,
    ...(response.refresh_token !== undefined
      ? { refreshToken: response.refresh_token }
      : {}),
    ...(response.accessTokenExpiresAt !== undefined
      ? { accessTokenExpiresAt: response.accessTokenExpiresAt }
      : {}),
    ...(response.oidc ? { oidc: response.oidc } : {}),
  };
  return {
    grant: AuthenticatedAccountGrant.issue(session),
    intent: {
      placement: 'active',
      liveAccounts: mode === 'add' ? 'keep' : 'replace',
      accountRecord,
    },
  };
}
