import {
  EventType,
  RelationType,
  SearchOrderBy,
  type MatrixClient,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSearchController } from './conversation-search.service';

function message(over: {
  id: string;
  body: string;
  ts?: number;
  replace?: boolean;
  decryptionFailure?: boolean;
}) {
  return {
    getId: () => over.id,
    getType: () => EventType.RoomMessage,
    getSender: () => '@alice:hs',
    getTs: () => over.ts ?? 0,
    getContent: () => ({ body: over.body }),
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
    hasEncryptionStateEvent: () => options.encrypted ?? false,
    getLiveTimeline: () => ({ getEvents: () => options.events ?? [] }),
    getMember: () => ({ name: 'Alice', getMxcAvatarUrl: () => null }),
  };
}

describe('ConversationSearchController', () => {
  let service: ConversationSearchController;
  const getRoom = vi.fn();
  const search = vi.fn();
  const scrollback = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ConversationSearchController();
    service.attach({ accountId: '@me:hs', roomId: '!r:hs' }, {
      getRoom,
      search,
      scrollback,
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

  it('never asks the server to search an encrypted conversation', async () => {
    getRoom.mockReturnValue(room({ encrypted: true }));

    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toEqual({ hits: [], count: 0, nextBatch: null });
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
    scrollback.mockResolvedValue(target);

    await expect(firstValueFrom(service.loadOlder(20))).resolves.toBe(1);
    expect(scrollback).toHaveBeenCalledWith(target, 20);
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
