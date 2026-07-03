import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
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
    activityTs: 0,
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
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [ChannelSidebarComponent] }),
  );

  it('lists rooms and emits selectRoom when one is clicked', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('rooms', [room()]);
    fixture.detectChanges();

    const channels = fixture.nativeElement.querySelectorAll('.channel');
    expect(channels.length).toBe(1);
    expect(channels[0].textContent).toContain('general');

    let roomId: string | undefined;
    fixture.componentInstance.selectRoom.subscribe((id) => (roomId = id));
    channels[0].click();
    expect(roomId).toBe('!a:hs');
  });

  it('marks unread rooms and shows a mention badge / unread dot', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('rooms', [
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
        unreadCount: 1,
        highlightCount: 0,
      }),
      room({ id: '!r:hs', name: 'read' }),
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    const badges = el.querySelectorAll('.channel__badge');
    expect(badges.length).toBe(1); // only the mention room
    expect(badges[0].textContent.trim()).toBe('2');
    expect(el.querySelectorAll('.channel__dot').length).toBe(1); // plain unread
    expect(el.querySelectorAll('.channel.unread').length).toBe(2);
  });

  it('shows only the new-chat affordance on Home (no space actions)', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.detectChanges(); // spaceActive defaults to false

    const el = fixture.nativeElement;
    // Space-only actions are hidden on Home; the new-room/DM "+" is present.
    expect(el.querySelector('[aria-label="Create a channel"]')).toBeNull();
    expect(
      el.querySelector('[aria-label="Invite people to space"]'),
    ).toBeNull();
    expect(el.querySelector('[aria-label="Leave space"]')).toBeNull();
    expect(
      el.querySelector('[aria-label="New room or direct message"]'),
    ).not.toBeNull();
  });

  it('emits newChat from the Home "+" affordance', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.detectChanges();

    let opened = false;
    fixture.componentInstance.newChat.subscribe(() => (opened = true));
    fixture.nativeElement
      .querySelector('[aria-label="New room or direct message"]')
      .click();

    expect(opened).toBe(true);
  });

  it('shows the space actions and emits createRoom / inviteToSpace / leaveSpace', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('spaceActive', true);
    fixture.detectChanges();

    let created = false;
    let invited = false;
    let left = false;
    fixture.componentInstance.createRoom.subscribe(() => (created = true));
    fixture.componentInstance.inviteToSpace.subscribe(() => (invited = true));
    fixture.componentInstance.leaveSpace.subscribe(() => (left = true));

    const el = fixture.nativeElement;
    el.querySelector('[aria-label="Create a channel"]').click();
    el.querySelector('[aria-label="Invite people to space"]').click();
    el.querySelector('[aria-label="Leave space"]').click();

    expect(created).toBe(true);
    expect(invited).toBe(true);
    expect(left).toBe(true);
    // The Home affordance is hidden while a space is active.
    expect(
      el.querySelector('[aria-label="New room or direct message"]'),
    ).toBeNull();
  });

  it('renders pending invites and emits accept / decline with the room id', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('invites', [
      invite({ roomId: '!i:hs', name: 'Invited Room', inviterName: 'Alice' }),
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    const invites = el.querySelectorAll('.invite');
    expect(invites.length).toBe(1);
    expect(invites[0].textContent).toContain('Invited Room');
    expect(invites[0].textContent).toContain('Alice');

    let accepted: string | undefined;
    let declined: string | undefined;
    fixture.componentInstance.acceptInvite.subscribe((id) => (accepted = id));
    fixture.componentInstance.declineInvite.subscribe((id) => (declined = id));

    el.querySelector('.invite__btn.accept').click();
    el.querySelector('.invite__btn.decline').click();

    expect(accepted).toBe('!i:hs');
    expect(declined).toBe('!i:hs');
  });

  it('shows no Invites group when there are none', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.invite')).toBeNull();
  });

  it('emits logout from the account menu opened via the user bar', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.detectChanges();

    let loggedOut = false;
    fixture.componentInstance.logout.subscribe(() => (loggedOut = true));

    // Open the account menu from the user-bar trigger, then trigger Log out
    // (the item lives in a CDK menu rendered into the overlay container).
    fixture.nativeElement.querySelector('.userbar__trigger').click();
    fixture.detectChanges();

    const logoutItem = document.querySelector<HTMLElement>(
      '[data-testid="logout"]',
    );
    expect(logoutItem).toBeTruthy();
    logoutItem?.click();

    expect(loggedOut).toBe(true);
    fixture.destroy();
  });

  it('emits openSettings from the user-panel settings button', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.detectChanges();

    let opened = false;
    fixture.componentInstance.openSettings.subscribe(() => (opened = true));
    fixture.nativeElement.querySelector('.userbar__settings').click();

    expect(opened).toBe(true);
  });

  it('emits openSwitcher from the header search button', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.detectChanges();

    let opened = false;
    fixture.componentInstance.openSwitcher.subscribe(() => (opened = true));
    fixture.nativeElement
      .querySelector('[data-testid="open-switcher"]')
      .click();

    expect(opened).toBe(true);
  });

  it('lists not-yet-joined channels and emits joinRoom with the child', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('spaceActive', true);
    fixture.componentRef.setInput('joinableRooms', [
      child({ roomId: '!x:hs', name: 'open-channel', suggested: true }),
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    const joinables = el.querySelectorAll('.joinable');
    expect(joinables.length).toBe(1);
    expect(joinables[0].textContent).toContain('open-channel');
    expect(joinables[0].textContent).toContain('Suggested'); // suggested hint

    let joined: SpaceChildRoom | undefined;
    fixture.componentInstance.joinRoom.subscribe((c) => (joined = c));
    el.querySelector('[aria-label="Join open-channel"]').click();

    expect(joined?.roomId).toBe('!x:hs');
  });

  it('offers Open for joined sub-spaces and Join for the rest', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('spaceActive', true);
    fixture.componentRef.setInput('childSpaces', [
      child({
        roomId: '!j:hs',
        name: 'Joined Sub',
        isSpace: true,
        joined: true,
      }),
      child({ roomId: '!n:hs', name: 'New Sub', isSpace: true, joined: false }),
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    let opened: string | undefined;
    let joined: SpaceChildRoom | undefined;
    fixture.componentInstance.openChildSpace.subscribe((id) => (opened = id));
    fixture.componentInstance.joinRoom.subscribe((c) => (joined = c));

    el.querySelector('[aria-label="Open Joined Sub"]').click();
    el.querySelector('[aria-label="Join New Sub"]').click();

    expect(opened).toBe('!j:hs');
    expect(joined?.roomId).toBe('!n:hs');
  });

  it('emits removeRoom for a joined channel only while a space is active', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('rooms', [
      room({ id: '!a:hs', name: 'general' }),
    ]);
    // No space active → no remove affordance.
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.channel__remove')).toBeNull();

    fixture.componentRef.setInput('spaceActive', true);
    fixture.detectChanges();

    let removed: string | undefined;
    fixture.componentInstance.removeRoom.subscribe((id) => (removed = id));
    fixture.nativeElement.querySelector('.channel__remove').click();

    expect(removed).toBe('!a:hs');
  });

  it('shows loading then error states for the space hierarchy', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('spaceActive', true);
    fixture.componentRef.setInput('childrenLoading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Loading channels');

    fixture.componentRef.setInput('childrenLoading', false);
    fixture.componentRef.setInput('childrenError', 'nope');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.empty--error')).not.toBeNull();
    // No joinable rows render while erroring.
    expect(fixture.nativeElement.querySelector('.joinable')).toBeNull();
  });
});
