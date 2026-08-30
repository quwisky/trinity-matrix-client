import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountScopeService } from './account-scope.service';
import { InvitesService, type PendingInvite } from './invites.service';
import { MixedRoomsService } from './mixed-rooms.service';
import { MixedSpacesService } from './mixed-spaces.service';
import { RoomLibrarySearchService } from './room-library-search.service';
import { RoomLibraryService, type RoomSummary } from './room-library.service';
import { SpacesService, type SpaceSummary } from './spaces.service';

function room(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: '!r:hs',
    accountId: '@me:hs',
    accountIds: ['@me:hs'],
    name: 'room',
    initial: 'R',
    avatarMxc: null,
    topic: '',
    memberCount: 0,
    encrypted: false,
    unreadCount: 0,
    highlightCount: 0,
    hasUnread: false,
    markedUnread: false,
    lastMessage: '',
    activityTs: 0,
    favourite: false,
    lowPriority: false,
    ...over,
  };
}

function space(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: '!s:hs',
    accountId: '@me:hs',
    name: 'space',
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
    ...over,
  };
}

function setup(
  options: {
    rooms?: RoomSummary[];
    directIds?: ReadonlySet<string>;
    spaces?: SpaceSummary[];
    mixing?: boolean;
    mixedRooms?: RoomSummary[];
    mixedSpaces?: SpaceSummary[];
    invites?: PendingInvite[];
  } = {},
): RoomLibrarySearchService {
  TestBed.configureTestingModule({
    providers: [
      RoomLibrarySearchService,
      MockProvider(RoomLibraryService, {
        rooms: signal(options.rooms ?? []),
        directRoomIds: signal(options.directIds ?? new Set<string>()),
      }),
      MockProvider(SpacesService, { spaces: signal(options.spaces ?? []) }),
      MockProvider(InvitesService, {
        pendingInvites: signal(options.invites ?? []),
      }),
      MockProvider(AccountScopeService, {
        mixing: signal(options.mixing ?? false),
      }),
      MockProvider(MixedRoomsService, {
        rooms: signal(options.mixedRooms ?? []),
      }),
      MockProvider(MixedSpacesService, {
        spaces: signal(options.mixedSpaces ?? []),
      }),
    ],
  });
  return TestBed.inject(RoomLibrarySearchService);
}

describe('RoomLibrarySearchService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('ranks exact, prefix, word-boundary, then substring matches', () => {
    const search = setup({
      rooms: [
        room({ id: '!substring:hs', name: 'oxygen' }),
        room({ id: '!word:hs', name: 'random gen squad' }),
        room({ id: '!prefix:hs', name: 'general' }),
        room({ id: '!exact:hs', name: 'gen' }),
      ],
    });

    expect(search.search('GEN').map((result) => result.id)).toEqual([
      '!exact:hs',
      '!prefix:hs',
      '!word:hs',
      '!substring:hs',
    ]);
  });

  it('classifies DMs and spaces without reaching outside Room Library', () => {
    const search = setup({
      rooms: [room({ id: '!dm:hs', name: 'Bob' })],
      directIds: new Set(['!dm:hs']),
      spaces: [space({ id: '!space:hs', name: 'Team' })],
    });

    expect(search.search('').map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: 'dm', id: '!dm:hs' },
      { kind: 'space', id: '!space:hs' },
    ]);
  });

  it('uses activity as the empty-query recency tiebreak', () => {
    const search = setup({
      rooms: [
        room({ id: '!old:hs', name: 'old', activityTs: 1 }),
        room({ id: '!new:hs', name: 'new', activityTs: 2 }),
      ],
    });

    expect(search.search('').map((result) => result.id)).toEqual([
      '!new:hs',
      '!old:hs',
    ]);
  });

  it('keeps an invite fully qualified and preserves its destination kind', () => {
    const search = setup({
      invites: [
        {
          roomId: '!space:hs',
          accountId: '@me:hs',
          name: 'Team',
          initial: 'T',
          avatarMxc: null,
          inviterName: 'Alice',
          isSpace: true,
          isDirect: false,
        },
      ],
    });

    expect(search.search('Team')[0]).toMatchObject({
      kind: 'invite',
      id: '!space:hs',
      accountId: '@me:hs',
      isSpace: true,
      isDirect: false,
    });
  });

  it('scopes before applying the result limit in mixed-account mode', () => {
    const search = setup({
      mixing: true,
      mixedRooms: [
        room({ id: '!mine:hs', accountId: '@me:hs', name: 'room' }),
        room({ id: '!other:hs', accountId: '@other:hs', name: 'room' }),
      ],
    });

    expect(search.search('', 1, '@me:hs').map((result) => result.id)).toEqual([
      '!mine:hs',
    ]);
  });
});
