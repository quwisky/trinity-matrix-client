import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  form,
  maxLength,
  pattern,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import {
  TrnButton,
  TrnFieldImports,
  TrnInput,
} from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  AppLockService,
  PIN_MAX_LENGTH,
  PIN_PATTERN,
  PIN_SUGGESTED_LENGTH,
  formatRetryWait,
  type UnlockOutcome,
} from '@trinity/data-access/app-lock';
import { shownError } from '@trinity/util/ui';
import { take } from 'rxjs';

interface PinModel {
  pin: string;
  confirmPin: string;
}

/** What the PIN dialog closes with: the new PIN (`set`), `'verified'` (`verify`) or nothing. */
export type AppLockPinDialogResult = string;

const DIGITS = 'Enter 4 to 16 digits.';
const EMPTY: PinModel = { pin: '', confirmPin: '' };

/**
 * Sets a new PIN (asked twice, with the warning decision 11 requires), or confirms the
 * current one for a guarded change. The PIN leaves this dialog only through `close()` (set)
 * or `verifyPinForChange` (verify); the fields are cleared as it leaves, and nothing logs or
 * shows it.
 */
@Component({
  selector: 'trn-app-lock-pin-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-pin-dialog.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnFieldImports,
    TrnInput,
  ],
})
export class AppLockPinDialogComponent {
  private readonly appLock = inject(AppLockService);
  private readonly dialogRef =
    inject<TrnDialogRef<AppLockPinDialogResult>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly model = signal<PinModel>(EMPTY);
  private readonly pinInput =
    viewChild<ElementRef<HTMLInputElement>>('pinInput');
  private readonly confirmInput =
    viewChild<ElementRef<HTMLInputElement>>('confirmInput');

  protected readonly appName = this.appLock.appName;
  protected readonly suggested = PIN_SUGGESTED_LENGTH;
  protected readonly shownError = shownError;
  protected readonly busy = signal(false);
  /** The last answer from the host, announced; never contains the PIN. */
  protected readonly message = signal<string | null>(null);
  protected readonly title = computed(() =>
    this.mode() === 'set'
      ? `Set a ${this.appName} PIN`
      : `Enter your ${this.appName} PIN`,
  );
  protected readonly pinForm = form(this.model, (path) => {
    required(path.pin, {
      message: () =>
        this.mode() === 'set' ? DIGITS : `Enter your ${this.appName} PIN.`,
    });
    pattern(path.pin, PIN_PATTERN, { message: DIGITS });
    // Also the fields' `maxlength`: Signal Forms owns that attribute.
    maxLength(path.pin, PIN_MAX_LENGTH, { message: DIGITS });
    maxLength(path.confirmPin, PIN_MAX_LENGTH, {
      message: 'The PINs don’t match.',
    });
    validate(path.confirmPin, ({ value, valueOf }) =>
      this.mode() === 'set' && value() !== valueOf(path.pin)
        ? { kind: 'pinMismatch', message: 'The PINs don’t match.' }
        : undefined,
    );
  });

  readonly mode = input<'set' | 'verify'>('set');
  /**
   * Everything the system prompt accepts ("Face ID or your device passcode"), for the
   * forgotten-PIN warning; null where there is no system prompt.
   */
  readonly methodName = input<string | null>(null);

  protected submitPin(): void {
    if (this.busy()) return;
    void submit(this.pinForm, async () => {
      const { pin } = this.model();
      // The PIN leaves the form at once; nothing here keeps it after this call.
      this.pinForm().reset(EMPTY);
      this.message.set(null);
      if (this.mode() === 'set') {
        this.dialogRef.close(pin);
        return;
      }
      this.busy.set(true);
      this.appLock
        .verifyPinForChange(pin)
        .pipe(take(1), takeUntilDestroyed(this.destroyRef))
        .subscribe((outcome) => {
          this.busy.set(false);
          this.present(outcome);
        });
    });
    this.focusFirstInvalid();
  }

  protected cancel(): void {
    this.dialogRef.close();
  }

  private present(outcome: UnlockOutcome): void {
    switch (outcome.kind) {
      case 'unlocked':
        this.dialogRef.close('verified');
        return;
      case 'cancelled':
        // A lock came while the PIN was checked: nothing was verified.
        this.dialogRef.close();
        return;
      case 'failed':
        this.fail(
          outcome.until === null
            ? 'That PIN isn’t right. Try again.'
            : `That PIN isn’t right. Try again in ${this.waitFor(outcome.until)}.`,
        );
        return;
      case 'delayed':
        this.fail(
          `Too many wrong PINs. Try again in ${this.waitFor(outcome.until)}.`,
        );
        return;
      case 'invalid':
        this.fail(DIGITS);
        return;
      case 'unavailable':
      case 'use-pin':
        this.fail(`${this.appName} can’t read your PIN right now. Try again.`);
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
        this.fail(`${this.appName} can’t read your PIN right now. Try again.`);
      }
    }
  }

  private waitFor(until: number): string {
    return formatRetryWait(until - Date.now());
  }

  /** Say why, and put focus back in the (cleared) field for the next try. */
  private fail(message: string): void {
    this.message.set(message);
    this.pinInput()?.nativeElement.focus();
  }

  private focusFirstInvalid(): void {
    const form = this.pinForm;
    if (form.pin().invalid()) this.pinInput()?.nativeElement.focus();
    else if (form.confirmPin().invalid()) {
      this.confirmInput()?.nativeElement.focus();
    }
  }
}
