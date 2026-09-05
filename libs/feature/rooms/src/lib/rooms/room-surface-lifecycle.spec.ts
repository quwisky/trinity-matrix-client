import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { BELOW_MD_QUERY, BELOW_MEMBERS_QUERY } from '@trinity/util/ui';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';

const BOB = {
  userId: '@bob:example.org',
  roomDisplayName: 'Bob',
  roomInitial: 'B',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
} as const;

function stubMedia(initial: Record<string, boolean> = {}) {
  const matches = new Map(Object.entries(initial));
  const listeners = new Map<
    string,
    Set<(event: { readonly matches: boolean }) => void>
  >();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matches.get(query) ?? false;
    },
    media: query,
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: { readonly matches: boolean }) => void,
    ) => {
      const current = listeners.get(query) ?? new Set();
      current.add(listener);
      listeners.set(query, current);
    },
    removeEventListener: (
      _type: string,
      listener: (event: { readonly matches: boolean }) => void,
    ) => listeners.get(query)?.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return (query: string, value: boolean) => {
    matches.set(query, value);
    for (const listener of listeners.get(query) ?? []) {
      listener({ matches: value });
    }
  };
}

function build(roomId: string | null = '!room:example.org') {
  const activeAccountId = signal<string | null>('@alice:example.org');
  const activeRoomId = signal<string | null>(roomId);
  const eventTarget = signal<{ readonly eventId: string } | null>(null);
  const pane = signal<'list' | 'conversation'>(
    roomId ? 'conversation' : 'list',
  );
  const navigate = vi.fn((intent: { readonly kind: string }) => {
    if (intent.kind === 'list') pane.set('list');
    return of({ kind: 'ready' as const });
  });

  TestBed.configureTestingModule({
    providers: [
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
          navigate,
        },
      },
    ],
  });

  return {
    activeAccountId,
    activeRoomId,
    eventTarget,
    pane,
    navigate,
    lifecycle: TestBed.inject(RoomSurfaceLifecycle),
    back: TestBed.inject(WorkspaceBackService),
  };
}

describe('RoomSurfaceLifecycle', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('starts the member surface closed at every width', () => {
    stubMedia({ [BELOW_MEMBERS_QUERY]: false });
    expect(build().lifecycle.renderedSurface()).toBeNull();

    TestBed.resetTestingModule();
    stubMedia({ [BELOW_MEMBERS_QUERY]: true });
    expect(build().lifecycle.renderedSurface()).toBeNull();
  });

  it('focuses the member filter when the drawer opens', () => {
    stubMedia({ [BELOW_MEMBERS_QUERY]: true });
    const { lifecycle } = build();
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    const filter = document.createElement('input');
    slot.dataset['rightPanelSlot'] = '';
    filter.dataset['rightPanelFocus'] = '';
    slot.append(filter);
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      lifecycle.transition({ kind: 'open-members' });
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(filter);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('leaves focus on the trigger when the wide member column opens', () => {
    stubMedia({ [BELOW_MEMBERS_QUERY]: false });
    const { lifecycle } = build();
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    const filter = document.createElement('input');
    slot.dataset['rightPanelSlot'] = '';
    filter.dataset['rightPanelFocus'] = '';
    slot.append(filter);
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      lifecycle.transition({ kind: 'open-members' });
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('keeps remembered members across Room, Account, and missing-Room transitions', () => {
    stubMedia();
    const { activeAccountId, activeRoomId, lifecycle, pane } = build();
    lifecycle.transition({ kind: 'open-members' });

    activeRoomId.set('!other:example.org');
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });

    activeAccountId.set('@carol:example.org');
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });

    pane.set('list');
    expect(lifecycle.renderedSurface()).toBeNull();
    pane.set('conversation');
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
  });

  it('keeps remembered closed across Room, Account, and missing-Room transitions', () => {
    stubMedia();
    const { activeAccountId, activeRoomId, lifecycle, pane } = build();

    activeRoomId.set('!other:example.org');
    expect(lifecycle.renderedSurface()).toBeNull();

    activeAccountId.set('@carol:example.org');
    expect(lifecycle.renderedSurface()).toBeNull();

    pane.set('list');
    expect(lifecycle.renderedSurface()).toBeNull();
    pane.set('conversation');
    expect(lifecycle.renderedSurface()).toBeNull();
  });

  it('places a temporary surface over remembered members and restores the roster', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });
    lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } });

    expect(lifecycle.renderedSurface()).toEqual({ kind: 'threads' });
    expect(lifecycle.membersVisible()).toBe(false);

    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
    expect(lifecycle.membersVisible()).toBe(true);
  });

  it('returns member detail to its actual roster, temporary, or empty origin', () => {
    stubMedia();
    const { lifecycle } = build();

    lifecycle.transition({ kind: 'open-members' });
    lifecycle.transition({ kind: 'open-member', member: BOB, direct: false });
    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });

    lifecycle.transition({ kind: 'clear' });
    lifecycle.transition({ kind: 'open-member', member: BOB, direct: false });
    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toBeNull();

    lifecycle.transition({ kind: 'open', surface: { kind: 'search' } });
    lifecycle.transition({ kind: 'open-member', member: BOB, direct: false });
    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'search' });
  });

  it('clears the whole slot and records remembered members closed', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });
    lifecycle.transition({ kind: 'open', surface: { kind: 'pinned' } });

    lifecycle.transition({ kind: 'clear' });
    expect(lifecycle.renderedSurface()).toBeNull();

    lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } });
    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toBeNull();
  });

  it('ignores Escape for a wide roster but dismisses a drawer and temporary surface', () => {
    const resize = stubMedia({ [BELOW_MEMBERS_QUERY]: false });
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });

    expect(lifecycle.transition({ kind: 'escape' })).toEqual({
      kind: 'unchanged',
    });
    expect(lifecycle.membersVisible()).toBe(true);

    resize(BELOW_MEMBERS_QUERY, true);
    TestBed.tick();
    expect(lifecycle.renderedSurface()).toBeNull();

    lifecycle.transition({ kind: 'open-members' });
    lifecycle.transition({ kind: 'escape' });
    expect(lifecycle.renderedSurface()).toBeNull();

    lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } });
    lifecycle.transition({ kind: 'escape' });
    expect(lifecycle.renderedSurface()).toBeNull();
  });

  it('clears hidden remembered members on drawer entry without closing a temporary surface', () => {
    const resize = stubMedia({ [BELOW_MEMBERS_QUERY]: false });
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });
    lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } });

    resize(BELOW_MEMBERS_QUERY, true);
    TestBed.tick();
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'threads' });

    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toBeNull();
  });

  it('keeps an opened member drawer when it becomes a wide static column', () => {
    const resize = stubMedia({ [BELOW_MEMBERS_QUERY]: true });
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });

    resize(BELOW_MEMBERS_QUERY, false);
    TestBed.tick();
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
  });

  it('drops temporary and jump state when the exact Conversation changes', () => {
    stubMedia();
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
      memberReturnSurface: null,
      jumpTarget: null,
      jumpRevision: 0,
    });

    lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } });
    activeAccountId.set('@bob:example.org');
    expect(lifecycle.surface()).toBeNull();
  });

  it('closes temporary state before a deferred message reveal', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open', surface: { kind: 'search' } });

    lifecycle.transition({ kind: 'reveal-message', eventId: '$event' });
    expect(lifecycle.surface()).toBeNull();
    expect(lifecycle.jumpTarget()).toBeNull();

    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBe('$event');
    expect(lifecycle.jumpRevision()).toBe(1);
  });

  it('drops a deferred reveal superseded before render', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'reveal-message', eventId: '$stale' });
    lifecycle.transition({ kind: 'open', surface: { kind: 'threads' } });

    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBeNull();
    expect(lifecycle.jumpRevision()).toBe(0);
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'threads' });
  });

  it('drops a deferred reveal when the Conversation changes before render', () => {
    stubMedia();
    const { activeRoomId, lifecycle } = build();
    lifecycle.transition({ kind: 'reveal-message', eventId: '$stale' });

    activeRoomId.set('!other:example.org');
    TestBed.tick();

    expect(lifecycle.conversation()).toEqual({
      accountId: '@alice:example.org',
      roomId: '!other:example.org',
    });
    expect(lifecycle.jumpTarget()).toBeNull();
    expect(lifecycle.jumpRevision()).toBe(0);
  });

  it('publishes only the latest reveal scheduled for one render', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'reveal-message', eventId: '$old' });
    lifecycle.transition({ kind: 'reveal-message', eventId: '$latest' });

    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBe('$latest');
    expect(lifecycle.jumpRevision()).toBe(1);
  });

  it('observes Workspace event targets without page coordination', () => {
    stubMedia();
    const { eventTarget, lifecycle } = build();

    eventTarget.set({ eventId: '$workspace' });
    TestBed.tick();

    expect(lifecycle.jumpTarget()).toBe('$workspace');
    expect(lifecycle.jumpRevision()).toBe(1);
  });

  it('offers Room surfaces before the compact Conversation to Workspace Back', async () => {
    stubMedia({
      [BELOW_MD_QUERY]: true,
      [BELOW_MEMBERS_QUERY]: true,
    });
    const { back, lifecycle, navigate } = build();
    lifecycle.transition({ kind: 'open-members' });

    await expect(firstValueFrom(back.back())).resolves.toMatchObject({
      kind: 'dismissed',
      surface: { layer: 'room', surface: { kind: 'members' } },
    });
    await expect(firstValueFrom(back.back())).resolves.toMatchObject({
      kind: 'dismissed',
      surface: { layer: 'conversation' },
    });
    expect(navigate).toHaveBeenCalledWith({
      kind: 'list',
      origin: 'workspace-back',
    });
  });

  it('rejects opening a surface without an active Conversation', () => {
    stubMedia();
    const { lifecycle } = build(null);

    expect(
      lifecycle.transition({ kind: 'open', surface: { kind: 'search' } }),
    ).toEqual({
      kind: 'rejected',
      reason: 'no-active-conversation',
    });
  });

  it('drops remembered members and its Back registration when its owner is destroyed', () => {
    stubMedia();
    const first = build();
    first.lifecycle.transition({ kind: 'open-members' });
    expect(first.back.hasActive()).toBe(true);

    TestBed.resetTestingModule();

    expect(first.back.hasActive()).toBe(false);
    const second = build();
    expect(second.lifecycle.renderedSurface()).toBeNull();
    expect(second.back.hasActive()).toBe(false);
  });
});
