import type { Room, RoomMember } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { roomAvatarMxc } from './room-avatar';

function fakeRoom(
  roomAvatar: string | null,
  fallbackMemberAvatar?: string | null,
): Room {
  const member = { getMxcAvatarUrl: () => fallbackMemberAvatar ?? undefined };
  return {
    getMxcAvatarUrl: () => roomAvatar,
    getAvatarFallbackMember: () =>
      fallbackMemberAvatar === undefined
        ? undefined
        : (member as unknown as RoomMember),
  } as unknown as Room;
}

describe('roomAvatarMxc', () => {
  it("prefers the room's own avatar", () => {
    expect(roomAvatarMxc(fakeRoom('mxc://hs/room', 'mxc://hs/person'))).toBe(
      'mxc://hs/room',
    );
  });

  it("falls back to the other person's avatar in a DM", () => {
    // The bug this exists for: a DM is not given an `m.room.avatar`, so reading only the
    // state event left every 1:1 conversation on a coloured initial.
    expect(roomAvatarMxc(fakeRoom(null, 'mxc://hs/person'))).toBe(
      'mxc://hs/person',
    );
  });

  it('stays null for a group room with no avatar', () => {
    // The SDK returns no fallback member once a room has more than two real members,
    // so an initial is the right answer and must not be replaced by a random member.
    expect(roomAvatarMxc(fakeRoom(null))).toBeNull();
  });

  it('stays null when the other person has no avatar either', () => {
    expect(roomAvatarMxc(fakeRoom(null, null))).toBeNull();
  });
});
