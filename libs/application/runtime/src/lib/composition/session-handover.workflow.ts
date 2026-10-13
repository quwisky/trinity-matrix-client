import { Injectable, inject } from '@angular/core';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  MatrixClientService,
  type PendingTextMessage,
} from '@trinity/data-access/matrix-client';
import {
  AppRestartService,
  SESSION_HANDOVER_TIMEOUT_MS,
  SessionLockService,
} from '@trinity/platform-native';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  exhaustMap,
  filter,
  from,
  ignoreElements,
  map,
  of,
  switchMap,
  take,
  timeout,
  timer,
} from 'rxjs';
import { UnsentDraftsWriter } from './unsent-drafts.writer';

/** Owner decision 2 of #1267: how long sends and uploads already on their way get. */
export const SESSION_HANDOVER_DRAIN_MS = 5_000;

/** How often the drain looks at the clients' outgoing work. */
const DRAIN_POLL_MS = 250;

/**
 * Hands this tab's session to another tab that chose "Use here" (#1267, decisions 2 and 5):
 * after any erase or sign-out already running here has settled, stop syncing at once, give messages and uploads already on their way up to five seconds,
 * note the text still not on the server, stop every Matrix client through the ordinary stop
 * path, close dialogs, put that text back in its drafts and reload this page in place, so the
 * fresh document waits for the lock like any other tab and, when it takes the session again,
 * lands on the route it showed. The lock is not released early:
 * the browser frees it as this document unloads, so the other tab never opens a store while
 * anything here, a client start still running included, could still use it. A reload rather
 * than a return to waiting in place: this document has loaded preferences, accounts and room
 * state that a waiting tab must not have. Never wipes anything.
 */
@Injectable({ providedIn: 'root' })
export class SessionHandoverWorkflow {
  private readonly sessionLock = inject(SessionLockService);
  private readonly matrix = inject(MatrixClientService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly appRestart = inject(AppRestartService);
  private readonly unsentDrafts = inject(UnsentDraftsWriter);
  private readonly accounts = inject(AccountRuntimeService);

  /** For the life of the page: a tab still starting up holds the lock too. */
  run(): Observable<never> {
    return this.sessionLock.handoverRequests.pipe(
      exhaustMap(() =>
        this.afterDestructiveWork().pipe(switchMap(() => this.handOver())),
      ),
      ignoreElements(),
    );
  }

  /**
   * Emits once no sign-out, Account removal or installation reset is running in this tab, so a
   * handover never cuts into one. At once when none is. Completes without emitting, so this
   * request goes unanswered and the other tab offers "Try again", when one is still running
   * after the requester's own timeout, or when the erase it waited for succeeded: that erase
   * restarts the app itself, and this tab must not stop, write or reload on top of it.
   */
  private afterDestructiveWork(): Observable<void> {
    return defer(() => {
      if (!this.accounts.lifecycleBusy()) return of(undefined);
      return timer(DRAIN_POLL_MS, DRAIN_POLL_MS).pipe(
        filter(() => !this.accounts.lifecycleBusy()),
        take(1),
        timeout({ first: SESSION_HANDOVER_TIMEOUT_MS, with: () => EMPTY }),
        filter(() => !this.erasedInstallation()),
        map((): void => undefined),
      );
    });
  }

  private erasedInstallation(): boolean {
    const lifecycle = this.accounts.lifecycle();
    return (
      lifecycle.phase === 'settled' &&
      lifecycle.operation === 'resetting-installation' &&
      lifecycle.outcome.kind === 'ready'
    );
  }

  private handOver(): Observable<void> {
    let unsent: readonly PendingTextMessage[] = [];
    return defer(() => {
      this.pauseSync();
      return this.drain();
    }).pipe(
      switchMap(() => {
        // Before stop(): the pending local echoes go with the clients (owner decision 5).
        unsent = this.readUnsent();
        return this.matrix.stop();
      }),
      // A failed stop must not keep this tab holding the session: the reload ends the rest.
      catchError(() => of(undefined)),
      switchMap(() => {
        this.closeSurfaces();
        // After the stop and the closing dialogs, so nothing they set off can overwrite it.
        return from(this.writeDrafts(unsent)).pipe(
          catchError(() => of(undefined)),
        );
      }),
      map(() => {
        // The unloading document frees the session lock; the other tab's queued request is next.
        this.appRestart.reload();
      }),
    );
  }

  /** A sync loop that will not pause must not cost the unsent text: the stop still ends it. */
  private pauseSync(): void {
    try {
      this.matrix.pauseSync();
    } catch {
      // stop() tears every client down a moment later.
    }
  }

  /** A dialog that fails to close must not stop the handover; the reload discards it. */
  private closeSurfaces(): void {
    try {
      this.surfaces.closeAll();
    } catch {
      // Nothing to recover: the document is about to be replaced.
    }
  }

  /** Rejected or thrown before it returns, a failed write must not stop the reload (ruling N7). */
  private writeDrafts(unsent: readonly PendingTextMessage[]): Promise<void> {
    try {
      return this.unsentDrafts.writeBack(unsent);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  }

  private readUnsent(): readonly PendingTextMessage[] {
    try {
      return this.matrix.pendingTextMessages();
    } catch {
      return [];
    }
  }

  /** Until nothing is on its way, or five seconds, whichever comes first. */
  private drain(): Observable<void> {
    return timer(0, DRAIN_POLL_MS).pipe(
      filter(() => !this.matrix.hasOutgoingWork()),
      take(1),
      map((): void => undefined),
      timeout({
        first: SESSION_HANDOVER_DRAIN_MS,
        with: () => of(undefined),
      }),
      catchError(() => of(undefined)),
    );
  }
}
