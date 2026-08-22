import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateTimeFormatService } from '@trinity/platform-native';
import { HlmButton } from '@trinity/helm/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import { TrnToastService } from '@trinity/components/overlay';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import { TrnIconComponent } from '@trinity/components/icon';

/**
 * Pinned-messages panel: every `m.room.pinned_events` entry for the active room, in
 * pin order, each row showing the sender, a short preview, and the pin timestamp.
 * Reads the live {@link PinnedMessagesService.pinnedMessages} (already projected for
 * the active room by the rooms shell), so it reacts to remote pins/unpins.
 *
 * Presentational: it renders into the rooms shell's right-hand panel slot and owns no
 * panel state of its own — mirroring {@link ThreadsListComponent}. Tapping a row emits
 * {@link selected} with the chosen event id for the host to jump the timeline to (the
 * same mechanism in-room search uses), and the header's close button emits
 * {@link dismissed}. Each row also offers an inline Unpin (gated to users who may edit
 * pinned events) that acts in place and announces nothing, so the panel stays open.
 */
@Component({
  selector: 'trn-pinned-messages-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, HlmButton, TrnTooltip],
  templateUrl: './pinned-messages-panel.component.html',
  styleUrl: './pinned-messages-panel.component.scss',
})
export class PinnedMessagesPanelComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  private readonly pinnedSvc = inject(PinnedMessagesService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The active room's pinned messages, in pin order. */
  readonly pinned = this.pinnedSvc.pinnedMessages;
  /** Whether the current user may unpin (room permission). */
  readonly canPin = this.pinnedSvc.canPin;

  /** The user picked a pinned message: its event id, for the host to jump to. */
  readonly selected = output<string>();
  /** The user closed the panel without picking a pinned message. */
  readonly dismissed = output<void>();

  /** Row tap: announce the chosen event id for a timeline jump. */
  jumpTo(eventId: string): void {
    this.selected.emit(eventId);
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

  /** Close button: announce the close without a jump. */
  close(): void {
    this.dismissed.emit();
  }
}
