import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
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
import {
  UiaCancelledError,
  UiaUnsupportedError,
  type PasswordPrompt,
} from '@trinity/util-matrix';
import {
  PageHeaderComponent,
  resolveInternalReturnTo,
  runWithBusy,
} from '@trinity/ui';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { HlmSpinner } from '@trinity/helm/spinner';
import { TrnAlertService } from '@trinity/helm/overlay';
import { RecoveryKeySaveComponent } from '../recovery-key-save/recovery-key-save.component';
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
    RecoveryKeySaveComponent,
    HlmButton,
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
  /**
   * A reset specifically is in flight. Distinct from {@link busy}, which the ordinary
   * unlock also sets — the two need different copy, and one of them cannot be abandoned.
   */
  readonly resetting = signal(false);

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
   * The identity provider's own reset page, when a refused reset can point at one.
   *
   * Rendered as a link rather than only handed to `Browser.open`: by the time we know to
   * open it, several awaits and a network round-trip have passed since the user's click,
   * so the browser no longer counts it as user-initiated and blocks the popup. A link
   * they can press is the difference between an explanation and a dead end.
   */
  readonly providerResetUrl = signal<string | null>(null);

  /** What the busy spinner says — the two operations are not interchangeable. */
  readonly progressMessage = computed(() =>
    this.resetting()
      ? 'Resetting your encryption…'
      : 'Unlocking your encrypted messages…',
  );

  /** Page/modal title, which has to follow what the page is actually doing. */
  readonly title = computed(() =>
    this.newRecoveryKey() ? 'Encryption reset' : 'Verify this device',
  );

  /**
   * The recovery key minted by a reset, shown once. Non-null switches the page from
   * "enter your key" to "save this key" — the reset leaves the account `ready`, so status
   * cannot be what decides this.
   */
  readonly newRecoveryKey = signal<string | null>(null);

  /** When true the page is modal content (desktop); else a routed page. */
  readonly asModal = input(false);
  /** Asks an @Output-bound host modal to dismiss. */
  readonly closed = output<void>();

  /**
   * Arrive with the reset already offered, for an entry point whose own label promised
   * it (Settings → Security's "I've lost my recovery key"). Set as an input by the modal
   * presentation and as `?reset=1` by the routed one.
   */
  readonly offerReset = input(false);

  constructor() {
    // Honour the caller's intent once, after the view exists so the confirm dialog has
    // something to sit over. A gate, not the action — the user still has to type the word.
    afterNextRender(() => {
      const asked =
        this.offerReset() ||
        this.route.snapshot.queryParamMap.get('reset') === '1';
      if (asked) {
        void this.resetRecovery();
      }
    });
  }

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
      message: `${RESET_CONSEQUENCES}\n\nType ${RESET_CONFIRMATION_WORD} to confirm.`,
      placeholder: RESET_CONFIRMATION_WORD,
      inputLabel: `Type ${RESET_CONFIRMATION_WORD} to confirm`,
      confirmText: 'Reset',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (typed === null) {
      return; // cancelled — they said no, and that needs no explanation
    }
    if (typed.trim().toUpperCase() !== RESET_CONFIRMATION_WORD) {
      // Silence here is indistinguishable from a broken button.
      this.error.set(
        `Nothing was reset. Type ${RESET_CONFIRMATION_WORD} exactly to confirm.`,
      );
      return;
    }
    // Deliberately NOT runWithBusy: it turns a failure into EMPTY, so an error handler
    // never runs — and this is the one path that has to inspect WHY it failed.
    this.busy.set(true);
    this.resetting.set(true);
    this.error.set(null);
    this.providerResetUrl.set(null);
    this.crypto
      .resetRecovery(this.promptPassword)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.busy.set(false);
          this.resetting.set(false);
        }),
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
    if (err instanceof UiaCancelledError) {
      return; // they stopped it themselves, before anything was touched
    }
    if (!(err instanceof UiaUnsupportedError)) {
      this.error.set(err instanceof Error ? err.message : String(err));
      return;
    }
    // A rejected read here must not swallow the explanation: the whole point of this
    // branch is to say something, and `void`-discarding a throw would say nothing.
    const management = await firstValueFrom(
      this.auth.getAccountManagement(),
    ).catch(() => null);
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
    // Rendered as a link too — see providerResetUrl. Native has no popup blocker, so
    // this still opens straight away there.
    this.providerResetUrl.set(url);
    void Browser.open({ url });
  }

  /** Finish after a reset: the key has been shown and the user says it is saved. */
  finishReset(): void {
    this.newRecoveryKey.set(null);
    this.leave();
  }

  /**
   * Whether closing right now would throw something away.
   *
   * The reset cannot be cancelled once it is running — unsubscribing does not abort the
   * promise — and the key it mints is shown exactly once. Both are reasons to ask first,
   * and neither is a reason to disable the button: the desktop dialog opens with
   * `disableClose`, so this is the only way out and taking it away would trap the user.
   */
  private closeWouldDiscard(): 'in-flight' | 'unsaved-key' | null {
    if (this.newRecoveryKey()) {
      return 'unsaved-key';
    }
    return this.resetting() ? 'in-flight' : null;
  }

  /**
   * Whether it is safe to leave, asking the user when it is not.
   *
   * Shared by the modal's Close button and by the route guard, because the routed page
   * is dismissed by the browser's own back button and would otherwise throw a shown-once
   * key away without a word — which is the path most users are on.
   *
   * Fails towards staying: if the confirmation itself cannot be shown there is nothing
   * to read, and refusing to leave loses nothing that cannot be retried.
   */
  async confirmLeave(): Promise<boolean> {
    const risk = this.closeWouldDiscard();
    if (!risk) {
      return true;
    }
    try {
      return await this.alert.confirm({
        header:
          risk === 'unsaved-key'
            ? 'Leave without saving your key?'
            : 'Encryption reset in progress',
        message:
          risk === 'unsaved-key'
            ? "This key is shown once. Leave now and you won't be able to recover your messages on another device."
            : "Leaving won't stop it, and the new recovery key it produces will be lost. Wait for it to finish.",
        confirmText: 'Leave anyway',
        cancelText: 'Stay',
        destructive: true,
      });
    } catch {
      return false;
    }
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
  async close(): Promise<void> {
    if (!(await this.confirmLeave())) {
      return;
    }
    this.clearKey();
    // The shown-once key is the more sensitive of the two; dropping it here keeps this
    // symmetrical with finishReset(), which has always cleared it.
    this.newRecoveryKey.set(null);
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
