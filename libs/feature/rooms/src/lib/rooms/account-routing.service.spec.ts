import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  WorkspaceNavigationService,
  type WorkspacePanel,
} from '@trinity/application/workspace';
import {
  MatrixClientService,
  type SyncState,
} from '@trinity/data-access/matrix-client';
import {
  ROOM_READINESS_TIMEOUT_MS,
  RoomReadinessService,
  SelectedRoomLibraryService,
  type SelectedRoomLibraryView,
} from '@trinity/data-access/room-library';
import {
  ConversationRuntime,
  type ConversationHandle,
} from '@trinity/data-access/timeline';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, of, throwError } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { AccountRoutingService } from './account-routing.service';
import { RoomShellStore } from './room-shell-store';
import { RoomShellViewModel } from './room-shell-view-model';
import {
  RoomSurfaceLifecycle,
  type RenderedRoomSurface,
} from './room-surface-lifecycle';
import { ShellStatusService } from './shell-status.service';

describe('AccountRoutingService.openLinkedRoom on a cold start', () => {
  const joined = { id: '!r:hs', accountId: '@me:hs' };
  const view = signal({ rooms: [] } as unknown as SelectedRoomLibraryView);
  const syncState = signal<SyncState | null>(null);
  let navigate: Mock;
  let listsShowing: Mock;
  let showError: Mock;
  let transition: Mock;
  let loadEvent: Mock;
  let joinSynced: Subject<void>;
  let waitForRoom: Mock;
  const focused = signal<ConversationHandle | null>(null);
  const eventTarget = signal<{ readonly eventId: string } | null>(null);
  const activeRoomId = signal<string | null>(null);
  const loaded = signal<{ readonly id: string }[]>([]);
  const loadState = signal<{ readonly kind: string }>({ kind: 'ready' });
  const focus = (roomId: string | null): void =>
    focused.set(
      roomId
        ? ({ key: { accountId: '@me:hs', roomId } } as ConversationHandle)
        : null,
    );

  function build(): AccountRoutingService {
    navigate = vi.fn(() => of({ kind: 'ready' }));
    listsShowing = vi.fn(() => [{ kind: 'recent' }, { kind: 'home' }]);
    showError = vi.fn();
    transition = vi.fn();
    loadEvent = vi.fn(() => of(true));
    joinSynced = new Subject<void>();
    waitForRoom = vi.fn(() => joinSynced);
    TestBed.configureTestingModule({
      providers: [
        AccountRoutingService,
        MockProvider(RoomShellStore, {
          activeRoomId: activeRoomId.asReadonly(),
          activeAccountId: signal<string | null>('@me:hs'),
          pane: signal('list') as never,
        }),
        MockProvider(RoomShellViewModel, { listsShowing }),
        MockProvider(ShellStatusService, { showError }),
        MockProvider(WorkspaceNavigationService, {
          navigate,
          activeAccountId: signal<string | null>('@me:hs'),
          eventTarget: eventTarget.asReadonly(),
          panel: signal(null),
        }),
        MockProvider(RoomSurfaceLifecycle, {
          transition,
          renderedSurface: signal(null),
        }),
        MockProvider(ConversationRuntime, {
          focused: focused.asReadonly(),
          timeline: {
            loadEvent,
            messages: loaded.asReadonly(),
            loadState: loadState.asReadonly(),
          } as never,
        }),
        MockProvider(SelectedRoomLibraryService, { view }),
        MockProvider(RoomReadinessService, { waitForRoom }),
        MockProvider(MatrixClientService, { syncState }),
      ],
    });
    return TestBed.inject(AccountRoutingService);
  }

  function sync(rooms: unknown[], state: SyncState | null): void {
    view.set({ rooms } as unknown as SelectedRoomLibraryView);
    syncState.set(state);
    TestBed.tick();
  }

  beforeEach(() => {
    view.set({ rooms: [] } as unknown as SelectedRoomLibraryView);
    syncState.set(null);
    eventTarget.set(null);
    loaded.set([]);
    loadState.set({ kind: 'ready' });
    activeRoomId.set(joined.id);
    focus(joined.id);
  });
  afterEach(() => vi.useRealTimers());

  it('waits for the first sync, then opens a joined room exactly once', () => {
    const routing = build();

    routing.openLinkedRoom(joined.id, '$e', 'deep-link');
    TestBed.tick();
    expect(showError).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    sync([joined], 'PREPARED' as SyncState);
    sync([joined], 'SYNCING' as SyncState);

    expect(showError).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'room', roomId: joined.id }),
    );
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$e',
    });
  });

  it('still reports a room that is not joined once the first sync is done', () => {
    const routing = build();

    routing.openLinkedRoom('!other:hs', '$e', 'deep-link');
    sync([joined], 'PREPARED' as SyncState); // the cached sync: the room may be newly joined
    expect(showError).not.toHaveBeenCalled();
    sync([joined], 'SYNCING' as SyncState);

    expect(showError).toHaveBeenCalledExactlyOnceWith(
      "You're not in that room.",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens immediately when the first sync is already done', () => {
    const routing = build();
    sync([joined], 'SYNCING' as SyncState);

    routing.openLinkedRoom(joined.id, '$e');

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('reports a link that is still waiting when the sync never completes', () => {
    vi.useFakeTimers();
    const routing = build();

    routing.openLinkedRoom(joined.id, '$e', 'deep-link');
    TestBed.tick();
    vi.advanceTimersByTime(15_000);

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalledWith("You're not in that room.");
    expect(navigate).not.toHaveBeenCalled();
  });

  it('pages the event in before revealing it, since a cold start loads only the newest messages', () => {
    const routing = build();
    sync([joined], 'SYNCING' as SyncState);
    const loaded = new Subject<boolean>();
    loadEvent.mockReturnValue(loaded);

    routing.openLinkedRoom(joined.id, '$old', 'deep-link');

    expect(loadEvent).toHaveBeenCalledWith('$old');
    expect(transition).not.toHaveBeenCalled();
    loaded.next(true);
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$old',
    });
  });

  it('says so when the linked event cannot be loaded', () => {
    const routing = build();
    sync([joined], 'SYNCING' as SyncState);
    loadEvent.mockReturnValue(of(false));

    routing.openLinkedRoom(joined.id, '$gone', 'deep-link');

    expect(transition).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledExactlyOnceWith(
      'Could not load that message.',
    );
  });

  it('pages the event in only after a live sync, since a gappy one replaces the cached timeline', () => {
    const routing = build();
    // The SDK reports PREPARED for the sync it restores from its cache, before any request.
    sync([joined], 'PREPARED' as SyncState);

    routing.openLinkedRoom(joined.id, '$old', 'deep-link');
    TestBed.tick();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(loadEvent).not.toHaveBeenCalled();

    sync([joined], 'SYNCING' as SyncState);
    expect(loadEvent).toHaveBeenCalledExactlyOnceWith('$old');
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$old',
    });
  });

  it('waits for the room to be the focused conversation before paging its history', () => {
    const routing = build();
    sync([joined], 'SYNCING' as SyncState);
    focus('!previous:hs'); // navigation is ready, but the old room still holds the focus

    routing.openLinkedRoom(joined.id, '$old', 'deep-link');
    TestBed.tick();
    expect(loadEvent).not.toHaveBeenCalled();

    focus(joined.id);
    TestBed.tick();
    expect(loadEvent).toHaveBeenCalledExactlyOnceWith('$old');
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$old',
    });
  });

  it('pages in and reveals a ?event= target once the linked room is ready', () => {
    build();
    sync([], 'PREPARED' as SyncState); // the room has not synced yet
    const loaded = new Subject<boolean>();
    loadEvent.mockReturnValue(loaded);
    focus(null);

    eventTarget.set({ eventId: '$old' });
    TestBed.tick();
    expect(loadEvent).not.toHaveBeenCalled();

    sync([joined], 'SYNCING' as SyncState);
    focus(joined.id);
    TestBed.tick();
    expect(loadEvent).toHaveBeenCalledExactlyOnceWith('$old');
    expect(transition).not.toHaveBeenCalled();
    loaded.next(true);
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$old',
    });
  });

  it('never applies a ?event= target that was superseded before its room arrived', () => {
    build();
    focus(null);
    eventTarget.set({ eventId: '$old' });
    TestBed.tick();

    eventTarget.set(null); // the user navigated elsewhere
    sync([joined], 'SYNCING' as SyncState);
    focus(joined.id);
    TestBed.tick();

    expect(loadEvent).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('reveals an event already in the loaded timeline without waiting for a live sync', () => {
    build();
    sync([joined], 'RECONNECTING' as SyncState);
    loaded.set([{ id: '$here' }]);

    eventTarget.set({ eventId: '$here' });
    TestBed.tick();

    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$here',
    });
    expect(loadEvent).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('waits silently while the linked room is unavailable, then reveals the event once it opens', () => {
    build();
    sync([], 'SYNCING' as SyncState);
    loadState.set({ kind: 'error' });

    eventTarget.set({ eventId: '$old' });
    TestBed.tick();
    expect(loadEvent).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();

    loadState.set({ kind: 'ready' }); // the room arrived through the recovery listener
    TestBed.tick();
    expect(loadEvent).toHaveBeenCalledExactlyOnceWith('$old');
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$old',
    });
  });

  it('starts the anchor timeout when the room is ready, not at navigation', () => {
    vi.useFakeTimers();
    build();
    loadState.set({ kind: 'loading' });
    eventTarget.set({ eventId: '$old' });
    TestBed.tick();

    vi.advanceTimersByTime(20_000); // a slow first sync
    expect(showError).not.toHaveBeenCalled();

    sync([joined], 'SYNCING' as SyncState);
    loadState.set({ kind: 'ready' });
    TestBed.tick();
    expect(loadEvent).toHaveBeenCalledExactlyOnceWith('$old');
    expect(transition).toHaveBeenCalledOnce();
  });

  it('still says so when the event does not load within the timeout once the room is ready', () => {
    vi.useFakeTimers();
    build();
    sync([joined], 'SYNCING' as SyncState);
    loadEvent.mockReturnValue(new Subject<boolean>());
    eventTarget.set({ eventId: '$old' });
    TestBed.tick();

    vi.advanceTimersByTime(15_000);
    expect(showError).toHaveBeenCalledExactlyOnceWith(
      'Could not load that message.',
    );
  });

  it('drops a linked-message reveal when the user navigates to another room first', () => {
    vi.useFakeTimers();
    const routing = build();
    sync([joined], 'PREPARED' as SyncState); // cache only: the reveal waits

    routing.openLinkedRoom(joined.id, '$old', 'deep-link');
    TestBed.tick();
    activeRoomId.set('!elsewhere:hs');
    focus('!elsewhere:hs');
    TestBed.tick();

    vi.advanceTimersByTime(20_000);
    activeRoomId.set(joined.id);
    focus(joined.id);
    sync([joined], 'SYNCING' as SyncState);
    expect(loadEvent).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('hands a rail entry its ready callback only once Workspace has opened the room', () => {
    const routing = build();
    const onReady = vi.fn();
    const chat = { accountId: '@me:hs', roomId: '!c:hs' };

    routing.onSelectRoomSelection(chat, 'rail-unread', onReady);

    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      kind: 'room',
      ...chat,
      origin: 'rail-unread',
      listedIn: [{ kind: 'recent' }, { kind: 'home' }],
    });
    expect(listsShowing).toHaveBeenCalledWith(chat);
    expect(onReady).toHaveBeenCalledOnce();

    navigate.mockReturnValueOnce(
      of({ kind: 'unavailable', reason: 'navigation-rejected' }),
    );
    routing.onSelectRoomSelection(chat, 'rail-unread', onReady);

    expect(onReady).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledOnce();
  });

  it('names the lists that show a rail chat, and leaves other opens without that hint', () => {
    const routing = build();
    const chat = { accountId: '@me:hs', roomId: '!c:hs' };

    routing.onSelectRoomSelection(chat, 'room-list');
    routing.onSelectRoomSelection(chat, 'room-invitation');

    expect(listsShowing).not.toHaveBeenCalled();
    for (const [intent] of navigate.mock.calls) {
      expect(intent).not.toHaveProperty('listedIn');
    }
  });

  // A join or an accepted invitation keeps the earlier membership until `/sync` brings it,
  // and Workspace keeps only a joined space: re-joining a space left this session would
  // otherwise land in Recent.
  it('waits for a confirmed space join to sync before selecting the space', () => {
    const routing = build();

    routing.openConfirmedLinkedRoom({
      kind: 'space',
      roomId: '!s:hs',
      accountId: '@me:hs',
    });

    expect(waitForRoom).toHaveBeenCalledWith('@me:hs', '!s:hs');
    expect(navigate).not.toHaveBeenCalled();
    joinSynced.next();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      kind: 'scope',
      accountId: '@me:hs',
      scope: { kind: 'space', spaceId: '!s:hs' },
    });
  });

  it('reports a confirmed space whose join never syncs', () => {
    const routing = build();

    routing.openConfirmedLinkedRoom({
      kind: 'space',
      roomId: '!s:hs',
      accountId: '@me:hs',
    });
    joinSynced.error(new Error('timed out'));

    expect(navigate).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      'Joined, but the space is not ready yet.',
    );
  });
});

describe('AccountRoutingService.openInboxRow', () => {
  afterEach(() => vi.useRealTimers());

  const row = {
    accountId: '@me:hs',
    roomId: '!r:hs',
    eventId: '$e',
    threadRootId: null,
  };
  const listedRoom = {
    id: '!r:hs',
    accountId: '@me:hs',
    accountIds: ['@me:hs'],
  };

  function build(
    options: {
      readonly activeRoomId?: string | null;
      readonly activeAccountId?: string;
      readonly pane?: 'list' | 'conversation';
      readonly rooms?: readonly unknown[];
      readonly syncState?: string;
      readonly focused?: string | null;
      readonly loaded?: readonly string[];
      readonly loadEvent?: Mock;
      readonly loadRoot?: Mock;
      readonly panel?: WorkspacePanel;
    } = {},
  ) {
    const activeAccountId = options.activeAccountId ?? '@me:hs';
    const activeRoomId = options.activeRoomId ?? null;
    const roomId = signal<string | null>(activeRoomId);
    const panel = signal<WorkspacePanel | null>(options.panel ?? null);
    const shown = signal<RenderedRoomSurface | null>(null);
    const loadState = signal<{
      readonly kind: string;
      readonly reason?: string;
    }>({ kind: 'ready' });
    const navigate: Mock = vi.fn((intent: { readonly roomId: string }) => {
      roomId.set(intent.roomId);
      return of({ kind: 'ready' });
    });
    const showError = vi.fn();
    const transition = vi.fn();
    const loadEvent = options.loadEvent ?? vi.fn(() => of(true));
    const loadRoot = options.loadRoot ?? vi.fn(() => of(true));
    const syncState = signal((options.syncState ?? 'SYNCING') as SyncState);
    const focused = signal(
      options.focused === null
        ? null
        : ({
            key: {
              accountId: row.accountId,
              roomId: options.focused ?? row.roomId,
            },
          } as ConversationHandle),
    );
    TestBed.configureTestingModule({
      providers: [
        AccountRoutingService,
        MockProvider(RoomShellStore, {
          activeRoomId: roomId.asReadonly(),
          activeAccountId: signal<string | null>(activeAccountId),
          pane: signal(options.pane ?? 'conversation') as never,
        }),
        MockProvider(RoomShellViewModel),
        MockProvider(ShellStatusService, { showError }),
        MockProvider(WorkspaceNavigationService, {
          navigate,
          activeAccountId: signal<string | null>(activeAccountId),
          eventTarget: signal(null),
          panel: panel.asReadonly(),
        }),
        MockProvider(RoomSurfaceLifecycle, {
          transition,
          renderedSurface: shown.asReadonly(),
        }),
        MockProvider(ConversationRuntime, {
          focused,
          threads: { loadRoot } as never,
          timeline: {
            loadEvent,
            messages: signal(
              (options.loaded ?? []).map((id) => ({ id })),
            ).asReadonly(),
            loadState: loadState.asReadonly(),
          } as never,
        }),
        MockProvider(SelectedRoomLibraryService, {
          view: signal({
            rooms: options.rooms ?? [listedRoom],
          } as unknown as SelectedRoomLibraryView),
        }),
        MockProvider(RoomReadinessService),
        MockProvider(MatrixClientService, {
          syncState,
        }),
      ],
    });
    return {
      routing: TestBed.inject(AccountRoutingService),
      navigate,
      showError,
      transition,
      loadEvent,
      loadRoot,
      roomId,
      syncState,
      focused,
      shown,
      loadState,
    };
  }

  it('opens the room and reveals the event, keeping the inbox scope', () => {
    const { routing, navigate, transition } = build({ pane: 'list' });

    routing.openInboxRow(row);

    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      kind: 'room',
      accountId: '@me:hs',
      roomId: '!r:hs',
      origin: 'room-list',
    });
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$e',
    });
  });

  it('reveals at once when that room is already open', () => {
    const { routing, navigate, transition, loadEvent } = build({
      activeRoomId: '!r:hs',
      loaded: ['$e'],
    });

    routing.openInboxRow(row);

    expect(navigate).not.toHaveBeenCalled();
    expect(loadEvent).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$e',
    });
  });

  it("moves from the room open beside the inbox to the row's room", () => {
    const { routing, navigate } = build({ activeRoomId: '!other:hs' });

    routing.openInboxRow(row);

    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'room', roomId: '!r:hs' }),
    );
  });

  it('reopens a remembered room on the phone, whose pane is the list', () => {
    const { routing, navigate } = build({
      activeRoomId: '!r:hs',
      pane: 'list',
    });

    routing.openInboxRow(row);

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('never switches account in the mixed view', () => {
    const shared = {
      id: '!r:hs',
      accountId: '@other:hs',
      accountIds: ['@other:hs', '@me:hs'],
    };
    const { routing, navigate } = build({
      activeRoomId: '!r:hs',
      activeAccountId: '@other:hs',
      rooms: [shared],
      focused: null,
    });

    routing.openInboxRow(row);

    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accountId: '@me:hs', roomId: '!r:hs' }),
    );
  });

  it('opens a thread message in its thread, and scrolls to it', () => {
    const { routing, navigate, transition } = build({ pane: 'list' });

    routing.openInboxRow({ ...row, threadRootId: '$root' });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$e',
    });
  });

  it('opens the thread alone when its room is already open', () => {
    const { routing, navigate, transition } = build({
      activeRoomId: '!r:hs',
    });

    routing.openInboxRow({ ...row, threadRootId: '$root' });

    expect(navigate).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$e',
    });
  });

  it('never pages the room for a thread root, which it may not hold however long it pages', () => {
    const { routing, loadEvent, loadRoot } = build({ activeRoomId: '!r:hs' });

    routing.openInboxRow({ ...row, threadRootId: '$root' });

    expect(loadEvent).not.toHaveBeenCalled();
    expect(loadRoot).toHaveBeenCalledExactlyOnceWith('$root');
  });

  it('opens the thread once its root has loaded', () => {
    const page = new Subject<boolean>();
    const { routing, transition } = build({
      activeRoomId: '!r:hs',
      loadRoot: vi.fn(() => page),
    });

    routing.openInboxRow({ ...row, threadRootId: '$root' });
    expect(transition).not.toHaveBeenCalled();

    page.next(true);

    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$e',
    });
  });

  it('opens a thread the URL names once the Room is focused and its root loads', () => {
    const page = new Subject<boolean>();
    const { transition, loadRoot, focused, shown } = build({
      activeRoomId: '!r:hs',
      focused: null,
      panel: { kind: 'thread', root: '$root' },
      loadRoot: vi.fn(() => page),
    });
    TestBed.tick();
    expect(loadRoot).not.toHaveBeenCalled();

    focused.set({
      key: { accountId: row.accountId, roomId: row.roomId },
    } as ConversationHandle);
    TestBed.tick();
    expect(loadRoot).toHaveBeenCalledExactlyOnceWith('$root');
    page.next(true);

    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'open-thread',
      rootEventId: '$root',
    });
    shown.set({ kind: 'thread', rootEventId: '$root' });
    TestBed.tick();
    expect(loadRoot).toHaveBeenCalledTimes(1);
  });

  it('closes a thread the URL names whose root will not load, without an error', () => {
    const { transition, showError } = build({
      activeRoomId: '!r:hs',
      panel: { kind: 'thread', root: '$gone' },
      loadRoot: vi.fn(() => of(false)),
    });
    TestBed.tick();

    expect(transition).toHaveBeenCalledExactlyOnceWith({ kind: 'clear' });
    expect(showError).not.toHaveBeenCalled();
  });

  it('closes a thread the URL names in a Room this Account cannot open', () => {
    const { transition, loadRoot, loadState, showError } = build({
      activeRoomId: '!r:hs',
      focused: null,
      panel: { kind: 'thread', root: '$root' },
    });
    TestBed.tick();
    expect(transition).not.toHaveBeenCalled();

    loadState.set({ kind: 'error', reason: 'room-unavailable' });
    TestBed.tick();

    expect(transition).toHaveBeenCalledExactlyOnceWith({ kind: 'clear' });
    expect(loadRoot).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('closes a thread the URL names whose root fetch fails or never answers', () => {
    vi.useFakeTimers();
    const { transition, showError } = build({
      activeRoomId: '!r:hs',
      panel: { kind: 'thread', root: '$slow' },
      loadRoot: vi.fn(() => NEVER),
    });
    TestBed.tick();
    vi.advanceTimersByTime(ROOM_READINESS_TIMEOUT_MS);

    expect(transition).toHaveBeenCalledExactlyOnceWith({ kind: 'clear' });
    expect(showError).not.toHaveBeenCalled();
  });

  it('waits for focus before loading the root', () => {
    const { routing, loadRoot, focused } = build({
      activeRoomId: '!r:hs',
      focused: null,
    });

    routing.openInboxRow({ ...row, threadRootId: '$root' });
    TestBed.tick();
    expect(loadRoot).not.toHaveBeenCalled();

    focused.set({
      key: { accountId: row.accountId, roomId: row.roomId },
    } as ConversationHandle);
    TestBed.tick();

    expect(loadRoot).toHaveBeenCalledTimes(1);
  });

  it('opens a thread offline when its root needs no fetch', () => {
    const { routing, transition, showError } = build({
      activeRoomId: '!r:hs',
      syncState: 'RECONNECTING',
    });

    routing.openInboxRow({ ...row, threadRootId: '$root' });

    expect(showError).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'open-thread',
      rootEventId: '$root',
      revealEventId: '$e',
    });
  });

  it('says so offline when a fetch for the root fails', () => {
    const { routing, transition, showError } = build({
      activeRoomId: '!r:hs',
      syncState: 'RECONNECTING',
      loadRoot: vi.fn(() => of(false)),
    });

    routing.openInboxRow({ ...row, threadRootId: '$root' });

    expect(transition).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledExactlyOnceWith(
      'Could not load that message.',
    );
  });

  it('says so offline within the limit when a fetch for the root never answers', () => {
    vi.useFakeTimers();
    const { routing, transition, showError } = build({
      activeRoomId: '!r:hs',
      syncState: 'RECONNECTING',
      loadRoot: vi.fn(() => NEVER),
    });

    routing.openInboxRow({ ...row, threadRootId: '$root' });
    vi.advanceTimersByTime(ROOM_READINESS_TIMEOUT_MS - 1);
    expect(showError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(transition).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledExactlyOnceWith(
      'Could not load that message.',
    );
  });

  it('still waits for a live sync before paging for an event', () => {
    const { routing, loadEvent, syncState } = build({
      activeRoomId: '!r:hs',
      syncState: 'RECONNECTING',
    });

    routing.openInboxRow(row);
    TestBed.tick();
    expect(loadEvent).not.toHaveBeenCalled();

    syncState.set('SYNCING' as SyncState);
    TestBed.tick();

    expect(loadEvent).toHaveBeenCalledExactlyOnceWith('$e');
  });

  it.each([
    ['cannot be fetched', () => of(false)],
    ['fails', () => throwError(() => new Error('down'))],
  ])(
    'says it could not load a thread whose root %s, opening no panel',
    (_name, answer) => {
      const { routing, transition, showError } = build({
        activeRoomId: '!r:hs',
        loadRoot: vi.fn(answer),
      });

      routing.openInboxRow({ ...row, threadRootId: '$root' });

      expect(transition).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledExactlyOnceWith(
        'Could not load that message.',
      );
    },
  );

  it('says it could not load an event the room cannot page to', () => {
    const { routing, transition, showError, navigate } = build({
      pane: 'list',
      loadEvent: vi.fn(() => of(false)),
    });

    routing.openInboxRow(row);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(transition).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledExactlyOnceWith(
      'Could not load that message.',
    );
  });

  it('reveals a thread root in the timeline, not the panel', () => {
    const { routing, transition } = build({
      activeRoomId: '!r:hs',
      loaded: ['$root'],
    });

    routing.openInboxRow({ ...row, eventId: '$root', threadRootId: null });

    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$root',
    });
  });

  it('says "You\'re not in that room." for a room left since loading', () => {
    const { routing, navigate, showError, transition } = build({ rooms: [] });

    routing.openInboxRow(row);

    expect(showError).toHaveBeenCalledExactlyOnceWith(
      "You're not in that room.",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("doesn't take another account's membership of a shared room as this account's", () => {
    const { routing, navigate, showError } = build({
      rooms: [
        { id: '!r:hs', accountId: '@other:hs', accountIds: ['@other:hs'] },
      ],
    });

    routing.openInboxRow(row);

    expect(showError).toHaveBeenCalledExactlyOnceWith(
      "You're not in that room.",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("doesn't claim the room was left before the room list is known", () => {
    const { routing, navigate, showError } = build({
      rooms: [],
      syncState: 'PREPARED',
    });

    routing.openInboxRow(row);

    expect(showError).toHaveBeenCalledExactlyOnceWith(
      'Could not open that room yet. Try again once Trinity has connected.',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reveals once for a double tap, still paging the event in', () => {
    const page = new Subject<boolean>();
    const { routing, transition } = build({
      activeRoomId: '!r:hs',
      loadEvent: vi.fn(() => page),
    });

    routing.openInboxRow(row);
    routing.openInboxRow(row);
    page.next(true);

    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('keeps the later of two rows tapped while their room is opening', () => {
    const opened = new Subject<{ kind: 'ready' }>();
    const page = new Subject<boolean>();
    const { routing, transition, navigate, loadEvent } = build({
      activeRoomId: '!r:hs',
      pane: 'list',
      loadEvent: vi.fn(() => page),
    });
    navigate.mockReturnValue(opened as never);

    routing.openInboxRow(row);
    routing.openInboxRow({ ...row, eventId: '$later' });
    opened.next({ kind: 'ready' });
    page.next(true);

    expect(loadEvent).toHaveBeenLastCalledWith('$later');
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$later',
    });
  });

  it('drops a running reveal when another row opens', () => {
    const first = new Subject<boolean>();
    const second = new Subject<boolean>();
    const { routing, transition, showError } = build({
      activeRoomId: '!r:hs',
      loadEvent: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    });

    routing.openInboxRow(row);
    routing.openInboxRow({ ...row, eventId: '$later' });

    expect(first.observed).toBe(false);
    second.next(true);
    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$later',
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('keeps a running reveal when the next row turns out to be left', () => {
    const page = new Subject<boolean>();
    const { routing, transition } = build({
      activeRoomId: '!r:hs',
      loadEvent: vi.fn(() => page),
    });

    routing.openInboxRow(row);
    routing.openInboxRow({ ...row, roomId: '!left:hs' });
    page.next(true);

    expect(transition).toHaveBeenCalledExactlyOnceWith({
      kind: 'reveal-message',
      eventId: '$e',
    });
  });

  it.each([
    ['found', (page: Subject<boolean>) => page.next(true)],
    ['out of reach', (page: Subject<boolean>) => page.next(false)],
    ['failing', (page: Subject<boolean>) => page.error(new Error('down'))],
  ])('ignores a page %s after the person left that room', (_name, land) => {
    const page = new Subject<boolean>();
    const { routing, transition, showError, roomId } = build({
      activeRoomId: '!r:hs',
      loadRoot: vi.fn(() => page),
    });

    routing.openInboxRow({ ...row, threadRootId: '$root' });
    roomId.set('!elsewhere:hs');
    land(page);

    expect(transition).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('says it could not load a message whose page fails', () => {
    const { routing, showError } = build({
      activeRoomId: '!r:hs',
      loadEvent: vi.fn(() => throwError(() => new Error('down'))),
    });

    routing.openInboxRow(row);

    expect(showError).toHaveBeenCalledExactlyOnceWith(
      'Could not load that message.',
    );
  });
});
