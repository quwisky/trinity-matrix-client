import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  RoomNotificationUpdateError,
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { Observable, forkJoin } from 'rxjs';
import { RoomShellViewModel } from './room-shell-view-model';
import { ShellStatusService } from './shell-status.service';

/**
 * Read state and per-room notification level: marking read or unread, marking everything
 * read, and setting a room's notify mode.
 *
 * Depends only on the view model's `visibleRooms` and the two data-access services, so it
 * is a leaf — nothing else in the shell calls into it.
 */
@Injectable()
export class ReadStateService {
  private readonly vm = inject(RoomShellViewModel);
  private readonly status = inject(ShellStatusService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly roomNotifications = inject(RoomNotificationsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sidebar room ⋮ menu: apply a chosen notification level (all / mentions / mute). */
  onSetNotifyMode({
    roomId,
    mode,
    accountIds,
  }: {
    roomId: string;
    mode: RoomNotifyMode;
    accountIds?: readonly string[];
  }): void {
    this.setNotifyMode(roomId, mode, accountIds);
  }

  /** Apply a notification level on every account joined to the row — a merged row shows one
   * menu, so muting it must actually mute the room everywhere it is contributing. */
  private setNotifyMode(
    roomId: string,
    mode: RoomNotifyMode,
    accountIds?: readonly string[],
  ): void {
    this.roomNotifications
      .setModeForAccounts(roomId, mode, accountIds)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          const message =
            error instanceof RoomNotificationUpdateError && error.restored
              ? 'Couldn’t update notifications. Your previous setting was restored. Try again.'
              : 'Couldn’t update notifications. Reopen the menu to confirm the server setting, then try again.';
          void this.status.showError(message);
        },
      });
  }

  /** Mark a single room read (from its ⋮ menu); the badge clears via sync. Acked on the
   * row's own account, which in the mixed view need not be the active one. */
  onMarkRead({
    roomId,
    accountIds,
  }: {
    roomId: string;
    accountIds?: readonly string[];
  }): void {
    this.ackRead(roomId, accountIds)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () =>
          void this.status.showError('Could not mark the room read.'),
      });
  }

  /**
   * Flag a room to come back to. Written on every account joined to the row for the same
   * reason {@link onMarkRead} acks all of them: a merged mixed-account row would otherwise
   * be flagged on one account and not the other, and the two would disagree.
   */
  onMarkUnread({
    roomId,
    accountIds,
  }: {
    roomId: string;
    accountIds?: readonly string[];
  }): void {
    const targets = accountIds?.length ? accountIds : [undefined];
    forkJoin(
      targets.map((accountId) =>
        this.rooms.setMarkedUnread(roomId, true, accountId),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () =>
          void this.status.showError('Could not mark the room unread.'),
      });
  }

  /**
   * Ack a room on every account joined to it. A room both mixed accounts are in is ONE row
   * carrying the loudest unread of the two, so acking only one leaves a badge the user has
   * no way to clear.
   */
  private ackRead(
    roomId: string,
    accountIds?: readonly string[],
  ): Observable<unknown> {
    const targets = accountIds?.length ? accountIds : [undefined];
    return forkJoin(
      targets.map((accountId) => this.rooms.markRead(roomId, accountId)),
    );
  }

  /**
   * Mark the currently-visible unread rooms read (header action). Scoped to the sidebar's
   * rooms so it matches the button, which is gated on their unread state — and acked per
   * owning account, since in the mixed view the button is offered for rooms belonging to
   * accounts other than the active one (acking those through the active client would
   * silently do nothing).
   */
  onMarkAllRead(): void {
    const unread = this.vm.visibleRooms().filter((room) => room.hasUnread);
    if (unread.length === 0) {
      return;
    }
    // Acked on every account joined to the row, exactly as the ⋮ path does: a merged
    // mixed-account row can be flagged on the account that did NOT win the merge, and
    // acking only the winner leaves the row unread with the button still offering to
    // clear it.
    forkJoin(unread.map((room) => this.ackRead(room.id, room.accountIds)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: () => void this.status.showError('Could not mark rooms read.'),
      });
  }
}
