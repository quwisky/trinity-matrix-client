import { Injectable, inject } from '@angular/core';
import {
  MatrixClientService,
  jsSdkUia,
} from '@trinity/data-access/matrix-client';
import {
  UiaAttemptsExceededError,
  UiaCancelledError,
  UiaUnsupportedError,
  describeMatrixRequestFailure,
  driveUia,
} from '@trinity/util/matrix';
import { Observable, catchError, defer, forkJoin, from, map, of } from 'rxjs';
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

/** Reads and changes the email addresses bound to one account on its homeserver. */
@Injectable({ providedIn: 'root' })
export class EmailAddressesWorkflow {
  private readonly matrix = inject(MatrixClientService);

  load(accountId: string): Observable<EmailAddressesLoad> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return of(refused('account-unavailable'));
      return forkJoin([
        defer(() => from(client.getThreePids())),
        defer(() => from(client.getCapabilities())),
      ]).pipe(
        map(([{ threepids }, capabilities]): EmailAddressesLoad => ({
          kind: 'loaded',
          addresses: threepids.flatMap(({ medium, address }) =>
            medium === 'email' || medium === 'msisdn'
              ? [{ medium, address } satisfies ContactAddress]
              : [],
          ),
          canChange: capabilities['m.3pid_changes']?.enabled !== false,
        })),
        catchError((err: unknown) => of(refusalOf(err))),
      );
    });
  }

  sendLink(accountId: string, email: string): Observable<EmailLinkResult> {
    const client = this.matrix.clientFor(accountId);
    return this.requestLink({
      accountId,
      email: email.trim(),
      sid: '',
      clientSecret: client?.generateClientSecret() ?? '',
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
    return defer(() => {
      const client = this.matrix.clientFor(pending.accountId);
      if (!client) return of(refused('account-unavailable'));
      // Synapse checks re-authentication before the link, so an early Continue completes
      // the session; sending it back skips a second password prompt.
      let session = pending.uiaSession;
      return from(
        driveUia(
          jsSdkUia((probe) => {
            const auth = probe ?? (session ? { session } : null);
            if (auth && 'session' in auth && typeof auth.session === 'string') {
              session = auth.session;
            }
            return client.addThreePidOnly({
              sid: pending.sid,
              client_secret: pending.clientSecret,
              // The SDK types `auth` as `{ type }`, but a fallback stage answers with `{ session }` alone.
              ...(auth
                ? {
                    auth: auth as Parameters<
                      typeof client.addThreePidOnly
                    >[0]['auth'],
                  }
                : {}),
            });
          }),
          {
            password: { user: pending.accountId, prompt: stages.password },
            fallback: ({ stage, session, pending: stillPending }) =>
              stages.confirmInBrowser({
                url: client.getFallbackAuthUrl(stage, session),
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
    });
  }

  remove(
    accountId: string,
    address: ContactAddress,
  ): Observable<EmailRemoveResult> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return of(refused('account-unavailable'));
      return from(client.deleteThreePid(address.medium, address.address)).pipe(
        map(({ id_server_unbind_result }): EmailRemoveResult => ({
          kind: 'removed',
          unbind: id_server_unbind_result ?? 'success',
        })),
        catchError((err: unknown) => of(refusalOf(err))),
      );
    });
  }

  private requestLink(pending: PendingEmail): Observable<EmailLinkResult> {
    return defer(() => {
      const client = this.matrix.clientFor(pending.accountId);
      if (!client) return of(refused('account-unavailable'));
      return from(
        client.requestAdd3pidEmailToken(
          pending.email,
          pending.clientSecret,
          pending.sendAttempt,
        ),
      ).pipe(
        map(({ sid }): EmailLinkResult => ({
          kind: 'sent',
          pending: { ...pending, sid },
        })),
        catchError((err: unknown) => of(refusalOf(err))),
      );
    });
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
