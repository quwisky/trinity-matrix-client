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
import type { Subscription } from 'rxjs';
import {
  QR_SIGN_IN_FAILURE_MESSAGES,
  QrSignInService,
  type NewDeviceState,
  type QrSignInFailure,
} from '@trinity/data-access/auth';
import { QrCodeService } from '@trinity/platform-native';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';

/** Failures a new code cannot fix; "Sign in another way" is their next action. */
const FINAL_FAILURES: ReadonlySet<QrSignInFailure> = new Set([
  'unsupported',
  'already-signed-in',
]);

/** The new device's side of a QR sign-in: shows the code, then follows the other device. */
@Component({
  selector: 'trn-qr-sign-in-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'qr-sign-in-panel.component.html',
  styleUrl: 'qr-sign-in-panel.component.scss',
  imports: [DatePipe, TrnButton, TrnSpinnerComponent],
  host: { '(keydown.escape)': 'leave()' },
})
export class QrSignInPanelComponent implements OnInit {
  private readonly qrSignIn = inject(QrSignInService);
  private readonly qrCode = inject(QrCodeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly stepHeading =
    viewChild<ElementRef<HTMLElement>>('stepHeading');
  private flow: Subscription | null = null;
  /** Counts flows, so a QR code rendered for an abandoned flow is dropped. */
  private attempt = 0;

  readonly homeserverUrl = input.required<string>();
  readonly signedIn = output<{ verified: boolean }>();
  readonly back = output<void>();

  readonly state = signal<NewDeviceState>({ kind: 'creating' });
  readonly qrUrl = signal<string | null>(null);
  /** Kept through `waiting-for-approval`, which carries no check code of its own. */
  readonly checkCode = signal<string | null>(null);
  /** The heading on screen; the check code and the wait for approval share one. */
  readonly step = computed(() => {
    const kind = this.state().kind;
    return kind === 'confirm-check-code' || kind === 'waiting-for-approval'
      ? 'check'
      : kind;
  });
  readonly spokenCheckCode = computed(() =>
    (this.checkCode() ?? '').split('').join(' '),
  );
  /** What the live region says; written after each render, never on insertion. */
  readonly announcement = signal('');
  readonly failureMessages = QR_SIGN_IN_FAILURE_MESSAGES;
  readonly finalFailures = FINAL_FAILURES;

  constructor() {
    effect(() => {
      this.step();
      afterNextRender(() => this.stepHeading()?.nativeElement.focus(), {
        injector: this.injector,
      });
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
    this.checkCode.set(null);
    this.flow = this.qrSignIn
      .signInByShowingCode(this.homeserverUrl())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (state) => this.apply(state),
        error: () => this.state.set({ kind: 'failed', reason: 'unknown' }),
      });
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
      case 'confirm-check-code':
        return `Check code: ${this.spokenCheckCode()}`;
      case 'waiting-for-approval':
        return `Check code: ${this.spokenCheckCode()}. Then approve the sign-in on your other device.`;
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
    } else if (state.kind === 'confirm-check-code') {
      this.checkCode.set(state.code);
    } else if (state.kind === 'done') {
      this.signedIn.emit({ verified: state.verified });
    }
  }
}
