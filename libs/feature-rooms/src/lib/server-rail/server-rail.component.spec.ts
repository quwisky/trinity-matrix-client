import { TestBed } from '@angular/core/testing';
import type { SpaceSummary } from '@trinity/core';
import { ServerRailComponent } from './server-rail.component';
import { beforeEach, describe, expect, it } from 'vitest';

function space(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: '!s:hs',
    name: 'Space',
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
    ...over,
  };
}

describe('ServerRailComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [ServerRailComponent] }),
  );

  it('renders Home plus a pill per space', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.componentRef.setInput('spaces', [
      space({ id: '!a:hs', name: 'Alpha' }),
      space({ id: '!b:hs', name: 'Beta' }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pill.home')).toBeTruthy();
    const spacePills = fixture.nativeElement.querySelectorAll(
      '.pill:not(.home):not(.add)',
    );
    expect(spacePills.length).toBe(2);
  });

  it('emits selectSpace(null) when Home is clicked', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.detectChanges();

    let selected: string | null = 'unset';
    fixture.componentInstance.selectSpace.subscribe((v) => (selected = v));
    fixture.nativeElement.querySelector('.pill.home').click();

    expect(selected).toBeNull();
  });

  it('emits selectSpace(spaceId) when a space pill is clicked', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.componentRef.setInput('spaces', [space({ id: '!s:hs' })]);
    fixture.detectChanges();

    let selected: string | null = null;
    fixture.componentInstance.selectSpace.subscribe((v) => (selected = v));
    fixture.nativeElement.querySelector('.pill:not(.home):not(.add)').click();

    expect(selected).toBe('!s:hs');
  });

  it('marks the active space (Home active when no space is selected)', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.componentRef.setInput('spaces', [space({ id: '!s:hs' })]);
    fixture.detectChanges();

    // No selection → Home is the active item.
    const homeItem = fixture.nativeElement.querySelector('.item');
    expect(homeItem.classList.contains('active')).toBe(true);

    // Selecting the space moves the active marker to its item.
    fixture.componentRef.setInput('activeSpaceId', '!s:hs');
    fixture.detectChanges();
    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items[0].classList.contains('active')).toBe(false); // Home
    expect(items[1].classList.contains('active')).toBe(true); // the space
  });
});
