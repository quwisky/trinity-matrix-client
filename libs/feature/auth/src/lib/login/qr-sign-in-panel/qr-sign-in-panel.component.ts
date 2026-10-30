import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  type OnInit,
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
} from '@angular/forms/signals';
import type { Subscription } from 'rxjs';
import {
  QR_SIGN_IN_FAILURE_MESSAGES,
  QrSignInService,
  type NewDeviceQrSignIn,
  type NewDeviceState,
  type QrSignInFailure,
} from '@trinity/data-access/auth';
import { QrCodeService } from '@trinity/platform-native';
import {
  TrnButton,
  TrnFieldImports,
  TrnInput,
} from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { shownError } from '@trinity/util/ui';

/** Failures a new code cannot fix; "Sign in another way" is their next action. */
const FINAL_FAILURES: ReadonlySet<QrSignInFailure> = new Set([
  'unsupported',
  'already-signed-in',
  'other-server',
]);

const TWO_DIGITS = 'Enter the two digits.';
const APPROVE_HINT = 'Approve the sign-in on your other device.';
const WRONG_CODE =
  "That isn't the code your other device shows, so nothing was shared. Show a new code and try again.";

/** The new device's side of a QR sign-in: shows the code, then follows the other device. */
@Component({
  selector: 'trn-qr-sign-in-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'qr-sign-in-panel.component.html',
  styleUrl: 'qr-sign-in-panel.component.scss',
  imports: [
    DatePipe,
    FormField,
    FormRoot,
    TrnButton,
    TrnFieldImports,
    TrnInput,
    TrnSpinnerComponent,
  ],
  host: { '(keydown.escape)': 'onEscape($event)' },
})
export class QrSignInPanelComponent implements OnInit {
  private readonly qrSignIn = inject(QrSignInService);
  private readonly qrCode = inject(QrCodeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly stepHeading =
    viewChild<ElementRef<HTMLElement>>('stepHeading');
  private readonly codeInput =
    viewChild<ElementRef<HTMLInputElement>>('codeInput');
  private readonly codeModel = signal({ code: '' });
  /** Whether a code was typed in this flow, the only way it can be the wrong one. */
  private readonly codeEntered = signal(false);
  private signIn: NewDeviceQrSignIn | null = null;
  private flow: Subscription | null = null;
  /** Counts flows, so a QR code rendered for an abandoned flow is dropped. */
  private attempt = 0;

  protected readonly shownError = shownError;
  protected readonly codeForm = form(this.codeModel, (path) => {
    required(path.code, { message: TWO_DIGITS });
    pattern(path.code, /^\d{2}$/, { message: TWO_DIGITS });
    // Also the field's `maxlength`: Signal Forms owns that attribute.
    maxLength(path.code, 2, { message: TWO_DIGITS });
  });

  readonly homeserverUrl = input.required<string>();
  /** The server entered; the account the other device signs in must belong to it. */
  readonly serverName = input.required<string>();

  readonly signedIn = output<void>();
  readonly back = output<void>();

  readonly state = signal<NewDeviceState>({ kind: 'creating' });
  readonly qrUrl = signal<string | null>(null);
  /** The step on screen; a new state of the same step keeps focus where it is. */
  readonly step = computed(() => this.state().kind);
  /** What the live region says; written after each render, never on insertion. */
  readonly announcement = signal('');
  readonly failureMessages = {
    ...QR_SIGN_IN_FAILURE_MESSAGES,
    // Here it is this device that already holds the account.
    'already-signed-in': 'This account is already signed in on this device.',
  };
  readonly failureMessage = computed(() => {
    const state = this.state();
    if (state.kind !== 'failed') return '';
    return state.reason === 'insecure' && this.codeEntered()
      ? WRONG_CODE
      : this.failureMessages[state.reason];
  });
  readonly approveHint = APPROVE_HINT;
  readonly finalFailures = FINAL_FAILURES;

  constructor() {
    effect(() => {
      const step = this.step();
      afterNextRender(
        () =>
          (step === 'enter-check-code'
            ? this.codeInput()
            : this.stepHeading()
          )?.nativeElement.focus(),
        { injector: this.injector },
      );
    });
    effect(() => {
      const text = this.announcementFor(this.state());
      afterNextRender(() => this.announcement.set(text), {
        injector: this.injector,
      });
    });
  }

  ngOnInit(): void {
    this.start();
  }

  /** Start a new flow, which shows a new code; the previous one is cancelled. */
  start(): void {
    this.flow?.unsubscribe();
    this.attempt++;
    this.state.set({ kind: 'creating' });
    this.qrUrl.set(null);
    this.codeForm().reset({ code: '' });
    this.codeEntered.set(false);
    const signIn = this.qrSignIn.signInByShowingCode(
      this.homeserverUrl(),
      this.serverName(),
    );
    this.signIn = signIn;
    this.flow = signIn.state$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (state) => this.apply(state),
        error: () => this.state.set({ kind: 'failed', reason: 'unknown' }),
      });
  }

  protected enterCode(): void {
    void submit(this.codeForm, async () => {
      this.codeEntered.set(true);
      this.signIn?.enterCheckCode(this.codeModel().code);
    });
    if (this.codeForm.code().invalid()) {
      this.codeInput()?.nativeElement.focus();
    }
  }

  /** Escape belongs to this panel, so nothing around it acts on it too. */
  onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.leave();
  }

  /** Cancel the sign-in and return to the other ways to sign in. */
  leave(): void {
    this.flow?.unsubscribe();
    this.back.emit();
  }

  private announcementFor(state: NewDeviceState): string {
    switch (state.kind) {
      case 'creating':
        return 'Creating a code…';
      case 'showing-code':
        return 'Your sign-in code is ready to scan.';
      case 'enter-check-code':
        return 'Enter the code your other device shows.';
      case 'waiting-for-approval':
        return `Waiting for approval. ${APPROVE_HINT} If it asks for a code, enter ${state.userCode}.`;
      case 'signing-in':
        return 'Signing in…';
      case 'done':
        return 'Signed in.';
      case 'failed':
        // The failure's own alert speaks for it.
        return '';
    }
  }

  private apply(state: NewDeviceState): void {
    this.state.set(state);
    if (state.kind === 'showing-code') {
      const attempt = this.attempt;
      this.qrCode
        .createDataUrl(new Uint8ClampedArray(state.qr))
        .then((url) => {
          if (attempt === this.attempt) this.qrUrl.set(url);
        })
        .catch(() => {
          if (attempt === this.attempt) {
            this.flow?.unsubscribe();
            this.state.set({ kind: 'failed', reason: 'unknown' });
          }
        });
    } else if (state.kind === 'done') {
      this.signedIn.emit();
    }
  }
}
