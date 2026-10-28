import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { PinnedEvents } from '../lib/conversation-content-engine';
import { defineConversationContentEngineContract } from './conversation-content-engine.contract';
import { FakeConversationContentEngine } from './fake-conversation-content-engine';

defineConversationContentEngineContract(
  async () => {
    const engine = new FakeConversationContentEngine();
    return {
      engine,
      alice: engine.alice,
      bob: engine.bob,
      previewableUrl: engine.previewableUrl,
      asAlice: engine.asAlice,
      asBob: engine.asBob,
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);

describe('FakeConversationContentEngine', () => {
  async function joinedRoom(engine: FakeConversationContentEngine) {
    const roomId = await engine.asBob.createRoom('r');
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);
    return roomId;
  }

  it('pinnedEvents drops non-string entries and shows a missing event as unavailable', async () => {
    const engine = new FakeConversationContentEngine();
    const roomId = await joinedRoom(engine);
    const states: PinnedEvents[] = [];
    const sub = engine
      .pinnedEvents(engine.alice, roomId)
      .subscribe((s) => states.push(s));

    engine.setPinned(roomId, [42, '$gone']);
    sub.unsubscribe();

    expect(states.at(-1)).toEqual({
      eventIds: ['$gone'],
      entries: [
        expect.objectContaining({ eventId: '$gone', status: 'unavailable' }),
      ],
    });
  });

  it('unpin keeps non-string entries', async () => {
    const engine = new FakeConversationContentEngine();
    const roomId = await joinedRoom(engine);
    engine.setPinned(roomId, [42, '$a']);

    await firstValueFrom(engine.unpin(engine.alice, roomId, '$a'));

    const state = await firstValueFrom(
      engine.pinnedEvents(engine.alice, roomId),
    );
    expect(state.eventIds).toEqual([]);
  });

  it('failNext fails only the next command', async () => {
    const engine = new FakeConversationContentEngine();
    engine.failNext('request-failed');

    const failed = await firstValueFrom(
      engine.linkPreview(engine.alice, engine.previewableUrl, {
        onlyIfUnencrypted: null,
      }),
    );
    const passed = await firstValueFrom(
      engine.linkPreview(engine.alice, engine.previewableUrl, {
        onlyIfUnencrypted: null,
      }),
    );

    expect(!failed.ok && failed.failure.code).toBe('request-failed');
    expect(passed).toEqual({
      ok: true,
      value: { title: 'Example', description: null, imageMxc: null },
    });
  });

  it('an onlyIfUnencrypted refusal makes no request', async () => {
    const engine = new FakeConversationContentEngine();
    const roomId = await engine.asBob.createRoom('r', { encrypted: true });
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);

    await firstValueFrom(
      engine.linkPreview(engine.alice, engine.previewableUrl, {
        onlyIfUnencrypted: roomId,
      }),
    );

    expect(engine.previewRequests).toBe(0);
  });
});
