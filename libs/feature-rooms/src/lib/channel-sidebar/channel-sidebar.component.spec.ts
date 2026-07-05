import { render } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import type { PendingInvite, RoomSummary, SpaceChildRoom } from '@trinity/core';
import { ChannelSidebarComponent } from './channel-sidebar.component';

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

describe('ChannelSidebarComponent', () => {
  it('lists rooms and emits selectRoom when one is clicked', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent, {
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
    const { container } = await render(ChannelSidebarComponent, {
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
    const { container } = await render(ChannelSidebarComponent, {
      inputs: { rooms: [room({ lastMessage: '' })] },
    });

    expect(container.querySelector('.channel__preview')).toBeNull();
  });

  it('shows a mention count, a muted unread count, and caps at 99+', async () => {
    const { container } = await render(ChannelSidebarComponent, {
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
    const { fixture } = await render(ChannelSidebarComponent);

    expect(fixture.componentInstance.badgeLabel(99)).toBe('99');
    expect(fixture.componentInstance.badgeLabel(100)).toBe('99+');
  });

  it('shows the exact uncapped unread count on a muted badge', async () => {
    const { container } = await render(ChannelSidebarComponent, {
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
    const { container } = await render(ChannelSidebarComponent);

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
    const { fixture, container } = await render(ChannelSidebarComponent);

    let opened = false;
    fixture.componentInstance.newChat.subscribe(() => (opened = true));
    container
      .querySelector<HTMLElement>('[aria-label="New room or direct message"]')!
      .click();

    expect(opened).toBe(true);
  });

  it('shows the space actions and emits createRoom / inviteToSpace / leaveSpace', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent, {
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
    const { fixture, container } = await render(ChannelSidebarComponent, {
      inputs: {
        invites: [
          invite({
            roomId: '!i:hs',
            name: 'Invited Room',
            inviterName: 'Alice',
          }),
        ],
      },
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
    const { container } = await render(ChannelSidebarComponent);

    expect(container.querySelector('.invite')).toBeNull();
  });

  it('emits logout from the account menu opened via the user bar', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent);

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

  it('emits openSettings from the user-panel settings button', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent);

    let opened = false;
    fixture.componentInstance.openSettings.subscribe(() => (opened = true));
    container.querySelector<HTMLElement>('.userbar__settings')!.click();

    expect(opened).toBe(true);
  });

  it('emits openSwitcher from the header search button', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent);

    let opened = false;
    fixture.componentInstance.openSwitcher.subscribe(() => (opened = true));
    container
      .querySelector<HTMLElement>('[data-testid="open-switcher"]')!
      .click();

    expect(opened).toBe(true);
  });

  it('lists not-yet-joined channels and emits joinRoom with the child', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent, {
      inputs: {
        spaceActive: true,
        joinableRooms: [
          child({ roomId: '!x:hs', name: 'open-channel', suggested: true }),
        ],
      },
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
    const { fixture, container } = await render(ChannelSidebarComponent, {
      inputs: {
        spaceActive: true,
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
      },
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
    const { container } = await render(ChannelSidebarComponent, {
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
    const { container } = await render(ChannelSidebarComponent, {
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

  it('emits setFavourite to favourite a non-favourite room via the kebab menu', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent, {
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', favourite: false })],
      },
    });

    let emitted: { id: string; favourite: boolean } | undefined;
    fixture.componentInstance.setFavourite.subscribe((e) => (emitted = e));

    const kebab = container.querySelector<HTMLElement>('.channel__menu')!;
    kebab.click(); // open the menu (rendered into the CDK overlay)
    fixture.detectChanges();

    const favouriteItem = document.querySelector<HTMLElement>(
      '[data-testid="room-favourite"]',
    );
    expect(favouriteItem?.textContent).toContain('Favourite');
    favouriteItem?.click();

    expect(emitted).toEqual({ id: '!a:hs', favourite: true });
  });

  it('emits setFavourite to unfavourite a favourite room via the kebab menu', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent, {
      inputs: {
        rooms: [room({ id: '!a:hs', name: 'general', favourite: true })],
      },
    });

    let emitted: { id: string; favourite: boolean } | undefined;
    fixture.componentInstance.setFavourite.subscribe((e) => (emitted = e));

    const kebab = container.querySelector<HTMLElement>('.channel__menu')!;
    kebab.click();
    fixture.detectChanges();

    const favouriteItem = document.querySelector<HTMLElement>(
      '[data-testid="room-favourite"]',
    );
    expect(favouriteItem?.textContent).toContain('Unfavourite');
    favouriteItem?.click();

    expect(emitted).toEqual({ id: '!a:hs', favourite: false });
  });

  it('emits removeRoom for a joined channel only while a space is active', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent, {
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

  it('shows loading then error states for the space hierarchy', async () => {
    const { fixture, container } = await render(ChannelSidebarComponent, {
      inputs: { spaceActive: true, childrenLoading: true },
    });
    expect(container.textContent).toContain('Loading channels');

    fixture.componentRef.setInput('childrenLoading', false);
    fixture.componentRef.setInput('childrenError', 'nope');
    fixture.detectChanges();
    expect(container.querySelector('.empty--error')).not.toBeNull();
    // No joinable rows render while erroring.
    expect(container.querySelector('.joinable')).toBeNull();
  });
});
