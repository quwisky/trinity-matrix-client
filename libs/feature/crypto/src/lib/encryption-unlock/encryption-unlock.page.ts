import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormField, disabled, form } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Browser } from '@capacitor/browser';
import { Observable, finalize, firstValueFrom } from 'rxjs';
import { CryptoService } from '@trinity/data-access/crypto';
import { AuthService } from '@trinity/data-access/auth';
import {
  PageHeaderComponent,
  resolveInternalReturnTo,
  runWithBusy,
} from '@trinity/ui';
import { TrnButton } from '@trinity/kit/button';
import { TrnInput } from '@trinity/kit/input';
import { TrnLabel } from '@trinity/kit/label';
import { TrnSpinner } from '@trinity/kit/spinner';
import { DialogRef, TrnAlertService } from '@trinity/kit/overlay';
import { RecoveryKeySaveComponent } from '../recovery-key-save/recovery-key-save.component';
import {
  confirmLeaving,
  type LeaveRisk,
} from '../recovery-key-save/leave-confirmation';
import {
  RESET_MISTYPED_MESSAGE,
  confirmResetIntent,
  describeResetFailure,
  resetPasswordPrompt,
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
    TrnButton,
    TrnInput,
    TrnLabel,
    TrnSpinner,
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
   *
   * Linked to {@link error} so it cannot outlive the message it is the second half of.
   * Every action on this page clears `error` first ({@link runWithBusy} included), and
   * this link surviving that would sit next to an unrelated failure — or next to none —
   * telling the user two contradictory things. Structural on purpose: the next action
   * added here gets the clearing for free rather than having to remember it.
   */
  readonly providerResetUrl = linkedSignal<string | null, string | null>({
    source: this.error,
    computation: () => null,
  });

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
    const intent = await confirmResetIntent(this.alert);
    if (intent === 'cancelled') {
      return; // they said no, and that needs no explanation
    }
    if (intent === 'mistyped') {
      this.error.set(RESET_MISTYPED_MESSAGE);
      return;
    }
    // Deliberately NOT runWithBusy: it turns a failure into EMPTY, so an error handler
    // never runs — and this is the one path that has to inspect WHY it failed.
    this.busy.set(true);
    this.resetting.set(true);
    this.error.set(null);
    this.crypto
      .resetRecovery(resetPasswordPrompt(this.alert))
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

  /** Say what went wrong, and open the provider's page when that is the answer. */
  private async onResetFailed(err: unknown): Promise<void> {
    const failure = await describeResetFailure(err, () =>
      firstValueFrom(this.auth.getAccountManagement()),
    );
    if (!failure) {
      return;
    }
    // Order matters: providerResetUrl is linked to error and clears when it changes.
    this.error.set(failure.message);
    if (failure.providerUrl) {
      // Rendered as a link too — see providerResetUrl. Native has no popup blocker, so
      // this still opens straight away there.
      this.providerResetUrl.set(failure.providerUrl);
      void Browser.open({ url: failure.providerUrl });
    }
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
  private closeWouldDiscard(): LeaveRisk | null {
    if (this.newRecoveryKey()) {
      return 'unsaved-key';
    }
    return this.resetting() ? 'reset-in-flight' : null;
  }

  /**
   * Whether it is safe to leave, asking the user when it is not.
   *
   * Shared by the modal's Close button and by the route guard, because the routed page
   * is dismissed by the browser's own back button and would otherwise throw a shown-once
   * key away without a word — which is the path most users are on.
   */
  confirmLeave(): Promise<boolean> {
    return confirmLeaving(this.alert, this.closeWouldDiscard());
  }

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
