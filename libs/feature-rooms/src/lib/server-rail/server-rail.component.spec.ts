import { render, screen } from '@trinity/testing';
import { type SpaceSummary } from '@trinity/data-access/rooms';
import { AvatarComponent } from '@trinity/ui';
import { MockComponent } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { ServerRailComponent, type RailUnread } from './server-rail.component';

function space(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: '!s:hs',
    accountId: '@me:hs',
    name: 'Space',
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
    ...over,
  };
}

/** Build an unread object, overriding only the counts a test cares about. */
const unread = (over: Partial<RailUnread> = {}): RailUnread => ({
  recent: 0,
  home: 0,
  rooms: 0,
  perSpace: {},
  ...over,
});

// Fixed pill order at the head of the rail: Recent, Home, Rooms, then one per space.
const RECENT = 0;
const HOME = 1;
const ROOMS = 2;
const FIRST_SPACE = 3;

describe('ServerRailComponent', () => {
  it('renders Recent, Home, Rooms plus a pill per space', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [
          space({ id: '!a:hs', name: 'Alpha' }),
          space({ id: '!b:hs', name: 'Beta' }),
        ],
      },
      imports: [MockComponent(AvatarComponent)],
    });

    expect(container.querySelector('.pill.recent')).toBeTruthy();
    expect(container.querySelector('.pill.home')).toBeTruthy();
    expect(container.querySelector('.pill.rooms')).toBeTruthy();
    const spacePills = container.querySelectorAll(
      '.pill:not(.recent):not(.home):not(.add):not(.rooms)',
    );
    expect(spacePills.length).toBe(2);
  });

  it('emits showRecent when the Recent pill is clicked', async () => {
    const { fixture } = await render(ServerRailComponent, {
      imports: [MockComponent(AvatarComponent)],
    });

    let shown = false;
    fixture.componentInstance.showRecent.subscribe(() => (shown = true));
    screen.getByTestId('rail-recent').click();

    expect(shown).toBe(true);
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
      .querySelector<HTMLElement>(
        '.pill:not(.recent):not(.home):not(.add):not(.rooms)',
      )!
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

  it('lights Recent while its view is active and dims Home', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { recentActive: true },
      imports: [MockComponent(AvatarComponent)],
    });

    const items = container.querySelectorAll('.item');
    expect(items[RECENT].classList.contains('active')).toBe(true);
    expect(items[HOME].classList.contains('active')).toBe(false);

    // Leaving Recent hands the active marker back to Home (no space, no Rooms view).
    fixture.componentRef.setInput('recentActive', false);
    fixture.detectChanges();
    expect(items[RECENT].classList.contains('active')).toBe(false);
    expect(items[HOME].classList.contains('active')).toBe(true);
  });

  it('marks the active space (Home active when nothing else is)', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s:hs' })] },
      imports: [MockComponent(AvatarComponent)],
    });

    // No Recent, no Rooms, no space → Home is the active item.
    const items = container.querySelectorAll('.item');
    expect(items[HOME].classList.contains('active')).toBe(true);

    // Selecting the space moves the active marker to its item.
    fixture.componentRef.setInput('activeSpaceId', '!s:hs');
    fixture.detectChanges();
    expect(items[RECENT].classList.contains('active')).toBe(false);
    expect(items[HOME].classList.contains('active')).toBe(false);
    expect(items[ROOMS].classList.contains('active')).toBe(false);
    expect(items[FIRST_SPACE].classList.contains('active')).toBe(true);
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
    expect(items[HOME].classList.contains('active')).toBe(true);
    expect(items[ROOMS].classList.contains('active')).toBe(false);

    fixture.componentRef.setInput('roomsActive', true);
    fixture.detectChanges();
    expect(items[HOME].classList.contains('active')).toBe(false);
    expect(items[ROOMS].classList.contains('active')).toBe(true);
  });

  it('shows unread badges on the Recent, Home, Rooms and space pills', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({
          recent: 9,
          home: 3,
          rooms: 7,
          perSpace: { '!s:hs': 12 },
        }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    const items = container.querySelectorAll('.item');
    expect(items[RECENT].querySelector('.badge')?.textContent?.trim()).toBe(
      '9',
    );
    expect(items[HOME].querySelector('.badge')?.textContent?.trim()).toBe('3');
    expect(items[ROOMS].querySelector('.badge')?.textContent?.trim()).toBe('7');
    expect(
      items[FIRST_SPACE].querySelector('.badge')?.textContent?.trim(),
    ).toBe('12');
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

    // order: Recent, Home, Rooms, a, b, c, add
    const items = container.querySelectorAll('.item');
    expect(
      items[FIRST_SPACE].querySelector('.badge')?.textContent?.trim(),
    ).toBe('1');
    expect(items[FIRST_SPACE + 1].querySelector('.badge')).toBeNull(); // zero → hidden
    expect(
      items[FIRST_SPACE + 2].querySelector('.badge')?.textContent?.trim(),
    ).toBe('42');
  });

  it('hides a space badge once its count transitions to 0 via a setInput change', async () => {
    const { fixture, container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [space({ id: '!s:hs' })],
        unread: unread({ perSpace: { '!s:hs': 6 } }),
      },
      imports: [MockComponent(AvatarComponent)],
    });

    const spaceItem = () => container.querySelectorAll('.item')[FIRST_SPACE];
    expect(spaceItem().querySelector('.badge')?.textContent?.trim()).toBe('6');

    fixture.componentRef.setInput(
      'unread',
      unread({ perSpace: { '!s:hs': 0 } }),
    );
    fixture.detectChanges();

    expect(spaceItem().querySelector('.badge')).toBeNull();
  });

  it('badges each space pill with its owning account in the mixed view', async () => {
    // Use the real AvatarComponent (its badge renders without the image resolver) so the
    // account-badge overlay is actually present.
    const { container } = await render(ServerRailComponent, {
      inputs: {
        spaces: [
          space({ id: '!s1:hs', accountId: '@me:hs' }),
          space({ id: '!s2:hs', accountId: '@alt:hs' }),
        ],
        accountBadges: new Map([
          ['@me:hs', { initial: 'M', name: 'Me' }],
          ['@alt:hs', { initial: 'A', name: 'Alt' }],
        ]),
      },
    });

    expect(
      container.querySelectorAll('[data-testid="account-badge"]').length,
    ).toBe(2);
  });

  it('shows no space-pill badge without an account-badge map', async () => {
    const { container } = await render(ServerRailComponent, {
      inputs: { spaces: [space({ id: '!s1:hs' })] },
    });
    expect(container.querySelector('[data-testid="account-badge"]')).toBeNull();
  });
});
