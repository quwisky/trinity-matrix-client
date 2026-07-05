import { render, screen } from '@testing-library/angular';
import { type SpaceSummary } from '@trinity/data-access-rooms';
import { AvatarComponent } from '@trinity/ui';
import { MockComponent } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { ServerRailComponent, type RailUnread } from './server-rail.component';

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

/** Build an unread object, overriding only the counts a test cares about. */
const unread = (over: Partial<RailUnread> = {}): RailUnread => ({
  home: 0,
  rooms: 0,
  perSpace: {},
  ...over,
});

describe('ServerRailComponent', () => {
  it('renders Home plus a pill per space', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [
          space({ id: '!a:hs', name: 'Alpha' }),
          space({ id: '!b:hs', name: 'Beta' }),
        ],
      },
      imports: [MockComponent(AvatarComponent)],
    });

    expect(container.querySelector('.pill.home')).toBeTruthy();
    expect(container.querySelector('.pill.rooms')).toBeTruthy();
    const spacePills = container.querySelectorAll(
      '.pill:not(.home):not(.add):not(.rooms)',
    );
    expect(spacePills.length).toBe(2);
  });

  it('emits selectSpace(null) when Home is clicked', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let selected: string | null = 'unset';
    fixture.componentInstance.selectSpace.subscribe((v) => (selected = v));
    container.querySelector<HTMLElement>('.pill.home')!.click();

    expect(selected).toBeNull();
  });

  it('emits selectSpace(spaceId) when a space pill is clicked', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s:hs' })] },
      imports: [MockComponent(AvatarComponent)],
    });

    let selected: string | null = null;
    fixture.componentInstance.selectSpace.subscribe((v) => (selected = v));
    container
      .querySelector<HTMLElement>('.pill:not(.home):not(.add):not(.rooms)')!
      .click();

    expect(selected).toBe('!s:hs');
  });

  it('emits createSpace when the add ("+") pill is clicked', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let created = false;
    fixture.componentInstance.createSpace.subscribe(() => (created = true));
    const add = container.querySelector<HTMLButtonElement>('.pill.add')!;
    expect(add.disabled).toBe(false); // the affordance is enabled now
    add.click();

    expect(created).toBe(true);
  });

  it('marks the active space (Home active when no space is selected)', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s:hs' })] },
      imports: [MockComponent(AvatarComponent)],
    });

    // No selection → Home is the active item.
    const homeItem = container.querySelector('.item')!;
    expect(homeItem.classList.contains('active')).toBe(true);

    // Selecting the space moves the active marker to its item
    // (order: Home, Rooms, space, add).
    fixture.componentRef.setInput('activeSpaceId', '!s:hs');
    fixture.detectChanges();
    const items = container.querySelectorAll('.item');
    expect(items[0].classList.contains('active')).toBe(false); // Home
    expect(items[1].classList.contains('active')).toBe(false); // Rooms
    expect(items[2].classList.contains('active')).toBe(true); // the space
  });

  it('emits showRooms when the Rooms pill is clicked', async () => {
    const { fixture } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let shown = false;
    fixture.componentInstance.showRooms.subscribe(() => (shown = true));
    screen.getByTestId('rail-rooms').click();

    expect(shown).toBe(true);
  });

  it('marks the Rooms view active and deactivates Home when roomsActive is set', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });
    const items = container.querySelectorAll('.item');

    // Default (no Rooms view): Home active, Rooms inactive.
    expect(items[0].classList.contains('active')).toBe(true); // Home
    expect(items[1].classList.contains('active')).toBe(false); // Rooms

    fixture.componentRef.setInput('roomsActive', true);
    fixture.detectChanges();
    expect(items[0].classList.contains('active')).toBe(false); // Home no longer active
    expect(items[1].classList.contains('active')).toBe(true); // Rooms active
  });

  it('shows unread badges on the Home, Rooms and space pills', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({ home: 3, rooms: 7, perSpace: { '!s:hs': 12 } }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    // order: Home, Rooms, space, add
    const items = container.querySelectorAll('.item');
    expect(items[0].querySelector('.badge')?.textContent?.trim()).toBe('3');
    expect(items[1].querySelector('.badge')?.textContent?.trim()).toBe('7');
    expect(items[2].querySelector('.badge')?.textContent?.trim()).toBe('12');
  });

  it('hides a pill badge when its unread count is zero', async () => {
    const { container } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('caps a pill badge at 99+', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: { unread: unread({ home: 250 }) },
      imports: [MockComponent(AvatarComponent)],
    });
    expect(container.querySelector('.item .badge')?.textContent?.trim()).toBe(
      '99+',
    );
  });

  it('shows a distinct badge value per space pill among several spaces', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [
          space({ id: '!a:hs', name: 'Alpha' }),
          space({ id: '!b:hs', name: 'Bravo' }),
          space({ id: '!c:hs', name: 'Charlie' }),
        ],
        unread: unread({
          perSpace: {
            '!a:hs': 1,
            '!b:hs': 0,
            '!c:hs': 42,
          },
        }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    // order: Home, Rooms, a, b, c, add
    const items = container.querySelectorAll('.item');
    expect(items[2].querySelector('.badge')?.textContent?.trim()).toBe('1');
    expect(items[3].querySelector('.badge')).toBeNull(); // zero → hidden
    expect(items[4].querySelector('.badge')?.textContent?.trim()).toBe('42');
  });

  it('hides a space badge once its count transitions to 0 via a setInput change', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({ perSpace: { '!s:hs': 6 } }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    const spaceItem = () => container.querySelectorAll('.item')[2];
    expect(spaceItem().querySelector('.badge')?.textContent?.trim()).toBe('6');

    fixture.componentRef.setInput(
      'unread',
      unread({ perSpace: { '!s:hs': 0 } }),
    );
    fixture.detectChanges();

    expect(spaceItem().querySelector('.badge')).toBeNull();
  });
});
