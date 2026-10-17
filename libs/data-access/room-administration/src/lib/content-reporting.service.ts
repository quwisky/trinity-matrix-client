import { Injectable, inject, signal } from '@angular/core';
import {
  HTTPError,
  MatrixError,
  Method,
  type MatrixClient,
} from 'matrix-js-sdk';
import { Observable, catchError, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { describeMatrixRequestFailure } from '@trinity/util/matrix';

/** What can be reported to the reporter's own homeserver admins. */
export type ReportKind = 'room' | 'user';

/** Why a report did not reach the server's admins. */
export type ContentReportFailure =
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number | null }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'reason-too-long' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'not-signed-in' }
  | { readonly kind: 'failed' };

/** A typed report failure; the message is never the server's own text. */
export class ContentReportError extends Error {
  constructor(
    readonly report: ReportKind,
    readonly failure: ContentReportFailure,
  ) {
    super(`The ${report} report failed: ${failure.kind}.`);
    this.name = 'ContentReportError';
  }
}

/**
 * Reports rooms (MSC4151) and users (MSC4260) to the reporter's own homeserver admins.
 * Reports are not federated. Every command names the account it runs as.
 */
@Injectable({ providedIn: 'root' })
export class ContentReportingService {
  private readonly matrix = inject(MatrixClientService);
  private readonly unsupported = signal<
    ReadonlyMap<string, ReadonlySet<ReportKind>>
  >(new Map());

  /**
   * Whether `accountId` may offer `kind` reports. True until its server answers that it doesn't
   * know the endpoint; then false for the rest of the session.
   */
  offers(accountId: string, kind: ReportKind): boolean {
    return !this.unsupported().get(accountId)?.has(kind);
  }

  /** Report a room to the account's server admins. Cold. */
  reportRoom(
    target: { readonly accountId: string; readonly roomId: string },
    reason: string,
  ): Observable<void> {
    return this.send(target.accountId, 'room', (client) =>
      client.reportRoom(target.roomId, reason),
    );
  }

  /** Report a user to the account's server admins. Cold. */
  reportUser(
    accountId: string,
    userId: string,
    reason: string,
  ): Observable<void> {
    return this.send(accountId, 'user', (client) =>
      client.http.authedRequest(
        Method.Post,
        `/users/${encodeURIComponent(userId)}/report`,
        undefined,
        { reason },
      ),
    );
  }

  private send(
    accountId: string,
    kind: ReportKind,
    request: (client: MatrixClient) => Promise<unknown>,
  ): Observable<void> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        return throwError(
          () => new ContentReportError(kind, { kind: 'not-signed-in' }),
        );
      }
      return from(request(client)).pipe(
        map(() => void 0),
        catchError((error: unknown) => {
          const failure = classify(error);
          if (failure.kind === 'unsupported')
            this.markUnsupported(accountId, kind);
          return throwError(() => new ContentReportError(kind, failure));
        }),
      );
    });
  }

  private markUnsupported(accountId: string, kind: ReportKind): void {
    this.unsupported.update((current) => {
      const next = new Map(current);
      next.set(accountId, new Set([...(current.get(accountId) ?? []), kind]));
      return next;
    });
  }
}

function classify(error: unknown): ContentReportFailure {
  const errcode = error instanceof MatrixError ? error.errcode : undefined;
  const status = error instanceof HTTPError ? error.httpStatus : undefined;
  if (errcode === 'M_LIMIT_EXCEEDED' || status === 429) {
    return {
      kind: 'rate-limited',
      retryAfterMs:
        describeMatrixRequestFailure(error).diagnostic.retryAfterMs ?? null,
    };
  }
  if (errcode === 'M_NOT_FOUND') return { kind: 'not-found' };
  // Tuwunel caps the reason at 2000 bytes; the only free-form parameter is the reason.
  if (errcode === 'M_INVALID_PARAM') return { kind: 'reason-too-long' };
  // A server without the endpoint answers M_UNRECOGNIZED, or a bare 404/405 from its router.
  if (errcode === 'M_UNRECOGNIZED' || status === 404 || status === 405) {
    return { kind: 'unsupported' };
  }
  return { kind: 'failed' };
}
