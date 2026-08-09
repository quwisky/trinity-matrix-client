import { describe, expect, it } from 'vitest';
import { type RoomSummary } from '@trinity/data-access/rooms';
import { stepList, stepUnread } from './room-navigation';

const IDS = ['!a', '!b', '!c'];

function room(id: string, hasUnread = false): RoomSummary {
  return {
    id,
    accountId: '@me:hs',
    accountIds: ['@me:hs'],
    name: id,
    initial: id[1].toUpperCase(),
    markedUnread: false,
    avatarMxc: null,
    topic: '',
    memberCount: 0,
    encrypted: false,
    unreadCount: hasUnread ? 1 : 0,
    highlightCount: 0,
    hasUnread,
    lastMessage: '',
    activityTs: 0,
    favourite: false,
    lowPriority: false,
  };
}

describe('stepList', () => {
  it('moves to the neighbour in each direction', () => {
    expect(stepList(IDS, '!b', 'next')).toBe('!c');
    expect(stepList(IDS, '!b', 'previous')).toBe('!a');
  });

  it('wraps at both ends', () => {
    expect(stepList(IDS, '!c', 'next')).toBe('!a');
    expect(stepList(IDS, '!a', 'previous')).toBe('!c');
  });

  it('starts from the appropriate end when nothing is active', () => {
    expect(stepList(IDS, null, 'next')).toBe('!a');
    expect(stepList(IDS, null, 'previous')).toBe('!c');
  });

  it('starts from the end when the active room is not in the list', () => {
    expect(stepList(IDS, '!gone', 'next')).toBe('!a');
  });

  it('returns null for an empty list', () => {
    expect(stepList([], '!a', 'next')).toBeNull();
  });

  it('stays put with a single room', () => {
    expect(stepList(['!a'], '!a', 'next')).toBe('!a');
  });
});

describe('stepUnread', () => {
  // '!a' read, '!b' unread, '!c' unread, '!d' read.
  const rooms = [room('!a'), room('!b', true), room('!c', true), room('!d')];

  it('walks only the unread rooms, wrapping', () => {
    expect(stepUnread(rooms, '!b', 'next')).toBe('!c');
    expect(stepUnread(rooms, '!c', 'next')).toBe('!b'); // wrap
    expect(stepUnread(rooms, '!b', 'previous')).toBe('!c'); // wrap back
  });

  it('lands on the first/last unread from a read room', () => {
    expect(stepUnread(rooms, '!a', 'next')).toBe('!b');
    expect(stepUnread(rooms, '!a', 'previous')).toBe('!c');
    expect(stepUnread(rooms, null, 'next')).toBe('!b');
  });

  it('returns null when nothing is unread', () => {
    expect(stepUnread([room('!a'), room('!b')], '!a', 'next')).toBeNull();
  });
});
