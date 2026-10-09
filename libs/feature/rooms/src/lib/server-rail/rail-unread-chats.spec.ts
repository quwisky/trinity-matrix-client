import { describe, expect, it } from 'vitest';
import { type UnreadRoom } from '@trinity/data-access/room-library';
import {
  buildRailUnreadChats,
  type RailUnreadChatsInput,
} from './rail-unread-chats';

const chat = (roomId: string, over: Partial<UnreadRoom> = {}): UnreadRoom => ({
  accountId: '@me:hs',
  roomId,
  name: roomId.slice(1, 2).toUpperCase() + 'chat',
  initial: 'C',
  avatarMxc: null,
  direct: false,
  unreadCount: 1,
  markedUnread: false,
  activityTs: 0,
  ...over,
});
const ben = { id: '@ben:hs', name: 'Ben', initial: 'B', avatarMxc: null };
const me = { id: '@me:hs', name: 'Me', initial: 'M', avatarMxc: null };
const build = (over: Partial<RailUnreadChatsInput>) =>
  buildRailUnreadChats({
    rooms: [],
    mode: 'up-to-5',
    open: null,
    activeAccountId: '@me:hs',
    mixed: false,
    badges: new Map([
      ['@me:hs', me],
      ['@ben:hs', ben],
    ]),
    ...over,
  });
const keys = (r: ReturnType<typeof build>) => r.entries.map((e) => e.key);

describe('buildRailUnreadChats', () => {
  it('lists nothing when the setting is Off', () => {
    expect(build({ mode: 'off', rooms: [chat('!a:hs')] })).toEqual({
      entries: [],
      overflow: 0,
    });
  });

  it('orders chats newest first across accounts', () => {
    const r = build({
      rooms: [
        chat('!a:hs', { activityTs: 1 }),
        chat('!b:hs', { accountId: '@ben:hs', activityTs: 3 }),
        chat('!c:hs', { activityTs: 2 }),
      ],
    });
    expect(keys(r)).toEqual([
      '@ben:hs\u0000!b:hs',
      '@me:hs\u0000!c:hs',
      '@me:hs\u0000!a:hs',
    ]);
  });

  it('breaks activity ties by account then room', () => {
    const r = build({
      rooms: [
        chat('!b:hs', { accountId: '@ben:hs' }),
        chat('!z:hs'),
        chat('!a:hs'),
      ],
    });
    expect(keys(r)).toEqual([
      '@ben:hs\u0000!b:hs',
      '@me:hs\u0000!a:hs',
      '@me:hs\u0000!z:hs',
    ]);
  });

  it('does not reorder the input list', () => {
    const rooms = [
      chat('!a:hs', { activityTs: 1 }),
      chat('!b:hs', { activityTs: 2 }),
    ];
    build({ rooms });
    expect(rooms.map((r) => r.roomId)).toEqual(['!a:hs', '!b:hs']);
  });

  it('never lists the open chat, but keeps the same room on another account', () => {
    const r = build({
      open: { accountId: '@me:hs', roomId: '!s:hs' },
      rooms: [chat('!s:hs'), chat('!s:hs', { accountId: '@ben:hs' })],
    });
    expect(keys(r)).toEqual(['@ben:hs\u0000!s:hs']);
  });

  it('caps Up to 5 at the newest five and counts the rest', () => {
    const rooms = Array.from({ length: 7 }, (_, i) =>
      chat(`!${i}:hs`, { activityTs: i }),
    );
    const r = build({ rooms });
    expect(keys(r)).toEqual([6, 5, 4, 3, 2].map((i) => `@me:hs\u0000!${i}:hs`));
    expect(r.overflow).toBe(2);
    expect(build({ rooms: rooms.slice(0, 5) }).overflow).toBe(0);
  });

  it('lists every chat with All', () => {
    const rooms = Array.from({ length: 7 }, (_, i) => chat(`!${i}:hs`));
    expect(build({ mode: 'all', rooms })).toMatchObject({ overflow: 0 });
    expect(build({ mode: 'all', rooms }).entries).toHaveLength(7);
  });

  it('caps the badge at 99+ but names the real count', () => {
    const [entry] = build({
      rooms: [chat('!a:hs', { name: 'Team', unreadCount: 120 })],
    }).entries;
    expect(entry.countLabel).toBe('99+');
    expect(entry.label).toBe('Team · 120 unread');
  });

  it('draws a dot for a chat that is only marked unread', () => {
    const [entry] = build({
      rooms: [
        chat('!a:hs', { name: 'Team', unreadCount: 0, markedUnread: true }),
      ],
    }).entries;
    expect(entry.countLabel).toBeNull();
    expect(entry.label).toBe('Team · marked unread');
  });

  it('badges only other accounts with one account selected', () => {
    const r = build({
      rooms: [
        chat('!a:hs', { name: 'Mine', activityTs: 2 }),
        chat('!b:hs', { name: 'Theirs', accountId: '@ben:hs', activityTs: 1 }),
      ],
    });
    expect(r.entries.map((e) => [e.accountBadge?.id ?? null, e.label])).toEqual(
      [
        [null, 'Mine · 1 unread'],
        ['@ben:hs', 'Theirs · 1 unread · Ben'],
      ],
    );
  });

  it('badges every entry when several accounts are selected', () => {
    const r = build({ mixed: true, rooms: [chat('!a:hs', { name: 'Mine' })] });
    expect(r.entries[0]).toMatchObject({
      accountBadge: me,
      label: 'Mine · 1 unread · Me',
    });
  });

  it('falls back to the user id for an account whose profile has not loaded', () => {
    const r = build({
      badges: new Map(),
      rooms: [chat('!a:hs', { name: 'X', accountId: '@zed:hs' })],
    });
    expect(r.entries[0].accountBadge).toEqual({
      id: '@zed:hs',
      name: '@zed:hs',
      initial: 'Z',
      avatarMxc: null,
    });
  });

  it('carries the exact account and room into the click', () => {
    expect(
      build({ rooms: [chat('!a:hs', { accountId: '@ben:hs' })] }).entries[0]
        .selection,
    ).toEqual({ accountId: '@ben:hs', roomId: '!a:hs' });
  });
});
