import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomLibraryService } from './room-library.service';
import { ROOM_LIBRARY_GOVERNANCE_POLICY } from './room-library-governance-policy';
import { SpaceChildrenService } from './space-children.service';
import { SpaceContentsService } from './space-contents.service';
import { SpacesService } from './spaces.service';

const TARGET = { accountId: '@opening:hs', spaceId: '!parent:hs' } as const;

function room(id: string, name: string, isSpace = false) {
  return {
    roomId: id,
    name,
    isSpaceRoom: () => isSpace,
    getMyMembership: () => 'join',
    getMxcAvatarUrl: () => null,
  };
}

function setup(options: { allowed?: boolean; hierarchyError?: Error } = {}) {
  const accountIds = signal<readonly string[]>([TARGET.accountId]);
  const parent = room(TARGET.spaceId, 'Design', true);
  const candidate = room('!candidate:hs', 'Candidate');
  const nested = room('!nested:hs', 'Nested', true);
  const handlers = new Map<string, (...args: never[]) => void>();
  const getRoomHierarchy = options.hierarchyError
    ? vi.fn().mockRejectedValue(options.hierarchyError)
    : vi.fn().mockResolvedValue({
        rooms: [
          {
            room_id: TARGET.spaceId,
            children_state: [
              {
                state_key: '!child:remote',
                content: { via: ['remote'], order: 'a' },
              },
              {
                state_key: '!nested:hs',
                content: { via: ['hs'], order: 'b' },
              },
            ],
          },
          {
            room_id: '!child:remote',
            name: 'Public child',
            room_type: undefined,
            num_joined_members: 4,
          },
          {
            room_id: '!nested:hs',
            name: 'Nested',
            room_type: 'm.space',
            num_joined_members: 2,
          },
        ],
      });
  const client = {
    getRoom: (id: string) =>
      id === TARGET.spaceId
        ? parent
        : id === nested.roomId
          ? nested
          : id === candidate.roomId
            ? candidate
            : null,
    getRooms: () => [parent, candidate, nested],
    getAccountData: () => null,
    getRoomHierarchy,
    on: vi.fn((event: string, handler: (...args: never[]) => void) =>
      handlers.set(event, handler),
    ),
    off: vi.fn(),
  };
  const authorize = vi.fn(() =>
    options.allowed === false
      ? ({ kind: 'rejected', reason: 'You need permission.' } as const)
      : ({ kind: 'allowed' } as const),
  );
  const createRoomFor = vi.fn(() => of('!created-room:hs'));
  const createSpace = vi.fn(() => of('!created-space:hs'));
  const addExistingRoom = vi.fn(() => of(undefined));
  const removeExistingRoom = vi.fn(() => of(undefined));
  const links = new BehaviorSubject<readonly { childId: string }[]>([
    { childId: '!nested:hs' },
  ]);
  TestBed.configureTestingModule({
    providers: [
      SpaceContentsService,
      MockProvider(MatrixClientService, {
        accountIds: accountIds.asReadonly(),
        clientFor: (accountId: string) =>
          accountId === TARGET.accountId ? (client as never) : null,
      }),
      MockProvider(RoomLibraryService, { createRoomFor }),
      MockProvider(SpacesService, { createSpace }),
      MockProvider(SpaceChildrenService, {
        childLinksFor: () => links.value as never,
        addExistingRoom,
        removeExistingRoom,
      }),
      { provide: ROOM_LIBRARY_GOVERNANCE_POLICY, useValue: { authorize } },
    ],
  });
  return {
    service: TestBed.inject(SpaceContentsService),
    accountIds,
    client,
    handlers,
    authorize,
    createRoomFor,
    createSpace,
    addExistingRoom,
    removeExistingRoom,
  };
}

describe('SpaceContentsService', () => {
  it('projects Room and Space children from the opening Account hierarchy', async () => {
    const { service, client } = setup();

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(client.getRoomHierarchy).toHaveBeenCalledWith(
      TARGET.spaceId,
      100,
      1,
      false,
      undefined,
    );
    expect(snapshot.items).toMatchObject([
      {
        id: '!child:remote',
        name: 'Public child',
        kind: 'room',
        joined: false,
      },
      { id: '!nested:hs', name: 'Nested', kind: 'space', joined: true },
    ]);
    expect(snapshot.candidates.map(({ id }) => id)).toEqual(['!candidate:hs']);
  });

  it('reads every hierarchy page instead of publishing a truncated list', async () => {
    const { service, client } = setup();
    client.getRoomHierarchy
      .mockResolvedValueOnce({
        rooms: [
          {
            room_id: TARGET.spaceId,
            children_state: [
              {
                state_key: '!child:remote',
                content: { via: ['remote'], order: 'a' },
              },
            ],
          },
        ],
        next_batch: 'page-2',
      })
      .mockResolvedValueOnce({
        rooms: [
          {
            room_id: '!child:remote',
            name: 'Public child',
            num_joined_members: 4,
          },
        ],
      });

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(client.getRoomHierarchy).toHaveBeenNthCalledWith(
      2,
      TARGET.spaceId,
      100,
      1,
      false,
      'page-2',
    );
    expect(snapshot.items.map(({ id }) => id)).toEqual(['!child:remote']);
  });

  it('keeps readable hierarchy while hiding management after permission loss', async () => {
    const { service } = setup({ allowed: false });

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.canManage).toBe(false);
    expect(snapshot.managementUnavailableReason).toBe('You need permission.');
  });

  it('reports hierarchy failure without inventing an empty authoritative list', async () => {
    const { service } = setup({
      hierarchyError: new Error('server unavailable'),
    });

    const snapshot = await firstValueFrom(service.observe(TARGET));

    expect(snapshot.availability).toBe('available');
    expect(snapshot.hierarchyError).toBe('server unavailable');
    expect(snapshot.items).toEqual([]);
  });

  it('creates and links on the exact Account with parent-only policy', async () => {
    const { service, createRoomFor, addExistingRoom } = setup();

    const result = await firstValueFrom(
      service.create(TARGET, 'room', '  New room  '),
    );

    expect(createRoomFor).toHaveBeenCalledWith(TARGET.accountId, {
      name: 'New room',
    });
    expect(addExistingRoom).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
      '!created-room:hs',
    );
    expect(result).toEqual({
      kind: 'linked',
      item: { id: '!created-room:hs', name: 'New room', kind: 'room' },
    });
  });

  it('preserves a created item when linking fails so retry does not create again', async () => {
    const { service, createSpace, addExistingRoom } = setup();
    addExistingRoom.mockReturnValueOnce(
      throwError(() => new Error('link rejected')),
    );

    const result = await firstValueFrom(
      service.create(TARGET, 'space', 'Nested'),
    );
    if (result.kind !== 'created-unlinked')
      throw new Error('expected recovery');
    await firstValueFrom(service.link(TARGET, result.item.id));

    expect(result.reason).toBe('link rejected');
    expect(result.item.id).toBe('!created-space:hs');
    expect(createSpace).toHaveBeenCalledTimes(1);
    expect(addExistingRoom).toHaveBeenCalledTimes(2);
  });

  it('unlinks through the exact parent without any membership command', async () => {
    const { service, removeExistingRoom } = setup();

    await firstValueFrom(service.unlink(TARGET, '!child:remote'));

    expect(removeExistingRoom).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.spaceId,
      '!child:remote',
    );
  });
});
