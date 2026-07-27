import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { DialogRef } from '@trinity/helm/overlay';
import { RoomsService, type MemberSummary } from '@trinity/data-access-rooms';
import { AvatarComponent } from '@trinity/ui';

/**
 * Dialog listing a space's members, so they can be inspected and moderated the way a
 * room's can.
 *
 * A space *is* a room, so `RoomsService.membersOf` and `RoomModerationService` already
 * answer correctly for a space id — the gap was never the data, only that nothing asked.
 * Picking a member CLOSES this dialog resolving them, and the host then opens the same
 * member-info panel used from a room, carrying the same kick/ban/power-level capabilities.
 * Resolving rather than emitting because `TrnDialogService` maps `inputs` only — there is
 * no output wiring — and this is the pattern `RoomDirectoryComponent` already uses for the
 * same reason. It keeps one moderation surface rather than a space-shaped copy of it.
 *
 * The list reads through `memberRevision` so it re-renders when membership changes and
 * not on every sync tick — the same signal the room member list depends on.
 */
@Component({
  selector: 'trn-space-members',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton, AvatarComponent],
  templateUrl: './space-members.component.html',
  styleUrl: './space-members.component.scss',
})
export class SpaceMembersComponent {
  readonly spaceId = input.required<string>();
  readonly spaceName = input('this space');

  private readonly dialogRef =
    inject<DialogRef<MemberSummary | null, SpaceMembersComponent>>(DialogRef);
  private readonly rooms = inject(RoomsService);

  readonly members = computed<MemberSummary[]>(() => {
    this.rooms.memberRevision();
    return this.rooms.membersOf(this.spaceId());
  });

  /**
   * The member's standing, from their power level. Named rather than numeric because the
   * number means nothing to anyone who has not read the spec, and these three are the
   * levels the moderation UI actually acts on.
   */
  roleOf(member: MemberSummary): string {
    if (member.powerLevel >= 100) {
      return 'Admin';
    }
    if (member.powerLevel >= 50) {
      return 'Moderator';
    }
    return '';
  }

  /** Pick a member: close resolving them so the host can open member info. */
  pick(member: MemberSummary): void {
    this.dialogRef.close(member);
  }

  close(): void {
    this.dialogRef.close(null);
  }
}
