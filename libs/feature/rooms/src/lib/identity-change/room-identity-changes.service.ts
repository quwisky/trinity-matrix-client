import { Injectable, inject, untracked } from '@angular/core';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { RoomMembersService } from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { TrustUsersService, type UserTrust } from '@trinity/data-access/trust';

/** A room member whose cryptographic identity changed and still needs a response. */
export interface IdentityChange {
  readonly userId: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
  readonly trust: Extract<
    UserTrust,
    'identity-changed' | 'verified-identity-changed'
  >;
}

/**
 * Who in an encrypted room changed identity: joined and invited members (those its messages are
 * encrypted to), never yourself. Trust is the active Account's view, so another Account's room
 * lists nobody. A synchronous read for `computed()`; it follows members and trust live.
 */
@Injectable({ providedIn: 'root' })
export class RoomIdentityChangesService {
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly members = inject(RoomMembersService);
  private readonly trustUsers = inject(TrustUsersService);

  changes(
    key: { readonly accountId: string; readonly roomId: string } | null,
  ): readonly IdentityChange[] {
    if (!key || key.accountId !== this.workspace.activeAccountId()) return [];
    const room = this.rooms.rooms().find((r) => r.id === key.roomId);
    if (!room?.encrypted) return [];
    // shortcut: reads every member's trust once on open (cached and event-driven after), as
    // Element does; batch or cap it if very large rooms open slowly.
    const people = [
      ...this.members.membersFor(key.roomId)(),
      ...this.members.invitedFor(key.roomId)(),
    ];
    return people.flatMap((member) => {
      if (member.userId === key.accountId) return [];
      // untracked: the service may settle its signal synchronously, which a computed forbids.
      const trust = untracked(() => this.trustUsers.userTrust(member.userId))();
      return trust === 'identity-changed' ||
        trust === 'verified-identity-changed'
        ? [
            {
              userId: member.userId,
              name: member.roomDisplayName,
              initial: member.roomInitial,
              avatarMxc: member.roomAvatarMxc,
              trust,
            },
          ]
        : [];
    });
  }
}
