import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomShellStore } from './room-shell-store';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';

function build(roomId: string | null = '!room:example.org') {
  const activeAccountId = signal<string | null>('@alice:example.org');
  const activeRoomId = signal<string | null>(roomId);
  const eventTarget = signal<{ readonly eventId: string } | null>(null);
  const pane = signal<'list' | 'conversation'>(
    roomId ? 'conversation' : 'list',
  );

  TestBed.configureTestingModule({
    providers: [
      RoomShellStore,
      RoomSurfaceLifecycle,
      {
        provide: WorkspaceNavigationService,
        useValue: {
          activeAccountId: activeAccountId.asReadonly(),
          activeSpaceId: signal<string | null>(null).asReadonly(),
          activeRoomId: activeRoomId.asReadonly(),
          eventTarget: eventTarget.asReadonly(),
          recentView: signal(true).asReadonly(),
          roomsView: signal(false).asReadonly(),
          pane: pane.asReadonly(),
          placement: signal<'list' | 'conversation' | 'split'>(
            'split',
          ).asReadonly(),
        },
      },
    ],
  });

  return {
    activeAccountId,
    activeRoomId,
    eventTarget,
    pane,
    lifecycle: TestBed.inject(RoomSurfaceLifecycle),
    store: TestBed.inject(RoomShellStore),
    back: TestBed.inject(WorkspaceBackService),
  };
}

describe('RoomSurfaceLifecycle', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('replaces message surfaces in one exact Conversation slot', () => {
    const { lifecycle, store } = build();
    store.rightPanel.set({ kind: 'members' });

    expect(
      lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } }),
    ).toEqual({ kind: 'applied' });
    expect(lifecycle.state()).toEqual({
      conversation: {
        accountId: '@alice:example.org',
        roomId: '!room:example.org',
      },
      surface: { kind: 'threads' },
      jumpTarget: null,
      jumpRevision: 0,
    });
    expect(store.rightPanel()).toBeNull();

    lifecycle.transition({
      kind: 'open',
      surface: { kind: 'thread', rootEventId: '$root' },
    });

    expect(lifecycle.surface()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
    });
  });

  it('rejects opening a surface without an active Conversation', () => {
    const { lifecycle } = build(null);

    expect(
      lifecycle.transition({ kind: 'open', surface: { kind: 'search' } }),
    ).toEqual({
      kind: 'rejected',
      reason: 'no-active-conversation',
    });
    expect(lifecycle.state()).toBeNull();
  });

  it('drops transient surface and jump state when the Conversation changes', () => {
    const { activeAccountId, activeRoomId, lifecycle } = build();
    lifecycle.transition({ kind: 'open', surface: { kind: 'pinned' } });
    lifecycle.transition({ kind: 'reveal-message', eventId: '$one' });
    TestBed.tick();

    activeRoomId.set('!other:example.org');
    expect(lifecycle.state()).toEqual({
      conversation: {
        accountId: '@alice:example.org',
        roomId: '!other:example.org',
      },
      surface: null,
      jumpTarget: null,
      jumpRevision: 0,
    });

    lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } });
    activeAccountId.set('@bob:example.org');

    expect(lifecycle.surface()).toBeNull();
    expect(lifecycle.conversation()).toEqual({
      accountId: '@bob:example.org',
      roomId: '!other:example.org',
    });
  });

  it('closes before reveal and repeats the same message after render', () => {
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open', surface: { kind: 'search' } });

    lifecycle.transition({ kind: 'reveal-message', eventId: '$event' });

    expect(lifecycle.surface()).toBeNull();
    expect(lifecycle.jumpTarget()).toBeNull();
    expect(lifecycle.jumpRevision()).toBe(0);

    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBe('$event');
    expect(lifecycle.jumpRevision()).toBe(1);

    lifecycle.transition({ kind: 'reveal-message', eventId: '$event' });
    TestBed.tick();

    expect(lifecycle.jumpTarget()).toBe('$event');
    expect(lifecycle.jumpRevision()).toBe(2);
  });

  it('does not deliver a reveal scheduled by an obsolete Conversation', () => {
    const { activeRoomId, lifecycle } = build();
    lifecycle.transition({ kind: 'reveal-message', eventId: '$stale' });

    activeRoomId.set('!next:example.org');
    expect(lifecycle.jumpTarget()).toBeNull();
    TestBed.tick();

    expect(lifecycle.jumpTarget()).toBeNull();
    expect(lifecycle.jumpRevision()).toBe(0);
  });

  it('observes Workspace event targets without page coordination', () => {
    const { eventTarget, lifecycle } = build();

    eventTarget.set({ eventId: '$workspace' });
    TestBed.tick();

    expect(lifecycle.jumpTarget()).toBe('$workspace');
    expect(lifecycle.jumpRevision()).toBe(1);
  });

  it('registers the semantic message surface with Workspace Back', async () => {
    const { back, lifecycle } = build();
    lifecycle.transition({ kind: 'open', surface: { kind: 'pinned' } });

    expect(back.activeSurface()).toEqual({
      layer: 'room',
      surface: { kind: 'pinned' },
    });
    await expect(firstValueFrom(back.back())).resolves.toEqual({
      kind: 'dismissed',
      surface: { layer: 'room', surface: { kind: 'pinned' } },
    });
    expect(lifecycle.surface()).toBeNull();
  });
});
