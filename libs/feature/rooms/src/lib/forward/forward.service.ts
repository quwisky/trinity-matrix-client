import { Injectable, inject } from '@angular/core';
import { TrnToastService } from '@trinity/helm/overlay';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';

/**
 * Forwards a message to another conversation: reuses the quick switcher as a room
 * picker, then hands the send to {@link TimelineActionsService.forwardMessage} and
 * toasts the outcome. Space/person/invite picks are ignored — only a room or DM is a
 * valid target.
 *
 * The picker is scoped to the ACTIVE account. Unlike opening a room — which switches to the
 * owning account first — forwarding sends immediately through the active client, so a
 * mixed-in account's room would be a destination the sender isn't a member of (a 403 the
 * user could not explain). Restricting the list is honest; silently sending as the other
 * identity would not be.
 */
@Injectable({ providedIn: 'root' })
export class ForwardService {
  private readonly switcher = inject(QuickSwitcherService);
  private readonly timelineActions = inject(TimelineActionsService);
  private readonly toast = inject(TrnToastService);

  /** Pick a destination room/DM and forward the source room's `eventId` into it. */
  async forward(sourceRoomId: string, eventId: string): Promise<void> {
    const selection = await this.switcher.pick({ activeAccountOnly: true });
    if (!selection || (selection.kind !== 'room' && selection.kind !== 'dm')) {
      return; // cancelled, or a non-room target the switcher also offers
    }
    this.timelineActions
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
