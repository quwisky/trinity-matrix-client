import { EventEmitter } from 'events';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  EventType,
  MatrixError,
  MatrixEvent,
  RoomStateEvent,
  SyncState,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { assertPlainData } from '@trinity/util/matrix';
import type { PinnedEvents } from '../conversation-content-engine';
import { CONVERSATION_CONTENT_ENGINE } from '../conversation-content-engine.token';
import { JsSdkConversationContentEngine } from './js-sdk-conversation-content-engine';

const ME = '@me:hs';
const BOB = '@bob:hs';
const ROOM = '!r:hs';

function message(
  eventId: string,
  body: string,
  extra: Record<string, unknown> = {},
): MatrixEvent {
  return new MatrixEvent({
    event_id: eventId,
    room_id: ROOM,
    sender: BOB,
    type: EventType.RoomMessage,
    origin_server_ts: 1_000,
    content: { msgtype: 'm.text', body, ...extra },
  });
}

function edit(eventId: string, target: string, body: string, ts: number) {
  return new MatrixEvent({
    event_id: eventId,
    room_id: ROOM,
    sender: BOB,
    type: EventType.RoomMessage,
    origin_server_ts: ts,
    content: {
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: target },
    },
  });
}

interface Options {
  readonly pinned?: unknown[];
  readonly encrypted?: boolean;
  readonly crypto?: unknown;
}

/** A room and client over real EventEmitters, so listeners can be counted. */
function world(events: MatrixEvent[], options: Options = {}) {
  let pinned: { content: { pinned?: unknown }; id: string } = {
    content: { pinned: options.pinned ?? [] },
    id: '$pins-0',
  };
  const state = {
    getStateEvents: (type: string) =>
      type === EventType.RoomPinnedEvents
        ? { getContent: () => pinned.content, getId: () => pinned.id }
        : null,
  };
  const room = Object.assign(new EventEmitter(), {
    roomId: ROOM,
    getLiveTimeline: () => ({ getState: () => state, getEvents: () => events }),
    findEventById: (id: string) => events.find((e) => e.getId() === id),
    getMember: (userId: string) => ({
      userId,
      name: userId === BOB ? 'Bob' : userId,
      rawDisplayName: userId === BOB ? 'Bob' : userId,
      getMxcAvatarUrl: () => null,
    }),
    hasEncryptionStateEvent: () => options.encrypted === true,
  });
  const client = Object.assign(new EventEmitter(), {
    getUserId: () => ME,
    getRoom: (roomId: string) => (roomId === ROOM ? room : null),
    getCrypto: () => options.crypto,
    fetchRoomEvent: vi.fn(),
    getEventMapper: () => (raw: Record<string, unknown>) =>
      new MatrixEvent(raw),
    decryptEventIfNeeded: () => Promise.resolve(),
    sendStateEvent: vi.fn(
      async (_roomId: string, type: string, content: { pinned: unknown[] }) => {
        // The write reaches the room later, as /sync applies it.
        setTimeout(() => {
          pinned = { content, id: '$pins-1' };
          const event = { getType: () => type, getRoomId: () => ROOM };
          room.emit(RoomStateEvent.Events, event);
          client.emit(RoomStateEvent.Events, event);
        });
        return { event_id: '$pins-1' };
      },
    ),
    search: vi.fn(),
    getUrlPreview: vi.fn(),
    relations: vi.fn(),
    redactEvent: vi.fn(() => Promise.resolve({ event_id: '$redaction' })),
  });
  return { room, client };
}

function engineFor(client: unknown): JsSdkConversationContentEngine {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (accountId: string) => (accountId === ME ? client : null),
        },
      },
    ],
  });
  return TestBed.inject(JsSdkConversationContentEngine);
}

describe('JsSdkConversationContentEngine', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is the default CONVERSATION_CONTENT_ENGINE', () => {
    const { client } = world([]);
    const engine = engineFor(client);

    expect(TestBed.inject(CONVERSATION_CONTENT_ENGINE)).toBe(engine);
  });

  it('pinnedEvents emits on subscribe and removes its listeners on unsubscribe', () => {
    const { room, client } = world([message('$a', 'hello')], {
      pinned: ['$a'],
    });
    const engine = engineFor(client);
    const states: PinnedEvents[] = [];

    const sub = engine
      .pinnedEvents(ME, ROOM)
      .subscribe((state) => states.push(state));
    sub.unsubscribe();

    expect(() => assertPlainData(states)).not.toThrow();
    expect(states).toEqual([
      {
        eventIds: ['$a'],
        allEventIds: ['$a'],
        entries: [
          {
            eventId: '$a',
            status: 'loaded',
            sender: BOB,
            body: 'hello',
            ts: 1_000,
            shield: null,
            unencryptedMark: null,
            profiles: {
              [BOB]: {
                displayName: 'Bob',
                displayNameAmbiguous: false,
                avatarMxc: null,
              },
            },
          },
        ],
      },
    ]);
    expect(room.listenerCount(RoomStateEvent.Events)).toBe(0);
    expect(room.eventNames()).toEqual([]);
    expect(client.eventNames()).toEqual([]);
  });

  it('pinnedEvents fetches a pin outside the timeline, loading first', async () => {
    const { client } = world([], { pinned: ['$far'] });
    client.fetchRoomEvent.mockResolvedValue({
      event_id: '$far',
      room_id: ROOM,
      sender: BOB,
      type: EventType.RoomMessage,
      origin_server_ts: 5,
      content: { msgtype: 'm.text', body: 'far away' },
    });
    const engine = engineFor(client);
    const states: PinnedEvents[] = [];

    const sub = engine.pinnedEvents(ME, ROOM).subscribe((s) => states.push(s));
    await vi.waitFor(() => expect(states).toHaveLength(2));
    sub.unsubscribe();

    expect(states.map((s) => s.entries[0].status)).toEqual([
      'loading',
      'loaded',
    ]);
    expect(states[1].entries[0].body).toBe('far away');
  });

  it('pin replies once the new list is in the open subscription', async () => {
    const { client } = world([message('$a', 'a')], { pinned: [] });
    const engine = engineFor(client);
    const states: PinnedEvents[] = [];
    const sub = engine.pinnedEvents(ME, ROOM).subscribe((s) => states.push(s));

    const result = await firstValueFrom(engine.pin(ME, ROOM, '$a'));

    expect(result).toEqual({ ok: true, value: null });
    expect(states.at(-1)?.eventIds).toEqual(['$a']);
    sub.unsubscribe();
  });

  it('pin settles when sync stops before the state event arrives', async () => {
    const { client } = world([message('$a', 'a')], { pinned: [] });
    client.sendStateEvent.mockResolvedValueOnce({ event_id: '$never' });
    const engine = engineFor(client);

    const reply = firstValueFrom(engine.pin(ME, ROOM, '$a'));
    await vi.waitFor(() =>
      expect(client.listenerCount(ClientEvent.Sync)).toBe(1),
    );
    client.emit(ClientEvent.Sync, SyncState.Stopped);

    await expect(reply).resolves.toEqual({ ok: true, value: null });
    expect(client.eventNames()).toEqual([]);
  });

  it('pin settles after 15 seconds without the state event', async () => {
    vi.useFakeTimers();
    try {
      const { client } = world([message('$a', 'a')], { pinned: [] });
      client.sendStateEvent.mockResolvedValueOnce({ event_id: '$never' });
      const engine = engineFor(client);
      let result: unknown = null;
      engine.pin(ME, ROOM, '$a').subscribe((r) => (result = r));

      await vi.advanceTimersByTimeAsync(14_999);
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      expect(result).toEqual({ ok: true, value: null });
      expect(client.eventNames()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pinnedEvents removes its listeners when reading the list fails', () => {
    const { room, client } = world([], { pinned: ['$a'] });
    room.getLiveTimeline = () => {
      throw new Error('unreadable');
    };
    const engine = engineFor(client);
    const error = vi.fn();

    engine.pinnedEvents(ME, ROOM).subscribe({ error });

    expect(error).toHaveBeenCalledWith(new Error('unreadable'));
    expect(room.eventNames()).toEqual([]);
    expect(client.eventNames()).toEqual([]);
  });

  it('unpin writes non-string entries back', async () => {
    const { client } = world([], { pinned: [7, '$a', { odd: true }, '$b'] });
    const engine = engineFor(client);

    const result = await firstValueFrom(engine.unpin(ME, ROOM, '$a'));

    expect(result).toEqual({ ok: true, value: null });
    expect(client.sendStateEvent).toHaveBeenCalledWith(
      ROOM,
      EventType.RoomPinnedEvents,
      { pinned: [7, { odd: true }, '$b'] },
      '',
    );
  });

  it('unpin of an event that is not pinned sends nothing', async () => {
    const { client } = world([], { pinned: ['$b'] });
    const engine = engineFor(client);

    const result = await firstValueFrom(engine.unpin(ME, ROOM, '$a'));

    expect(result).toEqual({ ok: true, value: null });
    expect(client.sendStateEvent).not.toHaveBeenCalled();
  });

  it('searchMessages in an encrypted room is encrypted', async () => {
    const { client } = world([], { encrypted: true });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.searchMessages(ME, ROOM, 'hello', null),
    );

    expect(result).toEqual({ ok: true, value: { encrypted: true } });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('searchMessages refuses a room the crypto store has as encrypted without the state event', async () => {
    const crypto = { isEncryptionEnabledInRoom: vi.fn(async () => true) };
    const { client } = world([], { crypto });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.searchMessages(ME, ROOM, 'hello', null),
    );

    expect(result).toEqual({ ok: true, value: { encrypted: true } });
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith(ROOM);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('searchMessages maps the server page with profiles', async () => {
    const crypto = { isEncryptionEnabledInRoom: async () => false };
    const { client } = world([], { crypto });
    client.search.mockResolvedValue({
      search_categories: {
        room_events: {
          count: 3,
          next_batch: 'next',
          results: [
            {
              rank: 1,
              result: {
                event_id: '$hit',
                sender: BOB,
                origin_server_ts: 9,
                content: { body: 'hello there' },
              },
              context: { profile_info: { [BOB]: { displayname: 'Bob' } } },
            },
          ],
        },
      },
    });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.searchMessages(ME, ROOM, ' hello ', 'prev'),
    );

    expect(() => assertPlainData(result)).not.toThrow();
    expect(result).toEqual({
      ok: true,
      value: {
        hits: [
          {
            eventId: '$hit',
            sender: BOB,
            body: 'hello there',
            ts: 9,
            profiles: {
              [BOB]: {
                displayName: 'Bob',
                displayNameAmbiguous: false,
                avatarMxc: null,
              },
            },
          },
        ],
        count: 3,
        nextBatch: 'next',
      },
    });
    expect(client.search).toHaveBeenCalledWith({
      body: expect.objectContaining({
        search_categories: {
          room_events: expect.objectContaining({ search_term: 'hello' }),
        },
      }),
      next_batch: 'prev',
    });
  });

  it('editHistory pages 50 at a time, stops at 10 pages and repairs the aggregation', async () => {
    const original = message('$orig', 'one');
    const { client } = world([original]);
    client.relations.mockImplementation(async () => ({
      originalEvent: original,
      events: [edit('$e1', '$orig', 'two <b>', 2_000)],
      nextBatch: 'more',
    }));
    const makeReplaced = vi.spyOn(original, 'makeReplaced');
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.editHistory(ME, ROOM, '$orig', { maxPages: 50 }),
    );

    expect(() => assertPlainData(result)).not.toThrow();
    expect(client.relations).toHaveBeenCalledTimes(10);
    expect(client.relations).toHaveBeenLastCalledWith(
      ROOM,
      '$orig',
      'm.replace',
      EventType.RoomMessage,
      { dir: 'b', limit: 50, from: 'more' },
    );
    expect(result.ok && result.value.truncated).toBe(true);
    expect(
      result.ok && result.value.revisions.map((r) => [r.eventId, r.body]),
    ).toEqual([
      ['$orig', 'one'],
      ['$e1', 'two <b>'],
    ]);
    expect(makeReplaced).toHaveBeenCalledWith(
      expect.objectContaining({ getId: expect.any(Function) }),
    );
  });

  it('editHistory carries the unsanitised HTML and the profiles it links to', async () => {
    const html = '<a href="https://matrix.to/#/@carol:hs">Carol</a>';
    const original = message('$orig', 'hi Carol', {
      format: 'org.matrix.custom.html',
      formatted_body: html,
    });
    const { client } = world([original]);
    client.relations.mockResolvedValue({
      originalEvent: original,
      events: [],
      nextBatch: null,
    });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.editHistory(ME, ROOM, '$orig', { maxPages: 10 }),
    );

    const [revision] = result.ok ? result.value.revisions : [];
    expect(revision).toMatchObject({ kind: 'text', html, body: 'hi Carol' });
    expect(Object.keys(revision.profiles).sort()).toEqual([BOB, '@carol:hs']);
  });

  it('editHistory of a deleted message lists nothing', async () => {
    const original = new MatrixEvent({
      event_id: '$orig',
      room_id: ROOM,
      sender: BOB,
      type: EventType.RoomMessage,
      origin_server_ts: 1_000,
      content: {},
      unsigned: { redacted_because: { event_id: '$x' } as never },
    });
    const { client } = world([original]);
    client.relations.mockResolvedValue({
      originalEvent: original,
      events: [edit('$e1', '$orig', 'two', 2_000)],
      nextBatch: null,
    });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.editHistory(ME, ROOM, '$orig', { maxPages: 10 }),
    );

    expect(result).toEqual({
      ok: true,
      value: { revisions: [], truncated: false },
    });
  });

  it('editHistory of a message nobody can load is message-unavailable', async () => {
    const { client } = world([]);
    client.relations.mockResolvedValue({
      originalEvent: null,
      events: [],
      nextBatch: null,
    });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.editHistory(ME, ROOM, '$orig', { maxPages: 10 }),
    );

    expect(!result.ok && result.failure.code).toBe('message-unavailable');
  });

  it('linkPreview maps M_UNRECOGNIZED to unsupported', async () => {
    const { client } = world([]);
    client.getUrlPreview.mockRejectedValue(
      new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 400),
    );
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.linkPreview(ME, 'https://x.org', { onlyIfUnencrypted: null }),
    );

    expect(!result.ok && result.failure.code).toBe('unsupported');
  });

  it('linkPreview onlyIfUnencrypted without a crypto store makes no request', async () => {
    const { client } = world([]);
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.linkPreview(ME, 'https://x.org', { onlyIfUnencrypted: ROOM }),
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(client.getUrlPreview).not.toHaveBeenCalled();
  });

  it('linkPreview onlyIfUnencrypted refuses a room the crypto store has as encrypted', async () => {
    const crypto = { isEncryptionEnabledInRoom: async () => true };
    const { client } = world([], { crypto });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.linkPreview(ME, 'https://x.org', { onlyIfUnencrypted: ROOM }),
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(client.getUrlPreview).not.toHaveBeenCalled();
  });

  it('linkPreview projects the Open Graph fields', async () => {
    const { client } = world([]);
    client.getUrlPreview.mockResolvedValue({
      'og:title': 'Title',
      'og:image': 'mxc://hs/img',
      'og:description': '',
    });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.linkPreview(ME, 'https://x.org', { onlyIfUnencrypted: null }),
    );

    expect(result).toEqual({
      ok: true,
      value: { title: 'Title', description: null, imageMxc: 'mxc://hs/img' },
    });
  });
});
