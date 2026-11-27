import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AppearanceEffects } from '@trinity/application/appearance';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrnToastService } from '@trinity/components/overlay';
import { CallRingService, CallService } from '@trinity/data-access/calls';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RingToneService } from './ring-tone.service';

/** The prompt and ring tone for a call coming in on any signed-in account. */
@Component({
  selector: 'trn-call-ring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  templateUrl: './call-ring.component.html',
})
export class CallRingComponent {
  private readonly ringService = inject(CallRingService);
  private readonly calls = inject(CallService);
  private readonly tone = inject(RingToneService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly clients = inject(MatrixClientService);
  private readonly identities = inject(AccountIdentitiesService);
  private readonly document = inject(DOCUMENT);
  private readonly toasts = inject(TrnToastService);
  private readonly appearance = inject(AppearanceEffects);
  private readonly destroyRef = inject(DestroyRef);
  private readonly join = viewChild<ElementRef<HTMLButtonElement>>('join');

  protected readonly ring = this.ringService.incomingRing;

  protected readonly kind = computed(() => {
    const video = this.ring()?.video;
    return video === null
      ? 'Incoming call'
      : video
        ? 'Incoming video call'
        : 'Incoming voice call';
  });

  /** Named only when it can be ambiguous. */
  protected readonly calledAccount = computed(() => {
    const ring = this.ring();
    if (!ring || this.clients.accountIds().length < 2) return null;
    return (
      this.identities.identities().get(ring.accountId)?.displayName ??
      ring.accountId
    );
  });

  constructor() {
    effect(() => {
      // Untracked: start() reads the sound preference, which must not restart the tone.
      const accountId = this.ring()?.accountId;
      // Stops first: a ring for an account with sound off must silence a tone already playing.
      untracked(() => {
        this.tone.stop();
        if (accountId) this.tone.start(accountId);
      });
    });
    this.destroyRef.onDestroy(() => this.tone.stop());
    effect(() => {
      const join = this.join()?.nativeElement;
      const focused = this.document.activeElement;
      // Never steals focus from the composer or any other element.
      if (join && (!focused || focused === this.document.body)) join.focus();
    });
    effect(() => {
      const ring = this.ring();
      // The prompt lives inside the app root, which a modal hides from assistive tech.
      if (ring) {
        this.toasts.announceWhileAppHidden(
          `${ring.callerName} is calling`,
          'assertive',
        );
      }
    });
  }

  protected accept(): void {
    const ring = this.ring();
    if (!ring) return;
    // Navigating to another account's room switches to that account first.
    this.workspace
      .navigate({
        kind: 'room',
        accountId: ring.accountId,
        roomId: ring.roomId,
        origin: 'room-action',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        // Anything else leaves the ring showing, so the user can retry or decline.
        if (outcome.kind !== 'ready') return;
        this.ringService.dismiss();
        this.calls.start(ring.roomId, {
          video: ring.video ?? true,
          dm: true,
          theme: this.appearance.resolved()?.mode === 'dark' ? 'dark' : 'light',
          roomName: ring.callerName,
        });
      });
  }

  protected decline(): void {
    this.ringService.decline();
  }
}
