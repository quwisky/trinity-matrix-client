import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AccountScopeService,
  MixedRoomsService,
  RoomLibraryService,
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

/**
 * UI-local navigation adapter around the authoritative Workspace workflow.
 *
 * Semantic state, Account activation, URLs, and Conversation focus belong to Workspace.
 * This adapter retains only room-shell concerns: focus handoff, overlay cleanup, error
 * presentation, and the mixed-room lookup needed by keyboard and row coordinators.
 */
@Injectable()
export class RoomShellNavigationService {
  private readonly store = inject(RoomShellStore);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly mixedRooms = inject(MixedRoomsService);
  private readonly accountScope = inject(AccountScopeService);
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

  onSelectSpace(id: string | null): void {
    this.openScope(id ? { kind: 'space', spaceId: id } : { kind: 'home' });
  }

  onShowRooms(): void {
    this.openScope({ kind: 'rooms' });
  }

  onSelectRoom(
    id: string,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    const accountId = this.workspace.activeAccountId();
    if (!accountId) return;
    this.navigate({ kind: 'room', accountId, roomId: id, origin });
  }

  /** Change sidebar scope and open its room as one atomic Workspace destination. */
  onSelectRoomInScope(
    id: string,
    scope: WorkspaceNavigationScope,
    origin: WorkspaceRoomNavigationOrigin = 'room-action',
  ): void {
    const accountId = this.workspace.activeAccountId();
    if (!accountId) return;
    this.navigate({ kind: 'room', accountId, roomId: id, scope, origin });
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
  knownRooms(): RoomSummary[] {
    return this.accountScope.mixing()
      ? this.mixedRooms.rooms()
      : this.rooms.rooms();
  }

  private openScope(scope: WorkspaceNavigationScope): void {
    const accountId = this.workspace.activeAccountId();
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
