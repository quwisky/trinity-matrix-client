import { TestBed } from '@angular/core/testing';
import { ErrorHandler, signal, type WritableSignal } from '@angular/core';
import { NEVER, Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DraftStoreService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import {
  MediaPipeline,
  type MediaTransferEvent,
  type StagedMediaReference,
} from '@trinity/data-access/media';
import {
  CONVERSATION_RETENTION_LIMIT,
  CONVERSATION_TEXT_SENDER,
  ConversationRuntime,
  type ConversationTextSendRequest,
  type ConversationTextSender,
} from './conversation-runtime.service';
import {
  CONVERSATION_TIMELINE_FACTORY,
  type ConversationClientStatus,
  type ConversationTimeline,
  type ConversationTimelineController,
  type ConversationTimelineFactory,
} from './conversation-timeline-factory';
import type {
  ConversationTextDelivery,
  ConversationTextSendOutcome,
} from './conversation-compose';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import { conversationDraftKey } from './conversation-draft-key';
import type {
  ConversationMessageAdapter,
  ConversationMessageOperation,
} from './conversation-messages';
import { ConversationTimelineReadiness } from './conversation-timeline-readiness';
import type { TimelineLoadState } from './conversation-timeline-readiness';
import { TimelineService } from './timeline.service';
import { ThreadsService as RealThreadsService } from './threads.service';
import { ConversationPinsController as RealPins } from './conversation-pins.controller';
import { ConversationSearchController } from './conversation-search.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import type { MessageView } from './message-presentation';
import type { ThreadsService } from './threads.service';
import type { ConversationPinsController } from './conversation-pins.controller';
import {
  Direction,
  MatrixEvent,
  Room,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  TRIM_CEILING,
  TRIM_KEEP,
  noteSyncPosition,
} from './live-timeline-trim';

const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';

interface TestConversationTimelineController extends ConversationTimelineController {
  readonly visible: ReturnType<typeof signal<boolean>>;
  readonly released: ReturnType<typeof signal<boolean>>;
  /** Whether the SDK history was released, and if so whether after the listeners were. */
  readonly history: ReturnType<
    typeof signal<'kept' | 'released' | 'released-while-attached'>
  >;
}

function timeline(
  roomId: string,
  messages: readonly MessageView[] = [],
): ConversationTimeline {
  return {
    messages: signal([...messages]).asReadonly(),
    loadingOlder: signal(false).asReadonly(),
    canLoadOlder: signal(false).asReadonly(),
    oldestEventId: signal<string | null>(null).asReadonly(),
    typingNames: signal([]).asReadonly(),
    canRedactOthers: signal(false).asReadonly(),
    canSendMessages: signal(true).asReadonly(),
    tombstone: signal(null).asReadonly(),
    firstUnreadId: signal<string | null>(null).asReadonly(),
    openRoomId: roomId,
    roomEncrypted: false,
    loadOlder: () => of(void 0),
    jumpToDate: () => of({ kind: 'no-event' }),
    loadEvent: () => of(true),
    setTyping: vi.fn(),
    rawEvent: () => null,
    roomVia: () => [],
    reactionDetails: () => [],
    loadState: signal<TimelineLoadState>({ kind: 'ready' }),
    retryLoad: vi.fn(),
    setLiveView: vi.fn(),
  };
}

function setup(
  retainedPerAccount = 2,
  senderOverride?: ConversationTextSender,
  messages: readonly MessageView[] = [],
) {
  const controllers = new Map<string, TestConversationTimelineController[]>();
  const sends = new Subject<ConversationTextDelivery>();
  const sender: ConversationTextSender = senderOverride ?? {
    send: vi.fn(() => ({ outcome: sends, cancel: () => false })),
  };
  const mediaEvents = new Subject<MediaTransferEvent>();
  const keepPhotoMetadata = signal(false);
  const mediaPipeline = {
    transfer: vi.fn(() => mediaEvents.asObservable()),
  };
  const applied = (operation: ConversationMessageOperation) =>
    of({ kind: 'applied' as const, operation });
  const messageAdapter: ConversationMessageAdapter = {
    toggleReaction: vi.fn(() => applied('reaction')),
    redact: vi.fn(() => applied('redaction')),
    retry: vi.fn(() => applied('retry')),
    cancel: vi.fn(() => applied('cancel')),
    acknowledge: vi.fn(() => applied('receipt')),
    flushReceipts: vi.fn(),
  };
  const factory: ConversationTimelineFactory = {
    create: vi.fn((key) => {
      const visible = signal(false);
      const released = signal(false);
      const history = signal<'kept' | 'released' | 'released-while-attached'>(
        'kept',
      );
      const threads = {
        openThreadRootId: signal<string | null>(null),
        summaries: signal({}).asReadonly(),
        threadList: signal([]).asReadonly(),
        threadMessages: signal([...messages]).asReadonly(),
        loadingOlderThread: signal(false).asReadonly(),
        canPaginateThread: signal(false).asReadonly(),
        oldestThreadEventId: signal<string | null>('$oldest').asReadonly(),
        attachThreadRoot: vi.fn(),
        closeThread: vi.fn(),
        paginateOpenThread: vi.fn(() => of(void 0)),
        sendToThread: vi.fn(() => of(void 0)),
        editInThread: vi.fn(() => of(void 0)),
        replyInThread: vi.fn(() => of(void 0)),
      } as unknown as ThreadsService;
      const pins = {
        eventIds: signal([]).asReadonly(),
        messages: signal([]).asReadonly(),
        canMutate: signal(false).asReadonly(),
        isPinned: vi.fn(() => false),
        pin: vi.fn(() => of({ kind: 'applied', operation: 'pin' })),
        unpin: vi.fn(() => of({ kind: 'applied', operation: 'unpin' })),
        release: vi.fn(),
      } as unknown as ConversationPinsController;
      const controller: TestConversationTimelineController = {
        timeline: timeline(key.roomId, messages),
        search: {
          searchLoaded: () => ({
            hits: [],
            scanned: 0,
            encrypted: false,
            serverAvailable: true,
          }),
          searchServer: () => of({ hits: [], count: 0, nextBatch: null }),
          loadOlder: () => of(0),
        },
        threads,
        pins,
        setVisible: (next) => {
          visible.set(next);
          if (!next) {
            threads.closeThread();
            pins.release();
          }
        },
        release: () => released.set(true),
        releaseHistory: vi.fn(() =>
          history.set(released() ? 'released' : 'released-while-attached'),
        ),
        trimFocused: vi.fn(),
        liveSettled: signal(false),
        refill: vi.fn(() => of(undefined)),
        resources: () => ({ listenerCount: 11, retainedBytes: 64 }),
        clientStatus: vi.fn((): ConversationClientStatus => 'attached'),
        visible,
        released,
        history,
      };
      const created = controllers.get(key.roomId) ?? [];
      created.push(controller);
      controllers.set(key.roomId, created);
      return controller;
    }),
  };
  const errors = { handleError: vi.fn() };
  const accountIds = signal<readonly string[]>([ALICE, BOB]);
  TestBed.configureTestingModule({
    providers: [
      ConversationRuntime,
      { provide: ErrorHandler, useValue: errors },
      {
        provide: MatrixClientService,
        useValue: {
          accountIds: accountIds.asReadonly(),
          softLoggedOut: signal<readonly string[]>([]),
        },
      },
      { provide: CONVERSATION_TIMELINE_FACTORY, useValue: factory },
      { provide: CONVERSATION_TEXT_SENDER, useValue: sender },
      { provide: CONVERSATION_MESSAGE_ADAPTER, useValue: messageAdapter },
      { provide: MediaPipeline, useValue: mediaPipeline },
      {
        provide: PrivacySettingsService,
        useValue: { keepPhotoMetadata: keepPhotoMetadata.asReadonly() },
      },
      { provide: CONVERSATION_RETENTION_LIMIT, useValue: retainedPerAccount },
    ],
  });
  const controller = (
    roomId: string,
    index = 0,
  ): TestConversationTimelineController => {
    const found = controllers.get(roomId)?.[index];
    if (!found) {
      throw new Error(`No test timeline controller for ${roomId} at ${index}.`);
    }
    return found;
  };
  return {
    runtime: TestBed.inject(ConversationRuntime),
    drafts: TestBed.inject(DraftStoreService),
    factory,
    controller,
    sender,
    sends,
    mediaEvents,
    mediaPipeline,
    messageAdapter,
    keepPhotoMetadata,
    errors,
    accountIds,
  };
}

function message(
  id: string,
  overrides: Partial<MessageView> = {},
): MessageView {
  return {
    id,
    key: id,
    senderId: ALICE,
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: 'hello',
    html: null,
    timestamp: 1,
    isOwn: true,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'text',
    media: null,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

async function realFactory(liveClient: () => MatrixClient | null) {
  const client = createClient({
    baseUrl: 'https://hs',
    userId: ALICE,
    fetchFn: () => Promise.reject(new Error('no network in unit tests')),
  });
  const room = new Room('!a:example.org', client, ALICE);
  client.store.storeRoom(room);
  const message = (n: number) =>
    new MatrixEvent({
      event_id: `$${n}`,
      room_id: room.roomId,
      type: 'm.room.message',
      sender: BOB,
      origin_server_ts: n,
      content: { msgtype: 'm.text', body: `${n}` },
    });
  room.getLiveTimeline().setPaginationToken('b1', Direction.Backward);
  await room.addLiveEvents(
    Array.from({ length: 100 }, (_, i) => message(i + 1)),
    { addToState: false },
  );
  noteSyncPosition(room, 'b101');
  await room.addLiveEvents(
    Array.from({ length: 100 }, (_, i) => message(i + 101)),
    { addToState: false },
  );
  vi.spyOn(TimelineService.prototype, 'open').mockImplementation(
    () => undefined,
  );
  vi.spyOn(ConversationTimelineReadiness.prototype, 'start').mockImplementation(
    () => undefined,
  );
  vi.spyOn(RealThreadsService.prototype, 'attach').mockImplementation(
    () => undefined,
  );
  vi.spyOn(RealPins.prototype, 'attach').mockImplementation(() => undefined);
  vi.spyOn(ConversationSearchController.prototype, 'attach').mockImplementation(
    () => undefined,
  );
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MatrixClientService,
        useValue: {
          clientFor: (accountId: string) =>
            accountId === ALICE ? (liveClient() ?? client) : null,
        },
      },
      { provide: MediaPipeline, useValue: {} },
      {
        provide: CONVERSATION_MESSAGE_ADAPTER,
        useValue: { flushReceipts: vi.fn() },
      },
    ],
  });
  const controller = TestBed.inject(CONVERSATION_TIMELINE_FACTORY).create({
    accountId: ALICE,
    roomId: room.roomId,
  });
  const loaded = () => room.getLiveTimeline().getEvents().length;
  return { client, room, controller, loaded };
}

describe('ConversationRuntime', () => {
  it('keys one immutable handle by exactly Account and Room', () => {
    const { runtime, factory } = setup();

    const first = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const same = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const otherAccount = runtime.focus({
      accountId: BOB,
      roomId: '!room:example.org',
    });

    expect(same).toBe(first);
    expect(otherAccount).not.toBe(first);
    expect(first.key).toEqual({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    expect(first.timeline.openRoomId).toBe('!room:example.org');
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(runtime.diagnostics().lastAttachDurationMs).toEqual(
      expect.any(Number),
    );
  });

  it('exposes the focused Conversation load state and routes retry to it', () => {
    const { runtime, factory } = setup();
    const loadState = signal<TimelineLoadState>({
      kind: 'error',
      reason: 'backfill-failed',
    });
    const retryLoad = vi.fn();
    vi.mocked(factory.create).mockImplementationOnce(
      (key) =>
        ({
          timeline: {
            ...timeline(key.roomId),
            loadState: loadState.asReadonly(),
            retryLoad,
          },
          search: {
            searchLoaded: vi.fn(),
            searchServer: vi.fn(),
            loadOlder: vi.fn(),
          },
          threads: { closeThread: vi.fn(), close: vi.fn() },
          pins: { release: vi.fn() },
          setVisible: vi.fn(),
          release: vi.fn(),
          resources: () => ({ listenerCount: 0, retainedBytes: 0 }),
        }) as unknown as ConversationTimelineController,
    );

    runtime.focus({ accountId: ALICE, roomId: '!a:example.org' });

    expect(runtime.timeline.loadState()).toEqual({
      kind: 'error',
      reason: 'backfill-failed',
    });
    runtime.timeline.retryLoad();
    expect(retryLoad).toHaveBeenCalledOnce();
  });

  it('is ready when nothing is focused', () => {
    const { runtime } = setup();
    expect(runtime.timeline.loadState()).toEqual({ kind: 'ready' });
  });

  describe("releasing a retired room's history", () => {
    it('trims the room back to its latest events once the handle is released', async () => {
      const { controller, loaded } = await realFactory(() => null);

      controller.releaseHistory();
      expect(loaded()).toBe(200);

      controller.release();
      controller.releaseHistory();

      expect(loaded()).toBe(100);
      expect(loaded()).toBeGreaterThanOrEqual(TRIM_KEEP);
    });

    it('trims a focused room while hidden only as far as its live view allows', async () => {
      const { room, controller, loaded } = await realFactory(() => null);
      await room.addLiveEvents(
        Array.from(
          { length: 10 },
          (_, i) =>
            new MatrixEvent({
              event_id: `$${i + 201}`,
              room_id: room.roomId,
              type: 'm.room.message',
              sender: BOB,
              origin_server_ts: i + 201,
              content: { msgtype: 'm.text', body: `${i + 201}` },
            }),
        ),
        { addToState: false },
      );
      const guard = vi.spyOn(TimelineService.prototype, 'liveTrimGuard');

      // Scrolled back: no guard, nothing trimmed.
      guard.mockReturnValue(null);
      controller.trimFocused({}, false);
      expect(loaded()).toBe(210);

      // A reply target before the only cut keeps everything.
      guard.mockReturnValue({ marked: [], kept: ['$180'] });
      controller.trimFocused({ kept: ['$50'] }, false);
      expect(loaded()).toBe(210);

      controller.trimFocused({}, false);
      expect(loaded()).toBe(110);
      expect(room.findEventById('$180')).toBeDefined();
    });

    it('keeps the messages the rows on screen quote', async () => {
      const { client, room, controller, loaded } = await realFactory(
        () => null,
      );
      const event = (n: number) =>
        new MatrixEvent({
          event_id: `$${n}`,
          room_id: room.roomId,
          type: 'm.room.message',
          sender: BOB,
          origin_server_ts: n,
          content: {
            msgtype: 'm.text',
            body: `${n}`,
            ...(n === 325
              ? { 'm.relates_to': { 'm.in_reply_to': { event_id: '$150' } } }
              : {}),
          },
        });
      const receive = (from: number, to: number) =>
        room.addLiveEvents(
          Array.from({ length: to - from + 1 }, (_, i) => event(from + i)),
          { addToState: false },
        );
      await receive(201, 260);
      noteSyncPosition(room, 'b261');
      await receive(261, 330);
      vi.mocked(TimelineService.prototype.open).mockRestore();
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      const timeline = controller.timeline as unknown as TimelineService;
      timeline.open(room.roomId, client);
      timeline.setLiveView('$320');

      controller.trimFocused({}, false);

      // Without the quote, the cut after $260 would take $150 and empty $325's preview.
      expect(room.findEventById('$150')).toBeDefined();
      expect(loaded()).toBe(230);
    });

    it('leaves a focused room at or under the high-water mark alone', async () => {
      const { controller, loaded } = await realFactory(() => null);
      vi.spyOn(TimelineService.prototype, 'liveTrimGuard').mockReturnValue({
        marked: [],
        kept: [],
      });

      controller.trimFocused({}, false);

      expect(loaded()).toBe(200);
    });

    it('trims a shown room only past the ceiling, and pages back in from where it cut', async () => {
      const { room, controller, loaded } = await realFactory(() => null);
      const guard = vi
        .spyOn(TimelineService.prototype, 'liveTrimGuard')
        .mockReturnValue({ marked: [], kept: [] });
      const token = () =>
        room.getLiveTimeline().getPaginationToken(Direction.Backward);
      const receive = async (from: number, count: number) => {
        await room.addLiveEvents(
          Array.from(
            { length: count },
            (_, i) =>
              new MatrixEvent({
                event_id: `$${from + i}`,
                room_id: room.roomId,
                type: 'm.room.message',
                sender: BOB,
                origin_server_ts: from + i,
                content: { msgtype: 'm.text', body: `${from + i}` },
              }),
          ),
          { addToState: false },
        );
        noteSyncPosition(room, `s${from + count}`);
      };
      for (let n = 201; n < 1001; n += 100) await receive(n, 100);

      controller.trimFocused({}, true);
      expect(loaded()).toBe(TRIM_CEILING);

      await receive(1001, 100);
      // A row on screen quotes $950: its preview reads the event.
      guard.mockReturnValue({ marked: ['$950'], kept: [] });
      controller.trimFocused({}, true);
      expect(loaded()).toBe(200);
      expect(token()).toBe('s901');
      expect(room.findEventById('$900')).toBeUndefined();
    });

    it("leaves the history of a client that is no longer the Account's live one", async () => {
      const replacement = createClient({ baseUrl: 'https://hs' });
      let live: MatrixClient | null = null;
      const { controller, loaded } = await realFactory(() => live);
      live = replacement;

      controller.release();
      controller.releaseHistory();

      expect(loaded()).toBe(200);
    });
  });

  it('shows the timeline before readiness resumes paging', () => {
    const calls: string[] = [];
    vi.spyOn(TimelineService.prototype, 'open').mockImplementation(
      () => undefined,
    );
    vi.spyOn(TimelineService.prototype, 'setVisible').mockImplementation(
      (v) => {
        calls.push(`timeline:${v}`);
      },
    );
    vi.spyOn(
      ConversationTimelineReadiness.prototype,
      'start',
    ).mockImplementation(() => undefined);
    vi.spyOn(
      ConversationTimelineReadiness.prototype,
      'setVisible',
    ).mockImplementation((v) => {
      calls.push(`readiness:${v}`);
    });
    vi.spyOn(RealThreadsService.prototype, 'attach').mockImplementation(
      () => undefined,
    );
    vi.spyOn(RealPins.prototype, 'attach').mockImplementation(() => undefined);
    vi.spyOn(
      ConversationSearchController.prototype,
      'attach',
    ).mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MatrixClientService,
          useValue: {
            clientFor: () => ({}),
            accountIds: signal([]),
            softLoggedOut: signal([]),
          },
        },
        { provide: MediaPipeline, useValue: {} },
        {
          provide: CONVERSATION_MESSAGE_ADAPTER,
          useValue: { flushReceipts: vi.fn() },
        },
      ],
    });
    const controller = TestBed.inject(CONVERSATION_TIMELINE_FACTORY).create({
      accountId: ALICE,
      roomId: '!a:example.org',
    });

    controller.setVisible(false);
    controller.setVisible(true);

    expect(calls).toEqual([
      'timeline:false',
      'readiness:false',
      'timeline:true',
      'readiness:true',
    ]);
  });

  it('blurs visibility while retaining a warm conversation', () => {
    const { runtime, controller } = setup();
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!a:example.org',
    });

    runtime.blur();

    expect(handle.state()).toBe('retained');
    expect(controller('!a:example.org').visible()).toBe(false);
    expect(controller('!a:example.org').released()).toBe(false);
    expect(runtime.focused()).toBeNull();
  });

  it('evicts the least-recently-used retained handle per Account', () => {
    const { runtime, controller } = setup(1);
    const first = runtime.focus({ accountId: ALICE, roomId: '!a:example.org' });
    runtime.focus({ accountId: ALICE, roomId: '!b:example.org' });
    const third = runtime.focus({ accountId: ALICE, roomId: '!c:example.org' });

    expect(first.state()).toBe('retired');
    expect(controller('!a:example.org').released()).toBe(true);
    expect(controller('!a:example.org').history()).toBe('released');
    expect(controller('!b:example.org').history()).toBe('kept');
    expect(controller('!c:example.org').history()).toBe('kept');
    expect(third.state()).toBe('focused');
    expect(runtime.diagnostics()).toMatchObject({
      activeHandles: 2,
      focusedHandles: 1,
      retainedHandles: 1,
      retiredHandles: 1,
      listenerCount: 22,
      retainedBytes: 64,
    });
  });

  it('retires every retained handle across Accounts but keeps the focused one', () => {
    const { runtime, controller } = setup();
    const a = runtime.focus({ accountId: ALICE, roomId: '!a:example.org' });
    const bob = runtime.focus({ accountId: BOB, roomId: '!bob:example.org' });
    const focused = runtime.focus({
      accountId: ALICE,
      roomId: '!c:example.org',
    });

    runtime.retireRetained();

    expect(a.state()).toBe('retired');
    expect(bob.state()).toBe('retired');
    expect(controller('!a:example.org').released()).toBe(true);
    expect(controller('!bob:example.org').released()).toBe(true);
    expect(controller('!a:example.org').history()).toBe('released');
    expect(controller('!bob:example.org').history()).toBe('released');
    expect(controller('!c:example.org').history()).toBe('kept');
    expect(focused.state()).toBe('focused');
    expect(runtime.focused()).toBe(focused);
    expect(controller('!c:example.org').released()).toBe(false);
    expect(runtime.diagnostics()).toMatchObject({
      activeHandles: 1,
      focusedHandles: 1,
      retainedHandles: 0,
      retiredHandles: 2,
    });
  });

  it('retires a handle even when releasing its history fails, and reports the failure', () => {
    const { runtime, controller, errors } = setup();
    const a = runtime.focus({ accountId: ALICE, roomId: '!a:example.org' });
    runtime.focus({ accountId: ALICE, roomId: '!b:example.org' });
    const failure = new Error('trim failed');
    vi.mocked(controller('!a:example.org').releaseHistory).mockImplementation(
      () => {
        throw failure;
      },
    );

    runtime.retireRetained();

    expect(a.state()).toBe('retired');
    expect(controller('!a:example.org').released()).toBe(true);
    expect(errors.handleError).toHaveBeenCalledWith(failure);
  });

  it('pages a rewound room back in through the handle that holds it, and only that one', async () => {
    const { runtime, controller } = setup();
    runtime.focus({ accountId: ALICE, roomId: '!a:example.org' });

    await firstValueFrom(runtime.refillHeld(ALICE, '!a:example.org', 40), {
      defaultValue: undefined,
    });
    await firstValueFrom(runtime.refillHeld(BOB, '!a:example.org', 40), {
      defaultValue: undefined,
    });

    expect(controller('!a:example.org').refill).toHaveBeenCalledExactlyOnceWith(
      40,
    );
  });

  describe("a room's client", () => {
    it('reports whether the account still has the client it attached to', async () => {
      let live: MatrixClient | null = null;
      const { controller } = await realFactory(() => live);
      const matrix = TestBed.inject(MatrixClientService);

      expect(controller.clientStatus()).toBe('attached');

      live = createClient({ baseUrl: 'https://hs', userId: ALICE });
      expect(controller.clientStatus()).toBe('replaced');

      vi.spyOn(matrix, 'clientFor').mockReturnValue(null);
      expect(controller.clientStatus()).toBe('removed');
      controller.release();
    });

    it('opens a warm room afresh once its account signed out and in again', () => {
      const { runtime, factory, controller } = setup();
      const x = { accountId: ALICE, roomId: '!x:example.org' };
      const stale = runtime.focus(x);
      runtime.focus({ accountId: ALICE, roomId: '!y:example.org' });
      vi.mocked(controller('!x:example.org').clientStatus).mockReturnValue(
        'replaced',
      );

      const fresh = runtime.focus(x);

      expect(fresh).not.toBe(stale);
      expect(stale.state()).toBe('retired');
      expect(controller('!x:example.org').released()).toBe(true);
      expect(controller('!x:example.org', 1).visible()).toBe(true);
      expect(factory.create).toHaveBeenCalledTimes(3);
    });

    it('keeps a warm room whose account has no client to open it with', () => {
      const { runtime, factory, controller } = setup();
      const x = { accountId: ALICE, roomId: '!x:example.org' };
      const warm = runtime.focus(x);
      runtime.focus({ accountId: ALICE, roomId: '!y:example.org' });
      vi.mocked(controller('!x:example.org').clientStatus).mockReturnValue(
        'removed',
      );

      expect(runtime.focus(x)).toBe(warm);
      expect(factory.create).toHaveBeenCalledTimes(2);
    });

    it("reopens the room on screen on its account's new client", () => {
      const { runtime, controller, accountIds } = setup();
      const x = { accountId: ALICE, roomId: '!x:example.org' };
      const shown = runtime.focus(x);
      TestBed.tick();
      vi.mocked(controller('!x:example.org').clientStatus).mockReturnValue(
        'replaced',
      );

      accountIds.set([BOB, ALICE]);
      TestBed.tick();

      expect(runtime.focused()).not.toBe(shown);
      expect(runtime.focused()?.key).toEqual(x);
      expect(controller('!x:example.org').released()).toBe(true);
      expect(controller('!x:example.org', 1).visible()).toBe(true);
    });

    it('carries an edit in progress over when the room on screen reopens', () => {
      const { runtime, controller, accountIds } = setup(2, undefined, [
        message('$edit'),
      ]);
      const x = { accountId: ALICE, roomId: '!x:example.org' };
      runtime.focus(x).messages.beginEdit('$edit', 'original message');
      TestBed.tick();
      vi.mocked(controller('!x:example.org').clientStatus).mockReturnValue(
        'replaced',
      );

      accountIds.set([BOB, ALICE]);
      TestBed.tick();

      expect(runtime.focused()?.compose.intent()).toEqual({
        kind: 'edit',
        eventId: '$edit',
      });
      expect(runtime.focused()?.compose.draft()).toBe('original message');
    });

    it('keeps the room on screen while its account has no client', () => {
      const { runtime, controller, accountIds } = setup();
      const shown = runtime.focus({
        accountId: ALICE,
        roomId: '!x:example.org',
      });
      TestBed.tick();
      vi.mocked(controller('!x:example.org').clientStatus).mockReturnValue(
        'removed',
      );

      accountIds.set([BOB]);
      TestBed.tick();

      expect(runtime.focused()).toBe(shown);
      expect(controller('!x:example.org').released()).toBe(false);
    });

    it('retires the warm rooms of an account that signed out or has another client', () => {
      const { runtime, controller, accountIds } = setup();
      runtime.focus({ accountId: ALICE, roomId: '!x:example.org' });
      runtime.focus({ accountId: ALICE, roomId: '!y:example.org' });
      runtime.focus({ accountId: BOB, roomId: '!z:example.org' });
      TestBed.tick();
      vi.mocked(controller('!x:example.org').clientStatus).mockReturnValue(
        'removed',
      );
      vi.mocked(controller('!y:example.org').clientStatus).mockReturnValue(
        'replaced',
      );

      accountIds.set([BOB]);
      TestBed.tick();

      expect(runtime.holds(ALICE, '!x:example.org')).toBe(false);
      expect(runtime.holds(ALICE, '!y:example.org')).toBe(false);
      expect(controller('!x:example.org').released()).toBe(true);
      expect(controller('!y:example.org').released()).toBe(true);
      expect(runtime.holds(BOB, '!z:example.org')).toBe(true);
    });
  });

  describe('while the window is hidden', () => {
    const A = { accountId: ALICE, roomId: '!a:example.org' };
    const B = { accountId: ALICE, roomId: '!b:example.org' };

    it('trims the focused room only while the window is hidden', () => {
      const { runtime, controller } = setup();
      runtime.focus(B);
      runtime.focus(A);
      const trim = vi.mocked(controller(A.roomId).trimFocused);

      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).not.toHaveBeenCalled();

      expect(runtime.windowHidden()).toBe(false);
      const hidden = runtime.trimFocusedWhileHidden().subscribe();
      expect(runtime.windowHidden()).toBe(true);
      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).toHaveBeenCalledExactlyOnceWith(
        { kept: [], marked: [] },
        false,
      );

      // A retained room, or the same room on another Account, waits for its handle to retire.
      runtime.trimHeld(ALICE, B.roomId);
      runtime.trimHeld(BOB, A.roomId);
      expect(controller(B.roomId).trimFocused).not.toHaveBeenCalled();

      hidden.unsubscribe();
      expect(runtime.windowHidden()).toBe(false);
      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).toHaveBeenCalledOnce();
    });

    it("keeps the event the composer replies to or edits, and the open thread's root below the ceiling", () => {
      const { runtime, controller } = setup(2, undefined, [message('$target')]);
      const handle = runtime.focus(A);
      const trim = vi.mocked(controller(A.roomId).trimFocused);
      const hidden = runtime.trimFocusedWhileHidden().subscribe();

      handle.messages.beginReply('$target');
      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).toHaveBeenLastCalledWith(
        { kept: ['$target'], marked: [] },
        false,
      );

      handle.messages.beginEdit('$target', 'changed');
      (
        controller(A.roomId).threads.openThreadRootId as ReturnType<
          typeof signal<string | null>
        >
      ).set('$root');
      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).toHaveBeenLastCalledWith(
        { kept: ['$target'], marked: ['$root'] },
        false,
      );
      hidden.unsubscribe();
    });

    it('leaves a failed trim to the trimmer to report, and keeps the room', () => {
      const { runtime, controller, errors } = setup();
      runtime.focus(A);
      const failure = new Error('trim failed');
      vi.mocked(controller(A.roomId).trimFocused).mockImplementation(() => {
        throw failure;
      });
      const hidden = runtime.trimFocusedWhileHidden().subscribe();

      expect(() => runtime.trimHeld(ALICE, A.roomId)).toThrow(failure);
      expect(errors.handleError).not.toHaveBeenCalled();
      expect(runtime.focused()?.key).toEqual(A);
      hidden.unsubscribe();
    });
  });

  describe('while the open room is shown', () => {
    const A = { accountId: ALICE, roomId: '!a:example.org' };
    const B = { accountId: ALICE, roomId: '!b:example.org' };

    it('trims the focused room past the ceiling once its view has settled at the newest messages', () => {
      const { runtime, controller } = setup();
      const settled = (roomId: string) =>
        controller(roomId).liveSettled as ReturnType<typeof signal<boolean>>;
      runtime.focus(B);
      runtime.focus(A);
      const trim = vi.mocked(controller(A.roomId).trimFocused);

      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).not.toHaveBeenCalled();
      expect(runtime.trimsFocused()).toBeNull();

      settled(A.roomId).set(true);
      expect(runtime.trimsFocused()).toBe('settled');
      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).toHaveBeenCalledExactlyOnceWith(
        { kept: [], marked: [] },
        true,
      );

      // Hiding the window after the view settled is a new reason to trim, further back.
      const hidden = runtime.trimFocusedWhileHidden().subscribe();
      expect(runtime.trimsFocused()).toBe('hidden');
      hidden.unsubscribe();

      // A retained room's settled view is not the one on screen.
      settled(B.roomId).set(true);
      runtime.trimHeld(ALICE, B.roomId);
      expect(controller(B.roomId).trimFocused).not.toHaveBeenCalled();

      // Scrolled back again.
      settled(A.roomId).set(false);
      runtime.trimHeld(ALICE, A.roomId);
      expect(trim).toHaveBeenCalledOnce();
    });

    it("tells a room shown again where the list's view is, which may not change", () => {
      const { runtime, controller } = setup();
      runtime.focus(A);
      runtime.timeline.setLiveView('$shown');
      runtime.blur();

      runtime.focus(A);

      // Hidden, the timeline forgot it; the list reports only changes.
      expect(controller(A.roomId).timeline.setLiveView).toHaveBeenNthCalledWith(
        2,
        '$shown',
      );
    });

    it('leaves the room alone while a thread is open beside it', () => {
      const { runtime, controller } = setup();
      runtime.focus(A);
      (
        controller(A.roomId).liveSettled as ReturnType<typeof signal<boolean>>
      ).set(true);
      (
        controller(A.roomId).threads.openThreadRootId as ReturnType<
          typeof signal<string | null>
        >
      ).set('$root');

      runtime.trimHeld(ALICE, A.roomId);

      expect(controller(A.roomId).trimFocused).not.toHaveBeenCalled();
    });
  });

  it('says which rooms hold a live Conversation handle', () => {
    const { runtime } = setup(1);
    runtime.focus({ accountId: ALICE, roomId: '!a:example.org' });
    runtime.focus({ accountId: ALICE, roomId: '!b:example.org' });

    expect(runtime.holds(ALICE, '!a:example.org')).toBe(true);
    expect(runtime.holds(ALICE, '!b:example.org')).toBe(true);
    expect(runtime.holds(BOB, '!a:example.org')).toBe(false);

    runtime.focus({ accountId: ALICE, roomId: '!c:example.org' });

    expect(runtime.holds(ALICE, '!a:example.org')).toBe(false);
  });

  it('never reactivates an evicted handle when the same key is opened again', () => {
    const { runtime, controller } = setup(0);
    const retired = runtime.focus({
      accountId: ALICE,
      roomId: '!old:example.org',
    });
    runtime.focus({ accountId: ALICE, roomId: '!new:example.org' });

    const replacement = runtime.focus({
      accountId: ALICE,
      roomId: '!old:example.org',
    });

    expect(retired.state()).toBe('retired');
    expect(replacement).not.toBe(retired);
    expect(replacement.state()).toBe('focused');
    expect(controller('!old:example.org', 0).released()).toBe(true);
    expect(controller('!old:example.org', 1).released()).toBe(false);
  });

  it('protects the retained target while focus evicts the previous same-Account room', () => {
    const { runtime } = setup(1);
    const first = runtime.focus({
      accountId: ALICE,
      roomId: '!first:example.org',
    });
    const second = runtime.focus({
      accountId: ALICE,
      roomId: '!second:example.org',
    });

    const firstAgain = runtime.focus({
      accountId: ALICE,
      roomId: '!first:example.org',
    });

    expect(firstAgain).toBe(first);
    expect(first.state()).toBe('focused');
    expect(second.state()).toBe('retired');
  });

  it('retains independent per-Account conversations across account switches', () => {
    const { runtime, factory } = setup(1);
    const alice = runtime.focus({
      accountId: ALICE,
      roomId: '!alice:example.org',
    });
    const bob = runtime.focus({
      accountId: BOB,
      roomId: '!bob:example.org',
    });
    const aliceAgain = runtime.focus({
      accountId: ALICE,
      roomId: '!alice:example.org',
    });

    expect(aliceAgain).toBe(alice);
    expect(alice.state()).toBe('focused');
    expect(bob.state()).toBe('retained');
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it('keeps drafts independent when two Accounts share the same Room', () => {
    const { runtime } = setup();
    const alice = runtime.focus({
      accountId: ALICE,
      roomId: '!shared:example.org',
    });
    alice.compose.setDraft('alice draft');

    const bob = runtime.focus({
      accountId: BOB,
      roomId: '!shared:example.org',
    });

    expect(bob.compose.draft()).toBe('');
    bob.compose.setDraft('bob draft');
    expect(alice.compose.draft()).toBe('alice draft');
  });

  describe('keeping a draft for a conversation that is not on screen', () => {
    const KEY = { accountId: ALICE, roomId: '!room:example.org' };

    it('gives it to the handle that holds the conversation now', () => {
      const { runtime } = setup(2, undefined, [message('$edit')]);
      const held = runtime.focus(KEY);
      runtime.focus({ accountId: ALICE, roomId: '!other:example.org' });

      runtime.keepDraft(KEY, 'caption');

      expect(held.compose.draft()).toBe('caption');
    });

    it('keeps it in the message draft while an edit is in progress, shown once the edit ends', () => {
      const { runtime } = setup(2, undefined, [message('$edit')]);
      const held = runtime.focus(KEY);
      held.messages.beginEdit('$edit', 'original message');

      runtime.keepDraft(KEY, 'caption');

      expect(held.compose.draft()).toBe('original message');
      held.compose.cancelIntent();
      expect(held.compose.draft()).toBe('caption');
    });

    it('adds it after text already in the draft', () => {
      const { runtime } = setup();
      const held = runtime.focus(KEY);
      held.compose.setDraft('typed since');

      runtime.keepDraft(KEY, 'caption');

      expect(held.compose.draft()).toBe('typed since\n\ncaption');
    });

    it('keeps a caption that reads like the message still sending', async () => {
      const { runtime, sends, drafts } = setup();
      const held = runtime.focus(KEY);
      held.compose.setDraft('ok');
      const outcome = firstValueFrom(held.compose.submit());
      runtime.focus({ accountId: ALICE, roomId: '!other:example.org' });
      runtime.retireRetained();

      runtime.keepDraft(KEY, 'ok');
      sends.next({ kind: 'accepted', eventId: '$sent' });
      await outcome;

      expect(drafts.get(conversationDraftKey(KEY))).toBe('ok');
    });

    it('drops sent text from storage even when a reply began while it was sending', async () => {
      const { runtime, sends, drafts } = setup(2, undefined, [
        message('$target'),
      ]);
      const held = runtime.focus(KEY);
      held.compose.setDraft('hi');
      const outcome = firstValueFrom(held.compose.submit());

      held.messages.beginReply('$target');
      sends.next({ kind: 'accepted', eventId: '$sent' });
      await outcome;

      expect(drafts.get(conversationDraftKey(KEY))).toBe('');
      expect(held.compose.intent()).toEqual({
        kind: 'reply',
        eventId: '$target',
      });
    });

    describe('while a text send is in flight', () => {
      function sending(retire = false) {
        const fixture = setup(2, undefined, [message('$target')]);
        const held = fixture.runtime.focus(KEY);
        held.compose.setDraft('text');
        const outcome = firstValueFrom(held.compose.submit());
        if (retire) {
          fixture.runtime.focus({
            accountId: ALICE,
            roomId: '!other:example.org',
          });
          fixture.runtime.retireRetained();
        }
        fixture.runtime.keepDraft(KEY, 'caption');
        return {
          ...fixture,
          held,
          outcome,
          stored: () => fixture.drafts.get(conversationDraftKey(KEY)),
        };
      }

      it('keeps the failed text beside the caption, in the box and in storage', async () => {
        const { held, sends, outcome, stored } = sending();
        sends.next({ kind: 'rejected', retryable: true });
        await outcome;

        expect(held.compose.draft()).toBe('text\n\ncaption');
        expect(stored()).toBe('text\n\ncaption');
      });

      it('keeps only the caption once the text is sent', async () => {
        const { held, sends, outcome, stored } = sending();
        sends.next({ kind: 'accepted', eventId: '$sent' });
        await outcome;

        expect(held.compose.draft()).toBe('caption');
        expect(stored()).toBe('caption');
      });

      it('keeps a late caption alone in a retired handle’s stored draft, before and after the send settles', async () => {
        const { sends, outcome, stored } = sending(true);
        expect(stored()).toBe('caption');

        sends.next({ kind: 'accepted', eventId: '$sent' });
        await outcome;

        expect(stored()).toBe('caption');
      });

      it('keeps only the caption when the text fails into a failed message', async () => {
        const { held, sends, outcome, stored } = sending();
        sends.next({ kind: 'failed' });
        await outcome;

        expect(held.compose.draft()).toBe('caption');
        expect(stored()).toBe('caption');
      });

      it('lets a retired handle restore the failed text beside the caption', async () => {
        const { sends, outcome, stored } = sending(true);
        sends.next({ kind: 'rejected', retryable: true });
        await outcome;

        expect(stored()).toBe('text\n\ncaption');
      });
    });

    it('puts a failed send back in front of a newer handle’s text after its own handle retired', async () => {
      const { runtime, sends, drafts } = setup();
      const old = runtime.focus(KEY);
      old.compose.setDraft('failed text');
      const outcome = firstValueFrom(old.compose.submit());
      old.compose.setDraft(''); // the box clears on send
      runtime.focus({ accountId: ALICE, roomId: '!other:example.org' });
      runtime.retireRetained();
      const fresh = runtime.focus(KEY);
      fresh.compose.setDraft('new text');

      sends.next({ kind: 'rejected', retryable: true });
      await outcome;

      expect(fresh.compose.draft()).toBe('failed text\n\nnew text');
      expect(drafts.get(conversationDraftKey(KEY))).toBe(
        'failed text\n\nnew text',
      );
      fresh.compose.setDraft('failed text\n\nnew text!');
      expect(drafts.get(conversationDraftKey(KEY))).toBe(
        'failed text\n\nnew text!',
      );
    });

    describe('a send that succeeds after its handle retired', () => {
      async function reopenWhileSending() {
        const fixture = setup();
        const old = fixture.runtime.focus(KEY);
        old.compose.setDraft('hi');
        const outcome = firstValueFrom(old.compose.submit());
        fixture.runtime.focus({
          accountId: ALICE,
          roomId: '!other:example.org',
        });
        fixture.runtime.retireRetained();
        const fresh = fixture.runtime.focus(KEY);
        return { ...fixture, fresh, outcome };
      }

      it('shows the text nowhere in the reopened box, so it cannot go out twice', async () => {
        const { fresh, sends, sender, drafts, outcome } =
          await reopenWhileSending();
        expect(fresh.compose.draft()).toBe('');
        expect(drafts.get(conversationDraftKey(KEY))).toBe('');
        await expect(firstValueFrom(fresh.compose.submit())).resolves.toEqual({
          kind: 'rejected',
          failure: 'empty-draft',
          retryable: false,
        });

        sends.next({ kind: 'accepted', eventId: '$sent' });
        await outcome;

        expect(fresh.compose.draft()).toBe('');
        expect(sender.send).toHaveBeenCalledOnce();
      });

      it('keeps what the person changed in the reopened box', async () => {
        const { fresh, sends, drafts, outcome } = await reopenWhileSending();
        fresh.compose.setDraft('hi there');

        sends.next({ kind: 'accepted', eventId: '$sent' });
        await outcome;

        expect(fresh.compose.draft()).toBe('hi there');
        expect(drafts.get(conversationDraftKey(KEY))).toBe('hi there');
      });
    });

    describe('sends that settle after their handle retired', () => {
      /** Send `text` from a fresh handle for the room, then retire it. */
      function sendAndRetire(
        fixture: ReturnType<typeof setup>,
        text: string,
      ): Promise<unknown> {
        const handle = fixture.runtime.focus(KEY);
        handle.compose.setDraft(text);
        const outcome = firstValueFrom(handle.compose.submit());
        fixture.runtime.focus({
          accountId: ALICE,
          roomId: '!other:example.org',
        });
        fixture.runtime.retireRetained();
        return outcome;
      }

      /** One sender per send, so each can settle on its own. */
      function twoSends() {
        const first = new Subject<ConversationTextDelivery>();
        const second = new Subject<ConversationTextDelivery>();
        const outcomes = [first, second];
        const sender: ConversationTextSender = {
          send: vi.fn(() => ({
            outcome:
              outcomes.shift() ?? new Subject<ConversationTextDelivery>(),
            cancel: () => false,
          })),
        };
        return { fixture: setup(2, sender), first, second };
      }

      const stored = (fixture: ReturnType<typeof setup>) =>
        fixture.drafts.get(conversationDraftKey(KEY));

      it('does not store a failed send for an account that has signed out', async () => {
        const fixture = setup();
        const failed = sendAndRetire(fixture, 'private text');
        fixture.accountIds.set([BOB]);
        TestBed.tick();

        fixture.sends.next({ kind: 'rejected', retryable: true });
        await failed;

        expect(stored(fixture) ?? '').toBe('');
      });

      it('does not store a failed send from the open room of an account that has signed out', async () => {
        // The room on screen keeps its handle when its account's client is removed.
        const fixture = setup();
        const handle = fixture.runtime.focus(KEY);
        handle.compose.setDraft('private text');
        const failed = firstValueFrom(handle.compose.submit());
        vi.mocked(fixture.controller(KEY.roomId).clientStatus).mockReturnValue(
          'removed',
        );
        fixture.accountIds.set([BOB]);
        TestBed.tick();
        fixture.drafts.clearAll();

        fixture.sends.next({ kind: 'rejected', retryable: true });
        await failed;

        expect(stored(fixture) ?? '').toBe('');
      });

      it('puts back and drops from storage alone when no handle holds the room', async () => {
        const failing = setup();
        const failed = sendAndRetire(failing, 'x');
        failing.sends.next({ kind: 'rejected', retryable: true });
        await failed;
        expect(stored(failing)).toBe('x');

        TestBed.resetTestingModule();
        const sending = setup();
        const sent = sendAndRetire(sending, 'y');
        sending.sends.next({ kind: 'accepted', eventId: '$y' });
        await sent;
        expect(stored(sending)).toBe('');
      });

      it('puts a failed send into the message draft of a handle that is editing', async () => {
        const fixture = setup(2, undefined, [message('$edit')]);
        const outcome = sendAndRetire(fixture, 'x');
        const live = fixture.runtime.focus(KEY);
        live.compose.setDraft('mine');
        live.messages.beginEdit('$edit', 'edit body');

        fixture.sends.next({ kind: 'rejected', retryable: true });
        await outcome;

        expect(live.compose.draft()).toBe('edit body');
        expect(stored(fixture)).toBe('x\n\nmine');
        live.compose.cancelIntent();
        expect(live.compose.draft()).toBe('x\n\nmine');
      });

      it('keeps the message of a handle that is itself sending when another fails', async () => {
        const { fixture, first, second } = twoSends();
        const failed = sendAndRetire(fixture, 'x');
        const live = fixture.runtime.focus(KEY);
        live.compose.setDraft('y');
        const sent = firstValueFrom(live.compose.submit());

        first.next({ kind: 'rejected', retryable: true });
        await failed;
        expect(stored(fixture)).toBe('x'); // y left the draft when it was sent

        second.next({ kind: 'accepted', eventId: '$y' });
        await sent;
        expect(live.compose.draft()).toBe('x');
        expect(stored(fixture)).toBe('x');
      });

      for (const failFirst of [true, false]) {
        it(`leaves the box empty when two sends settle out of order, ${failFirst ? 'failure' : 'success'} first`, async () => {
          const { fixture, first, second } = twoSends();
          const failed = sendAndRetire(fixture, 'same');
          const sent = sendAndRetire(fixture, 'same');
          const live = fixture.runtime.focus(KEY);

          const settle = [
            () => first.next({ kind: 'failed' }),
            () => second.next({ kind: 'accepted', eventId: '$y' }),
          ];
          if (!failFirst) settle.reverse();
          settle.forEach((step) => step());
          await Promise.all([failed, sent]);

          expect(live.compose.draft()).toBe('');
          expect(stored(fixture)).toBe('');
        });
      }

      for (const failFirst of [true, false]) {
        it(`leaves only the failed text when two retired sends settle, ${failFirst ? 'failure' : 'success'} first`, async () => {
          const { fixture, first, second } = twoSends();
          const failed = sendAndRetire(fixture, 'x');
          const sent = sendAndRetire(fixture, 'y');
          const live = fixture.runtime.focus(KEY);

          const settle = [
            () => first.next({ kind: 'rejected', retryable: true }),
            () => second.next({ kind: 'accepted', eventId: '$y' }),
          ];
          if (!failFirst) settle.reverse();
          settle.forEach((step) => step());
          await Promise.all([failed, sent]);

          expect(live.compose.draft()).toBe('x');
          expect(stored(fixture)).toBe('x');
        });
      }
    });

    it('does not keep a reply open after its send succeeds', async () => {
      const { runtime, sends } = setup(2, undefined, [message('$target')]);
      const held = runtime.focus(KEY);
      held.messages.beginReply('$target');
      held.compose.setDraft('reply');
      const outcome = firstValueFrom(held.compose.submit());

      runtime.keepDraft(KEY, 'caption');
      sends.next({ kind: 'accepted', eventId: '$sent' });
      await outcome;

      expect(held.compose.intent()).toEqual({ kind: 'message' });
      expect(held.compose.draft()).toBe('caption');
    });

    it('does not keep an edit open after it is saved', async () => {
      const { runtime, sends } = setup(2, undefined, [message('$target')]);
      const held = runtime.focus(KEY);
      held.messages.beginEdit('$target', 'original');
      held.compose.setDraft('edited');
      const outcome = firstValueFrom(held.compose.submit());

      runtime.keepDraft(KEY, 'caption');
      sends.next({ kind: 'accepted', eventId: '$sent' });
      await outcome;

      expect(held.compose.intent()).toEqual({ kind: 'message' });
      expect(held.compose.draft()).toBe('caption');
    });

    it('stores it for the next handle when none holds the conversation', () => {
      const { runtime } = setup();

      runtime.keepDraft(KEY, 'caption');

      expect(runtime.focus(KEY).compose.draft()).toBe('caption');
    });
  });

  it('starts reply and edit intent only for eligible presented messages', () => {
    const editable = message('$editable');
    const unavailable = message('$failed', { status: 'failed' });
    const { runtime } = setup(2, undefined, [editable, unavailable]);
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });

    expect(handle.messages.beginReply('$editable')).toEqual({
      kind: 'applied',
      operation: 'reply',
    });
    expect(handle.compose.intent()).toEqual({
      kind: 'reply',
      eventId: '$editable',
    });
    expect(handle.messages.beginEdit('$editable', 'updated')).toEqual({
      kind: 'applied',
      operation: 'edit',
    });
    expect(handle.compose.draft()).toBe('updated');
    expect(handle.messages.beginEdit('$failed', 'ignored')).toMatchObject({
      kind: 'rejected',
      failure: 'message-unavailable',
      retryable: false,
    });
  });

  it('keeps message actions cold and binds them to the immutable handle key', async () => {
    const { runtime, messageAdapter } = setup();
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const command = handle.messages.toggleReaction('$message', '👍');

    expect(messageAdapter.toggleReaction).not.toHaveBeenCalled();
    await firstValueFrom(command);
    expect(messageAdapter.toggleReaction).toHaveBeenCalledWith({
      key: handle.key,
      messageId: '$message',
      reaction: '👍',
    });
  });

  it('rejects a retained handle command and resolves the focused proxy on subscribe', async () => {
    const { runtime, messageAdapter } = setup();
    const alice = runtime.focus({
      accountId: ALICE,
      roomId: '!same:example.org',
    });
    const focusedCommand = runtime.messages.redact('$message');
    const bob = runtime.focus({
      accountId: BOB,
      roomId: '!same:example.org',
    });

    await expect(
      firstValueFrom(alice.messages.redact('$message')),
    ).resolves.toMatchObject({
      kind: 'rejected',
      operation: 'redaction',
      failure: 'conversation-unavailable',
    });
    await firstValueFrom(focusedCommand);
    expect(messageAdapter.redact).toHaveBeenCalledWith({
      key: bob.key,
      messageId: '$message',
    });
  });

  it('releases every listener-owning child when the runtime is retired', () => {
    const { runtime, controller } = setup();
    const alice = runtime.focus({
      accountId: ALICE,
      roomId: '!alice:example.org',
    });
    const bob = runtime.focus({
      accountId: BOB,
      roomId: '!bob:example.org',
    });

    runtime.retireAll();

    expect(alice.state()).toBe('retired');
    expect(bob.state()).toBe('retired');
    expect(controller('!alice:example.org').released()).toBe(true);
    expect(controller('!bob:example.org').released()).toBe(true);
    // Sign-out and teardown stop the client; there is no history left to keep small.
    expect(controller('!alice:example.org').history()).toBe('kept');
    expect(controller('!bob:example.org').history()).toBe('kept');
    expect(runtime.diagnostics()).toMatchObject({
      activeHandles: 0,
      focusedHandles: 0,
      retainedHandles: 0,
      listenerCount: 0,
      retainedBytes: 0,
    });
  });

  it('restores draft and reply/edit intent with the exact retained conversation', () => {
    const { runtime } = setup(2, undefined, [
      message('$reply'),
      message('$edit'),
    ]);
    const first = runtime.focus({
      accountId: ALICE,
      roomId: '!first:example.org',
    });
    first.compose.setDraft('half written');
    first.messages.beginReply('$reply');

    runtime.focus({ accountId: ALICE, roomId: '!second:example.org' });
    const restored = runtime.focus({
      accountId: ALICE,
      roomId: '!first:example.org',
    });

    expect(restored).toBe(first);
    expect(restored.compose.draft()).toBe('half written');
    expect(restored.compose.intent()).toEqual({
      kind: 'reply',
      eventId: '$reply',
    });

    restored.messages.beginEdit('$edit', 'original message');
    expect(restored.compose.intent()).toEqual({
      kind: 'edit',
      eventId: '$edit',
    });
    expect(restored.compose.draft()).toBe('original message');
    restored.compose.setDraft('edited message');
    restored.compose.cancelIntent();
    expect(restored.compose.draft()).toBe('half written');
  });

  it('restores compose intent after the timeline handle is evicted', () => {
    const { runtime } = setup(0, undefined, [message('$edit')]);
    const original = runtime.focus({
      accountId: ALICE,
      roomId: '!original:example.org',
    });
    original.compose.setDraft('parked message');
    original.messages.beginEdit('$edit', 'edited text');
    runtime.focus({ accountId: ALICE, roomId: '!other:example.org' });

    const restored = runtime.focus({
      accountId: ALICE,
      roomId: '!original:example.org',
    });

    expect(restored).not.toBe(original);
    expect(restored.compose.intent()).toEqual({
      kind: 'edit',
      eventId: '$edit',
    });
    expect(restored.compose.draft()).toBe('edited text');
    restored.compose.cancelIntent();
    expect(restored.compose.draft()).toBe('parked message');
  });

  it('keeps submit cold and succeeds only with an accepted authoritative local echo', async () => {
    const { runtime, drafts, sender, sends } = setup();
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    handle.compose.setDraft('hello');
    const persist = vi.spyOn(drafts, 'set');
    persist.mockClear();
    const request: ConversationTextSendRequest = {
      key: handle.key,
      body: 'hello',
      mentions: [],
      intent: { kind: 'message' },
    };

    const command = handle.compose.submit();
    expect(sender.send).not.toHaveBeenCalled();
    const outcomePromise = firstValueFrom(command);
    expect(sender.send).toHaveBeenCalledWith(request);
    expect(handle.compose.sending()).toBe(true);
    // The text leaves the stored draft with the send, not when it settles.
    expect(persist).toHaveBeenCalledExactlyOnceWith(expect.any(String), '');
    sends.next({ kind: 'accepted', eventId: '$local-echo' });
    sends.complete();

    await expect(outcomePromise).resolves.toEqual({
      kind: 'sent',
      eventId: '$local-echo',
    });
    expect(handle.compose.draft()).toBe('');
    expect(handle.compose.intent()).toEqual({ kind: 'message' });
    expect(handle.compose.sending()).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('keeps media transfer cold and binds it to the immutable Account-and-Room handle', async () => {
    const { runtime, mediaPipeline, mediaEvents } = setup();
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const media = Object.freeze({
      id: 'staged-media-1',
      filename: 'secret.png',
      mimeType: 'image/png',
      size: 4,
      previewUrl: null,
    }) as StagedMediaReference;

    const command = handle.media.send(media, 'classified');
    expect(mediaPipeline.transfer).not.toHaveBeenCalled();
    const outcome = firstValueFrom(command);
    expect(mediaPipeline.transfer).toHaveBeenCalledWith({
      key: handle.key,
      media,
      caption: 'classified',
      imageMetadata: 'strip',
    });
    mediaEvents.next({ kind: 'sent', eventId: '$media' });
    mediaEvents.complete();

    await expect(outcome).resolves.toEqual({
      kind: 'sent',
      eventId: '$media',
    });
  });

  it('resolves the focused media target only when the command is subscribed', () => {
    const { runtime, mediaPipeline } = setup();
    const media = Object.freeze({
      id: 'staged-media-1',
      filename: 'secret.png',
      mimeType: 'image/png',
      size: 4,
      previewUrl: null,
    }) as StagedMediaReference;
    runtime.focus({ accountId: ALICE, roomId: '!first:example.org' });
    const command = runtime.media.send(media, '');
    runtime.focus({ accountId: BOB, roomId: '!second:example.org' });

    const subscription = command.subscribe();

    expect(mediaPipeline.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        key: { accountId: BOB, roomId: '!second:example.org' },
      }),
    );
    subscription.unsubscribe();
  });

  it('returns a typed rejection and restores the durable intent', async () => {
    const { runtime, sends } = setup(2, undefined, [message('$target')]);
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const compose = handle.compose;
    compose.setDraft('try again');
    handle.messages.beginReply('$target');

    const outcomePromise = firstValueFrom(compose.submit());
    sends.next({ kind: 'rejected', retryable: true });
    sends.complete();

    await expect(outcomePromise).resolves.toEqual({
      kind: 'rejected',
      failure: 'send-rejected',
      retryable: true,
    });
    expect(compose.draft()).toBe('try again');
    expect(compose.intent()).toEqual({ kind: 'reply', eventId: '$target' });
  });

  it('leaves a failed send to its failed message: the box stays empty and the reply ends', async () => {
    const { runtime, sends, drafts } = setup(2, undefined, [
      message('$target'),
    ]);
    const key = { accountId: ALICE, roomId: '!room:example.org' };
    const handle = runtime.focus(key);
    handle.compose.setDraft('refused');
    handle.messages.beginReply('$target');

    const outcome = firstValueFrom(handle.compose.submit());
    sends.next({ kind: 'failed' });

    await expect(outcome).resolves.toEqual({
      kind: 'rejected',
      failure: 'send-rejected',
      retryable: true,
    });
    expect(handle.compose.draft()).toBe('');
    expect(handle.compose.intent()).toEqual({ kind: 'message' });
    expect(drafts.get(conversationDraftKey(key))).toBe('');
  });

  it('retries a failed message while editing another without putting its text in the box', async () => {
    const { runtime, sends, sender, messageAdapter } = setup(2, undefined, [
      message('$edit'),
    ]);
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    handle.compose.setDraft('failed text');
    const outcome = firstValueFrom(handle.compose.submit());
    sends.next({ kind: 'failed' });
    await outcome;

    handle.messages.beginEdit('$edit', 'edit body');
    await firstValueFrom(handle.messages.retry('~!room:example.org:txn-1'));
    expect(handle.compose.draft()).toBe('edit body');
    handle.compose.cancelIntent();

    expect(messageAdapter.retry).toHaveBeenCalledOnce();
    expect(handle.compose.draft()).toBe('');
    await expect(firstValueFrom(handle.compose.submit())).resolves.toEqual({
      kind: 'rejected',
      failure: 'empty-draft',
      retryable: false,
    });
    expect(sender.send).toHaveBeenCalledOnce();
  });

  describe('taking a failed message back to the composer', () => {
    const KEY = { accountId: ALICE, roomId: '!room:example.org' };
    const ID = '~!room:example.org:txn-1';

    it('cancels it and puts its text and reply in front of the draft, letting its hold go', async () => {
      const { runtime, drafts, messageAdapter } = setup();
      const handle = runtime.focus(KEY);
      drafts.holdWaiting(conversationDraftKey(KEY), 'txn-1', {
        body: 'refused',
        replyTo: '$target',
      });
      handle.compose.setDraft('typed since');

      await expect(
        firstValueFrom(handle.messages.toComposer(ID)),
      ).resolves.toEqual({ kind: 'applied', operation: 'cancel' });

      expect(messageAdapter.cancel).toHaveBeenCalledWith({
        key: KEY,
        messageId: ID,
      });
      expect(handle.compose.draft()).toBe('refused\n\ntyped since');
      expect(handle.compose.intent()).toEqual({
        kind: 'reply',
        eventId: '$target',
      });
      expect(drafts.pendingMessages(conversationDraftKey(KEY)).size).toBe(0);
    });

    it('leaves the draft and the hold alone when the cancel is refused', async () => {
      const { runtime, drafts, messageAdapter } = setup();
      const handle = runtime.focus(KEY);
      drafts.holdWaiting(conversationDraftKey(KEY), 'txn-1', {
        body: 'refused',
      });
      vi.mocked(messageAdapter.cancel).mockReturnValueOnce(
        of({
          kind: 'rejected',
          operation: 'cancel',
          failure: 'event-not-retryable',
          retryable: false,
        }),
      );

      await firstValueFrom(handle.messages.toComposer(ID));

      expect(handle.compose.draft()).toBe('');
      expect(drafts.pendingMessages(conversationDraftKey(KEY)).size).toBe(1);
    });

    it('switches a reply in progress to the one the failed message was written for', async () => {
      const { runtime, drafts } = setup(2, undefined, [message('$other')]);
      const handle = runtime.focus(KEY);
      drafts.holdWaiting(conversationDraftKey(KEY), 'txn-1', {
        body: 'refused',
        replyTo: '$target',
      });
      handle.messages.beginReply('$other');

      await firstValueFrom(handle.messages.toComposer(ID));

      expect(handle.compose.intent()).toEqual({
        kind: 'reply',
        eventId: '$target',
      });
    });

    it('refuses while another message is being edited, changing nothing', async () => {
      const { runtime, drafts, messageAdapter } = setup(2, undefined, [
        message('$edit'),
      ]);
      const handle = runtime.focus(KEY);
      drafts.holdWaiting(conversationDraftKey(KEY), 'txn-1', {
        body: 'refused',
      });
      handle.messages.beginEdit('$edit', 'edit body');

      await expect(
        firstValueFrom(handle.messages.toComposer(ID)),
      ).resolves.toMatchObject({
        kind: 'rejected',
        failure: 'edit-in-progress',
      });
      expect(messageAdapter.cancel).not.toHaveBeenCalled();
      expect(handle.compose.draft()).toBe('edit body');
      expect(drafts.pendingMessages(conversationDraftKey(KEY)).size).toBe(1);
    });

    it('does not add the text again when the draft already holds it', async () => {
      const { runtime, drafts } = setup();
      const handle = runtime.focus(KEY);
      drafts.holdWaiting(conversationDraftKey(KEY), 'txn-1', {
        body: 'refused',
      });
      handle.compose.setDraft('typed\n\nrefused');

      await firstValueFrom(handle.messages.toComposer(ID));

      expect(handle.compose.draft()).toBe('typed\n\nrefused');
    });

    it('refuses a message it holds no text for', async () => {
      const { runtime, messageAdapter } = setup();
      const handle = runtime.focus(KEY);

      await expect(
        firstValueFrom(handle.messages.toComposer(ID)),
      ).resolves.toMatchObject({
        kind: 'rejected',
        failure: 'message-unavailable',
      });
      expect(messageAdapter.cancel).not.toHaveBeenCalled();
    });
  });

  describe('showing held messages again', () => {
    const KEY = { accountId: ALICE, roomId: '!room:example.org' };
    function restoring() {
      const restore = vi.fn();
      const sender: ConversationTextSender = { send: vi.fn(), restore };
      return { restore, ...setup(2, sender) };
    }

    it('asks the sender when it opens a conversation', () => {
      const { runtime, restore } = restoring();

      runtime.focus(KEY);

      expect(restore).toHaveBeenCalledWith(KEY);
    });

    it('asks again once a room that was still loading has opened', () => {
      const { runtime, restore, controller } = restoring();
      runtime.focus(KEY);
      const loadState = controller(KEY.roomId).timeline
        .loadState as WritableSignal<TimelineLoadState>;
      loadState.set({
        kind: 'loading',
        reason: 'room-pending',
        partial: false,
      });
      TestBed.tick();
      restore.mockClear();

      loadState.set({ kind: 'ready' });
      TestBed.tick();

      expect(restore).toHaveBeenCalledWith(KEY);
    });

    it('asks again each time a retained conversation is focused', () => {
      const { runtime, restore } = restoring();
      runtime.focus(KEY);
      runtime.focus({ accountId: ALICE, roomId: '!other:example.org' });
      restore.mockClear();

      runtime.focus(KEY);

      expect(restore).toHaveBeenCalledWith(KEY);
    });
  });

  it('leaves a newer edit alone when an older one is refused', () => {
    const { runtime, sends } = setup(2, undefined, [
      message('$older'),
      message('$newer'),
    ]);
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const compose = handle.compose;
    handle.messages.beginEdit('$older', 'older text');
    const outcomes: ConversationTextSendOutcome[] = [];
    compose.submit().subscribe((outcome) => outcomes.push(outcome));

    handle.messages.beginEdit('$newer', 'newer text');
    sends.next({ kind: 'rejected', retryable: true });
    sends.complete();

    expect(outcomes).toEqual([
      { kind: 'rejected', failure: 'send-rejected', retryable: true },
    ]);
    expect(compose.intent()).toEqual({ kind: 'edit', eventId: '$newer' });
    expect(compose.draft()).toBe('newer text');
    expect(compose.sending()).toBe(false);
  });

  it('clears the composer for a send queued offline, without restoring it', async () => {
    const { runtime, sends, drafts } = setup(2, undefined, [
      message('$target'),
    ]);
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const compose = handle.compose;
    compose.setDraft('goes out later');
    handle.messages.beginReply('$target');

    const outcomePromise = firstValueFrom(compose.submit());
    sends.next({ kind: 'queued' });
    sends.complete();

    await expect(outcomePromise).resolves.toEqual({ kind: 'queued' });
    expect(compose.draft()).toBe('');
    expect(compose.intent()).toEqual({ kind: 'message' });
    expect(
      drafts.get(
        conversationDraftKey({ accountId: ALICE, roomId: '!room:example.org' }),
      ),
    ).toBe('');
  });

  it('cancels the finite command without losing the draft or leaving send state behind', () => {
    const cancelled = vi.fn(() => true);
    const sender: ConversationTextSender = {
      send: vi.fn(() => ({ outcome: NEVER, cancel: cancelled })),
    };
    const { runtime } = setup(2, sender);
    const compose = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    }).compose;
    compose.setDraft('  keep me  ');

    const subscription = compose.submit().subscribe();
    subscription.unsubscribe();

    expect(cancelled).toHaveBeenCalledOnce();
    expect(compose.sending()).toBe(false);
    expect(compose.draft()).toBe('  keep me  ');
  });

  it('does not restore a draft when SDK cancellation is indeterminate: the sender keeps the text', () => {
    const sender: ConversationTextSender = {
      send: vi.fn(() => ({ outcome: NEVER, cancel: () => false })),
    };
    const { runtime } = setup(0, sender);
    const original = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    original.compose.setDraft('durable text');

    const subscription = original.compose.submit().subscribe();
    subscription.unsubscribe();

    expect(original.compose.draft()).toBe('');
    runtime.focus({ accountId: ALICE, roomId: '!other:example.org' });
    const restored = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    expect(restored.compose.draft()).toBe('');
  });

  it('rejects a duplicate interaction without dispatching a second SDK send', async () => {
    const { runtime, sender } = setup();
    const compose = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    }).compose;
    compose.setDraft('once');
    const first = compose.submit().subscribe();

    await expect(firstValueFrom(compose.submit())).resolves.toEqual({
      kind: 'rejected',
      failure: 'send-in-progress',
      retryable: false,
    });
    expect(sender.send).toHaveBeenCalledOnce();
    first.unsubscribe();
  });

  describe('a plain message sent beside what is being composed', () => {
    const ROOM = { accountId: ALICE, roomId: '!room:example.org' };

    it('goes out as a new message and leaves an edit in progress alone', async () => {
      const { runtime, sender, sends } = setup(2, undefined, [
        message('$edit'),
      ]);
      const handle = runtime.focus(ROOM);
      handle.messages.beginEdit('$edit', 'original');
      handle.compose.setDraft('half-edited');

      const sent = firstValueFrom(handle.compose.sendMessage('holiday'));
      sends.next({ kind: 'accepted', eventId: '$caption' });

      await expect(sent).resolves.toEqual({
        kind: 'sent',
        eventId: '$caption',
      });
      expect(sender.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          body: 'holiday',
          intent: { kind: 'message' },
        }),
      );
      expect(handle.compose.intent()).toEqual({
        kind: 'edit',
        eventId: '$edit',
      });
      expect(handle.compose.draft()).toBe('half-edited');
    });

    it('leaves typed text and a reply in progress alone', async () => {
      const { runtime, sender, sends } = setup(2, undefined, [
        message('$target'),
      ]);
      const handle = runtime.focus(ROOM);
      handle.messages.beginReply('$target');
      handle.compose.setDraft('next message');

      const sent = firstValueFrom(handle.compose.sendMessage('holiday'));
      sends.next({ kind: 'accepted', eventId: '$caption' });
      await sent;

      expect(sender.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ intent: { kind: 'message' } }),
      );
      expect(handle.compose.draft()).toBe('next message');
      expect(handle.compose.intent()).toEqual({
        kind: 'reply',
        eventId: '$target',
      });
    });

    it('keeps text nothing sent after the typed draft', async () => {
      const { runtime, sends } = setup();
      const compose = runtime.focus(ROOM).compose;
      compose.setDraft('next message');

      const sent = firstValueFrom(compose.sendMessage('holiday'));
      sends.next({ kind: 'rejected', retryable: true });

      await expect(sent).resolves.toMatchObject({ kind: 'rejected' });
      expect(compose.draft()).toBe('next message\n\nholiday');
    });

    it('carries its mentions', async () => {
      const { runtime, sender, sends } = setup();
      const mention = { userId: '@bob:example.org', display: '@Bob' };

      const sent = firstValueFrom(
        runtime.focus(ROOM).compose.sendMessage('holiday @Bob', [mention]),
      );
      sends.next({ kind: 'accepted', eventId: '$caption' });
      await sent;

      expect(sender.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mentions: [mention] }),
      );
    });

    it('leaves the draft and a reply in progress alone when its echo failed', async () => {
      const { runtime, sends } = setup(2, undefined, [message('$target')]);
      const handle = runtime.focus(ROOM);
      handle.messages.beginReply('$target');
      handle.compose.setDraft('next message');

      const sent = firstValueFrom(handle.compose.sendMessage('holiday'));
      sends.next({ kind: 'failed' });

      await expect(sent).resolves.toEqual({
        kind: 'rejected',
        failure: 'send-rejected',
        retryable: true,
      });
      // The failed row holds the text, with Retry.
      expect(handle.compose.draft()).toBe('next message');
      expect(handle.compose.intent()).toEqual({
        kind: 'reply',
        eventId: '$target',
      });
    });

    it('keeps the text as its own draft once another conversation is focused', async () => {
      const { runtime, sender } = setup();
      const left = runtime.focus(ROOM);
      runtime.focus({ accountId: ALICE, roomId: '!other:example.org' });

      await expect(
        firstValueFrom(left.compose.sendMessage('holiday')),
      ).resolves.toMatchObject({ failure: 'conversation-unavailable' });

      expect(sender.send).not.toHaveBeenCalled();
      expect(left.compose.draft()).toBe('holiday');
    });
  });

  it('does not clear newer draft or target changes when an older send settles', async () => {
    const { runtime, sends } = setup(2, undefined, [message('$new-target')]);
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const compose = handle.compose;
    compose.setDraft('first');
    const first = firstValueFrom(compose.submit());

    compose.setDraft('second');
    handle.messages.beginReply('$new-target');
    sends.next({ kind: 'accepted', eventId: '$first' });
    sends.complete();

    await expect(first).resolves.toEqual({ kind: 'sent', eventId: '$first' });
    expect(compose.draft()).toBe('second');
    expect(compose.intent()).toEqual({
      kind: 'reply',
      eventId: '$new-target',
    });
  });

  it('cleans up typing ownership when the conversation loses focus', () => {
    const { runtime } = setup();
    const first = runtime.focus({
      accountId: ALICE,
      roomId: '!first:example.org',
    });
    first.compose.setTyping(true);

    runtime.focus({ accountId: ALICE, roomId: '!second:example.org' });

    expect(first.timeline.setTyping).toHaveBeenLastCalledWith(false, 'room');
  });

  it('creates one exact keyed thread child and routes message actions through it', async () => {
    const { runtime, controller, messageAdapter } = setup(2, undefined, [
      message('$reply'),
    ]);
    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });

    const thread = conversation.threads.forRoot('$root');

    expect(thread?.key).toEqual({
      accountId: ALICE,
      roomId: '!room:example.org',
      rootEventId: '$root',
    });
    expect(
      controller('!room:example.org').threads.attachThreadRoot,
    ).toHaveBeenCalledWith('$root');
    expect(thread?.oldestEventId()).toBe('$oldest');
    const command = thread?.toggleReaction('$reply', '👍');
    expect(messageAdapter.toggleReaction).not.toHaveBeenCalled();
    await expect(firstValueFrom(command!)).resolves.toEqual({
      kind: 'applied',
      operation: 'reaction',
    });
    expect(messageAdapter.toggleReaction).toHaveBeenCalledWith({
      key: conversation.key,
      threadRootId: '$root',
      messageId: '$reply',
      reaction: '👍',
    });
  });

  it('loads a thread root only through the focused Conversation', async () => {
    const { runtime, controller } = setup();
    await expect(
      firstValueFrom(runtime.threads.loadRoot('$root')),
    ).resolves.toBe(false);

    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const projection = controller('!room:example.org').threads;
    projection.loadThreadRoot = vi.fn(() => of(true));

    await expect(
      firstValueFrom(runtime.threads.loadRoot('$root')),
    ).resolves.toBe(true);
    expect(projection.loadThreadRoot).toHaveBeenCalledExactlyOnceWith('$root');

    runtime.blur();
    await expect(
      firstValueFrom(conversation.threads.loadRoot('$root')),
    ).resolves.toBe(false);
  });

  it('routes a thread cancel to the adapter with the thread root', async () => {
    const { runtime, messageAdapter } = setup();
    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });

    await firstValueFrom(
      conversation.threads.forRoot('$root')!.cancel('$reply'),
    );

    expect(messageAdapter.cancel).toHaveBeenCalledWith({
      key: conversation.key,
      threadRootId: '$root',
      messageId: '$reply',
    });
  });

  it('permanently releases the previous root child when thread navigation changes', async () => {
    const { runtime, controller, messageAdapter } = setup();
    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const first = conversation.threads.forRoot('$first')!;
    const staleCommand = first.retry('$echo');
    const staleInvalidSend = first.send('   ');

    const second = conversation.threads.forRoot('$second')!;

    expect(second).not.toBe(first);
    expect(
      controller('!room:example.org').threads.closeThread,
    ).toHaveBeenCalled();
    await expect(firstValueFrom(staleCommand)).resolves.toMatchObject({
      kind: 'rejected',
      operation: 'retry',
      failure: 'conversation-unavailable',
    });
    expect(messageAdapter.retry).not.toHaveBeenCalled();
    await expect(firstValueFrom(staleInvalidSend)).resolves.toMatchObject({
      kind: 'rejected',
      operation: 'send',
      failure: 'conversation-unavailable',
    });
    expect(first.messages()).toEqual([]);
    expect(first.oldestEventId()).toBeNull();
  });

  it('releases the active thread on parent blur and rejects its staged media', async () => {
    const { runtime, controller, mediaPipeline } = setup();
    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const thread = conversation.threads.forRoot('$root')!;
    const staged = Object.freeze({
      id: 'thread-media',
      filename: 'thread.png',
      mimeType: 'image/png',
      size: 4,
      previewUrl: null,
    }) as StagedMediaReference;

    runtime.blur();

    expect(
      controller('!room:example.org').threads.closeThread,
    ).toHaveBeenCalled();
    await expect(
      firstValueFrom(thread.media.send(staged, 'caption')),
    ).resolves.toEqual({
      kind: 'rejected',
      failure: 'conversation-unavailable',
      retryable: false,
    });
    expect(mediaPipeline.transfer).not.toHaveBeenCalled();
  });

  it('routes thread media through the staged pipeline with the exact root key', () => {
    const { runtime, mediaPipeline } = setup();
    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const thread = conversation.threads.forRoot('$root')!;
    const staged = Object.freeze({
      id: 'thread-media',
      filename: 'thread.png',
      mimeType: 'image/png',
      size: 4,
      previewUrl: null,
    }) as StagedMediaReference;

    const subscription = thread.media.send(staged, 'caption').subscribe();

    expect(mediaPipeline.transfer).toHaveBeenCalledWith({
      key: conversation.key,
      threadRootId: '$root',
      media: staged,
      caption: 'caption',
      imageMetadata: 'strip',
    });
    subscription.unsubscribe();
  });

  it('keeps photo metadata only when the privacy setting is on as the send starts', () => {
    const { runtime, mediaPipeline, keepPhotoMetadata } = setup();
    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const staged = Object.freeze({
      id: 'photo',
      filename: 'IMG_0001.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      previewUrl: null,
    }) as StagedMediaReference;
    const command = conversation.media.send(staged, '');
    const threadCommand = conversation.threads
      .forRoot('$root')!
      .media.send(staged, '');

    keepPhotoMetadata.set(true);
    const subscriptions = [command.subscribe(), threadCommand.subscribe()];

    expect(mediaPipeline.transfer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ imageMetadata: 'keep' }),
    );
    expect(mediaPipeline.transfer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadRootId: '$root', imageMetadata: 'keep' }),
    );
    subscriptions.forEach((subscription) => subscription.unsubscribe());
  });

  it('keeps pin commands cold and rejects the retained exact handle', async () => {
    const { runtime, controller } = setup();
    const conversation = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    const pinController = controller('!room:example.org').pins;
    const command = conversation.pins.pin('$message');

    expect(pinController.pin).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'applied',
      operation: 'pin',
    });
    expect(pinController.pin).toHaveBeenCalledWith('$message');

    runtime.focus({ accountId: BOB, roomId: '!other:example.org' });
    await expect(
      firstValueFrom(conversation.pins.unpin('$message')),
    ).resolves.toMatchObject({
      kind: 'rejected',
      operation: 'unpin',
      failure: 'conversation-unavailable',
    });
    expect(pinController.unpin).not.toHaveBeenCalled();
  });
});
