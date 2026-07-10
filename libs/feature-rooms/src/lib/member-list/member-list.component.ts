import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCrown, lucideShield, lucideUser } from '@ng-icons/lucide';
import { AvatarComponent } from '@trinity/ui';
import { type MemberSummary } from '@trinity/data-access-rooms';
import { PresenceService } from '@trinity/data-access-profile';
import { type PresenceState } from '@trinity/util-matrix';

/** The role a member holds in the room, derived from their power level. */
type MemberRole = 'admin' | 'moderator' | 'member';

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
  /** Registered ng-icon name shown beside the header, e.g. "lucideCrown". */
  readonly icon: string;
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

/** Sections are rendered highest-role first. */
const ROLE_ORDER: readonly MemberRole[] = ['admin', 'moderator', 'member'];

/** Human-readable section header for each role. */
const ROLE_LABEL: Record<MemberRole, string> = {
  admin: 'Admin',
  moderator: 'Moderator',
  member: 'Member',
};

/** Icon shown beside each role header: a crown for admins, a shield for moderators. */
const ROLE_ICON: Record<MemberRole, string> = {
  admin: 'lucideCrown',
  moderator: 'lucideShield',
  member: 'lucideUser',
};

/**
 * Classify a power level into a role by the standard Matrix convention Element also
 * uses: 100 = admin, 50 = moderator, everything below = a regular member.
 */
function roleOf(powerLevel: number): MemberRole {
  if (powerLevel >= 100) {
    return 'admin';
  }
  if (powerLevel >= 50) {
    return 'moderator';
  }
  return 'member';
}

/** Discord member list (right column): joined members grouped into role sections. */
@Component({
  selector: 'trn-member-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, NgIcon],
  viewProviders: [provideIcons({ lucideCrown, lucideShield, lucideUser })],
  templateUrl: './member-list.component.html',
  styleUrl: './member-list.component.scss',
})
export class MemberListComponent {
  private readonly presence = inject(PresenceService);

  readonly members = input<MemberSummary[]>([]);
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
      role: roleOf(member.powerLevel),
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
    return ROLE_ORDER.map((role) => {
      const sectionRows = rows
        .filter((row) => row.role === role)
        .sort((a, b) => PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence]);
      const label = ROLE_LABEL[role];
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
