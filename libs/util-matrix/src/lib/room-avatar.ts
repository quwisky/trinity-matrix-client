import type { Room } from 'matrix-js-sdk';

/**
 * The `mxc://` avatar to show for a room: its own `m.room.avatar` if it has one, and
 * otherwise — for a direct message — the other person's.
 *
 * Reading only the state event is what leaves every 1:1 conversation showing a coloured
 * initial, because a DM is not normally given a room avatar at all. The name beside it
 * *does* resolve to the other person (`room.name` falls back to the server's heroes
 * summary), so the row ends up naming someone whose face it refuses to show.
 *
 * `getAvatarFallbackMember()` is the SDK's own answer, and is preferred to picking a
 * member by hand: it reads the heroes summary first (which is all a lazy-loaded room has
 * before its members arrive), ignores functional members — bots and widgets, per the
 * `io.element.functional_members` convention — and still resolves the other side of a DM
 * whose peer has since left. It returns nothing once a room has more than two real
 * members, so a group room with no avatar keeps its initial, which is correct.
 */
export function roomAvatarMxc(room: Room): string | null {
  return (
    room.getMxcAvatarUrl() ??
    room.getAvatarFallbackMember()?.getMxcAvatarUrl() ??
    null
  );
}
