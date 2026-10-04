import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  Injector,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  type WorkspaceNavigationIntent,
  WorkspaceNavigationService,
  type WorkspaceRoomNavigationOrigin,
} from '@trinity/application/workspace';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ROOM_READINESS_TIMEOUT_MS,
  SelectedRoomLibraryService,
} from '@trinity/data-access/room-library';
import { filter, of, switchMap, take, timeout } from 'rxjs';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import { ShellStatusService } from './shell-status.service';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';
import {
  type ExactRoomSelection,
  type ExactSpaceSelection,
} from '../shared/exact-selection';

interface ConfirmedRoomLinkTarget extends ExactRoomSelection {
  readonly kind: 'room' | 'space';
}

/**
 * Routing a selection to the account that owns it.
 *
 * A visible row carries its exact owning Account into the semantic Workspace command.
 * Permalinks resolve against the same selected Room Library generation that rendered the
 * sidebar; confirmed membership flows carry their Account explicitly and skip that lookup.
 */
@Injectable()
export class AccountRoutingService {
  private readonly store = inject(RoomShellStore);
  private readonly vm = inject(RoomShellViewModel);
  private readonly status = inject(ShellStatusService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly roomSurfaces = inject(RoomSurfaceLifecycle);
  private readonly selected = inject(SelectedRoomLibraryService);
  private readonly matrix = inject(MatrixClientService);
  private readonly injector = inject(Injector);
  private readonly conversations = inject(ConversationRuntime);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * A sync from the server has completed. Not PREPARED: the SDK also reports that for the
   * sync it restores from its cache, whose timelines a gappy live sync later replaces.
   */
  private readonly firstSyncDone = computed(
    // String compare: components and features never import the SDK's SyncState enum.
    () => String(this.matrix.syncState() ?? '') === 'SYNCING',
  );

  /** An account's display name for user-facing copy, falling back to its user id. */
  accountLabel(accountId: string): string {
    return this.vm.accountBadges().get(accountId)?.name ?? accountId;
  }

  /**
   * Include/exclude an account from the mixed view (the account picker's checkbox). The
   * active account is always shown, and the service ignores an attempt to drop it.
   */
  onToggleAccountShown(userId: string): void {
    this.selected
      .toggleAccount(userId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (outcome) => {
          if (outcome.kind !== 'completed') {
            this.status.showError(
              'Unable to update the accounts shown right now.',
            );
          }
        },
        error: () =>
          this.status.showError(
            'Unable to update the accounts shown right now.',
          ),
      });
  }

  /** Open the exact Account-and-Room identity emitted by a visible Room row. */
  onSelectRoomSelection(
    selection: ExactRoomSelection,
    origin: WorkspaceRoomNavigationOrigin = 'room-list',
  ): void {
    this.openRoom(selection, origin);
  }

  /** Open one exact Conversation and present its member roster once Workspace is ready. */
  onOpenRoomMembers(
    selection: ExactRoomSelection,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    if (
      selection.accountId === this.workspace.activeAccountId() &&
      selection.roomId === this.workspace.activeRoomId() &&
      this.workspace.pane() === 'conversation'
    ) {
      this.roomSurfaces.transition({ kind: 'open-members' });
      return;
    }
    this.openRoom(selection, origin, () => {
      this.roomSurfaces.transition({ kind: 'open-members' });
    });
  }

  /**
   * Select a space pill from the rail. In mixed mode a foreign account's space switches to
   * that account first; Home (`null`) and same-account spaces select directly.
   */
  onSelectSpaceRow({ spaceId, accountId }: ExactSpaceSelection): void {
    const changesAccount = accountId !== this.workspace.activeAccountId();
    this.navigate(
      {
        kind: 'scope',
        accountId,
        scope: spaceId ? { kind: 'space', spaceId } : { kind: 'home' },
      },
      changesAccount
        ? 'Unable to open that account right now.'
        : 'Unable to open that destination right now.',
    );
  }

  /**
   * Open a resolved room if joined (jumping to `eventId` when given), else toast. A link
   * that launches the app can arrive before the first sync, when the room list is still
   * empty, so a room not yet listed waits for that sync rather than looking unjoined.
   */
  openLinkedRoom(
    roomId: string,
    eventId?: string,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    if (this.isListed(roomId) || this.firstSyncDone()) {
      this.openSyncedRoom(roomId, eventId, origin);
      return;
    }
    toObservable(this.firstSyncDone, { injector: this.injector })
      .pipe(
        filter(Boolean),
        take(1),
        timeout({ first: ROOM_READINESS_TIMEOUT_MS }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.openSyncedRoom(roomId, eventId, origin),
        error: () =>
          void this.status.showError(
            'Could not open that room yet. Try the link again once Trinity has connected.',
          ),
      });
  }

  private isListed(roomId: string): boolean {
    return this.selected.view().rooms.some((room) => room.id === roomId);
  }

  private openSyncedRoom(
    roomId: string,
    eventId: string | undefined,
    origin: WorkspaceRoomNavigationOrigin,
  ): void {
    const room = this.selected
      .view()
      .rooms.find((candidate) => candidate.id === roomId);
    if (!room) {
      void this.status.showError("You're not in that room.");
      return;
    }
    if (
      roomId !== this.store.activeRoomId() ||
      room.accountId !== this.store.activeAccountId() ||
      this.store.pane() !== 'conversation'
    ) {
      this.openRoom(
        { roomId, accountId: room.accountId },
        origin,
        eventId
          ? () =>
              this.revealLoadedEvent(
                { roomId, accountId: room.accountId },
                eventId,
              )
          : undefined,
      );
      return;
    }
    if (eventId) {
      this.revealLoadedEvent({ roomId, accountId: room.accountId }, eventId);
    }
  }

  /**
   * Reveal an event of a room. The list scrolls by DOM lookup, and a cold start loads only
   * the newest messages, so an older linked event is paged in first. Navigation reports
   * ready before the Conversation Runtime moves focus, and `loadEvent` pages whichever
   * conversation holds it, so wait for the target room to be focused. A cold start opens
   * the room from the cached sync, so also wait for a live sync: a gappy one replaces the
   * cached timeline and would drop the paged-in event.
   */
  private revealLoadedEvent(room: ExactRoomSelection, eventId: string): void {
    const isReady = (): boolean => {
      const key = this.conversations.focused()?.key;
      return (
        this.firstSyncDone() &&
        key?.roomId === room.roomId &&
        key.accountId === room.accountId
      );
    };
    const ready$ = isReady()
      ? of(true)
      : toObservable(computed(isReady), { injector: this.injector }).pipe(
          filter(Boolean),
          take(1),
          timeout({ first: ROOM_READINESS_TIMEOUT_MS }),
        );
    ready$
      .pipe(
        switchMap(() => this.conversations.timeline.loadEvent(eventId)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (loaded) => {
          if (loaded) {
            this.roomSurfaces.transition({ kind: 'reveal-message', eventId });
          } else {
            void this.status.showError('Could not load that message.');
          }
        },
        error: () => void this.status.showError('Could not load that message.'),
      });
  }

  /**
   * Open a room/space after a Join or Accept request has succeeded. The normal linked-room
   * path checks the synced sidebar projection and can briefly reject the new membership
   * before `/sync` catches up, so confirmed membership deliberately bypasses that stale read.
   */
  openConfirmedLinkedRoom(
    target: ConfirmedRoomLinkTarget,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    if (target.kind === 'space') {
      this.navigate(
        {
          kind: 'scope',
          accountId: target.accountId,
          scope: { kind: 'space', spaceId: target.roomId },
        },
        'Unable to open that destination right now.',
      );
      return;
    }
    this.navigate(
      {
        kind: 'room',
        accountId: target.accountId,
        roomId: target.roomId,
        scope: { kind: 'rooms' },
        origin,
      },
      'Unable to open that destination right now.',
    );
  }

  private openRoom(
    selection: ExactRoomSelection,
    origin: WorkspaceRoomNavigationOrigin,
    onReady?: () => void,
  ): void {
    const changesAccount =
      selection.accountId !== this.workspace.activeAccountId();
    this.navigate(
      { kind: 'room', ...selection, origin },
      changesAccount
        ? 'Unable to open that account right now.'
        : 'Unable to open that destination right now.',
      onReady,
    );
  }

  private navigate(
    intent: WorkspaceNavigationIntent,
    error: string,
    onReady?: () => void,
  ): void {
    this.workspace
      .navigate(intent)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind !== 'ready') {
          void this.status.showError(error);
        } else {
          onReady?.();
        }
      });
  }
}
