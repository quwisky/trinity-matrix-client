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
import { Observable, finalize, firstValueFrom, take } from 'rxjs';
import { TrustService } from '@trinity/data-access/trust';
import { ExternalBrowserService } from '@trinity/platform-native';
import { resolveInternalReturnTo, runWithBusy } from '@trinity/util/ui';
import {
  PageHeaderComponent,
  TrnCardImports,
} from '@trinity/components/navigation-layout';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnFieldImports } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
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
 * New-device unlock. The account already has secret storage; the user enters their
 * recovery key to trust this device ({@link TrustService.recoverWithKey} imports the
 * cross-signing secrets and enables key backup). Key-only: setup provisions a random
 * recovery key, no passphrase.
 *
 * Also the one home of the irreversible reset. An Account without secret storage arrives
 * here only for that reset, so the page asks for no recovery key it does not have.
 */
@Component({
  selector: 'trn-encryption-unlock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'encryption-unlock.page.html',
  styleUrls: ['encryption-unlock.page.scss'],
  imports: [
    TrnCardImports,
    FormField,
    NgTemplateOutlet,
    PageHeaderComponent,
    RecoveryKeySaveComponent,
    TrnButton,
    TrnDialogShellComponent,
    TrnFieldImports,
    TrnInput,
    TrnSpinnerComponent,
  ],
})
export class EncryptionUnlockPage {
  private readonly crypto = inject(TrustService);
  private readonly alert = inject(TrnAlertService);
  private readonly externalBrowser = inject(ExternalBrowserService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  // Present only when opened as a dialog (desktop); null on the routed page.
  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef, {
    optional: true,
  });
  private readonly destroyRef = inject(DestroyRef);

  readonly busy = signal(false);
  /** A reset specifically is in flight; unlike {@link busy}, it cannot be abandoned. */
  readonly resetting = signal(false);

  private readonly keyModel = signal({ recoveryKey: '' });
  // Disabled belongs to the schema: Signal Forms owns it and rejects a [disabled] binding
  // at compile time (NG8022). Declared after `busy`, which the schema reads.
  readonly unlockForm = form(this.keyModel, (path) => {
    disabled(path.recoveryKey, { when: () => this.busy() });
  });
  readonly hasKey = computed(
    () => this.keyModel().recoveryKey.trim().length > 0,
  );
  readonly error = signal<string | null>(null);

  /**
   * The identity provider's own reset page, when a refused reset can point at one.
   *
   * Rendered as a link, not only handed to `Browser.open`: by the time it is known the
   * user's click is long over, so the browser blocks the popup.
   *
   * Linked to {@link error} so it cannot outlive the message it belongs to: every action
   * clears `error` first, and a surviving link would contradict an unrelated failure.
   * New actions get the clearing for free.
   */
  readonly providerResetUrl = linkedSignal<string | null, string | null>({
    source: this.error,
    computation: () => null,
  });

  readonly progressMessage = computed(() =>
    this.resetting()
      ? 'Resetting your identity…'
      : 'Unlocking your encrypted messages…',
  );

  /**
   * The Account's identity lives on another device and no secret storage backs it, so
   * there is no recovery key to enter and the page offers only the reset. Every other
   * reading, `unknown` included, keeps the key form: a status not in yet must not hide
   * the ordinary path.
   *
   * Held while a reset runs: the reset moves the live status through other readings, and
   * following them would swap the page's copy mid-reset.
   */
  readonly identityWithoutRecovery = linkedSignal<
    { readonly live: boolean; readonly resetting: boolean },
    boolean
  >({
    source: () => ({
      live:
        this.crypto.status() === 'needs-verification' ||
        this.crypto.recoverySetupElsewhere(),
      resetting: this.resetting(),
    }),
    computation: ({ live, resetting }, previous) =>
      resetting && previous ? previous.value : live,
  }).asReadonly();

  readonly title = computed(() => {
    if (this.newRecoveryKey()) {
      return 'Identity reset';
    }
    return this.identityWithoutRecovery()
      ? 'Reset your identity'
      : 'Verify this device';
  });

  /**
   * The recovery key minted by a reset, shown once. Non-null switches the page to "save
   * this key"; status cannot decide this because the reset leaves the account `ready`.
   */
  readonly newRecoveryKey = signal<string | null>(null);

  /** When true the page is modal content (desktop); else a routed page. */
  readonly asModal = input(false);
  readonly closed = output<void>();

  /**
   * Arrive with the reset already offered, for an entry point whose label promised it
   * (Settings → Security). An input in the modal, `?reset=1` on the routed page.
   */
  readonly offerReset = input(false);

  constructor() {
    // After the view exists, so the confirm dialog has something to sit over. This only
    // opens the gate; the user still has to type the confirmation word.
    afterNextRender(() => {
      const asked =
        this.offerReset() ||
        this.route.snapshot.queryParamMap.get('reset') === '1';
      if (asked) {
        this.resetRecovery();
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
      this.clearKey();
      this.leave();
    });
  }

  /**
   * Throw the account's encryption identity away and build a new one, for someone with no
   * recovery key and no other verified device.
   *
   * Gated on typing the confirmation word: this destroys the account's server-side message
   * backup, and a mis-tap must not reach it.
   */
  resetRecovery(): void {
    confirmResetIntent(this.alert)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((intent) => {
        if (intent === 'cancelled') {
          return;
        }
        if (intent === 'mistyped') {
          this.error.set(RESET_MISTYPED_MESSAGE);
          return;
        }
        this.beginRecoveryReset();
      });
  }

  private beginRecoveryReset(): void {
    // Not runWithBusy: it turns a failure into EMPTY, but this path must inspect WHY it
    // failed.
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
      firstValueFrom(this.crypto.providerResetLink()),
    );
    if (!failure) {
      return;
    }
    // Order matters: providerResetUrl is linked to error and clears when it changes.
    this.error.set(failure.message);
    if (failure.providerUrl) {
      // Also rendered as a link (see providerResetUrl); native has no popup blocker.
      this.providerResetUrl.set(failure.providerUrl);
      this.externalBrowser
        .open(failure.providerUrl)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
  }

  finishReset(): void {
    this.newRecoveryKey.set(null);
    this.leave();
  }

  /**
   * Whether closing right now would throw something away: a running reset cannot be
   * cancelled (unsubscribing does not abort the promise) and its key is shown once. Ask
   * first rather than disabling Close: the desktop dialog opens with `disableClose`, so
   * Close is the only way out.
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
   * Shared by the modal's Close button and the route guard: the browser's back button
   * would otherwise discard a shown-once key silently.
   */
  confirmLeave(): Observable<boolean> {
    return confirmLeaving(this.alert, this.closeWouldDiscard());
  }

  close(): void {
    this.confirmLeave()
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((confirmed) => {
        if (!confirmed) {
          return;
        }
        this.clearKey();
        // The shown-once key is the more sensitive; finishReset() clears it too.
        this.newRecoveryKey.set(null);
        this.leave();
      });
  }

  /**
   * Wipe the entered key. `reset` rather than a bare model write so touched/dirty state
   * goes with it: the key must not outlive its use.
   */
  private clearKey(): void {
    this.unlockForm().reset({ recoveryKey: '' });
  }

  private leave(): void {
    if (this.asModal()) {
      // @Outputs aren't bound on dialog-created components, so close the dialog ourselves;
      // `closed` stays for any @Output-bound host.
      this.closed.emit();
      this.dialogRef?.close();
      return;
    }
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    void this.router.navigateByUrl(resolveInternalReturnTo(returnTo), {
      replaceUrl: true,
    });
  }

  private withBusy<T>(source: Observable<T>): Observable<T> {
    return runWithBusy(source, {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    });
  }
}
