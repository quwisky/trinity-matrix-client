import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  Injector,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  type WorkspaceNavigationIntent,
  WorkspaceNavigationService,
  type WorkspaceRoomNavigationOrigin,
} from '@trinity/application/workspace';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  ROOM_READINESS_TIMEOUT_MS,
  RoomReadinessService,
  SelectedRoomLibraryService,
} from '@trinity/data-access/room-library';
import {
  Subscription,
  filter,
  of,
  switchMap,
  take,
  takeWhile,
  timeout,
  type Observable,
} from 'rxjs';
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
  private readonly roomReadiness = inject(RoomReadinessService);
  private readonly matrix = inject(SessionStateService);
  private readonly injector = inject(Injector);
  private readonly conversations = inject(ConversationRuntime);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * A sync from the server has completed. Not PREPARED: the SDK also reports that for the
   * sync it restores from its cache, whose timelines a gappy live sync later replaces.
   */
  private readonly firstSyncDone = computed(
    () => this.matrix.syncState() === 'syncing',
  );
  // Watchers are created once for the service's lifetime. A `toObservable` made per wait
  // would stay alive after its wait was cancelled, until the page is destroyed.
  private readonly firstSyncDone$ = toObservable(this.firstSyncDone, {
    injector: this.injector,
  });
  /** Changes whenever anything a pending event reveal waits on (or is cancelled by) changes. */
  private readonly revealInputs$ = toObservable(
    computed(() => ({
      synced: this.firstSyncDone(),
      focus: this.conversations.focused()?.key ?? null,
      load: this.conversations.timeline.loadState().kind,
      roomId: this.store.activeRoomId(),
      accountId: this.store.activeAccountId(),
    })),
    { injector: this.injector },
  );

  constructor() {
    // A published event anchor (`?event=`, a notification) is revealed once its room is the
    // focused, live-synced Conversation, paging the event in like a linked-room jump. A
    // changed or cleared target, or another room, cancels the wait so it is never applied late.
    effect((onCleanup) => {
      const target = this.workspace.eventTarget();
      const accountId = this.store.activeAccountId();
      const roomId = this.store.activeRoomId();
      if (!target || !accountId || !roomId) return;
      const pending = untracked(() =>
        this.revealLoadedEvent({ accountId, roomId }, target.eventId),
      );
      onCleanup(() => pending.unsubscribe());
    });
  }

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

  /**
   * Open an exact Account-and-Room identity. Callers name `origin` because it decides
   * which list the Room opens in: `'room-list'` keeps a selected space, so only a row of
   * the sidebar list on screen may use it. `onReady` runs once Workspace has opened it,
   * for a caller that hands focus on from a control the open removes.
   */
  onSelectRoomSelection(
    selection: ExactRoomSelection,
    origin: WorkspaceRoomNavigationOrigin,
    onReady?: () => void,
  ): void {
    this.openRoom(selection, origin, onReady);
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
   * that account first; Home (`null`) and same-account spaces select directly, and so does
   * the pill already selected for the account on screen.
   */
  onSelectSpaceRow(selection: ExactSpaceSelection): void {
    const { spaceId } = selection;
    const activeAccountId = this.workspace.activeAccountId();
    // In the mixed view the account on screen can be showing another account's space, after
    // opening one of its rooms. Its highlighted pill stays on that account and its room.
    const accountId =
      spaceId &&
      activeAccountId &&
      spaceId === this.workspace.activeSpaceId() &&
      this.selected.spaceAvailability(activeAccountId, spaceId) === 'available'
        ? activeAccountId
        : selection.accountId;
    const changesAccount = accountId !== activeAccountId;
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
    this.firstSyncDone$
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
   * the room from the cached sync, so also wait for a live sync before paging history: a
   * gappy one replaces the cached timeline and would drop the paged-in event. An event that
   * is already loaded is revealed at once.
   */
  private revealLoadedEvent(
    room: ExactRoomSelection,
    eventId: string,
  ): Subscription {
    const focusedKey = this.conversations.focused()?.key;
    const isFocused =
      focusedKey?.roomId === room.roomId &&
      focusedKey.accountId === room.accountId;
    // Already in the loaded timeline: nothing to page in, so no live sync is needed.
    if (
      isFocused &&
      this.conversations.timeline.messages().some((m) => m.id === eventId)
    ) {
      this.roomSurfaces.transition({ kind: 'reveal-message', eventId });
      return Subscription.EMPTY;
    }
    // The watcher only signals a change; the live state is re-read, since its replayed value
    // can be one effect-flush stale. The room must be open (ready or empty): an unavailable
    // or still-loading room waits silently, however long its sync takes, and the timeout
    // only bounds paging the event in once it can be.
    const isActive = (): boolean =>
      this.store.activeRoomId() === room.roomId &&
      this.store.activeAccountId() === room.accountId;
    const isReady = (): boolean => {
      const key = this.conversations.focused()?.key;
      const load = this.conversations.timeline.loadState().kind;
      return (
        this.firstSyncDone() &&
        key?.roomId === room.roomId &&
        key.accountId === room.accountId &&
        (load === 'ready' || load === 'empty')
      );
    };
    // Navigating to another room or account drops the reveal, from any navigation source.
    const ready$: Observable<unknown> = isReady()
      ? of(true)
      : this.revealInputs$.pipe(takeWhile(isActive), filter(isReady), take(1));
    return ready$
      .pipe(
        switchMap(() =>
          this.conversations.timeline
            .loadEvent(eventId)
            .pipe(timeout({ first: ROOM_READINESS_TIMEOUT_MS })),
        ),
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
      // A join or an accepted invitation keeps the earlier membership until `/sync` brings
      // it, and Workspace keeps only a joined space, so the join has to land first.
      this.roomReadiness
        .waitForRoom(target.accountId, target.roomId)
        .pipe(
          switchMap(() =>
            this.workspace.navigate({
              kind: 'scope',
              accountId: target.accountId,
              scope: { kind: 'space', spaceId: target.roomId },
            }),
          ),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe({
          next: (outcome) => {
            if (outcome.kind !== 'ready') {
              void this.status.showError(
                'Unable to open that destination right now.',
              );
            }
          },
          error: () =>
            void this.status.showError(
              'Joined, but the space is not ready yet.',
            ),
        });
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
      {
        kind: 'room',
        ...selection,
        origin,
        // A rail chat keeps the current list only when that list shows it.
        ...(origin === 'rail-unread'
          ? { listedIn: this.vm.listsShowing(selection) }
          : {}),
      },
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
