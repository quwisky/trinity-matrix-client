import type { Room, RoomMember } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { roomAvatarMxc } from './room-avatar';

/**
 * `fallbackAvatar` models what the SDK really does: it offers a stand-in member for ANY
 * room of two or fewer members, so passing `undefined` here would be modelling a room
 * with three or more, not a group room in general.
 */
function fakeRoom(roomAvatar: string | null, fallbackAvatar?: string | null) {
  const member = { getMxcAvatarUrl: () => fallbackAvatar ?? undefined };
  const getAvatarFallbackMember = vi.fn(() =>
    fallbackAvatar === undefined
      ? undefined
      : (member as unknown as RoomMember),
  );
  return {
    room: {
      getMxcAvatarUrl: () => roomAvatar,
      getAvatarFallbackMember,
    } as unknown as Room,
    getAvatarFallbackMember,
  };
}

describe('roomAvatarMxc', () => {
  it("prefers the room's own avatar", () => {
    const { room } = fakeRoom('mxc://hs/room', 'mxc://hs/person');
    expect(roomAvatarMxc(room, true)).toBe('mxc://hs/room');
  });

  it("falls back to the other person's avatar in a DM", () => {
    // The bug this exists for: a DM is not given an `m.room.avatar`, so reading only the
    // state event left every 1:1 conversation on a coloured initial.
    const { room } = fakeRoom(null, 'mxc://hs/person');
    expect(roomAvatarMxc(room, true)).toBe('mxc://hs/person');
  });

  it('never uses a member as the avatar when the room is not a DM', () => {
    // The SDK's own guard is a member COUNT, not DM-ness, so it happily offers a member
    // for a two-person named group room and for every invite (whose stripped state has
    // only two memberships whatever the room's real size). Trusting it would put a
    // stranger's face on a room, and take it away again when a third person joined.
    const { room, getAvatarFallbackMember } = fakeRoom(null, 'mxc://hs/person');

    expect(roomAvatarMxc(room, false)).toBeNull();
    // Not merely discarded — never asked for. The SDK walks the whole member array
    // before its own bail-out, and the room list rebuilds every room on every sync.
    expect(getAvatarFallbackMember).not.toHaveBeenCalled();
  });

  it('stays null when the other person has no avatar either', () => {
    const { room } = fakeRoom(null, null);
    expect(roomAvatarMxc(room, true)).toBeNull();
  });

  it('degrades to an initial when a Room stub has no fallback member at all', () => {
    // Matches the optional-call convention of the neighbouring Room reads, so a spec
    // stub that predates this helper keeps working instead of throwing.
    const room = { getMxcAvatarUrl: () => null } as unknown as Room;
    expect(roomAvatarMxc(room, true)).toBeNull();
  });
});
