import { Injectable, inject } from '@angular/core';
import {
  RoomLibraryService,
  SelectedRoomLibraryService,
  type RoomLibrarySelectionAvailability,
} from '@trinity/data-access/room-library';

/**
 * Package-internal: which Spaces and Rooms a Workspace destination may name. The transition
 * workflow repairs a destination with it, the cold-start seed checks a URL with it, and the
 * navigation service watches the selected Space with it.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceAvailability {
  private readonly rooms = inject(RoomLibraryService);
  private readonly selectedRooms = inject(SelectedRoomLibraryService);

  /**
   * A Space scope must be held by the Account, or listed in the mixed view it is part of.
   * One its Accounts have not synced yet is `unconfirmed` and kept, like a Room; only an
   * `unavailable` one is repaired to Recent. Reactive: read it in a `computed` to follow it.
   */
  space(accountId: string, spaceId: string): RoomLibrarySelectionAvailability {
    return this.selectedRooms.spaceAvailability(accountId, spaceId);
  }

  /** A Room the live client has not synced yet is kept; the Conversation decides. */
  roomKept(accountId: string, roomId: string): boolean {
    return (
      this.rooms.selectionAvailability(accountId, roomId) !== 'unavailable'
    );
  }
}
