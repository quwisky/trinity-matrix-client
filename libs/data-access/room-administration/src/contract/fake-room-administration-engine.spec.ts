import { describe, expect, it } from 'vitest';
import type {
  AdministeredRoom,
  RoomMembers,
} from '../lib/room-administration-engine';
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

  it('reports encryption unknown until the test answers', async () => {
    const engine = new FakeRoomAdministrationEngine();
    const roomId = await engine.asBob.createRoom({ encryptionUnknown: true });
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);
    const seen: (string | undefined)[] = [];
    const subscription = engine
      .room(engine.alice, roomId)
      .subscribe((room) => seen.push(room?.encryption));

    engine.answerEncryption(roomId, false);
    subscription.unsubscribe();

    expect(seen).toEqual(['unknown', 'unencrypted']);
  });

  it.each([
    { roomVersion: 'org.example.custom', creators: 2, power: 'infinite' },
    { roomVersion: '11', creators: 1, power: 0 },
  ])(
    'lists additional creators exactly when they have creator power (version $roomVersion)',
    async ({ roomVersion, creators, power }) => {
      const engine = new FakeRoomAdministrationEngine();
      const roomId = await engine.asBob.createRoom({
        roomVersion,
        additionalCreators: [engine.alice],
      });
      await engine.asBob.invite(roomId, engine.alice);
      await engine.asAlice.join(roomId);
      let room: AdministeredRoom | null = null;
      engine
        .room(engine.alice, roomId)
        .subscribe((value) => (room = value))
        .unsubscribe();

      expect(room).toMatchObject({ ownPower: power });
      expect((room as AdministeredRoom | null)?.creators).toHaveLength(
        creators,
      );
    },
  );

  it('lets bob change thresholds and carol knock', async () => {
    const engine = new FakeRoomAdministrationEngine();
    const roomId = await engine.asBob.createRoom();
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);
    await engine.asBob.setPowerLevels(roomId, { kick: 75 });
    await engine.asCarol.knock(roomId);
    let room: AdministeredRoom | null = null;
    let members: RoomMembers | null = null;
    engine
      .room(engine.alice, roomId)
      .subscribe((value) => (room = value))
      .unsubscribe();
    engine
      .members(engine.alice, roomId)
      .subscribe((value) => (members = value))
      .unsubscribe();

    expect((room as AdministeredRoom | null)?.powerLevels).toMatchObject({
      kick: 75,
      ban: 50,
    });
    expect(
      (members as RoomMembers | null)?.members.find(
        ({ userId }) => userId === engine.carol,
      )?.membership,
    ).toBe('knock');
  });
});
