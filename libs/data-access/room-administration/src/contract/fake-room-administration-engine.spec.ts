import { describe, expect, it } from 'vitest';
import type { AdministeredRoom } from '../lib/room-administration-engine';
import { defineRoomAdministrationEngineContract } from './room-administration-engine.contract';
import { FakeRoomAdministrationEngine } from './fake-room-administration-engine';

defineRoomAdministrationEngineContract(
  async () => {
    const engine = new FakeRoomAdministrationEngine();
    return {
      engine,
      alice: engine.alice,
      bob: engine.bob,
      carol: engine.carol,
      asAlice: engine.asAlice,
      asBob: engine.asBob,
      asCarol: engine.asCarol,
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);

describe('FakeRoomAdministrationEngine', () => {
  it('setLive ends and restores the account', async () => {
    const engine = new FakeRoomAdministrationEngine();
    const roomId = await engine.asBob.createRoom();
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);
    const seen: (AdministeredRoom | null)[] = [];
    const subscription = engine
      .room(engine.alice, roomId)
      .subscribe((room) => seen.push(room));

    engine.setLive(engine.alice, false);
    engine.setLive(engine.alice, true);
    subscription.unsubscribe();

    expect(seen.map((room) => room?.ownMembership ?? null)).toEqual([
      'join',
      null,
      'join',
    ]);
  });

  it('gives no power in a v12 room until it has power levels, as js-sdk does', async () => {
    const engine = new FakeRoomAdministrationEngine();
    const roomId = await engine.asBob.createRoom({
      roomVersion: '12',
      additionalCreators: [engine.alice],
      withoutPowerLevels: true,
    });
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);
    let room: AdministeredRoom | null = null;
    engine
      .room(engine.alice, roomId)
      .subscribe((value) => (room = value))
      .unsubscribe();

    expect(room).toMatchObject({ powerLevels: null, ownPower: 0 });
  });
});
