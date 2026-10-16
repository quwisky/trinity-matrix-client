import { Injectable, inject } from '@angular/core';
import {
  RoomLibraryService,
  SelectedRoomLibraryService,
} from '@trinity/data-access/room-library';

/**
 * Package-internal: which Spaces and Rooms a Workspace destination may name. The transition
 * workflow repairs a destination with it, and the cold-start seed checks a URL with it.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceAvailability {
  private readonly rooms = inject(RoomLibraryService);
  private readonly selectedRooms = inject(SelectedRoomLibraryService);

  /**
   * A Space scope must be held by the Account, or listed in the mixed view it is part of;
   * any other is repaired to the list.
   */
  space(accountId: string, spaceId: string): boolean {
    return this.selectedRooms.spaceSelectable(accountId, spaceId);
  }

  /** A Room the live client has not synced yet is kept; the Conversation decides. */
  roomKept(accountId: string, roomId: string): boolean {
    return (
      this.rooms.selectionAvailability(accountId, roomId) !== 'unavailable'
    );
  }
}
