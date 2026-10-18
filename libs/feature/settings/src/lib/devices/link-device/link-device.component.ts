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
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import {
  QR_SIGN_IN_FAILURE_MESSAGES,
  QrSignInService,
  type ExistingDeviceLink,
  type ExistingDeviceState,
} from '@trinity/data-access/auth';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { QrScannerComponent, TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { ExternalBrowserService } from '@trinity/platform-native';

type LinkState = { kind: 'scanning' } | ExistingDeviceState;

/** The existing device's side of a QR sign-in: scans the new device's code and links it. */
@Component({
  selector: 'trn-link-device',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: 'link-device.component.html',
  styleUrl: 'link-device.component.scss',
  imports: [QrScannerComponent, TrnButton, TrnSpinnerComponent],
  host: { '(keydown.escape)': 'close()' },
})
export class LinkDeviceComponent {
  private readonly qrSignIn = inject(QrSignInService);
  private readonly matrix = inject(MatrixClientService);
  private readonly browser = inject(ExternalBrowserService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly stepHeading =
    viewChild<ElementRef<HTMLElement>>('stepHeading');
  private link: ExistingDeviceLink | null = null;
  private flow: Subscription | null = null;

  /** The flow ended or was cancelled; the owner removes this panel. */
  readonly closed = output<void>();

  readonly state = signal<LinkState>({ kind: 'scanning' });
  /** Shown above the scanner after a code that is not a sign-in code. */
  readonly notice = signal<string | null>(null);
  readonly checkCode = signal<string | null>(null);
  /** Kept through `sharing-secrets`, which follows `approve-in-browser` at once. */
  readonly verificationUri = signal<string | null>(null);
  /** The heading on screen; approval and sharing share one, so focus stays put. */
  readonly step = computed(() => {
    const kind = this.state().kind;
    return kind === 'sharing-secrets' ? 'approve-in-browser' : kind;
  });
  readonly spokenCheckCode = computed(() =>
    (this.checkCode() ?? '').split('').join(' '),
  );
  /** What the live region says; written after each render, never on insertion. */
  readonly announcement = signal('');
  readonly failureMessages = QR_SIGN_IN_FAILURE_MESSAGES;

  constructor() {
    effect(() => {
      this.step();
      afterNextRender(() => this.stepHeading()?.nativeElement.focus(), {
        injector: this.injector,
      });
    });
    effect(() => {
      const text = this.announcementFor(this.state(), this.notice());
      afterNextRender(() => this.announcement.set(text), {
        injector: this.injector,
      });
    });
  }

  scan(data: Uint8ClampedArray): void {
    this.flow?.unsubscribe();
    this.notice.set(null);
    const link = this.qrSignIn.linkByScanning(
      this.matrix.instance,
      new Uint8Array(data),
    );
    this.link = link;
    this.flow = link.state$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (state) => this.apply(state),
        error: () => this.state.set({ kind: 'failed', reason: 'unknown' }),
      });
  }

  confirmCheckCode(match: boolean): void {
    this.link?.confirmCheckCode(match);
  }

  openApprovalPage(): void {
    const url = this.verificationUri();
    if (url) {
      this.browser
        .open(url)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
  }

  /** Cancel any link in progress and start over at the scanner. */
  scanAgain(): void {
    this.flow?.unsubscribe();
    this.reset();
  }

  /** Cancel any link in progress (declining it at the check code) and close. */
  close(): void {
    this.flow?.unsubscribe();
    this.closed.emit();
  }

  private apply(state: ExistingDeviceState): void {
    if (state.kind === 'not-sign-in-code') {
      this.reset();
      this.notice.set("That's not a Trinity sign-in code");
      return;
    }
    if (state.kind === 'confirm-check-code') this.checkCode.set(state.code);
    if (state.kind === 'approve-in-browser') {
      this.verificationUri.set(state.verificationUri);
    }
    this.state.set(state);
  }

  private reset(): void {
    this.link = null;
    this.checkCode.set(null);
    this.verificationUri.set(null);
    this.notice.set(null);
    this.state.set({ kind: 'scanning' });
  }

  private announcementFor(state: LinkState, notice: string | null): string {
    switch (state.kind) {
      case 'scanning':
        // The scanner announces its own status.
        return notice ?? '';
      case 'connecting':
      case 'not-sign-in-code':
        return 'Connecting to your new device…';
      case 'confirm-check-code':
        return `Check code: ${this.spokenCheckCode()}`;
      case 'approve-in-browser':
      case 'sharing-secrets':
        return 'Open the approval page and approve the sign-in.';
      case 'done':
        return 'Device linked.';
      case 'failed':
        // The failure's own alert speaks for it.
        return '';
    }
  }
}
