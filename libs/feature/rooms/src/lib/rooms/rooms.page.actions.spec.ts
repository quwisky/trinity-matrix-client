import { RoomModerationService } from '@trinity/data-access/room-administration';
import {
  SHARED_MOCKS,
  RoomsTimelineStub,
  UNREAD_AGGREGATOR_PROVIDER,
  matrixClientProvider,
  sessionStateProvider,
  invitesProvider,
  selectedRoomLibraryProvider,
  setRouteRoom,
  settleWorkspace,
  shellFrom,
  stubNarrowLayout,
} from './rooms-page.spec-harness';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  InboundRoomLinkService,
  WorkspaceApplicationSurfaceService,
} from '@trinity/application/workspace';
import {
  AccountRuntimeService,
  type AccountSwitchCoordination,
} from '@trinity/data-access/accounts';
import {
  ACCOUNT_REMOVAL_LAUNCHER,
  KeyboardShortcutsService,
  type AccountRemovalOutcome,
} from '@trinity/platform-native';
import { ShellStatusService } from './shell-status.service';
import {
  InviteBlockedError,
  type PendingInvite,
} from '@trinity/data-access/room-library';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  RoomLibraryService,
  RoomReadinessService,
  SpaceContentsService,
  SpacesService,
  type RoomSummary,
  type SpaceChildRoom,
  type SpaceSummary,
} from '@trinity/data-access/room-library';
import { TimelineActionsService } from '@trinity/data-access/timeline';
import {
  TrnAlertService,
  TrnSurfaceService,
  TrnToastService,
  type TrnActionSheetRef,
} from '@trinity/components/overlay';
import { MockProvider } from 'ng-mocks';
import { defer, finalize, map, of, Subject, tap, throwError } from 'rxjs';
import { matrixError } from '@trinity/testing';
import {
  SessionLockService,
  type SessionLockState,
} from '@trinity/platform-native';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { AppLockService } from '@trinity/data-access/app-lock';
import { UserPickerService } from '../user-picker/user-picker.service';
import { InviteHistoryNoteService } from '../shared/invite-history-note';
import { UserCardComponent } from '../user-card/user-card.component';
import { MemberInfoComponent } from '../member-info/member-info.component';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { RoomLinkPreviewComponent } from '../room-link-preview/room-link-preview.component';
import {
  pendingInvite,
  roomSummary,
  spaceSummary,
} from '../testing/room-summary.fixture';

// The open room lives in the URL, and the harness's route is module state that outlives a
// single TestBed — so a room one test opens is still in the URL when the next one builds.
// Start every test on a bare `/rooms`, the way a fresh load of the shell arrives.
beforeEach(() => setRouteRoom(null));

// Create-space / create-channel / leave-space: the page prompts via TrnAlertService
// and delegates to SpacesService, handling the success navigation + error state.
const HISTORY_NOTE = { text: "They'll be able to read earlier messages." };

describe('RoomsPage space actions', () => {
  let alertPrompt: Mock;
  let alertConfirm: Mock;
  let accountRemoval: Mock;
  let createSpace: Mock;
  let createRoomInSpace: Mock;
  let leaveSpace: Mock;
  let waitForRoom: Mock;
  /** Whether @me still holds '!s:hs', as its client says; a sync can drop it. */
  let spaceHeld: WritableSignal<boolean>;
  /** SpacesService's mark for a leave this app started that has not settled yet. */
  let leaving: WritableSignal<boolean>;

  function build(
    activeUserId: string | null = '@me:hs',
    accountIds: readonly string[] = ['@me:hs'],
  ) {
    const activeAccountId = signal<string | null>(activeUserId);
    const lockState = signal<SessionLockState>('held');
    alertPrompt = vi.fn(() => of(null));
    alertConfirm = vi.fn(() => of(false));
    accountRemoval = vi.fn(() => of<AccountRemovalOutcome>({ kind: 'kept' }));
    createSpace = vi.fn(() => of('!new:hs'));
    createRoomInSpace = vi.fn(() =>
      of({
        kind: 'linked' as const,
        item: { id: '!room:hs', name: 'general', kind: 'room' as const },
      }),
    );
    leaveSpace = vi.fn(() => of(undefined));
    waitForRoom = vi.fn(() => of(void 0));
    spaceHeld = signal(true);
    leaving = signal(false);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        {
          provide: ACCOUNT_REMOVAL_LAUNCHER,
          useValue: { remove: accountRemoval },
        },
        // The Account holds every space these actions open, as `selectionAvailability` says.
        selectedRoomLibraryProvider(),
        MockProvider(RoomLibraryService, {
          selectionAvailability: (_accountId: string, roomId: string) =>
            roomId === '!s:hs' && !spaceHeld() ? 'unavailable' : 'available',
          clearMarkedUnread: () => of(void 0),
          // ng-mocks >= 14.18 no longer stubs signal fields; the selected-library
          // projection reads this one.
          rooms: signal<RoomSummary[]>([]),
        }),
        MockProvider(RoomReadinessService, { waitForRoom }),
        MockProvider(SpacesService, {
          openSpace: () => of(void 0),
          spaces: signal<SpaceSummary[]>([
            spaceSummary({
              id: '!s:hs',
              accountId: '@me:hs',
              name: 'My Space',
              initial: 'M',
            }),
          ]),
          createSpace,
          leaveSpace,
          isLeaving: () => leaving(),
        }),
        MockProvider(SpaceContentsService, { create: createRoomInSpace }),
        MockProvider(TimelineActionsService),
        matrixClientProvider({
          activeUserId: activeAccountId.asReadonly(),
          accountIds,
        }),
        sessionStateProvider({
          activeAccountId: activeAccountId.asReadonly(),
          accountIds,
          syncState: 'syncing',
        }),
        UNREAD_AGGREGATOR_PROVIDER,
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(AccountRuntimeService, {
          activeAccountId: activeAccountId.asReadonly(),
          signOutAccount: vi.fn((accountId: string) =>
            of({
              kind: 'ready' as const,
              accountId,
              activeAccountId:
                accountIds.length > 1 ? (accountIds[1] ?? null) : null,
              remainingAccountIds: accountIds.filter((id) => id !== accountId),
            }),
          ),
          switchActiveAccount: vi.fn(
            (accountId: string, coordination: AccountSwitchCoordination) =>
              defer(coordination.prepare).pipe(
                tap(() => {
                  coordination.onCommitStarted?.();
                  activeAccountId.set(accountId);
                }),
                map(() => ({
                  kind: 'ready' as const,
                  accountId,
                })),
              ),
          ),
        }),
        MockProvider(TrnSurfaceService),
        MockProvider(TrnAlertService, {
          confirm$: alertConfirm,
          prompt$: alertPrompt,
        }),
        MockProvider(TrnToastService),
        MockProvider(SessionLockService, { state: lockState.asReadonly() }),
      ],
    });
    return { ...shellFrom(), activeAccountId, lockState };
  }

  it('creates a space and selects it on success', async () => {
    const shell = build();
    alertPrompt.mockReturnValue(of('My Space'));

    shell.spaces.onCreateSpace();

    expect(createSpace).toHaveBeenCalledWith('@me:hs', {
      name: 'My Space',
    });
    await vi.waitFor(() => expect(shell.store.activeSpaceId()).toBe('!new:hs'));
  });

  it('gives the space name prompt an accessible name, not only a placeholder', () => {
    const shell = build();
    alertPrompt.mockReturnValue(of(null));

    shell.spaces.onCreateSpace();

    expect(alertPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ inputLabel: 'Space name' }),
    );
  });

  it('waits for a created space to enter the Account SDK graph before selecting it', async () => {
    const shell = build();
    const ready = new Subject<void>();
    waitForRoom.mockReturnValue(ready);
    alertPrompt.mockReturnValue(of('My Space'));

    shell.spaces.onCreateSpace();

    expect(waitForRoom).toHaveBeenCalledWith('@me:hs', '!new:hs');
    expect(shell.store.activeSpaceId()).toBeNull();

    ready.next();
    ready.complete();
    await settleWorkspace();

    expect(shell.store.activeSpaceId()).toBe('!new:hs');
  });

  it('does not create a space for an empty name', async () => {
    const shell = build();
    alertPrompt.mockReturnValue(of('   '));

    shell.spaces.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('does not create a space when the prompt is cancelled', async () => {
    const shell = build();
    alertPrompt.mockReturnValue(of(null));

    shell.spaces.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('surfaces a create-space failure in spaceError', async () => {
    const shell = build();
    alertPrompt.mockReturnValue(of('My Space'));
    createSpace.mockReturnValue(throwError(() => new Error('boom')));

    shell.spaces.onCreateSpace();

    expect(shell.status.error()).toBe('boom');
    expect(shell.store.activeSpaceId()).toBeNull(); // not selected on failure
  });

  it('creates a channel in the active space', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    await settleWorkspace();
    alertPrompt.mockReturnValue(of('general'));

    shell.spaces.onCreateChannel();

    expect(createRoomInSpace).toHaveBeenCalledWith(
      { accountId: '@me:hs', spaceId: '!s:hs' },
      'room',
      'general',
    );
  });

  it('does not prompt to create a channel on Home (no active space)', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: null, accountId: '@me:hs' });

    shell.spaces.onCreateChannel();

    expect(alertPrompt).not.toHaveBeenCalled();
    expect(createRoomInSpace).not.toHaveBeenCalled();
  });

  it('leaves the active space and returns to Home on success', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    await settleWorkspace();
    alertConfirm.mockReturnValue(of(true));

    shell.spaces.onLeaveSpace();

    expect(leaveSpace).toHaveBeenCalledWith('@me:hs', '!s:hs');
    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /Leave .* as .*You remain a member of its rooms/,
        ),
      }),
    );
    await vi.waitFor(() => expect(shell.store.activeSpaceId()).toBeNull());
  });

  // The sync carrying the leave can land before the leave request answers. Workspace leaves
  // the space to the leave flow meanwhile, so the flow's Home is the only navigation.
  it('leaving the space navigates Home once, even when the sync drops the space first', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    await settleWorkspace();
    const request = new Subject<void>();
    leaveSpace.mockImplementation(() =>
      defer(() => {
        leaving.set(true);
        return request.pipe(finalize(() => leaving.set(false)));
      }),
    );
    alertConfirm.mockReturnValue(of(true));
    const navigate = vi.mocked(TestBed.inject(Router).navigate);

    shell.spaces.onLeaveSpace();
    spaceHeld.set(false);
    await settleWorkspace();
    await settleWorkspace();
    expect(shell.store.activeSpaceId()).toBe('!s:hs');
    navigate.mockClear();

    request.next();
    request.complete();
    await vi.waitFor(() => expect(shell.store.activeSpaceId()).toBeNull());
    await settleWorkspace();

    expect(shell.store.recentView()).toBe(false);
    expect(shell.vm.sidebarTitle()).toBe('Direct messages');
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      ['/rooms'],
      expect.objectContaining({
        queryParams: { account: '@me:hs', view: 'home' },
      }),
    );
  });

  it('does not leave when the confirm is cancelled', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    alertConfirm.mockReturnValue(of(false));

    shell.spaces.onLeaveSpace();

    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to leave on Home (no active space)', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: null, accountId: '@me:hs' });

    shell.spaces.onLeaveSpace();

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('removes an account through the shared removal flow', () => {
    const shell = build();

    shell.session.logout('@me:hs');

    expect(accountRemoval).toHaveBeenCalledWith('@me:hs');
  });

  it('opens Security settings when the flow asks to export keys first', () => {
    const shell = build();
    accountRemoval.mockReturnValue(
      of<AccountRemovalOutcome>({ kind: 'export-keys' }),
    );
    const open = vi.spyOn(
      TestBed.inject(WorkspaceApplicationSurfaceService),
      'open',
    );

    shell.session.logout('@me:hs');

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'settings', section: 'security' },
    });
  });

  it('says when the account could not be removed', () => {
    const shell = build();
    accountRemoval.mockReturnValue(
      of<AccountRemovalOutcome>({ kind: 'failed' }),
    );
    const showError = vi.spyOn(TestBed.inject(ShellStatusService), 'showError');

    shell.session.logout('@me:hs');

    expect(showError).toHaveBeenCalledWith(
      'Unable to remove this account right now.',
    );
  });

  it.each([
    { kind: 'kept' },
    { kind: 'removed', remainingAccountIds: ['@alt:hs'] },
    { kind: 'still-running' },
  ] as const)('adds nothing of its own after $kind', (outcome) => {
    const shell = build();
    accountRemoval.mockReturnValue(of<AccountRemovalOutcome>(outcome));
    const showError = vi.spyOn(TestBed.inject(ShellStatusService), 'showError');
    const open = vi.spyOn(
      TestBed.inject(WorkspaceApplicationSurfaceService),
      'open',
    );

    shell.session.logout('@me:hs');

    expect(showError).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('switches to another account (and no-ops on the active one)', async () => {
    const shell = build();
    const accounts = TestBed.inject(AccountRuntimeService);

    shell.session.switchAccount('@me:hs'); // already active → ignored
    expect(accounts.switchActiveAccount).not.toHaveBeenCalled();

    shell.session.switchAccount('@other:hs');
    await vi.waitFor(() =>
      expect(accounts.switchActiveAccount).toHaveBeenCalledWith(
        '@other:hs',
        expect.objectContaining({
          prepare: expect.any(Function),
          onCommitStarted: expect.any(Function),
        }),
      ),
    );
  });

  it('drops the sidebar filter when switching accounts', async () => {
    // The filter resets itself on a VIEW change, and resetViewScope deliberately leaves
    // Recent / Direct messages / Rooms alone — so on those three the view key never
    // changes and a query typed against one account's rooms would silently narrow the
    // next account's list.
    const shell = build();
    shell.store.roomFilter.set('design');

    shell.session.switchAccount('@other:hs');
    await settleWorkspace();

    expect(shell.store.roomFilter()).toBe('');
  });

  it('tears the open room down when switching accounts', async () => {
    // The room panes are bound to the PREVIOUS account's client and Room objects, and
    // timeline/threads/pinned each early-return on open(sameRoomId) — so leaving the
    // room open across a switch would keep projecting the old account's data (including
    // its decryption) with no way to re-bind short of a reload.
    const shell = build();
    const timeline = TestBed.inject(RoomsTimelineStub);
    shell.nav.onSelectRoom({ roomId: '!r:hs', accountId: '@me:hs' });
    await settleWorkspace();
    expect(shell.store.activeRoomId()).toBe('!r:hs');
    // Opening is a navigation now and the projections follow the URL from an effect, so
    // flush before switching: without this the room is never actually open, and the
    // teardown below would be asserted against a shell that had nothing to tear down.
    TestBed.tick();
    expect(timeline.open).toHaveBeenCalledWith('!r:hs');

    shell.session.switchAccount('@other:hs');
    await settleWorkspace();

    expect(shell.store.activeRoomId()).toBeNull();
    TestBed.tick(); // and again for the teardown the closed URL triggers

    expect(timeline.close).toHaveBeenCalled();
  });

  it('routes to /login in add mode from "Add account"', () => {
    const shell = build();
    const router = TestBed.inject(Router);

    shell.session.addAccount();

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { add: 1 },
    });
  });

  it('routes to /login in re-auth mode for a soft-logged-out account', () => {
    const shell = build();
    const router = TestBed.inject(Router);

    shell.session.reauthAccount('@bob:hs');

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { reauth: '@bob:hs' },
    });
  });

  it('returns to /login when the last account is lost (active becomes null)', () => {
    const shell = build();
    const router = TestBed.inject(Router);

    shell.activeAccountId.set(null); // e.g. a soft-logout of the last account
    TestBed.flushEffects();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });

  it('stays on the room while this tab hands its session to another tab', () => {
    // The handover stops every client, then reloads this URL: a redirect would race the
    // reload and could leave the tab on the sign-in page instead of the room (#1267).
    const shell = build();
    const router = TestBed.inject(Router);

    shell.lockState.set('releasing');
    shell.activeAccountId.set(null);
    TestBed.flushEffects();

    expect(router.navigateByUrl).not.toHaveBeenCalledWith(
      '/login',
      expect.anything(),
    );
  });

  it.each([
    'held',
    'not-required',
    'acquiring',
    'waiting',
    'taking-over',
    'handover-timed-out',
    'unavailable',
  ] as const satisfies readonly SessionLockState[])(
    'still returns to /login when the last account is lost and the lock is %s',
    (state) => {
      const shell = build();
      const router = TestBed.inject(Router);

      shell.lockState.set(state);
      shell.activeAccountId.set(null);
      TestBed.flushEffects();

      expect(router.navigateByUrl).toHaveBeenCalledWith('/login', {
        replaceUrl: true,
      });
    },
  );
});

// Room / DM creation, invites, and accept/decline. The page picks a user (modal),
// prompts for a name (alert), or reads a pending invite, then delegates to the
// services and handles selection + success/error toasts.

// Room / DM creation, invites, and accept/decline. The page picks a user (modal),
// prompts for a name (alert), or reads a pending invite, then delegates to the
// services and handles selection + success/error toasts.
describe('RoomsPage room / DM / invite actions', () => {
  let alertPrompt: Mock;
  let toastShow: Mock;
  let pick: Mock;
  let historyNote: Mock;
  let createRoom: Mock;
  let directIds: ReturnType<typeof signal<ReadonlySet<string>>>;
  let createDirectMessage: Mock;
  let inviteUser: Mock;
  let acceptInvite: Mock;
  let declineInvite: Mock;
  let canModerate: Mock;
  let dialogOpen: Mock;
  let surfaceOpen: Mock;
  let resolveRoomId: Mock;
  let pending: WritableSignal<PendingInvite[]>;

  function build() {
    alertPrompt = vi.fn(() => of(null));
    toastShow = vi.fn();
    pick = vi.fn(() => of(null));
    historyNote = vi.fn(() => HISTORY_NOTE);
    createRoom = vi.fn(() => of('!room:hs'));
    directIds = signal<ReadonlySet<string>>(new Set());
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    inviteUser = vi.fn(() => of(undefined));
    acceptInvite = vi.fn(() => of(undefined));
    declineInvite = vi.fn(() => of(undefined));
    canModerate = vi.fn(() => ({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 0,
    }));
    dialogOpen = vi.fn(() => of(null));
    surfaceOpen = vi.fn();
    resolveRoomId = vi.fn(() => of('!linked:hs'));
    pending = signal<PendingInvite[]>([]);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        // The Account holds every space these tests open, as `selectionAvailability` says.
        selectedRoomLibraryProvider(),
        MockProvider(RoomLibraryService, {
          selectionAvailability: () => 'available',
          clearMarkedUnread: () => of(void 0),
          rooms: signal<RoomSummary[]>([]),
          createRoom,
          createDirectMessage,
          inviteUser,
          directRoomIds: directIds,
          resolveRoomId,
        }),
        MockProvider(SpacesService, {
          openSpace: () => of(void 0),
          spaces: signal<SpaceSummary[]>([
            spaceSummary({
              id: '!s:hs',
              accountId: '@me:hs',
              name: 'My Space',
              initial: 'M',
            }),
          ]),
        }),
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
          declineInvite,
        }),
        MockProvider(UserPickerService, {
          pick$: pick,
          pickUser$: (options: unknown) =>
            pick(options).pipe(
              map((picked: unknown) =>
                typeof picked === 'string'
                  ? { userId: picked, displayName: null }
                  : picked,
              ),
            ),
        }),
        MockProvider(InviteHistoryNoteService, { noteFor: historyNote }),
        MockProvider(RoomModerationService, { canModerate }),
        MockProvider(QuickSwitcherService),
        MockProvider(TimelineActionsService),
        MockProvider(MediaPipeline),
        matrixClientProvider(),
        sessionStateProvider({ syncState: 'syncing' }),
        UNREAD_AGGREGATOR_PROVIDER,
        MockProvider(TrnSurfaceService, {
          open: surfaceOpen,
          openAndWait$: dialogOpen,
        }),
        MockProvider(TrnAlertService, { prompt$: alertPrompt }),
        MockProvider(TrnToastService, { show: toastShow }),
      ],
    });
    return shellFrom();
  }

  it('creates an encrypted room from the name prompt and selects it', async () => {
    const shell = build();
    alertPrompt.mockReturnValue(of('general'));

    shell.rooms.onCreateRoom();

    expect(createRoom).toHaveBeenCalledWith({ name: 'general' });
    await vi.waitFor(() => expect(shell.store.activeRoomId()).toBe('!room:hs'));
  });

  it('does not create a room for an empty name', async () => {
    const shell = build();
    alertPrompt.mockReturnValue(of('   '));

    shell.rooms.onCreateRoom();

    expect(createRoom).not.toHaveBeenCalled();
  });

  it('starts a DM with the picked user and selects the DM room', async () => {
    const shell = build();
    pick.mockReturnValue(of('@bob:hs'));

    shell.rooms.onStartDm();
    await settleWorkspace();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('does not start a DM when the picker is cancelled', async () => {
    const shell = build();
    pick.mockReturnValue(of(null));

    shell.rooms.onStartDm();
    await settleWorkspace();

    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('shows a user card for a mention link, starting a DM only if messaged', async () => {
    const shell = build();
    dialogOpen.mockReturnValue(of('@bob:hs')); // the viewer chose "Message"
    const mention = document.createElement('a');

    shell.messages.onMatrixLink({
      target: { kind: 'user', userId: '@bob:hs' },
      anchor: mention,
    });
    await Promise.resolve();
    await Promise.resolve();

    // The anchor is forwarded, not dropped: it is what pins the card to the mention
    // instead of centring it over the sentence the mention is part of.
    expect(dialogOpen).toHaveBeenCalledWith(UserCardComponent, {
      ariaLabel: 'User',
      inputs: { userId: '@bob:hs' },
      kind: 'popover',
      anchor: mention,
    });
    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('opens no conversation when the user card is dismissed', async () => {
    const shell = build();
    dialogOpen.mockReturnValue(of(null)); // dismissed

    // No anchor — the edit-history route, where the dialog holding the link has closed.
    shell.messages.onMatrixLink({
      target: { kind: 'user', userId: '@bob:hs' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(dialogOpen).toHaveBeenCalledWith(UserCardComponent, {
      ariaLabel: 'User',
      inputs: { userId: '@bob:hs' },
      kind: 'popover',
      anchor: undefined,
    });
    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('previews a room permalink without resolving or joining it first', async () => {
    const shell = build();

    shell.messages.onMatrixLink({
      target: {
        kind: 'room',
        roomIdOrAlias: '#linked:remote',
        via: ['remote'],
      },
    });
    await Promise.resolve();

    expect(dialogOpen).toHaveBeenCalledWith(RoomLinkPreviewComponent, {
      autoFocus: 'first-heading',
      inputs: {
        target: {
          kind: 'room',
          roomIdOrAlias: '#linked:remote',
          via: ['remote'],
        },
      },
    });
    expect(resolveRoomId).not.toHaveBeenCalled();
  });

  it('keeps event permalinks on the existing resolve-and-jump path', () => {
    const shell = build();
    const openLinkedRoom = vi.spyOn(shell.routing, 'openLinkedRoom');

    shell.messages.onMatrixLink({
      target: {
        kind: 'room',
        roomIdOrAlias: '#linked:remote',
        eventId: '$event:remote',
        via: ['remote'],
      },
    });

    expect(resolveRoomId).toHaveBeenCalledWith('#linked:remote');
    expect(openLinkedRoom).toHaveBeenCalledWith(
      '!linked:hs',
      '$event:remote',
      'room-action',
    );
    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('opens a deep-link room link through the same preview, tagged with its origin', async () => {
    const shell = build();
    const openExact = vi.spyOn(shell.routing, 'onSelectRoomSelection');
    dialogOpen.mockReturnValue(
      of({
        accountId: '@alt:hs',
        roomId: '!joined:remote',
        isSpace: false,
        membershipChanged: false,
      }),
    );

    shell.messages.onMatrixLink(
      { target: { kind: 'room', roomIdOrAlias: '#linked:remote' } },
      'deep-link',
    );
    await Promise.resolve();

    expect(dialogOpen).toHaveBeenCalledWith(
      RoomLinkPreviewComponent,
      expect.objectContaining({ autoFocus: 'first-heading' }),
    );
    expect(openExact).toHaveBeenCalledWith(
      { roomId: '!joined:remote', accountId: '@alt:hs' },
      'deep-link',
    );
  });

  it('carries the deep-link origin through event links and fresh joins', async () => {
    const shell = build();
    const openLinkedRoom = vi.spyOn(shell.routing, 'openLinkedRoom');
    const openConfirmed = vi.spyOn(shell.routing, 'openConfirmedLinkedRoom');

    shell.messages.onMatrixLink(
      {
        target: {
          kind: 'room',
          roomIdOrAlias: '#linked:remote',
          eventId: '$event:remote',
        },
      },
      'deep-link',
    );
    expect(openLinkedRoom).toHaveBeenCalledWith(
      '!linked:hs',
      '$event:remote',
      'deep-link',
    );

    dialogOpen.mockReturnValue(
      of({
        accountId: '@me:hs',
        roomId: '!joined:remote',
        isSpace: false,
        membershipChanged: true,
      }),
    );
    shell.messages.onMatrixLink(
      { target: { kind: 'room', roomIdOrAlias: '#linked:remote' } },
      'deep-link',
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(openConfirmed).toHaveBeenCalledWith(
      { kind: 'room', roomId: '!joined:remote', accountId: '@me:hs' },
      'deep-link',
    );
  });

  it('opens a room link waiting from the host exactly once', () => {
    const shell = build();
    const onMatrixLink = vi.spyOn(shell.messages, 'onMatrixLink');
    const inbound = TestBed.inject(InboundRoomLinkService);
    const link = { kind: 'room', roomIdOrAlias: '!b:hs' } as const;

    inbound.offer(link);
    TestBed.tick();
    TestBed.tick();

    expect(onMatrixLink).toHaveBeenCalledExactlyOnceWith(
      { target: link },
      'deep-link',
    );
    expect(inbound.pending()).toBeNull();
  });

  it('keeps a room link waiting while App lock is locked', () => {
    const locked = signal(true);
    TestBed.overrideProvider(AppLockService, {
      useValue: { locked: locked.asReadonly(), lockNow: vi.fn() },
    });
    const shell = build();
    const onMatrixLink = vi.spyOn(shell.messages, 'onMatrixLink');
    const inbound = TestBed.inject(InboundRoomLinkService);
    const link = { kind: 'room', roomIdOrAlias: '!b:hs' } as const;

    inbound.offer(link);
    TestBed.tick();
    expect(onMatrixLink).not.toHaveBeenCalled();
    expect(inbound.pending()).toEqual(link);

    locked.set(false);
    TestBed.tick();
    expect(onMatrixLink).toHaveBeenCalledExactlyOnceWith(
      { target: link },
      'deep-link',
    );
  });

  it('ignores global shortcuts while App lock is locked', () => {
    const locked = signal(true);
    TestBed.overrideProvider(AppLockService, {
      useValue: { locked: locked.asReadonly(), lockNow: vi.fn() },
    });
    const shell = build();
    const openSwitcher = vi
      .spyOn(shell.shortcuts, 'openSwitcher')
      .mockImplementation(() => undefined);
    const chord = () =>
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        cancelable: true,
      });

    const behindCover = chord();
    shell.page.onGlobalKeydown(behindCover);
    expect(behindCover.defaultPrevented).toBe(false);
    expect(openSwitcher).not.toHaveBeenCalled();

    locked.set(false);
    const unlocked = chord();
    shell.page.onGlobalKeydown(unlocked);
    expect(unlocked.defaultPrevented).toBe(true);
    expect(openSwitcher).toHaveBeenCalledOnce();
  });

  describe('Lock Trinity shortcut', () => {
    const lockChord = () =>
      new KeyboardEvent('keydown', {
        key: 'l',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      });

    function buildWithLock(state: { enabled: boolean; locked: boolean }) {
      const lockNow = vi.fn();
      TestBed.overrideProvider(AppLockService, {
        useValue: {
          enabled: signal(state.enabled).asReadonly(),
          locked: signal(state.locked).asReadonly(),
          lockNow,
        },
      });
      const shell = build();
      const shortcuts = TestBed.inject(KeyboardShortcutsService);
      shortcuts.resetAll();
      shortcuts.rebind('lock.now', {
        accel: true,
        alt: false,
        shift: true,
        key: 'l',
      });
      return { shell, lockNow, shortcuts };
    }

    it('locks with the bound shortcut even over an open dialog', () => {
      const { shell, lockNow, shortcuts } = buildWithLock({
        enabled: true,
        locked: false,
      });
      vi.spyOn(TestBed.inject(TrnSurfaceService), 'hasOpen').mockReturnValue(
        true,
      );
      const chord = lockChord();

      shell.page.onGlobalKeydown(chord);

      expect(lockNow).toHaveBeenCalledOnce();
      expect(chord.defaultPrevented).toBe(true);
      shortcuts.resetAll();
    });

    it('does nothing while already locked, since the cover owns the keys', () => {
      const { shell, lockNow, shortcuts } = buildWithLock({
        enabled: true,
        locked: true,
      });
      const chord = lockChord();

      shell.page.onGlobalKeydown(chord);

      expect(lockNow).not.toHaveBeenCalled();
      expect(chord.defaultPrevented).toBe(false);
      shortcuts.resetAll();
    });

    it('leaves the chord to the browser while App lock is off', () => {
      const { shell, lockNow, shortcuts } = buildWithLock({
        enabled: false,
        locked: false,
      });
      const chord = lockChord();

      shell.page.onGlobalKeydown(chord);

      expect(lockNow).not.toHaveBeenCalled();
      expect(chord.defaultPrevented).toBe(false);
      shortcuts.resetAll();
    });
  });

  it('ignores Escape while App lock is locked', () => {
    const locked = signal(true);
    TestBed.overrideProvider(AppLockService, {
      useValue: { locked: locked.asReadonly(), lockNow: vi.fn() },
    });
    const shell = build();
    const transition = vi.spyOn(shell.surfaces, 'transition');
    const escape = () =>
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });

    shell.page.onEscapeKey(escape());
    expect(transition).not.toHaveBeenCalled();

    locked.set(false);
    shell.page.onEscapeKey(escape());
    expect(transition).toHaveBeenCalledExactlyOnceWith({ kind: 'escape' });
  });

  it('reports a malformed Matrix link instead of opening an overlay', () => {
    const shell = build();

    shell.messages.onMatrixLink({ target: { kind: 'invalid' } });

    expect(toastShow).toHaveBeenCalledWith(
      'That Matrix link is malformed or unsupported.',
      { duration: 4000, variant: 'danger' },
    );
    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('routes a newly joined room without waiting for the sidebar sync', async () => {
    const shell = build();
    const openConfirmed = vi.spyOn(shell.routing, 'openConfirmedLinkedRoom');
    dialogOpen.mockReturnValue(
      of({
        accountId: '@me:hs',
        roomId: '!joined:remote',
        isSpace: false,
        membershipChanged: true,
      }),
    );

    shell.messages.onMatrixLink({
      target: { kind: 'room', roomIdOrAlias: '#linked:remote' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(openConfirmed).toHaveBeenCalledWith(
      { kind: 'room', roomId: '!joined:remote', accountId: '@me:hs' },
      'room-action',
    );
  });

  it('opens an already-joined preview on the Account that resolved it', async () => {
    const shell = build();
    const openExact = vi.spyOn(shell.routing, 'onSelectRoomSelection');
    dialogOpen.mockReturnValue(
      of({
        accountId: '@alt:hs',
        roomId: '!joined:remote',
        isSpace: false,
        membershipChanged: false,
      }),
    );

    shell.messages.onMatrixLink({
      target: { kind: 'room', roomIdOrAlias: '#linked:remote' },
    });
    await Promise.resolve();

    expect(openExact).toHaveBeenCalledWith(
      { roomId: '!joined:remote', accountId: '@alt:hs' },
      'room-action',
    );
  });

  // Member info from the list is a modal surface through `TrnSurfaceService` (#1041): the
  // roster keeps its place in the Room surface slot and the dialog or sheet sits on top.
  // `member-actions.service.spec.ts` renders the real surface stack for its placement and
  // for the Account ownership rules.
  const bob = {
    userId: '@bob:hs',
    roomDisplayName: 'Bob',
    roomInitial: 'B',
    roomAvatarMxc: null,
    powerLevel: 0,
    isCreator: false,
  };

  /** A member info handle the test closes itself, as the dialog would. */
  function memberInfoRef() {
    const closed = new Subject<string | undefined>();
    const ref = {
      closed: closed.asObservable(),
      close: vi.fn((value?: string) => {
        closed.next(value);
        closed.complete();
      }),
    };
    surfaceOpen.mockReturnValue(ref);
    return ref;
  }

  function memberInfoOptions(
    roomId: string,
    direct = false,
    targetName = 'this room',
  ) {
    return {
      ariaLabel: 'Member info',
      align: 'top',
      inputs: {
        member: bob,
        roomId,
        owningAccountId: '@me:hs',
        direct,
        targetName,
      },
    };
  }

  it('names the room in member info, so moderation and its confirmations say which', async () => {
    const shell = build();
    (
      TestBed.inject(RoomLibraryService).rooms as WritableSignal<RoomSummary[]>
    ).set([{ id: '!r:hs', name: 'Design team' } as RoomSummary]);
    setRouteRoom('!r:hs');
    await settleWorkspace();
    memberInfoRef();

    shell.members.onSelectMember(bob);

    expect(surfaceOpen).toHaveBeenCalledWith(
      MemberInfoComponent,
      memberInfoOptions('!r:hs', false, 'Design team'),
    );
  });

  it('opens member info over the roster and starts a DM only if messaged', async () => {
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    shell.surfaces.transition({ kind: 'open-members' });
    const ref = memberInfoRef();

    shell.members.onSelectMember(bob);
    // `direct` says whether the room is a DM — member info must not name an owner in a 1:1
    // chat, where both people sit at power level 100. No `kind`: the surface service applies
    // the sheet-or-dialog rule rather than this caller picking one.
    expect(surfaceOpen).toHaveBeenCalledWith(
      MemberInfoComponent,
      memberInfoOptions('!r:hs'),
    );
    ref.close('@bob:hs'); // the viewer chose "Message"
    await settleWorkspace();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('keeps the roster open when member info closes without a pick', async () => {
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    shell.surfaces.transition({ kind: 'open-members' });
    const ref = memberInfoRef();

    shell.members.onSelectMember(bob);
    // While it is open the roster is still the slot's surface, behind the dialog or sheet.
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });

    // Closing, or a kick or ban landing (member info closes itself with null), returns to
    // the roster — which is where the change shows.
    ref.close();
    await settleWorkspace();

    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
    expect(createDirectMessage).not.toHaveBeenCalled();
    expect(shell.store.activeRoomId()).toBe('!r:hs');
  });

  it('does not carry member info into the next room', async () => {
    // Member info is bound to the Conversation it was opened in. A room switch (a link, a
    // notification tap) closes it rather than leaving it over another room's timeline.
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    shell.surfaces.transition({ kind: 'open-members' });
    const ref = memberInfoRef();
    shell.members.onSelectMember(bob);
    await settleWorkspace();
    expect(ref.close).not.toHaveBeenCalled();

    setRouteRoom('!other:hs');
    await settleWorkspace();

    expect(ref.close).toHaveBeenCalledWith();
    expect(createDirectMessage).not.toHaveBeenCalled();
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
  });

  it('keeps the roster when Message reuses the active DM', async () => {
    const shell = build();
    setRouteRoom('!dm:hs');
    await settleWorkspace();
    createDirectMessage.mockReturnValue(of('!dm:hs'));
    shell.surfaces.transition({ kind: 'open-members' });
    const ref = memberInfoRef();

    shell.members.onSelectMember(bob);
    ref.close('@bob:hs');
    await settleWorkspace();

    expect(shell.store.activeRoomId()).toBe('!dm:hs');
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
  });

  it('leaves a newer Room surface alone when DM creation finishes late', async () => {
    const shell = build();
    const pendingDm = new Subject<string>();
    createDirectMessage.mockReturnValue(pendingDm);
    setRouteRoom('!first:hs');
    await settleWorkspace();
    shell.surfaces.transition({ kind: 'open-members' });
    const ref = memberInfoRef();

    shell.members.onSelectMember(bob);
    ref.close('@bob:hs');
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
    shell.routing.onSelectRoomSelection(
      {
        accountId: '@me:hs',
        roomId: '!second:hs',
      },
      'room-list',
    );
    await settleWorkspace();
    shell.surfaces.transition({ kind: 'open-threads' });

    pendingDm.next('!second:hs');
    pendingDm.complete();
    await settleWorkspace();

    expect(shell.store.activeRoomId()).toBe('!second:hs');
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'threads' });
  });

  it('tells member info when the room is a direct message', async () => {
    // Both participants of a DM sit at 100 (trusted_private_chat), so without this the
    // person who started the chat is labelled Owner and their friend Admin.
    const shell = build();
    setRouteRoom('!dm:hs');
    await settleWorkspace();
    directIds.set(new Set(['!dm:hs']));
    memberInfoRef();

    shell.members.onSelectMember(bob);

    expect(surfaceOpen).toHaveBeenCalledWith(
      MemberInfoComponent,
      memberInfoOptions('!dm:hs', true),
    );
  });

  it('opens no member info without an active room', () => {
    const shell = build();
    setRouteRoom(null);
    // The empty slot must be left exactly as it is. Reference identity, so any write to it
    // fails this rather than merely producing another falsy presentation.
    const before = shell.surfaces.renderedSurface();

    shell.members.onSelectMember(bob);

    expect(surfaceOpen).not.toHaveBeenCalled();
    expect(shell.surfaces.renderedSurface()).toBe(before);
  });

  it('keeps the member drawer open under member info on the narrow layout', async () => {
    // Before #1041 member info replaced the roster in the one slot. Now the drawer stays
    // where it was and the sheet sits on top, so closing the sheet shows the list again.
    const restore = stubNarrowLayout();
    try {
      const shell = build();
      setRouteRoom('!r:hs');
      await settleWorkspace();
      shell.surfaces.transition({ kind: 'open-members' });
      expect(shell.surfaces.membersVisible()).toBe(true);
      memberInfoRef();

      shell.members.onSelectMember(bob);

      expect(shell.surfaces.membersVisible()).toBe(true);
      expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
      expect(surfaceOpen).toHaveBeenCalledWith(
        MemberInfoComponent,
        expect.anything(),
      );
    } finally {
      restore();
    }
  });

  it('keeps the member column open under member info on the wide layout', async () => {
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    shell.surfaces.transition({ kind: 'open-members' });
    memberInfoRef();

    shell.members.onSelectMember(bob);

    expect(shell.surfaces.membersVisible()).toBe(true);
    expect(shell.surfaces.renderedSurface()).toEqual({ kind: 'members' });
    expect(surfaceOpen).toHaveBeenCalledWith(
      MemberInfoComponent,
      expect.anything(),
    );
  });

  it('invites the picked user to the active room and toasts success', async () => {
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    pick.mockReturnValue(of('@bob:hs'));

    shell.rooms.onInviteToRoom();
    await Promise.resolve();
    await Promise.resolve();

    expect(historyNote).toHaveBeenCalledWith('!r:hs');
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({ note: HISTORY_NOTE }),
    );
    expect(inviteUser).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('captures an invite failure and shows an error toast', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    pick.mockReturnValue(of('@bob:hs'));
    inviteUser.mockReturnValue(throwError(() => new Error('forbidden')));

    shell.rooms.onInviteToRoom();
    await Promise.resolve();
    await Promise.resolve();

    // runWithBusy records and presents the failure without relying on a render pass.
    expect(shell.status.error()).toBe('Could not invite this user. Try again.');
    expect(toastShow).toHaveBeenCalledWith(
      'Could not invite this user. Try again.',
      expect.objectContaining({ variant: 'danger' }),
    );
    expect(warn).toHaveBeenCalledWith(
      '[trinity] Matrix request failed',
      expect.objectContaining({ operation: 'invite user to room' }),
    );
    warn.mockRestore();
  });

  it('says the invitee is not accepting invites when their server blocks them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    pick.mockReturnValue(of({ userId: '@bob:hs', displayName: 'Bob' }));
    inviteUser.mockReturnValue(
      throwError(() => new InviteBlockedError('@bob:hs')),
    );

    shell.rooms.onInviteToRoom();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      "Bob isn't accepting invites.",
      expect.objectContaining({ variant: 'danger' }),
    );
    warn.mockRestore();
  });

  it('recovers from an HTTP invite failure and allows an immediate retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    pick.mockReturnValue(of('@bob:remote.example'));
    inviteUser
      .mockReturnValueOnce(throwError(() => matrixError('M_FORBIDDEN', 403)))
      .mockReturnValueOnce(of(undefined));

    shell.rooms.onInviteToRoom();
    await settleWorkspace();

    expect(shell.status.busy()).toBe(false);
    expect(shell.status.error()).toBe('You do not have permission to do that.');
    expect(warn).toHaveBeenCalledWith(
      '[trinity] Matrix request failed',
      expect.objectContaining({ operation: 'invite user to room' }),
    );

    shell.rooms.onInviteToRoom();
    await settleWorkspace();

    expect(inviteUser).toHaveBeenCalledTimes(2);
    expect(shell.status.busy()).toBe(false);
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Invitation sent'),
      expect.objectContaining({ variant: 'success' }),
    );
    warn.mockRestore();
  });

  it('shows a queued failure without a component render pass', async () => {
    // The app is zoneless. Presenting from ShellStatusService keeps this reliable even
    // when the failed action changes no template-read signal that would schedule a tick.
    const shell = build();
    shell.status.error.set('forbidden');
    shell.status.presentError();

    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      'forbidden',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('does not invite when the picker is cancelled', async () => {
    const shell = build();
    setRouteRoom('!r:hs');
    await settleWorkspace();
    pick.mockReturnValue(of(null));

    shell.rooms.onInviteToRoom();
    await settleWorkspace();

    expect(inviteUser).not.toHaveBeenCalled();
  });

  it('invites to the active space from the sidebar action', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    await settleWorkspace();
    pick.mockReturnValue(of('@bob:hs'));

    shell.rooms.onInviteToSpace();
    await settleWorkspace();

    expect(inviteUser).toHaveBeenCalledWith('!s:hs', '@bob:hs');
  });

  it('accepts a room invite (joins) and selects the joined room', async () => {
    const shell = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isSpace: false })]);

    shell.invites.onAcceptInvite(pendingInvite({ roomId: '!i:hs' }));
    await settleWorkspace();

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs', '@me:hs');
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('recovers from an HTTP join failure and allows an immediate retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shell = build();
    pending.set([pendingInvite({ roomId: '!i:remote.example' })]);
    acceptInvite
      .mockReturnValueOnce(
        throwError(() =>
          matrixError('M_UNKNOWN', 502, { error: 'upstream unavailable' }),
        ),
      )
      .mockReturnValueOnce(of(undefined));

    shell.invites.onAcceptInvite(
      pendingInvite({ roomId: '!i:remote.example' }),
    );
    await settleWorkspace();

    expect(shell.status.busy()).toBe(false);
    expect(shell.status.error()).toBe(
      'The homeserver is unavailable. Try again.',
    );
    expect(shell.store.activeRoomId()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[trinity] Matrix request failed',
      expect.objectContaining({ operation: 'accept room invite' }),
    );

    shell.invites.onAcceptInvite(
      pendingInvite({ roomId: '!i:remote.example' }),
    );
    await settleWorkspace();

    expect(acceptInvite).toHaveBeenCalledTimes(2);
    expect(shell.status.busy()).toBe(false);
    expect(shell.store.activeRoomId()).toBe('!i:remote.example');
    warn.mockRestore();
  });

  it('leaves a room invite on a view that can actually show the room', async () => {
    // Accepting used to force the Home view, which lists DIRECT MESSAGES ONLY since the
    // rail split — so the room you had just joined was invisible in the sidebar, and the
    // row count went DOWN. Recent activity is the default and lists everything; accepting
    // a non-DM room must not navigate away from it.
    const shell = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isDirect: false })]);
    expect(shell.store.recentView()).toBe(true);

    shell.invites.onAcceptInvite(
      pendingInvite({ roomId: '!i:hs', isDirect: false }),
    );
    await settleWorkspace();

    expect(shell.store.recentView()).toBe(true);
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('still lands a DM invite on the direct-message view', async () => {
    // A DM is exactly what that view shows, so switching to it is right here.
    const shell = build();
    pending.set([pendingInvite({ roomId: '!d:hs', isDirect: true })]);

    shell.invites.onAcceptInvite(
      pendingInvite({ roomId: '!d:hs', isDirect: true }),
    );
    await settleWorkspace();

    expect(shell.store.recentView()).toBe(false);
    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.store.activeRoomId()).toBe('!d:hs');
  });

  it('opens an accepted DM invite on the exact inactive Account', async () => {
    const shell = build();
    pending.set([
      pendingInvite({
        roomId: '!shared:hs',
        accountId: '@alt:hs',
        isDirect: true,
      }),
    ]);

    shell.invites.onAcceptInvite(
      pendingInvite({
        roomId: '!shared:hs',
        accountId: '@alt:hs',
        isDirect: true,
      }),
    );

    await vi.waitFor(() =>
      expect(shell.store.activeAccountId()).toBe('@alt:hs'),
    );
    expect(acceptInvite).toHaveBeenCalledWith('!shared:hs', '@alt:hs');
    expect(shell.store.activeRoomId()).toBe('!shared:hs');
    expect(shell.store.pane()).toBe('conversation');
    expect(shell.store.recentView()).toBe(false);
  });

  it('accepts a space invite without auto-selecting a room', () => {
    const shell = build();
    pending.set([pendingInvite({ roomId: '!s:hs', isSpace: true })]);

    shell.invites.onAcceptInvite(
      pendingInvite({ roomId: '!s:hs', isSpace: true }),
    );

    expect(acceptInvite).toHaveBeenCalledWith('!s:hs', '@me:hs');
    expect(shell.store.activeRoomId()).toBeNull(); // a space lands in the rail, not selected
  });

  it('declines an invite (leaves)', () => {
    const shell = build();

    shell.invites.onDeclineInvite(pendingInvite({ roomId: '!i:hs' }));

    expect(declineInvite).toHaveBeenCalledWith('!i:hs', '@me:hs');
  });

  it('opens the new-chat actions beside the Home "+"', async () => {
    const shell = build();
    const openActions = vi
      .spyOn(TestBed.inject(TrnSurfaceService), 'openActions')
      .mockReturnValue({} as TrnActionSheetRef);
    const plus = document.createElement('button');

    shell.rooms.onNewChat(plus);

    expect(openActions).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ text: 'Create a room' }),
          expect.objectContaining({ text: 'Explore public rooms' }),
          expect.objectContaining({ text: 'Start a direct message' }),
        ]),
      }),
      { anchor: plus },
    );
  });
});

// Selecting a space loads its hierarchy; joining a not-yet-joined child and
// removing a joined child delegate to SpacesService (the live read model + sync
// surface the result, so the page only fires the SDK-backed call).

// Selecting a space loads its hierarchy; joining a not-yet-joined child and
// removing a joined child delegate to SpacesService (the live read model + sync
// surface the result, so the page only fires the SDK-backed call).
describe('RoomsPage space hierarchy actions', () => {
  let alertConfirm: Mock;
  let openSpace: Mock;
  let joinRoom: Mock;
  let removeRoomFromSpace: Mock;

  function childRoom(over: Partial<SpaceChildRoom> = {}): SpaceChildRoom {
    return {
      accountId: '@me:hs',
      roomId: '!c:hs',
      name: 'general',
      initial: 'G',
      avatarMxc: null,
      memberCount: 3,
      joinRule: 'public',
      suggested: false,
      isSpace: false,
      via: ['hs.example'],
      joined: false,
      ...over,
    };
  }

  function build() {
    alertConfirm = vi.fn(() => of(false));
    openSpace = vi.fn(() => of(void 0));
    joinRoom = vi.fn(() => of(undefined));
    removeRoomFromSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        // The Account holds every space these tests open, as `selectionAvailability` says.
        selectedRoomLibraryProvider(),
        MockProvider(RoomLibraryService, {
          selectionAvailability: () => 'available',
          clearMarkedUnread: () => of(void 0),
          rooms: signal<RoomSummary[]>([
            roomSummary({
              id: '!c:hs',
              accountId: '@me:hs',
              name: 'general',
            }),
          ]),
        }),
        MockProvider(SpacesService, {
          openSpace,
          joinRoom,
          spaces: signal<SpaceSummary[]>([
            spaceSummary({
              id: '!s:hs',
              accountId: '@me:hs',
              name: 'My Space',
              initial: 'M',
            }),
          ]),
        }),
        MockProvider(SpaceContentsService, { unlink: removeRoomFromSpace }),
        MockProvider(TimelineActionsService),
        matrixClientProvider(),
        sessionStateProvider({ syncState: 'syncing' }),
        UNREAD_AGGREGATOR_PROVIDER,
        invitesProvider(),
        MockProvider(UserPickerService),
        MockProvider(QuickSwitcherService),
        MockProvider(TrnSurfaceService),
        MockProvider(TrnAlertService, { confirm$: alertConfirm }),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('loads the hierarchy when a space is selected (and clears it for Home)', async () => {
    const shell = build();

    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    await settleWorkspace();
    expect(shell.store.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');

    shell.nav.onSelectSpace({ spaceId: null, accountId: '@me:hs' });
    await settleWorkspace();
    expect(openSpace).toHaveBeenLastCalledWith(null);
  });

  it('joins a not-yet-joined child through its via servers', () => {
    const shell = build();

    shell.spaces.onJoinChild(
      childRoom({ roomId: '!x:hs', via: ['hs.example'] }),
    );

    expect(joinRoom).toHaveBeenCalledWith('@me:hs', '!x:hs', ['hs.example']);
  });

  it('confirms then removes a joined child from the active space', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    await settleWorkspace();
    alertConfirm.mockReturnValue(of(true));

    shell.spaces.onRemoveFromSpace('!c:hs');

    // The confirmation names the channel and the space.
    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ header: 'Remove from space' }),
    );
    expect(removeRoomFromSpace).toHaveBeenCalledWith(
      { accountId: '@me:hs', spaceId: '!s:hs' },
      '!c:hs',
    );
  });

  it('does not remove when the confirm is cancelled', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: '!s:hs', accountId: '@me:hs' });
    await settleWorkspace();
    alertConfirm.mockReturnValue(of(false));

    shell.spaces.onRemoveFromSpace('!c:hs');

    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to remove on Home (no active space)', async () => {
    const shell = build();
    shell.nav.onSelectSpace({ spaceId: null, accountId: '@me:hs' });

    shell.spaces.onRemoveFromSpace('!c:hs');

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });
});

// The quick switcher (Ctrl/Cmd+K) presents a modal and, on a selection, jumps per
// kind: room/dm open the room, space selects it in the rail, a directory person
// opens a DM, an invite runs the page's accept path.
