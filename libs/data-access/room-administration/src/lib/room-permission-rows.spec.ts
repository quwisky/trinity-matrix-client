import { describe, expect, it } from 'vitest';
import { applyChanges, permissionRows, readRows } from './room-permission-rows';

const room = permissionRows('room');

describe('readRows', () => {
  it('reads spec defaults when keys are absent', () => {
    const levels = readRows({}, room);
    expect(levels.get('send-messages')).toBe(0);
    expect(levels.get('invite')).toBe(0);
    expect(levels.get('redact')).toBe(50);
    expect(levels.get('kick')).toBe(50);
    expect(levels.get('ban')).toBe(50);
    expect(levels.get('mention-room')).toBe(50);
    expect(levels.get('users-default')).toBe(0);
    expect(levels.get('state-default')).toBe(50);
    expect(levels.get('join-rule')).toBe(50);
    expect(levels.get('send-reactions')).toBe(0);
  });

  it("falls back to the content's own defaults", () => {
    const levels = readRows({ state_default: 70, events_default: 10 }, room);
    expect(levels.get('join-rule')).toBe(70);
    expect(levels.get('send-reactions')).toBe(10);
  });

  it('ignores non-integer junk by using the default', () => {
    const levels = readRows(
      { invite: '10', kick: 1.5, events: { 'm.reaction': 'x' } },
      room,
    );
    expect(levels.get('invite')).toBe(0);
    expect(levels.get('kick')).toBe(50);
    expect(levels.get('send-reactions')).toBe(0);
  });

  it('reads Mixed when a multi-type row differs', () => {
    const mixed = readRows(
      { events: { 'm.room.name': 50, 'm.room.topic': 0 } },
      room,
    );
    expect(mixed.get('profile')).toBe('mixed');
    const same = readRows(
      {
        events: {
          'm.room.name': 100,
          'm.room.topic': 100,
          'm.room.avatar': 100,
        },
      },
      room,
    );
    expect(same.get('profile')).toBe(100);
  });
});

describe('applyChanges', () => {
  it('keeps users, unknown keys and other events', () => {
    const latest = {
      users: { '@a:x': 100 },
      events: { 'm.room.server_acl': 100 },
      custom_key: true,
      notifications: { room: 50, other: 1 },
    };
    const snapshot = structuredClone(latest);
    const out = applyChanges(
      latest,
      room,
      new Map([
        ['send-messages', 50],
        ['mention-room', 100],
        ['nope', 5],
      ]),
    );
    expect(out).toEqual({
      ...snapshot,
      events_default: 50,
      notifications: { room: 100, other: 1 },
    });
    expect(latest).toEqual(snapshot);
  });

  it('writes all types of a multi-type row', () => {
    const out = applyChanges({}, room, new Map([['profile', 0]]));
    expect(out['events']).toEqual({
      'm.room.name': 0,
      'm.room.topic': 0,
      'm.room.avatar': 0,
    });
  });
});

describe('permissionRows', () => {
  it('lists space rows in order', () => {
    expect(permissionRows('space').map((r) => r.id)).toEqual([
      'space-children',
      'invite',
      'kick',
      'ban',
      'users-default',
      'profile',
      'join-rule',
      'permissions',
      'state-default',
    ]);
  });
});
