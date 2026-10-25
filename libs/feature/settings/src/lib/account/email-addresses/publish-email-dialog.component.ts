import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  IdentityServerService,
  type IdentityServerRefused,
  type PendingPublish,
  type PublishLinkResult,
  type PublishResult,
} from '@trinity/data-access/contact-addresses';
import {
  EMAIL_ADDRESSES_COPY,
  hostOf,
  identityRefusalMessage,
} from './email-addresses.copy';
import { VerifyLinkStepComponent } from './verify-link-step.component';

/** What the publish dialog closes with once the identity server lists the address. */
export interface PublishEmailClosed {
  readonly kind: 'published';
}

/** Settings › Account › Email addresses: verify an address so an identity server can publish it. */
@Component({
  selector: 'trn-publish-email-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './publish-email-dialog.component.html',
  imports: [
    TrnButton,
    TrnDialogActions,
    TrnDialogShellComponent,
    VerifyLinkStepComponent,
  ],
})
export class PublishEmailDialogComponent implements OnInit {
  private readonly identity = inject(IdentityServerService);
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly waitTimers: ReturnType<typeof setTimeout>[] = [];

  protected readonly copy = EMAIL_ADDRESSES_COPY;

  /** Fixed when the dialog opened, so a later account or server change cannot redirect it. */
  readonly accountId = input.required<string>();
  readonly url = input.required<string>();
  readonly email = input.required<string>();

  protected readonly host = computed(() => hostOf(this.url()));
  protected readonly pending = signal<PendingPublish | null>(null);
  protected readonly stopped = signal('');
  protected readonly notVerified = signal(false);
  protected readonly resent = signal(false);
  protected readonly sentError = signal('');
  protected readonly resendWaitMs = signal(0);
  protected readonly continueWaitMs = signal(0);
  // The first request is the send, so the dialog opens busy.
  protected readonly busy = signal(true);

  constructor() {
    const sent = computed(() => this.pending() !== null);
    effect(() => {
      if (!sent()) return;
      untracked(() => this.focusHeading());
    });
    this.destroyRef.onDestroy(() => this.waitTimers.forEach(clearTimeout));
  }

  ngOnInit(): void {
    this.identity
      .sendPublishLink(this.accountId(), this.url(), this.email())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        this.busy.set(false);
        if (result.kind === 'sent') this.pending.set(result.pending);
        else this.stopped.set(this.message(result));
      });
  }

  /** Escape and the close control are ignored while a request cannot be called back. */
  canDismiss(): boolean {
    return !this.busy();
  }

  close(): void {
    if (this.canDismiss()) this.ref?.close();
  }

  publish(): void {
    const pending = this.pending();
    if (this.busy() || !pending) return;
    this.busy.set(true);
    this.identity
      .publish(pending)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => this.published(result, pending));
  }

  resend(): void {
    const pending = this.pending();
    if (this.busy() || !pending) return;
    this.busy.set(true);
    this.identity
      .resendPublishLink(pending)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => this.resentLink(result));
  }

  private resentLink(result: PublishLinkResult): void {
    this.busy.set(false);
    if (result.kind === 'refused') {
      this.resent.set(false);
      this.sentError.set(this.message(result));
      this.waitOut(this.resendWaitMs, result);
      return;
    }
    this.sentError.set('');
    this.resent.set(true);
    this.notVerified.set(false);
    this.pending.set(result.pending);
  }

  private published(result: PublishResult, pending: PendingPublish): void {
    this.busy.set(false);
    this.resent.set(false);
    this.sentError.set('');
    switch (result.kind) {
      case 'published':
        // With a result, so the dismiss guard that holds it open while busy lets go.
        this.ref?.close({ kind: 'published' } satisfies PublishEmailClosed);
        return;
      case 'not-verified':
        this.notVerified.set(true);
        this.pending.set(result.pending);
        return;
      case 'refused':
        this.notVerified.set(false);
        this.pending.set(pending);
        this.sentError.set(this.message(result));
        this.waitOut(this.continueWaitMs, result);
    }
  }

  private message({ reason, retryAfterMs }: IdentityServerRefused): string {
    return identityRefusalMessage(reason, this.host(), retryAfterMs);
  }

  /** Holds an action off for as long as a rate limit asks. */
  private waitOut(
    wait: WritableSignal<number>,
    { reason, retryAfterMs }: IdentityServerRefused,
  ): void {
    if (reason !== 'rate-limited' || !retryAfterMs) return;
    wait.set(retryAfterMs);
    this.waitTimers.push(setTimeout(() => wait.set(0), retryAfterMs));
  }

  /** The heading takes focus when the link is sent, so the change is announced. */
  private focusHeading(): void {
    afterNextRender(
      () => {
        const heading = this.element.nativeElement.querySelector('h2');
        heading?.setAttribute('tabindex', '-1');
        heading?.focus();
      },
      { injector: this.injector },
    );
  }
}
