import { Injectable, inject } from '@angular/core';
import type { EngineFailure } from '@trinity/util/matrix';
import { Observable, catchError, defer, map, of } from 'rxjs';
import { AUTH_ENGINE } from './auth-engine.token';

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
  private readonly engine = inject(AUTH_ENGINE);

  sendLink(baseUrl: string, email: string): Observable<ResetLinkResult> {
    return defer(() =>
      this.requestLink({
        baseUrl,
        email: email.trim(),
        sid: '',
        clientSecret: newClientSecret(),
        sendAttempt: 1,
      }),
    ).pipe(catchError(() => of(refused('failed'))));
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
    return defer(() =>
      this.engine.resetPassword(pending.baseUrl, {
        sid: pending.sid,
        clientSecret: pending.clientSecret,
        newPassword,
        logoutDevices,
      }),
    ).pipe(
      map((result): ResetResult =>
        result.ok ? { kind: 'reset' } : refusalOf(result.failure, 'reset'),
      ),
      catchError(() => of(refused('failed'))),
    );
  }

  private requestLink(pending: PendingReset): Observable<ResetLinkResult> {
    return this.engine
      .requestPasswordResetToken(pending.baseUrl, {
        email: pending.email,
        clientSecret: pending.clientSecret,
        sendAttempt: pending.sendAttempt,
      })
      .pipe(
        map((result): ResetLinkResult =>
          result.ok
            ? { kind: 'sent', pending: { ...pending, sid: result.value.sid } }
            : refusalOf(result.failure, 'send'),
        ),
        catchError(() => of(refused('failed'))),
      );
  }
}

/** 24 random bytes as base64url: 32 characters, as much entropy as js-sdk's secret or more. */
function newClientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
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

function refusalOf(failure: EngineFailure, phase: Phase): ResetRefused {
  const { errcode, errorName, httpStatus, retryAfterMs } = failure.diagnostic;
  // fetch rejects with a bare TypeError when the homeserver cannot be reached.
  if (
    failure.kind === 'network' ||
    failure.kind === 'timeout' ||
    errorName === 'TypeError'
  ) {
    return refused('unreachable');
  }
  if (failure.kind === 'rate-limit') {
    return refused(
      'rate-limited',
      retryAfterMs !== undefined ? { retryAfterMs } : {},
    );
  }
  // A UIA challenge: the email link is not confirmed yet.
  if (failure.code === 'uia-required' || (httpStatus === 401 && !errcode)) {
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
    const reason =
      failure.code === 'request-failed'
        ? failure.params?.serverMessage
        : undefined;
    return refused(
      refusal,
      refusal === 'weak-password' && reason !== undefined ? { reason } : {},
    );
  }
  return refused('failed');
}
