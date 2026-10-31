import {
  EventType,
  MatrixEvent,
  RelationType,
  SearchOrderBy,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSearchController } from './conversation-search.service';
import { scrollbackLive } from './live-scrollback';

// Paging itself is covered against the real SDK in live-scrollback.spec.
vi.mock('./live-scrollback', () => ({ scrollbackLive: vi.fn() }));

function message(over: {
  id: string;
  body: string;
  ts?: number;
  replace?: boolean;
  decryptionFailure?: boolean;
  encrypted?: boolean;
  /** An edit attached to the message: its sender and the text it would show. */
  editedBy?: { sender: string; body: string };
}) {
  const edit = over.editedBy && {
    getSender: () => over.editedBy?.sender,
    getType: () => EventType.RoomMessage,
    getRelation: () => ({ rel_type: RelationType.Replace, event_id: over.id }),
    getOriginalContent: () => ({
      'm.new_content': { body: over.editedBy?.body },
    }),
    isEncrypted: () => false,
    getClearContent: () => null,
  };
  return {
    getId: () => over.id,
    getType: () => EventType.RoomMessage,
    isState: () => false,
    isEncrypted: () => over.encrypted ?? false,
    status: null,
    getSender: () => '@alice:hs',
    getTs: () => over.ts ?? 0,
    // As the SDK does: an attached edit's m.new_content, checked or not.
    getContent: () =>
      edit ? edit.getOriginalContent()['m.new_content'] : { body: over.body },
    getOriginalContent: () => ({ body: over.body }),
    isRedacted: () => false,
    replacingEvent: () => edit ?? null,
    isDecryptionFailure: () => over.decryptionFailure ?? false,
    isRelation: (relation: string) =>
      over.replace === true && relation === RelationType.Replace,
  };
}

function room(options: {
  encrypted?: boolean;
  events?: ReturnType<typeof message>[];
}) {
  return {
    roomId: '!r:hs',
    hasEncryptionStateEvent: () => options.encrypted ?? false,
    getLiveTimeline: () => ({
      getEvents: () => options.events ?? [],
      getState: () => undefined,
    }),
    getMember: () => ({ name: 'Alice', getMxcAvatarUrl: () => null }),
  };
}

describe('ConversationSearchController', () => {
  let service: ConversationSearchController;
  const getRoom = vi.fn();
  const search = vi.fn();
  const isEncryptionEnabledInRoom = vi.fn();
  const getCrypto = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    isEncryptionEnabledInRoom.mockResolvedValue(false);
    getCrypto.mockReturnValue({ isEncryptionEnabledInRoom });
    service = new ConversationSearchController();
    service.attach({ accountId: '@me:hs', roomId: '!r:hs' }, {
      getRoom,
      search,
      getCrypto,
    } as unknown as MatrixClient);
  });

  it('searches only displayable decrypted events and orders by recency', () => {
    getRoom.mockReturnValue(
      room({
        events: [
          message({ id: '$old', body: 'hello old', ts: 1 }),
          message({ id: '$new', body: 'HELLO new', ts: 2 }),
          message({ id: '$edit', body: 'hello edit', replace: true }),
          message({ id: '$failed', body: 'hello', decryptionFailure: true }),
        ],
      }),
    );

    const result = service.searchLoaded('hello');

    expect(result.hits.map((hit) => hit.eventId)).toEqual(['$new', '$old']);
    expect(result.scanned).toBe(2);
  });

  it('neither finds nor counts a message deleted in an encrypted room', async () => {
    const deleted = new MatrixEvent({
      type: 'm.room.encrypted',
      event_id: '$deleted',
      sender: '@alice:hs',
      room_id: '!r:hs',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque' },
    });
    await deleted.attemptDecryption({
      decryptEvent: () =>
        Promise.resolve({
          clearEvent: {
            type: 'm.room.message',
            content: { msgtype: 'm.text', body: 'hello deleted' },
          },
        }),
    } as unknown as Parameters<MatrixEvent['attemptDecryption']>[0]);
    deleted.makeRedacted(
      new MatrixEvent({ type: 'm.room.redaction', content: {} }),
      {} as Room,
    );
    getRoom.mockReturnValue(
      room({
        encrypted: true,
        events: [
          message({ id: '$kept', body: 'hello kept', ts: 1, encrypted: true }),
          deleted as unknown as ReturnType<typeof message>,
        ],
      }),
    );

    const result = service.searchLoaded('hello');

    expect(result.hits.map((hit) => hit.eventId)).toEqual(['$kept']);
    expect(result.scanned).toBe(1);
  });

  // The SDK's setClearData puts the type and body back when a decrypt outlasts the deletion.
  it('does not find a message deleted while it was decrypting', async () => {
    const deleted = new MatrixEvent({
      type: 'm.room.encrypted',
      event_id: '$deleted',
      sender: '@alice:hs',
      room_id: '!r:hs',
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque' },
    });
    let answer: (result: { clearEvent: object }) => void = () => undefined;
    const decrypting = deleted.attemptDecryption({
      decryptEvent: () => new Promise((resolve) => (answer = resolve)),
    } as unknown as Parameters<MatrixEvent['attemptDecryption']>[0]);
    await Promise.resolve();
    deleted.makeRedacted(
      new MatrixEvent({ type: 'm.room.redaction', content: {} }),
      {} as Room,
    );
    answer({
      clearEvent: {
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'hello deleted' },
      },
    });
    await decrypting;
    expect(deleted.getContent()['body']).toBe('hello deleted');
    getRoom.mockReturnValue(
      room({
        encrypted: true,
        events: [deleted as unknown as ReturnType<typeof message>],
      }),
    );

    const result = service.searchLoaded('hello');

    expect(result.hits).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  it('marks a hit that arrived unencrypted in an encrypted room', () => {
    getRoom.mockReturnValue(
      room({
        encrypted: true,
        events: [
          message({ id: '$plain', body: 'hello plain', ts: 1 }),
          message({
            id: '$sealed',
            body: 'hello sealed',
            ts: 2,
            encrypted: true,
          }),
        ],
      }),
    );

    const { hits } = service.searchLoaded('hello');

    expect(hits.find((hit) => hit.eventId === '$plain')?.shield).toMatchObject({
      level: 'unencrypted',
    });
    expect(hits.find((hit) => hit.eventId === '$sealed')?.shield).toBeNull();
  });

  it("matches what a message's sender wrote, not someone else's edit of it", () => {
    getRoom.mockReturnValue(
      room({
        events: [
          message({
            id: '$forged',
            body: 'plain words',
            editedBy: { sender: '@m:hs', body: 'hello forged' },
          }),
          message({
            id: '$edited',
            body: 'plain words',
            editedBy: { sender: '@alice:hs', body: 'hello now' },
          }),
        ],
      }),
    );

    expect(
      service.searchLoaded('hello').hits.map((hit) => hit.eventId),
    ).toEqual(['$edited']);
  });

  it("matches an edit's own text, never an edit attached to the edit", () => {
    const sdkEvent = (id: string, sender: string, content: object) =>
      new MatrixEvent({
        event_id: id,
        room_id: '!r:hs',
        sender,
        type: EventType.RoomMessage,
        origin_server_ts: 1,
        content,
      });
    const message = sdkEvent('$m', '@alice:hs', {
      msgtype: 'm.text',
      body: 'plain',
    });
    const edit = sdkEvent('$e1', '@alice:hs', {
      msgtype: 'm.text',
      body: '* changed',
      'm.new_content': { msgtype: 'm.text', body: 'changed' },
      'm.relates_to': { rel_type: RelationType.Replace, event_id: '$m' },
    });
    edit.makeReplaced(
      sdkEvent('$e2', '@m:hs', {
        'm.new_content': {
          'm.new_content': { msgtype: 'm.text', body: 'FORGED' },
        },
      }),
    );
    message.makeReplaced(edit);
    getRoom.mockReturnValue(room({ events: [message as never] }));

    expect(service.searchLoaded('FORGED').hits).toEqual([]);
    expect(
      service.searchLoaded('changed').hits.map((hit) => hit.eventId),
    ).toEqual(['$m']);
  });

  it('never asks the server to search an encrypted conversation', async () => {
    getRoom.mockReturnValue(room({ encrypted: true }));

    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toEqual({
      hits: [],
      count: 0,
      nextBatch: null,
      encrypted: true,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('never asks the server to search a conversation the crypto store has as encrypted when its state lacks the event', async () => {
    getRoom.mockReturnValue(room({}));
    isEncryptionEnabledInRoom.mockResolvedValue(true);

    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toEqual({
      hits: [],
      count: 0,
      nextBatch: null,
      encrypted: true,
    });
    expect(isEncryptionEnabledInRoom).toHaveBeenCalledWith('!r:hs');
    expect(search).not.toHaveBeenCalled();
  });

  it('never asks the server to search when the crypto store is unavailable', async () => {
    getRoom.mockReturnValue(room({}));
    getCrypto.mockReturnValue(undefined);

    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toEqual({
      hits: [],
      count: 0,
      nextBatch: null,
      encrypted: true,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('never asks the server to search when the crypto store fails to answer', async () => {
    getRoom.mockReturnValue(room({}));
    isEncryptionEnabledInRoom.mockRejectedValue(new Error('store unavailable'));

    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toMatchObject({ hits: [], encrypted: true });
    expect(search).not.toHaveBeenCalled();
  });

  it('maps and paginates an unencrypted server search', async () => {
    getRoom.mockReturnValue(room({}));
    search.mockResolvedValue({
      search_categories: {
        room_events: {
          count: 2,
          next_batch: 'next',
          results: [
            {
              result: {
                event_id: '$event',
                sender: '@bob:hs',
                origin_server_ts: 10,
                content: { body: 'hello' },
              },
              context: { profile_info: { '@bob:hs': { displayname: 'Bob' } } },
            },
          ],
        },
      },
    });

    const result = await firstValueFrom(
      service.searchServer('hello', 'before'),
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ next_batch: 'before' }),
    );
    expect(
      search.mock.calls[0][0].body.search_categories.room_events.order_by,
    ).toBe(SearchOrderBy.Recent);
    expect(result.nextBatch).toBe('next');
    expect(result.hits[0]?.senderName).toBe('Bob');
  });

  it('loads older history through a cold scrollback action', async () => {
    const target = room({ events: [message({ id: '$1', body: 'one' })] });
    getRoom.mockReturnValue(target);
    vi.mocked(scrollbackLive).mockResolvedValue();

    const loaded = service.loadOlder(20);
    expect(scrollbackLive).not.toHaveBeenCalled();
    await expect(firstValueFrom(loaded)).resolves.toBe(1);
    expect(scrollbackLive).toHaveBeenCalledWith(
      expect.objectContaining({ getRoom }),
      target,
      20,
    );
  });

  it('fails closed after its exact Conversation handle retires', async () => {
    service.release();

    expect(service.searchLoaded('hello').hits).toEqual([]);
    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toEqual({ hits: [], count: 0, nextBatch: null });
    expect(getRoom).not.toHaveBeenCalled();
  });
});
