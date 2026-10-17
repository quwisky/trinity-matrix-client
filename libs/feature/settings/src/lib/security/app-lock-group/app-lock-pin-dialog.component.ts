import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
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
  TrnPasswordInputComponent,
} from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  APP_LOCK_CLOCK,
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

/** What the PIN dialog closes with: the new PIN (`set`), a verification (`verify`), or nothing. */
export type AppLockPinDialogResult =
  | { readonly kind: 'pin'; readonly pin: string }
  | { readonly kind: 'verified' };

/** Why the last check failed; `retry` adds "Try again", with the wait while one runs. */
interface PinFailure {
  readonly text: string;
  readonly retry: boolean;
}

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
    TrnPasswordInputComponent,
  ],
})
export class AppLockPinDialogComponent {
  private readonly appLock = inject(AppLockService);
  private readonly dialogRef =
    inject<TrnDialogRef<AppLockPinDialogResult>>(TrnDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clock = inject(APP_LOCK_CLOCK);
  private readonly model = signal<PinModel>(EMPTY);
  private readonly failure = signal<PinFailure | null>(null);
  /** The end of the host's wait after wrong PINs, while it runs. */
  private readonly waitUntil = signal<number | null>(null);
  private readonly now = signal(this.clock());
  private readonly pinInput =
    viewChild<ElementRef<HTMLInputElement>>('pinInput');
  private readonly confirmInput =
    viewChild<ElementRef<HTMLInputElement>>('confirmInput');

  protected readonly appName = this.appLock.appName;
  protected readonly suggested = PIN_SUGGESTED_LENGTH;
  protected readonly shownError = shownError;
  protected readonly busy = signal(false);
  protected readonly waiting = computed(() => {
    const until = this.waitUntil();
    return until !== null && this.now() < until;
  });
  /** The last answer from the host, with a live countdown; never contains the PIN. */
  protected readonly message = computed(() => {
    const failure = this.failure();
    if (!failure) return null;
    if (!failure.retry) return failure.text;
    const until = this.waitUntil();
    return until !== null && this.waiting()
      ? `${failure.text} Try again in ${formatRetryWait(Math.max(0, until - this.now()))}.`
      : `${failure.text} Try again.`;
  });
  /** Said once when a check fails and once when its wait ends, never every second. */
  protected readonly announcement = signal('');
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

  constructor() {
    // The countdown ticks only during a wait, and says once when it is over.
    effect((onCleanup) => {
      const until = this.waitUntil();
      if (until === null) return;
      const tick = setInterval(() => {
        const now = this.clock();
        this.now.set(now);
        if (now >= until) {
          this.waitUntil.set(null);
          this.announcement.set('You can try again now.');
        }
      }, 1_000);
      onCleanup(() => clearInterval(tick));
    });
  }

  protected submitPin(): void {
    // The host enforces a wait too; this keeps the PIN from leaving during one.
    if (this.busy() || this.waiting()) return;
    void submit(this.pinForm, async () => {
      const { pin } = this.model();
      // The PIN leaves the form at once; nothing here keeps it after this call.
      this.pinForm().reset(EMPTY);
      this.failure.set(null);
      this.waitUntil.set(null);
      this.announcement.set('');
      if (this.mode() === 'set') {
        this.dialogRef.close({ kind: 'pin', pin });
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
    const unreadable = `${this.appName} can’t read your PIN right now.`;
    switch (outcome.kind) {
      case 'unlocked':
        this.dialogRef.close({ kind: 'verified' });
        return;
      case 'cancelled':
        // A lock came while the PIN was checked: nothing was verified.
        this.dialogRef.close();
        return;
      case 'failed':
        this.fail(
          { text: 'That PIN isn’t right.', retry: true },
          outcome.until,
        );
        return;
      case 'delayed':
        this.fail({ text: 'Too many wrong PINs.', retry: true }, outcome.until);
        return;
      case 'invalid':
        this.fail({ text: DIGITS, retry: false }, null);
        return;
      case 'unavailable':
      case 'use-pin':
        this.fail({ text: unreadable, retry: true }, null);
        return;
      default: {
        const unhandled: never = outcome;
        void unhandled;
        this.fail({ text: unreadable, retry: true }, null);
      }
    }
  }

  /** Say why (once), start any wait, and put focus back in the cleared field. */
  private fail(failure: PinFailure, until: number | null): void {
    this.now.set(this.clock());
    this.failure.set(failure);
    this.waitUntil.set(until !== null && until > this.now() ? until : null);
    this.announcement.set(this.message() ?? '');
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
