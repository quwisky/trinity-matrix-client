import { describe, expect, it } from 'vitest';
import { showRoomIntro, type RoomIntroState } from './room-intro';

const system = { systemCategory: 'room' as const };
const said = { systemCategory: null };

function state(over: Partial<RoomIntroState> = {}): RoomIntroState {
  return {
    hasRoom: true,
    direct: false,
    canInvite: true,
    loadState: { kind: 'ready' },
    joinedMembers: 1,
    messages: [system, system],
    ...over,
  };
}

describe('showRoomIntro', () => {
  it('prompts in a room where you are alone and only system lines exist', () => {
    expect(showRoomIntro(state())).toBe(true);
  });

  it('still prompts with system messages hidden (no rows, settled empty)', () => {
    expect(
      showRoomIntro(state({ loadState: { kind: 'empty' }, messages: [] })),
    ).toBe(true);
  });

  it.each<[string, Partial<RoomIntroState>]>([
    ['no room is open', { hasRoom: false }],
    ['the room is a DM', { direct: true }],
    ['you may not invite', { canInvite: false }],
    [
      'the timeline is still loading',
      {
        loadState: { kind: 'loading', reason: 'initial-sync', partial: false },
      },
    ],
    [
      'the timeline failed',
      { loadState: { kind: 'error', reason: 'room-unavailable' } },
    ],
    ['someone else has joined', { joinedMembers: 2 }],
    ['the member list has no current authority', { joinedMembers: null }],
    ['someone has said something', { messages: [system, said] }],
  ])('stays hidden when %s', (_, over) => {
    expect(showRoomIntro(state(over))).toBe(false);
  });
});
