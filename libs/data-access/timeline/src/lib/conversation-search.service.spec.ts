import { TestBed } from '@angular/core/testing';
import {
  EventType,
  MatrixEvent,
  RelationType,
  SearchOrderBy,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSearchController } from './conversation-search.service';
import { scrollbackLive } from './js-sdk/live-scrollback';
import { TimelineService } from './timeline.service';
import {
  fakeClient,
  fakeEdit,
  fakeEvent,
  fakeRoom,
  matrixProvider,
  privacyProvider,
  ROOM_KEY,
} from './timeline.spec-harness';

// Paging itself is covered against the real SDK in live-scrollback.spec.
vi.mock('./js-sdk/live-scrollback', () => ({ scrollbackLive: vi.fn() }));

function message(over: {
  id: string;
  body: string;
  ts?: number;
  replace?: boolean;
  decryptionFailure?: boolean;
  encrypted?: boolean;
  /** An edit attached to the message: its sender and the text it would show. */
  editedBy?: { sender: string };
}) {
  return fakeEvent({
    id: over.id,
    sender: '@alice:hs',
    body: over.body,
    ts: over.ts,
    editRelation: over.replace,
    decryptFail: over.decryptionFailure,
    encrypted: over.encrypted,
    replacement: over.editedBy && {
      ...fakeEdit(over.id),
      getSender: () => over.editedBy?.sender,
    },
  });
}

describe('ConversationSearchController', () => {
  let service: ConversationSearchController;
  const search = vi.fn();
  const isEncryptionEnabledInRoom = vi.fn();
  const getCrypto = vi.fn();
  let client: ReturnType<typeof fakeClient> & Record<string, unknown>;

  /** Opens the room's main timeline over `events`, then attaches the controller to it. */
  function open(
    events: readonly unknown[] = [],
    options: { encrypted?: boolean } = {},
  ) {
    const room = fakeRoom(events as never, {}, options.encrypted ?? false);
    // No room state: the unencrypted mark then judges every unencrypted event.
    const live = room.getLiveTimeline();
    room.getLiveTimeline = () => ({
      ...live,
      getState: () => undefined as never,
    });
    client = { ...fakeClient(room, []), search, getCrypto };
    TestBed.configureTestingModule({
      providers: [
        privacyProvider(true),
        ...matrixProvider(client),
        TimelineService,
        ConversationSearchController,
      ],
    });
    TestBed.inject(TimelineService).open(ROOM_KEY);
    service = TestBed.inject(ConversationSearchController);
    service.attach(ROOM_KEY);
    return room;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    isEncryptionEnabledInRoom.mockResolvedValue(false);
    getCrypto.mockReturnValue({ isEncryptionEnabledInRoom });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('searchLoaded finds a message without a request', () => {
    open([message({ id: '$a', body: 'find me' })]);

    expect(service.searchLoaded('find').hits).toMatchObject([
      {
        eventId: '$a',
        roomId: ROOM_KEY.roomId,
        sender: '@alice:hs',
        senderName: 'Alice',
        senderAvatarMxc: null,
        body: 'find me',
        snippet: 'find me',
        shield: null,
      },
    ]);
    expect(search).not.toHaveBeenCalled();
    expect(scrollbackLive).not.toHaveBeenCalled();
  });

  it('searches only displayable decrypted events and orders by recency', () => {
    open([
      message({ id: '$old', body: 'hello old', ts: 1 }),
      message({ id: '$new', body: 'HELLO new', ts: 2 }),
      message({ id: '$edit', body: 'hello edit', replace: true }),
      message({ id: '$failed', body: 'hello', decryptionFailure: true }),
    ]);

    const result = service.searchLoaded('hello');

    expect(result.hits.map((hit) => hit.eventId)).toEqual(['$new', '$old']);
    expect(result.scanned).toBe(2);
  });

  it('finds a poll by its question', () => {
    open([
      fakeEvent({
        id: '$poll',
        sender: '@alice:hs',
        type: 'm.poll.start',
        content: {
          'm.poll.start': {
            question: { 'm.text': 'Lunch where?' },
            answers: [
              { id: 'a', 'm.text': 'Pizza' },
              { id: 'b', 'm.text': 'Sushi' },
            ],
          },
        },
      }),
    ]);

    expect(service.searchLoaded('lunch').hits).toMatchObject([
      { eventId: '$poll', body: 'Lunch where?' },
    ]);
  });

  it('marks a hit that arrived unencrypted in an encrypted room', () => {
    open(
      [
        message({ id: '$plain', body: 'hello plain', ts: 1 }),
        message({
          id: '$sealed',
          body: 'hello sealed',
          ts: 2,
          encrypted: true,
        }),
      ],
      { encrypted: true },
    );

    const { hits } = service.searchLoaded('hello');

    expect(hits.find((hit) => hit.eventId === '$plain')?.shield).toMatchObject({
      level: 'unencrypted',
    });
    expect(hits.find((hit) => hit.eventId === '$sealed')?.shield).toBeNull();
  });

  it("matches what a message's sender wrote, not someone else's edit of it", () => {
    open([
      message({
        id: '$forged',
        body: 'plain words',
        editedBy: { sender: '@m:hs' },
      }),
      message({
        id: '$edited',
        body: 'plain words',
        editedBy: { sender: '@alice:hs' },
      }),
    ]);

    expect(
      service.searchLoaded('as edited').hits.map((hit) => hit.eventId),
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
    open([message]);

    expect(service.searchLoaded('FORGED').hits).toEqual([]);
    expect(
      service.searchLoaded('changed').hits.map((hit) => hit.eventId),
    ).toEqual(['$m']);
  });

  it('never asks the server to search an encrypted conversation', async () => {
    open([], { encrypted: true });

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
    open();
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
    open();
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
    open();
    isEncryptionEnabledInRoom.mockRejectedValue(new Error('store unavailable'));

    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toMatchObject({ hits: [], encrypted: true });
    expect(search).not.toHaveBeenCalled();
  });

  it('maps and paginates an unencrypted server search', async () => {
    open();
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
    expect(result.hits[0]).toEqual({
      eventId: '$event',
      roomId: ROOM_KEY.roomId,
      sender: '@bob:hs',
      senderName: 'Bob',
      senderAvatarMxc: null,
      body: 'hello',
      ts: 10,
      snippet: 'hello',
      shield: null,
    });
  });

  it.each([
    ['the request fails', () => search.mockRejectedValue(new Error('down'))],
    [
      'the room is unknown',
      () => Object.assign(client, { getRoom: () => null }),
    ],
  ])('gives an empty page when %s', async (_name, arrange) => {
    open();
    arrange();

    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toEqual({ hits: [], count: 0, nextBatch: null });
  });

  it('loads older history through a cold scrollback action', async () => {
    const target = open([message({ id: '$1', body: 'one' })]);
    vi.mocked(scrollbackLive).mockResolvedValue();

    const loaded = service.loadOlder(20);
    expect(scrollbackLive).not.toHaveBeenCalled();
    await expect(firstValueFrom(loaded)).resolves.toBe(1);
    expect(scrollbackLive).toHaveBeenCalledWith(
      expect.objectContaining({ search }),
      target,
      20,
    );
  });

  it('fails closed after its exact Conversation handle retires', async () => {
    open([message({ id: '$a', body: 'hello' })]);
    service.release();

    expect(service.searchLoaded('hello').hits).toEqual([]);
    await expect(
      firstValueFrom(service.searchServer('hello')),
    ).resolves.toEqual({ hits: [], count: 0, nextBatch: null });
    await expect(firstValueFrom(service.loadOlder())).resolves.toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(scrollbackLive).not.toHaveBeenCalled();
  });
});
