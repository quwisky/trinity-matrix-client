import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';

interface TestConversationTimelineController extends ConversationTimelineController {
  readonly visible: ReturnType<typeof signal<boolean>>;
  readonly released: ReturnType<typeof signal<boolean>>;
}

function timeline(roomId: string): ConversationTimeline {
  return {
    messages: signal([]).asReadonly(),
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
) {
  const controllers = new Map<string, TestConversationTimelineController[]>();
  const sends = new Subject<
    | { readonly kind: 'accepted'; readonly eventId: string }
    | { readonly kind: 'rejected'; readonly retryable: boolean }
  >();
  const sender: ConversationTextSender = senderOverride ?? {
    send: vi.fn(() => sends),
  };
  const factory: ConversationTimelineFactory = {
    create: vi.fn((key) => {
      const visible = signal(false);
      const released = signal(false);
      const controller: TestConversationTimelineController = {
        timeline: timeline(key.roomId),
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
    factory,
    controller,
    sender,
    sends,
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
    const { runtime } = setup();
    const first = runtime.focus({
      accountId: ALICE,
      roomId: '!first:example.org',
    });
    first.compose.setDraft('half written');
    first.compose.beginReply('$reply');

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

    restored.compose.beginEdit('$edit', 'original message');
    expect(restored.compose.intent()).toEqual({
      kind: 'edit',
      eventId: '$edit',
    });
    expect(restored.compose.draft()).toBe('original message');
    restored.compose.setDraft('edited message');
    restored.compose.cancelIntent();
    expect(restored.compose.draft()).toBe('half written');
  });

  it('keeps submit cold and succeeds only with an accepted authoritative local echo', async () => {
    const { runtime, sender, sends } = setup();
    const handle = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    });
    handle.compose.setDraft('hello');
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
    sends.next({ kind: 'accepted', eventId: '$local-echo' });
    sends.complete();

    await expect(outcomePromise).resolves.toEqual({
      kind: 'sent',
      eventId: '$local-echo',
    });
    expect(handle.compose.draft()).toBe('');
    expect(handle.compose.intent()).toEqual({ kind: 'message' });
    expect(handle.compose.sending()).toBe(false);
  });

  it('returns a typed rejection and restores the durable intent', async () => {
    const { runtime, sends } = setup();
    const compose = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    }).compose;
    compose.setDraft('try again');
    compose.beginReply('$target');

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
    const cancelled = vi.fn();
    const sender: ConversationTextSender = {
      send: vi.fn(
        () =>
          new Observable<never>(() => {
            return cancelled;
          }),
      ),
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
    const { runtime, sends } = setup();
    const compose = runtime.focus({
      accountId: ALICE,
      roomId: '!room:example.org',
    }).compose;
    compose.setDraft('first');
    const first = firstValueFrom(compose.submit());

    compose.setDraft('second');
    compose.beginReply('$new-target');
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
