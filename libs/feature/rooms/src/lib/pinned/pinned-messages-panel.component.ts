import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  output,
} from '@angular/core';
import { SidePanelHeaderComponent } from '../side-panel/side-panel-header.component';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DateTimeFormatService } from '@trinity/platform-native';
import { TrnButton } from '@trinity/components/controls';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnTooltip } from '@trinity/components/generic-content';
import {
  TrnOverlaySurfaceDirective,
  TrnToastService,
  releaseInputTargetOnDestroy,
} from '@trinity/components/overlay';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { TrnIconComponent } from '@trinity/components/foundations';
import { UnencryptedMarkComponent } from '../shared/unencrypted-mark/unencrypted-mark.component';

/**
 * Pinned-messages panel: every `m.room.pinned_events` entry for the active room, in pin
 * order, each row showing the sender, a short preview and the pin timestamp. Reads the live
 * pinned-message projection from Conversation Runtime, so it reacts to remote pins/unpins.
 *
 * Presentational, like {@link ThreadsListComponent}: it owns no panel state. A row tap emits
 * {@link selected} (the event id, for the host to jump to) and the close button emits
 * {@link dismissed}. Each row's inline Unpin (gated to users who may edit pinned events)
 * acts in place and announces nothing, so the panel stays open.
 */
@Component({
  selector: 'trn-pinned-messages-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    UnencryptedMarkComponent,
    SidePanelHeaderComponent,
    EmptyStateComponent,
    TrnIconComponent,
    TrnButton,
    TrnTooltip,
    TrnOverlaySurfaceDirective,
  ],
  templateUrl: './pinned-messages-panel.component.html',
  styleUrl: './pinned-messages-panel.component.scss',
})
export class PinnedMessagesPanelComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  private readonly pins = inject(ConversationRuntime).pins;
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly pinned = this.pins.messages;
  readonly canPin = this.pins.canMutate;

  /** The user picked a pinned message: its event id, for the host to jump to. */
  readonly selected = output<string>();
  /** The user closed the panel without picking a pinned message. */
  readonly dismissed = output<void>();

  constructor() {
    // Reopening the panel retries pins whose fetch failed.
    this.pins.retryFailed();
    // Closed or replaced after a press or key inside it, the panel would otherwise stay in
    // memory, detached, as the CDK's last input target until the next one.
    releaseInputTargetOnDestroy();
  }

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
      variant: 'danger',
    });
  }

  close(): void {
    this.dismissed.emit();
  }
}
