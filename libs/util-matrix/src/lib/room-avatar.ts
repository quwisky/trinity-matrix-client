import type { Room } from 'matrix-js-sdk';

/**
 * The `mxc://` avatar to show for a room: its own `m.room.avatar` if it has one, and
 * otherwise — for a direct message only — the other person's.
 *
 * Reading only the state event is what leaves every 1:1 conversation showing a coloured
 * initial, because a DM is not normally given a room avatar at all. The name beside it
 * *does* resolve to the other person (`room.name` falls back to the server's heroes
 * summary), so the row ends up naming someone whose face it refuses to show.
 *
 * `isDirect` must come from the caller — `m.direct` for a joined room, the invite event's
 * `is_direct` for an invite. It is NOT safe to let `getAvatarFallbackMember()` decide: it
 * bails out only above *two members* (`room.js:761`), which is a proxy for "DM" that two
 * common cases break. A named two-person group room would wear the other member's face
 * until a third person joined, and an invite is worse still — its stripped state contains
 * just the inviter's and our own membership whatever the room's real size, so every
 * group-room and space invite would show the inviter as the room's icon.
 *
 * Given a genuine DM, `getAvatarFallbackMember()` is still the right way to find the peer:
 * it reads the heroes summary first (all a lazy-loaded room has before its members
 * arrive), ignores functional members — bots and widgets, per the
 * `io.element.functional_members` convention — and resolves the other side even after they
 * have left. Gating on `isDirect` also keeps it off the hot path: it walks the room's
 * whole member array before its own bail-out, and the room list rebuilds every room on
 * every sync.
 */
export function roomAvatarMxc(room: Room, isDirect: boolean): string | null {
  const ownAvatar = room.getMxcAvatarUrl();
  if (ownAvatar || !isDirect) {
    return ownAvatar ?? null;
  }
  // Optional-called like the other Room reads here (`getLiveTimeline?.()`,
  // `getUsersReadUpTo?.()`), so a spec's Room stub degrades to an initial rather than
  // dying on a method it had no reason to implement.
  return room.getAvatarFallbackMember?.()?.getMxcAvatarUrl() ?? null;
}
