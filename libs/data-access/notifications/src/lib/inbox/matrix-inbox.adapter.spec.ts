import {
  HTTPError,
  MatrixError,
  MatrixEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  checkInboxEvent,
  fetchNotificationsPage,
  lookUpIndexedEvent,
  mapInboxEvent,
} from './matrix-inbox.adapter';

const ME = '@me:hs';

interface Fake {
  authedRequest?: ReturnType<typeof vi.fn>;
  getRoom?: ReturnType<typeof vi.fn>;
  fetchRoomEvent?: ReturnType<typeof vi.fn>;
  mapper?: ReturnType<typeof vi.fn>;
  getEventMapper?: ReturnType<typeof vi.fn>;
  decryptEventIfNeeded?: ReturnType<typeof vi.fn>;
  getPushActionsForEvent?: ReturnType<typeof vi.fn>;
  getCrypto?: ReturnType<typeof vi.fn>;
}

function clientOf(fake: Fake): MatrixClient {
  return {
    http: { authedRequest: fake.authedRequest },
    getRoom: fake.getRoom ?? vi.fn(() => null),
    fetchRoomEvent: fake.fetchRoomEvent,
    getEventMapper:
      fake.getEventMapper ??
      vi.fn(() => (raw: object) => new MatrixEvent(raw as never)),
    decryptEventIfNeeded: fake.decryptEventIfNeeded ?? vi.fn(),
    getPushActionsForEvent: fake.getPushActionsForEvent ?? vi.fn(),
    getCrypto: fake.getCrypto ?? vi.fn(() => ({})),
    getUserId: () => ME,
  } as unknown as MatrixClient;
}

const message = (content: Record<string, unknown> = { body: 'hi' }) =>
  new MatrixEvent({
    event_id: '$e',
    room_id: '!r:hs',
    sender: '@a:hs',
    type: 'm.room.message',
    content,
  });

describe('fetchNotificationsPage', () => {
  it('asks for 50 with no only filter', async () => {
    const authedRequest = vi.fn().mockResolvedValue({ notifications: [] });
    const client = clientOf({ authedRequest });
    await fetchNotificationsPage(client, null, 50);
    await fetchNotificationsPage(client, 't', 50);
    expect(authedRequest).toHaveBeenNthCalledWith(1, 'GET', '/notifications', {
      limit: '50',
    });
    expect(authedRequest).toHaveBeenNthCalledWith(2, 'GET', '/notifications', {
      limit: '50',
      from: 't',
    });
  });
});

describe('mapInboxEvent', () => {
  it("maps with preventReEmit and decrypt false, under the entry's room", () => {
    const getEventMapper = vi.fn(
      () => (raw: object) => new MatrixEvent(raw as never),
    );
    const event = mapInboxEvent(
      clientOf({ getEventMapper }),
      { event_id: '$e', room_id: '!other:hs', type: 'm.room.message' },
      '!r:hs',
    );
    expect(getEventMapper).toHaveBeenCalledWith({
      preventReEmit: true,
      decrypt: false,
    });
    expect(event.getRoomId()).toBe('!r:hs');
  });
});

describe('lookUpIndexedEvent', () => {
  it('finds an indexed event in memory without a request', async () => {
    const known = message();
    const fetchRoomEvent = vi.fn();
    const result = await lookUpIndexedEvent(
      clientOf({
        getRoom: vi.fn(() => ({ findEventById: () => known })),
        fetchRoomEvent,
      }),
      '!r:hs',
      '$e',
    );
    expect(result).toEqual({ kind: 'found', event: known });
    expect(fetchRoomEvent).not.toHaveBeenCalled();
  });

  it('reads only a Matrix refusal as gone, anything else as unreachable', async () => {
    const kind = async (error: unknown) =>
      (
        await lookUpIndexedEvent(
          clientOf({ fetchRoomEvent: vi.fn().mockRejectedValue(error) }),
          '!r:hs',
          '$e',
        )
      ).kind;
    const matrix = (errcode: string, status: number) =>
      new MatrixError({ errcode }, status);
    expect(await kind(matrix('M_FORBIDDEN', 403))).toBe('gone');
    expect(await kind(matrix('M_NOT_FOUND', 404))).toBe('gone');
    expect(await kind(matrix('M_RESOURCE_LIMIT_EXCEEDED', 403))).toBe(
      'unreachable',
    );
    expect(await kind(new HTTPError('Server returned 403 error', 403))).toBe(
      'unreachable',
    );
    expect(await kind(new HTTPError('Server returned 404 error', 404))).toBe(
      'unreachable',
    );
    expect(await kind(matrix('M_UNKNOWN', 500))).toBe('unreachable');
    expect(await kind(new Error('offline'))).toBe('unreachable');
  });

  it('fetches and maps an event that is not in memory', async () => {
    const result = await lookUpIndexedEvent(
      clientOf({
        fetchRoomEvent: vi
          .fn()
          .mockResolvedValue({ event_id: '$e', type: 'm.room.message' }),
      }),
      '!r:hs',
      '$e',
    );
    expect(result.kind).toBe('found');
  });

  it('reads an event from another room as gone', async () => {
    const result = await lookUpIndexedEvent(
      clientOf({
        fetchRoomEvent: vi
          .fn()
          .mockResolvedValue({ event_id: '$e', room_id: '!x:hs' }),
      }),
      '!r:hs',
      '$e',
    );
    expect(result.kind).toBe('gone');
  });
});

describe('checkInboxEvent', () => {
  const highlight = () => vi.fn(() => ({ tweaks: { highlight: true } }));

  it('reads the push rules for a plain event', async () => {
    const result = await checkInboxEvent(
      clientOf({ getPushActionsForEvent: highlight() }),
      message(),
    );
    expect(result).toMatchObject({ kind: 'checked', highlighted: true });
  });

  it('re-checks a decrypted event with force', async () => {
    const order: string[] = [];
    const event = message();
    vi.spyOn(event, 'isEncrypted').mockReturnValue(true);
    vi.spyOn(event, 'getClearContent').mockReturnValue({ body: 'hi' });
    const decryptEventIfNeeded = vi.fn(() => {
      order.push('decrypt');
      return Promise.resolve();
    });
    const getPushActionsForEvent = vi.fn(() => {
      order.push('push');
      return { tweaks: { highlight: true } };
    });
    const result = await checkInboxEvent(
      clientOf({ decryptEventIfNeeded, getPushActionsForEvent }),
      event,
    );
    expect(order).toEqual(['decrypt', 'push']);
    expect(getPushActionsForEvent).toHaveBeenCalledWith(event, true);
    expect(result).toMatchObject({ kind: 'checked', highlighted: true });
  });

  it('reads a failed decryption as undecryptable, never guessing', async () => {
    const event = message();
    vi.spyOn(event, 'isEncrypted').mockReturnValue(true);
    vi.spyOn(event, 'isDecryptionFailure').mockReturnValue(true);
    const getPushActionsForEvent = highlight();
    const result = await checkInboxEvent(
      clientOf({ getPushActionsForEvent }),
      event,
    );
    expect(result.kind).toBe('undecryptable');
    expect(getPushActionsForEvent).not.toHaveBeenCalled();
  });

  it('reads an impossible decryption as undecryptable', async () => {
    const event = message();
    vi.spyOn(event, 'isEncrypted').mockReturnValue(true);
    vi.spyOn(event, 'getClearContent').mockReturnValue(null);
    const decryptEventIfNeeded = vi.fn();
    const result = await checkInboxEvent(
      clientOf({ getCrypto: vi.fn(() => undefined), decryptEventIfNeeded }),
      event,
    );
    expect(result.kind).toBe('undecryptable');
    expect(decryptEventIfNeeded).not.toHaveBeenCalled();
  });

  it('drops a redacted event', async () => {
    const event = message();
    vi.spyOn(event, 'isRedacted').mockReturnValue(true);
    expect((await checkInboxEvent(clientOf({}), event)).kind).toBe('dropped');
  });

  it('drops an event redacted while it decrypted', async () => {
    const event = message();
    vi.spyOn(event, 'isRedacted')
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    expect((await checkInboxEvent(clientOf({}), event)).kind).toBe('dropped');
  });

  it('does not count a legacy edit as a highlight', async () => {
    const edit = message({
      body: '* @me',
      'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
    });
    const result = await checkInboxEvent(
      clientOf({ getPushActionsForEvent: highlight() }),
      edit,
    );
    expect(result).toMatchObject({ kind: 'checked', highlighted: false });
  });

  it('does not count the person’s own message as a highlight', async () => {
    const own = new MatrixEvent({
      event_id: '$o',
      room_id: '!r:hs',
      sender: ME,
      type: 'm.room.message',
      content: { body: 'me' },
    });
    const result = await checkInboxEvent(
      clientOf({ getPushActionsForEvent: highlight() }),
      own,
    );
    expect(result).toMatchObject({ highlighted: false });
  });

  it('forces for an event that is not the room’s own', async () => {
    const event = message();
    const getPushActionsForEvent = highlight();
    await checkInboxEvent(
      clientOf({
        getPushActionsForEvent,
        getRoom: vi.fn(() => ({ findEventById: () => message() })),
      }),
      event,
    );
    expect(getPushActionsForEvent).toHaveBeenCalledWith(event, true);
  });

  it('takes the cached answer for the room’s own event', async () => {
    const event = message();
    const getPushActionsForEvent = highlight();
    const result = await checkInboxEvent(
      clientOf({
        getPushActionsForEvent,
        getRoom: vi.fn(() => ({ findEventById: () => event })),
      }),
      event,
    );
    expect(getPushActionsForEvent).toHaveBeenCalledWith(event, false);
    expect(result).toMatchObject({ highlighted: true });
  });

  it('counts an original later edited to mention the person', async () => {
    const original = new MatrixEvent({
      event_id: '$o',
      room_id: '!r:hs',
      sender: '@a:hs',
      type: 'm.room.message',
      content: { body: 'hi' },
      unsigned: {
        'm.relations': {
          'm.replace': {
            event_id: '$edit',
            sender: '@a:hs',
            type: 'm.room.message',
            origin_server_ts: 2,
            content: {
              body: '* @me',
              'm.new_content': { body: '@me' },
              'm.relates_to': { rel_type: 'm.replace', event_id: '$o' },
            },
          },
        },
      },
    });
    const result = await checkInboxEvent(
      clientOf({ getPushActionsForEvent: highlight() }),
      original,
    );
    expect(result).toMatchObject({ kind: 'checked', highlighted: true });
  });
});
