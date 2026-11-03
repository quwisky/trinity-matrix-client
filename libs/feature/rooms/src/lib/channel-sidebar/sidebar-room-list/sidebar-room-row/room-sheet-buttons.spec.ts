import { describe, expect, it, vi } from 'vitest';
import { roomSummary } from '../../../testing/room-summary.fixture';
import { roomSheetButtons } from './room-sheet-buttons';

function buttons(over: Partial<Parameters<typeof roomSheetButtons>[0]> = {}) {
  const emit = vi.fn();
  const list = roomSheetButtons({
    room: roomSummary(),
    active: false,
    mode: 'all',
    canReport: true,
    spaceActive: false,
    canCurate: true,
    curateReason: null,
    emit,
    ...over,
  });
  return { list, emit };
}

const texts = (list: { text: string }[]) => list.map((b) => b.text);

describe('roomSheetButtons', () => {
  it('mirrors the kebab menu, ending in leave and cancel', () => {
    const { list } = buttons();
    expect(texts(list)).toEqual([
      'Favourite',
      'Low priority',
      'Mark as unread',
      'Mute except mentions & keywords',
      'Mute everything',
      'Report room',
      'Leave room',
      'Cancel',
    ]);
    expect(list.at(-2)?.variant).toBe('danger');
  });

  it('offers Mark as read for an unread room and nothing for the open one', () => {
    expect(
      texts(buttons({ room: roomSummary({ hasUnread: true }) }).list),
    ).toContain('Mark as read');
    const open = texts(buttons({ active: true }).list);
    expect(open).not.toContain('Mark as unread');
    expect(open).not.toContain('Mark as read');
  });

  it('flips the favourite and priority labels', () => {
    const list = texts(
      buttons({ room: roomSummary({ favourite: true, lowPriority: true }) })
        .list,
    );
    expect(list).toContain('Unfavourite');
    expect(list).toContain('Restore to list');
  });

  it('drops the current notification mode, and Report when the server takes none', () => {
    const list = texts(buttons({ mode: 'mute', canReport: false }).list);
    expect(list).toContain('Notify for all messages');
    expect(list).not.toContain('Mute everything');
    expect(list).not.toContain('Report room');
  });

  it('offers Remove from space only in a space, and says why when it is refused', () => {
    expect(texts(buttons().list)).not.toContain('Remove from space');
    expect(texts(buttons({ spaceActive: true }).list)).toContain(
      'Remove from space',
    );
    const refused = buttons({
      spaceActive: true,
      canCurate: false,
      curateReason: 'You cannot manage this space',
    }).list.find((b) => b.text.startsWith('Remove from space'));
    expect(refused?.text).toBe(
      'Remove from space: You cannot manage this space',
    );
    expect(refused?.disabled).toBe(true);
  });

  it('leaves out a refused Remove from space that cannot say why', () => {
    const list = texts(buttons({ spaceActive: true, canCurate: false }).list);
    expect(list.some((t) => t.startsWith('Remove from space'))).toBe(false);
  });

  it('emits the same actions as the menu', () => {
    const room = roomSummary();
    const { list, emit } = buttons({ room });
    list.find((b) => b.text === 'Leave room')?.handler?.();
    list.find((b) => b.text === 'Mute everything')?.handler?.();
    expect(emit.mock.calls).toEqual([
      [{ kind: 'leave', room }],
      [{ kind: 'notify', room, mode: 'mute' }],
    ]);
  });
});
