import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateTimeFormatService } from '@trinity/platform-native';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePinOff, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@trinity/helm/button';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';
import { PinnedMessagesService } from '@trinity/data-access/pinned';

/**
 * Pinned-messages panel: every `m.room.pinned_events` entry for the active room, in
 * pin order, each row showing the sender, a short preview, and the pin timestamp.
 * Reads the live {@link PinnedMessagesService.pinnedMessages} (already projected for
 * the active room by the rooms shell), so it reacts to remote pins/unpins.
 *
 * Presented via {@link PinnedPanelService} as a right-aligned side panel (desktop) /
 * full-screen (mobile) {@link TrnDialogService} dialog — mirroring
 * {@link ThreadsListComponent}. Tapping a row closes the dialog with the chosen event
 * id, and the panel service hands it to the rooms shell to jump the timeline (the
 * same mechanism in-room search uses). Each row also offers an inline Unpin (gated to
 * users who may edit pinned events) that acts in place without closing the panel.
 */
@Component({
  selector: 'trn-pinned-messages-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButton, HlmTooltip],
  viewProviders: [provideIcons({ lucideX, lucidePinOff })],
  templateUrl: './pinned-messages-panel.component.html',
  styleUrl: './pinned-messages-panel.component.scss',
})
export class PinnedMessagesPanelComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  private readonly pinnedSvc = inject(PinnedMessagesService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef =
    inject<DialogRef<string | undefined, PinnedMessagesPanelComponent>>(
      DialogRef,
    );

  /** The active room's pinned messages, in pin order. */
  readonly pinned = this.pinnedSvc.pinnedMessages;
  /** Whether the current user may unpin (room permission). */
  readonly canPin = this.pinnedSvc.canPin;

  /** Close this panel, handing the chosen event id back for a timeline jump. */
  jumpTo(eventId: string): void {
    this.dialogRef.close(eventId);
  }

  /** Unpin a message in place; the live projection drops the row on success. */
  unpin(eventId: string): void {
    this.pinnedSvc
      .unpin(eventId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () =>
          this.toast.show('Could not unpin the message.', {
            duration: 4000,
            variant: 'destructive',
          }),
      });
  }

  /** Close the panel without jumping. */
  close(): void {
    this.dialogRef.close();
  }
}
