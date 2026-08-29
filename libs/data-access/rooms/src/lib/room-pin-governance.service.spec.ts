import { TestBed } from '@angular/core/testing';
import { EventType } from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomPinGovernanceService } from './room-pin-governance.service';

afterEach(() => TestBed.resetTestingModule());

describe('RoomPinGovernanceService', () => {
  function setup(options: { allowed?: boolean; eventLoaded?: boolean } = {}) {
    const maySendStateEvent = vi.fn(() => options.allowed ?? true);
    const room = {
      roomId: '!room:example.org',
      findEventById: vi.fn(() =>
        options.eventLoaded === false ? undefined : { getId: () => '$event' },
      ),
      getLiveTimeline: () => ({
        getState: () => ({ maySendStateEvent }),
      }),
    };
    const aliceClient = {
      getUserId: () => '@alice:example.org',
      getRoom: (roomId: string) => (roomId === room.roomId ? room : null),
    };
    const clientFor = vi.fn((accountId: string) =>
      accountId === '@alice:example.org' ? aliceClient : null,
    );
    TestBed.configureTestingModule({
      providers: [
        RoomPinGovernanceService,
        { provide: MatrixClientService, useValue: { clientFor } },
      ],
    });
    return {
      service: TestBed.inject(RoomPinGovernanceService),
      room,
      maySendStateEvent,
      clientFor,
    };
  }

  const key = {
    accountId: '@alice:example.org',
    roomId: '!room:example.org',
  } as const;

  it('delegates the permission decision to exact-room state for the exact Account', () => {
    const { service, maySendStateEvent, clientFor } = setup();

    expect(service.canMutate(key)).toBe(true);
    expect(clientFor).toHaveBeenCalledWith('@alice:example.org');
    expect(maySendStateEvent).toHaveBeenCalledWith(
      EventType.RoomPinnedEvents,
      '@alice:example.org',
    );
    expect(service.canMutate({ ...key, accountId: '@bob:example.org' })).toBe(
      false,
    );
  });

  it('rejects pinning an unavailable message and still permits stale-id removal', () => {
    const { service } = setup({ eventLoaded: false });

    expect(service.authorize(key, 'pin', '$missing')).toEqual({
      kind: 'rejected',
      failure: 'message-unavailable',
    });
    expect(service.authorize(key, 'unpin', '$missing')).toEqual({
      kind: 'allowed',
    });
  });

  it('rejects both mutations when room power levels deny the state event', () => {
    const { service } = setup({ allowed: false });

    expect(service.authorize(key, 'pin', '$event')).toEqual({
      kind: 'rejected',
      failure: 'not-allowed',
    });
    expect(service.authorize(key, 'unpin', '$event')).toEqual({
      kind: 'rejected',
      failure: 'not-allowed',
    });
  });
});
