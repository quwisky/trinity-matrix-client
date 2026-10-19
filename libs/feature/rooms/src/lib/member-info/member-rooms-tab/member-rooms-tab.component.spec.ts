import { type CommonRoom } from '@trinity/data-access/room-library';
import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { MemberRoomsTabComponent } from './member-rooms-tab.component';

const room = (over: Partial<CommonRoom>): CommonRoom => ({
  id: '!a:hs',
  accountId: '@me:hs',
  name: 'Design',
  initial: 'D',
  avatarMxc: null,
  kind: 'room',
  memberCount: 12,
  ...over,
});

const ROOMS = [
  room({}),
  room({ id: '!b:hs', name: 'Bob', kind: 'direct', memberCount: 2 }),
  room({ id: '!c:hs', name: 'Guild', kind: 'space', memberCount: 40 }),
];

async function build(rooms: readonly CommonRoom[] | null) {
  const open = vi.fn();
  const view = await render(MemberRoomsTabComponent, {
    inputs: { rooms },
    on: { open },
  });
  return { open, ...view };
}

describe('MemberRoomsTabComponent', () => {
  it('lists each room with its member count, "Direct message" or "Space"', async () => {
    await build(ROOMS);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('12 members')).toBeTruthy();
    expect(screen.getByText('Direct message')).toBeTruthy();
    expect(screen.getByText('Space')).toBeTruthy();
  });

  it('gives rooms and spaces the place avatar and a direct message the person avatar', async () => {
    const { container } = await build(ROOMS);
    const shapes = [...container.querySelectorAll('trn-avatar')].map((avatar) =>
      avatar.getAttribute('data-shape'),
    );
    expect(shapes).toEqual(['place', 'person', 'place']);
  });

  it('shows "No other rooms in common." when empty', async () => {
    await build([]);
    expect(screen.getByText('No other rooms in common.')).toBeTruthy();
  });

  it('shows "Loading…" while null', async () => {
    const { container } = await build(null);
    expect(container.textContent?.trim()).toBe('Loading…');
  });

  it('activating a room emits open', async () => {
    const { open } = await build(ROOMS);
    // Enter and Space reach this through the native button's own click; jsdom has no such
    // keyboard-to-click step, so a click is the observable activation.
    screen.getByRole('button', { name: /Design/ }).click();
    screen.getByRole('button', { name: /Guild/ }).click();
    expect(open.mock.calls).toEqual([[ROOMS[0]], [ROOMS[2]]]);
  });

  it('a room that disappears from the input disappears from the list', async () => {
    const { fixture } = await build(ROOMS);
    fixture.componentRef.setInput('rooms', [ROOMS[1]]);
    await fixture.whenStable();
    expect(screen.queryByRole('button', { name: /Design/ })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
