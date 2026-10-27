import {
  RoomEvent,
  RoomMemberEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import { Observable } from 'rxjs';
import { coalesce } from '@trinity/data-access/matrix-client';
import type { TypingMember } from '../room-list-engine';

type TypingByRoom = Readonly<Record<string, readonly TypingMember[]>>;

/** The room's WHOLE typing set from an `m.typing` EDU: there is no delta to merge. */
export function typingUserIds(event: MatrixEvent): string[] {
  const userIds = event.getContent()?.['user_ids'];
  return Array.isArray(userIds) ? (userIds as string[]) : [];
}

/**
 * Each typist with their room display name, or their id. O(typists): `getMembers()` is
 * O(members), fine for one open room and not for every joined room on every typing change.
 */
export function typingMembers(
  room: Room | null | undefined,
  userIds: readonly string[],
): TypingMember[] {
  return userIds.map((userId) => ({
    userId,
    displayName: room?.getMember(userId)?.name ?? userId,
  }));
}

function sameMembers(
  a: readonly TypingMember[],
  b: readonly TypingMember[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (m, i) => m.userId === b[i].userId && m.displayName === b[i].displayName,
    )
  );
}

/**
 * Who is typing in each of `client`'s joined rooms, own user included. Emits the current
 * set on subscribe, then one record per microtask that changed it.
 */
export function roomTyping(client: MatrixClient): Observable<TypingByRoom> {
  return new Observable<TypingByRoom>((subscriber) => {
    let current: Record<string, readonly TypingMember[]> = {};
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== 'join') continue;
      const typing = room.getMembers().filter((member) => member.typing);
      if (typing.length) {
        current[room.roomId] = typingMembers(
          room,
          typing.map((member) => member.userId),
        );
      }
    }
    const dirty = new Map<string, string[]>();

    const flusher = coalesce(() => {
      let next = current;
      for (const [roomId, userIds] of dirty) {
        const members = typingMembers(client.getRoom(roomId), userIds);
        if (sameMembers(next[roomId] ?? [], members)) continue;
        if (next === current) next = { ...current };
        if (members.length) next[roomId] = members;
        else delete next[roomId];
      }
      dirty.clear();
      if (next !== current) {
        current = next;
        subscriber.next(current);
      }
    });

    const onTyping = (event: MatrixEvent, member: RoomMember): void => {
      dirty.set(member.roomId, typingUserIds(event));
      flusher.schedule();
    };
    // A room we have left stops syncing, so its members never emit "stopped typing".
    const onMyMembership = (room: Room): void => {
      dirty.delete(room.roomId);
      if (room.roomId in current) {
        const { [room.roomId]: _, ...rest } = current;
        current = rest;
        subscriber.next(current);
      }
    };

    subscriber.next(current);
    client.on(RoomMemberEvent.Typing, onTyping);
    client.on(RoomEvent.MyMembership, onMyMembership);
    return () => {
      flusher.cancel();
      client.off(RoomMemberEvent.Typing, onTyping);
      client.off(RoomEvent.MyMembership, onMyMembership);
    };
  });
}
