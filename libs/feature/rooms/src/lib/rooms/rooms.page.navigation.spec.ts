import {
  SHARED_MOCKS,
  clientStub,
  flushPanelJump,
  invitesProvider,
  setMediaQuery,
  setRouteRoom,
  setRouteSegment,
  shellFrom,
  stubLiveLayout,
  stubNarrowLayout,
} from './rooms-page.spec-harness';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { Router } from '@angular/router';
import { KeyboardShortcutsService } from '@trinity/platform-native';
import { AuthService } from '@trinity/data-access/auth';
import { type PendingInvite } from '@trinity/data-access/invites';
import {
  HomeserverInfoService,
  type HomeserverInfo,
} from '@trinity/data-access/homeserver';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { AccountProfilesService } from '@trinity/data-access/profile';
import { MediaService } from '@trinity/data-access/media';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import {
  RoomsService,
  SpacesService,
  UnreadAggregatorService,
  type RoomSummary,
  type SpaceSummary,
} from '@trinity/data-access/rooms';
import {
  ThreadsService,
  TimelineActionsService,
  TimelineService,
} from '@trinity/data-access/timeline';
import {
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { RoomsPage } from './rooms.page';
import { type RightPanel } from './room-shell-store';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';

// The open room is the URL now, and the route the store reads outlives any one TestBed —
// it is one stream in the harness, shared by every block in this file. Without this reset a
// test that opens a room hands it to the next test, where "no room is open" then silently
// asserts against the previous test's room.
beforeEach(() => setRouteRoom(null));

// The quick switcher (Ctrl/Cmd+K) presents a modal and, on a selection, jumps per
// kind: room/dm open the room, space selects it in the rail, a directory person
// opens a DM, an invite runs the page's accept path.
describe('RoomsPage quick switcher', () => {
  let pick: Mock;
  let createDirectMessage: Mock;
  let acceptInvite: Mock;
  let openSpace: Mock;
  let timelineOpen: Mock;
  let pending: WritableSignal<PendingInvite[]>;
  let dialogHasOpen: Mock;

  function build() {
    pick = vi.fn();
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    acceptInvite = vi.fn(() => of(undefined));
    openSpace = vi.fn();
    timelineOpen = vi.fn();
    pending = signal<PendingInvite[]>([]);
    dialogHasOpen = vi.fn().mockReturnValue(false);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          createDirectMessage,
          // The jump resolves the row's owning account from the known room set.
          rooms: signal<RoomSummary[]>([]),
          directRoomIds: signal<ReadonlySet<string>>(new Set()).asReadonly(),
        }),
        MockProvider(SpacesService, {
          openSpace,
          spaces: signal<SpaceSummary[]>([]),
          childRoomIds: vi.fn(() => []),
        }),
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
        }),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService, { pick }),
        MockProvider(TimelineService, { open: timelineOpen }),
        MockProvider(TimelineActionsService),
        MockProvider(MediaService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => clientStub(),
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService, { hasOpen: dialogHasOpen }),
        MockProvider(TrnAlertService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('opens the selected room', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'room', id: '!r:hs' });

    await shell.shortcuts.openSwitcher();
    TestBed.tick(); // the projections follow the URL from an effect

    expect(shell.store.activeRoomId()).toBe('!r:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!r:hs');
  });

  it('opens a DM result like a room', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'dm', id: '!d:hs' });

    await shell.shortcuts.openSwitcher();

    expect(shell.store.activeRoomId()).toBe('!d:hs');
  });

  it('selects a space in the rail (loading its hierarchy)', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'space', id: '!s:hs' });

    await shell.shortcuts.openSwitcher();

    expect(shell.store.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');
    expect(shell.store.activeRoomId()).toBeNull();
  });

  it('opens (or reuses) a DM for a directory person', async () => {
    const shell = build();
    pick.mockResolvedValue({ kind: 'user', id: '@bob:hs' });

    await shell.shortcuts.openSwitcher();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('runs the accept path for an invite result', async () => {
    const shell = build();
    pending.set([
      {
        roomId: '!i:hs',
        accountId: '@me:hs',
        name: 'Invited',
        initial: 'I',
        avatarMxc: null,
        inviterName: 'Alice',
        isSpace: false,
        isDirect: false,
      },
    ]);
    pick.mockResolvedValue({ kind: 'invite', id: '!i:hs' });

    await shell.shortcuts.openSwitcher();

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs', undefined);
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('does nothing when the switcher is cancelled', async () => {
    const shell = build();
    pick.mockResolvedValue(null);

    await shell.shortcuts.openSwitcher();
    TestBed.tick(); // flush, so "nothing opened" outlives the projection effect

    expect(shell.store.activeRoomId()).toBeNull();
    expect(timelineOpen).not.toHaveBeenCalled();
  });

  it('Ctrl/Cmd+K prevents default and opens the switcher', async () => {
    const shell = build();
    pick.mockResolvedValue(null);
    const preventDefault = vi.fn();

    // Cmd+K resolves to the `switcher.open` shortcut through the registry.
    shell.shortcuts.onGlobalKeydown({
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(preventDefault).toHaveBeenCalled(); // sync — stops the browser's Cmd+K
    await new Promise((resolve) => setTimeout(resolve)); // settle the async openSwitcher()
    expect(pick).toHaveBeenCalled();
  });

  it('does not open the switcher over an existing overlay', async () => {
    const shell = build();
    dialogHasOpen.mockReturnValue(true);

    await shell.shortcuts.openSwitcher();

    // A thread/search/verification modal owns the screen — the switcher must not
    // stack over it (picking a result would releaseAll() its pinned media).
    expect(pick).not.toHaveBeenCalled();
  });

  it('shows in-room search in the slot, and a hit jumps the timeline', () => {
    // Two steps now instead of one awaited dialog: the panel goes into the shell's one
    // right-hand slot, and a picked row arrives back through `onPanelJump` — which is what
    // the template binds the panel's `(selected)` output to.
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');

    shell.messages.openMessageSearch();
    expect(shell.store.rightPanel()).toEqual({ kind: 'search' });

    shell.messages.onPanelJump('$evt:hs');

    flushPanelJump();

    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(1);
    // And the slot closes, as the dialog it replaced did: on the drawer layout it covers
    // the timeline, so jumping with it open scrolls a message nobody can see.
    expect(shell.store.rightPanel()).toBeNull();
  });

  it('in-room search bumps jumpRequest again when the SAME hit is re-picked', () => {
    // Same crux as the pinned panel: picking the identical hit twice must still
    // re-fire the jump, which only happens because jumpRequest keeps incrementing.
    // Easier to reach now — the panel stays open, so the second pick is just another row
    // click rather than reopening the whole dialog.
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');
    shell.messages.openMessageSearch();

    shell.messages.onPanelJump('$evt:hs');

    flushPanelJump();
    expect(shell.store.jumpRequest()).toBe(1);

    shell.messages.onPanelJump('$evt:hs');

    flushPanelJump();

    expect(shell.store.messageSearchTarget()).toBe('$evt:hs');
    expect(shell.store.jumpRequest()).toBe(2);
  });

  it('does not jump when in-room search is dismissed without a pick', () => {
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');

    shell.messages.openMessageSearch();
    shell.page.closeRightPanel();

    expect(shell.store.messageSearchTarget()).toBeNull();
    expect(shell.store.jumpRequest()).toBe(0);
    expect(shell.store.rightPanel()).toBeNull();
  });

  it('does not open in-room search when no room is active', () => {
    const shell = build();
    const before = shell.store.rightPanel();

    shell.messages.openMessageSearch();

    // Reference identity, so this fails for ANY write to the slot, not only for search.
    expect(shell.store.rightPanel()).toBe(before);
    expect(shell.store.messageSearchTarget()).toBeNull();
  });
});

// Below md the rail + sidebar (room list) and the chat are separate full-screen
// pages keyed off `activeRoomId`: picking a room opens the chat page, and the back
// button (`backToList`) returns to the list. At md+ both columns are static columns.
describe('RoomsPage mobile navigation', () => {
  let timelineOpen: Mock;
  let threadsOpen: Mock;
  let releaseAll: Mock;

  function build() {
    timelineOpen = vi.fn();
    threadsOpen = vi.fn();
    releaseAll = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService),
        MockProvider(TimelineService, { open: timelineOpen }),
        MockProvider(TimelineActionsService),
        MockProvider(MediaService, { releaseAll }),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => clientStub(),
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService, { open: threadsOpen }),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('backToList closes the open room, returning to the list page', () => {
    const shell = build();
    shell.nav.onSelectRoom('!r:hs');
    TestBed.tick(); // open the projections FIRST, so the closes below can only come from backToList
    expect(shell.store.activeRoomId()).toBe('!r:hs');
    // Both halves, or the test passes on an effect that never opened anything and then
    // "closed" it from the same single null run.
    expect(TestBed.inject(TimelineService).open).toHaveBeenCalledWith('!r:hs');
    expect(TestBed.inject(TimelineService).close).not.toHaveBeenCalled();

    shell.page.backToList();
    TestBed.tick();

    expect(shell.store.activeRoomId()).toBeNull();
    expect(TestBed.inject(TimelineService).close).toHaveBeenCalled();
    expect(TestBed.inject(ThreadsService).close).toHaveBeenCalled();
    expect(TestBed.inject(PinnedMessagesService).close).toHaveBeenCalled();
  });

  it('closing a room resets an open members drawer so it does not carry to the next room', () => {
    // Force the narrow (drawer) layout so the member list reads as an overlay.
    const restore = stubNarrowLayout();
    try {
      const shell = build();
      shell.nav.onSelectRoom('!a:hs');
      shell.store.rightPanel.set({ kind: 'members' }); // the drawer is open in room A
      expect(shell.store.membersOpen()).toBe(true);

      shell.page.backToList();

      // The drawer state is dropped, so it won't slide in over the next room.
      expect(shell.store.membersOpen()).toBe(false);
    } finally {
      restore();
    }
  });

  it('seeds the members list open as the wide static column and toggleMembers flips it', () => {
    // The base stub reports non-drawer (matches:false) — the wide layout — so the static
    // members column shows by default; toggleMembers hides and re-shows it.
    const shell = build();
    expect(shell.store.membersOpen()).toBe(true);

    shell.page.toggleMembers();
    expect(shell.store.membersOpen()).toBe(false);

    shell.page.toggleMembers();
    expect(shell.store.membersOpen()).toBe(true);
  });

  it('seeds the members drawer closed on the narrow layout', () => {
    // At/below the drawer cutoff the list is the overlay drawer, which starts closed
    // rather than defaulting open like the wide static column.
    const restore = stubNarrowLayout();
    try {
      expect(build().store.membersOpen()).toBe(false);
    } finally {
      restore();
    }
  });

  it('closeRightPanel empties the slot (the mobile drawer backdrop)', () => {
    const shell = build();
    shell.store.rightPanel.set({ kind: 'members' });
    expect(shell.store.membersOpen()).toBe(true);

    shell.page.closeRightPanel();
    expect(shell.store.membersOpen()).toBe(false);
  });

  it('Escape closes a panel at the WIDE layout, where nothing else does', () => {
    // The base matchMedia stub reports non-drawer, i.e. the wide layout. These are plain
    // components now, so nothing gives them the Escape a CDK dialog answered for free — and
    // the guard that used to read `membersAreDrawer()` alone made Escape a no-op here.
    const shell = build();
    setRouteRoom('!r:hs');
    shell.store.rightPanel.set({ kind: 'threads' });

    shell.page.onEscapeKey();

    expect(shell.store.rightPanel()).toBeNull();
  });

  it('Escape leaves the wide roster alone (the composer owns Escape there)', () => {
    // This is a DOCUMENT listener: an unguarded Escape would close the member column every
    // time someone pressed Escape to cancel an edit in the composer. As the narrow drawer it
    // is an overlay like the rest and goes — covered by the drawer test above.
    const shell = build();
    setRouteRoom('!r:hs');
    shell.store.rightPanel.set({ kind: 'members' });

    shell.page.onEscapeKey();

    expect(shell.store.rightPanel()).toEqual({ kind: 'members' });
  });

  it('Escape on member info goes back to the roster, like its close button', () => {
    // Escape is the keyboard spelling of pressing the panel's own close button, so it has to
    // land in the same place. Only the mobile backdrop empties the slot outright.
    const shell = build();
    setRouteRoom('!r:hs');
    shell.store.rightPanel.set({
      kind: 'member',
      member: {
        userId: '@bob:hs',
        name: 'Bob',
        initial: 'B',
        avatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      },
      direct: false,
    });

    shell.page.onEscapeKey();

    expect(shell.store.rightPanel()).toEqual({ kind: 'members' });
  });

  it('gives focus back to whatever opened the slot once it empties', () => {
    // CDK did this for the four dialogs these panels replaced. Without it a keyboard user who
    // opens Threads, reads the list and closes it lands on `<body>` — and in-room search is
    // worse, because it deliberately takes focus when it opens.
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    try {
      trigger.focus();

      shell.store.rightPanel.set({ kind: 'threads' });
      TestBed.tick();
      trigger.blur(); // the panel took focus, then its removal orphans it
      shell.page.closeRightPanel();
      TestBed.tick();
      TestBed.tick(); // the restore is deferred to after the render that removes the panel

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it('leaves focus alone when something else has claimed it', () => {
    // The room-change handoff, or a DM the panel just opened, has a better idea than a
    // remembered button does — so the restore only fires when the removal orphaned focus.
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    const trigger = document.createElement('button');
    const elsewhere = document.createElement('button');
    document.body.append(trigger, elsewhere);
    try {
      trigger.focus();
      shell.store.rightPanel.set({ kind: 'threads' });
      TestBed.tick();

      shell.page.closeRightPanel();
      elsewhere.focus();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      trigger.remove();
      elsewhere.remove();
    }
  });

  const bobPanel: Exclude<RightPanel, null> = {
    kind: 'member',
    member: {
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    },
    direct: false,
  };

  it.each<{
    name: string;
    from: Exclude<RightPanel, null>;
    to: Exclude<RightPanel, null>;
    targetTag: 'button' | 'input';
  }>([
    {
      name: 'threads → thread',
      from: { kind: 'threads' },
      to: { kind: 'thread', rootEventId: '$root' },
      targetTag: 'button',
    },
    {
      name: 'members → member',
      from: { kind: 'members' },
      to: bobPanel,
      targetTag: 'button',
    },
    {
      name: 'member → members',
      from: bobPanel,
      to: { kind: 'members' },
      targetTag: 'input',
    },
  ])('hands focus to the replacement on $name', ({ from, to, targetTag }) => {
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    TestBed.tick();
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      shell.store.rightPanel.set(from);
      TestBed.tick();

      const source = document.createElement('button');
      slot.append(source);
      source.focus();
      shell.store.rightPanel.set(to);
      source.remove(); // the outgoing panel's render removal orphans focus
      const target = document.createElement(targetTag);
      target.dataset['rightPanelFocus'] = '';
      slot.append(target);
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(target);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('restores the original external trigger after an inline swap then close', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    TestBed.tick();
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      shell.store.rightPanel.set({ kind: 'threads' });
      TestBed.tick();

      const source = document.createElement('button');
      slot.append(source);
      source.focus();
      shell.store.rightPanel.set({ kind: 'thread', rootEventId: '$root' });
      source.remove();
      const threadClose = document.createElement('button');
      threadClose.dataset['rightPanelFocus'] = '';
      slot.append(threadClose);
      TestBed.tick();
      TestBed.tick();
      expect(document.activeElement).toBe(threadClose);

      shell.page.closeRightPanel();
      slot.remove();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('remembers an outside opener when the wide roster was already seeded', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    expect(shell.store.rightPanel()).toEqual({ kind: 'members' });
    TestBed.tick(); // establish the already-rendered roster before its toolbar replacement
    const trigger = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, slot);
    try {
      trigger.focus();
      shell.store.rightPanel.set({ kind: 'threads' });
      TestBed.tick();

      const threadRow = document.createElement('button');
      slot.append(threadRow);
      threadRow.focus();
      shell.store.rightPanel.set({ kind: 'thread', rootEventId: '$root' });
      threadRow.remove();
      const threadClose = document.createElement('button');
      threadClose.dataset['rightPanelFocus'] = '';
      slot.append(threadClose);
      TestBed.tick();
      TestBed.tick();
      expect(document.activeElement).toBe(threadClose);

      shell.page.closeRightPanel();
      slot.remove();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      slot.remove();
    }
  });

  it('remembers a timeline opener beside the seeded wide roster', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    expect(shell.store.rightPanel()).toEqual({ kind: 'members' });
    TestBed.tick();
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    const timelineTrigger = document.createElement('button');
    slot.append(timelineTrigger);
    document.body.append(slot);
    try {
      timelineTrigger.focus();
      shell.store.rightPanel.set({ kind: 'thread', rootEventId: '$root' });
      TestBed.tick();

      const panel = document.createElement('div');
      panel.dataset['rightPanelSurface'] = '';
      const threadClose = document.createElement('button');
      threadClose.dataset['rightPanelFocus'] = '';
      panel.append(threadClose);
      slot.append(panel);
      threadClose.focus();

      shell.page.closeRightPanel();
      panel.remove();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(timelineTrigger);
    } finally {
      slot.remove();
    }
  });

  it('does not steal focus claimed while an inline swap renders', () => {
    const shell = build();
    setRouteRoom('!r:hs');
    shell.page.closeRightPanel();
    TestBed.tick();
    const trigger = document.createElement('button');
    const elsewhere = document.createElement('button');
    const slot = document.createElement('div');
    slot.dataset['rightPanelSlot'] = '';
    document.body.append(trigger, elsewhere, slot);
    try {
      trigger.focus();
      shell.store.rightPanel.set({ kind: 'threads' });
      TestBed.tick();

      const source = document.createElement('button');
      slot.append(source);
      source.focus();
      shell.store.rightPanel.set({ kind: 'thread', rootEventId: '$root' });
      source.remove();
      const target = document.createElement('button');
      target.dataset['rightPanelFocus'] = '';
      slot.append(target);
      elsewhere.focus();
      TestBed.tick();
      TestBed.tick();

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      trigger.remove();
      elsewhere.remove();
      slot.remove();
    }
  });

  it('measures the swipe against the drawer that is actually on screen', () => {
    // NOT `layout.rightPanelWidth()`, which is the width the pane handle drags on a DESKTOP
    // and which the stylesheet ignores at this breakpoint. Passing it measured a 240px roster
    // against a 480px default — 80% of its travel to commit, where the rule is 40% — and a
    // user who had dragged the panel to its 720px maximum made the distance threshold
    // physically unreachable on a phone.
    const shell = build();
    setRouteRoom('!r:hs');
    const widthOf = () =>
      (shell.page as unknown as { drawerWidth(): number }).drawerWidth();

    shell.store.rightPanel.set({ kind: 'members' });
    expect(widthOf()).toBe(240);

    shell.store.rightPanel.set(null);
    expect(widthOf()).toBe(240); // an opening swipe measures the roster it will open

    shell.store.rightPanel.set({ kind: 'threads' });
    expect(widthOf()).toBe(Math.min(480, window.innerWidth));
  });

  it('a swipe with no room open opens nothing', () => {
    // The slot's template is gated on an open room, so writing the state without one leaves
    // a roster queued for whichever room is opened next.
    const shell = build();
    setRouteRoom(null);
    const before = shell.store.rightPanel();

    shell.page.onDrawerSwipedOpen();

    expect(shell.store.rightPanel()).toBe(before);
  });

  it('onSelectRoom opens the room (switching to the mobile chat page)', () => {
    const shell = build();

    shell.nav.onSelectRoom('!r:hs');
    TestBed.tick(); // the projections follow the URL from an effect

    expect(shell.store.activeRoomId()).toBe('!r:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!r:hs');
    expect(threadsOpen).toHaveBeenCalledWith('!r:hs');
    expect(releaseAll).toHaveBeenCalled();
  });
});

// The user-panel switcher summarises every signed-in account: each row is that account's
// profile (display name + avatar) from AccountProfilesService with a fallback to the raw
// MXID, plus its unread total — and it tolerates an account the projection has no entry
// for yet, which still shows as a row with a zero badge.
describe('RoomsPage account switcher summary', () => {
  const meAvatar = 'mxc://hs/me';
  let homeservers: ReturnType<
    typeof signal<ReadonlyMap<string, HomeserverInfo>>
  >;
  let loadAllHomeservers: Mock;

  beforeEach(() => {
    homeservers = signal<ReadonlyMap<string, HomeserverInfo>>(new Map());
    loadAllHomeservers = vi.fn(() => of(undefined));
  });

  function build() {
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService),
        MockProvider(TimelineService),
        MockProvider(TimelineActionsService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>([
            '@me:hs',
            '@alt:hs',
          ]).asReadonly(),
          // Profiles come from the projection below, not from reading clients here.
          clientFor: () => null,
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map([['@me:hs', 4]]),
          ).asReadonly(),
        }),
        // '@me:hs' has a hydrated profile; '@alt:hs' is signed in but has no entry yet,
        // so its row falls back to the mxid.
        MockProvider(AccountProfilesService, {
          profiles: signal(
            new Map([
              [
                '@me:hs',
                {
                  userId: '@me:hs',
                  displayName: 'Me',
                  avatarMxc: meAvatar,
                },
              ],
            ]),
          ).asReadonly(),
        }),
        MockProvider(HomeserverInfoService, {
          infos: homeservers.asReadonly(),
          loadAll: loadAllHomeservers,
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('carries each account\u2019s homeserver version into the switcher row', () => {
    // #155: the same value the Server settings section shows, composed once here so the
    // presentational panel stays a dumb renderer.
    homeservers.set(
      new Map([
        [
          '@me:hs',
          {
            userId: '@me:hs',
            serverName: 'hs',
            baseUrl: 'https://hs',
            discovered: false,
            software: {
              name: 'Synapse',
              version: '1.158.0',
              source: 'base-url' as const,
              host: 'https://hs',
            },
            specVersions: null,
            unstableFeatures: null,
            capabilities: null,
          },
        ],
      ]),
    );
    const shell = build();

    const rows = shell.vm.accounts();
    expect(rows[0].server).toBe('Synapse 1.158.0');
    // The account with no answer gets null rather than a placeholder \u2014 the switcher omits
    // the line entirely rather than reserving space for a word nobody came to read.
    expect(rows[1].server).toBeNull();
  });

  it('looks the versions up only when the account menu asks', () => {
    const shell = build();
    expect(loadAllHomeservers).not.toHaveBeenCalled();

    shell.vm.loadHomeserverInfo();

    expect(loadAllHomeservers).toHaveBeenCalledTimes(1);
  });

  it('summarises each account by its client profile, MXID fallback, and unread total', () => {
    const shell = build();

    // '@me:hs': hydrated profile (name + avatar) with its unread total from the
    // aggregator. '@alt:hs': no profile entry yet, so the name falls back to the MXID,
    // the avatar is null, and its unread defaults to 0 (absent from the map).
    // `server` is null for both: the homeserver version is looked up when the account menu
    // is opened, not at startup, so nothing has asked for it yet here.
    expect(shell.vm.accounts()).toEqual([
      {
        userId: '@me:hs',
        displayName: 'Me',
        avatarMxc: meAvatar,
        unread: 4,
        server: null,
      },
      {
        userId: '@alt:hs',
        displayName: '@alt:hs',
        avatarMxc: null,
        unread: 0,
        server: null,
      },
    ]);
  });
});

// Keyboard room switching (issue #12): the single `onGlobalKeydown` dispatcher. The MRU
// service and the pure nav helpers have their own specs; these assert the wiring — which
// chord opens what, the desktop gate, and the overlay guard.
describe('RoomsPage keyboard room switching', () => {
  function roomSummary(id: string, unread = 0): RoomSummary {
    return {
      id,
      accountId: '@me:hs',
      accountIds: ['@me:hs'],
      name: id,
      initial: id[1].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: unread,
      highlightCount: 0,
      hasUnread: unread > 0,
      markedUnread: false,
      lastMessage: '',
      activityTs: 0,
      favourite: false,
      lowPriority: false,
    };
  }

  let dialogOpen = false;

  let keyboardRooms: WritableSignal<RoomSummary[]>;

  const releaseAll = vi.fn();
  function build() {
    releaseAll.mockClear();
    dialogOpen = false;
    // Display order a, b, c; b and c carry unread.
    keyboardRooms = signal<RoomSummary[]>([
      roomSummary('!a:hs'),
      roomSummary('!b:hs', 3),
      roomSummary('!c:hs', 1),
    ]);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: keyboardRooms,
          directRoomIds: signal<ReadonlySet<string>>(new Set()),
        }),
        MockProvider(SpacesService, {
          spaces: signal([]),
          childRoomIds: vi.fn(() => []),
        }),
        MockProvider(TimelineService),
        MockProvider(TimelineActionsService),
        MockProvider(MediaService, { releaseAll }),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => clientStub(),
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService, { hasOpen: () => dialogOpen }),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  /** A minimal KeyboardEvent-like with a preventDefault spy, for the host handler. */
  function key(init: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: '',
      code: '',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      ...init,
    } as unknown as KeyboardEvent;
  }

  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
  });

  /** Visit a → b → c so the MRU is [c, b, a] and we're in c. */
  function visitABC(shell: ReturnType<typeof shellFrom>): void {
    shell.nav.onSelectRoom('!a:hs');
    shell.nav.onSelectRoom('!b:hs');
    shell.nav.onSelectRoom('!c:hs');
  }

  it('ignores a shortcut that resolves to the room already open', () => {
    // Not a no-op for tidiness: re-entering onSelectRoom calls media.releaseAll(), which
    // revokes the object URLs for images currently on screen. timeline.open() early-returns
    // on the same id; releaseAll does not. Reachable with a one-room list, because the list
    // walk wraps around to the room you are already in.
    const shell = build();
    keyboardRooms.set([roomSummary('!only:hs')]);
    shell.nav.onSelectRoom('!only:hs');
    TestBed.tick(); // let the room actually open (this is the releaseAll we allow)
    releaseAll.mockClear();

    shell.page.onGlobalKeydown(key({ key: 'ArrowDown', altKey: true }));
    TestBed.tick(); // without the flush the assertion would hold for any implementation

    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('keeps the keyboard surface wired through the page', () => {
    // The host binding names a member of the component class, so the page keeps a delegate
    // nothing else calls. Re-pointing this suite onto the coordinators removed the only
    // test crossing that seam — emptying the delegate body left 192 tests green, i.e. the
    // whole keyboard feature could be unplugged from the page unnoticed.
    const shell = build();
    visitABC(shell);

    shell.page.onGlobalKeydown(key({ key: "'", ctrlKey: true }));

    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('hops back through the visited stack, cycling deeper, without recording mid-cycle', () => {
    const shell = build();
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // previous room

    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!a:hs'); // two back — cycling deeper

    // Shift reverses.
    shell.shortcuts.onGlobalKeydown(
      key({ key: "'", ctrlKey: true, shiftKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('consumes the chord it handles and ignores an unmodified quote', () => {
    const shell = build();
    visitABC(shell);

    const handled = key({ key: "'", metaKey: true });
    shell.shortcuts.onGlobalKeydown(handled);
    expect(handled.preventDefault).toHaveBeenCalled();

    const typed = key({ key: "'" }); // no modifier → plain typing
    shell.shortcuts.onGlobalKeydown(typed);
    expect(typed.preventDefault).not.toHaveBeenCalled();
  });

  it('walks the visible list with Alt+Arrow, wrapping', () => {
    const shell = build(); // list order a, b, c; in c after visiting
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(key({ key: 'ArrowDown', altKey: true }));
    expect(shell.store.activeRoomId()).toBe('!a:hs'); // c → wrap to a

    shell.shortcuts.onGlobalKeydown(key({ key: 'ArrowUp', altKey: true }));
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // a → wrap back to c
  });

  it('jumps to the next unread room with Alt+Shift+Arrow', () => {
    const shell = build(); // b(3) and c(1) are unread
    shell.nav.onSelectRoom('!a:hs'); // in a read room

    shell.shortcuts.onGlobalKeydown(
      key({ key: 'ArrowDown', altKey: true, shiftKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // first unread
  });

  it('ignores Ctrl/Cmd+1…9 and Ctrl+Tab on the web (browser-reserved)', () => {
    const shell = build(); // no desktop marker
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit1', key: '1', metaKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // unchanged
    shell.shortcuts.onGlobalKeydown(key({ key: 'Tab', ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // unchanged
  });

  it('jumps to the Nth most-recent room with Ctrl/Cmd+1…9 on the desktop shell', () => {
    // The marker must be present before the page reads it at construction.
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell); // MRU [c, b, a], in c

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit2', key: '2', ctrlKey: true }),
    );
    expect(shell.store.activeRoomId()).toBe('!a:hs'); // 2 = two rooms back
  });

  it('hops with Ctrl+Tab on the desktop shell', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell); // in c

    shell.shortcuts.onGlobalKeydown(key({ key: 'Tab', ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // Tab hops like the quote
  });

  // The MRU outlives account switches and unticks, so a numbered jump can name a room no
  // account in scope still holds — unlike hop, nth() filters against nothing. Opening it
  // would tear the timeline down and leave a blank chat pane, so it must decline.
  it('ignores a numbered jump to a room the list no longer knows', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell); // MRU [c, b, a], in c
    // '!b:hs' leaves the scope (its account was unticked, or signed out).
    keyboardRooms.set([roomSummary('!a:hs'), roomSummary('!c:hs')]);

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit1', key: '1', ctrlKey: true }),
    );

    expect(shell.store.activeRoomId()).toBe('!c:hs'); // stayed put rather than opening a ghost
  });

  it('still jumps to a room that is in scope', () => {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
      isElectron: true,
    };
    const shell = build();
    visitABC(shell);

    shell.shortcuts.onGlobalKeydown(
      key({ code: 'Digit1', key: '1', ctrlKey: true }),
    );

    expect(shell.store.activeRoomId()).toBe('!b:hs');
  });

  it('stays quiet while an overlay owns the screen', () => {
    const shell = build();
    visitABC(shell);
    dialogOpen = true;

    const event = key({ key: "'", ctrlKey: true });
    shell.shortcuts.onGlobalKeydown(event);
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // no hop
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('follows a rebound chord, not the old one', () => {
    const shell = build();
    visitABC(shell); // in c, MRU [c, b, a]
    // Move "hop back" from Ctrl+' to Alt+J through the registry.
    TestBed.inject(KeyboardShortcutsService).rebind('room.hop.back', {
      accel: false,
      alt: true,
      shift: false,
      key: 'j',
    });

    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // old chord no longer hops

    shell.shortcuts.onGlobalKeydown(key({ key: 'j', altKey: true }));
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // the new chord does

    TestBed.inject(KeyboardShortcutsService).resetAll(); // don't leak into other specs
  });

  it('ignores a chord while a panel owns the screen, but not while the roster does', () => {
    // The guard used to be `dialog.hasOpen()` alone, and that answered the question for as
    // long as these surfaces were dialogs. Inline in the slot they are invisible to it, so a
    // chord typed into the search field walked to another room. The roster stays exempt: it
    // is a column beside the timeline, not over it.
    const shell = build();
    visitABC(shell); // in c, MRU [c, b, a]

    shell.store.rightPanel.set({ kind: 'search' });
    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!c:hs'); // suppressed

    shell.store.rightPanel.set({ kind: 'members' });
    shell.shortcuts.onGlobalKeydown(key({ key: "'", ctrlKey: true }));
    expect(shell.store.activeRoomId()).toBe('!b:hs'); // still hops
  });
});

// A notification tap (web Notification, Electron toast, or an FCM/APNs tap) navigates to
// `/rooms/<segment>`; the shell is what has to turn that URL into an open room. These drive
// the real route parameter through to `activeRoomId` and the projections behind it — the
// producer side was already asserted against a mocked Router in the notifications lib, which
// stayed green for the whole time nothing consumed what it sent.
describe('RoomsPage room-in-URL deep link', () => {
  let timelineOpen: Mock;
  let timelineClose: Mock;

  function build() {
    timelineOpen = vi.fn();
    timelineClose = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService),
        MockProvider(TimelineService, {
          open: timelineOpen,
          close: timelineClose,
        }),
        MockProvider(TimelineActionsService),
        MockProvider(MediaService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>('@me:hs').asReadonly(),
          accountIds: signal<readonly string[]>(['@me:hs']).asReadonly(),
          clientFor: () => clientStub(),
        }),
        MockProvider(UnreadAggregatorService, {
          unreadByAccount: signal<ReadonlyMap<string, number>>(
            new Map(),
          ).asReadonly(),
        }),
        MockProvider(ThreadsService),
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('opens the room the URL names when the page is created on it', () => {
    setRouteRoom('!notified:hs'); // a cold start on /rooms/:roomId — a tap, a reload, a pasted link
    const shell = build();

    TestBed.tick(); // run the projection effect

    expect(shell.store.activeRoomId()).toBe('!notified:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!notified:hs');
  });

  it('opens it when the URL changes on the already-active /rooms route', () => {
    // THE case: tapping a notification while the shell is open does not re-create the
    // component, so a route snapshot read sees nothing. Only the stream fires.
    const shell = build();
    TestBed.tick();
    expect(shell.store.activeRoomId()).toBeNull();

    setRouteRoom('!notified:hs');
    TestBed.tick();

    expect(shell.store.activeRoomId()).toBe('!notified:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!notified:hs');
  });

  it('follows the URL without writing it back', () => {
    // What is left of "strips the param with replaceUrl": there is no `?room=` to strip now
    // — the URL IS the open room. The other half of that test still has to hold, though: the
    // shell must not navigate while merely FOLLOWING the route, or every tap would push a
    // second history entry and Back would land the user on the room they just left.
    setRouteRoom('!notified:hs');
    const shell = build();
    const router = TestBed.inject(Router);
    vi.mocked(router.navigate).mockClear(); // the harness spy is shared across this file

    TestBed.tick();

    expect(shell.store.activeRoomId()).toBe('!notified:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!notified:hs');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not re-open the room that is already open', () => {
    const shell = build();
    shell.nav.onSelectRoom('!notified:hs');
    TestBed.tick();
    timelineOpen.mockClear();

    setRouteRoom('!notified:hs'); // the same room named again — a second tap on the same chat
    TestBed.tick();

    expect(shell.store.activeRoomId()).toBe('!notified:hs');
    expect(timelineOpen).not.toHaveBeenCalled();
  });

  it('ignores a route with no room segment', () => {
    const shell = build();
    const router = TestBed.inject(Router);
    vi.mocked(router.navigate).mockClear();

    TestBed.tick();

    expect(shell.store.activeRoomId()).toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
  });
  // A segment that is not one of ours must land on the room list, not be handed to the SDK
  // as a room id. Every other route helper encodes first, so this is the only place the
  // null branch of `decodeRoomSegment` is reachable from a spec at all.
  it('ignores a segment that is not a room reference', () => {
    // `aGVsbG8` is valid base64url over valid UTF-8 ("hello"), so it reaches the sigil
    // check rather than short-circuiting on the alphabet test or the decode's catch —
    // the guard this is about is the one that asks whether the result is a room reference.
    setRouteSegment('aGVsbG8');
    const shell = build();

    TestBed.tick();

    expect(shell.store.activeRoomId()).toBeNull();
    expect(timelineOpen).not.toHaveBeenCalled();
  });

  // The projection effect must depend on the OPEN ROOM and nothing else. `focusActiveView`
  // reads the md media query and `clearMarkedUnread` reads `matrix.accountIds()`, and an
  // effect tracks every signal its body reads through a callee — so calling either without
  // `untracked` puts them in this effect's dependency set. A window crossing 768px would
  // then re-run the whole projection, and `media.releaseAll()` would revoke the object URLs
  // of every image on screen; they do not come back, because the memoised MessageView keeps
  // the attachment's input identity stable so nothing re-resolves.
  //
  // Two flushes before the assertion on purpose: the dependency only appears from the
  // effect's SECOND run, since `hasProjected` skips the focus call on the first.
  it('does not re-project when only the layout breakpoint changes', () => {
    const restore = stubLiveLayout({ [BELOW_MD_QUERY]: false });
    const shell = build();
    setRouteRoom('!a:hs');
    TestBed.tick();
    setRouteRoom('!b:hs');
    TestBed.tick();
    expect(shell.store.activeRoomId()).toBe('!b:hs');

    const media = TestBed.inject(MediaService);
    vi.mocked(media.releaseAll).mockClear();

    setMediaQuery(BELOW_MD_QUERY, true);
    TestBed.tick();

    expect(media.releaseAll).not.toHaveBeenCalled();
    restore();
  });

  // `releaseOpenRoom` is the teardown half of closing, and the ONLY thing that stops the
  // root-scoped projections following a room nobody is looking at once the page is gone.
  // `closeOpenRoom` cannot do it here: it navigates, and the router is already on its way
  // to wherever the user actually went.
  it('stops the projections when the page is destroyed', () => {
    setRouteRoom('!open:hs');
    const shell = build();
    TestBed.tick();
    expect(timelineOpen).toHaveBeenCalledWith('!open:hs');

    const threads = TestBed.inject(ThreadsService);
    const pinned = TestBed.inject(PinnedMessagesService);
    const media = TestBed.inject(MediaService);
    timelineClose.mockClear();
    // The effect already called releaseAll on the way in, so without this the assertion
    // below could not fail — deleting it from `releaseOpenRoom` left the suite green.
    vi.mocked(media.releaseAll).mockClear();

    shell.page.ngOnDestroy();

    expect(timelineClose).toHaveBeenCalled();
    expect(threads.close).toHaveBeenCalled();
    expect(threads.closeThread).toHaveBeenCalled();
    expect(pinned.close).toHaveBeenCalled();
    expect(media.releaseAll).toHaveBeenCalled();
  });
});
