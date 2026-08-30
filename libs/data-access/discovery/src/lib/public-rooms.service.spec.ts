import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PublicRoomsService } from './public-rooms.service';

function setup(
  response: {
    chunk?: unknown[];
    next_batch?: string;
    total_room_count_estimate?: number;
  } = {},
) {
  const publicRooms = vi.fn().mockResolvedValue({
    chunk: response.chunk ?? [],
    next_batch: response.next_batch,
    total_room_count_estimate: response.total_room_count_estimate,
  });
  const joinRoom = vi.fn().mockResolvedValue({ roomId: '!joined:hs' });
  const instance = { publicRooms, joinRoom };
  TestBed.configureTestingModule({
    providers: [
      PublicRoomsService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: instance as never,
      }),
    ],
  });
  return { svc: TestBed.inject(PublicRoomsService), publicRooms, joinRoom };
}

const CHUNK_ROOM = {
  room_id: '!r:hs',
  name: 'General',
  topic: 'Chat',
  canonical_alias: '#general:hs',
  avatar_url: 'mxc://hs/a',
  num_joined_members: 42,
};

describe('PublicRoomsService', () => {
  it('search is cold and maps the directory chunk to summaries', async () => {
    const { svc, publicRooms } = setup({
      chunk: [CHUNK_ROOM],
      next_batch: 'tok',
      total_room_count_estimate: 100,
    });

    const action = svc.search();
    expect(publicRooms).not.toHaveBeenCalled(); // cold

    expect(await firstValueFrom(action)).toEqual({
      rooms: [
        {
          roomId: '!r:hs',
          name: 'General',
          topic: 'Chat',
          alias: '#general:hs',
          avatarMxc: 'mxc://hs/a',
          memberCount: 42,
          isSpace: false,
        },
      ],
      nextBatch: 'tok',
      total: 100,
    });
  });

  it('falls back to the alias then the room id for the name, and nulls a missing topic', async () => {
    const { svc } = setup({
      chunk: [
        { room_id: '!a:hs', canonical_alias: '#a:hs', num_joined_members: 1 },
        { room_id: '!b:hs', num_joined_members: 0 },
      ],
    });

    const page = await firstValueFrom(svc.search());
    expect(page.rooms.map((r) => r.name)).toEqual(['#a:hs', '!b:hs']);
    expect(page.rooms[0].topic).toBeNull();
    expect(page.rooms[1].alias).toBeNull();
    expect(page.nextBatch).toBeNull();
  });

  it('passes a search term as a generic filter', async () => {
    const { svc, publicRooms } = setup();

    await firstValueFrom(svc.search({ term: '  chess  ' }));

    expect(publicRooms).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { generic_search_term: 'chess' } }),
    );
  });

  it('omits the filter for an empty term and threads the pagination token', async () => {
    const { svc, publicRooms } = setup();

    await firstValueFrom(svc.search({ term: '   ', since: 'page2' }));

    const opts = publicRooms.mock.calls[0][0];
    expect(opts.filter).toBeUndefined();
    expect(opts.since).toBe('page2');
  });

  it('restricts to Spaces and flags each summary as a space', async () => {
    const { svc, publicRooms } = setup({
      chunk: [{ ...CHUNK_ROOM, room_type: 'm.space' }],
    });

    const page = await firstValueFrom(svc.search({ spaces: true }));

    expect(publicRooms).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { room_types: ['m.space'] } }),
    );
    expect(page.rooms[0].isSpace).toBe(true);
  });

  it('combines a search term with the Spaces filter', async () => {
    const { svc, publicRooms } = setup();

    await firstValueFrom(svc.search({ term: 'dev', spaces: true }));

    expect(publicRooms).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { generic_search_term: 'dev', room_types: ['m.space'] },
      }),
    );
  });

  it('join resolves the joined room id', async () => {
    const { svc, joinRoom } = setup();

    expect(await firstValueFrom(svc.join('#general:hs'))).toBe('!joined:hs');
    expect(joinRoom).toHaveBeenCalledWith('#general:hs');
  });
});
