import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDiscoveryEngine } from '../contract/fake-discovery-engine';
import {
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import { DISCOVERY_ENGINE } from './discovery-engine';
import { PublicRoomsService } from './public-rooms.service';

const ROOM = {
  roomId: '!r:hs',
  name: 'General',
  topic: 'Chat',
  alias: '#general:hs',
  avatarMxc: 'mxc://hs/a',
  memberCount: 42,
  isSpace: false,
};

describe('PublicRoomsService', () => {
  let engine: FakeDiscoveryEngine;
  let svc: PublicRoomsService;

  beforeEach(() => {
    engine = new FakeDiscoveryEngine();
    engine.accounts.add('@me:hs');
    engine.rooms.push(ROOM, {
      ...ROOM,
      roomId: '!s:hs',
      name: 'Dev space',
      alias: '#dev:hs',
      isSpace: true,
    });
    TestBed.configureTestingModule({
      providers: [
        PublicRoomsService,
        { provide: DISCOVERY_ENGINE, useValue: engine },
      ],
    });
    svc = TestBed.inject(PublicRoomsService);
  });

  it('search is cold and returns the engine page', async () => {
    const action = svc.search('@me:hs', { term: 'gen' });
    expect(engine.calls).toEqual([]);

    const page = await firstValueFrom(action);

    expect(page.rooms.map((r) => r.roomId)).toEqual(['!r:hs']);
    expect(engine.calls).toEqual(['searchPublicRooms:@me:hs']);
  });

  it('passes the term, token, Spaces flag and page size to the engine', async () => {
    const searchPublicRooms = vi
      .spyOn(engine, 'searchPublicRooms')
      .mockReturnValue(
        of(engineOk({ rooms: [], nextBatch: null, total: null })),
      );

    await firstValueFrom(
      svc.search('@me:hs', { term: 'dev', since: 'p2', spaces: true }),
    );
    await firstValueFrom(svc.search('@me:hs'));

    expect(searchPublicRooms.mock.calls).toEqual([
      ['@me:hs', { term: 'dev', since: 'p2', spaces: true, limit: 30 }],
      ['@me:hs', { limit: 30 }],
    ]);
  });

  it('join resolves the joined room id', async () => {
    expect(await firstValueFrom(svc.join('@me:hs', '#general:hs'))).toBe(
      '!r:hs',
    );
  });

  it('errors a signed-out search and join with "Not signed in."', async () => {
    await expect(firstValueFrom(svc.search('@x:hs'))).rejects.toThrow(
      'Not signed in.',
    );
    await expect(firstValueFrom(svc.join('@x:hs', '#a:hs'))).rejects.toThrow(
      'Not signed in.',
    );
  });

  it('errors a refused join as a permission failure', async () => {
    vi.spyOn(engine, 'joinRoom').mockReturnValue(
      of(
        engineFail({
          kind: 'permission',
          message: 'You do not have permission to do that.',
          diagnostic: { kind: 'permission', httpStatus: 403 },
        }),
      ),
    );

    const error = await firstValueFrom(svc.join('@me:hs', '#general:hs')).catch(
      (e: unknown) => e,
    );

    expect(describeMatrixRequestFailure(error)).toMatchObject({
      kind: 'permission',
      message: 'You do not have permission to do that.',
    });
  });

  it('describes a missing room with the caller fallback and its 404', async () => {
    const error = await firstValueFrom(svc.join('@me:hs', '#missing:hs')).catch(
      (e: unknown) => e,
    );

    expect(
      describeMatrixRequestFailure(error, 'Could not join X. Try again.'),
    ).toEqual({
      kind: 'http',
      message: 'Could not join X. Try again.',
      diagnostic: { kind: 'http', httpStatus: 404 },
    });
  });

  it('describes a directory-search 4xx with the caller fallback', async () => {
    vi.spyOn(engine, 'searchPublicRooms').mockReturnValue(
      of(
        engineFail({
          kind: 'http',
          message: 'Something went wrong. Try again.',
          diagnostic: { kind: 'http', httpStatus: 400 },
        }),
      ),
    );
    const error = await firstValueFrom(svc.search('@me:hs')).catch(
      (e: unknown) => e,
    );

    expect(describeMatrixRequestFailure(error, 'Search failed.')).toMatchObject(
      {
        kind: 'http',
        message: 'Search failed.',
        diagnostic: { httpStatus: 400 },
      },
    );
  });

  it('keeps the signed-out message and still takes the caller fallback', async () => {
    const error = await firstValueFrom(svc.join('@x:hs', '#a:hs')).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toBe('Not signed in.');
    expect(
      describeMatrixRequestFailure(error, 'Could not join X. Try again.')
        .message,
    ).toBe('Could not join X. Try again.');
  });
});
