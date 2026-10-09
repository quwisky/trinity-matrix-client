import { Injectable, inject } from '@angular/core';
import {
  AccountRuntimeService,
  type AccountSwitchOutcome,
} from '@trinity/data-access/accounts';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import {
  Observable,
  ReplaySubject,
  type Subscription,
  catchError,
  defer,
  finalize,
  map,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import {
  RECENT_WORKSPACE_SCOPE,
  sameWorkspaceDestination,
  type WorkspaceDestination,
  type WorkspaceOpenOptions,
  type WorkspaceOpenOutcome,
  type WorkspaceView,
  workspaceViewOf,
} from './workspace.models';
import { WorkspaceLocationAdapter } from './workspace-location.adapter';

interface WorkspaceAttempt {
  readonly destination: WorkspaceDestination;
  readonly options: WorkspaceOpenOptions;
  readonly outcome: Observable<WorkspaceOpenOutcome>;
}

interface ResolvedWorkspaceDestination {
  readonly destination: WorkspaceDestination;
  readonly repaired: boolean;
}

export interface WorkspaceTransitionCallbacks {
  readonly release: () => void;
  readonly restore: (view: WorkspaceView) => void;
  readonly commit: (view: WorkspaceView, options: WorkspaceOpenOptions) => void;
}

class WorkspaceNavigationRejected extends Error {}

/** Package-internal, joining transition engine behind Workspace's small public API. */
@Injectable({ providedIn: 'root' })
export class WorkspaceTransitionWorkflow {
  private readonly location = inject(WorkspaceLocationAdapter);
  private readonly accounts = inject(AccountRuntimeService);
  private readonly rooms = inject(RoomLibraryService);
  private attempt: WorkspaceAttempt | null = null;

  get projectingLocation(): boolean {
    return this.location.projecting;
  }

  run(
    requested: WorkspaceDestination,
    options: WorkspaceOpenOptions,
    previous: WorkspaceView,
    callbacks: WorkspaceTransitionCallbacks,
  ): Observable<WorkspaceOpenOutcome> {
    return defer(() => {
      if (this.attempt) {
        return sameWorkspaceDestination(this.attempt.destination, requested) &&
          this.attempt.options.source === options.source &&
          this.attempt.options.history === options.history &&
          this.attempt.options.eventId === options.eventId &&
          this.attempt.options.force === options.force
          ? this.attempt.outcome
          : of({
              kind: 'transition-in-progress',
              destination: requested,
            } as const);
      }
      return this.begin(requested, options, previous, callbacks);
    });
  }

  private begin(
    requested: WorkspaceDestination,
    options: WorkspaceOpenOptions,
    previous: WorkspaceView,
    callbacks: WorkspaceTransitionCallbacks,
  ): Observable<WorkspaceOpenOutcome> {
    let accountCommitStarted = false;
    let routeProjectionStarted = false;
    let released = false;
    let committed = false;
    const resolved = this.resolveDestination(requested);
    const accountChanges =
      requested.accountId !== this.accounts.activeAccountId();

    if (
      options.source !== 'repair' &&
      !options.force &&
      !Object.hasOwn(options, 'eventId') &&
      !resolved.repaired &&
      !accountChanges &&
      sameWorkspaceDestination(previous, resolved.destination)
    ) {
      return of({
        kind: 'ready',
        view: previous,
        repaired: false,
      });
    }

    const projectRequestedUrl = () => {
      // A canonical inbound Router destination is already in the address bar. Asking
      // Angular to navigate to that same URL resolves `false`; that means "unchanged",
      // not "rejected", and must not prevent Workspace from committing the restored view.
      if (options.source === 'restore' && !resolved.repaired) {
        return of(true);
      }
      routeProjectionStarted = true;
      return this.location.project(resolved.destination, {
        history: resolved.repaired ? 'replace' : options.history,
        overList: options.overList === true && !resolved.repaired,
        eventId: options.eventId,
      });
    };

    const source = this.activateAccount(
      requested.accountId,
      accountChanges
        ? () =>
            projectRequestedUrl().pipe(
              switchMap((navigated) => {
                if (!navigated) {
                  return throwError(() => new WorkspaceNavigationRejected());
                }
                released = true;
                callbacks.release();
                return of(void 0);
              }),
            )
        : () => of(void 0),
      () => {
        // Account Runtime invokes this only after adapter preparation settles and
        // immediately before its persisted/live commit becomes uninterruptible.
        accountCommitStarted = true;
      },
    ).pipe(
      switchMap((accountOutcome) => {
        if (accountOutcome.kind !== 'ready') {
          return this.restoreUrlIfNeeded(previous, routeProjectionStarted).pipe(
            map((): WorkspaceOpenOutcome => ({
              kind: 'failed',
              destination: requested,
              failure: 'account-transition-failed',
            })),
          );
        }
        const route = accountChanges ? of(true) : projectRequestedUrl();
        return route.pipe(
          map((navigated): WorkspaceOpenOutcome => {
            if (!navigated) {
              return {
                kind: 'failed',
                destination: requested,
                failure: 'navigation-rejected',
              };
            }
            const view = workspaceViewOf(resolved.destination);
            committed = true;
            callbacks.commit(view, options);
            return {
              kind: 'ready',
              view,
              repaired: resolved.repaired,
            };
          }),
        );
      }),
      catchError((error: unknown) =>
        error instanceof WorkspaceNavigationRejected
          ? of({
              kind: 'failed',
              destination: requested,
              failure: 'navigation-rejected',
            } as const)
          : throwError(() => error),
      ),
      finalize(() => {
        if (released && !committed) callbacks.restore(previous);
      }),
    );
    const outcome = this.shareAttempt(
      requested,
      source,
      () => accountCommitStarted || committed,
      () =>
        this.restoreUrlIfNeeded(previous, routeProjectionStarted).pipe(
          catchError(() => of(false)),
        ),
      () => {
        if (this.attempt?.outcome === outcome) this.attempt = null;
      },
    );
    this.attempt = { destination: requested, options, outcome };
    return outcome;
  }

  private activateAccount(
    accountId: string,
    prepare: () => Observable<void>,
    onCommitStarted: () => void,
  ): Observable<AccountSwitchOutcome> {
    if (accountId === this.accounts.activeAccountId()) {
      return of({
        kind: 'ready',
        accountId,
      });
    }
    return this.accounts.switchActiveAccount(accountId, {
      prepare,
      onCommitStarted,
    });
  }

  private restoreUrlIfNeeded(
    previous: WorkspaceView,
    routeProjectionStarted: boolean,
  ): Observable<boolean> {
    if (!routeProjectionStarted || !previous.accountId) return of(true);
    return this.location.project(
      {
        accountId: previous.accountId,
        scope: previous.scope,
        roomId: previous.roomId,
        pane: previous.pane,
      },
      { history: 'replace' },
    );
  }

  private resolveDestination(
    requested: WorkspaceDestination,
  ): ResolvedWorkspaceDestination {
    let scope = requested.scope;
    let roomId = requested.roomId;
    let pane = requested.pane;
    let repaired = false;
    if (
      scope.kind === 'space' &&
      !this.spaceAvailable(requested.accountId, scope.spaceId)
    ) {
      scope = RECENT_WORKSPACE_SCOPE;
      roomId = null;
      pane = 'list';
      repaired = true;
    }
    if (roomId && !this.roomKept(requested.accountId, roomId)) {
      roomId = null;
      pane = 'list';
      repaired = true;
    }
    if (pane === 'conversation' && !roomId) {
      pane = 'list';
      repaired = true;
    }
    return {
      destination: {
        accountId: requested.accountId,
        scope,
        roomId,
        pane,
      },
      repaired,
    };
  }

  /**
   * Replay one attempt while preserving cancellation before Account commit.
   *
   * Once Account preparation returns, Account Runtime's commit is deliberately
   * uninterruptible. At that boundary this multicast keeps the Workspace source owned to
   * completion even when route restoration switches or page teardown remove all observers.
   */
  private shareAttempt(
    destination: WorkspaceDestination,
    source: Observable<WorkspaceOpenOutcome>,
    ownsCompletion: () => boolean,
    rollbackCancelledPreparation: () => Observable<boolean>,
    releaseAttempt: () => void,
  ): Observable<WorkspaceOpenOutcome> {
    let replay: ReplaySubject<WorkspaceOpenOutcome> | null = null;
    let sourceSubscription: Subscription | null = null;
    let recoverySubscription: Subscription | null = null;
    let sourceSettled = false;
    let subscribers = 0;

    return new Observable((subscriber) => {
      replay ??= new ReplaySubject<WorkspaceOpenOutcome>(1);
      subscribers += 1;
      const replaySubscription = replay.subscribe(subscriber);
      if (!sourceSubscription) {
        sourceSubscription = source.subscribe({
          next: (outcome) => {
            // Every Workspace command produces one terminal outcome. Mark it settled
            // before forwarding so firstValueFrom()/take(1) teardown cannot be mistaken
            // for cancellation between next and the source's immediate complete.
            sourceSettled = true;
            replay?.next(outcome);
          },
          error: (error: unknown) => {
            sourceSettled = true;
            releaseAttempt();
            replay?.error(error);
          },
          complete: () => {
            sourceSettled = true;
            releaseAttempt();
            replay?.complete();
          },
        });
      }
      return () => {
        replaySubscription.unsubscribe();
        subscribers -= 1;
        if (
          subscribers === 0 &&
          sourceSubscription &&
          !sourceSubscription.closed &&
          !sourceSettled &&
          !ownsCompletion()
        ) {
          sourceSubscription.unsubscribe();
          replay?.next({ kind: 'transition-in-progress', destination });
          replay?.complete();
          // Router promises cannot be cancelled by RxJS teardown. Keep this named
          // recovery subscription owned by the attempt so its replacement navigation
          // supersedes any pending projection and no new command can race the repair.
          if (!recoverySubscription) {
            recoverySubscription = rollbackCancelledPreparation().subscribe({
              error: () => releaseAttempt(),
              complete: () => releaseAttempt(),
            });
          }
        }
      };
    });
  }

  /** A Space scope must be synced; an unsynced one is repaired to the list. */
  private spaceAvailable(accountId: string, spaceId: string): boolean {
    return this.rooms.selectionAvailability(accountId, spaceId) === 'available';
  }

  /** A Room the live client has not synced yet is kept; the Conversation decides. */
  private roomKept(accountId: string, roomId: string): boolean {
    return (
      this.rooms.selectionAvailability(accountId, roomId) !== 'unavailable'
    );
  }
}
