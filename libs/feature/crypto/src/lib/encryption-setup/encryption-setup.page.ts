import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom, tap, type Observable } from 'rxjs';
import { TrnAlertService } from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  TrustOperationError,
  TrustService,
  type TrustRecovery,
} from '@trinity/data-access/trust';
import { type PasswordPrompt } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import {
  PageHeaderComponent,
  TrnCardImports,
} from '@trinity/components/navigation-layout';
import { RecoveryKeySaveComponent } from '../recovery-key-save/recovery-key-save.component';
import {
  confirmLeaving,
  type LeaveRisk,
} from '../recovery-key-save/leave-confirmation';

/**
 * First-device encryption setup. Triggers {@link TrustService.setUp}, answering its UIA
 * password challenge, then shows the generated recovery key once behind an explicit
 * "I've saved it" gate. The key is held only in a signal for this view and never
 * persisted.
 */
@Component({
  selector: 'trn-encryption-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'encryption-setup.page.html',
  styleUrls: ['encryption-setup.page.scss'],
  imports: [
    TrnCardImports,
    PageHeaderComponent,
    TrnButton,
    TrnSpinnerComponent,
    RecoveryKeySaveComponent,
  ],
})
export class EncryptionSetupPage {
  private readonly crypto = inject(TrustService);
  private readonly router = inject(Router);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  /** What the last failed setup said the user can do about it; cleared by the next try. */
  private readonly failureRecovery = signal<TrustRecovery | null>(null);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Whether the error's answer lives in Security settings: a refused setup on an Account
   * whose identity is held elsewhere says to verify or reset, and both live there.
   */
  readonly offerSecuritySettings = computed(() => {
    const recovery = this.failureRecovery();
    return (
      this.error() !== null &&
      (recovery === 'verify-another-device' ||
        recovery === 'review-security-settings')
    );
  });

  /** The generated recovery key — shown once, never persisted. */
  readonly recoveryKey = signal<string | null>(null);

  /** Bootstrap cross-signing, secret storage and key backup. */
  setUp(): void {
    this.failureRecovery.set(null);
    const setUp = this.crypto.setUp(this.promptPassword).pipe(
      tap({
        error: (err: unknown) =>
          this.failureRecovery.set(
            err instanceof TrustOperationError ? err.recovery : null,
          ),
      }),
    );
    this.withBusy(setUp).subscribe((key) => {
      this.recoveryKey.set(key);
    });
  }

  /** Go to Security settings, where verifying this device and the reset both live. */
  openSecuritySettings(): void {
    void this.router.navigateByUrl('/settings/security');
  }

  /** Leave for the app once the user has saved their recovery key. */
  finish(): void {
    // Drop our reference to the key as early as possible.
    this.recoveryKey.set(null);
    void this.router.navigateByUrl('/rooms', { replaceUrl: true });
  }

  /**
   * Whether leaving right now would throw something away.
   *
   * Leaving mid-setup is the worse case: unsubscribing does not abort
   * {@link TrustService.setUp} (a promise behind `defer`), so it still provisions 4S and
   * a key backup whose only recovery key went to a gone subscriber, and Settings →
   * Security then reports the account as secured.
   *
   * `busy` proxies "setup in flight" only because {@link setUp} is this page's only
   * action; the unlock page has two and needs a separate signal.
   */
  private leaveWouldDiscard(): LeaveRisk | null {
    if (this.recoveryKey()) {
      return 'unsaved-key';
    }
    return this.busy() ? 'setup-in-flight' : null;
  }

  /**
   * Whether it is safe to leave, asking the user when it is not.
   *
   * Called by the route guard, since the browser's back button would otherwise dismiss
   * the page silently. Fails towards staying, like the unlock page's guard.
   */
  confirmLeave(): Observable<boolean> {
    return confirmLeaving(this.alert, this.leaveWouldDiscard());
  }

  /**
   * Answers the SDK's UIA password challenge. The SDK may invoke this zero times
   * (server completes without UIA) or repeatedly (wrong password); each call shows
   * a fresh password alert. Resolving `null` cancels the whole setup.
   */
  private readonly promptPassword: PasswordPrompt = () =>
    firstValueFrom(
      this.alert.prompt$({
        header: 'Confirm your password',
        message: 'Your homeserver needs your password to set up encryption.',
        placeholder: 'Password',
        confirmText: 'Confirm',
        inputType: 'password',
      }),
    );

  private withBusy<T>(source: Observable<T>): Observable<T> {
    return runWithBusy(source, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    });
  }
}
