import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnDialogRef } from '@trinity/components/overlay';
import { DateTimeFormatService } from '@trinity/platform-native';
import { AvatarComponent } from '@trinity/ui';
import { HlmButton } from '@trinity/helm/button';
import { TrnTooltip } from '@trinity/components/tooltip';
import { TrnIconComponent } from '@trinity/components/icon';
import {
  ThreadsService,
  type ThreadSummary,
} from '@trinity/data-access/timeline';

/** Most participant avatars shown per row before the "+N" overflow chip. */
const MAX_AVATARS = 4;

/**
 * Threads-list panel: every thread in the active room, newest activity first,
 * each row showing the root preview, reply count, last-activity time, a
 * participant avatar cluster, and an unread badge. Reads the live
 * {@link ThreadsService.threadList} (already projected for the active room by the
 * rooms shell), so it reacts to new threads, replies, and unread changes.
 *
 * Presented via {@link ThreadPanelService} as a right-aligned side panel (desktop) /
 * full-screen (mobile) {@link TrnDialogService} dialog; `roomId` arrives as a signal
 * input. Tapping a row closes this dialog with the chosen root id, and the panel
 * service re-opens it as a {@link ThreadViewComponent} — keeping this component free
 * of any thread-open dependency (and the two panels from stacking).
 */
@Component({
  selector: 'trn-threads-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, AvatarComponent, HlmButton, TrnTooltip],
  templateUrl: './threads-list.component.html',
  styleUrl: './threads-list.component.scss',
})
export class ThreadsListComponent {
  /** Timestamps go through the app-wide format preference, never a DatePipe. */
  readonly fmt = inject(DateTimeFormatService);

  private readonly threadsSvc = inject(ThreadsService);
  private readonly dialogRef =
    inject<TrnDialogRef<string | undefined>>(TrnDialogRef);

  /** The room whose threads are listed (used by the panel to re-open a thread). */
  readonly roomId = input.required<string>();

  /** The active room's threads, newest activity first. */
  readonly threads = this.threadsSvc.threadList;

  /** Avatars shown per row, capped — the rest collapse into a "+N" chip. */
  readonly maxAvatars = MAX_AVATARS;

  /** Close this list, handing the chosen thread root back to the panel service. */
  openThread(rootEventId: string): void {
    this.dialogRef.close(rootEventId);
  }

  /** Close the panel without opening a thread. */
  close(): void {
    this.dialogRef.close();
  }

  /** Accessible label for a row's unread badge. */
  unreadLabel(summary: ThreadSummary): string {
    return summary.highlight
      ? `${summary.unreadCount} unread mentions`
      : `${summary.unreadCount} unread`;
  }
}
