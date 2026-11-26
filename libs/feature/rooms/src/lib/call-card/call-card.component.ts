import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnTooltip } from '@trinity/components/generic-content';
import { CallService, CallStageService } from '@trinity/data-access/calls';
import { BELOW_MD_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import { RoomShellNavigationService } from '../rooms/room-shell-navigation.service';

/**
 * The docked call above the account panel. Its video box is empty: the app-level call host lays
 * the call's frame over it, so the frame takes clicks there.
 */
@Component({
  selector: 'trn-call-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent, TrnTooltip],
  templateUrl: './call-card.component.html',
  styleUrl: './call-card.component.scss',
})
export class CallCardComponent {
  private readonly calls = inject(CallService);
  private readonly stage = inject(CallStageService);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly video = viewChild<ElementRef<HTMLElement>>('videoSlot');
  private readonly belowMd = mediaQuerySignal(BELOW_MD_QUERY, this.destroyRef);

  protected readonly call = this.calls.activeCall;
  protected readonly elapsed = toSignal(this.calls.elapsed(), {
    initialValue: '',
  });
  protected readonly participants = toSignal(
    this.calls.activeCallParticipants(),
    { initialValue: 0 },
  );
  protected readonly meta = computed(() => {
    const elapsed = this.elapsed();
    return ` · ${this.participants()}${elapsed ? ` · ${elapsed}` : ''}`;
  });
  protected readonly videoShown = computed(() => {
    const id = this.call()?.id;
    const choice = id === undefined ? null : this.stage.videoChoice(id);
    return choice ?? !this.belowMd();
  });

  /** The card's height plus its gap to the account panel, for the scrollers it covers. */
  readonly heightChange = output<number>();

  protected toggleVideo(): void {
    const id = this.call()?.id;
    if (id !== undefined) this.stage.setVideoChoice(id, !this.videoShown());
  }

  constructor() {
    this.destroyRef.onDestroy(this.stage.claimDock());
    effect((onCleanup) => {
      const slot = this.video()?.nativeElement;
      if (slot) onCleanup(this.stage.registerDock(slot));
    });
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize;
      if (size !== undefined) this.heightChange.emit(size);
    });
    observer.observe(this.host.nativeElement, { box: 'border-box' });
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  protected returnToCall(): void {
    const call = this.call();
    if (call)
      this.nav.onSelectRoom({ roomId: call.roomId, accountId: call.accountId });
  }

  protected hangUp(): void {
    this.calls.hangUp();
  }
}
