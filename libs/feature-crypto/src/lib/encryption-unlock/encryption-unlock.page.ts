import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormField, disabled, form } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { DialogRef } from '@angular/cdk/dialog';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Browser } from '@capacitor/browser';
import { Observable, finalize, firstValueFrom } from 'rxjs';
import { CryptoService } from '@trinity/data-access-crypto';
import { AuthService } from '@trinity/data-access-auth';
import { UiaUnsupportedError, type PasswordPrompt } from '@trinity/util-matrix';
import {
  PageHeaderComponent,
  resolveInternalReturnTo,
  runWithBusy,
} from '@trinity/ui';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { HlmSpinner } from '@trinity/helm/spinner';
import { TrnAlertService } from '@trinity/helm/overlay';
import { RecoveryKeyDisplayComponent } from '../recovery-key-display/recovery-key-display.component';
import {
  RESET_CONFIRMATION_WORD,
  RESET_CONSEQUENCES,
  crossSigningResetUrl,
} from './recovery-reset';

/**
 * New-device unlock (flow B). The account already has secret storage; the user
 * enters their recovery key to trust this device — {@link CryptoService.recoverWithKey}
 * imports the cross-signing secrets and enables key backup. Key-only by design:
 * Trinity provisions a random recovery key (no passphrase) during setup.
 */
@Component({
  selector: 'trn-encryption-unlock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'encryption-unlock.page.html',
  styleUrls: ['encryption-unlock.page.scss'],
  imports: [
    FormField,
    NgTemplateOutlet,
    PageHeaderComponent,
    RecoveryKeyDisplayComponent,
    HlmButton,
    HlmCheckbox,
    HlmInput,
    HlmLabel,
    HlmSpinner,
  ],
})
export class EncryptionUnlockPage {
  private readonly crypto = inject(CryptoService);
  private readonly auth = inject(AuthService);
  private readonly alert = inject(TrnAlertService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  // Present only when opened as a dialog (desktop); null on the routed page.
  private readonly dialogRef = inject<DialogRef<void, EncryptionUnlockPage>>(
    DialogRef,
    { optional: true },
  );
  private readonly destroyRef = inject(DestroyRef);

  readonly busy = signal(false);

  private readonly keyModel = signal({ recoveryKey: '' });
  // Disabled belongs to the schema, not to a [disabled] binding on the input: Signal
  // Forms owns the field's disabled state and rejects the binding at compile time
  // (NG8022). Declared after `busy` because the schema reads it.
  readonly unlockForm = form(this.keyModel, (path) => {
    disabled(path.recoveryKey, { when: () => this.busy() });
  });
  /** Whether there is a key to try — keeps the trim out of the template. */
  readonly hasKey = computed(
    () => this.keyModel().recoveryKey.trim().length > 0,
  );
  readonly error = signal<string | null>(null);

  /**
   * The recovery key minted by a reset, shown once. Non-null switches the page from
   * "enter your key" to "save this key" — the reset leaves the account `ready`, so status
   * cannot be what decides this.
   */
  readonly newRecoveryKey = signal<string | null>(null);
  /** The user has ticked "I've saved it", which is what releases the Done button. */
  readonly confirmedSaved = signal(false);

  /** When true the page is modal content (desktop); else a routed page. */
  readonly asModal = input(false);
  /** Asks an @Output-bound host modal to dismiss. */
  readonly closed = output<void>();

  /** Unlock this device from the entered recovery key. */
  unlock(): void {
    const key = this.keyModel().recoveryKey.trim();
    if (!key) {
      return;
    }
    this.withBusy(this.crypto.recoverWithKey(key)).subscribe(() => {
      this.clearKey(); // drop the key from memory once it's been used
      this.leave();
    });
  }

  /**
   * Throw the account's encryption identity away and build a new one, for someone with no
   * recovery key and no other verified device.
   *
   * Gated on typing the confirmation word: this destroys the account's server-side message
   * backup, and a mis-tap is not an acceptable way to reach it. Cancelling and mistyping
   * are the same answer — no.
   */
  async resetRecovery(): Promise<void> {
    const typed = await this.alert.prompt({
      header: 'Reset encryption',
      message: RESET_CONSEQUENCES,
      placeholder: RESET_CONFIRMATION_WORD,
      confirmText: 'Reset',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (typed?.trim().toUpperCase() !== RESET_CONFIRMATION_WORD) {
      return;
    }
    // Deliberately NOT runWithBusy: it turns a failure into EMPTY, so an error handler
    // never runs — and this is the one path that has to inspect WHY it failed.
    this.busy.set(true);
    this.error.set(null);
    this.crypto
      .resetRecovery(this.promptPassword)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.busy.set(false)),
      )
      .subscribe({
        next: (key) => {
          this.clearKey();
          this.newRecoveryKey.set(key);
        },
        error: (err: unknown) => void this.onResetFailed(err),
      });
  }

  /**
   * An OIDC-native account cannot answer a password challenge in-app, so the reset has to
   * happen at the identity provider. Only {@link UiaUnsupportedError} means that — a wrong
   * password or a dropped connection must keep the message they already produced.
   */
  private async onResetFailed(err: unknown): Promise<void> {
    if (!(err instanceof UiaUnsupportedError)) {
      this.error.set(err instanceof Error ? err.message : String(err));
      return;
    }
    const management = await firstValueFrom(this.auth.getAccountManagement());
    const url = management ? crossSigningResetUrl(management) : null;
    if (!url) {
      this.error.set(
        'Your identity provider has to reset encryption for this account. Trinity cannot do it here.',
      );
      return;
    }
    this.error.set(
      'Your identity provider handles this. Finish the reset there, then come back and sign in again.',
    );
    void Browser.open({ url });
  }

  /** Finish after a reset: the key has been shown and the user says it is saved. */
  finishReset(): void {
    this.newRecoveryKey.set(null);
    this.leave();
  }

  /**
   * Password prompt for the reset's device-signing-key upload. Same copy as encryption
   * setup, which drives the identical UIA stage.
   */
  private readonly promptPassword: PasswordPrompt = () =>
    this.alert.prompt({
      header: 'Confirm your password',
      message: 'Your homeserver needs your password to reset encryption.',
      placeholder: 'Password',
      confirmText: 'Confirm',
      inputType: 'password',
    });

  /** Close without unlocking (modal Close / return on the routed page). */
  close(): void {
    this.clearKey();
    this.leave();
  }

  /**
   * Wipe the entered key. `reset` rather than a bare model write so the field's
   * touched/dirty state goes with it — this runs on the security-relevant path where
   * the key must not outlive its use.
   */
  private clearKey(): void {
    this.unlockForm().reset({ recoveryKey: '' });
  }

  /** Close the dialog, or (routed) return to the launch route / /rooms. */
  private leave(): void {
    if (this.asModal()) {
      // @Outputs aren't bound on dialog-created components, so close the host
      // dialog ourselves; `closed` stays for any @Output-bound host.
      this.closed.emit();
      this.dialogRef?.close();
      return;
    }
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    void this.router.navigateByUrl(resolveInternalReturnTo(returnTo), {
      replaceUrl: true,
    });
  }

  /** Wrap a one-shot action with shared busy/error handling. */
  private withBusy<T>(source: Observable<T>): Observable<T> {
    return runWithBusy(source, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    });
  }
}
