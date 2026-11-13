import { Injectable, inject, signal } from '@angular/core';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnToastService } from '@trinity/components/overlay';
import { IdentityService } from '@trinity/data-access/identity';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import {
  TrustOperationError,
  TrustUsersService,
  TrustVerificationService,
} from '@trinity/data-access/trust';
import { finalize, type Observable } from 'rxjs';

/**
 * Who an identity action is for: the Account they were listed for, the id it acts on and the
 * name its failure toast uses.
 */
export interface IdentityChangeTarget {
  readonly accountId: string;
  readonly userId: string;
  readonly name: string;
}

/** Which response is running for a person. */
export type IdentityChangeAction = 'acknowledge' | 'withdraw' | 'verify';

/**
 * The responses to a changed identity, shared by the room banner, its Review list and the
 * member card. Each runs once per person at a time; {@link pending} names the one in flight so
 * its button can say so, and a failure is a toast. Success needs no message: the warning
 * clears itself.
 */
@Injectable({ providedIn: 'root' })
export class IdentityChangeActionsService {
  private readonly trust = inject(TrustUsersService);
  private readonly verification = inject(TrustVerificationService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly toast = inject(TrnToastService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly identity = inject(IdentityService);
  private readonly running = signal<ReadonlyMap<string, IdentityChangeAction>>(
    new Map(),
  );

  /** The action in flight for this person, or null. */
  pending(userId: string): IdentityChangeAction | null {
    return this.running().get(userId) ?? null;
  }

  /** Accept a changed identity as theirs. */
  acknowledge(target: IdentityChangeTarget): void {
    this.run(
      target,
      'acknowledge',
      () => this.trust.acknowledgeIdentity(target.userId),
      `Couldn't accept ${target.name}'s new identity.`,
      'Identity not accepted',
    );
  }

  /** Stop requiring a previously verified person to be verified. */
  withdraw(target: IdentityChangeTarget): void {
    this.run(
      target,
      'withdraw',
      () => this.trust.withdrawVerification(target.userId),
      `Couldn't withdraw verification for ${target.name}.`,
      'Verification not withdrawn',
    );
  }

  /**
   * Start verifying them again over a DM; the app's verification host takes it from there.
   * `started` lets the opener close itself so the verification dialog isn't covered.
   */
  verifyAgain(target: IdentityChangeTarget, started?: () => void): void {
    this.run(
      target,
      'verify',
      () =>
        this.verification.startUserVerification(
          target.userId,
          this.rooms.createDirectMessage(target.userId),
        ),
      null,
      'Verification not started',
      started,
    );
  }

  private run(
    { accountId, userId }: IdentityChangeTarget,
    kind: IdentityChangeAction,
    action: () => Observable<unknown>,
    failure: string | null,
    refusal: string,
    succeeded?: () => void,
  ): void {
    if (this.pending(userId)) return;
    // The action runs as the client's active Account, resolved when `action` is subscribed
    // below, in this same tick. The row can outlive a switch by a render, with both the shown
    // and the active Account already another one, so it must be the row's own Account.
    if (
      accountId !== this.workspace.activeAccountId() ||
      accountId !== this.identity.activeUserId()
    ) {
      this.toast.show(`${refusal}: you switched account while this was open.`, {
        duration: 4000,
        variant: 'danger',
      });
      return;
    }
    this.running.update((map) => new Map(map).set(userId, kind));
    action()
      .pipe(
        finalize(() =>
          this.running.update((map) => {
            const next = new Map(map);
            next.delete(userId);
            return next;
          }),
        ),
      )
      .subscribe({
        next: () => succeeded?.(),
        error: (error: unknown) =>
          this.toast.show(
            failure ??
              (error instanceof TrustOperationError
                ? error.message
                : 'Could not start verification.'),
            { duration: 4000, variant: 'danger' },
          ),
      });
  }
}
