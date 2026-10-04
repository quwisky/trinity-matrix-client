import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import {
  MatrixClientService,
  type SyncState,
} from '@trinity/data-access/matrix-client';
import {
  SelectedRoomLibraryService,
  type SelectedRoomLibraryView,
} from '@trinity/data-access/room-library';
import {
  ConversationRuntime,
  type ConversationHandle,
} from '@trinity/data-access/timeline';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
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
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';
import { ShellStatusService } from './shell-status.service';

describe('AccountRoutingService.openLinkedRoom on a cold start', () => {
  const joined = { id: '!r:hs', accountId: '@me:hs' };
  const view = signal({ rooms: [] } as unknown as SelectedRoomLibraryView);
  const syncState = signal<SyncState | null>(null);
  let navigate: Mock;
  let showError: Mock;
  let transition: Mock;
  let loadEvent: Mock;
  const focused = signal<ConversationHandle | null>(null);
  const focus = (roomId: string | null): void =>
    focused.set(
      roomId
        ? ({ key: { accountId: '@me:hs', roomId } } as ConversationHandle)
        : null,
    );

  function build(): AccountRoutingService {
    navigate = vi.fn(() => of({ kind: 'ready' }));
    showError = vi.fn();
    transition = vi.fn();
    loadEvent = vi.fn(() => of(true));
    TestBed.configureTestingModule({
      providers: [
        AccountRoutingService,
        MockProvider(RoomShellStore, {
          activeRoomId: signal<string | null>(null),
          activeAccountId: signal<string | null>('@me:hs'),
          pane: signal('list') as never,
        }),
        MockProvider(RoomShellViewModel),
        MockProvider(ShellStatusService, { showError }),
        MockProvider(WorkspaceNavigationService, {
          navigate,
          activeAccountId: signal<string | null>('@me:hs'),
        }),
        MockProvider(RoomSurfaceLifecycle, { transition }),
        MockProvider(ConversationRuntime, {
          focused: focused.asReadonly(),
          timeline: { loadEvent } as never,
        }),
        MockProvider(SelectedRoomLibraryService, { view }),
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
});
