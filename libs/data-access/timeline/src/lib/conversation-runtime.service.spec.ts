import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { NEVER, Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftStoreService } from '@trinity/platform-native';
import {
  MediaPipeline,
  type MediaTransferEvent,
  type StagedMediaReference,
} from '@trinity/data-access/media';
import {
  CONVERSATION_RETENTION_LIMIT,
  CONVERSATION_TEXT_SENDER,
  CONVERSATION_TIMELINE_FACTORY,
  ConversationRuntime,
  type ConversationTextSendRequest,
  type ConversationTextSender,
  type ConversationTimeline,
  type ConversationTimelineController,
  type ConversationTimelineFactory,
} from './conversation-runtime.service';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import type {
  ConversationMessageAdapter,
  ConversationMessageOperation,
} from './conversation-messages';
import type { MessageView } from './message-presentation';

const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';

interface TestConversationTimelineController extends ConversationTimelineController {
  readonly visible: ReturnType<typeof signal<boolean>>;
  readonly released: ReturnType<typeof signal<boolean>>;
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
    tombstone: signal(null).asReadonly(),
    firstUnreadId: signal<string | null>(null).asReadonly(),
    openRoomId: roomId,
    roomEncrypted: false,
    loadOlder: () => of(void 0),
    jumpToDate: () => of({ kind: 'no-event' }),
    setTyping: vi.fn(),
    rawEvent: () => null,
    reactionDetails: () => [],
  };
}

function setup(
  retainedPerAccount = 2,
  senderOverride?: ConversationTextSender,
  messages: readonly MessageView[] = [],
) {
  const controllers = new Map<string, TestConversationTimelineController[]>();
  const sends = new Subject<
    | { readonly kind: 'accepted'; readonly eventId: string }
    | { readonly kind: 'rejected'; readonly retryable: boolean }
  >();
  const sender: ConversationTextSender = senderOverride ?? {
    send: vi.fn(() => ({ outcome: sends, cancel: () => false })),
  };
  const mediaEvents = new Subject<MediaTransferEvent>();
  const mediaPipeline = {
    transfer: vi.fn(() => mediaEvents.asObservable()),
  };
  const applied = (operation: ConversationMessageOperation) =>
    of({ kind: 'applied' as const, operation });
  const messageAdapter: ConversationMessageAdapter = {
    toggleReaction: vi.fn(() => applied('reaction')),
    redact: vi.fn(() => applied('redaction')),
    retry: vi.fn(() => applied('retry')),
    acknowledge: vi.fn(() => applied('receipt')),
  };
  const factory: ConversationTimelineFactory = {
    create: vi.fn((key) => {
      const visible = signal(false);
      const released = signal(false);
      const controller: TestConversationTimelineController = {
        timeline: timeline(key.roomId, messages),
        setVisible: (next) => visible.set(next),
        release: () => released.set(true),
        resources: () => ({ listenerCount: 11, retainedBytes: 64 }),
        visible,
        released,
      };
      const created = controllers.get(key.roomId) ?? [];
      created.push(controller);
      controllers.set(key.roomId, created);
      return controller;
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      ConversationRuntime,
      { provide: CONVERSATION_TIMELINE_FACTORY, useValue: factory },
      { provide: CONVERSATION_TEXT_SENDER, useValue: sender },
      { provide: CONVERSATION_MESSAGE_ADAPTER, useValue: messageAdapter },
      { provide: MediaPipeline, useValue: mediaPipeline },
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
  };
}

function message(
  id: string,
  overrides: Partial<MessageView> = {},
): MessageView {
  return {
    id,
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

afterEach(() => TestBed.resetTestingModule());

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
    expect(persist).not.toHaveBeenCalled();
    sends.next({ kind: 'accepted', eventId: '$local-echo' });
    sends.complete();

    await expect(outcomePromise).resolves.toEqual({
      kind: 'sent',
      eventId: '$local-echo',
    });
    expect(handle.compose.draft()).toBe('');
    expect(handle.compose.intent()).toEqual({ kind: 'message' });
    expect(handle.compose.sending()).toBe(false);
    expect(persist).toHaveBeenCalledWith(expect.any(String), '');
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

  it('does not falsely restore a draft when SDK cancellation is indeterminate', () => {
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
    expect(restored.compose.draft()).toBe('durable text');
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
});
