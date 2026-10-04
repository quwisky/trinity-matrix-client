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
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
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

  function build(): AccountRoutingService {
    navigate = vi.fn(() => of({ kind: 'ready' }));
    showError = vi.fn();
    transition = vi.fn();
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
    sync([joined], 'PREPARED' as SyncState);

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
});
