import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AppearanceEffects } from '@trinity/application/appearance';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { CallRingService, CallService } from '@trinity/data-access/calls';
import { RingToneService } from './ring-tone.service';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

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
      if (this.ring()) this.tone.start();
      else this.tone.stop();
    });
    this.destroyRef.onDestroy(() => this.tone.stop());
    effect(() => {
      const join = this.join()?.nativeElement;
      const focused = this.document.activeElement;
      if (join && !focused?.closest('[role="dialog"], [role="alertdialog"]')) {
        join.focus();
      }
    });
  }

  protected accept(): void {
    const ring = this.ring();
    if (!ring) return;
    this.ringService.dismiss();
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
        if (outcome.kind !== 'ready') return;
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
