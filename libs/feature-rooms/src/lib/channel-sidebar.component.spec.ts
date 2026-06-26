import { TestBed } from '@angular/core/testing';
import { ChannelSidebarComponent } from './channel-sidebar.component';

describe('ChannelSidebarComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [ChannelSidebarComponent] }),
  );

  it('lists rooms and emits selectRoom when one is clicked', () => {
    const fixture = TestBed.createComponent(ChannelSidebarComponent);
    fixture.componentRef.setInput('rooms', [
      {
        id: '!a:hs',
        name: 'general',
        initial: 'G',
        avatarUrl: null,
        topic: '',
        memberCount: 0,
      },
    ]);
    fixture.detectChanges();

    const channels = fixture.nativeElement.querySelectorAll('.channel');
    expect(channels.length).toBe(1);
    expect(channels[0].textContent).toContain('general');

    let roomId: string | undefined;
    fixture.componentInstance.selectRoom.subscribe((id) => (roomId = id));
    channels[0].click();
    expect(roomId).toBe('!a:hs');
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
