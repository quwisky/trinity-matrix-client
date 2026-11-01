import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ImagePackEditorService,
  MediaService,
} from '@trinity/data-access/media';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { DraftStoreService } from '@trinity/platform-native';
import {
  FeatureSupport,
  MatrixEvent,
  Room,
  THREAD_RELATION_TYPE,
  Thread,
  createClient,
  type IRoomEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import { ThreadsService } from './threads.service';

// A real SDK client, Room and Thread: where a thread keeps its root is the SDK's own
// bookkeeping, and the row opening depends on it.

const ROOT = '$root';
const REPLY = '$reply';

const rootEvent = (replies = 1): IRoomEvent => ({
  event_id: ROOT,
  room_id: '!r:hs',
  type: 'm.room.message',
  sender: '@a:hs',
  origin_server_ts: 1,
  content: { msgtype: 'm.text', body: 'root' },
  unsigned: {
    'm.relations': {
      [THREAD_RELATION_TYPE.name]: {
        count: replies,
        current_user_participated: false,
        latest_event: replyEvent(),
      },
    },
  },
});

function replyEvent(): IRoomEvent {
  return {
    event_id: REPLY,
    room_id: '!r:hs',
    type: 'm.room.message',
    sender: '@a:hs',
    origin_server_ts: 2,
    content: {
      msgtype: 'm.text',
      body: 'reply',
      'm.relates_to': {
        rel_type: THREAD_RELATION_TYPE.name,
        event_id: ROOT,
        is_falling_back: true,
        'm.in_reply_to': { event_id: ROOT },
      },
    },
    unsigned: {},
  };
}

function build() {
  const client: MatrixClient = createClient({
    baseUrl: 'https://hs',
    userId: '@me:hs',
    fetchFn: () => Promise.reject(new Error('no network in unit tests')),
  });
  vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
  const paginate = vi
    .spyOn(client, 'paginateEventTimeline')
    .mockResolvedValue(false);
  const fetchRoot = vi
    .spyOn(client, 'fetchRoomEvent')
    .mockResolvedValue(rootEvent());
  const room = new Room('!r:hs', client, '@me:hs');
  vi.spyOn(client, 'getRoom').mockReturnValue(room);
  TestBed.configureTestingModule({
    providers: [
      ThreadsService,
      { provide: DraftStoreService, useValue: {} },
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client,
      }),
      MockProvider(MediaService),
      MockProvider(ImagePackEditorService, { emoticons: signal(new Map()) }),
      {
        provide: CONVERSATION_MESSAGE_ADAPTER,
        useValue: { acknowledge: () => of({ kind: 'applied' }) },
      },
    ],
  });
  const threads = TestBed.inject(ThreadsService);
  threads.attach({ accountId: '@me:hs', roomId: '!r:hs' }, client);
  return { threads, room, fetchRoot, paginate };
}

describe('ThreadsService.loadThreadRoot, on a real SDK room', () => {
  beforeEach(() => Thread.setServerSideSupport(FeatureSupport.Stable));
  afterEach(() => {
    vi.restoreAllMocks();
    Thread.setServerSideSupport(FeatureSupport.None);
  });

  it('takes a thread a live reply created, though the room finds no root in it', async () => {
    const { threads, room, fetchRoot } = build();
    await room.addLiveEvents([new MatrixEvent(replyEvent())], {
      addToState: false,
    });
    const thread = room.getThread(ROOT);
    await vi.waitFor(() => expect(thread?.initialEventsFetched).toBe(true));
    expect(thread?.rootEvent?.getId()).toBe(ROOT);
    expect(room.findEventById(ROOT)).toBeUndefined();
    fetchRoot.mockClear();
    fetchRoot.mockRejectedValue(new Error('offline'));

    await expect(firstValueFrom(threads.loadThreadRoot(ROOT))).resolves.toBe(
      true,
    );

    expect(fetchRoot).not.toHaveBeenCalled();
    expect(room.getThread(ROOT)).toBe(thread);
  });

  it('makes the thread from its fetched root when the room has neither', async () => {
    const { threads, room, fetchRoot } = build();
    expect(room.getThread(ROOT)).toBeNull();

    await expect(firstValueFrom(threads.loadThreadRoot(ROOT))).resolves.toBe(
      true,
    );

    expect(fetchRoot).toHaveBeenCalledWith('!r:hs', ROOT);
    expect(room.getThread(ROOT)?.rootEvent?.getId()).toBe(ROOT);
    threads.attachThreadRoot(ROOT);
    expect(threads.threadMessages().map((message) => message.id)).toEqual([
      ROOT,
    ]);
  });

  it('makes the thread from a root the room holds, without asking the server first', async () => {
    const { threads, room, fetchRoot } = build();
    await room.addLiveEvents(
      [new MatrixEvent({ ...rootEvent(), unsigned: {} })],
      { addToState: false },
    );
    const held = room.findEventById(ROOT);
    expect(held).toBeDefined();
    expect(room.getThread(ROOT)).toBeNull();
    fetchRoot.mockClear();

    const loading = firstValueFrom(threads.loadThreadRoot(ROOT));

    expect(fetchRoot).not.toHaveBeenCalled();
    await expect(loading).resolves.toBe(true);
    expect(room.getThread(ROOT)?.id).toBe(ROOT);
  });

  it('answers false, making no thread, when the root cannot be fetched', async () => {
    const { threads, room, fetchRoot } = build();
    fetchRoot.mockRejectedValue(new Error('not found'));

    await expect(firstValueFrom(threads.loadThreadRoot(ROOT))).resolves.toBe(
      false,
    );

    expect(room.getThread(ROOT)).toBeNull();
  });

  it('makes no thread on a room closed while its root was being fetched', async () => {
    const { threads, room, fetchRoot } = build();
    let answer: (root: IRoomEvent) => void = () => undefined;
    fetchRoot.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const loading = firstValueFrom(threads.loadThreadRoot(ROOT));

    threads.close();
    answer(rootEvent());

    await expect(loading).resolves.toBe(false);
    expect(room.getThread(ROOT)).toBeNull();
  });

  it('answers false with no room attached', async () => {
    const { threads, fetchRoot } = build();
    threads.close();

    await expect(firstValueFrom(threads.loadThreadRoot(ROOT))).resolves.toBe(
      false,
    );

    expect(fetchRoot).not.toHaveBeenCalled();
  });
});
