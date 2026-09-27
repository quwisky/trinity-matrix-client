import { Location } from '@angular/common';
import { provideLocationMocks, SpyLocation } from '@angular/common/testing';
import {
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  withRouterConfig,
  type Routes,
} from '@angular/router';
import {
  WorkspaceBackService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnDialogService } from '@trinity/components/overlay';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  InvitesService,
  RoomLibraryService,
  RoomReadinessService,
  SpacesService,
} from '@trinity/data-access/room-library';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { firstValueFrom, map, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRoutedSurfaceAdapter } from './composition/workspace-routed-surface.adapter';
import { workspaceBrowserBackGuard } from './workspace-browser-back.guard';

/**
 * Browser history outcomes of Back from the compact Conversation, through the real Router
 * (with the application's `computed` cancellation policy) and the real Workspace transition
 * engine. Only the Matrix data boundary, the dialog stack and the viewport are stubbed.
 */
const ALICE = '@alice:example.org';
const ROOM = '!room:example.org';
const LIST_URL = `/rooms?account=${ALICE}&view=rooms`;
const ROOM_URL = `/rooms/${encodeRoomSegment(ROOM)}?account=${ALICE}&view=rooms`;
const ROOM_LIST_PANE_URL = `/rooms/${encodeRoomSegment(ROOM)}?account=${ALICE}&pane=list&view=rooms`;

@Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
class WorkspaceOutletStubComponent {}

const routes: Routes = [
  {
    matcher: (segments) => {
      if (segments[0]?.path !== 'rooms' || segments.length > 2) return null;
      return segments.length === 1
        ? { consumed: segments }
        : { consumed: segments, posParams: { roomId: segments[1] } };
    },
    canActivate: [workspaceBrowserBackGuard],
    canDeactivate: [workspaceBrowserBackGuard],
    runGuardsAndResolvers: 'always',
    component: WorkspaceOutletStubComponent,
  },
];

function harness() {
  // The viewport right now, and the value the page's `mediaQuerySignal` last reported. They
  // differ for up to a frame after a resize, which is the race the hosted flake hit.
  const viewport = { compact: false };
  const reportedCompact = signal(false);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return query === BELOW_MD_QUERY && viewport.compact;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });

  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        routes,
        withRouterConfig({ canceledNavigationResolution: 'computed' }),
      ),
      provideLocationMocks(),
      {
        provide: AccountRuntimeService,
        useValue: {
          activeAccountId: signal(ALICE).asReadonly(),
          switchActiveAccount: vi.fn(),
        },
      },
      {
        provide: RoomLibraryService,
        useValue: {
          selectionAvailability: () => 'available' as const,
          clearMarkedUnread: () => of(void 0),
        },
      },
      {
        provide: ConversationRuntime,
        useValue: { focus: vi.fn(), blur: vi.fn() },
      },
      { provide: MediaPipeline, useValue: { releaseAll: vi.fn() } },
      { provide: SpacesService, useValue: { openSpace: () => of(void 0) } },
      { provide: RoomReadinessService, useValue: {} },
      { provide: InvitesService, useValue: {} },
      {
        provide: TrnDialogService,
        useValue: { hasOpen: () => false, closeTopmost: vi.fn() },
      },
      {
        provide: WorkspaceRoutedSurfaceAdapter,
        useValue: { owns: () => false },
      },
    ],
  });

  const router = TestBed.inject(Router);
  const location = TestBed.inject(Location) as SpyLocation;
  const workspace = TestBed.inject(WorkspaceNavigationService);
  const back = TestBed.inject(WorkspaceBackService);
  // Application Runtime starts the Router this way; it installs the popstate listener.
  router.initialNavigation();

  // The compact Conversation registration exactly as `RoomSurfaceLifecycle` offers it.
  back.register({
    surface: () => {
      const view = workspace.view();
      return reportedCompact() &&
        view.pane === 'conversation' &&
        view.accountId &&
        view.roomId
        ? {
            layer: 'conversation',
            surface: {
              kind: 'conversation',
              accountId: view.accountId,
              roomId: view.roomId,
            },
          }
        : null;
    },
    dismiss: () =>
      workspace
        .navigate({ kind: 'list', origin: 'workspace-back' })
        .pipe(
          map((outcome) =>
            outcome.kind === 'ready' ? 'dismissed' : 'blocked',
          ),
        ),
  });

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) {
      TestBed.tick();
      await TestBed.inject(ApplicationRef).whenStable();
      await new Promise((resolve) => setTimeout(resolve));
    }
  }

  async function arrive(url: string): Promise<void> {
    await router.navigateByUrl(url);
    await settle();
  }

  async function openRoomFromList(): Promise<void> {
    await arrive(LIST_URL);
    await firstValueFrom(
      workspace.navigate({
        kind: 'room',
        accountId: ALICE,
        roomId: ROOM,
        origin: 'room-list',
      }),
    );
    await settle();
    expect(location.path()).toBe(ROOM_URL);
  }

  /** Every history write from now on: pushes as URLs, replacements as `replace: URL`. */
  function writesAfter(action: () => void | Promise<void>) {
    return async () => {
      const before = location.urlChanges.length;
      await action();
      await settle();
      return location.urlChanges.slice(before);
    };
  }

  return {
    back,
    location,
    openRoomFromList,
    arrive,
    reportedCompact,
    settle,
    viewport,
    workspace,
    writesAfter,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('browser Back from the compact Conversation', () => {
  it('(a) from the Room list shows its list pane without rolling the Room URL back', async () => {
    const h = harness();
    h.viewport.compact = true;
    h.reportedCompact.set(true);
    await h.openRoomFromList();

    const writes = await h.writesAfter(() => h.location.back())();

    // One replacement of the entry Back reached. Before the fix the dismissal ran inside the
    // traversal's guard and ended with `replace: ROOM_URL` over that entry.
    expect(writes).toEqual([`replace: ${ROOM_LIST_PANE_URL}`]);
    expect(h.location.path()).toBe(ROOM_LIST_PANE_URL);
    expect(h.workspace.view()).toMatchObject({ roomId: ROOM, pane: 'list' });

    // The history stack is consistent: Forward reopens the Conversation, Back returns to the
    // same list-pane entry.
    h.location.forward();
    await h.settle();
    expect(h.location.path()).toBe(ROOM_URL);
    expect(h.workspace.pane()).toBe('conversation');
    h.location.back();
    await h.settle();
    expect(h.location.path()).toBe(ROOM_LIST_PANE_URL);
    expect(h.workspace.pane()).toBe('list');
  });

  it('(b) opened by link as the first app entry, host Back stays in the app on its list pane', async () => {
    const h = harness();
    h.viewport.compact = true;
    h.reportedCompact.set(true);
    await h.arrive(ROOM_URL);
    expect(h.workspace.pane()).toBe('conversation');

    // There is no earlier app entry for a browser traversal to reach, so a browser Back leaves
    // the document before any app code runs. Android's hardware Back is offered to Workspace
    // first (the host Back handler), outside any Router navigation.
    expect(h.back.hasActive()).toBe(true);
    const writes = await h.writesAfter(async () => {
      await firstValueFrom(h.back.back());
    })();

    expect(writes).toEqual([`replace: ${ROOM_LIST_PANE_URL}`]);
    expect(h.location.path()).toBe(ROOM_LIST_PANE_URL);
    expect(h.workspace.view()).toMatchObject({ roomId: ROOM, pane: 'list' });
  });

  it('(c) racing a narrow-to-wide resize follows browser history to the list', async () => {
    const h = harness();
    h.reportedCompact.set(true);
    await h.openRoomFromList();

    // The viewport is already wide; the page's media-query signal has not caught up yet.
    h.viewport.compact = false;
    const writes = await h.writesAfter(() => h.location.back())();

    expect(writes).toEqual([]);
    expect(h.location.path()).toBe(LIST_URL);
    expect(h.workspace.view()).toMatchObject({ roomId: null, pane: 'list' });
  });
});
