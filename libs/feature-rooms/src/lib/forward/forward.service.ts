import { Injectable, inject } from '@angular/core';
import { TrnToastService } from '@trinity/helm/overlay';
import { TimelineService } from '@trinity/data-access-timeline';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';

/**
 * Forwards a message to another conversation: reuses the quick switcher as a room
 * picker, then hands the send to {@link TimelineService.forwardMessage} and toasts the
 * outcome. Space/person/invite picks are ignored — only a room or DM is a valid target.
 */
@Injectable({ providedIn: 'root' })
export class ForwardService {
  private readonly switcher = inject(QuickSwitcherService);
  private readonly timeline = inject(TimelineService);
  private readonly toast = inject(TrnToastService);

  /** Pick a destination room/DM and forward the source room's `eventId` into it. */
  async forward(sourceRoomId: string, eventId: string): Promise<void> {
    const selection = await this.switcher.pick();
    if (!selection || (selection.kind !== 'room' && selection.kind !== 'dm')) {
      return; // cancelled, or a non-room target the switcher also offers
    }
    this.timeline
      .forwardMessage(sourceRoomId, eventId, selection.id)
      .subscribe({
        next: () =>
          this.toast.show('Message forwarded.', {
            duration: 3000,
            variant: 'success',
          }),
        error: () =>
          this.toast.show('Could not forward the message.', {
            duration: 4000,
            variant: 'destructive',
          }),
      });
  }
}
