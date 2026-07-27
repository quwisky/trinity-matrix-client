import { type MemberSummary } from '@trinity/data-access-rooms';

/**
 * A member's standing in a room, as the UI names it.
 *
 * Three of these are power levels by the standard Matrix convention Element also uses.
 * `owner` is not: it is the room's creator, which cannot be granted, transferred or
 * revoked — see {@link memberRole} for why that distinction has to be made here rather
 * than by adding another number to the ladder.
 */
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

/** The power level at which the standard convention calls someone an admin. */
const ADMIN_POWER = 100;
/** …and a moderator. */
const MODERATOR_POWER = 50;

/**
 * Classify a member into the role the UI shows.
 *
 * Lives here, shared, because three surfaces need the same answer — the member list's
 * section headers, the member-info panel's label, and the space members dialog — and
 * three private copies of `>= 100 / >= 50` is how they drift apart.
 *
 * **Owner requires being the creator AND still holding admin-level power.** The creator
 * flag alone would be enough to *state a fact*, but this list is a ranking: sections are
 * ordered by standing, so a creator who has since dropped themselves to 0 would be
 * rendered above the admins who actually run the room. Reporting them by the power they
 * now hold keeps the one invariant the list has. The fact itself is not lost — the data
 * layer still reports `isCreator`, so a surface that wants to badge a demoted founder can.
 *
 * `direct` suppresses the owner tier entirely — see the guard for why a DM has no owner.
 *
 * Note this deliberately does not distinguish power levels *above* 100. Someone
 * deliberately placed at 150 reads as Admin, and if the creator sits at 100 they will be
 * listed above them. That is a separate concern about treating the power ladder as
 * continuous, and folding it in here would conflate "who owns this" with "who outranks
 * whom".
 */
export function memberRole(
  member: MemberSummary,
  options: { direct?: boolean } = {},
): MemberRole {
  // Nobody owns a direct message. `createDirectMessage` uses the trusted_private_chat
  // preset, which puts BOTH participants at 100, so without this the person who happened
  // to start the chat is hoisted above the other and the panel labels them "Owner" and
  // their friend "Admin" — a hierarchy that does not exist in a 1:1 conversation.
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
