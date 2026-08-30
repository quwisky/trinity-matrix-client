import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateTimeFormatService } from '@trinity/platform-native';
import { TrnButton } from '@trinity/components/controls';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnTooltip } from '@trinity/components/generic-content';
import { TrnToastService } from '@trinity/components/overlay';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * Pinned-messages panel: every `m.room.pinned_events` entry for the active room, in
 * pin order, each row showing the sender, a short preview, and the pin timestamp.
 * Reads the live pinned-message projection from Conversation Runtime, so it reacts
 * to remote pins/unpins for the exact Account-and-Room handle.
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
  imports: [EmptyStateComponent, TrnIconComponent, TrnButton, TrnTooltip],
  templateUrl: './pinned-messages-panel.component.html',
  styleUrl: './pinned-messages-panel.component.scss',
})
export class PinnedMessagesPanelComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  private readonly pins = inject(ConversationRuntime).pins;
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The active room's pinned messages, in pin order. */
  readonly pinned = this.pins.messages;
  /** Whether the current user may unpin (room permission). */
  readonly canPin = this.pins.canMutate;

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
    this.pins
      .unpin(eventId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind === 'rejected') {
            this.showFailure();
          }
        },
        error: () => this.showFailure(),
      });
  }

  private showFailure(): void {
    this.toast.show('Could not unpin the message.', {
      duration: 4000,
      variant: 'destructive',
    });
  }

  /** Close button: announce the close without a jump. */
  close(): void {
    this.dismissed.emit();
  }
}
