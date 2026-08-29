import type { MatrixSession } from '@trinity/util/matrix';

const payloads = new WeakMap<AuthenticatedAccountGrant, MatrixSession>();

/**
 * One successful authentication attempt, sealed for Account Runtime consumption.
 *
 * The grant deliberately exposes no session fields: callers can hand it to Account Runtime,
 * but cannot inspect, log, persist, or start a Matrix client from its credentials.
 */
export class AuthenticatedAccountGrant {
  private constructor() {}

  /** Seal authenticated material at the authentication/Account Runtime seam. */
  static issue(session: MatrixSession): AuthenticatedAccountGrant {
    const grant = Object.freeze(new AuthenticatedAccountGrant());
    payloads.set(grant, { ...session });
    return grant;
  }
}

export function authenticatedAccountGrantPayload(
  grant: AuthenticatedAccountGrant,
): MatrixSession {
  const payload = payloads.get(grant);
  if (!payload) {
    throw new Error('Account Runtime received an invalid authenticated grant.');
  }
  return { ...payload };
}

export function sameAuthenticatedAccountGrant(
  left: AuthenticatedAccountGrant,
  right: AuthenticatedAccountGrant,
): boolean {
  const leftPayload = authenticatedAccountGrantPayload(left);
  const rightPayload = authenticatedAccountGrantPayload(right);
  return (
    leftPayload.baseUrl === rightPayload.baseUrl &&
    leftPayload.userId === rightPayload.userId &&
    leftPayload.deviceId === rightPayload.deviceId &&
    leftPayload.accessToken === rightPayload.accessToken &&
    leftPayload.refreshToken === rightPayload.refreshToken &&
    leftPayload.accessTokenExpiresAt === rightPayload.accessTokenExpiresAt &&
    JSON.stringify(leftPayload.oidc) === JSON.stringify(rightPayload.oidc)
  );
}
