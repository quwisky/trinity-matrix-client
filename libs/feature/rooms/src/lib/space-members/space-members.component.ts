import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { EmptyStateComponent } from '@trinity/components/empty-state';
import { TrnDialogRef } from '@trinity/components/overlay';
import { RoomsService, type MemberSummary } from '@trinity/data-access/rooms';
import { AvatarComponent } from '@trinity/components/avatar';
import { MEMBER_ROLE_LABEL, memberRole } from '../shared/member-role';

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
 * The list reads `membersFor(spaceId)`, so it re-renders when THIS space's membership
 * changes and not on every sync tick — the same projection the room member list uses.
 */
@Component({
  selector: 'trn-space-members',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyStateComponent, HlmButton, AvatarComponent],
  templateUrl: './space-members.component.html',
  styleUrl: './space-members.component.scss',
})
export class SpaceMembersComponent {
  readonly spaceId = input.required<string>();
  readonly spaceName = input('this space');

  private readonly dialogRef =
    inject<TrnDialogRef<MemberSummary | null>>(TrnDialogRef);
  private readonly rooms = inject(RoomsService);

  readonly members = computed<readonly MemberSummary[]>(() => {
    return this.rooms.membersFor(this.spaceId())();
  });

  /**
   * The member's standing, named rather than numeric because the number means nothing to
   * anyone who has not read the spec. Empty for a plain member, whose row needs no badge.
   *
   * A space is a room, so it has a creator too — the same shared classification applies
   * unchanged, and the space's founder is distinguished from anyone they promoted.
   */
  roleOf(member: MemberSummary): string {
    const role = memberRole(member);
    return role === 'member' ? '' : MEMBER_ROLE_LABEL[role];
  }

  /** Pick a member: close resolving them so the host can open member info. */
  pick(member: MemberSummary): void {
    this.dialogRef.close(member);
  }

  close(): void {
    this.dialogRef.close(null);
  }
}
