import { type MemberSummary } from './room-members.service';

/** A member's Room standing after applying Matrix power-level policy. */
export type MemberRole = 'owner' | 'admin' | 'moderator' | 'member';

/** Highest standing first — the order role sections are rendered in. */
export const MEMBER_ROLE_ORDER: readonly MemberRole[] = [
  'owner',
  'admin',
  'moderator',
  'member',
];

/** How each role is named to the user. */
export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  moderator: 'Moderator',
  member: 'Member',
};

/** One role Room Administration can assign through a Matrix power-level write. */
export interface AssignableMemberRole {
  readonly role: Exclude<MemberRole, 'owner'>;
  readonly label: string;
  readonly level: number;
}

/**
 * Standard assignable roles. Owner is intentionally absent: creator identity is immutable
 * and cannot be granted by a power-level write.
 */
export const ASSIGNABLE_MEMBER_ROLES: readonly AssignableMemberRole[] = [
  { role: 'member', label: 'Member', level: 0 },
  { role: 'moderator', label: 'Moderator', level: 50 },
  { role: 'admin', label: 'Admin', level: 100 },
];

const ADMIN_POWER = 100;
const MODERATOR_POWER = 50;

/**
 * Classify a member into Room Administration's role model.
 *
 * Creator identity is separate from power. A creator is displayed as owner only while
 * retaining admin-level authority; a demoted creator follows their current power. Direct
 * messages suppress owner because their trusted-private-chat preset gives both peers equal
 * authority and has no meaningful ownership hierarchy.
 */
export function memberRole(
  member: MemberSummary,
  options: { readonly direct?: boolean } = {},
): MemberRole {
  if (!options.direct && member.isCreator && member.powerLevel >= ADMIN_POWER) {
    return 'owner';
  }
  if (member.powerLevel >= ADMIN_POWER) {
    return 'admin';
  }
  if (member.powerLevel >= MODERATOR_POWER) {
    return 'moderator';
  }
  return 'member';
}
