import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { InvitesService, type PendingInvite } from './invites.service';
import {
  RoomsService,
  type RoomSummary,
  type UserSearchResult,
} from './rooms.service';
import { SearchService } from './search.service';
import { SpacesService, type SpaceSummary } from './spaces.service';

function room(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: '!r:hs',
    name: 'room',
    initial: 'R',
    avatarMxc: null,
    topic: '',
    memberCount: 0,
    encrypted: false,
    unreadCount: 0,
    highlightCount: 0,
    hasUnread: false,
    activityTs: 0,
    ...over,
  };
}

function space(over: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: '!s:hs',
    name: 'space',
    initial: 'S',
    avatarMxc: null,
    childRoomIds: [],
    ...over,
  };
}

function invite(over: Partial<PendingInvite> = {}): PendingInvite {
  return {
    roomId: '!i:hs',
    name: 'invite',
    initial: 'I',
    avatarMxc: null,
    inviterName: 'Alice',
    isSpace: false,
    isDirect: false,
    ...over,
  };
}

function setup(opts: {
  rooms?: RoomSummary[];
  directRoomIds?: Set<string>;
  spaces?: SpaceSummary[];
  invites?: PendingInvite[];
  searchUsers?: ReturnType<typeof vi.fn>;
}): { svc: SearchService; searchUsers: ReturnType<typeof vi.fn> } {
  const searchUsers =
    opts.searchUsers ?? vi.fn(() => of<UserSearchResult[]>([]));
  TestBed.configureTestingModule({
    providers: [
      SearchService,
      {
        provide: RoomsService,
        useValue: {
          rooms: signal(opts.rooms ?? []),
          directRoomIds: signal<ReadonlySet<string>>(
            opts.directRoomIds ?? new Set(),
          ),
          searchUsers,
        },
      },
      {
        provide: SpacesService,
        useValue: { spaces: signal(opts.spaces ?? []) },
      },
      {
        provide: InvitesService,
        useValue: { pendingInvites: signal(opts.invites ?? []) },
      },
    ],
  });
  return { svc: TestBed.inject(SearchService), searchUsers };
}

describe('SearchService.localResults ranking', () => {
  it('ranks exact > prefix > word-boundary > substring, case-insensitively', () => {
    const { svc } = setup({
      rooms: [
        room({ id: '!sub:hs', name: 'oxygen' }), // substring: gen not on a boundary
        room({ id: '!word:hs', name: 'random gen squad' }), // word-boundary
        room({ id: '!prefix:hs', name: 'general' }), // prefix
        room({ id: '!exact:hs', name: 'gen' }), // exact
      ],
    });

    expect(svc.localResults('GEN').map((r) => r.id)).toEqual([
      '!exact:hs',
      '!prefix:hs',
      '!word:hs',
      '!sub:hs',
    ]);
  });

  it('matches a room topic only as a substring fallback', () => {
    const { svc } = setup({
      rooms: [room({ id: '!t:hs', name: 'lounge', topic: 'project planning' })],
    });

    const [hit] = svc.localResults('planning');
    expect(hit?.id).toBe('!t:hs');
    expect(hit?.score).toBe(10); // substring bucket, via the topic
  });

  it('drops non-matches', () => {
    const { svc } = setup({ rooms: [room({ id: '!a:hs', name: 'alpha' })] });
    expect(svc.localResults('zzz')).toEqual([]);
  });

  it('breaks score ties by recency then title', () => {
    const { svc } = setup({
      rooms: [
        room({ id: '!old:hs', name: 'general old', activityTs: 100 }),
        room({ id: '!new:hs', name: 'general new', activityTs: 300 }),
      ],
    });
    // Both are prefix matches for "general"; the more recent sorts first.
    expect(svc.localResults('general').map((r) => r.id)).toEqual([
      '!new:hs',
      '!old:hs',
    ]);
  });
});

describe('SearchService.localResults aggregation', () => {
  it('tags DMs via directRoomIds, spaces, and invites by kind', () => {
    const { svc } = setup({
      rooms: [
        room({ id: '!dm:hs', name: 'bob' }),
        room({ id: '!room:hs', name: 'bobby room' }),
      ],
      directRoomIds: new Set(['!dm:hs']),
      spaces: [space({ id: '!sp:hs', name: 'bob space' })],
      invites: [
        invite({ roomId: '!inv:hs', name: 'bob invite', inviterName: 'Carol' }),
      ],
    });

    const byId = new Map(svc.localResults('bob').map((r) => [r.id, r]));
    expect(byId.get('!dm:hs')?.kind).toBe('dm');
    expect(byId.get('!room:hs')?.kind).toBe('room');
    expect(byId.get('!sp:hs')?.kind).toBe('space');
    expect(byId.get('!inv:hs')?.kind).toBe('invite');
    expect(byId.get('!inv:hs')?.subtitle).toBe('Invited by Carol');
  });

  it('surfaces the room encrypted flag for the lock badge', () => {
    const { svc } = setup({
      rooms: [room({ id: '!e:hs', name: 'secret', encrypted: true })],
    });
    expect(svc.localResults('secret')[0]?.encrypted).toBe(true);
  });

  it('empty query returns recents ordered by activity', () => {
    const { svc } = setup({
      rooms: [
        room({ id: '!old:hs', name: 'old', activityTs: 100 }),
        room({ id: '!new:hs', name: 'new', activityTs: 300 }),
        room({ id: '!mid:hs', name: 'mid', activityTs: 200 }),
      ],
      spaces: [space({ id: '!sp:hs', name: 'zeta space' })],
    });

    const ids = svc.localResults('').map((r) => r.id);
    // Rooms (recency) lead; the zero-activity space trails.
    expect(ids).toEqual(['!new:hs', '!mid:hs', '!old:hs', '!sp:hs']);
  });

  it('caps the result count at the limit', () => {
    const rooms = Array.from({ length: 10 }, (_, i) =>
      room({ id: `!r${i}:hs`, name: `room ${i}`, activityTs: i }),
    );
    const { svc } = setup({ rooms });
    expect(svc.localResults('room', 3)).toHaveLength(3);
  });
});

describe('SearchService.searchPeople', () => {
  it('does not query the directory for a term shorter than two characters', async () => {
    const searchUsers = vi.fn(() => of<UserSearchResult[]>([]));
    const { svc } = setup({ searchUsers });

    const results = await firstValueFrom(svc.searchPeople('b'));

    expect(results).toEqual([]);
    expect(searchUsers).not.toHaveBeenCalled();
  });

  it('maps directory hits to user results', async () => {
    const searchUsers = vi.fn(() =>
      of<UserSearchResult[]>([
        { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://a/b' },
      ]),
    );
    const { svc } = setup({ searchUsers });

    const [hit] = await firstValueFrom(svc.searchPeople('bob'));

    expect(searchUsers).toHaveBeenCalledWith('bob');
    expect(hit).toEqual({
      kind: 'user',
      id: '@bob:hs',
      title: 'Bob',
      subtitle: '@bob:hs',
      avatarMxc: 'mxc://a/b',
      initial: 'B',
      score: 0,
    });
  });

  it('degrades a failed directory lookup to an empty list', async () => {
    const searchUsers = vi.fn(() => throwError(() => new Error('offline')));
    const { svc } = setup({ searchUsers });

    await expect(firstValueFrom(svc.searchPeople('bob'))).resolves.toEqual([]);
  });
});
