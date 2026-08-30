import { Injectable, inject } from '@angular/core';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import { RoomModerationService } from '@trinity/data-access/room-administration';

/**
 * Reports a message to the room's server administrators: prompts for a reason, hands
 * the send to {@link RoomModerationService.reportMessage}, and toasts the outcome.
 * Available on any message (it needs no room-admin rights).
 */
@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly moderation = inject(RoomModerationService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);

  /** Prompt for a reason and report `eventId` in `roomId` to the server admins. */
  async report(roomId: string, eventId: string): Promise<void> {
    if (!roomId || !eventId) {
      return;
    }
    const reason = await this.alert.prompt({
      header: 'Report message',
      message: 'Report this message to the room’s server administrators?',
      confirmText: 'Report',
      destructive: true,
      placeholder: 'Reason (optional)',
    });
    if (reason === null) {
      return; // cancelled
    }
    this.moderation.reportMessage(roomId, eventId, reason).subscribe({
      next: () =>
        this.toast.show('Reported to the server admins.', { duration: 3000 }),
      error: () =>
        this.toast.show('Could not report the message.', {
          duration: 4000,
          variant: 'destructive',
        }),
    });
  }
}
