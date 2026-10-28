import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomMessageGovernanceService } from './room-message-governance.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';

async function setup(alicePower = 50) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine);
  await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
  TestBed.configureTestingModule({ providers: session.providers });
  return {
    engine,
    governance: TestBed.inject(RoomMessageGovernanceService),
    key: { accountId: engine.alice, roomId },
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('RoomMessageGovernanceService', () => {
  it('resolves moderator affordances for the exact Account', async () => {
    const { governance, key, engine } = await setup();

    expect(governance.canRedactOthers(key)).toBe(true);
    expect(governance.canRedactOthers({ ...key, accountId: engine.bob })).toBe(
      false,
    );
  });

  it('follows power-level changes', async () => {
    const { governance, key, engine } = await setup();
    const canRedact = computed(() => governance.canRedactOthers(key));
    expect(canRedact()).toBe(true);

    await engine.asBob.setPowerLevels(key.roomId, { redact: 75 });

    expect(canRedact()).toBe(false);
  });

  it('lets a member redact their own messages and, with the redact level, others’', async () => {
    const { governance, key, engine } = await setup(0);
    const redact = (senderId: string) =>
      governance.authorizeRedaction({ ...key, senderId });

    expect(redact(engine.alice)).toEqual({ kind: 'allowed' });
    expect(redact(engine.bob)).toEqual({
      kind: 'rejected',
      failure: 'not-allowed',
    });
    await engine.asBob.setPowerLevel(key.roomId, engine.alice, 50);
    expect(redact(engine.bob)).toEqual({ kind: 'allowed' });
  });

  it('rejects a room the account does not know as unavailable', async () => {
    const { governance, key, engine } = await setup();

    expect(
      governance.authorizeRedaction({
        ...key,
        roomId: '!unknown:example.org',
        senderId: engine.alice,
      }),
    ).toEqual({ kind: 'rejected', failure: 'conversation-unavailable' });
  });

  describe('canSendMessages', () => {
    it('follows events_default', async () => {
      const { governance, key, engine } = await setup(0);
      await engine.asBob.setPowerLevels(key.roomId, { events_default: 50 });

      expect(governance.canSendMessages(key)).toBe(false);
    });

    it('is true when events_default is 0', async () => {
      const { governance, key } = await setup(0);

      expect(governance.canSendMessages(key)).toBe(true);
    });

    it('honours an m.room.message override', async () => {
      const { governance, key, engine } = await setup(0);
      await engine.asBob.setPowerLevels(key.roomId, {
        events: { 'm.room.message': 50 },
      });

      expect(governance.canSendMessages(key)).toBe(false);
    });
  });
});
