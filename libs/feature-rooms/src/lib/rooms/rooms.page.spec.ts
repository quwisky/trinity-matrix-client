import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  ActionSheetController,
  AlertController,
  MenuController,
  ToastController,
} from '@ionic/angular/standalone';
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
  type SpaceSummary,
} from '@trinity/core';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomsPage } from './rooms.page';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { UserPickerService } from '../user-picker/user-picker.service';

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
  let create: ReturnType<typeof vi.fn>;
  let sendMedia: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    const present = vi.fn().mockResolvedValue(undefined);
    create = vi.fn().mockResolvedValue({ present });
    edit = vi.fn();
    sendMedia = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        RoomsPage,
        { provide: RoomsService, useValue: { connect: vi.fn() } },
        { provide: SpacesService, useValue: { connect: vi.fn() } },
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
        { provide: ActionSheetController, useValue: { create: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: MenuController, useValue: { close: vi.fn() } },
        { provide: ToastController, useValue: { create } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  it('shows a danger toast when an edit fails', () => {
    const page = build();
    edit.mockReturnValue(throwError(() => new Error('nope')));

    page.onEdit({ id: '$1', body: 'x' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'danger' }),
    );
  });

  it('does not toast when the action succeeds', () => {
    const page = build();
    edit.mockReturnValue(of(undefined));

    page.onEdit({ id: '$1', body: 'x' });

    expect(create).not.toHaveBeenCalled();
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
    expect(create).not.toHaveBeenCalled(); // no error toast
  });

  it('clears uploadProgress and toasts when a media send fails', () => {
    const page = build();
    const stream = new Subject<void>();
    sendMedia.mockReturnValue(stream.asObservable());

    page.onSendMedia(pngFile());
    expect(page.uploadProgress()).toBe(0);

    stream.error(new Error('upload failed'));

    expect(page.uploadProgress()).toBeNull(); // finalize clears on error too
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'danger' }),
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
        { provide: ActionSheetController, useValue: { create: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: MenuController, useValue: { close: vi.fn() } },
        { provide: ToastController, useValue: { create: vi.fn() } },
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

// Create-space / create-channel / leave-space: the page prompts via AlertController
// and delegates to SpacesService, handling the success navigation + error state.
describe('RoomsPage space actions', () => {
  interface AlertButton {
    text: string;
    handler?: (data?: unknown) => unknown;
  }
  let create: ReturnType<typeof vi.fn>;
  let createSpace: ReturnType<typeof vi.fn>;
  let createRoomInSpace: ReturnType<typeof vi.fn>;
  let leaveSpace: ReturnType<typeof vi.fn>;

  function build(): RoomsPage {
    const present = vi.fn().mockResolvedValue(undefined);
    create = vi.fn().mockResolvedValue({ present });
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
        { provide: ActionSheetController, useValue: { create: vi.fn() } },
        {
          provide: AuthService,
          useValue: { logout: vi.fn(() => of(undefined)) },
        },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
        { provide: MenuController, useValue: { close: vi.fn() } },
        { provide: AlertController, useValue: { create } },
        {
          provide: ToastController,
          useValue: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) },
        },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  /** Invoke the most recent alert's button handler by label (simulating a tap). */
  function tapButton(text: string, data?: unknown): void {
    const opts = create.mock.calls.at(-1)?.[0] as { buttons: AlertButton[] };
    opts.buttons.find((b) => b.text === text)?.handler?.(data);
  }

  it('creates a space and selects it on success', async () => {
    const page = build();

    await page.onCreateSpace();
    tapButton('Create', { name: 'My Space' });

    expect(createSpace).toHaveBeenCalledWith({ name: 'My Space' });
    expect(page.activeSpaceId()).toBe('!new:hs');
  });

  it('does not create a space for an empty name', async () => {
    const page = build();

    await page.onCreateSpace();
    tapButton('Create', { name: '   ' });

    expect(createSpace).not.toHaveBeenCalled();
  });

  it('surfaces a create-space failure in spaceError', async () => {
    const page = build();
    createSpace.mockReturnValue(throwError(() => new Error('boom')));

    await page.onCreateSpace();
    tapButton('Create', { name: 'My Space' });

    expect(page.spaceError()).toBe('boom');
    expect(page.activeSpaceId()).toBeNull(); // not selected on failure
  });

  it('creates a channel in the active space', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');

    await page.onCreateChannel();
    tapButton('Create', { name: 'general' });

    expect(createRoomInSpace).toHaveBeenCalledWith('!s:hs', {
      name: 'general',
    });
  });

  it('does not prompt to create a channel on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onCreateChannel();

    expect(create).not.toHaveBeenCalled();
    expect(createRoomInSpace).not.toHaveBeenCalled();
  });

  it('leaves the active space and returns to Home on success', async () => {
    const page = build();
    page.activeSpaceId.set('!s:hs');

    await page.onLeaveSpace();
    tapButton('Leave');

    expect(leaveSpace).toHaveBeenCalledWith('!s:hs');
    expect(page.activeSpaceId()).toBeNull();
  });

  it('does not prompt to leave on Home (no active space)', async () => {
    const page = build();
    page.activeSpaceId.set(null);

    await page.onLeaveSpace();

    expect(create).not.toHaveBeenCalled();
    expect(leaveSpace).not.toHaveBeenCalled();
  });
});

// Room / DM creation, invites, and accept/decline. The page picks a user (modal),
// prompts for a name (alert), or reads a pending invite, then delegates to the
// services and handles selection + success/error toasts.
describe('RoomsPage room / DM / invite actions', () => {
  interface AlertButton {
    text: string;
    handler?: (data?: unknown) => unknown;
  }
  let alertCreate: ReturnType<typeof vi.fn>;
  let toastCreate: ReturnType<typeof vi.fn>;
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
    alertCreate = vi
      .fn()
      .mockResolvedValue({ present: vi.fn().mockResolvedValue(undefined) });
    toastCreate = vi
      .fn()
      .mockResolvedValue({ present: vi.fn().mockResolvedValue(undefined) });
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
        { provide: MenuController, useValue: { close: vi.fn() } },
        { provide: AlertController, useValue: { create: alertCreate } },
        { provide: ActionSheetController, useValue: { create: vi.fn() } },
        { provide: ToastController, useValue: { create: toastCreate } },
      ],
    });
    return TestBed.inject(RoomsPage);
  }

  function tapAlert(text: string, data?: unknown): void {
    const opts = alertCreate.mock.calls.at(-1)?.[0] as {
      buttons: AlertButton[];
    };
    opts.buttons.find((b) => b.text === text)?.handler?.(data);
  }

  it('creates an encrypted room from the name prompt and selects it', async () => {
    const page = build();

    await page.onCreateRoom();
    tapAlert('Create', { name: 'general' });

    expect(createRoom).toHaveBeenCalledWith({ name: 'general' });
    expect(page.activeRoomId()).toBe('!room:hs');
  });

  it('does not create a room for an empty name', async () => {
    const page = build();

    await page.onCreateRoom();
    tapAlert('Create', { name: '   ' });

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
    expect(toastCreate).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'success' }),
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
    expect(toastCreate).not.toHaveBeenCalled();
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
    const sheetCreate = TestBed.inject(ActionSheetController)
      .create as ReturnType<typeof vi.fn>;
    sheetCreate.mockResolvedValue({ present: vi.fn() });

    await page.onNewChat();

    expect(sheetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.objectContaining({ text: 'Create a room' }),
          expect.objectContaining({ text: 'Start a direct message' }),
        ]),
      }),
    );
  });
});
