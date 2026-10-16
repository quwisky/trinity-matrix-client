import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { finalize, timer, type Subscription } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  PageHeaderComponent,
  TrnCardImports,
} from '@trinity/components/navigation-layout';
import {
  DEVICE_CONFIRMATION_SETTLE_MS,
  TrustDeviceConfirmationService,
} from '@trinity/data-access/trust';
import {
  ACCOUNT_REMOVAL_LAUNCHER,
  ACCOUNT_SWITCH_LAUNCHER,
  type AccountRemovalOutcome,
} from '@trinity/platform-native';

/** Where the unlock and verify pages bring the person back to. */
const CHECK_URL = '/encryption/confirm';
const REMOVAL_FAILED = 'This account couldn’t be removed right now. Try again.';
const SKIP_FAILED = 'Skipping the check didn’t work. Try again.';
const SWITCH_FAILED =
  'Couldn’t switch to another account right now. Try again.';

/**
 * Following MSC4153, a new device of an Account that has an identity is verified before
 * the app opens, with the recovery key or another device, or the identity is reset.
 * Removing the account from this device is the other way out; debug builds can skip.
 * Another signed-in account stays reachable, so this check never blocks it.
 *
 * The screen owns no flow: it routes to the unlock and verify pages (which come back
 * here), runs the shared account-removal flow, and leaves for Rooms once nothing is
 * required.
 */
@Component({
  selector: 'trn-device-confirmation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './device-confirmation.page.html',
  styleUrl: './device-confirmation.page.scss',
  imports: [
    TrnCardImports,
    PageHeaderComponent,
    TrnButton,
    TrnSpinnerComponent,
  ],
})
export class DeviceConfirmationPage {
  private readonly confirmation = inject(TrustDeviceConfirmationService);
  private readonly accountRemoval = inject(ACCOUNT_REMOVAL_LAUNCHER);
  private readonly accountSwitch = inject(ACCOUNT_SWITCH_LAUNCHER);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  /** A removal or switch ended with a move away from the check; nothing else navigates then. */
  private leaving = false;
  private stallTimer: Subscription | null = null;
  private readonly pending = computed(() => this.gate().kind === 'pending');

  readonly gate = this.confirmation.gate;
  readonly canSkip = this.confirmation.canSkip;
  /** Another signed-in account to open instead; a pending check never blocks it. */
  readonly hasOtherAccount = this.accountSwitch.hasOtherAccount;
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** The status could not be read within the settle time; offer the ways out. */
  readonly stalled = signal(false);
  /** Only an identity with recovery has a recovery key to offer. */
  readonly hasRecoveryKey = computed(() => {
    const gate = this.gate();
    return gate.kind === 'required' && gate.status === 'needs-recovery';
  });

  constructor() {
    // A direct visit (reload, bookmark) still loads the active Account's record.
    this.settle();
    // Keep in step with the guard, which lets a route through once the status has not
    // arrived within the settle time; mirror that whenever the gate is loading, including
    // after it was settled.
    effect(() => {
      const pending = this.pending();
      untracked(() => (pending ? this.armStall() : this.disarmStall()));
    });
    // Leave once nothing is asked. A removal or switch in flight ends the check itself
    // (sign-out repoints the active account first), so wait for its outcome.
    effect(() => {
      if (this.gate().kind !== 'not-required' || this.busy()) return;
      untracked(() => {
        if (this.leaving) return;
        void this.router.navigateByUrl('/rooms', { replaceUrl: true });
      });
    });
  }

  useRecoveryKey(): void {
    void this.router.navigate(['/encryption/unlock'], {
      queryParams: { returnTo: CHECK_URL },
    });
  }

  verifyWithAnotherDevice(): void {
    void this.router.navigate(['/encryption/verify'], {
      queryParams: { returnTo: CHECK_URL },
    });
  }

  /** The unlock page owns the typed confirmation and the consequences of a reset. */
  resetIdentity(): void {
    void this.router.navigate(['/encryption/unlock'], {
      queryParams: { returnTo: CHECK_URL, reset: '1' },
    });
  }

  skip(): void {
    this.error.set(null);
    this.confirmation
      .skip()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: () => this.error.set(SKIP_FAILED) });
  }

  /** Read the status again after the check could not settle. */
  retry(): void {
    this.settle();
    if (this.pending()) this.armStall();
  }

  /** Open Rooms unchecked, as the guard does once the settle time has passed. */
  continueWithoutCheck(): void {
    void this.router.navigateByUrl('/rooms', { replaceUrl: true });
  }

  removeAccount(): void {
    const accountId = this.confirmation.activeAccountId();
    if (!accountId || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.accountRemoval
      .remove(accountId)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => this.afterRemoval(outcome));
  }

  /** Switch to another signed-in account and open Rooms for it. */
  useAnotherAccount(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.accountSwitch
      .switchToOther()
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((switched) => {
        if (!switched) {
          this.error.set(SWITCH_FAILED);
          return;
        }
        this.leaveForRooms();
      });
  }

  /**
   * Load the active Account's record and status. `settledGate()` gives up after
   * `DEVICE_CONFIRMATION_SETTLE_MS`; a gate still pending then offers Try again instead of
   * an endless spinner.
   */
  private settle(): void {
    this.stalled.set(false);
    this.confirmation
      .settledGate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.gate().kind === 'pending') this.stalled.set(true);
      });
  }

  private armStall(): void {
    this.stallTimer?.unsubscribe();
    this.stallTimer = timer(DEVICE_CONFIRMATION_SETTLE_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.pending()) this.stalled.set(true);
      });
  }

  private disarmStall(): void {
    this.stallTimer?.unsubscribe();
    this.stallTimer = null;
    this.stalled.set(false);
  }

  /**
   * Leave for Rooms after a removal or a switch. When the account now active also owes the
   * check, the guard sends the move back to this same URL, which the router ignores, so
   * this page stays: it must still leave once that account's gate stops asking.
   */
  private leaveForRooms(): void {
    this.leaving = true;
    void this.router.navigateByUrl('/rooms', { replaceUrl: true }).then(
      (navigated) => {
        if (!navigated) this.leaving = false;
      },
      () => {
        this.leaving = false;
      },
    );
  }

  private afterRemoval(outcome: AccountRemovalOutcome): void {
    switch (outcome.kind) {
      case 'removed':
        // With no account left, the removal flow has already gone to sign-in.
        if (outcome.remainingAccountIds.length > 0) {
          this.leaveForRooms();
        } else {
          this.leaving = true;
        }
        return;
      case 'export-keys':
        this.leaving = true;
        void this.router.navigate(['/settings/security']);
        return;
      case 'failed':
        this.error.set(REMOVAL_FAILED);
        return;
      case 'kept':
      case 'still-running':
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
      }
    }
  }
}
