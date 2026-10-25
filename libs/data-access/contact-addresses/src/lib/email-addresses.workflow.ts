import { Injectable, inject } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { describeMatrixRequestFailure } from '@trinity/util/matrix';
import { Observable, catchError, defer, forkJoin, from, map, of } from 'rxjs';
import type {
  ContactAddress,
  EmailAddressRefused,
  EmailAddressesLoad,
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
}

function refused(reason: EmailAddressRefused['reason']): EmailAddressRefused {
  return { kind: 'refused', reason };
}

function refusalOf(err: unknown): EmailAddressRefused {
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
  return refused('failed');
}
