import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { applyVectorDiffs } from '@trinity/util/matrix';
import { FakeRoomListEngine, fakeRoom } from './fake-room-list-engine';
import { defineRoomListEngineContract } from './room-list-engine.contract';

defineRoomListEngineContract(
  async () => {
    const engine = new FakeRoomListEngine();
    return {
      engine,
      alice: engine.alice,
      bob: engine.bob,
      serverName: engine.serverName,
      serverBlocksInvites: engine.serverBlocksInvites,
      asAlice: {
        publishAlias: async (r, l) => engine.publishAlias(r, l),
        join: async (r) => engine.acceptInvite(r),
        spaceParents: async (r) => engine.spaceParents(r),
      },
      asBob: engine.asBob,
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);

describe('FakeRoomListEngine', () => {
  it('seed replaces the rooms with a reset', async () => {
    const engine = new FakeRoomListEngine();
    const batches: unknown[] = [];
    const sub = engine.rooms(engine.alice).subscribe((b) => batches.push(b));

    engine.seed(engine.alice, [fakeRoom('!a:example.org')]);
    sub.unsubscribe();

    expect(batches).toEqual([
      [{ op: 'reset', values: [] }],
      [{ op: 'reset', values: [fakeRoom('!a:example.org')] }],
    ]);
  });

  it('failNext fails only the next command', async () => {
    const engine = new FakeRoomListEngine();
    engine.seed(engine.alice, [fakeRoom('!a:example.org')]);
    engine.failNext('invite-blocked');

    const failed = await firstValueFrom(
      engine.setTag(engine.alice, '!a:example.org', 'favourite', true),
    );
    const passed = await firstValueFrom(
      engine.setTag(engine.alice, '!a:example.org', 'favourite', true),
    );

    expect(!failed.ok && failed.failure.code).toBe('invite-blocked');
    expect(passed.ok).toBe(true);
  });

  it('inviteBlocking reports no support where the server lacks MSC4380', async () => {
    const engine = new FakeRoomListEngine();
    engine.serverBlocksInvites = false;

    const written = await firstValueFrom(
      engine.setInviteBlocking(engine.alice, true),
    );

    expect(!written.ok && written.failure.code).toBe('request-failed');
    await expect(
      firstValueFrom(engine.inviteBlocking(engine.alice)),
    ).resolves.toEqual({ supported: false, blocked: false });
  });

  it('setTyping replaces the members typing in a room', async () => {
    const engine = new FakeRoomListEngine();
    const member = { userId: engine.bob, displayName: 'Bob' };

    engine.setTyping(engine.alice, '!a:example.org', [member]);

    await expect(firstValueFrom(engine.typing(engine.alice))).resolves.toEqual({
      '!a:example.org': [member],
    });
  });

  it('gives created rooms deterministic ids', async () => {
    const engine = new FakeRoomListEngine();
    const request = {
      name: 'x',
      topic: null,
      isPublic: false,
      kind: 'room' as const,
      parentSpaceId: null,
    };

    await firstValueFrom(engine.createRoom(engine.alice, request));
    await firstValueFrom(engine.createRoom(engine.alice, request));

    const batch = await firstValueFrom(engine.rooms(engine.alice));
    expect(applyVectorDiffs([], batch).map((r) => r.roomId)).toEqual([
      '!fake-1:example.org',
      '!fake-2:example.org',
    ]);
  });

  it('re-emits space child links once the space is listed for the account', () => {
    const engine = new FakeRoomListEngine();
    const space = fakeRoom('!s:example.org', { isSpace: true });
    engine.seed(engine.bob, [space]);
    const link = { via: ['example.org'], suggested: false, order: '' };
    engine
      .setSpaceChild(engine.bob, space.roomId, '!c:example.org', link)
      .subscribe();
    const seen: unknown[] = [];
    const sub = engine
      .spaceChildLinks(engine.alice, space.roomId)
      .subscribe((links) => seen.push(links));

    engine.seed(engine.alice, [space]);
    sub.unsubscribe();

    expect(seen).toEqual([[], [{ childId: '!c:example.org', ...link }]]);
  });
});
