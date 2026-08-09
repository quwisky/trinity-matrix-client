import {
  SHARED_MOCKS,
  clientStub,
  invitesProvider,
  shellFrom,
  stubNarrowLayout,
} from './rooms-page.spec-harness';
import { ApplicationRef, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '@trinity/data-access/auth';
import { type PendingInvite } from '@trinity/data-access/invites';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import {
  RoomsService,
  RoomModerationService,
  SpacesService,
  UnreadAggregatorService,
  type RoomSummary,
  type SpaceChildRoom,
  type SpaceSummary,
} from '@trinity/data-access/rooms';
import { ThreadsService, TimelineService } from '@trinity/data-access/timeline';
import {
  TrnActionSheetService,
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/helm/overlay';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { UserPickerService } from '../user-picker/user-picker.service';
import { UserCardService } from '../user-card/user-card.service';
import { MemberInfoService } from '../member-info/member-info.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';

// Create-space / create-channel / leave-space: the page prompts via TrnAlertService
// and delegates to SpacesService, handling the success navigation + error state.
describe('RoomsPage space actions', () => {
  let alertPrompt: Mock;
  let alertConfirm: Mock;
  let createSpace: Mock;
  let createRoomInSpace: Mock;
  let leaveSpace: Mock;

  function build(
    activeUserId: string | null = '@me:hs',
    accountIds: readonly string[] = ['@me:hs'],
  ) {
    alertPrompt = vi.fn().mockResolvedValue(null);
    alertConfirm = vi.fn().mockResolvedValue(false);
    createSpace = vi.fn(() => of('!new:hs'));
    createRoomInSpace = vi.fn(() => of('!room:hs'));
    leaveSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService),
        MockProvider(SpacesService, {
          spaces: signal<SpaceSummary[]>([]),
          createSpace,
          createRoomInSpace,
          leaveSpace,
        }),
        MockProvider(TimelineService),
        MockProvider(MatrixClientService, {
          isInitialized: true,
          instance: { getUserId: () => '@me:hs', getUser: () => null } as never,
          activeUserId: signal<string | null>(activeUserId).asReadonly(),
          accountIds: signal<readonly string[]>(accountIds).asReadonly(),
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
        MockProvider(MessageSearchService),
        MockProvider(AuthService, {
          logout: vi.fn(() => of(undefined)),
          switchAccount: vi.fn(() => of(undefined)),
        }),
        MockProvider(TrnDialogService),
        MockProvider(TrnAlertService, {
          confirm: alertConfirm,
          prompt: alertPrompt,
        }),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('creates a space and selects it on success', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('My Space');

    await shell.spaces.onCreateSpace();

    expect(createSpace).toHaveBeenCalledWith({ name: 'My Space' });
    expect(shell.store.activeSpaceId()).toBe('!new:hs');
  });

  it('does not create a space for an empty name', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('   ');

    await shell.spaces.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('does not create a space when the prompt is cancelled', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue(null);

    await shell.spaces.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('surfaces a create-space failure in spaceError', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('My Space');
    createSpace.mockReturnValue(throwError(() => new Error('boom')));

    await shell.spaces.onCreateSpace();

    expect(shell.status.error()).toBe('boom');
    expect(shell.store.activeSpaceId()).toBeNull(); // not selected on failure
  });

  it('creates a channel in the active space', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertPrompt.mockResolvedValue('general');

    await shell.spaces.onCreateChannel();

    expect(createRoomInSpace).toHaveBeenCalledWith('!s:hs', {
      name: 'general',
    });
  });

  it('does not prompt to create a channel on Home (no active space)', async () => {
    const shell = build();
    shell.store.activeSpaceId.set(null);

    await shell.spaces.onCreateChannel();

    expect(alertPrompt).not.toHaveBeenCalled();
    expect(createRoomInSpace).not.toHaveBeenCalled();
  });

  it('leaves the active space and returns to Home on success', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await shell.spaces.onLeaveSpace();

    expect(leaveSpace).toHaveBeenCalledWith('!s:hs');
    expect(shell.store.activeSpaceId()).toBeNull();
  });

  it('does not leave when the confirm is cancelled', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await shell.spaces.onLeaveSpace();

    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to leave on Home (no active space)', async () => {
    const shell = build();
    shell.store.activeSpaceId.set(null);

    await shell.spaces.onLeaveSpace();

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('signs out the last account and navigates to /login after confirming', async () => {
    const shell = build();
    alertConfirm.mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);

    await shell.session.logout('@me:hs');

    expect(alertConfirm).toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalledWith('@me:hs');
    // The harness has a single account, so signing it out returns to /login.
    expect(router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });

  it('signs out one of several accounts without leaving the shell', async () => {
    const shell = build('@me:hs', ['@me:hs', '@alt:hs']);
    alertConfirm.mockResolvedValue(true);
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);

    await shell.session.logout('@me:hs');

    expect(auth.logout).toHaveBeenCalledWith('@me:hs');
    // A second account is still signed in (activeUserId stays non-null), so the
    // wasLastAccount=false branch skips the /login redirect and the shell stays.
    expect(router.navigateByUrl).not.toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });

  it('does not sign out when the confirm is cancelled', async () => {
    const shell = build();
    alertConfirm.mockResolvedValue(false);
    const auth = TestBed.inject(AuthService);

    await shell.session.logout('@me:hs');

    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('switches to another account (and no-ops on the active one)', () => {
    const shell = build();
    const auth = TestBed.inject(AuthService);

    shell.session.switchAccount('@me:hs'); // already active → ignored
    expect(auth.switchAccount).not.toHaveBeenCalled();

    shell.session.switchAccount('@other:hs');
    expect(auth.switchAccount).toHaveBeenCalledWith('@other:hs');
  });

  it('drops the sidebar filter when switching accounts', () => {
    // The filter resets itself on a VIEW change, and resetViewScope deliberately leaves
    // Recent / Direct Messages / Rooms alone — so on those three the view key never
    // changes and a query typed against one account's rooms would silently narrow the
    // next account's list.
    const shell = build();
    shell.store.roomFilter.set('design');

    shell.session.switchAccount('@other:hs');

    expect(shell.store.roomFilter()).toBe('');
  });

  it('tears the open room down when switching accounts', () => {
    // The room panes are bound to the PREVIOUS account's client and Room objects, and
    // timeline/threads/pinned each early-return on open(sameRoomId) — so leaving the
    // room open across a switch would keep projecting the old account's data (including
    // its decryption) with no way to re-bind short of a reload.
    const shell = build();
    const timeline = TestBed.inject(TimelineService);
    const threads = TestBed.inject(ThreadsService);
    const pinned = TestBed.inject(PinnedMessagesService);
    shell.nav.onSelectRoom('!r:hs');
    expect(shell.store.activeRoomId()).toBe('!r:hs');

    shell.session.switchAccount('@other:hs');

    expect(shell.store.activeRoomId()).toBeNull();
    expect(timeline.close).toHaveBeenCalled();
    expect(threads.close).toHaveBeenCalled();
    expect(threads.closeThread).toHaveBeenCalled();
    expect(pinned.close).toHaveBeenCalled();
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
    build(null); // no active account — e.g. a soft-logout of the last one
    const router = TestBed.inject(Router);

    TestBed.inject(ApplicationRef).tick(); // run the redirect effect

    expect(router.navigateByUrl).toHaveBeenCalledWith('/login', {
      replaceUrl: true,
    });
  });
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
  let createRoom: Mock;
  let directIds: ReturnType<typeof signal<ReadonlySet<string>>>;
  let createDirectMessage: Mock;
  let inviteUser: Mock;
  let acceptInvite: Mock;
  let declineInvite: Mock;
  let userCardOpen: Mock;
  let memberInfoOpen: Mock;
  let canModerate: Mock;
  let pending: WritableSignal<PendingInvite[]>;

  function pendingInvite(over: Partial<PendingInvite> = {}): PendingInvite {
    return {
      roomId: '!i:hs',
      accountId: '@me:hs',
      name: 'Invited',
      initial: 'I',
      avatarMxc: null,
      inviterName: 'Alice',
      isSpace: false,
      isDirect: false,
      ...over,
    };
  }

  function build() {
    alertPrompt = vi.fn().mockResolvedValue(null);
    toastShow = vi.fn();
    pick = vi.fn();
    createRoom = vi.fn(() => of('!room:hs'));
    directIds = signal<ReadonlySet<string>>(new Set());
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    inviteUser = vi.fn(() => of(undefined));
    acceptInvite = vi.fn(() => of(undefined));
    declineInvite = vi.fn(() => of(undefined));
    userCardOpen = vi.fn().mockResolvedValue(null);
    memberInfoOpen = vi.fn().mockResolvedValue(null);
    canModerate = vi.fn(() => ({
      kick: false,
      ban: false,
      setPower: false,
      myPower: 0,
    }));
    pending = signal<PendingInvite[]>([]);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: signal<RoomSummary[]>([]),
          createRoom,
          createDirectMessage,
          inviteUser,
          directRoomIds: directIds,
        }),
        MockProvider(SpacesService, { spaces: signal<SpaceSummary[]>([]) }),
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
          declineInvite,
        }),
        MockProvider(UserPickerService, { pick }),
        MockProvider(UserCardService, { open: userCardOpen }),
        MockProvider(MemberInfoService, { open: memberInfoOpen }),
        MockProvider(RoomModerationService, { canModerate }),
        MockProvider(QuickSwitcherService),
        MockProvider(MessageSearchService),
        MockProvider(TimelineService),
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
        MockProvider(TrnDialogService),
        MockProvider(TrnAlertService, { prompt: alertPrompt }),
        MockProvider(TrnToastService, { show: toastShow }),
      ],
    });
    return shellFrom();
  }

  it('creates an encrypted room from the name prompt and selects it', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('general');

    await shell.rooms.onCreateRoom();

    expect(createRoom).toHaveBeenCalledWith({ name: 'general' });
    expect(shell.store.activeRoomId()).toBe('!room:hs');
  });

  it('does not create a room for an empty name', async () => {
    const shell = build();
    alertPrompt.mockResolvedValue('   ');

    await shell.rooms.onCreateRoom();

    expect(createRoom).not.toHaveBeenCalled();
  });

  it('starts a DM with the picked user and selects the DM room', async () => {
    const shell = build();
    pick.mockResolvedValue('@bob:hs');

    await shell.rooms.onStartDm();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('does not start a DM when the picker is cancelled', async () => {
    const shell = build();
    pick.mockResolvedValue(null);

    await shell.rooms.onStartDm();

    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('shows a user card for a mention link, starting a DM only if messaged', async () => {
    const shell = build();
    userCardOpen.mockResolvedValue('@bob:hs'); // the viewer chose "Message"

    shell.messages.onMatrixLink({ kind: 'user', userId: '@bob:hs' });
    await Promise.resolve();
    await Promise.resolve();

    expect(userCardOpen).toHaveBeenCalledWith('@bob:hs');
    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('opens no conversation when the user card is dismissed', async () => {
    const shell = build();
    userCardOpen.mockResolvedValue(null); // dismissed

    shell.messages.onMatrixLink({ kind: 'user', userId: '@bob:hs' });
    await Promise.resolve();
    await Promise.resolve();

    expect(userCardOpen).toHaveBeenCalledWith('@bob:hs');
    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('opens a member info panel and starts a DM only if messaged', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    const bob = {
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    };
    memberInfoOpen.mockResolvedValue('@bob:hs'); // the viewer chose "Message"

    shell.members.onSelectMember(bob);
    await Promise.resolve();
    await Promise.resolve();

    expect(canModerate).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    // The trailing flag says whether this room is a DM — the panel must not name an
    // owner in a 1:1 chat, where both people sit at power level 100.
    expect(memberInfoOpen).toHaveBeenCalledWith(
      bob,
      '!r:hs',
      { kick: false, ban: false, setPower: false, myPower: 0 },
      false,
    );
    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(shell.store.activeRoomId()).toBe('!dm:hs');
  });

  it('tells the member panel when the room is a direct message', async () => {
    // Both participants of a DM sit at 100 (trusted_private_chat), so without this the
    // person who started the chat is labelled Owner and their friend Admin.
    const bob = {
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    };
    const shell = build();
    shell.store.activeRoomId.set('!dm:hs');
    directIds.set(new Set(['!dm:hs']));

    shell.members.onSelectMember(bob);
    await Promise.resolve();

    expect(memberInfoOpen).toHaveBeenCalledWith(
      bob,
      '!dm:hs',
      expect.anything(),
      true,
    );
  });

  it('opens no member info panel without an active room', () => {
    const shell = build();
    shell.store.activeRoomId.set(null);

    shell.members.onSelectMember({
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    });

    expect(memberInfoOpen).not.toHaveBeenCalled();
  });

  it('closes the members drawer when a member is selected on the narrow layout', () => {
    // On the narrow (drawer) layout the list seeds closed, so open it first; selecting a
    // member must then slide it shut.
    const restore = stubNarrowLayout();
    try {
      const shell = build();
      shell.store.activeRoomId.set('!r:hs');
      shell.store.membersOpen.set(true);
      expect(shell.store.membersOpen()).toBe(true);

      shell.members.onSelectMember({
        userId: '@bob:hs',
        name: 'Bob',
        initial: 'B',
        avatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      });

      expect(shell.store.membersOpen()).toBe(false);
      expect(memberInfoOpen).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('keeps the members column open when a member is selected on the wide layout', () => {
    // The base matchMedia stub reports non-drawer (matches:false) — i.e. the wide
    // static column, the desktop-protected path. onSelectMember must NOT collapse it.
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    shell.store.membersOpen.set(true);

    shell.members.onSelectMember({
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    });

    expect(shell.store.membersOpen()).toBe(true);
    expect(memberInfoOpen).toHaveBeenCalled();
  });

  it('opens no conversation when the member panel is dismissed', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    memberInfoOpen.mockResolvedValue(null); // dismissed

    shell.members.onSelectMember({
      userId: '@bob:hs',
      name: 'Bob',
      initial: 'B',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(memberInfoOpen).toHaveBeenCalled();
    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('invites the picked user to the active room and toasts success', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');

    await shell.rooms.onInviteToRoom();

    expect(inviteUser).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('captures an invite failure in spaceError without a success toast', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');
    inviteUser.mockReturnValue(throwError(() => new Error('forbidden')));

    await shell.rooms.onInviteToRoom();

    // runWithBusy records the message in spaceError (the shell's effect toasts it,
    // like the create-space path); no success toast on failure.
    expect(shell.status.error()).toBe('forbidden');
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('shows the user that failure, rather than only recording it', () => {
    // The sibling above asserts no toast — true only because nothing has flushed yet. The
    // page turns `status.error` into a danger toast from a constructor effect, and every
    // failure test in this file stopped at the signal, so deleting that effect outright
    // left all 192 tests green: the error was recorded and never shown. What was missing
    // was a flush AFTER the failure, not a rendered harness.
    const shell = build();
    shell.status.error.set('forbidden');

    TestBed.tick();

    expect(toastShow).toHaveBeenCalledWith(
      'forbidden',
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('does not invite when the picker is cancelled', async () => {
    const shell = build();
    shell.store.activeRoomId.set('!r:hs');
    pick.mockResolvedValue(null);

    await shell.rooms.onInviteToRoom();

    expect(inviteUser).not.toHaveBeenCalled();
  });

  it('invites to the active space from the sidebar action', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    pick.mockResolvedValue('@bob:hs');

    await shell.rooms.onInviteToSpace();

    expect(inviteUser).toHaveBeenCalledWith('!s:hs', '@bob:hs');
  });

  it('accepts a room invite (joins) and selects the joined room', () => {
    const shell = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isSpace: false })]);

    shell.invites.onAcceptInvite({ roomId: '!i:hs' });

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs', undefined);
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('leaves a room invite on a view that can actually show the room', () => {
    // Accepting used to force the Home view, which lists DIRECT MESSAGES ONLY since the
    // rail split — so the room you had just joined was invisible in the sidebar, and the
    // row count went DOWN. Recent activity is the default and lists everything; accepting
    // a non-DM room must not navigate away from it.
    const shell = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isDirect: false })]);
    expect(shell.store.recentView()).toBe(true);

    shell.invites.onAcceptInvite({ roomId: '!i:hs' });

    expect(shell.store.recentView()).toBe(true);
    expect(shell.store.activeRoomId()).toBe('!i:hs');
  });

  it('still lands a DM invite on the direct-message view', () => {
    // A DM is exactly what that view shows, so switching to it is right here.
    const shell = build();
    pending.set([pendingInvite({ roomId: '!d:hs', isDirect: true })]);

    shell.invites.onAcceptInvite({ roomId: '!d:hs' });

    expect(shell.store.recentView()).toBe(false);
    expect(shell.store.activeSpaceId()).toBeNull();
    expect(shell.store.activeRoomId()).toBe('!d:hs');
  });

  it('accepts a space invite without auto-selecting a room', () => {
    const shell = build();
    pending.set([pendingInvite({ roomId: '!s:hs', isSpace: true })]);

    shell.invites.onAcceptInvite({ roomId: '!s:hs' });

    expect(acceptInvite).toHaveBeenCalledWith('!s:hs', undefined);
    expect(shell.store.activeRoomId()).toBeNull(); // a space lands in the rail, not selected
  });

  it('declines an invite (leaves)', () => {
    const shell = build();

    shell.invites.onDeclineInvite({ roomId: '!i:hs' });

    expect(declineInvite).toHaveBeenCalledWith('!i:hs', undefined);
  });

  it('opens the new-chat action sheet on Home', async () => {
    const shell = build();
    const sheetOpen = TestBed.inject(TrnActionSheetService).open as ReturnType<
      typeof vi.fn
    >;

    shell.rooms.onNewChat();

    expect(sheetOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ text: 'Create a room' }),
          expect.objectContaining({ text: 'Explore public rooms' }),
          expect.objectContaining({ text: 'Start a direct message' }),
        ]),
      }),
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
    alertConfirm = vi.fn().mockResolvedValue(false);
    openSpace = vi.fn();
    joinRoom = vi.fn(() => of(undefined));
    removeRoomFromSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        ...SHARED_MOCKS,
        MockProvider(RoomsService, {
          rooms: signal<RoomSummary[]>([
            {
              id: '!c:hs',
              accountId: '@me:hs',
              accountIds: ['@me:hs'],
              name: 'general',
              initial: 'G',
              avatarMxc: null,
              topic: '',
              memberCount: 0,
              encrypted: false,
              unreadCount: 0,
              highlightCount: 0,
              hasUnread: false,
              markedUnread: false,
              lastMessage: '',
              activityTs: 0,
              favourite: false,
              lowPriority: false,
            },
          ]),
        }),
        MockProvider(SpacesService, {
          openSpace,
          joinRoom,
          removeRoomFromSpace,
          spaces: signal<SpaceSummary[]>([
            {
              id: '!s:hs',
              accountId: '@me:hs',
              name: 'My Space',
              initial: 'M',
              avatarMxc: null,
              childRoomIds: [],
            },
          ]),
        }),
        MockProvider(TimelineService),
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
        MockProvider(MessageSearchService),
        MockProvider(AuthService),
        MockProvider(TrnDialogService),
        MockProvider(TrnAlertService, { confirm: alertConfirm }),
        MockProvider(TrnToastService),
      ],
    });
    return shellFrom();
  }

  it('loads the hierarchy when a space is selected (and clears it for Home)', () => {
    const shell = build();

    shell.nav.onSelectSpace('!s:hs');
    expect(shell.store.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');

    shell.nav.onSelectSpace(null);
    expect(openSpace).toHaveBeenLastCalledWith(null);
  });

  it('joins a not-yet-joined child through its via servers', () => {
    const shell = build();

    shell.spaces.onJoinChild(
      childRoom({ roomId: '!x:hs', via: ['hs.example'] }),
    );

    expect(joinRoom).toHaveBeenCalledWith('!x:hs', ['hs.example']);
  });

  it('confirms then removes a joined child from the active space', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await shell.spaces.onRemoveFromSpace('!c:hs');

    // The confirmation names the channel and the space.
    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ header: 'Remove from space' }),
    );
    expect(removeRoomFromSpace).toHaveBeenCalledWith('!s:hs', '!c:hs');
  });

  it('does not remove when the confirm is cancelled', async () => {
    const shell = build();
    shell.store.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await shell.spaces.onRemoveFromSpace('!c:hs');

    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to remove on Home (no active space)', async () => {
    const shell = build();
    shell.store.activeSpaceId.set(null);

    await shell.spaces.onRemoveFromSpace('!c:hs');

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });
});

// The quick switcher (Ctrl/Cmd+K) presents a modal and, on a selection, jumps per
// kind: room/dm open the room, space selects it in the rail, a directory person
// opens a DM, an invite runs the page's accept path.
