import { Injectable, inject } from '@angular/core';
import {
  HTTPError,
  MatrixError,
  createClient,
  type AuthDict,
  type LoginRequest,
} from 'matrix-js-sdk';
import { type Observable, catchError, defer, from, map, of } from 'rxjs';
import {
  JS_SDK_CLIENTS,
  uiaChallengeOf,
} from '@trinity/data-access/matrix-client';
import {
  NOT_SIGNED_IN,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  type EngineFailure,
  type EngineResult,
  type LoginRefusal,
  type UiaAuth,
} from '@trinity/util/matrix';
import type {
  AuthEngine,
  EmailTokenRequest,
  PasswordLogin,
  PasswordReset,
  SignedInSession,
  TokenLogin,
} from '../auth-engine';
import type { AuthMetadata } from '../auth-metadata';

/**
 * The server answered without offering OAuth 2.0 metadata: `M_UNRECOGNIZED`, or a client
 * error or 501 from it or its proxy. A timeout, rate limiting, a 5xx, no connection or a
 * body that isn't valid metadata (a captive portal) leave the answer unknown.
 */
export function lacksAuthMetadata(err: unknown): boolean {
  if (err instanceof MatrixError && err.errcode === 'M_UNRECOGNIZED') {
    return true;
  }
  if (!(err instanceof HTTPError)) return false;
  const status = err.httpStatus ?? 0;
  return (
    status === 501 ||
    (status >= 400 && status < 500 && status !== 408 && status !== 429)
  );
}

function requestFailed(err: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(err);
  const challenge = uiaChallengeOf(err);
  if (challenge) {
    return { kind, code: 'uia-required', diagnostic, params: { challenge } };
  }
  const serverMessage =
    err instanceof MatrixError && err.errcode === 'M_WEAK_PASSWORD'
      ? err.data.error
      : undefined;
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(typeof serverMessage === 'string' ? { params: { serverMessage } } : {}),
  };
}

/** A 401 or 403 from `/login` refuses what was signed in with, not a permission. */
function loginFailure(err: unknown, refused: LoginRefusal): EngineFailure {
  const failure = requestFailed(err);
  const { errcode, httpStatus } = failure.diagnostic;
  const reason: LoginRefusal | null =
    errcode === 'M_USER_DEACTIVATED'
      ? 'deactivated'
      : httpStatus === 401 || httpStatus === 403 || errcode === 'M_FORBIDDEN'
        ? refused
        : null;
  return reason
    ? {
        kind: failure.kind,
        code: 'login-refused',
        diagnostic: failure.diagnostic,
        params: { reason },
      }
    : failure;
}

function request<T>(
  run: () => Promise<T>,
  failure: (err: unknown) => EngineFailure = requestFailed,
): Observable<EngineResult<T>> {
  return defer(() => from(run())).pipe(
    map((value) => engineOk(value)),
    catchError((err: unknown) => of(engineFail(failure(err)))),
  );
}

@Injectable({ providedIn: 'root' })
export class JsSdkAuthEngine implements AuthEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  loginFlows(baseUrl: string): Observable<EngineResult<readonly string[]>> {
    return request(async () =>
      (await createClient({ baseUrl }).loginFlows()).flows.map((f) => f.type),
    );
  }

  authMetadata(baseUrl: string): Observable<EngineResult<AuthMetadata | null>> {
    return defer(() => from(createClient({ baseUrl }).getAuthMetadata())).pipe(
      map((metadata): EngineResult<AuthMetadata | null> => engineOk(metadata)),
      catchError((err: unknown) =>
        of(
          lacksAuthMetadata(err)
            ? engineOk(null)
            : engineFail(requestFailed(err)),
        ),
      ),
    );
  }

  usernameAvailable(
    baseUrl: string,
    localpart: string,
  ): Observable<EngineResult<boolean>> {
    return request(
      () => createClient({ baseUrl }).isUsernameAvailable(localpart),
      (err) => {
        const failure = requestFailed(err);
        return failure.diagnostic.errcode === 'M_FORBIDDEN'
          ? {
              kind: failure.kind,
              code: 'forbidden',
              diagnostic: failure.diagnostic,
            }
          : failure;
      },
    );
  }

  ssoLoginUrl(
    baseUrl: string,
    redirectUrl: string,
  ): Observable<EngineResult<string>> {
    return request(async () =>
      createClient({ baseUrl }).getSsoLoginUrl(redirectUrl, 'sso'),
    );
  }

  loginWithPassword(
    baseUrl: string,
    login: PasswordLogin,
  ): Observable<EngineResult<SignedInSession>> {
    return this.login(
      baseUrl,
      {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: login.localpart },
        password: login.password,
        initial_device_display_name: login.deviceDisplayName,
        ...(login.deviceId ? { device_id: login.deviceId } : {}),
      },
      'invalid-credentials',
    );
  }

  loginWithToken(
    baseUrl: string,
    login: TokenLogin,
  ): Observable<EngineResult<SignedInSession>> {
    return this.login(
      baseUrl,
      {
        type: 'm.login.token',
        token: login.token,
        initial_device_display_name: login.deviceDisplayName,
        ...(login.deviceId ? { device_id: login.deviceId } : {}),
      },
      'invalid-token',
    );
  }

  requestPasswordResetToken(
    baseUrl: string,
    { email, clientSecret, sendAttempt }: EmailTokenRequest,
  ): Observable<EngineResult<{ readonly sid: string }>> {
    return request(async () => {
      const { sid } = await createClient({
        baseUrl,
      }).requestPasswordEmailToken(email, clientSecret, sendAttempt);
      return { sid };
    });
  }

  resetPassword(
    baseUrl: string,
    reset: PasswordReset,
  ): Observable<EngineResult<null>> {
    const creds = { sid: reset.sid, client_secret: reset.clientSecret };
    return request(async () => {
      await createClient({ baseUrl }).setPassword(
        {
          type: 'm.login.email.identity',
          threepid_creds: creds,
          // Older homeservers still read the unstable camelCase key.
          threepidCreds: creds,
        },
        reset.newPassword,
        reset.logoutDevices,
      );
      return null;
    });
  }

  changePassword(
    accountId: string,
    newPassword: string,
    auth: UiaAuth | null,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_SIGNED_IN));
      return request(async () => {
        // The probe sends no `auth` at all: an empty dict is malformed UIA data that
        // ruma-based servers reject with M_BAD_JSON instead of the 401 challenge. The
        // SDK types the dict as required but serialises an undefined one away.
        await client.setPassword(
          auth ?? (undefined as unknown as AuthDict),
          newPassword,
          false,
        );
        return null;
      });
    });
  }

  private login(
    baseUrl: string,
    body: LoginRequest,
    refused: LoginRefusal,
  ): Observable<EngineResult<SignedInSession>> {
    return request(
      async () => {
        const res = await createClient({ baseUrl }).loginRequest(body);
        return {
          userId: res.user_id,
          deviceId: res.device_id,
          accessToken: res.access_token,
          refreshToken: res.refresh_token ?? null,
        };
      },
      (err) => loginFailure(err, refused),
    );
  }
}
