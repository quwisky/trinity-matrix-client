import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormField, disabled, form } from '@angular/forms/signals';
import { TrustOperationError, TrustService } from '@trinity/data-access/trust';
import {
  TrnButton,
  TrnFieldImports,
  TrnInput,
} from '@trinity/components/controls';
import {
  TrnFieldLockComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import { runWithBusy } from '@trinity/util/ui';

/**
 * This device is already verified here, so the unlock screen's advice to verify it is wrong.
 * True both when recovery lacks the keys and when the account has no recovery at all.
 */
const NO_KEYS_IN_RECOVERY =
  'This account’s recovery can’t give a new device the keys it needs. Link the new device from the device where you set up encryption instead.';

/**
 * Before linking: this device is verified but lacks a private cross-signing key a new device
 * needs, typically the master key, which emoji verification does not hand over. The recovery
 * key fetches all three from secret storage; without one, it says where to link from.
 */
@Component({
  selector: 'trn-link-device-keys',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './link-device-keys.component.html',
  imports: [
    FormField,
    TrnButton,
    TrnFieldImports,
    TrnInput,
    TrnFieldLockComponent,
    TrnSpinnerComponent,
  ],
  host: { class: 'block py-3', '(keydown.escape)': 'cancel()' },
})
export class LinkDeviceKeysComponent {
  private readonly trust = inject(TrustService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly keyModel = signal({ recoveryKey: '' });

  /** The account has a recovery key that can unlock its secret storage. */
  readonly hasRecovery = input.required<boolean>();
  /** The keys are on this device now; the owner opens the scanner. */
  readonly unlocked = output<void>();
  readonly cancelled = output<void>();

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly keyForm = form(this.keyModel, (path) => {
    disabled(path.recoveryKey, {
      when: () => this.busy() && 'Wait for this step to finish',
    });
  });
  readonly hasKey = computed(
    () => this.keyModel().recoveryKey.trim().length > 0,
  );

  constructor() {
    afterNextRender(() => this.heading().nativeElement.focus());
  }

  /** Escape matches the Cancel button, which a recovery in flight disables. */
  cancel(): void {
    if (!this.busy()) {
      this.cancelled.emit();
    }
  }

  submit(): void {
    const key = this.keyModel().recoveryKey.trim();
    if (!key || this.busy()) {
      return;
    }
    runWithBusy(
      this.trust.recoverWithKey(key),
      { busy: this.busy, error: this.error, destroyRef: this.destroyRef },
      {
        formatError: (error) =>
          error instanceof TrustOperationError &&
          error.kind === 'recovery-not-configured'
            ? NO_KEYS_IN_RECOVERY
            : error instanceof Error
              ? error.message
              : String(error),
      },
    ).subscribe(() => {
      this.keyModel.set({ recoveryKey: '' });
      this.unlocked.emit();
    });
  }
}
