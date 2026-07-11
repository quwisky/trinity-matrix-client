import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import {
  InvitesService,
  type PendingInvite,
} from '@trinity/data-access-invites';
import {
  PresenceService,
  type UserProfile,
} from '@trinity/data-access-profile';
import {
  RoomsService,
  SpacesService,
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
    };
    joinableRooms?: SpaceChildRoom[];
    childSpaces?: SpaceChildRoom[];
    childrenLoading?: boolean;
    childrenError?: string | null;
    invites?: PendingInvite[];
    notifyMode?: RoomNotifyMode;
  } = {},
) {
  const signals = {
    notJoinedRooms: signal<SpaceChildRoom[]>(opts.joinableRooms ?? []),
    childSpaces: signal<SpaceChildRoom[]>(opts.childSpaces ?? []),
    childrenLoading: signal(opts.childrenLoading ?? false),
    childrenError: signal<string | null>(opts.childrenError ?? null),
    pendingInvites: signal<PendingInvite[]>(opts.invites ?? []),
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
      MockProvider(RoomsService),
      MockProvider(RoomNotificationsService, {
        modeFor: () => opts.notifyMode ?? 'all',
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
    expect(
      container.querySelector('[aria-label="Invite people to space"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Leave space"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="New room or direct message"]'),
    ).not.toBeNull();
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

    container
      .querySelector<HTMLElement>('[aria-label="Create a channel"]')!
      .click();
    container
      .querySelector<HTMLElement>('[aria-label="Invite people to space"]')!
      .click();
    container.querySelector<HTMLElement>('[aria-label="Leave space"]')!.click();

    expect(created).toBe(true);
    expect(invited).toBe(true);
    expect(left).toBe(true);
    // The Home affordance is hidden while a space is active.
    expect(
      container.querySelector('[aria-label="New room or direct message"]'),
    ).toBeNull();
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
    fixture.componentInstance.acceptInvite.subscribe((id) => (accepted = id));
    fixture.componentInstance.declineInvite.subscribe((id) => (declined = id));

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

    expect(roomsSvc.setFavourite).toHaveBeenCalledWith('!a:hs', true);
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

    expect(roomsSvc.setFavourite).toHaveBeenCalledWith('!a:hs', false);
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

  it('emits leaveRoom from the room kebab menu', async () => {
    const { fixture, container } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs', name: 'general' })] },
    });
    let left: string | undefined;
    fixture.componentInstance.leaveRoom.subscribe((id) => (left = id));

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
    fixture.componentInstance.markRead.subscribe((id) => (marked = id));

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

  it('reads the room’s current notification level for the menu', async () => {
    const { fixture } = await renderSidebar({
      inputs: { rooms: [room({ id: '!a:hs' })] },
      notifyMode: 'mentions',
    });
    expect(fixture.componentInstance.notifyMode('!a:hs')).toBe('mentions');
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

    expect(picks).toEqual([{ roomId: '!a:hs', mode: 'mute' }]);
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

    expect(picks).toEqual([{ roomId: '!a:hs', mode: 'mentions' }]);
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

    expect(picks).toEqual([{ roomId: '!b:hs', mode: 'mute' }]);
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
});
