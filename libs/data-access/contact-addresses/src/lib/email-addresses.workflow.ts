import { Injectable, inject } from '@angular/core';
import { SESSION_ENGINE } from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
  describeMatrixRequestFailure,
  driveUia,
  engineUia,
  uiaFallbackUrl,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import { Observable, catchError, from, map, of, switchMap, take } from 'rxjs';
import { CONTACT_ADDRESSES_ENGINE } from './contact-addresses-engine.token';
import type {
  ContactAddress,
  EmailAddResult,
  EmailAddressRefused,
  EmailAddressStages,
  EmailAddressesLoad,
  EmailLinkResult,
  EmailRemoveResult,
  PendingEmail,
} from './email-addresses.models';
import { newClientSecret } from './identity-server-http';

/** Reads and changes the email addresses bound to one account on its homeserver. */
@Injectable({ providedIn: 'root' })
export class EmailAddressesWorkflow {
  private readonly engine = inject(CONTACT_ADDRESSES_ENGINE);
  private readonly session = inject(SESSION_ENGINE);

  load(accountId: string): Observable<EmailAddressesLoad> {
    return this.engine.threePids(accountId).pipe(
      unwrapEngineResult(),
      map(({ addresses, canChange }): EmailAddressesLoad => ({
        kind: 'loaded',
        addresses: addresses.flatMap(({ medium, address }) =>
          medium === 'email' || medium === 'msisdn'
            ? [{ medium, address } satisfies ContactAddress]
            : [],
        ),
        canChange,
      })),
      catchError((err: unknown) => of(refusalOf(err))),
    );
  }

  sendLink(accountId: string, email: string): Observable<EmailLinkResult> {
    return this.requestLink({
      accountId,
      email: email.trim(),
      sid: '',
      clientSecret: newClientSecret(),
      sendAttempt: 1,
    });
  }

  resend(pending: PendingEmail): Observable<EmailLinkResult> {
    return this.requestLink({
      ...pending,
      sendAttempt: pending.sendAttempt + 1,
    });
  }

  /** Binds the verified address, completing the re-authentication the homeserver asks for. */
  add(
    pending: PendingEmail,
    stages: EmailAddressStages,
  ): Observable<EmailAddResult> {
    const { accountId } = pending;
    return this.session.accessToken(accountId).pipe(
      take(1),
      // Keep only the URL, so the fallback closure holds no token through the dialog.
      map((live) => live?.homeserverUrl ?? null),
      switchMap((homeserverUrl): Observable<EmailAddResult> => {
        if (homeserverUrl === null) return of(refused('account-unavailable'));
        // Synapse checks re-authentication before the link, so an early Continue completes
        // the session; sending it back skips a second password prompt.
        let session = pending.uiaSession;
        return from(
          driveUia(
            engineUia((probe) => {
              const auth = probe ?? (session ? { session } : null);
              if (auth) session = auth.session;
              return this.engine.addThreePid(
                accountId,
                { sid: pending.sid, clientSecret: pending.clientSecret },
                auth,
              );
            }),
            {
              password: { user: accountId, prompt: stages.password },
              fallback: ({ stage, session, pending: stillPending }) =>
                stages.confirmInBrowser({
                  url: uiaFallbackUrl(homeserverUrl, stage, session),
                  pending: stillPending,
                }),
            },
          ),
        ).pipe(
          map((): EmailAddResult => ({ kind: 'added' })),
          catchError((err: unknown): Observable<EmailAddResult> => {
            const refusal = refusalOf(err);
            return of(
              refusal.reason === 'not-verified'
                ? {
                    kind: 'not-verified',
                    pending: session
                      ? { ...pending, uiaSession: session }
                      : pending,
                  }
                : refusal,
            );
          }),
        );
      }),
    );
  }

  remove(
    accountId: string,
    address: ContactAddress,
  ): Observable<EmailRemoveResult> {
    return this.engine
      .deleteThreePid(accountId, address.medium, address.address)
      .pipe(
        unwrapEngineResult(),
        map(({ unbind }): EmailRemoveResult => ({ kind: 'removed', unbind })),
        catchError((err: unknown) => of(refusalOf(err))),
      );
  }

  private requestLink(pending: PendingEmail): Observable<EmailLinkResult> {
    return this.engine
      .requestAddEmailToken(pending.accountId, {
        email: pending.email,
        clientSecret: pending.clientSecret,
        sendAttempt: pending.sendAttempt,
      })
      .pipe(
        unwrapEngineResult(),
        map(({ sid }): EmailLinkResult => ({
          kind: 'sent',
          pending: { ...pending, sid },
        })),
        catchError((err: unknown) => of(refusalOf(err))),
      );
  }
}

const REFUSAL_BY_ERRCODE: Readonly<
  Record<string, EmailAddressRefused['reason']>
> = {
  M_THREEPID_IN_USE: 'in-use',
  M_THREEPID_DENIED: 'cannot-send',
  M_THREEPID_MEDIUM_NOT_SUPPORTED: 'cannot-send',
  M_SERVER_NOT_TRUSTED: 'cannot-send',
  M_INVALID_PARAM: 'invalid',
  M_INVALID_EMAIL: 'invalid',
  M_THREEPID_AUTH_FAILED: 'not-verified',
};

function refused(reason: EmailAddressRefused['reason']): EmailAddressRefused {
  return { kind: 'refused', reason };
}

function refusalOf(err: unknown): EmailAddressRefused {
  if (err instanceof UiaCancelledError) return refused('cancelled');
  if (err instanceof UiaAttemptsExceededError) {
    return refused('attempts-exceeded');
  }
  if (err instanceof UiaUnsupportedError) return refused('no-usable-stage');
  if (
    err instanceof EngineRequestError &&
    err.failure.code === 'account-not-live'
  ) {
    return refused('account-unavailable');
  }
  const failure = describeMatrixRequestFailure(err);
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return refused('unreachable');
  }
  if (failure.kind === 'rate-limit') {
    const retryAfterMs = failure.diagnostic.retryAfterMs;
    return {
      ...refused('rate-limited'),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  const errcode = failure.diagnostic.errcode;
  return refused(
    errcode && Object.hasOwn(REFUSAL_BY_ERRCODE, errcode)
      ? REFUSAL_BY_ERRCODE[errcode]
      : 'failed',
  );
}
