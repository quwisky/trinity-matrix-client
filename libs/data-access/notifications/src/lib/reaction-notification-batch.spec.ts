import {
  EventType,
  MatrixEvent,
  RelationType,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactionNotificationBatch } from './reaction-notification-batch';

const ACCOUNT = '@me:hs';
const ROOM = '!room:hs';

function message(id = '$target', sender = ACCOUNT) {
  return new MatrixEvent({
    event_id: id,
    room_id: ROOM,
    sender,
    type: EventType.RoomMessage,
    content: { msgtype: 'm.text', body: 'Please review the release notes' },
  });
}

function reaction(
  id: string,
  sender = '@alice:hs',
  target = '$target',
  key = '👍',
) {
  return new MatrixEvent({
    event_id: id,
    room_id: ROOM,
    sender,
    type: EventType.Reaction,
    content: {
      'm.relates_to': {
        rel_type: RelationType.Annotation,
        event_id: target,
        key,
      },
    },
  });
}

function setup() {
  const targets = new Map([['$target', message()]]);
  const room = {
    roomId: ROOM,
    name: 'General',
    findEventById: vi.fn((id: string) => targets.get(id)),
    getMember: (id: string) => ({ name: id === '@alice:hs' ? 'Alice' : id }),
  } as unknown as Room;
  const client = {
    getUserId: () => ACCOUNT,
    fetchRoomEvent: vi
      .fn<MatrixClient['fetchRoomEvent']>()
      .mockResolvedValue(message().event),
    getEventMapper: vi.fn(
      () => (raw: MatrixEvent['event']) => new MatrixEvent(raw),
    ),
    decryptEventIfNeeded: vi
      .fn<MatrixClient['decryptEventIfNeeded']>()
      .mockResolvedValue(undefined),
  };
  const allowed = vi.fn(() => true);
  const present = vi.fn();
  const batch = new ReactionNotificationBatch({
    accountId: ACCOUNT,
    client: client as unknown as MatrixClient,
    allowed,
    present,
  });
  return { targets, room, client, allowed, present, batch };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ReactionNotificationBatch', () => {
  it('groups five people into one notification for the original message', async () => {
    const { batch, room, present } = setup();
    for (let i = 0; i < 5; i++) {
      batch.add(
        reaction(`$reaction${i}`, i ? `@user${i}:hs` : '@alice:hs'),
        room,
      );
    }
    await vi.advanceTimersByTimeAsync(1999);
    expect(present).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(present).toHaveBeenCalledExactlyOnceWith({
      kind: 'reaction',
      accountId: ACCOUNT,
      roomId: ROOM,
      eventId: '$target',
      senderId: '@alice:hs',
      senderName: 'Alice',
      senderCount: 5,
      reactionKeys: ['👍'],
      roomName: 'General',
      body: 'Please review the release notes',
    });
  });

  it('counts people once across multiple emojis and deduplicates reaction events', async () => {
    const { batch, room, present } = setup();
    batch.add(reaction('$one'), room);
    batch.add(reaction('$one'), room);
    batch.add(reaction('$two', '@alice:hs', '$target', '✅'), room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        senderCount: 1,
        reactionKeys: ['👍', '✅'],
      }),
    );
    batch.add(reaction('$one'), room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('waits for a quiet period but flushes a continuous burst within ten seconds', async () => {
    const { batch, room, present } = setup();
    for (let i = 0; i < 10; i++) {
      batch.add(reaction(`$reaction${i}`), room);
      await vi.advanceTimersByTimeAsync(1000);
      if (i < 9) expect(present).not.toHaveBeenCalled();
    }
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('keeps different message targets separate', async () => {
    const { batch, targets, room, present } = setup();
    targets.set('$second', message('$second'));
    batch.add(reaction('$one'), room);
    batch.add(reaction('$two', '@bob:hs', '$second'), room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present.mock.calls.map(([event]) => event.eventId)).toEqual([
      '$target',
      '$second',
    ]);
  });

  it('never notifies for own reactions or someone else’s message', async () => {
    const { batch, targets, room, present } = setup();
    targets.set('$other', message('$other', '@bob:hs'));
    batch.add(reaction('$own', ACCOUNT), room);
    batch.add(reaction('$other-reaction', '@alice:hs', '$other'), room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).not.toHaveBeenCalled();
  });

  it('ignores malformed relations, cross-room events and redacted reactions', async () => {
    const { batch, room, present, client } = setup();
    const malformed = reaction('$bad');
    malformed.event.content = {
      'm.relates_to': { rel_type: 'm.reference', event_id: '$target' },
    };
    const wrongRoom = reaction('$wrong-room');
    wrongRoom.event.room_id = '!different:hs';
    const redacted = reaction('$redacted');
    vi.spyOn(redacted, 'isRedacted').mockReturnValue(true);
    for (const event of [malformed, wrongRoom, redacted])
      batch.add(event, room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).not.toHaveBeenCalled();
    expect(client.fetchRoomEvent).not.toHaveBeenCalled();
  });

  it('rechecks eligibility and redactions at delivery time', async () => {
    const { batch, room, present, targets } = setup();
    const removed = reaction('$removed');
    batch.add(removed, room);
    batch.add(reaction('$kept', '@bob:hs'), room);
    vi.spyOn(removed, 'isRedacted').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        senderId: '@bob:hs',
        senderCount: 1,
      }),
    );
    batch.add(reaction('$target-removed'), room);
    vi.spyOn(targets.get('$target')!, 'isRedacted').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('fetches a missing target once and includes reactions arriving during lookup', async () => {
    const { batch, room, present, targets, client } = setup();
    targets.clear();
    let resolve!: (value: MatrixEvent['event']) => void;
    client.fetchRoomEvent.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    batch.add(reaction('$one'), room);
    await vi.advanceTimersByTimeAsync(2000);
    batch.add(reaction('$two', '@bob:hs'), room);
    resolve(message().event);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.fetchRoomEvent).toHaveBeenCalledExactlyOnceWith(
      ROOM,
      '$target',
    );
    expect(client.getEventMapper).toHaveBeenCalledWith({ decrypt: false });
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ senderCount: 2 }),
    );
  });

  it('decrypts an encrypted target before using its preview', async () => {
    const { batch, room, present, targets, client } = setup();
    const encrypted = new MatrixEvent({
      event_id: '$target',
      room_id: ROOM,
      sender: ACCOUNT,
      type: EventType.RoomMessageEncrypted,
      content: { ciphertext: 'private' },
    });
    targets.set('$target', encrypted);
    client.decryptEventIfNeeded.mockImplementation(async (event) => {
      vi.spyOn(event, 'getType').mockReturnValue(EventType.RoomMessage);
      vi.spyOn(event, 'getContent').mockReturnValue({
        body: 'Decrypted preview',
      });
      vi.spyOn(event, 'getClearContent').mockReturnValue({
        body: 'Decrypted preview',
      });
    });
    batch.add(reaction('$one'), room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.decryptEventIfNeeded).toHaveBeenCalledWith(encrypted);
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ body: 'Decrypted preview' }),
    );
  });

  it('suppresses lookup failures and undecryptable targets', async () => {
    const { batch, room, present, targets, client } = setup();
    targets.clear();
    client.fetchRoomEvent.mockRejectedValue(new Error('Unavailable'));
    batch.add(reaction('$one'), room);
    await vi.advanceTimersByTimeAsync(2000);
    targets.set(
      '$target',
      new MatrixEvent({
        event_id: '$target',
        room_id: ROOM,
        sender: ACCOUNT,
        type: EventType.RoomMessageEncrypted,
        content: { ciphertext: 'private' },
      }),
    );
    client.decryptEventIfNeeded.mockRejectedValue(new Error('Missing key'));
    batch.add(reaction('$two'), room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).not.toHaveBeenCalled();
  });

  it('drops batches if the preference, mute or owning client changes', async () => {
    const { batch, room, present, allowed } = setup();
    batch.add(reaction('$one'), room);
    allowed.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).not.toHaveBeenCalled();
  });

  it('cancels timers and ignores a fetched target after disposal', async () => {
    const { batch, room, present, targets, client } = setup();
    targets.clear();
    let resolve!: (value: MatrixEvent['event']) => void;
    client.fetchRoomEvent.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    batch.add(reaction('$one'), room);
    await vi.advanceTimersByTimeAsync(2000);
    batch.dispose();
    resolve(message().event);
    batch.add(reaction('$two'), room);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(present).not.toHaveBeenCalled();
    expect(client.fetchRoomEvent).toHaveBeenCalledTimes(1);
  });

  it('releases a timed-out lookup and ignores its late result', async () => {
    const { batch, room, present, targets, client } = setup();
    targets.clear();
    let resolve!: (value: MatrixEvent['event']) => void;
    client.fetchRoomEvent.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    batch.add(reaction('$stalled'), room);
    await vi.advanceTimersByTimeAsync(12_000);
    resolve(message().event);
    await vi.advanceTimersByTimeAsync(0);
    expect(present).not.toHaveBeenCalled();

    targets.set('$target', message());
    batch.add(reaction('$later'), room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledTimes(1);
  });
});
