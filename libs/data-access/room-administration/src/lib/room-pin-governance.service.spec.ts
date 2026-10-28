import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomPinGovernanceService } from './room-pin-governance.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';

afterEach(() => TestBed.resetTestingModule());

describe('RoomPinGovernanceService', () => {
  async function setup(alicePower: number) {
    const session = administrationSession();
    const { engine } = session;
    const roomId = await roomWithAlice(engine);
    await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
    TestBed.configureTestingModule({ providers: session.providers });
    return {
      engine,
      service: TestBed.inject(RoomPinGovernanceService),
      key: { accountId: engine.alice, roomId },
    };
  }

  it('decides from the exact room state for the exact Account', async () => {
    const { service, key, engine } = await setup(50);

    expect(service.canMutate(key)).toBe(true);
    expect(service.authorize(key)).toEqual({ kind: 'allowed' });
    expect(service.canMutate({ ...key, accountId: engine.bob })).toBe(false);
    expect(service.authorize({ ...key, accountId: engine.bob })).toEqual({
      kind: 'rejected',
      failure: 'conversation-unavailable',
    });
  });

  it('rejects pin mutations when room power levels deny the state event', async () => {
    const { service, key } = await setup(49);

    expect(service.canMutate(key)).toBe(false);
    expect(service.authorize(key)).toEqual({
      kind: 'rejected',
      failure: 'not-allowed',
    });
  });
});
