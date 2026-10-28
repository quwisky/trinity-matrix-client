import { Injectable, inject, signal } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import type { EngineFailure, EngineResult } from '@trinity/util/matrix';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';

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
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
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
    return this.send(target.accountId, 'room', () =>
      this.engine.reportRoom(target.accountId, target.roomId, reason),
    );
  }

  /** Report a user to the account's server admins. Cold. */
  reportUser(
    accountId: string,
    userId: string,
    reason: string,
  ): Observable<void> {
    return this.send(accountId, 'user', () =>
      this.engine.reportUser(accountId, userId, reason),
    );
  }

  private send(
    accountId: string,
    kind: ReportKind,
    request: () => Observable<EngineResult<null>>,
  ): Observable<void> {
    return defer(request).pipe(
      map((result) => {
        if (result.ok) return;
        const failure = classify(result.failure);
        if (failure.kind === 'unsupported') {
          this.markUnsupported(accountId, kind);
        }
        throw new ContentReportError(kind, failure);
      }),
    );
  }

  private markUnsupported(accountId: string, kind: ReportKind): void {
    this.unsupported.update((current) => {
      const next = new Map(current);
      next.set(accountId, new Set([...(current.get(accountId) ?? []), kind]));
      return next;
    });
  }
}

function classify({ code, diagnostic }: EngineFailure): ContentReportFailure {
  if (code === 'account-not-live') return { kind: 'not-signed-in' };
  const { errcode, httpStatus } = diagnostic;
  if (errcode === 'M_LIMIT_EXCEEDED' || httpStatus === 429) {
    return {
      kind: 'rate-limited',
      retryAfterMs: diagnostic.retryAfterMs ?? null,
    };
  }
  if (errcode === 'M_NOT_FOUND') return { kind: 'not-found' };
  // Tuwunel caps the reason at 2000 bytes; the only free-form parameter is the reason.
  if (errcode === 'M_INVALID_PARAM') return { kind: 'reason-too-long' };
  // A server without the endpoint answers M_UNRECOGNIZED, or a bare 404/405 from its router.
  if (
    errcode === 'M_UNRECOGNIZED' ||
    httpStatus === 404 ||
    httpStatus === 405
  ) {
    return { kind: 'unsupported' };
  }
  return { kind: 'failed' };
}
