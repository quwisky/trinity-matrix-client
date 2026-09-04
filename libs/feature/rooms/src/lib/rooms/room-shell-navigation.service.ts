import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  SelectedRoomLibraryService,
  type RoomSummary,
} from '@trinity/data-access/room-library';
import { BELOW_MEMBERS_QUERY, mediaQuerySignal } from '@trinity/util/ui';
import {
  type WorkspaceNavigationIntent,
  WorkspaceNavigationService,
  type WorkspaceNavigationScope,
  type WorkspaceRoomNavigationOrigin,
} from '@trinity/application/workspace';
import { RoomShellStore } from './room-shell-store';
import { ShellStatusService } from './shell-status.service';
import {
  type ExactRoomSelection,
  type ExactSpaceSelection,
} from '../shared/exact-selection';

/**
 * UI-local navigation adapter around the authoritative Workspace workflow.
 *
 * Semantic state, Account activation, URLs, and Conversation focus belong to Workspace.
 * This adapter retains only room-shell concerns: focus handoff, overlay cleanup, error
 * presentation, and the selected-room lookup needed by keyboard and row coordinators.
 */
@Injectable()
export class RoomShellNavigationService {
  private readonly store = inject(RoomShellStore);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly selected = inject(SelectedRoomLibraryService);
  private readonly status = inject(ShellStatusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly membersAreDrawer = mediaQuerySignal(
    BELOW_MEMBERS_QUERY,
    this.destroyRef,
  );
  private focusActiveView!: () => void;
  private hasProjected = false;

  /** Hand focus to the compact pane that became visible after an atomic commit. */
  private readonly projectPaneFocus = effect(() => {
    this.store.activeRoomId();
    this.store.pane();
    const isFirstRun = !this.hasProjected;
    this.hasProjected = true;
    if (!isFirstRun) untracked(() => this.focusActiveView());
  });

  bindFocus(focus: () => void): void {
    this.focusActiveView = focus;
  }

  onShowRecent(): void {
    this.openScope({ kind: 'recent' });
  }

  onSelectSpace({ spaceId, accountId }: ExactSpaceSelection): void {
    this.openScope(
      spaceId ? { kind: 'space', spaceId } : { kind: 'home' },
      accountId,
    );
  }

  onShowRooms(): void {
    this.openScope({ kind: 'rooms' });
  }

  onSelectRoom(
    { roomId, accountId }: ExactRoomSelection,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    this.navigate({ kind: 'room', accountId, roomId, origin });
  }

  /** Change sidebar scope and open its room as one atomic Workspace destination. */
  onSelectRoomInScope(
    { roomId, accountId }: ExactRoomSelection,
    scope: WorkspaceNavigationScope,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    this.navigate({ kind: 'room', accountId, roomId, scope, origin });
  }

  closeOpenRoom(): void {
    if (this.membersAreDrawer()) this.store.rightPanel.set(null);
    this.navigate({ kind: 'list', origin: 'compact-close' });
  }

  /** Clear selection after the Room is removed rather than merely hiding its pane. */
  clearOpenRoom(): void {
    if (this.membersAreDrawer()) this.store.rightPanel.set(null);
    this.navigate({ kind: 'list', origin: 'room-removed' });
  }

  /** Every room the shell can currently open, independent of the active sidebar scope. */
  knownRooms(): readonly RoomSummary[] {
    return this.selected.view().rooms;
  }

  private openScope(
    scope: WorkspaceNavigationScope,
    accountId = this.workspace.activeAccountId(),
  ): void {
    if (!accountId) return;
    this.navigate({ kind: 'scope', accountId, scope });
  }

  private navigate(intent: WorkspaceNavigationIntent): void {
    this.workspace
      .navigate(intent)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        if (outcome.kind !== 'ready') {
          void this.status.showError(
            'Unable to open that destination right now.',
          );
        }
      });
  }
}
