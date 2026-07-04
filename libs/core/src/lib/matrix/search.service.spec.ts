import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  EventType,
  RelationType,
  SearchOrderBy,
  type ISearchRequestBody,
} from 'matrix-js-sdk';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { InvitesService, type PendingInvite } from './invites.service';
import { MatrixClientService } from './matrix-client.service';
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
    lastMessage: '',
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
  matrix?: Partial<MatrixClientService>;
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
      {
        provide: MatrixClientService,
        useValue: opts.matrix ?? { isInitialized: false, instance: {} },
      },
    ],
  });
  return { svc: TestBed.inject(SearchService), searchUsers };
}

/** A fake decrypted `m.room.message` event for the loaded-timeline search tests. */
function messageEvent(over: {
  id: string;
  sender?: string;
  body?: string;
  ts?: number;
  type?: string;
  replace?: boolean;
  decryptionFailure?: boolean;
}) {
  const type = over.type ?? EventType.RoomMessage;
  return {
    getId: () => over.id,
    getType: () => type,
    getSender: () => over.sender ?? '@alice:hs',
    getTs: () => over.ts ?? 0,
    getContent: () => ({ body: over.body ?? '' }),
    isDecryptionFailure: () => over.decryptionFailure ?? false,
    isRelation: (rel: string) =>
      over.replace === true && rel === RelationType.Replace,
  };
}

/** A fake Room exposing just the surface SearchService touches. */
function fakeRoom(opts: {
  encrypted?: boolean;
  events?: ReturnType<typeof messageEvent>[];
  member?: (
    id: string,
  ) => { name: string; getMxcAvatarUrl: () => string | null } | null;
}) {
  return {
    hasEncryptionStateEvent: () => opts.encrypted ?? false,
    getLiveTimeline: () => ({ getEvents: () => opts.events ?? [] }),
    getMember:
      opts.member ??
      ((id: string) => ({ name: id, getMxcAvatarUrl: () => null })),
  };
}

/** A fake MatrixClient + MatrixClientService for the message-search tests. */
function matrixWith(
  client: Record<string, unknown>,
): Partial<MatrixClientService> {
  return {
    isInitialized: true,
    // The service only reads the methods it calls; cast past the full SDK surface.
    instance: { getUserId: () => '@me:hs', ...client } as never,
  };
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

describe('SearchService.searchLoadedMessages', () => {
  it('matches a substring, ranks most-recent first, and builds a snippet', () => {
    const events = [
      messageEvent({ id: '$1', body: 'hello there world', ts: 100 }),
      messageEvent({ id: '$2', body: 'a HELLO again', ts: 300 }),
      messageEvent({ id: '$3', body: 'no match here', ts: 200 }),
    ];
    const { svc } = setup({
      matrix: matrixWith({ getRoom: () => fakeRoom({ events }) }),
    });

    const out = svc.searchLoadedMessages('!r:hs', 'hello');

    expect(out.hits.map((h) => h.eventId)).toEqual(['$2', '$1']); // recency, case-insensitive
    expect(out.scanned).toBe(3);
    expect(out.hits[0].snippet).toContain('HELLO');
    expect(out.hits[0].senderName).toBe('@alice:hs');
  });

  it('skips edit relations and decryption failures, and counts only real scans', () => {
    const events = [
      messageEvent({ id: '$1', body: 'keyword one' }),
      messageEvent({ id: '$2', body: '* keyword edited', replace: true }),
      messageEvent({
        id: '$3',
        body: 'keyword secret',
        decryptionFailure: true,
      }),
      messageEvent({ id: '$4', body: 'unrelated', type: 'm.room.member' }),
    ];
    const { svc } = setup({
      matrix: matrixWith({ getRoom: () => fakeRoom({ events }) }),
    });

    const out = svc.searchLoadedMessages('!r:hs', 'keyword');

    expect(out.hits.map((h) => h.eventId)).toEqual(['$1']);
    expect(out.scanned).toBe(1); // only the one displayable, decrypted message
  });

  it('flags an encrypted room and reports server search as unavailable', () => {
    const { svc } = setup({
      matrix: matrixWith({
        getRoom: () => fakeRoom({ encrypted: true, events: [] }),
      }),
    });

    const out = svc.searchLoadedMessages('!r:hs', 'x');

    expect(out.encrypted).toBe(true);
    expect(out.serverAvailable).toBe(false);
  });

  it('marks an unencrypted room as server-searchable', () => {
    const { svc } = setup({
      matrix: matrixWith({ getRoom: () => fakeRoom({ encrypted: false }) }),
    });

    expect(svc.searchLoadedMessages('!r:hs', 'x').serverAvailable).toBe(true);
  });

  it('returns empty for an empty query (no hits, scanned counted)', () => {
    const events = [messageEvent({ id: '$1', body: 'anything' })];
    const { svc } = setup({
      matrix: matrixWith({ getRoom: () => fakeRoom({ events }) }),
    });

    const out = svc.searchLoadedMessages('!r:hs', '');
    expect(out.hits).toEqual([]);
    expect(out.scanned).toBe(1);
  });
});

describe('SearchService.searchServerMessages', () => {
  function searchResponse() {
    return {
      search_categories: {
        room_events: {
          count: 5,
          next_batch: 'batch2',
          results: [
            {
              rank: 1,
              result: {
                event_id: '$s1',
                sender: '@bob:hs',
                origin_server_ts: 111,
                content: { body: 'server side hit' },
              },
              context: {
                profile_info: {
                  '@bob:hs': { displayname: 'Bob', avatar_url: 'mxc://a/b' },
                },
              },
            },
          ],
        },
      },
    };
  }

  it('searches the server only for an unencrypted room and maps the response', async () => {
    const search = vi.fn(
      (_params: { body: ISearchRequestBody; next_batch?: string }) =>
        Promise.resolve(searchResponse()),
    );
    const { svc } = setup({
      matrix: matrixWith({
        getRoom: () => fakeRoom({ encrypted: false }),
        search,
      }),
    });

    const page = await firstValueFrom(svc.searchServerMessages('!r:hs', 'hit'));

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].body.search_categories.room_events).toEqual(
      expect.objectContaining({
        search_term: 'hit',
        keys: ['content.body'],
        filter: { rooms: ['!r:hs'] },
        order_by: SearchOrderBy.Recent,
      }),
    );
    expect(page.hits[0]).toEqual({
      eventId: '$s1',
      roomId: '!r:hs',
      sender: '@bob:hs',
      senderName: 'Bob',
      senderAvatarMxc: 'mxc://a/b',
      body: 'server side hit',
      ts: 111,
      snippet: 'server side hit',
    });
    expect(page.count).toBe(5);
    expect(page.nextBatch).toBe('batch2');
  });

  it('never hits the server for an encrypted room', async () => {
    const search = vi.fn(
      (_params: { body: ISearchRequestBody; next_batch?: string }) =>
        Promise.resolve(searchResponse()),
    );
    const { svc } = setup({
      matrix: matrixWith({
        getRoom: () => fakeRoom({ encrypted: true }),
        search,
      }),
    });

    const page = await firstValueFrom(svc.searchServerMessages('!r:hs', 'hit'));

    expect(search).not.toHaveBeenCalled();
    expect(page).toEqual({ hits: [], count: 0, nextBatch: null });
  });

  it('threads next_batch into the paginated request', async () => {
    const search = vi.fn(
      (_params: { body: ISearchRequestBody; next_batch?: string }) =>
        Promise.resolve(searchResponse()),
    );
    const { svc } = setup({
      matrix: matrixWith({
        getRoom: () => fakeRoom({ encrypted: false }),
        search,
      }),
    });

    await firstValueFrom(svc.searchServerMessages('!r:hs', 'hit', 'batch1'));

    expect(search.mock.calls[0][0].next_batch).toBe('batch1');
  });

  it('degrades a failed server search to an empty page', async () => {
    const search = vi.fn(() => Promise.reject(new Error('5xx')));
    const { svc } = setup({
      matrix: matrixWith({
        getRoom: () => fakeRoom({ encrypted: false }),
        search,
      }),
    });

    await expect(
      firstValueFrom(svc.searchServerMessages('!r:hs', 'hit')),
    ).resolves.toEqual({ hits: [], count: 0, nextBatch: null });
  });
});

describe('SearchService.loadMoreHistory', () => {
  it('scrolls back and resolves the new loaded-event count', async () => {
    const events = [messageEvent({ id: '$1' }), messageEvent({ id: '$2' })];
    const room = fakeRoom({ events });
    const scrollback = vi.fn(() => Promise.resolve(room));
    const { svc } = setup({
      matrix: matrixWith({ getRoom: () => room, scrollback }),
    });

    const count = await firstValueFrom(svc.loadMoreHistory('!r:hs', 40));

    expect(scrollback).toHaveBeenCalledWith(room, 40);
    expect(count).toBe(2);
  });
});
