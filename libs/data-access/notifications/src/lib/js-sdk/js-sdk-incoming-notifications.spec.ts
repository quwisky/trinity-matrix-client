import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
  RelationType,
  RoomEvent,
  SyncState,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import type { IncomingNotification } from '../notification-engine';
import { JsSdkNotificationEngine } from './js-sdk-notification-engine';

const ME = '@me:hs';
const ROOM = '!r:hs';

function message(
  opts: {
    id?: string;
    sender?: string;
    body?: string;
    /** Encrypted, with cleartext not yet available. */
    encrypted?: boolean;
    /** Encrypted and decrypted. */
    decrypted?: boolean;
    /** Encrypted and decryption failed. */
    failure?: boolean;
    /** An edit attached to the message. */
    editedBy?: { sender: string; body: string; encrypted?: boolean };
  } = {},
) {
  const isEncrypted = !!(opts.encrypted || opts.decrypted || opts.failure);
  const own = { body: opts.body ?? 'hello there' };
  const edit = opts.editedBy && {
    getSender: () => opts.editedBy?.sender,
    getType: () => 'm.room.message',
    getRelation: () => ({
      rel_type: 'm.replace',
      event_id: opts.id ?? '$event',
    }),
    getOriginalContent: () => ({
      'm.new_content': { body: opts.editedBy?.body },
    }),
    isEncrypted: () => opts.editedBy?.encrypted ?? false,
    getClearContent: () => (opts.editedBy?.encrypted ? {} : null),
  };
  return {
    getId: () => opts.id ?? '$event',
    getRoomId: () => ROOM,
    getSender: () => opts.sender ?? '@alice:hs',
    sender: { name: 'Alice' },
    getType: () => 'm.room.message',
    getOriginalContent: () => own,
    isRedacted: () => false,
    replacingEvent: () => edit ?? null,
    isRelation: () => false,
    isEncrypted: () => isEncrypted,
    getClearContent: () => (opts.decrypted ? own : null),
    isDecryptionFailure: () => !!opts.failure,
  };
}

function reaction(
  id: string,
  sender = '@alice:hs',
  target = '$target',
  key = '👍',
): MatrixEvent {
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

function ownMessage(id = '$target', sender = ME): MatrixEvent {
  return new MatrixEvent({
    event_id: id,
    room_id: ROOM,
    sender,
    type: EventType.RoomMessage,
    content: { msgtype: 'm.text', body: 'Please review the release notes' },
  });
}

function fakeClient() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const events = new Map<string, MatrixEvent>();
  const room = {
    roomId: ROOM,
    name: 'General',
    hasEncryptionStateEvent: vi.fn(() => false),
    findEventById: vi.fn((id: string) => events.get(id)),
    getMember: (id: string) => ({ name: id === '@alice:hs' ? 'Alice' : id }),
  };
  const client = {
    room,
    events,
    getUserId: () => ME,
    getSyncState: vi.fn((): SyncState | null => SyncState.Syncing),
    getPushActionsForEvent: vi.fn(() => ({ notify: true, tweaks: {} })),
    getRoom: vi.fn(() => room),
    getRooms: vi.fn(() => [room]),
    getCrypto: vi.fn((): unknown => undefined),
    isUserIgnored: vi.fn((_id: string) => false),
    fetchRoomEvent: vi.fn(async (_roomId: string, id: string) => {
      throw new Error(`No ${id}`);
    }),
    getEventMapper: vi.fn(
      () => (raw: MatrixEvent['event']) => new MatrixEvent(raw),
    ),
    decryptEventIfNeeded: vi.fn(async (_event: MatrixEvent) => undefined),
    on(event: string, fn: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(
        fn,
      );
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    /** A live timeline event, as sync delivers it. */
    live(event: unknown, liveEvent = true) {
      client.emit(RoomEvent.Timeline, event, room, false, false, { liveEvent });
    },
  };
  return client;
}

describe('JsSdkNotificationEngine incoming notifications', () => {
  let client: ReturnType<typeof fakeClient>;
  let current: ReturnType<typeof fakeClient> | null;
  let engine: JsSdkNotificationEngine;
  let items: IncomingNotification[];

  function subscribe() {
    return engine.notifications(ME).subscribe((item) => items.push(item));
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    client = fakeClient();
    current = client;
    items = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: { clientFor: (id: string) => (id === ME ? current : null) },
        },
      ],
    });
    engine = TestBed.inject(JsSdkNotificationEngine);
  });

  it('emits a live message the push rules notify, as plain data', () => {
    subscribe();

    client.live(message());

    expect(items).toEqual([
      {
        kind: 'message',
        accountId: ME,
        roomId: ROOM,
        eventId: '$event',
        senderId: '@alice:hs',
        senderName: 'Alice',
        roomName: 'General',
        body: 'hello there',
      },
    ]);
    expect(client.getPushActionsForEvent).toHaveBeenCalledWith(
      expect.anything(),
      false,
    );
  });

  it('leaves out backfill, own messages and what the push rules do not notify', () => {
    subscribe();

    client.live(message({ id: '$backfill' }), false);
    client.live(message({ id: '$own', sender: ME }));
    client.getPushActionsForEvent.mockReturnValueOnce({
      notify: false,
      tweaks: {},
    });
    client.live(message({ id: '$quiet' }));

    expect(items).toEqual([]);
  });

  it('ignores initial-sync history before the first prepared or syncing state', () => {
    client.getSyncState.mockReturnValue(null);
    subscribe();

    client.live(message({ id: '$history' }));
    client.emit(ClientEvent.Sync, SyncState.Error);
    client.live(message({ id: '$after-error' }));
    client.emit(ClientEvent.Sync, SyncState.Reconnecting);
    client.live(message({ id: '$reconnecting' }));
    client.emit(ClientEvent.Sync, SyncState.Prepared);
    client.live(message({ id: '$ready' }));

    expect(items.map((item) => item.eventId)).toEqual(['$ready']);
  });

  it('swallows a failure inside the sync emit loop', () => {
    subscribe();
    client.getPushActionsForEvent.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => client.live(message())).not.toThrow();
    expect(items).toEqual([]);
  });

  it('detaches its listeners on unsubscribe, and emits nothing once the client is replaced', () => {
    const subscription = subscribe();
    expect(client.listenerCount()).toBe(3);

    current = fakeClient();
    client.live(message());
    expect(items).toEqual([]);

    subscription.unsubscribe();
    expect(client.listenerCount()).toBe(0);
  });

  it('emits nothing for an account without a live client', () => {
    current = null;
    subscribe();

    expect(items).toEqual([]);
  });

  describe('E2EE', () => {
    it('notifies an encrypted live event once it decrypts, scoring the cleartext', () => {
      subscribe();

      client.live(message({ id: '$e1', encrypted: true }));
      expect(items).toEqual([]);

      client.emit(
        MatrixEventEvent.Decrypted,
        message({ id: '$e1', decrypted: true }),
      );
      // A retried decryption does not notify again.
      client.emit(
        MatrixEventEvent.Decrypted,
        message({ id: '$e1', decrypted: true }),
      );

      expect(items.map((item) => item.eventId)).toEqual(['$e1']);
      expect(client.getPushActionsForEvent).toHaveBeenCalledWith(
        expect.anything(),
        true,
      );
    });

    it('ignores the decryption of an event it never saw live', () => {
      subscribe();

      client.emit(
        MatrixEventEvent.Decrypted,
        message({ id: '$b1', decrypted: true }),
      );

      expect(items).toEqual([]);
    });

    it('keeps a failed decryption pending until a retry succeeds', () => {
      subscribe();

      client.live(message({ id: '$e2', encrypted: true }));
      client.emit(
        MatrixEventEvent.Decrypted,
        message({ id: '$e2', failure: true }),
      );
      expect(items).toEqual([]);

      client.emit(
        MatrixEventEvent.Decrypted,
        message({ id: '$e2', decrypted: true }),
      );
      expect(items.map((item) => item.eventId)).toEqual(['$e2']);
    });

    it('does not preview text sent in the clear into an encrypted room', () => {
      client.room.hasEncryptionStateEvent.mockReturnValue(true);
      subscribe();

      client.live(message({ body: 'sent in the clear' }));

      expect(items).toMatchObject([{ kind: 'message', body: null }]);
    });

    it('does not preview plaintext when only the crypto store knows the room is encrypted', async () => {
      const isEncryptionEnabledInRoom = vi.fn(() => Promise.resolve(true));
      client.getCrypto.mockReturnValue({ isEncryptionEnabledInRoom });
      subscribe();
      await vi.waitFor(() =>
        expect(isEncryptionEnabledInRoom).toHaveBeenCalledWith(ROOM),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      client.live(message({ body: 'sent in the clear' }));

      expect(items).toMatchObject([{ body: null }]);
    });

    it('previews a decrypted message, with only an encrypted edit by its sender', () => {
      client.room.hasEncryptionStateEvent.mockReturnValue(true);
      subscribe();
      const decrypt = (event: ReturnType<typeof message>) => {
        client.live(message({ id: event.getId(), encrypted: true }));
        client.emit(MatrixEventEvent.Decrypted, event);
      };

      decrypt(message({ id: '$plain', decrypted: true, body: 'sealed' }));
      decrypt(
        message({
          id: '$clear-edit',
          decrypted: true,
          body: 'sealed',
          editedBy: { sender: '@alice:hs', body: 'in the clear' },
        }),
      );
      decrypt(
        message({
          id: '$sealed-edit',
          decrypted: true,
          body: 'sealed',
          editedBy: {
            sender: '@alice:hs',
            body: 'sealed edit',
            encrypted: true,
          },
        }),
      );

      expect(
        items.map((item) => [item.eventId, 'body' in item && item.body]),
      ).toEqual([
        ['$plain', 'sealed'],
        ['$clear-edit', 'sealed'],
        ['$sealed-edit', 'sealed edit'],
      ]);
    });

    it("previews what a message's sender wrote, not someone else's edit of it", () => {
      subscribe();

      client.live(message({ editedBy: { sender: '@m:hs', body: 'forged' } }));

      expect(items).toMatchObject([{ body: 'hello there' }]);
    });
  });

  describe('reactions', () => {
    it('emits an annotation by someone else, whatever the push rules say', () => {
      client.getPushActionsForEvent.mockReturnValue({
        notify: false,
        tweaks: {},
      });
      subscribe();

      client.live(reaction('$r1'));

      expect(items).toEqual([
        {
          kind: 'reaction-annotation',
          accountId: ME,
          roomId: ROOM,
          roomName: 'General',
          eventId: '$r1',
          targetEventId: '$target',
          key: '👍',
          senderId: '@alice:hs',
          senderName: 'Alice',
        },
      ]);
    });

    it('leaves out own, ignored, redacted, cross-room and malformed reactions, and backfill', () => {
      client.isUserIgnored.mockImplementation((id) => id === '@ignored:hs');
      subscribe();
      const malformed = reaction('$bad');
      malformed.event.content = {
        'm.relates_to': { rel_type: 'm.reference', event_id: '$target' },
      };
      const blankKey = reaction('$blank', '@alice:hs', '$target', ' ');
      const wrongRoom = reaction('$wrong-room');
      wrongRoom.event.room_id = '!different:hs';
      const redacted = reaction('$redacted');
      vi.spyOn(redacted, 'isRedacted').mockReturnValue(true);

      for (const event of [
        reaction('$own', ME),
        reaction('$ignored', '@ignored:hs'),
        malformed,
        blankKey,
        wrongRoom,
        redacted,
      ]) {
        client.live(event);
      }
      client.live(reaction('$history'), false);

      expect(items).toEqual([]);
    });

    it('emits an encrypted reaction once it decrypts', () => {
      subscribe();
      const encrypted = reaction('$sealed');
      vi.spyOn(encrypted, 'isEncrypted').mockReturnValue(true);
      vi.spyOn(encrypted, 'getClearContent').mockReturnValue(null);

      client.live(encrypted);
      expect(items).toEqual([]);

      client.emit(MatrixEventEvent.Decrypted, reaction('$sealed'));
      expect(items.map((item) => item.kind)).toEqual(['reaction-annotation']);
    });
  });

  describe('reactionTarget', () => {
    async function target(reactionIds = ['$r1'], targetId = '$target') {
      const result = await firstValueFrom(
        engine.reactionTarget(ME, ROOM, targetId, reactionIds),
      );
      if (!result.ok) throw new Error(result.failure.code);
      return result.value;
    }

    let first: MatrixEvent;

    beforeEach(() => {
      subscribe();
      client.events.set('$target', ownMessage());
      first = reaction('$r1');
      // Handed out by the feed, not found in the timeline.
      client.live(first);
      client.live(reaction('$r2', '@bob:hs'));
    });

    it('returns the own message’s preview and the live reactions', async () => {
      await expect(target(['$r1', '$r2'])).resolves.toEqual({
        body: 'Please review the release notes',
        liveReactionIds: ['$r1', '$r2'],
      });
    });

    it('leaves out redacted reactions and those of a sender since ignored', async () => {
      vi.spyOn(first, 'isRedacted').mockReturnValue(true);
      client.isUserIgnored.mockImplementation((id) => id === '@bob:hs');

      await expect(target(['$r1', '$r2'])).resolves.toBeNull();
    });

    it('finds a reaction it did not hand out in the timeline', async () => {
      client.events.set('$r3', reaction('$r3', '@carol:hs'));
      await expect(target(['$r3', '$unknown'])).resolves.toMatchObject({
        liveReactionIds: ['$r3'],
      });
    });

    it('returns null for someone else’s message or a redacted one', async () => {
      client.events.set('$other', ownMessage('$other', '@bob:hs'));
      await expect(target(['$r1'], '$other')).resolves.toBeNull();

      vi.spyOn(client.events.get('$target')!, 'isRedacted').mockReturnValue(
        true,
      );
      await expect(target(['$r1'])).resolves.toBeNull();
    });

    it('fetches a target missing from the timeline without decrypting it in the mapper', async () => {
      client.events.delete('$target');
      client.fetchRoomEvent.mockResolvedValue(ownMessage().event as never);

      await expect(target()).resolves.toMatchObject({
        body: 'Please review the release notes',
      });
      expect(client.fetchRoomEvent).toHaveBeenCalledExactlyOnceWith(
        ROOM,
        '$target',
      );
      expect(client.getEventMapper).toHaveBeenCalledWith({ decrypt: false });
    });

    it('fails when the fetch fails', async () => {
      client.events.delete('$target');
      const result = await firstValueFrom(
        engine.reactionTarget(ME, ROOM, '$target', ['$r1']),
      );
      expect(result).toMatchObject({
        ok: false,
        failure: { code: 'request-failed' },
      });
    });

    it('decrypts an encrypted target before previewing it, and drops an undecryptable one', async () => {
      const encrypted = new MatrixEvent({
        event_id: '$target',
        room_id: ROOM,
        sender: ME,
        type: EventType.RoomMessageEncrypted,
        content: { ciphertext: 'private' },
      });
      client.events.set('$target', encrypted);
      client.decryptEventIfNeeded.mockImplementationOnce(async (event) => {
        vi.spyOn(event, 'getType').mockReturnValue(EventType.RoomMessage);
        vi.spyOn(event, 'getClearContent').mockReturnValue({ body: 'x' });
        vi.spyOn(event, 'getOriginalContent').mockReturnValue({
          body: 'Decrypted preview',
        });
      });

      await expect(target()).resolves.toMatchObject({
        body: 'Decrypted preview',
      });
      expect(client.decryptEventIfNeeded).toHaveBeenCalledWith(encrypted);

      client.events.set(
        '$target',
        new MatrixEvent({
          event_id: '$target',
          room_id: ROOM,
          sender: ME,
          type: EventType.RoomMessageEncrypted,
          content: { ciphertext: 'private' },
        }),
      );
      await expect(target()).resolves.toBeNull();
    });

    it("previews what the message's sender wrote, and nothing sent in the clear into an encrypted room", async () => {
      const forged = ownMessage();
      forged.makeReplaced(
        new MatrixEvent({
          event_id: '$forged',
          room_id: ROOM,
          sender: '@mallory:hs',
          type: EventType.RoomMessage,
          content: {
            body: '* forged',
            'm.new_content': { body: 'forged' },
            'm.relates_to': {
              rel_type: RelationType.Replace,
              event_id: '$target',
            },
          },
        }),
      );
      client.events.set('$target', forged);
      await expect(target()).resolves.toMatchObject({
        body: 'Please review the release notes',
      });

      client.room.hasEncryptionStateEvent.mockReturnValue(true);
      await expect(target()).resolves.toMatchObject({ body: null });
    });

    it('previews the original, not a plaintext edit, of an encrypted message in an encrypted room', async () => {
      client.room.hasEncryptionStateEvent.mockReturnValue(true);
      const original = ownMessage();
      vi.spyOn(original, 'isEncrypted').mockReturnValue(true);
      vi.spyOn(original, 'getClearContent').mockReturnValue({ body: 'x' });
      original.makeReplaced(
        new MatrixEvent({
          event_id: '$edit',
          room_id: ROOM,
          sender: ME,
          type: EventType.RoomMessage,
          content: {
            body: '* in the clear',
            'm.new_content': { body: 'in the clear' },
            'm.relates_to': {
              rel_type: RelationType.Replace,
              event_id: '$target',
            },
          },
        }),
      );
      client.events.set('$target', original);

      await expect(target()).resolves.toMatchObject({
        body: 'Please review the release notes',
      });
    });
  });
});
