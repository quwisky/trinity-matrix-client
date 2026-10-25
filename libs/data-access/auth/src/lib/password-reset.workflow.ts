import { Injectable } from '@angular/core';
import { MatrixError, createClient } from 'matrix-js-sdk';
import { describeMatrixRequestFailure } from '@trinity/util/matrix';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

export interface PendingReset {
  readonly baseUrl: string;
  readonly email: string;
  readonly sid: string;
  readonly clientSecret: string;
  readonly sendAttempt: number;
}

export type ResetRefusal =
  | 'unknown-address'
  | 'invalid-address'
  | 'not-confirmed'
  | 'weak-password'
  | 'rate-limited'
  | 'unreachable'
  | 'failed';

export interface ResetRefused {
  readonly kind: 'refused';
  readonly refusal: ResetRefusal;
  readonly retryAfterMs?: number;
  readonly reason?: string;
}

export type ResetLinkResult =
  { readonly kind: 'sent'; readonly pending: PendingReset } | ResetRefused;

export type ResetResult = { readonly kind: 'reset' } | ResetRefused;

type Phase = 'send' | 'reset';

/** Resets a forgotten password by email, with no signed-in account. */
@Injectable({ providedIn: 'root' })
export class PasswordResetWorkflow {
  sendLink(baseUrl: string, email: string): Observable<ResetLinkResult> {
    return defer(() => {
      const clientSecret = createClient({ baseUrl }).generateClientSecret();
      return this.requestLink({
        baseUrl,
        email: email.trim(),
        sid: '',
        clientSecret,
        sendAttempt: 1,
      });
    });
  }

  resend(pending: PendingReset): Observable<ResetLinkResult> {
    return defer(() =>
      this.requestLink({ ...pending, sendAttempt: pending.sendAttempt + 1 }),
    );
  }

  reset(
    pending: PendingReset,
    newPassword: string,
    logoutDevices: boolean,
  ): Observable<ResetResult> {
    return defer(() => {
      const creds = { sid: pending.sid, client_secret: pending.clientSecret };
      return from(
        createClient({ baseUrl: pending.baseUrl }).setPassword(
          {
            type: 'm.login.email.identity',
            threepid_creds: creds,
            // Older homeservers still read the unstable camelCase key.
            threepidCreds: creds,
          },
          newPassword,
          logoutDevices,
        ),
      );
    }).pipe(
      map((): ResetResult => ({ kind: 'reset' })),
      catchError((err: unknown) => of(refusalOf(err, 'reset'))),
    );
  }

  private requestLink(pending: PendingReset): Observable<ResetLinkResult> {
    return defer(() =>
      from(
        createClient({ baseUrl: pending.baseUrl }).requestPasswordEmailToken(
          pending.email,
          pending.clientSecret,
          pending.sendAttempt,
        ),
      ),
    ).pipe(
      map(({ sid }): ResetLinkResult => ({
        kind: 'sent',
        pending: { ...pending, sid },
      })),
      catchError((err: unknown) => of(refusalOf(err, 'send'))),
    );
  }
}

const REFUSAL_BY_ERRCODE: Readonly<Record<string, ResetRefusal>> = {
  M_THREEPID_NOT_FOUND: 'unknown-address',
  M_UNAUTHORIZED: 'not-confirmed',
  M_WEAK_PASSWORD: 'weak-password',
};

function refused(
  refusal: ResetRefusal,
  extra: Pick<ResetRefused, 'retryAfterMs' | 'reason'> = {},
): ResetRefused {
  return { kind: 'refused', refusal, ...extra };
}

function refusalOf(err: unknown, phase: Phase): ResetRefused {
  const failure = describeMatrixRequestFailure(err);
  // fetch rejects with a bare TypeError when the homeserver cannot be reached.
  if (
    failure.kind === 'network' ||
    failure.kind === 'timeout' ||
    err instanceof TypeError
  ) {
    return refused('unreachable');
  }
  if (failure.kind === 'rate-limit') {
    const { retryAfterMs } = failure.diagnostic;
    return refused(
      'rate-limited',
      retryAfterMs !== undefined ? { retryAfterMs } : {},
    );
  }
  const errcode = failure.diagnostic.errcode;
  // A UIA challenge carries no errcode: the email link is not confirmed yet.
  if (failure.diagnostic.httpStatus === 401 && !errcode) {
    return refused('not-confirmed');
  }
  if (
    phase === 'send' &&
    (errcode === 'M_INVALID_PARAM' || errcode === 'M_BAD_JSON')
  ) {
    return refused('invalid-address');
  }
  if (errcode && Object.hasOwn(REFUSAL_BY_ERRCODE, errcode)) {
    const refusal = REFUSAL_BY_ERRCODE[errcode];
    const reason = err instanceof MatrixError ? err.data?.error : undefined;
    return refused(
      refusal,
      refusal === 'weak-password' && typeof reason === 'string'
        ? { reason }
        : {},
    );
  }
  return refused('failed');
}
