import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import {
  InvitesService,
  MixedInvitesService,
  type PendingInvite,
} from '@trinity/data-access-invites';
import {
  PresenceService,
  type UserProfile,
} from '@trinity/data-access-profile';
import {
  AccountScopeService,
  RoomsService,
  SpacesService,
  TRINITY_ROOM_SORTS,
  type RoomSortMode,
  type RoomSummary,
  type SpaceChildRoom,
} from '@trinity/data-access-rooms';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access-notifications';
import { type PresenceState } from '@trinity/util-matrix';
import {
  ChannelSidebarComponent,
  type AccountSummary,
} from './channel-sidebar.component';

// Stub presence: @bob is online, everyone else offline.
const presenceStub = {
  presenceFor: (userId: string) =>
    signal<PresenceState>(userId === '@bob:hs' ? 'online' : 'offline'),
};

function room(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: '!a:hs',
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
    lastMessage: '',
    activityTs: 0,
    favourite: false,
    ...over,
  };
}

function invite(over: Partial<PendingInvite> = {}): PendingInvite {
  return {
    roomId: '!i:hs',
    name: 'Invited Room',
    initial: 'I',
    avatarMxc: null,
    inviterName: 'Alice',
    isSpace: false,
    isDirect: false,
    ...over,
  };
}

function child(over: Partial<SpaceChildRoom> = {}): SpaceChildRoom {
  return {
    roomId: '!c:hs',
    name: 'announcements',
    initial: 'A',
    avatarMxc: null,
    memberCount: 4,
    joinRule: 'public',
    suggested: false,
    isSpace: false,
    via: ['hs.example'],
    joined: false,
    ...over,
  };
}

/**
 * Render the sidebar with its injected core services mocked. The space hierarchy
 * and invites now come from `SpacesService`/`InvitesService` signals (not inputs),
 * so tests seed and later mutate those signals directly.
 */
/** Spy behind RoomNotificationsService.modeFor, so tests can assert the account it was
 * asked about (a mixed-in row must be read from ITS account, not the active one). */
let modeForSpy: ReturnType<typeof vi.fn>;

async function renderSidebar(
  opts: {
    inputs?: {
      rooms?: RoomSummary[];
      spaceActive?: boolean;
      activeRoomId?: string | null;
      user?: UserProfile;
      accounts?: AccountSummary[];
      activeUserId?: string | null;
      reauthAccounts?: string[];
      sortMode?: RoomSortMode;
      sortOverridden?: boolean;
      defaultSortMode?: RoomSortMode;
    };
    joinableRooms?: SpaceChildRoom[];
    childSpaces?: SpaceChildRoom[];
    childrenLoading?: boolean;
    childrenError?: string | null;
    invites?: PendingInvite[];
    /** Cross-account invites, used instead of `invites` when `mixing` is true. */
    mixedInvites?: PendingInvite[];
    mixing?: boolean;
    notifyMode?: RoomNotifyMode;
  } = {},
) {
  modeForSpy = vi.fn(() => opts.notifyMode ?? 'all');
  const signals = {
    notJoinedRooms: signal<SpaceChildRoom[]>(opts.joinableRooms ?? []),
    childSpaces: signal<SpaceChildRoom[]>(opts.childSpaces ?? []),
    childrenLoading: signal(opts.childrenLoading ?? false),
    childrenError: signal<string | null>(opts.childrenError ?? null),
    pendingInvites: signal<PendingInvite[]>(opts.invites ?? []),
    mixedInvites: signal<PendingInvite[]>(opts.mixedInvites ?? []),
  };

  const rendered = await render(ChannelSidebarComponent, {
    inputs: opts.inputs ?? {},
    providers: [
      MockProvider(SpacesService, {
        notJoinedRooms: signals.notJoinedRooms,
        childSpaces: signals.childSpaces,
        childrenLoading: signals.childrenLoading,
        childrenError: signals.childrenError,
      }),
      MockProvider(InvitesService, { pendingInvites: signals.pendingInvites }),
      MockProvider(MixedInvitesService, { invites: signals.mixedInvites }),
      MockProvider(AccountScopeService, {
        mixing: signal(opts.mixing ?? false).asReadonly(),
      }),
      MockProvider(RoomsService),
      MockProvider(RoomNotificationsService, {
        modeFor: modeForSpy,
      }),
      { provide: PresenceService, useValue: presenceStub },
    ],
  });

  return { ...rendered, signals, roomsSvc: TestBed.inject(RoomsService) };
}

describe('ChannelSidebarComponent', () => {
  it('shows the DM counterpart’s presence, but no dot on a plain room', async () => {
    const { fixture } = await renderSidebar({
      inputs: {
        rooms: [
          room({ id: '!dm:hs', name: 'Bob', directUserId: '@bob:hs' }),
          room({ id: '!room:hs', name: 'general' }),
        ],
      },
    });
    const sidebar = fixture.componentInstance;
    // Presence tracks the DM's other participant; a non-DM room gets null (no dot).
    expect(sidebar.presenceOf(room({ directUserId: '@bob:hs' }))).toBe(
      'online',
    );
    expect(sidebar.presenceOf(room({ directUserId: '@carol:hs' }))).toBe(
      'offline',
    );
    expect(sidebar.presenceOf(room())).toBeNull();
    // The DM row actually renders a presence dot; the plain room does not.
    expect(
      fixture.nativeElement.querySelectorAll('.presence-dot'),
    ).toHaveLength(1);
  });

  it('lists rooms and emits selectRoom when one is clicked', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { rooms: [room()] },
    });

    const channels = container.querySelectorAll<HTMLElement>('.channel');
    expect(channels.length).toBe(1);
    expect(channels[0].textContent).toContain('general');

    let roomId: string | undefined;
    fixture.componentInstance.selectRoom.subscribe((id) => (roomId = id));
    channels[0].click();
    expect(roomId).toBe('!a:hs');
  });

  it('renders a messenger-style row: avatar, name, and last-message preview', async () => {
    const { container } = await renderSidebar({
      inputs: { rooms: [room({ name: 'general', lastMessage: 'hey there' })] },
    });

    const channel = container.querySelector('.channel')!;
    // Discord-style hash prefix is gone; a room avatar takes its place.
    expect(channel.querySelector('.channel__hash')).toBeNull();
    expect(channel.querySelector('trn-avatar')).not.toBeNull();
    expect(channel.querySelector('.channel__name')!.textContent).toContain(
      'general',
    );
    expect(channel.querySelector('.channel__preview')!.textContent).toContain(
      'hey there',
    );
  });

  it('omits the preview line when a room has no last message', async () => {
    const { container } = await renderSidebar({
      inputs: { rooms: [room({ lastMessage: '' })] },
    });

    expect(container.querySelector('.channel__preview')).toBeNull();
  });

  it('shows a mention count, a muted unread count, and caps at 99+', async () => {
    const { container } = await renderSidebar({
      inputs: {
        rooms: [
          room({
            id: '!m:hs',
            name: 'mentions',
            hasUnread: true,
            unreadCount: 5,
            highlightCount: 2,
          }),
          room({
            id: '!u:hs',
            name: 'unread',
            hasUnread: true,
            unreadCount: 128,
            highlightCount: 0,
          }),
          room({ id: '!r:hs', name: 'read' }),
        ],
      },
    });

    // The mention room shows the red mention badge with the highlight count.
    const mention = container.querySelector(
      '.channel__badge:not(.channel__badge--muted)',
    )!;
    expect(mention.textContent!.trim()).toBe('2');
    // The plain-unread room shows a muted count badge, capped Discord-style.
    const muted = container.querySelector('.channel__badge--muted')!;
    expect(muted.textContent!.trim()).toBe('99+');
    // No bare dots anymore — every unread room carries a count.
    expect(container.querySelectorAll('.channel__dot').length).toBe(0);
    expect(container.querySelectorAll('.channel.unread').length).toBe(2);
  });

  it('caps badgeLabel exactly at the 99/100 boundary', async () => {
    const { fixture } = await renderSidebar();

    expect(fixture.componentInstance.badgeLabel(99)).toBe('99');
    expect(fixture.componentInstance.badgeLabel(100)).toBe('99+');
  });

  it('shows the exact uncapped unread count on a muted badge', async () => {
    const { container } = await renderSidebar({
      inputs: {
        rooms: [
          room({
            id: '!u:hs',
            name: 'unread',
            hasUnread: true,
            unreadCount: 7,
            highlightCount: 0,
          }),
        ],
      },
    });

    const muted = container.querySelector('.channel__badge--muted')!;
    expect(muted.textContent!.trim()).toBe('7');
  });

  it('shows only the new-chat affordance on Home (no space actions)', async () => {
    // spaceActive defaults to false
    const { container } = await renderSidebar();

    // Space-only actions are hidden on Home; the new-room/DM "+" is present.
    expect(
      container.querySelector('[aria-label="Create a channel"]'),
    ).toBeNull();
    // Invite and Leave live in the space overflow, which Home does not render at all.
    expect(
      container.querySelector('[data-testid="space-actions-overflow"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="New room or direct message"]'),
    ).not.toBeNull();
  });

  it('keeps the space header to three buttons, whatever the unread state', async () => {
    // The whole point of the overflow: six buttons left the 280px sidebar's title about six
    // characters, and on touch (44px targets) they were wider than the sidebar itself. Both
    // unread states are rendered, because mark-all-read is the one conditional button and a
    // re-added header copy of it would only show up in one of them.
    const unread = await renderSidebar({
      inputs: {
        spaceActive: true,
        rooms: [room({ id: '!a:hs', name: 'general', hasUnread: true })],
      },
    });
    expect(
      unread.container.querySelectorAll('.sidebar__actions button'),
    ).toHaveLength(3);

    TestBed.resetTestingModule();
    const read = await renderSidebar({ inputs: { spaceActive: true } });
    expect(
      read.container.querySelectorAll('.sidebar__actions button'),
    ).toHaveLength(3);
  });

  it('offers mark-all-read in the overflow, and emits it', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: {
        spaceActive: true,
        rooms: [room({ id: '!a:hs', name: 'general', hasUnread: true })],
      },
    });
    let marked = false;
    fixture.componentInstance.markAllRead.subscribe(() => (marked = true));

    container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    fixture.detectChanges();

    const row = document.querySelector<HTMLElement>(
      '[data-testid="mark-all-read"]',
    );
    expect(row).not.toBeNull();
    row!.click();
    expect(marked).toBe(true);
  });

  // Its own test, not a second half of the one above: the assertion is a GLOBAL document
  // query, so sharing a test with an already-opened menu would let it read the first
  // render's leftover overlay instead of this one's.
  it('leaves mark-all-read out of the overflow when nothing is unread', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { spaceActive: true },
    });

    container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    fixture.detectChanges();

    expect(document.querySelector('[data-testid="mark-all-read"]')).toBeNull();
  });

  it('emits newChat from the Home "+" affordance', async () => {
    const { fixture, container } = await renderSidebar();

    let opened = false;
    fixture.componentInstance.newChat.subscribe(() => (opened = true));
    container
      .querySelector<HTMLElement>('[aria-label="New room or direct message"]')!
      .click();

    expect(opened).toBe(true);
  });

  it('shows the space actions and emits createRoom / inviteToSpace / leaveSpace', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { spaceActive: true },
    });

    let created = false;
    let invited = false;
    let left = false;
    fixture.componentInstance.createRoom.subscribe(() => (created = true));
    fixture.componentInstance.inviteToSpace.subscribe(() => (invited = true));
    fixture.componentInstance.leaveSpace.subscribe(() => (left = true));

    // Create stays out on the header; invite and leave moved into the overflow.
    container
      .querySelector<HTMLElement>('[aria-label="Create a channel"]')!
      .click();
    container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="space-invite"]')!
      .click();
    fixture.detectChanges();
    container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    fixture.detectChanges();
    document.querySelector<HTMLElement>('[data-testid="space-leave"]')!.click();

    expect(created).toBe(true);
    expect(invited).toBe(true);
    expect(left).toBe(true);
    // The Home affordance is hidden while a space is active.
    expect(
      container.querySelector('[aria-label="New room or direct message"]'),
    ).toBeNull();
  });

  it('emits openSpaceSettings from the overflow menu', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { spaceActive: true, canConfigureSpace: true },
    });

    let opened = false;
    fixture.componentInstance.openSpaceSettings.subscribe(
      () => (opened = true),
    );
    container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="open-space-settings"]')!
      .click();

    expect(opened).toBe(true);
  });

  it('hides space settings for another account\u2019s space', async () => {
    // Mixed mode: RoomSettingsService writes on the ACTIVE client, so the dialog would seed
    // blank and save to the wrong account. Leave and invite still show — those are the
    // pre-existing rows, unguarded today.
    const { fixture, container } = await renderSidebar({
      inputs: { spaceActive: true, canConfigureSpace: false },
    });

    container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    fixture.detectChanges();

    expect(
      document.querySelector('[data-testid="open-space-settings"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="space-leave"]'),
    ).not.toBeNull();
  });

  it('renders pending invites and emits accept / decline with the room id', async () => {
    const { fixture, container } = await renderSidebar({
      invites: [
        invite({ roomId: '!i:hs', name: 'Invited Room', inviterName: 'Alice' }),
      ],
    });

    const invites = container.querySelectorAll<HTMLElement>('.invite');
    expect(invites.length).toBe(1);
    expect(invites[0].textContent).toContain('Invited Room');
    expect(invites[0].textContent).toContain('Alice');

    let accepted: string | undefined;
    let declined: string | undefined;
    fixture.componentInstance.acceptInvite.subscribe(
      (e) => (accepted = e.roomId),
    );
    fixture.componentInstance.declineInvite.subscribe(
      (e) => (declined = e.roomId),
    );

    container.querySelector<HTMLElement>('.invite__btn.accept')!.click();
    container.querySelector<HTMLElement>('.invite__btn.decline')!.click();

    expect(accepted).toBe('!i:hs');
    expect(declined).toBe('!i:hs');
  });

  it('shows no Invites group when there are none', async () => {
    const { container } = await renderSidebar();

    expect(container.querySelector('.invite')).toBeNull();
  });

  it('emits logout from the account menu opened via the user bar', async () => {
    const { fixture, container } = await renderSidebar();

    let loggedOut = false;
    fixture.componentInstance.logout.subscribe(() => (loggedOut = true));

    // Open the account menu from the user-bar trigger, then trigger Log out
    // (the item lives in a CDK menu rendered into the overlay container).
    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();

    const logoutItem = document.querySelector<HTMLElement>(
      '[data-testid="logout"]',
    );
    expect(logoutItem).toBeTruthy();
    logoutItem?.click();

    expect(loggedOut).toBe(true);
  });

  it('lists accounts, marks the active one, and shows per-account unread', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: {
        accounts: [
          { userId: '@me:hs', displayName: 'Me', avatarMxc: null, unread: 0 },
          { userId: '@alt:hs', displayName: 'Alt', avatarMxc: null, unread: 3 },
        ],
        activeUserId: '@me:hs',
      },
    });

    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();

    const rows = document.querySelectorAll<HTMLElement>(
      '[data-testid="account-row"]',
    );
    expect(rows).toHaveLength(2);
    const active = Array.from(rows).find(
      (r) => r.getAttribute('aria-current') === 'true',
    );
    expect(active?.textContent).toContain('@me:hs');
    expect(
      document.querySelector('.account-row__badge')?.textContent?.trim(),
    ).toBe('3');
  });

  it('emits switchAccount when a non-active account row is clicked', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: {
        accounts: [
          { userId: '@me:hs', displayName: 'Me', avatarMxc: null, unread: 0 },
          { userId: '@alt:hs', displayName: 'Alt', avatarMxc: null, unread: 3 },
        ],
        activeUserId: '@me:hs',
      },
    });

    let switched: string | null = null;
    fixture.componentInstance.switchAccount.subscribe((id) => (switched = id));

    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();

    const altRow = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="account-row"]'),
    ).find((r) => r.textContent?.includes('@alt:hs'));
    altRow?.click();

    expect(switched).toBe('@alt:hs');
  });

  it('lists soft-logged-out accounts and emits reauthAccount when clicked', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { reauthAccounts: ['@dormant:hs'] },
    });

    let reauthed: string | null = null;
    fixture.componentInstance.reauthAccount.subscribe((id) => (reauthed = id));

    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();

    const row = document.querySelector<HTMLElement>(
      '[data-testid="reauth-row"]',
    );
    expect(row?.textContent).toContain('@dormant:hs');
    row?.click();

    expect(reauthed).toBe('@dormant:hs');
  });

  it('emits addAccount from the account menu', async () => {
    const { fixture, container } = await renderSidebar();

    let added = false;
    fixture.componentInstance.addAccount.subscribe(() => (added = true));

    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();

    document.querySelector<HTMLElement>('[data-testid="add-account"]')?.click();

    expect(added).toBe(true);
  });

  it('emits openSettings from the user-panel settings button', async () => {
    const { fixture, container } = await renderSidebar();

    let opened = false;
    fixture.componentInstance.openSettings.subscribe(() => (opened = true));
    container.querySelector<HTMLElement>('.userbar__settings')!.click();

    expect(opened).toBe(true);
  });

  it('emits openSwitcher from the header search button', async () => {
    const { fixture, container } = await renderSidebar();

    let opened = false;
    fixture.componentInstance.openSwitcher.subscribe(() => (opened = true));
    container
      .querySelector<HTMLElement>('[data-testid="open-switcher"]')!
      .click();

    expect(opened).toBe(true);
  });

  it('lists not-yet-joined channels and emits joinRoom with the child', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { spaceActive: true },
      joinableRooms: [
        child({ roomId: '!x:hs', name: 'open-channel', suggested: true }),
      ],
    });

    const joinables = container.querySelectorAll<HTMLElement>('.joinable');
    expect(joinables.length).toBe(1);
    expect(joinables[0].textContent).toContain('open-channel');
    expect(joinables[0].textContent).toContain('Suggested'); // suggested hint

    let joined: SpaceChildRoom | undefined;
    fixture.componentInstance.joinRoom.subscribe((c) => (joined = c));
    container
      .querySelector<HTMLElement>('[aria-label="Join open-channel"]')!
      .click();

    expect(joined?.roomId).toBe('!x:hs');
  });

  it('offers Open for joined sub-spaces and Join for the rest', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { spaceActive: true },
      childSpaces: [
        child({
          roomId: '!j:hs',
          name: 'Joined Sub',
          isSpace: true,
          joined: true,
        }),
        child({
          roomId: '!n:hs',
          name: 'New Sub',
          isSpace: true,
          joined: false,
        }),
      ],
    });

    let opened: string | undefined;
    let joined: SpaceChildRoom | undefined;
    fixture.componentInstance.openChildSpace.subscribe((id) => (opened = id));
    fixture.componentInstance.joinRoom.subscribe((c) => (joined = c));

    container
      .querySelector<HTMLElement>('[aria-label="Open Joined Sub"]')!
      .click();
    container
      .querySelector<HTMLElement>('[aria-label="Join New Sub"]')!
      .click();

    expect(opened).toBe('!j:hs');
    expect(joined?.roomId).toBe('!n:hs');
  });

  it('renders a Favourites header with favourite rows grouped above the rest', async () => {
    const { container } = await renderSidebar({
      inputs: {
        rooms: [
          room({ id: '!a:hs', name: 'alpha' }),
          room({ id: '!f:hs', name: 'favourite-room', favourite: true }),
          room({ id: '!b:hs', name: 'bravo' }),
        ],
      },
    });

    const categories = [...container.querySelectorAll('.category')].map(
      (c) => c.textContent,
    );
    expect(categories).toContain('Favourites');

    const channels = [...container.querySelectorAll('.channel__name')].map(
      (n) => n.textContent,
    );
    // The favourite room renders first (under "Favourites"); the rest keep their order.
    expect(channels).toEqual(['favourite-room', 'alpha', 'bravo']);
  });

  it('omits the Favourites header when no room is favourited', async () => {
    const { container } = await renderSidebar({
      inputs: {
        rooms: [
          room({ id: '!a:hs', name: 'alpha' }),
          room({ id: '!b:hs', name: 'bravo' }),
        ],
      },
    });

    const categories = [...container.querySelectorAll('.category')].map(
      (c) => c.textContent,
    );
    expect(categories).not.toContain('Favourites');
  });

  it('favourites a non-favourite room via the kebab menu', async () => {
    const { fixture, container, roomsSvc } = await renderSidebar({
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', favourite: false })],
      },
    });

    const kebab = container.querySelector<HTMLElement>('.channel__menu')!;
    kebab.click(); // open the menu (rendered into the CDK overlay)
    fixture.detectChanges();

    const favouriteItem = document.querySelector<HTMLElement>(
      '[data-testid="room-favourite"]',
    );
    expect(favouriteItem?.textContent).toContain('Favourite');
    favouriteItem?.click();

    expect(roomsSvc.setFavourite).toHaveBeenCalledWith('!a:hs', true, '@me:hs');
  });

  it('unfavourites a favourite room via the kebab menu', async () => {
    const { fixture, container, roomsSvc } = await renderSidebar({
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', favourite: true })],
      },
    });

    const kebab = container.querySelector<HTMLElement>('.channel__menu')!;
    kebab.click();
    fixture.detectChanges();

    const favouriteItem = document.querySelector<HTMLElement>(
      '[data-testid="room-favourite"]',
    );
    expect(favouriteItem?.textContent).toContain('Unfavourite');
    favouriteItem?.click();

    expect(roomsSvc.setFavourite).toHaveBeenCalledWith(
      '!a:hs',
      false,
      '@me:hs',
    );
  });

  it('emits removeRoom for a joined channel only while a space is active', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs', name: 'general' })] },
    });

    const kebab = (): HTMLElement =>
      container.querySelector<HTMLElement>('.channel__menu')!;
    // No space active → the kebab menu offers no "Remove from space" item.
    kebab().click(); // open
    fixture.detectChanges();
    expect(document.querySelector('[data-testid="room-remove"]')).toBeNull();
    kebab().click(); // close before re-rendering the menu
    fixture.detectChanges();

    fixture.componentRef.setInput('spaceActive', true);
    fixture.detectChanges();

    let removed: string | undefined;
    fixture.componentInstance.removeRoom.subscribe((id) => (removed = id));
    // Open the row's kebab menu (rendered into the overlay) and remove.
    kebab().click();
    fixture.detectChanges();
    document.querySelector<HTMLElement>('[data-testid="room-remove"]')?.click();

    expect(removed).toBe('!a:hs');
  });

  // Presence is projected from the ACTIVE client only, so a mixed-in account's DM partner
  // has no entry there — a dot would render grey and read as genuinely offline.
  it('shows no presence dot on a DM owned by another account', async () => {
    const { container } = await renderSidebar({
      inputs: {
        rooms: [
          room({ id: '!mine:hs', accountId: '@me:hs', directUserId: '@x:hs' }),
          room({
            id: '!theirs:hs',
            accountId: '@alt:hs',
            directUserId: '@y:hs',
          }),
        ],
        activeUserId: '@me:hs',
      },
    });

    // One dot only: the active account's DM keeps it, the mixed-in one does not.
    expect(container.querySelectorAll('.presence-dot').length).toBe(1);
  });

  it('emits leaveRoom from the room kebab menu', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs', name: 'general' })] },
    });
    let left: string | undefined;
    fixture.componentInstance.leaveRoom.subscribe((e) => (left = e.roomId));

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLElement>('[data-testid="room-leave"]')!.click();

    expect(left).toBe('!a:hs');
  });

  it('emits markRead from the kebab menu for an unread room', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', hasUnread: true })],
      },
    });
    let marked: string | undefined;
    fixture.componentInstance.markRead.subscribe((e) => (marked = e.roomId));

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="room-mark-read"]')!
      .click();

    expect(marked).toBe('!a:hs');
  });

  it('does not offer Mark as read for a read room', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', hasUnread: false })],
      },
    });
    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    expect(document.querySelector('[data-testid="room-mark-read"]')).toBeNull();
  });

  it('emits markAllRead from the header when any room is unread', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', hasUnread: true })],
      },
    });
    let all = false;
    fixture.componentInstance.markAllRead.subscribe(() => (all = true));

    container
      .querySelector<HTMLElement>('[data-testid="mark-all-read"]')!
      .click();

    expect(all).toBe(true);
  });

  it('hides the mark-all-read header action when no room is unread', async () => {
    const { container } = await renderSidebar({
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', hasUnread: false })],
      },
    });

    expect(container.querySelector('[data-testid="mark-all-read"]')).toBeNull();
  });

  it('offers a Notifications entry in the room kebab menu', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs', name: 'general' })] },
    });

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();

    const notify = document.querySelector<HTMLElement>(
      '[data-testid="room-notify"]',
    );
    expect(notify?.textContent).toContain('Notifications');
  });

  it('reads the level from the account that owns the row, not the active one', async () => {
    const { fixture } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs' })] },
      notifyMode: 'mentions',
    });

    const foreign = room({ id: '!a:hs', accountId: '@alt:hs' });
    expect(fixture.componentInstance.notifyMode(foreign)).toBe('mentions');
    // A mixed-in row's push rules live on ITS account; reading them from the active client
    // would report the wrong level and silently mute/unmute the wrong account.
    expect(modeForSpy).toHaveBeenCalledWith('!a:hs', '@alt:hs');
  });

  it('emits setNotifyMode when a level is chosen from the submenu', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs', name: 'general' })] },
      notifyMode: 'all',
    });
    const picks: { roomId: string; mode: RoomNotifyMode }[] = [];
    fixture.componentInstance.setNotifyMode.subscribe((event) =>
      picks.push(event),
    );

    // Open the kebab, reveal the Notifications submenu, then pick Mute.
    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLElement>('[data-testid="room-notify"]')!.click();
    fixture.detectChanges();
    const muteItem = document.querySelector<HTMLElement>(
      '[data-testid="room-notify-mute"]',
    );
    expect(muteItem).not.toBeNull();
    // The current level ('all') is the checked radio; Mute is not yet checked.
    expect(
      document
        .querySelector('[data-testid="room-notify-all"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    muteItem!.click();

    expect(picks).toEqual([
      { roomId: '!a:hs', mode: 'mute', accountIds: ['@me:hs'] },
    ]);
  });

  // One render per case (a second render() in the same test re-configures an already
  // instantiated TestBed and throws), so parametrise rather than loop.
  it.each(['mentions', 'mute'] as const)(
    'checks the %s radio matching the room’s current level',
    async (mode) => {
      const { fixture, container } = await renderSidebar({
        inputs: { rooms: [room({ id: '!a:hs', name: 'general' })] },
        notifyMode: mode,
      });
      container.querySelector<HTMLElement>('.channel__menu')!.click();
      fixture.detectChanges();
      document
        .querySelector<HTMLElement>('[data-testid="room-notify"]')!
        .click();
      fixture.detectChanges();

      const ariaChecked = (id: string): string | null | undefined =>
        document
          .querySelector(`[data-testid="${id}"]`)
          ?.getAttribute('aria-checked');
      expect(ariaChecked(`room-notify-${mode}`)).toBe('true');
      for (const other of (['all', 'mentions', 'mute'] as const).filter(
        (m) => m !== mode,
      )) {
        expect(ariaChecked(`room-notify-${other}`)).toBe('false');
      }
    },
  );

  it('emits the mentions level when chosen from the submenu', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs', name: 'general' })] },
      notifyMode: 'all',
    });
    const picks: { roomId: string; mode: RoomNotifyMode }[] = [];
    fixture.componentInstance.setNotifyMode.subscribe((event) =>
      picks.push(event),
    );

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLElement>('[data-testid="room-notify"]')!.click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="room-notify-mentions"]')!
      .click();

    expect(picks).toEqual([
      { roomId: '!a:hs', mode: 'mentions', accountIds: ['@me:hs'] },
    ]);
  });

  it('emits the level for the specific room whose menu was opened', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: {
        rooms: [
          room({ id: '!a:hs', name: 'general' }),
          room({ id: '!b:hs', name: 'random' }),
        ],
      },
    });
    const picks: { roomId: string; mode: RoomNotifyMode }[] = [];
    fixture.componentInstance.setNotifyMode.subscribe((event) =>
      picks.push(event),
    );

    // Open the SECOND room's kebab → Notifications submenu → Mute; the emit must carry
    // that row's id, not the first (or last) room's.
    const kebabs = container.querySelectorAll<HTMLElement>('.channel__menu');
    expect(kebabs).toHaveLength(2);
    kebabs[1].click();
    fixture.detectChanges();
    document.querySelector<HTMLElement>('[data-testid="room-notify"]')!.click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="room-notify-mute"]')!
      .click();

    expect(picks).toEqual([
      { roomId: '!b:hs', mode: 'mute', accountIds: ['@me:hs'] },
    ]);
  });

  it('shows loading then error states for the space hierarchy', async () => {
    const { fixture, container, signals } = await renderSidebar({
      inputs: { spaceActive: true },
      childrenLoading: true,
    });
    expect(container.textContent).toContain('Loading channels');

    signals.childrenLoading.set(false);
    signals.childrenError.set('nope');
    fixture.detectChanges();
    expect(container.querySelector('.empty--error')).not.toBeNull();
    // No joinable rows render while erroring.
    expect(container.querySelector('.joinable')).toBeNull();
  });

  it('badges each room with its owning account only in the mixed view', async () => {
    const badges = new Map([
      ['@me:hs', { initial: 'M', name: 'Me' }],
      ['@alt:hs', { initial: 'A', name: 'Alt' }],
    ]);
    const { container, fixture } = await renderSidebar({
      inputs: {
        rooms: [
          room({ id: '!mine:hs', accountId: '@me:hs' }),
          room({ id: '!theirs:hs', accountId: '@alt:hs' }),
        ],
        accountBadges: badges,
      },
    });
    // Both rows carry an account badge.
    expect(
      container.querySelectorAll('[data-testid="account-badge"]').length,
    ).toBe(2);

    // With no badge map (single-account), no badge renders.
    fixture.componentRef.setInput('accountBadges', new Map());
    fixture.detectChanges();
    expect(container.querySelector('[data-testid="account-badge"]')).toBeNull();
  });

  // An invite to an account you're SHOWING but not acting as must be visible here, or it
  // stays hidden until you happen to switch to that account.
  it('lists invites from every mixed account, badged, while mixing', async () => {
    const badges = new Map([
      [
        '@alt:hs',
        { id: '@alt:hs', name: 'Alt', initial: 'A', avatarMxc: null },
      ],
    ]);
    const { container } = await renderSidebar({
      mixing: true,
      mixedInvites: [
        {
          roomId: '!i:hs',
          accountId: '@alt:hs',
          name: 'Ops',
          initial: 'O',
          avatarMxc: null,
          inviterName: 'Al',
          isSpace: false,
          isDirect: false,
        },
      ],
      inputs: { accountBadges: badges },
    });

    expect(container.querySelector('.invite__name')?.textContent).toContain(
      'Ops',
    );
    expect(
      container.querySelector('.invite [data-testid="account-badge"]'),
    ).toBeTruthy();
  });

  it('answers an invite on the account it was sent to', async () => {
    const { fixture, container } = await renderSidebar({
      mixing: true,
      mixedInvites: [
        {
          roomId: '!i:hs',
          accountId: '@alt:hs',
          name: 'Ops',
          initial: 'O',
          avatarMxc: null,
          inviterName: 'Al',
          isSpace: false,
          isDirect: false,
        },
      ],
    });
    const accepted: { roomId: string; accountId: string }[] = [];
    fixture.componentInstance.acceptInvite.subscribe((e) => accepted.push(e));

    container.querySelector<HTMLElement>('.invite__btn.accept')!.click();

    expect(accepted).toEqual([{ roomId: '!i:hs', accountId: '@alt:hs' }]);
  });

  it('falls back to the active account’s invites when not mixing', async () => {
    const single: PendingInvite = {
      roomId: '!mine:hs',
      accountId: '@me:hs',
      name: 'Mine',
      initial: 'M',
      avatarMxc: null,
      inviterName: 'Al',
      isSpace: false,
      isDirect: false,
    };
    const { container } = await renderSidebar({
      mixing: false,
      invites: [single],
      mixedInvites: [{ ...single, roomId: '!other:hs', name: 'Other' }],
    });

    expect(container.querySelector('.invite__name')?.textContent).toContain(
      'Mine',
    );
  });
});

// The header sort menu picks how the open space's rooms are ordered. The sidebar itself does
// no sorting — it only reports the pick; RoomsPage applies it.
describe('ChannelSidebarComponent space sort menu', () => {
  /** Open the header sort menu and return its rows, which render into a CDK overlay. */
  async function openSortMenu(
    inputs: {
      sortMode?: RoomSortMode;
      sortOverridden?: boolean;
      defaultSortMode?: RoomSortMode;
    } = {},
  ) {
    const rendered = await renderSidebar({
      inputs: { spaceActive: true, ...inputs },
    });
    // The sort menu is a SUBMENU now: open the header overflow first, then its row.
    rendered.container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    rendered.fixture.detectChanges();
    const trigger = document.querySelector<HTMLElement>(
      '[data-testid="space-sort"]',
    )!;
    trigger.click();
    rendered.fixture.detectChanges();
    const row = (testid: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
    return { ...rendered, trigger, row };
  }

  it('offers no sort menu on Home', async () => {
    const { container } = await renderSidebar({
      inputs: { spaceActive: false },
    });

    expect(container.querySelector('[data-testid="space-sort"]')).toBeNull();
  });

  it('offers the sort menu inside a space, from the overflow', async () => {
    const { container, fixture } = await renderSidebar({
      inputs: { spaceActive: true },
    });

    // Not on the header itself any more — it is a row in the overflow menu.
    expect(container.querySelector('[data-testid="space-sort"]')).toBeNull();

    container
      .querySelector<HTMLElement>('[data-testid="space-actions-overflow"]')!
      .click();
    fixture.detectChanges();

    expect(document.querySelector('[data-testid="space-sort"]')).not.toBeNull();
  });

  it('names the effective ordering on the trigger, for screen readers', async () => {
    const { trigger } = await openSortMenu({ sortMode: 'alphabetical' });

    expect(trigger.getAttribute('aria-label')).toBe(
      'Order rooms: Alphabetical',
    );
  });

  it('offers "use my default" plus one row per ordering', async () => {
    await openSortMenu();

    const rows = [
      ...document.querySelectorAll('[data-testid^="space-sort-"]'),
    ].map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual([
      'space-sort-default',
      'space-sort-recent',
      'space-sort-space',
      'space-sort-alphabetical',
    ]);
  });

  it('explains what each ordering does', async () => {
    const { row } = await openSortMenu();

    for (const option of TRINITY_ROOM_SORTS) {
      expect(row(`space-sort-${option.id}`)?.textContent, option.id).toContain(
        option.description,
      );
    }
  });

  it('names the account default on the "use my default" row', async () => {
    const { row } = await openSortMenu({ defaultSortMode: 'space' });

    expect(row('space-sort-default')?.textContent).toContain(
      'Use my default (Space order)',
    );
  });

  it('checks "use my default" when the space has no override', async () => {
    const { row } = await openSortMenu({
      sortMode: 'recent',
      sortOverridden: false,
    });

    // The effective mode is 'recent', but it is inherited — checking the Recent row instead
    // would leave the user no way to tell an inherited order from a pinned one.
    expect(row('space-sort-default')?.hasAttribute('data-checked')).toBe(true);
    expect(row('space-sort-recent')?.hasAttribute('data-checked')).toBe(false);
  });

  it('checks the pinned ordering when the space overrides the default', async () => {
    const { row } = await openSortMenu({
      sortMode: 'alphabetical',
      sortOverridden: true,
    });

    expect(row('space-sort-alphabetical')?.hasAttribute('data-checked')).toBe(
      true,
    );
    expect(row('space-sort-default')?.hasAttribute('data-checked')).toBe(false);
  });

  it('emits the chosen ordering', async () => {
    const { fixture, row } = await openSortMenu();
    const emitted: (RoomSortMode | null)[] = [];
    fixture.componentInstance.setSortMode.subscribe((mode) =>
      emitted.push(mode),
    );

    row('space-sort-space')?.click();

    expect(emitted).toEqual(['space']);
  });

  it('emits null for "use my default", so the override is dropped', async () => {
    const { fixture, row } = await openSortMenu({
      sortMode: 'space',
      sortOverridden: true,
    });
    const emitted: (RoomSortMode | null)[] = [];
    fixture.componentInstance.setSortMode.subscribe((mode) =>
      emitted.push(mode),
    );

    row('space-sort-default')?.click();

    expect(emitted).toEqual([null]);
  });
});
