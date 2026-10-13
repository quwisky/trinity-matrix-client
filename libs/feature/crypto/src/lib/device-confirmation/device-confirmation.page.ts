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
import { finalize } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  PageHeaderComponent,
  TrnCardImports,
} from '@trinity/components/navigation-layout';
import { TrustDeviceConfirmationService } from '@trinity/data-access/trust';
import {
  ACCOUNT_REMOVAL_LAUNCHER,
  type AccountRemovalOutcome,
} from '@trinity/platform-native';

/** Where the unlock and verify pages bring the person back to. */
const CHECK_URL = '/encryption/confirm';
const REMOVAL_FAILED = 'This account couldn’t be removed right now. Try again.';
const SKIP_FAILED = 'Skipping the check didn’t work. Try again.';

/**
 * MSC4153 decision 2: a new device of an Account that has an identity is verified before
 * the app opens, with the recovery key or another device, or the identity is reset.
 * Removing the account from this device is the other way out; debug builds can skip.
 *
 * The screen owns no flow: it routes to the existing unlock and verify pages, which come
 * back here, runs the shared account-removal flow, and leaves for Rooms as soon as
 * nothing is required any more.
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
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly gate = this.confirmation.gate;
  readonly canSkip = this.confirmation.canSkip;
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** The status could not be read within the settle time; offer Try again. */
  readonly stalled = signal(false);
  /** Only an identity with recovery has a recovery key to offer. */
  readonly hasRecoveryKey = computed(() => {
    const gate = this.gate();
    return gate.kind === 'required' && gate.status === 'needs-recovery';
  });

  constructor() {
    // A direct visit (reload, bookmark) still loads the active Account's record.
    this.settle();
    // Leave as soon as nothing is asked: verified, reset, skipped or never required.
    effect(() => {
      if (this.gate().kind !== 'not-required') return;
      untracked(
        () => void this.router.navigateByUrl('/rooms', { replaceUrl: true }),
      );
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

  /**
   * Load the active Account's record and status. `settledGate()` gives up after
   * `DEVICE_CONFIRMATION_SETTLE_MS`; a gate still pending then means the status could not
   * be read, so the screen offers Try again instead of a spinner that never ends.
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

  private afterRemoval(outcome: AccountRemovalOutcome): void {
    switch (outcome.kind) {
      case 'removed':
        // With no account left, the removal flow has already gone to sign-in.
        if (outcome.remainingAccountIds.length > 0) {
          void this.router.navigateByUrl('/rooms', { replaceUrl: true });
        }
        return;
      case 'export-keys':
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
