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
    expect(fixture.nativeElement.querySelector('.pill.rooms')).toBeTruthy();
    const spacePills = fixture.nativeElement.querySelectorAll(
      '.pill:not(.home):not(.add):not(.rooms)',
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
    fixture.nativeElement
      .querySelector('.pill:not(.home):not(.add):not(.rooms)')
      .click();

    expect(selected).toBe('!s:hs');
  });

  it('emits createSpace when the add ("+") pill is clicked', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.detectChanges();

    let created = false;
    fixture.componentInstance.createSpace.subscribe(() => (created = true));
    const add = fixture.nativeElement.querySelector('.pill.add');
    expect(add.disabled).toBe(false); // the affordance is enabled now
    add.click();

    expect(created).toBe(true);
  });

  it('marks the active space (Home active when no space is selected)', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.componentRef.setInput('spaces', [space({ id: '!s:hs' })]);
    fixture.detectChanges();

    // No selection → Home is the active item.
    const homeItem = fixture.nativeElement.querySelector('.item');
    expect(homeItem.classList.contains('active')).toBe(true);

    // Selecting the space moves the active marker to its item
    // (order: Home, Rooms, space, add).
    fixture.componentRef.setInput('activeSpaceId', '!s:hs');
    fixture.detectChanges();
    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items[0].classList.contains('active')).toBe(false); // Home
    expect(items[1].classList.contains('active')).toBe(false); // Rooms
    expect(items[2].classList.contains('active')).toBe(true); // the space
  });

  it('emits showRooms when the Rooms pill is clicked', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.detectChanges();

    let shown = false;
    fixture.componentInstance.showRooms.subscribe(() => (shown = true));
    fixture.nativeElement.querySelector('[data-testid=rail-rooms]').click();

    expect(shown).toBe(true);
  });

  it('marks the Rooms view active and deactivates Home when roomsActive is set', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.detectChanges();
    const items = fixture.nativeElement.querySelectorAll('.item');

    // Default (no Rooms view): Home active, Rooms inactive.
    expect(items[0].classList.contains('active')).toBe(true); // Home
    expect(items[1].classList.contains('active')).toBe(false); // Rooms

    fixture.componentRef.setInput('roomsActive', true);
    fixture.detectChanges();
    expect(items[0].classList.contains('active')).toBe(false); // Home no longer active
    expect(items[1].classList.contains('active')).toBe(true); // Rooms active
  });

  it('shows unread badges on the Home, Rooms and space pills', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.componentRef.setInput('spaces', [space({ id: '!s:hs' })]);
    fixture.componentRef.setInput('homeUnread', 3);
    fixture.componentRef.setInput('roomsUnread', 7);
    fixture.componentRef.setInput('spaceUnread', { '!s:hs': 12 });
    fixture.detectChanges();

    // order: Home, Rooms, space, add
    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items[0].querySelector('.badge')?.textContent?.trim()).toBe('3');
    expect(items[1].querySelector('.badge')?.textContent?.trim()).toBe('7');
    expect(items[2].querySelector('.badge')?.textContent?.trim()).toBe('12');
  });

  it('hides a pill badge when its unread count is zero', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.badge')).toBeNull();
  });

  it('caps a pill badge at 99+', () => {
    const fixture = TestBed.createComponent(ServerRailComponent);
    fixture.componentRef.setInput('homeUnread', 250);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.item .badge')?.textContent?.trim(),
    ).toBe('99+');
  });
});
