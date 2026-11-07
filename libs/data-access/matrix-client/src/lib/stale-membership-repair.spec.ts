import {
  EventType,
  KnownMembership,
  MatrixEvent,
  Room,
  RoomEvent,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import { repairStaleMembership } from './stale-membership-repair';

const ROOM = '!r:hs';
const ALICE = '@alice:hs';
const BOB = '@bob:hs';

let ts = 0;

function event(
  id: string,
  type: string,
  stateKey: string,
  content: Record<string, unknown>,
  replacesState?: string,
): MatrixEvent {
  return new MatrixEvent({
    event_id: id,
    room_id: ROOM,
    type,
    state_key: stateKey,
    sender: stateKey === BOB ? BOB : ALICE,
    origin_server_ts: ++ts,
    content,
    unsigned: replacesState ? { replaces_state: replacesState } : {},
  });
}

const member = (
  id: string,
  userId: string,
  membership: string,
  replacesState?: string,
) => event(id, EventType.RoomMember, userId, { membership }, replacesState);

/** A members-only encrypted room where Alice has invited Bob. */
function setup(): { client: MatrixClient; room: Room } {
  const client = createClient({
    baseUrl: 'https://hs',
    userId: ALICE,
    fetchFn: () => Promise.reject(new Error('no network in unit tests')),
  });
  const room = new Room(ROOM, client, ALICE);
  room.on(RoomEvent.Timeline, (...args) =>
    client.emit(RoomEvent.Timeline, ...args),
  );
  room.getLiveTimeline().initialiseState([
    event('$create', EventType.RoomCreate, '', { creator: ALICE }),
    member('$alice', ALICE, KnownMembership.Join),
    event('$enc', EventType.RoomEncryption, '', {
      algorithm: 'm.megolm.v1.aes-sha2',
    }),
    event('$hv', EventType.RoomHistoryVisibility, '', {
      history_visibility: 'joined',
    }),
    member('$invite', BOB, KnownMembership.Invite),
  ]);
  return { client, room };
}

/** What sync.ts does with a `state_after` response: state first, then timeline without state. */
async function sync(
  room: Room,
  stateAfter: MatrixEvent[],
  timeline: MatrixEvent[],
): Promise<void> {
  room.currentState.setStateEvents(stateAfter);
  await room.addLiveEvents(timeline, { addToState: false });
}

async function targets(room: Room): Promise<string[]> {
  return (await room.getEncryptionTargetMembers()).map((m) => m.userId);
}

describe('repairStaleMembership', () => {
  it('encrypts for a member whose join the timeline has but a lagging state_after still lists as invited', async () => {
    const { client, room } = setup();
    repairStaleMembership(client);

    await sync(
      room,
      [member('$invite', BOB, KnownMembership.Invite)],
      [member('$join', BOB, KnownMembership.Join, '$invite')],
    );

    expect(room.getMember(BOB)?.membership).toBe(KnownMembership.Join);
    expect(await targets(room)).toEqual([ALICE, BOB]);
  });

  it('does not encrypt for a member who left after joining in the same timeline', async () => {
    const { client, room } = setup();
    repairStaleMembership(client);

    await sync(
      room,
      [member('$invite', BOB, KnownMembership.Invite)],
      [
        member('$join', BOB, KnownMembership.Join, '$invite'),
        member('$leave', BOB, KnownMembership.Leave, '$join'),
      ],
    );

    expect(room.getMember(BOB)?.membership).toBe(KnownMembership.Leave);
    expect(await targets(room)).toEqual([ALICE]);
  });

  it('keeps the state when state_after has moved past the event the join replaced', async () => {
    const { client, room } = setup();
    repairStaleMembership(client);

    await sync(
      room,
      [member('$ban', BOB, KnownMembership.Ban, '$invite')],
      [member('$join', BOB, KnownMembership.Join, '$invite')],
    );

    expect(room.getMember(BOB)?.membership).toBe(KnownMembership.Ban);
    expect(await targets(room)).toEqual([ALICE]);
  });

  it('ignores membership events paginated into the past', async () => {
    const { client, room } = setup();
    repairStaleMembership(client);

    await room.addEventsToTimeline(
      [member('$join', BOB, KnownMembership.Join, '$invite')],
      true,
      false,
      room.getLiveTimeline(),
    );

    expect(room.getMember(BOB)?.membership).toBe(KnownMembership.Invite);
  });

  it('stops repairing once stopped', async () => {
    const { client, room } = setup();
    repairStaleMembership(client)();

    await sync(
      room,
      [member('$invite', BOB, KnownMembership.Invite)],
      [member('$join', BOB, KnownMembership.Join, '$invite')],
    );

    expect(room.getMember(BOB)?.membership).toBe(KnownMembership.Invite);
  });
});
