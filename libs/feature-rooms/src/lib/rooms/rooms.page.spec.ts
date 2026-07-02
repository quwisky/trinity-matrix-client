import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  AuthService,
  CryptoService,
  InvitesService,
  MatrixClientService,
  MediaService,
  RoomsService,
  SpacesService,
  ThreadsService,
  TimelineService,
  type PendingInvite,
  type RoomSummary,
  type SpaceChildRoom,
  type SpaceSummary,
} from '@trinity/core';
import {
  TrnActionSheetService,
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/ui-spartan';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { UserPickerService } from '../user-picker/user-picker.service';
import { QuickSwitcherService } from '../quick-switcher/quick-switcher.service';
import { MessageSearchService } from '../message-search/message-search.service';

/** Default InvitesService mock: empty model + join/leave stubs. */
function invitesProvider(over: Partial<Record<string, unknown>> = {}) {
  return {
    provide: InvitesService,
    useValue: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      pendingInvites: signal<PendingInvite[]>([]),
      acceptInvite: vi.fn(() => of(undefined)),
      declineInvite: vi.fn(() => of(undefined)),
      ...over,
    },
  };
}

// Instantiate the page through DI without rendering (the shell template pulls in
// many child components); we only exercise the action handlers' error feedback.
describe('RoomsPage action error feedback', () => {
  let edit: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;
  let sendMedia: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    toastShow = vi.fn();
    edit = vi.fn();
    sendMedia = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        { provide: RoomsService, useValue: { connect: vi.fn() } },
        {
          provide: SpacesService,
          useValue: { connect: vi.fn(), openSpace: vi.fn() },
        },
        {
          provide: TimelineService,
          useValue: {
            edit,
            sendMedia,
            redact: vi.fn(() => of(undefined)),
            toggleReaction: vi.fn(() => of(undefined)),
            reply: vi.fn(() => of(undefined)),
            close: vi.fn(),
          },
        },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs' },
          },
        },
        {
          provide: CryptoService,
          useValue: { connect: vi.fn(), status: signal('ready') },
        },
        {
          provide: ThreadsService,
          useValue: {
            open: vi.fn(),
            close: vi.fn(),
            closeThread: vi.fn(),
            summaries: signal({}),
          },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        { provide: TrnToastService, useValue: { show: toastShow } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('shows a danger toast when an edit fails', () => {
    const page = build();
    edit.mockReturnValue(throwError(() => new Error('nope')));

    page.onEdit({ id: '$1', body: 'x' });

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('does not toast when the action succeeds', () => {
    const page = build();
    edit.mockReturnValue(of(undefined));

    page.onEdit({ id: '$1', body: 'x' });

    expect(toastShow).not.toHaveBeenCalled();
  });

  it('opens the threads-list panel for the active room', () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    const panel = TestBed.inject(ThreadPanelService);

    page.openThreadsList();

    expect(panel.openList).toHaveBeenCalledWith('!r:hs');
  });

  it('does not open the threads-list panel without an active room', () => {
    const page = build();
    page.activeRoomId.set(null);
    const panel = TestBed.inject(ThreadPanelService);

    page.openThreadsList();

    expect(panel.openList).not.toHaveBeenCalled();
  });

  const pngFile = () =>
    new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' });

  it('drives uploadProgress 0 → fraction → null over a successful media send', () => {
    const page = build(); // build() (re)creates the sendMedia mock — set it after
    const stream = new Subject<void>();
    let progressCb: ((fraction: number) => void) | undefined;
    sendMedia.mockImplementation(
      (_file: File, cb?: (fraction: number) => void) => {
        progressCb = cb;
        return stream.asObservable();
      },
    );

    page.onSendMedia(pngFile());
    expect(page.uploadProgress()).toBe(0); // reset to 0 on start

    progressCb?.(0.5);
    expect(page.uploadProgress()).toBe(0.5); // tracks the upload fraction

    stream.complete();
    expect(page.uploadProgress()).toBeNull(); // cleared by finalize on success
    expect(toastShow).not.toHaveBeenCalled(); // no error toast
  });

  it('clears uploadProgress and toasts when a media send fails', () => {
    const page = build();
    const stream = new Subject<void>();
    sendMedia.mockReturnValue(stream.asObservable());

    page.onSendMedia(pngFile());
    expect(page.uploadProgress()).toBe(0);

    stream.error(new Error('upload failed'));

    expect(page.uploadProgress()).toBeNull(); // finalize clears on error too
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });
});

// The channel sidebar is fed by `visibleRooms()`: Home shows every room (recency
// order), a selected space shows only its joined children in space order.
describe('RoomsPage space filtering', () => {
  function roomSummary(id: string, name: string): RoomSummary {
    return {
      id,
      name,
      initial: name[0].toUpperCase(),
      avatarMxc: null,
      topic: '',
      memberCount: 0,
      encrypted: false,
      unreadCount: 0,
      highlightCount: 0,
      hasUnread: false,
      activityTs: 0,
    };
  }

  function spaceSummary(id: string, childRoomIds: string[]): SpaceSummary {
    return { id, name: id, initial: 'S', avatarMxc: null, childRoomIds };
  }

  function build(): RoomsPage {
    // Home recency order is c, a, b; the space orders its children a, b.
    const rooms = [
      roomSummary('!c:hs', 'charlie'),
      roomSummary('!a:hs', 'alpha'),
      roomSummary('!b:hs', 'bravo'),
    ];
    const childRoomIds = vi.fn((id: string | null) =>
      id === '!s:hs' ? ['!a:hs', '!b:hs'] : [],
    );
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal(rooms),
            revision: signal(0),
            membersOf: () => [],
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal([spaceSummary('!s:hs', ['!a:hs', '!b:hs'])]),
            childRoomIds,
          },
        },
        { provide: TimelineService, useValue: { close: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('Home (no space) shows every room in the rooms-service order', () => {
    const page = build();
    page.activeSpaceId.set(null);

    expect(page.visibleRooms().map((r) => r.id)).toEqual([
      '!c:hs',
      '!a:hs',
      '!b:hs',
    ]);
    expect(page.activeSpaceName()).toBe('Home');
  });

  it('a selected space shows only its joined children, in space order', () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');

    // '!c:hs' is excluded (not a child); a/b appear in the space's order.
    expect(page.visibleRooms().map((r) => r.id)).toEqual(['!a:hs', '!b:hs']);
    expect(page.activeSpaceName()).toBe('!s:hs');
  });
});

// Create-space / create-channel / leave-space: the page prompts via TrnAlertService
// and delegates to SpacesService, handling the success navigation + error state.
describe('RoomsPage space actions', () => {
  let alertPrompt: ReturnType<typeof vi.fn>;
  let alertConfirm: ReturnType<typeof vi.fn>;
  let createSpace: ReturnType<typeof vi.fn>;
  let createRoomInSpace: ReturnType<typeof vi.fn>;
  let leaveSpace: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    alertPrompt = vi.fn().mockResolvedValue(null);
    alertConfirm = vi.fn().mockResolvedValue(false);
    createSpace = vi.fn(() => of('!new:hs'));
    createRoomInSpace = vi.fn(() => of('!room:hs'));
    leaveSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        { provide: RoomsService, useValue: { connect: vi.fn() } },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal<SpaceSummary[]>([]),
            childRoomIds: () => [],
            createSpace,
            createRoomInSpace,
            leaveSpace,
          },
        },
        { provide: TimelineService, useValue: { close: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        {
          provide: TrnAlertService,
          useValue: { confirm: alertConfirm, prompt: alertPrompt },
        },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('creates a space and selects it on success', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('My Space');

    await page.onCreateSpace();

    expect(createSpace).toHaveBeenCalledWith({ name: 'My Space' });
    expect(page.activeSpaceId()).toBe('!new:hs');
  });

  it('does not create a space for an empty name', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('   ');

    await page.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('does not create a space when the prompt is cancelled', async () => {
    const page = build();
    alertPrompt.mockResolvedValue(null);

    await page.onCreateSpace();

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('surfaces a create-space failure in spaceError', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('My Space');
    createSpace.mockReturnValue(throwError(() => new Error('boom')));

    await page.onCreateSpace();

    expect(page.spaceError()).toBe('boom');
    expect(page.activeSpaceId()).toBeNull(); // not selected on failure
  });

  it('creates a channel in the active space', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertPrompt.mockResolvedValue('general');

    await page.onCreateChannel();

    expect(createRoomInSpace).toHaveBeenCalledWith('!s:hs', {
      name: 'general',
    });
  });

  it('does not prompt to create a channel on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onCreateChannel();

    expect(alertPrompt).not.toHaveBeenCalled();
    expect(createRoomInSpace).not.toHaveBeenCalled();
  });

  it('leaves the active space and returns to Home on success', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await page.onLeaveSpace();

    expect(leaveSpace).toHaveBeenCalledWith('!s:hs');
    expect(page.activeSpaceId()).toBeNull();
  });

  it('does not leave when the confirm is cancelled', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await page.onLeaveSpace();

    expect(leaveSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to leave on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onLeaveSpace();

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(leaveSpace).not.toHaveBeenCalled();
  });
});

// Room / DM creation, invites, and accept/decline. The page picks a user (modal),
// prompts for a name (alert), or reads a pending invite, then delegates to the
// services and handles selection + success/error toasts.
describe('RoomsPage room / DM / invite actions', () => {
  let alertPrompt: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;
  let pick: ReturnType<typeof vi.fn>;
  let createRoom: ReturnType<typeof vi.fn>;
  let createDirectMessage: ReturnType<typeof vi.fn>;
  let inviteUser: ReturnType<typeof vi.fn>;
  let acceptInvite: ReturnType<typeof vi.fn>;
  let declineInvite: ReturnType<typeof vi.fn>;
  let pending: WritableSignal<PendingInvite[]>;

  function pendingInvite(over: Partial<PendingInvite> = {}): PendingInvite {
    return {
      roomId: '!i:hs',
      name: 'Invited',
      initial: 'I',
      avatarMxc: null,
      inviterName: 'Alice',
      isSpace: false,
      isDirect: false,
      ...over,
    };
  }

  function build(): RoomsPage {
    alertPrompt = vi.fn().mockResolvedValue(null);
    toastShow = vi.fn();
    pick = vi.fn();
    createRoom = vi.fn(() => of('!room:hs'));
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    inviteUser = vi.fn(() => of(undefined));
    acceptInvite = vi.fn(() => of(undefined));
    declineInvite = vi.fn(() => of(undefined));
    pending = signal<PendingInvite[]>([]);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal<RoomSummary[]>([]),
            revision: signal(0),
            membersOf: () => [],
            createRoom,
            createDirectMessage,
            inviteUser,
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace: vi.fn(),
            spaces: signal<SpaceSummary[]>([]),
            childRoomIds: () => [],
          },
        },
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
          declineInvite,
        }),
        { provide: UserPickerService, useValue: { pick } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        {
          provide: TimelineService,
          useValue: { open: vi.fn(), close: vi.fn() },
        },
        { provide: MediaService, useValue: { releaseAll: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { open: vi.fn(), close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        {
          provide: TrnAlertService,
          useValue: { confirm: vi.fn(), prompt: alertPrompt },
        },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        { provide: TrnToastService, useValue: { show: toastShow } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('creates an encrypted room from the name prompt and selects it', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('general');

    await page.onCreateRoom();

    expect(createRoom).toHaveBeenCalledWith({ name: 'general' });
    expect(page.activeRoomId()).toBe('!room:hs');
  });

  it('does not create a room for an empty name', async () => {
    const page = build();
    alertPrompt.mockResolvedValue('   ');

    await page.onCreateRoom();

    expect(createRoom).not.toHaveBeenCalled();
  });

  it('starts a DM with the picked user and selects the DM room', async () => {
    const page = build();
    pick.mockResolvedValue('@bob:hs');

    await page.onStartDm();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(page.activeRoomId()).toBe('!dm:hs');
  });

  it('does not start a DM when the picker is cancelled', async () => {
    const page = build();
    pick.mockResolvedValue(null);

    await page.onStartDm();

    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it('invites the picked user to the active room and toasts success', async () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');

    await page.onInviteToRoom();

    expect(inviteUser).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('captures an invite failure in spaceError without a success toast', async () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    pick.mockResolvedValue('@bob:hs');
    inviteUser.mockReturnValue(throwError(() => new Error('forbidden')));

    await page.onInviteToRoom();

    // runWithBusy records the message in spaceError (the shell's effect toasts it,
    // like the create-space path); no success toast on failure.
    expect(page.spaceError()).toBe('forbidden');
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('does not invite when the picker is cancelled', async () => {
    const page = build();
    page.activeRoomId.set('!r:hs');
    pick.mockResolvedValue(null);

    await page.onInviteToRoom();

    expect(inviteUser).not.toHaveBeenCalled();
  });

  it('invites to the active space from the sidebar action', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    pick.mockResolvedValue('@bob:hs');

    await page.onInviteToSpace();

    expect(inviteUser).toHaveBeenCalledWith('!s:hs', '@bob:hs');
  });

  it('accepts a room invite (joins) and selects the joined room', () => {
    const page = build();
    pending.set([pendingInvite({ roomId: '!i:hs', isSpace: false })]);

    page.onAcceptInvite('!i:hs');

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs');
    expect(page.activeSpaceId()).toBeNull();
    expect(page.activeRoomId()).toBe('!i:hs');
  });

  it('accepts a space invite without auto-selecting a room', () => {
    const page = build();
    pending.set([pendingInvite({ roomId: '!s:hs', isSpace: true })]);

    page.onAcceptInvite('!s:hs');

    expect(acceptInvite).toHaveBeenCalledWith('!s:hs');
    expect(page.activeRoomId()).toBeNull(); // a space lands in the rail, not selected
  });

  it('declines an invite (leaves)', () => {
    const page = build();

    page.onDeclineInvite('!i:hs');

    expect(declineInvite).toHaveBeenCalledWith('!i:hs');
  });

  it('opens the new-chat action sheet on Home', async () => {
    const page = build();
    const sheetOpen = TestBed.inject(TrnActionSheetService).open as ReturnType<
      typeof vi.fn
    >;

    page.onNewChat();

    expect(sheetOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ text: 'Create a room' }),
          expect.objectContaining({ text: 'Start a direct message' }),
        ]),
      }),
    );
  });
});

// Selecting a space loads its hierarchy; joining a not-yet-joined child and
// removing a joined child delegate to SpacesService (the live read model + sync
// surface the result, so the page only fires the SDK-backed call).
describe('RoomsPage space hierarchy actions', () => {
  let alertConfirm: ReturnType<typeof vi.fn>;
  let openSpace: ReturnType<typeof vi.fn>;
  let joinRoom: ReturnType<typeof vi.fn>;
  let removeRoomFromSpace: ReturnType<typeof vi.fn>;

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

  function build(): RoomsPage {
    alertConfirm = vi.fn().mockResolvedValue(false);
    openSpace = vi.fn();
    joinRoom = vi.fn(() => of(undefined));
    removeRoomFromSpace = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal<RoomSummary[]>([
              {
                id: '!c:hs',
                name: 'general',
                initial: 'G',
                avatarMxc: null,
                topic: '',
                memberCount: 0,
                encrypted: false,
                unreadCount: 0,
                highlightCount: 0,
                hasUnread: false,
                activityTs: 0,
              },
            ]),
            revision: signal(0),
            membersOf: () => [],
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace,
            joinRoom,
            removeRoomFromSpace,
            spaces: signal<SpaceSummary[]>([
              {
                id: '!s:hs',
                name: 'My Space',
                initial: 'M',
                avatarMxc: null,
                childRoomIds: [],
              },
            ]),
            childRoomIds: () => [],
            notJoinedRooms: signal<SpaceChildRoom[]>([]),
            childSpaces: signal<SpaceChildRoom[]>([]),
            childrenLoading: signal(false),
            childrenError: signal<string | null>(null),
          },
        },
        { provide: TimelineService, useValue: { close: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        invitesProvider(),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick: vi.fn() } },
        { provide: MessageSearchService, useValue: { search: vi.fn() } },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: () => false } },
        {
          provide: TrnAlertService,
          useValue: { confirm: alertConfirm, prompt: vi.fn() },
        },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('loads the hierarchy when a space is selected (and clears it for Home)', () => {
    const page = build();

    page.onSelectSpace('!s:hs');
    expect(page.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');

    page.onSelectSpace(null);
    expect(openSpace).toHaveBeenLastCalledWith(null);
  });

  it('joins a not-yet-joined child through its via servers', () => {
    const page = build();

    page.onJoinChild(childRoom({ roomId: '!x:hs', via: ['hs.example'] }));

    expect(joinRoom).toHaveBeenCalledWith('!x:hs', ['hs.example']);
  });

  it('confirms then removes a joined child from the active space', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(true);

    await page.onRemoveFromSpace('!c:hs');

    // The confirmation names the channel and the space.
    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ header: 'Remove from space' }),
    );
    expect(removeRoomFromSpace).toHaveBeenCalledWith('!s:hs', '!c:hs');
  });

  it('does not remove when the confirm is cancelled', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');
    alertConfirm.mockResolvedValue(false);

    await page.onRemoveFromSpace('!c:hs');

    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });

  it('does not prompt to remove on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onRemoveFromSpace('!c:hs');

    expect(alertConfirm).not.toHaveBeenCalled();
    expect(removeRoomFromSpace).not.toHaveBeenCalled();
  });
});

// The quick switcher (Ctrl/Cmd+K) presents a modal and, on a selection, jumps per
// kind: room/dm open the room, space selects it in the rail, a directory person
// opens a DM, an invite runs the page's accept path.
describe('RoomsPage quick switcher', () => {
  let pick: ReturnType<typeof vi.fn>;
  let messageSearch: ReturnType<typeof vi.fn>;
  let createDirectMessage: ReturnType<typeof vi.fn>;
  let acceptInvite: ReturnType<typeof vi.fn>;
  let openSpace: ReturnType<typeof vi.fn>;
  let timelineOpen: ReturnType<typeof vi.fn>;
  let pending: WritableSignal<PendingInvite[]>;
  let dialogHasOpen: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    pick = vi.fn();
    messageSearch = vi.fn();
    createDirectMessage = vi.fn(() => of('!dm:hs'));
    acceptInvite = vi.fn(() => of(undefined));
    openSpace = vi.fn();
    timelineOpen = vi.fn();
    pending = signal<PendingInvite[]>([]);
    dialogHasOpen = vi.fn().mockReturnValue(false);
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        {
          provide: RoomsService,
          useValue: {
            connect: vi.fn(),
            rooms: signal<RoomSummary[]>([]),
            revision: signal(0),
            membersOf: () => [],
            createDirectMessage,
          },
        },
        {
          provide: SpacesService,
          useValue: {
            connect: vi.fn(),
            openSpace,
            spaces: signal<SpaceSummary[]>([]),
            childRoomIds: () => [],
          },
        },
        invitesProvider({
          pendingInvites: pending,
          acceptInvite,
        }),
        { provide: UserPickerService, useValue: { pick: vi.fn() } },
        { provide: QuickSwitcherService, useValue: { pick } },
        {
          provide: MessageSearchService,
          useValue: { search: messageSearch },
        },
        {
          provide: TimelineService,
          useValue: { open: timelineOpen, close: vi.fn() },
        },
        { provide: MediaService, useValue: { releaseAll: vi.fn() } },
        {
          provide: MatrixClientService,
          useValue: {
            isInitialized: true,
            instance: { getUserId: () => '@me:hs', getUser: () => null },
          },
        },
        { provide: CryptoService, useValue: { connect: vi.fn() } },
        {
          provide: ThreadsService,
          useValue: { open: vi.fn(), close: vi.fn(), closeThread: vi.fn() },
        },
        {
          provide: ThreadPanelService,
          useValue: { open: vi.fn(), openList: vi.fn() },
        },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: TrnDialogService, useValue: { hasOpen: dialogHasOpen } },
        {
          provide: TrnAlertService,
          useValue: { confirm: vi.fn(), prompt: vi.fn() },
        },
        { provide: TrnActionSheetService, useValue: { open: vi.fn() } },
        { provide: TrnToastService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('opens the selected room', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'room', id: '!r:hs' });

    await page.openSwitcher();

    expect(page.activeRoomId()).toBe('!r:hs');
    expect(timelineOpen).toHaveBeenCalledWith('!r:hs');
  });

  it('opens a DM result like a room', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'dm', id: '!d:hs' });

    await page.openSwitcher();

    expect(page.activeRoomId()).toBe('!d:hs');
  });

  it('selects a space in the rail (loading its hierarchy)', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'space', id: '!s:hs' });

    await page.openSwitcher();

    expect(page.activeSpaceId()).toBe('!s:hs');
    expect(openSpace).toHaveBeenCalledWith('!s:hs');
    expect(page.activeRoomId()).toBeNull();
  });

  it('opens (or reuses) a DM for a directory person', async () => {
    const page = build();
    pick.mockResolvedValue({ kind: 'user', id: '@bob:hs' });

    await page.openSwitcher();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(page.activeRoomId()).toBe('!dm:hs');
  });

  it('runs the accept path for an invite result', async () => {
    const page = build();
    pending.set([
      {
        roomId: '!i:hs',
        name: 'Invited',
        initial: 'I',
        avatarMxc: null,
        inviterName: 'Alice',
        isSpace: false,
        isDirect: false,
      },
    ]);
    pick.mockResolvedValue({ kind: 'invite', id: '!i:hs' });

    await page.openSwitcher();

    expect(acceptInvite).toHaveBeenCalledWith('!i:hs');
    expect(page.activeRoomId()).toBe('!i:hs');
  });

  it('does nothing when the switcher is cancelled', async () => {
    const page = build();
    pick.mockResolvedValue(null);

    await page.openSwitcher();

    expect(page.activeRoomId()).toBeNull();
    expect(timelineOpen).not.toHaveBeenCalled();
  });

  it('Ctrl/Cmd+K prevents default and opens the switcher', async () => {
    const page = build();
    pick.mockResolvedValue(null);
    const preventDefault = vi.fn();

    page.onQuickSwitch({ preventDefault } as unknown as KeyboardEvent);

    expect(preventDefault).toHaveBeenCalled(); // sync — stops the browser's Cmd+K
    await new Promise((resolve) => setTimeout(resolve)); // settle the async openSwitcher()
    expect(pick).toHaveBeenCalled();
  });

  it('does not open the switcher over an existing overlay', async () => {
    const page = build();
    dialogHasOpen.mockReturnValue(true);

    await page.openSwitcher();

    // A thread/search/verification modal owns the screen — the switcher must not
    // stack over it (picking a result would releaseAll() its pinned media).
    expect(pick).not.toHaveBeenCalled();
  });

  it('opens in-room message search for the active room and jumps to the hit', async () => {
    const page = build();
    page.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue('$evt:hs');

    await page.openMessageSearch();

    expect(messageSearch).toHaveBeenCalledWith('!r:hs');
    expect(page.messageSearchTarget()).toBe('$evt:hs');
  });

  it('does not jump when in-room search is cancelled', async () => {
    const page = build();
    page.onSelectRoom('!r:hs');
    messageSearch.mockResolvedValue(null);

    await page.openMessageSearch();

    expect(page.messageSearchTarget()).toBeNull();
  });

  it('does not open in-room search when no room is active', async () => {
    const page = build();
    messageSearch.mockResolvedValue('$evt:hs');

    await page.openMessageSearch();

    expect(messageSearch).not.toHaveBeenCalled();
    expect(page.messageSearchTarget()).toBeNull();
  });
});
