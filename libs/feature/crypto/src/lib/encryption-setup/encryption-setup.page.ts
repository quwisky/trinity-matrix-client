import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { TrnAlertService } from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/button';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import { CryptoService } from '@trinity/data-access/crypto';
import { type PasswordPrompt } from '@trinity/util/matrix';
import { runWithBusy } from '@trinity/util/ui';
import { PageHeaderComponent } from '@trinity/components/page-header';
import { RecoveryKeySaveComponent } from '../recovery-key-save/recovery-key-save.component';
import {
  confirmLeaving,
  type LeaveRisk,
} from '../recovery-key-save/leave-confirmation';

/**
 * First-device encryption setup (flow A). Triggers
 * {@link CryptoService.setUp}, answering its UIA password challenge via an Ionic
 * alert, then displays the generated recovery key once behind an explicit
 * "I've saved it" gate before continuing to the app. The key is held only in a
 * signal for this view and is never persisted.
 */
@Component({
  selector: 'trn-encryption-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'encryption-setup.page.html',
  styleUrls: ['encryption-setup.page.scss'],
  imports: [
    PageHeaderComponent,
    TrnButton,
    TrnSpinnerComponent,
    RecoveryKeySaveComponent,
  ],
})
export class EncryptionSetupPage {
  private readonly crypto = inject(CryptoService);
  private readonly router = inject(Router);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** The generated recovery key — shown once, never persisted. */
  readonly recoveryKey = signal<string | null>(null);

  /** Kick off cross-signing + secret-storage + key-backup bootstrap. */
  setUp(): void {
    this.withBusy(this.crypto.setUp(this.promptPassword)).subscribe((key) => {
      this.recoveryKey.set(key);
    });
  }

  /** Leave for the app once the user has saved their recovery key. */
  finish(): void {
    // Drop our reference to the key as early as possible (it's never persisted).
    this.recoveryKey.set(null);
    void this.router.navigateByUrl('/rooms', { replaceUrl: true });
  }

  /**
   * Whether leaving right now would throw something away.
   *
   * A setup already running is the worse of the two: unsubscribing does not abort it
   * ({@link CryptoService.setUp} is a promise behind `defer`), so it goes on to provision
   * 4S and a key backup whose only recovery key was emitted to a subscriber that no
   * longer exists — after which Settings → Security reports the account as secured and
   * nothing ever prompts the user to fix it. A key already on screen is the more urgent
   * of the two only because it is one press from being saved.
   *
   * `busy` is a safe proxy for "setup in flight" here because {@link setUp} is the page's
   * only action; the unlock page needs a separate signal precisely because it has two.
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
   * Called by the route guard. The browser's own back button dismisses this page without
   * asking anyone — on the path every new account takes. Same fail-towards-staying
   * semantics as the unlock page's guard.
   */
  confirmLeave(): Promise<boolean> {
    return confirmLeaving(this.alert, this.leaveWouldDiscard());
  }

  /**
   * Answers the SDK's UIA password challenge. The SDK may invoke this zero times
   * (server completes without UIA) or repeatedly (wrong password); each call shows
   * a fresh password alert. Resolving `null` cancels the whole setup.
   */
  private readonly promptPassword: PasswordPrompt = () =>
    this.alert.prompt({
      header: 'Confirm your password',
      message: 'Your homeserver needs your password to set up encryption.',
      placeholder: 'Password',
      confirmText: 'Confirm',
      inputType: 'password',
    });

  /** Wrap a one-shot action with shared busy/error handling. */
  private withBusy<T>(source: Observable<T>): Observable<T> {
    return runWithBusy(source, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    });
  }
}
