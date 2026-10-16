import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ClientEvent,
  RoomEvent,
  SyncState,
  type MatrixClient,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROOM_READINESS_TIMEOUT_MS,
  RoomReadinessError,
  RoomReadinessService,
} from './room-readiness.service';

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('RoomReadinessService', () => {
  /** A stored Room with the Account's membership in it, as the SDK keeps it. */
  const stored = (membership: string) => ({
    getMyMembership: () => membership,
  });

  function setup(initial: 'none' | 'join' | 'leave' | 'invite' = 'none') {
    let room: object | null = initial === 'none' ? null : stored(initial);
    const on = vi.fn();
    const off = vi.fn();
    const client = {
      getRoom: vi.fn(() => room),
      on,
      off,
    } as unknown as MatrixClient;
    TestBed.configureTestingModule({
      providers: [
        RoomReadinessService,
        {
          provide: MatrixClientService,
          useValue: {
            clientFor: (accountId: string) =>
              accountId === '@owner:hs' ? client : null,
          },
        },
      ],
    });
    return {
      service: TestBed.inject(RoomReadinessService),
      client,
      on,
      off,
      publishRoom: () => {
        room = stored('join');
        const handler = handlerFor(on, ClientEvent.Room);
        handler?.();
        return handler;
      },
      /** The join syncs into a Room the store already held. */
      syncJoin: () => {
        room = stored('join');
        const handler = handlerFor(on, RoomEvent.MyMembership);
        handler?.();
        return handler;
      },
      stopSync: () => {
        const handler = handlerFor(on, ClientEvent.Sync) as
          ((state: SyncState) => void) | undefined;
        handler?.(SyncState.Stopped);
        return handler;
      },
    };
  }

  it('is cold and resolves when the exact Account client publishes the Room', async () => {
    const { service, on, off, publishRoom } = setup();
    const readiness = service.waitForRoom('@owner:hs', '!new:hs');

    expect(on).not.toHaveBeenCalled();
    const result = firstValueFrom(readiness);
    expect(on).toHaveBeenCalledWith(ClientEvent.Room, expect.any(Function));
    expect(on).toHaveBeenCalledWith(ClientEvent.Sync, expect.any(Function));
    const handler = publishRoom();

    await expect(result).resolves.toBeUndefined();
    expect(off).toHaveBeenCalledWith(ClientEvent.Room, handler);
    expect(off).toHaveBeenCalledWith(ClientEvent.Sync, expect.any(Function));
  });

  it('resolves immediately when the Room is already in the SDK graph', async () => {
    const { service, on } = setup('join');

    await expect(
      firstValueFrom(service.waitForRoom('@owner:hs', '!ready:hs')),
    ).resolves.toBeUndefined();
    expect(on).not.toHaveBeenCalled();
  });

  // Re-joining a left Room, or accepting an invitation, keeps the earlier membership in the
  // SDK store until `/sync` brings the join; Workspace only keeps a space that is joined.
  it.each(['leave', 'invite'] as const)(
    'waits for the join to sync when the Room is still stored as %s',
    async (membership) => {
      const { service, on, off, syncJoin } = setup(membership);
      let resolved = false;
      const result = firstValueFrom(
        service.waitForRoom('@owner:hs', '!again:hs'),
      ).then(() => (resolved = true));

      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(on).toHaveBeenCalledWith(
        RoomEvent.MyMembership,
        expect.any(Function),
      );
      const handler = syncJoin();

      await result;
      expect(resolved).toBe(true);
      expect(off).toHaveBeenCalledWith(RoomEvent.MyMembership, handler);
    },
  );

  it('fails closed when the exact Account is not live', async () => {
    const { service } = setup();

    await expect(
      firstValueFrom(service.waitForRoom('@gone:hs', '!new:hs')),
    ).rejects.toMatchObject({
      name: 'RoomReadinessError',
      failure: 'account-unavailable',
    });
  });

  it('fails with typed metadata and tears down when sync stops', async () => {
    const { service, off, stopSync } = setup();
    const result = firstValueFrom(service.waitForRoom('@owner:hs', '!new:hs'));

    const syncHandler = stopSync();

    await expect(result).rejects.toEqual(
      new RoomReadinessError('sync-stopped'),
    );
    expect(off).toHaveBeenCalledWith(ClientEvent.Room, expect.any(Function));
    expect(off).toHaveBeenCalledWith(ClientEvent.Sync, syncHandler);
  });

  it('times out with typed metadata and tears down when the Room never arrives', async () => {
    vi.useFakeTimers();
    const { service, off } = setup();
    const result = expect(
      firstValueFrom(service.waitForRoom('@owner:hs', '!never:hs')),
    ).rejects.toMatchObject({
      name: 'RoomReadinessError',
      failure: 'timed-out',
    });

    await vi.advanceTimersByTimeAsync(ROOM_READINESS_TIMEOUT_MS);

    await result;
    expect(off).toHaveBeenCalledWith(ClientEvent.Room, expect.any(Function));
    expect(off).toHaveBeenCalledWith(ClientEvent.Sync, expect.any(Function));
  });
});

function handlerFor(
  on: ReturnType<typeof vi.fn>,
  event: ClientEvent | RoomEvent,
) {
  return on.mock.calls.find(([boundEvent]) => boundEvent === event)?.[1] as
    ((...args: never[]) => void) | undefined;
}
