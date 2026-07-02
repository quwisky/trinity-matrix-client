import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import {
  TrnAlertService,
  HlmButton,
  HlmCheckbox,
  HlmSpinner,
} from '@trinity/ui-spartan';
import { CryptoService, type PasswordPrompt } from '@trinity/core';
import { runWithBusy } from '@trinity/ui';
import { RecoveryKeyDisplayComponent } from '../recovery-key-display/recovery-key-display.component';

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
  imports: [HlmButton, HlmCheckbox, HlmSpinner, RecoveryKeyDisplayComponent],
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

  /** Gates "Continue" until the user confirms they saved the key. */
  readonly confirmedSaved = signal(false);

  /** The "Save your recovery key" heading, focused when the key is revealed. */
  private readonly savedHeading =
    viewChild<ElementRef<HTMLElement>>('savedHeading');
  private hasFocusedSavedHeading = false;

  constructor() {
    // Move focus to the heading once, when the recovery key first appears, so
    // keyboard and screen-reader users land on the critical "save this now"
    // content — without stealing focus again if the view later re-evaluates.
    effect(() => {
      const heading = this.savedHeading();
      if (heading && !this.hasFocusedSavedHeading) {
        this.hasFocusedSavedHeading = true;
        heading.nativeElement.focus();
      }
    });
  }

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
