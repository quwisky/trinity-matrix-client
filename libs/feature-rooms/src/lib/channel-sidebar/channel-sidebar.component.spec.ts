import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RoomSummary } from '@trinity/core';
import { ChannelSidebarComponent } from './channel-sidebar.component';

function room(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: '!a:hs',
    name: 'general',
    initial: 'G',
    avatarUrl: null,
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

  it('emits logout when the logout button is clicked', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.detectChanges();

    let loggedOut = false;
    fixture.componentInstance.logout.subscribe(() => (loggedOut = true));
    fixture.nativeElement.querySelector('.userbar__logout').click();

    expect(loggedOut).toBe(true);
  });
});
