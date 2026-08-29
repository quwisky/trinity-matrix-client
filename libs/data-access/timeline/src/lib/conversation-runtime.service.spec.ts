import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_RETENTION_LIMIT,
  CONVERSATION_TIMELINE_FACTORY,
  ConversationRuntime,
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
    loadOlder: () => of(void 0),
    jumpToDate: () => of({ kind: 'no-event' }),
    openContext: () => null,
    setTyping: () => undefined,
    rawEvent: () => null,
    reactionDetails: () => [],
  };
}

function setup(retainedPerAccount = 2) {
  const controllers = new Map<string, TestConversationTimelineController[]>();
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
});
