import { Injectable, inject } from '@angular/core';
import {
  AccountRuntimeService,
  type AccountSwitchOutcome,
} from '@trinity/data-access/accounts';
import {
  Observable,
  catchError,
  defer,
  finalize,
  of,
  shareReplay,
  switchMap,
  throwError,
} from 'rxjs';
import type { AccountSwitchDestination } from './account-switch.models';
import { RoomShellNavigationService } from './room-shell-navigation.service';

interface InFlightWorkspaceSwitch {
  readonly accountId: string;
  readonly destination: AccountSwitchDestination;
  readonly outcome: Observable<AccountSwitchOutcome>;
}

class WorkspaceTransitionRejected extends Error {}

/**
 * The current Workspace adapter for Active Account transitions.
 *
 * Account Runtime owns the Account and projection commit; the room shell owns the
 * semantic selection around it. Keeping those roles in one cold workflow prevents a
 * route, open conversation, or space selection from exposing a half-switched shell.
 */
@Injectable()
export class WorkspaceAccountSwitchService {
  private readonly accounts = inject(AccountRuntimeService);
  private readonly navigation = inject(RoomShellNavigationService);
  private attempt: InFlightWorkspaceSwitch | null = null;

  switchAccount(
    accountId: string,
    destination: AccountSwitchDestination,
  ): Observable<AccountSwitchOutcome> {
    return defer(() => {
      if (this.attempt) {
        return this.attempt.accountId === accountId &&
          sameDestination(this.attempt.destination, destination)
          ? this.attempt.outcome
          : of({
              kind: 'transition-in-progress',
              accountId,
              operation: 'switching-account',
            } as const);
      }

      const outcome = this.accounts
        .switchActiveAccount(accountId, () => {
          this.navigation.resetViewScope();
          return this.navigation
            .prepareAccountSwitch()
            .pipe(
              switchMap((prepared) =>
                prepared
                  ? of(void 0)
                  : throwError(() => new WorkspaceTransitionRejected()),
              ),
            );
        })
        .pipe(
          switchMap((accountOutcome) => {
            if (accountOutcome.kind !== 'ready') return of(accountOutcome);
            return this.navigation
              .repairAccountSelection(destination)
              .pipe(
                switchMap((repaired) =>
                  repaired
                    ? of(accountOutcome)
                    : of(this.workspaceFailure(accountId)),
                ),
              );
          }),
          catchError((error: unknown) =>
            error instanceof WorkspaceTransitionRejected
              ? of(this.workspaceFailure(accountId))
              : throwError(() => error),
          ),
          finalize(() => {
            if (this.attempt?.outcome === outcome) this.attempt = null;
          }),
          shareReplay({ bufferSize: 1, refCount: true }),
        );
      this.attempt = { accountId, destination, outcome };
      return outcome;
    });
  }

  private workspaceFailure(accountId: string): AccountSwitchOutcome {
    return {
      kind: 'failed',
      accountId,
      failure: 'workspace-transition-failed',
    };
  }
}

function sameDestination(
  left: AccountSwitchDestination,
  right: AccountSwitchDestination,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'home') return true;
  if (left.kind === 'space' && right.kind === 'space') {
    return left.spaceId === right.spaceId;
  }
  return (
    left.kind === 'room' &&
    right.kind === 'room' &&
    left.roomId === right.roomId &&
    left.source === right.source
  );
}
