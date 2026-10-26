import { Injectable, inject } from '@angular/core';
import {
  RoomLibraryService,
  type InviteHistory,
  type RoomLibraryGovernanceKey,
} from '@trinity/data-access/room-library';
import { TrustService } from '@trinity/data-access/trust';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import type { UserPickerNote } from '../user-picker/user-picker.service';
import { UndecryptableFixService } from './undecryptable-fix.service';

/**
 * The invite dialog's line on which earlier messages the invitee will be able to read. The SDK
 * shares a room's history only from a device verified by its own identity, so an unverified
 * device needs fixing first. Null when there is nothing to say: an unencrypted room, or a device
 * state not known yet.
 */
export function inviteHistoryNote(
  history: InviteHistory | null,
  deviceVerified: boolean | null,
): { text: string; needsVerification: boolean } | null {
  switch (history) {
    case null:
      return null;
    case 'from-invite':
      return {
        text: "They'll be able to read messages from when they're invited.",
        needsVerification: false,
      };
    case 'from-join':
      return {
        text: "They'll be able to read messages sent after they join.",
        needsVerification: false,
      };
    case 'shared':
      if (deviceVerified === null) return null;
      // Sent once, at invite, to the invitee's cross-signed devices only.
      return deviceVerified
        ? {
            text: "If they've set up encryption, they'll be able to read earlier messages.",
            needsVerification: false,
          }
        : {
            text: 'Verify this device before inviting, so they can read earlier messages.',
            needsVerification: true,
          };
  }
}

/** Builds the invite dialog's history note, with the device fix as its button when needed. */
@Injectable({ providedIn: 'root' })
export class InviteHistoryNoteService {
  private readonly rooms = inject(RoomLibraryService);
  private readonly trust = inject(TrustService);
  private readonly fixes = inject(UndecryptableFixService);
  private readonly workspace = inject(WorkspaceNavigationService);

  noteFor(target: string | RoomLibraryGovernanceKey): UserPickerNote | null {
    // Trust is the active account's; another account's device state is unknown here.
    const active =
      typeof target === 'string' ||
      target.accountId === this.workspace.activeAccountId();
    const note = inviteHistoryNote(
      this.rooms.inviteHistory(target),
      active ? this.trust.thisDeviceVerified() : null,
    );
    if (!note) return null;
    const fix = note.needsVerification ? this.fixes.fix() : null;
    return fix
      ? {
          text: note.text,
          action: {
            label: fix.label,
            run: () => this.fixes.open().subscribe(),
          },
        }
      : { text: note.text };
  }
}
