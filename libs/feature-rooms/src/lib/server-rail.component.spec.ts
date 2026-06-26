import { TestBed } from '@angular/core/testing';
import { ServerRailComponent } from './server-rail.component';

describe('ServerRailComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [ServerRailComponent] }),
  );

  it('renders Home plus a pill per space', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.componentRef.setInput('spaces', [
      {
        id: '!s:hs',
        name: 'Space',
        initial: 'S',
        avatarUrl: null,
        childRoomIds: [],
      },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pill.home')).toBeTruthy();
    const spacePills = fixture.nativeElement.querySelectorAll(
      '.pill:not(.home):not(.add)',
    );
    expect(spacePills.length).toBe(1);
  });

  it('emits selectSpace(null) when Home is clicked', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.detectChanges();

    let selected: string | null = 'unset';
    fixture.componentInstance.selectSpace.subscribe((v) => (selected = v));
    fixture.nativeElement.querySelector('.pill.home').click();

    expect(selected).toBeNull();
  });
});
