import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
  type WorkspacePanel,
  type WorkspaceRoomSurface,
} from '@trinity/application/workspace';
import { BELOW_MD_QUERY, BELOW_MEMBERS_QUERY } from '@trinity/util/ui';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  RoomSurfaceLifecycle,
  type RenderedRoomSurface,
  type RoomSurfaceTransition,
} from './room-surface-lifecycle';

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
  // `notify: false` models a resize whose `change` event the browser has not delivered yet.
  return (query: string, value: boolean, notify = true) => {
    matches.set(query, value);
    if (!notify) return;
    for (const listener of listeners.get(query) ?? []) {
      listener({ matches: value });
    }
  };
}

/**
 * Workspace commits a panel request at once unless `commits` is false, which models a
 * close still being written when the next thing happens.
 */
function build(
  roomId: string | null = '!room:example.org',
  { commits = true }: { readonly commits?: boolean } = {},
) {
  const activeAccountId = signal<string | null>('@alice:example.org');
  const activeRoomId = signal<string | null>(roomId);
  const pane = signal<'list' | 'conversation'>(
    roomId ? 'conversation' : 'list',
  );
  const navigate = vi.fn((intent: { readonly kind: string }) => {
    if (intent.kind === 'list') pane.set('list');
    return of({ kind: 'ready' as const });
  });
  const panel = signal<WorkspacePanel | null>(null);
  const membersBelow = signal(false);
  const openPanel = vi.fn((next: WorkspacePanel) => {
    if (commits) panel.set(next);
  });
  const closePanel = vi.fn(() => {
    if (commits) panel.set(null);
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
          recentView: signal(true).asReadonly(),
          roomsView: signal(false).asReadonly(),
          inboxView: signal(false).asReadonly(),
          pane: pane.asReadonly(),
          placement: signal<'list' | 'conversation' | 'split'>(
            'split',
          ).asReadonly(),
          navigate,
          panel: panel.asReadonly(),
          membersBelow: membersBelow.asReadonly(),
          openPanel,
          closePanel,
        },
      },
    ],
  });

  return {
    activeAccountId,
    activeRoomId,
    pane,
    navigate,
    panel,
    membersBelow,
    openPanel,
    closePanel,
    lifecycle: TestBed.inject(RoomSurfaceLifecycle),
    back: TestBed.inject(WorkspaceBackService),
  };
}

describe('RoomSurfaceLifecycle thread reveal', () => {
  it('carries the message to reveal on the thread surface', () => {
    const { lifecycle } = build();

    lifecycle.transition({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$reply',
    });

    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
      revealEventId: '$reply',
    });
  });

  it('leaves a thread opened by hand with nothing to reveal', () => {
    const { lifecycle } = build();

    lifecycle.transition({ kind: 'open-thread', rootEventId: '$root' });

    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
    });
  });

  it('dismisses a revealing thread from Workspace Back, as the same surface', async () => {
    const { lifecycle, back } = build();
    lifecycle.transition({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$reply',
    });

    await expect(firstValueFrom(back.back())).resolves.toMatchObject({
      kind: 'dismissed',
    });

    expect(lifecycle.renderedSurface()).toBeNull();
  });
});

describe('RoomSurfaceLifecycle', () => {
  it('exposes only read-only presentation signals and semantic transitions', () => {
    expectTypeOf<keyof RoomSurfaceLifecycle>().toEqualTypeOf<
      | 'membersAreDrawer'
      | 'membersVisible'
      | 'renderedSurface'
      | 'jumpTarget'
      | 'jumpRevision'
      | 'transition'
    >();
    expectTypeOf<RoomSurfaceLifecycle['renderedSurface']>().toEqualTypeOf<
      Signal<RenderedRoomSurface | null>
    >();
    expectTypeOf<RoomSurfaceLifecycle['jumpTarget']>().toEqualTypeOf<
      Signal<string | null>
    >();
    expectTypeOf<RoomSurfaceLifecycle['jumpRevision']>().toEqualTypeOf<
      Signal<number>
    >();
    expectTypeOf<RoomSurfaceLifecycle['membersVisible']>().toEqualTypeOf<
      Signal<boolean>
    >();
    expectTypeOf<RoomSurfaceLifecycle['membersAreDrawer']>().toEqualTypeOf<
      Signal<boolean>
    >();
    expectTypeOf<
      Extract<RoomSurfaceTransition, { kind: 'open' }>
    >().toBeNever();
  });

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

  it('constructs and replaces message surfaces from semantic intent', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-threads' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'threads' });

    const intent = { kind: 'open-thread' as const, rootEventId: '$root' };
    lifecycle.transition(intent);
    intent.rootEventId = '$changed-by-caller';
    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
    });

    lifecycle.transition({ kind: 'open-pinned' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'pinned' });
    lifecycle.transition({ kind: 'open-search' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'search' });
    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toBeNull();
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

  /** A slot holding one surface whose header has a button and no marked focus target. */
  function slotWithHeaderButton(): { slot: HTMLElement; button: HTMLElement } {
    const slot = document.createElement('div');
    const surface = document.createElement('div');
    const header = document.createElement('trn-side-panel-header');
    const button = document.createElement('button');
    slot.dataset['rightPanelSlot'] = '';
    surface.dataset['rightPanelSurface'] = '';
    header.append(button);
    surface.append(header);
    slot.append(surface);
    return { slot, button };
  }

  it('moves focus into a page opened below md, onto its header button', () => {
    stubMedia({ [BELOW_MEMBERS_QUERY]: true, [BELOW_MD_QUERY]: true });
    const { lifecycle } = build();
    const trigger = document.createElement('button');
    const { slot, button } = slotWithHeaderButton();
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      lifecycle.transition({ kind: 'open-threads' });
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(button);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('returns focus to the opener while the closed page is still sliding off', () => {
    stubMedia({ [BELOW_MEMBERS_QUERY]: true, [BELOW_MD_QUERY]: true });
    const { lifecycle } = build();
    const trigger = document.createElement('button');
    const { slot, button } = slotWithHeaderButton();
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      lifecycle.transition({ kind: 'open-threads' });
      TestBed.tick();
      TestBed.tick();
      expect(document.activeElement).toBe(button);

      // The page leaves the DOM only when its slide ends; its Back button still has focus.
      lifecycle.transition({ kind: 'dismiss' });
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('leaves focus alone when a wide panel switches to one with no marked target', () => {
    stubMedia({ [BELOW_MEMBERS_QUERY]: false, [BELOW_MD_QUERY]: false });
    const { lifecycle } = build();
    const { slot } = slotWithHeaderButton();
    document.body.append(slot);
    try {
      lifecycle.transition({ kind: 'open-threads' });
      TestBed.tick();
      (document.activeElement as HTMLElement | null)?.blur();
      lifecycle.transition({ kind: 'open-pinned' });
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(document.body);
    } finally {
      slot.remove();
    }
  });

  it('asks Workspace for each panel it opens, and shows what the URL then names', () => {
    stubMedia();
    const { lifecycle, openPanel } = build();
    const opened: readonly [RoomSurfaceTransition, WorkspacePanel][] = [
      [{ kind: 'open-members' }, { kind: 'members' }],
      [{ kind: 'open-threads' }, { kind: 'threads' }],
      [
        { kind: 'open-thread', rootEventId: '$root' },
        { kind: 'thread', root: '$root' },
      ],
      [{ kind: 'open-pinned' }, { kind: 'pinned' }],
      [{ kind: 'open-search' }, { kind: 'search' }],
    ];

    for (const [intent, panel] of opened) {
      lifecycle.transition(intent);
      expect(openPanel).toHaveBeenLastCalledWith(panel);
      expect(lifecycle.renderedSurface()).toMatchObject({ kind: panel.kind });
    }
  });

  it('shows the panel a reloaded URL names, and a thread once its root has loaded', () => {
    stubMedia();
    const { lifecycle, openPanel, panel } = build();

    for (const kind of ['members', 'threads', 'pinned', 'search'] as const) {
      panel.set({ kind });
      expect(lifecycle.renderedSurface()).toEqual({ kind });
    }

    panel.set({ kind: 'thread', root: '$root' });
    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
      loading: true,
    });

    lifecycle.transition({ kind: 'open-thread', rootEventId: '$root' });
    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
    });
    expect(openPanel).not.toHaveBeenCalled();
  });

  it('forgets a thread and its reveal once the URL names another root', () => {
    stubMedia();
    const { lifecycle, panel } = build();
    lifecycle.transition({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$reply',
    });

    panel.set({ kind: 'thread', root: '$other' });
    expect(lifecycle.renderedSurface()).toMatchObject({ loading: true });
    TestBed.tick();
    panel.set({ kind: 'thread', root: '$root' });
    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$root',
      loading: true,
    });
  });

  it('reveals a requested message once, not again after Back and Forward', () => {
    stubMedia();
    const { lifecycle, panel } = build();
    lifecycle.transition({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$reply',
    });
    expect(lifecycle.renderedSurface()).toMatchObject({
      revealEventId: '$reply',
    });

    panel.set(null);
    expect(lifecycle.renderedSurface()).toBeNull();
    panel.set({ kind: 'thread', root: '$root' });

    expect(lifecycle.renderedSurface()).toMatchObject({ loading: true });
    expect(lifecycle.renderedSurface()).not.toHaveProperty('revealEventId');
  });

  it('keeps showing the thread the URL names until another one commits', () => {
    stubMedia();
    const { lifecycle, panel } = build(undefined, { commits: false });
    panel.set({ kind: 'thread', root: '$a' });
    lifecycle.transition({ kind: 'open-thread', rootEventId: '$a' });

    lifecycle.transition({ kind: 'open-thread', rootEventId: '$b' });
    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$a',
    });

    panel.set({ kind: 'thread', root: '$b' });
    expect(lifecycle.renderedSurface()).toEqual({
      kind: 'thread',
      rootEventId: '$b',
    });
  });

  it('drops a reveal whose close another panel superseded, even once that one closes', () => {
    stubMedia();
    const { lifecycle, panel } = build(undefined, { commits: false });
    panel.set({ kind: 'pinned' });

    lifecycle.transition({ kind: 'reveal-message', eventId: '$event' });
    panel.set({ kind: 'threads' });
    TestBed.tick();
    panel.set(null);
    TestBed.tick();

    expect(lifecycle.jumpTarget()).toBeNull();
    expect(lifecycle.jumpRevision()).toBe(0);
  });

  it('shows nothing while the Conversation pane is not open', () => {
    stubMedia();
    const { lifecycle, pane, panel } = build();
    panel.set({ kind: 'members' });

    pane.set('list');
    expect(lifecycle.renderedSurface()).toBeNull();
    pane.set('conversation');
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
  });

  it('places a temporary surface over remembered members and restores the roster', () => {
    stubMedia();
    const { lifecycle, openPanel } = build();
    lifecycle.transition({ kind: 'open-members' });
    lifecycle.transition({ kind: 'open-threads' });

    expect(lifecycle.renderedSurface()).toEqual({ kind: 'threads' });
    expect(lifecycle.membersVisible()).toBe(false);

    lifecycle.transition({ kind: 'dismiss' });
    expect(openPanel).toHaveBeenLastCalledWith({ kind: 'members' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
    expect(lifecycle.membersVisible()).toBe(true);
  });

  it('closes back to the roster history says lies below, after a reload or Forward', () => {
    stubMedia();
    const { closePanel, lifecycle, membersBelow, openPanel, panel } = build();
    panel.set({ kind: 'threads' });
    membersBelow.set(true);

    lifecycle.transition({ kind: 'dismiss' });

    expect(openPanel).toHaveBeenCalledExactlyOnceWith({ kind: 'members' });
    expect(closePanel).not.toHaveBeenCalled();
  });

  it('does not restore a roster that a reload or Back did not leave below', () => {
    stubMedia();
    const { closePanel, lifecycle, panel } = build();
    panel.set({ kind: 'threads' });

    lifecycle.transition({ kind: 'dismiss' });
    expect(closePanel).toHaveBeenCalledOnce();
    expect(lifecycle.renderedSurface()).toBeNull();

    panel.set({ kind: 'members' });
    panel.set(null);
    panel.set({ kind: 'pinned' });
    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toBeNull();
  });

  it('returns every temporary surface to the remembered roster or an empty slot', () => {
    stubMedia();
    const { lifecycle } = build();
    const temporary: readonly RoomSurfaceTransition[] = [
      { kind: 'open-threads' },
      { kind: 'open-thread', rootEventId: '$root' },
      { kind: 'open-pinned' },
      { kind: 'open-search' },
    ];

    lifecycle.transition({ kind: 'open-members' });
    for (const intent of temporary) {
      lifecycle.transition(intent);
      expect(lifecycle.membersVisible()).toBe(false);
      lifecycle.transition({ kind: 'dismiss' });
      expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
    }

    lifecycle.transition({ kind: 'clear' });
    for (const intent of temporary) {
      lifecycle.transition(intent);
      lifecycle.transition({ kind: 'dismiss' });
      expect(lifecycle.renderedSurface()).toBeNull();
    }
  });

  it('has no member info surface: member info is a modal surface over the roster', () => {
    // #1041 moved member info out of the slot into `TrnSurfaceService`, so neither the
    // lifecycle nor Workspace Back can name it any more.
    expectTypeOf<
      Extract<RoomSurfaceTransition, { kind: 'open-member' }>
    >().toBeNever();
    expectTypeOf<
      Extract<RenderedRoomSurface, { kind: 'member' }>
    >().toBeNever();
    expectTypeOf<
      Extract<WorkspaceRoomSurface, { kind: 'member' }>
    >().toBeNever();

    stubMedia();
    const { back, lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });
    expect(back.activeSurface()).toEqual({
      layer: 'room',
      surface: { kind: 'members' },
    });
  });

  it('clears the whole slot and records remembered members closed', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });
    lifecycle.transition({ kind: 'open-pinned' });

    lifecycle.transition({ kind: 'clear' });
    expect(lifecycle.renderedSurface()).toBeNull();

    lifecycle.transition({ kind: 'open-threads' });
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
    lifecycle.transition({ kind: 'escape' });
    expect(lifecycle.renderedSurface()).toBeNull();

    lifecycle.transition({ kind: 'open-threads' });
    lifecycle.transition({ kind: 'escape' });
    expect(lifecycle.renderedSurface()).toBeNull();
  });

  it('keeps the roster the URL names when the viewport becomes a drawer', () => {
    const resize = stubMedia({ [BELOW_MEMBERS_QUERY]: false });
    const { closePanel, lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });

    resize(BELOW_MEMBERS_QUERY, true);
    TestBed.tick();
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
    expect(closePanel).not.toHaveBeenCalled();

    lifecycle.transition({ kind: 'open-threads' });
    lifecycle.transition({ kind: 'dismiss' });
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
  });

  it('keeps an opened member drawer when it becomes a wide static column', () => {
    const resize = stubMedia({ [BELOW_MEMBERS_QUERY]: true });
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-members' });

    resize(BELOW_MEMBERS_QUERY, false);
    TestBed.tick();
    expect(lifecycle.renderedSurface()).toEqual({ kind: 'members' });
  });

  it('drops jump state when the exact Conversation changes', () => {
    stubMedia();
    const { activeRoomId, lifecycle } = build();
    lifecycle.transition({ kind: 'reveal-message', eventId: '$one' });
    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBe('$one');

    activeRoomId.set('!other:example.org');
    expect(lifecycle.jumpTarget()).toBeNull();
    expect(lifecycle.jumpRevision()).toBe(0);
  });

  it('closes temporary state before a deferred message reveal', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'open-search' });

    lifecycle.transition({ kind: 'reveal-message', eventId: '$event' });
    expect(lifecycle.renderedSurface()).toBeNull();
    expect(lifecycle.jumpTarget()).toBeNull();

    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBe('$event');
    expect(lifecycle.jumpRevision()).toBe(1);
  });

  it('reveals a jump from a panel only once its close has committed', () => {
    stubMedia();
    const { closePanel, lifecycle, panel } = build(undefined, {
      commits: false,
    });
    panel.set({ kind: 'pinned' });

    lifecycle.transition({ kind: 'reveal-message', eventId: '$event' });
    expect(closePanel).toHaveBeenCalledOnce();
    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBeNull();

    panel.set(null);
    TestBed.tick();
    expect(lifecycle.jumpTarget()).toBe('$event');
    expect(lifecycle.jumpRevision()).toBe(1);
  });

  it('drops a deferred reveal superseded before render', () => {
    stubMedia();
    const { lifecycle } = build();
    lifecycle.transition({ kind: 'reveal-message', eventId: '$stale' });
    lifecycle.transition({ kind: 'open-threads' });

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

    expect(lifecycle.renderedSurface()).toBeNull();
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

  it('stops offering the compact Conversation once the viewport is wide, before its change event', async () => {
    const setMedia = stubMedia({ [BELOW_MD_QUERY]: true });
    const { back, navigate } = build();
    expect(back.activeSurface()).toMatchObject({ layer: 'conversation' });

    // A busy main thread can run a popstate before the rendering step that reports the
    // media query change. Back must follow the viewport, not the event that lags it.
    setMedia(BELOW_MD_QUERY, false, false);

    await expect(firstValueFrom(back.back())).resolves.toEqual({
      kind: 'unhandled',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects opening a surface without an active Conversation', () => {
    stubMedia();
    const { lifecycle } = build(null);

    expect(lifecycle.transition({ kind: 'open-search' })).toEqual({
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
