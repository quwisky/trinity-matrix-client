import type { Room } from 'matrix-js-sdk';

/**
 * The `mxc://` avatar to show for a room: its own `m.room.avatar` if it has one, and
 * otherwise — for a direct message only — the other person's (a DM normally has no room
 * avatar).
 *
 * `isDirect` must come from the caller (`m.direct` for a joined room, the invite's
 * `is_direct` for an invite). Do not let `getAvatarFallbackMember()` decide: it bails out
 * only above two members, so a named two-person group room would wear the other member's
 * face, and an invite's stripped state holds just the inviter's and our own membership, so
 * every group-room and space invite would show the inviter.
 *
 * For a genuine DM it is still the right way to find the peer: it reads the heroes summary
 * first (all a lazy-loaded room has early), ignores functional members (bots, widgets) and
 * resolves the other side after they leave. Gating on `isDirect` also keeps its whole-member
 * walk off the hot path, as the room list rebuilds every room on every sync.
 */
export function roomAvatarMxc(room: Room, isDirect: boolean): string | null {
  const ownAvatar = room.getMxcAvatarUrl();
  if (ownAvatar || !isDirect) {
    return ownAvatar ?? null;
  }
  // Optional-called like the other Room reads here so a spec's Room stub degrades to an
  // initial rather than throwing.
  return room.getAvatarFallbackMember?.()?.getMxcAvatarUrl() ?? null;
}
