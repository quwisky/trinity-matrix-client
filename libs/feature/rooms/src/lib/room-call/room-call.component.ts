import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import {
  BannerComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import { CallService } from '@trinity/data-access/calls';
import { RoomShellNavigationService } from '../rooms/room-shell-navigation.service';

/**
 * The active call's Element Call frame. Expanded it fills the conversation area; collapsed
 * it shows a bar, and the frame keeps running off-screen: moving or re-creating the iframe
 * would reload Element Call and drop the call.
 */
@Component({
  selector: 'trn-room-call',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, TrnButton, TrnIconComponent, TrnSpinnerComponent],
  host: {
    class: 'room-call',
    '[class.room-call--expanded]': 'expanded()',
  },
  templateUrl: './room-call.component.html',
  styleUrl: './room-call.component.scss',
})
export class RoomCallComponent {
  private readonly calls = inject(CallService);
  private readonly nav = inject(RoomShellNavigationService);
  private readonly frame =
    viewChild.required<ElementRef<HTMLIFrameElement>>('callFrame');

  /** Whether the call's room is the one on screen. */
  readonly expanded = input(false);

  protected readonly call = this.calls.activeCall;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() =>
      this.calls
        .attach(this.frame().nativeElement)
        .pipe(takeUntilDestroyed(destroyRef))
        .subscribe(),
    );
  }

  protected returnToCall(): void {
    const call = this.call();
    if (call) {
      this.nav.onSelectRoom({ roomId: call.roomId, accountId: call.accountId });
    }
  }

  protected hangUp(): void {
    this.calls.hangUp();
  }
}
