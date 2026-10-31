import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { RoomWidgetSnapshot } from '../lib/room-widget-engine';
import { FakeRoomWidgetEngine } from './fake-room-widget-engine';
import { defineRoomWidgetEngineContract } from './room-widget-engine.contract';

defineRoomWidgetEngineContract(
  async () => {
    const engine = new FakeRoomWidgetEngine();
    return {
      engine,
      alice: engine.alice,
      aliceDeviceId: 'FAKEDEVICE',
      homeserverUrl: `https://${engine.serverName}`,
      bob: engine.bob,
      asAlice: engine.asAlice,
      asBob: engine.asBob,
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);

describe('FakeRoomWidgetEngine', () => {
  it('failNext fails only the next command', async () => {
    const engine = new FakeRoomWidgetEngine();
    const roomId = await engine.joinedRoom({ canManage: true });
    const content = {
      id: 'w',
      name: 'W',
      type: 'm.custom',
      url: 'https://widgets.example',
      creatorUserId: engine.alice,
      data: {},
      waitForIframeLoad: true,
    };
    engine.failNext('request-failed');

    const failed = await firstValueFrom(
      engine.putRoomWidget(engine.alice, roomId, content),
    );
    const passed = await firstValueFrom(
      engine.putRoomWidget(engine.alice, roomId, content),
    );

    expect(!failed.ok && failed.failure.code).toBe('request-failed');
    expect(passed.ok).toBe(true);
  });

  it('setLive ends and restores the account', async () => {
    const engine = new FakeRoomWidgetEngine();
    const roomId = await engine.joinedRoom({ canManage: true });
    const seen: RoomWidgetSnapshot[] = [];
    const sub = engine
      .roomWidgets(engine.alice, roomId)
      .subscribe((s) => seen.push(s));

    engine.setLive(engine.alice, false);
    engine.setLive(engine.alice, true);
    sub.unsubscribe();

    expect(seen.map((s) => s.identity?.userId ?? null)).toEqual([
      engine.alice,
      null,
      engine.alice,
    ]);
  });
});
