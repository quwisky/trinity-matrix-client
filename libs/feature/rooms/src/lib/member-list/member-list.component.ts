import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { AvatarComponent } from '@trinity/ui';
import { type MemberSummary } from '@trinity/data-access/rooms';
import { PresenceService } from '@trinity/data-access/profile';
import { type PresenceState } from '@trinity/util/matrix';
import { TrnIconComponent, type TrnIconName } from '@trinity/kit/icon';
import {
  MEMBER_ROLE_LABEL,
  MEMBER_ROLE_ORDER,
  memberRole,
  type MemberRole,
} from '../shared/member-role';

/** A member decorated with their live presence and role, for the section list. */
interface MemberRow {
  readonly member: MemberSummary;
  readonly presence: PresenceState;
  readonly role: MemberRole;
}

/** A role section: a labelled group of members shown under its own header. */
interface MemberSection {
  readonly role: MemberRole;
  /** Visible header, e.g. "Admin". */
  readonly label: string;
  /** Icon shown beside the header, from Trinity's vocabulary, e.g. "crown". */
  readonly icon: TrnIconName;
  /** Accessible name for the group landmark, e.g. "Admin, 2 members". */
  readonly ariaLabel: string;
  readonly rows: MemberRow[];
}

/** Sort order: online first, then away, then offline (stable within each group). */
const PRESENCE_RANK: Record<PresenceState, number> = {
  online: 0,
  unavailable: 1,
  offline: 2,
};

/**
 * Icon per role header. The owner gets the key rather than a second crown: two crown-ish
 * glyphs stacked above each other is exactly the "which of these is which?" the separate
 * section exists to remove.
 */
const ROLE_ICON: Record<MemberRole, TrnIconName> = {
  owner: 'key-round',
  admin: 'crown',
  moderator: 'shield',
  member: 'user',
};

/** Discord member list (right column): joined members grouped into role sections. */
@Component({
  selector: 'trn-member-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnIconComponent],
  templateUrl: './member-list.component.html',
  styleUrl: './member-list.component.scss',
})
export class MemberListComponent {
  private readonly presence = inject(PresenceService);

  readonly members = input<readonly MemberSummary[]>([]);
  /**
   * Whether this is a direct message. A DM has no owner — both participants sit at power
   * level 100 by the trusted_private_chat preset — so the section is suppressed there.
   */
  readonly direct = input(false);
  /** A member row was clicked — the host opens their info panel. */
  readonly selectMember = output<MemberSummary>();

  /**
   * Every member decorated with live presence and role. Recomputes when membership,
   * any listed member's presence, or a member's power level changes.
   */
  private readonly rows = computed<MemberRow[]>(() =>
    this.members().map((member) => ({
      member,
      presence: this.presence.presenceFor(member.userId)(),
      role: memberRole(member, { direct: this.direct() }),
    })),
  );

  /**
   * Members grouped into role sections (admins, then moderators, then members), each
   * ordered online-first. The incoming list is already name-sorted and both the
   * partition and the presence sort are stable, so members keep alphabetical order
   * within each presence group. Empty sections are dropped.
   */
  readonly sections = computed<MemberSection[]>(() => {
    const rows = this.rows();
    return MEMBER_ROLE_ORDER.map((role) => {
      const sectionRows = rows
        .filter((row) => row.role === role)
        .sort((a, b) => PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence]);
      const label = MEMBER_ROLE_LABEL[role];
      const noun = sectionRows.length === 1 ? 'member' : 'members';
      return {
        role,
        label,
        icon: ROLE_ICON[role],
        ariaLabel: `${label}, ${sectionRows.length} ${noun}`,
        rows: sectionRows,
      };
    }).filter((section) => section.rows.length > 0);
  });
}
