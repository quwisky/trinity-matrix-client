import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { TimelineUpdate } from '../lib/timeline-engine';
import { FakeTimelineEngine, fakeEventItem } from './fake-timeline-engine';
import { defineTimelineEngineContract } from './timeline-engine.contract';

defineTimelineEngineContract(
  async () => {
    const engine = new FakeTimelineEngine();
    return {
      engine,
      alice: engine.alice,
      bob: engine.bob,
      serverName: engine.serverName,
      asAlice: engine.asAlice,
      asBob: engine.asBob,
      dispose: async () => undefined,
    };
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);

const LIVE = { kind: 'live' } as const;

describe('FakeTimelineEngine', () => {
  it('seed replaces the room with a reset', () => {
    const engine = new FakeTimelineEngine();
    const item = fakeEventItem('$a', engine.bob);
    const updates: TimelineUpdate[] = [];
    const sub = engine
      .timeline(engine.alice, '!r:example.org', LIVE)
      .subscribe((u) => updates.push(u));

    engine.seed(engine.alice, '!r:example.org', [item], {
      encryption: 'encrypted',
    });
    sub.unsubscribe();

    expect(updates).toEqual([
      { kind: 'room-unavailable' },
      {
        kind: 'items',
        diffs: [{ op: 'reset', values: [item] }],
        backPagination: 'idle',
        room: {
          encryption: 'encrypted',
          tombstone: null,
          latestConfirmedEventId: '$a',
          oldestEventId: '$a',
        },
      },
    ]);
  });

  it('emit passes an update through to open subscriptions', () => {
    const engine = new FakeTimelineEngine();
    const updates: TimelineUpdate[] = [];
    const sub = engine
      .timeline(engine.alice, '!r:example.org', LIVE)
      .subscribe((u) => updates.push(u));

    engine.emit(engine.alice, '!r:example.org', { kind: 'room-unavailable' });
    sub.unsubscribe();

    expect(updates).toHaveLength(2);
  });

  it('failNext fails only the next command', async () => {
    const engine = new FakeTimelineEngine();
    engine.seed(engine.alice, '!r:example.org', []);
    engine.failNext('request-failed');

    const failed = await firstValueFrom(
      engine.setTyping(engine.alice, '!r:example.org', true),
    );
    const passed = await firstValueFrom(
      engine.setTyping(engine.alice, '!r:example.org', true),
    );

    expect(!failed.ok && failed.failure.code).toBe('request-failed');
    expect(passed.ok).toBe(true);
  });

  it('a join shows the newest pageSize events', async () => {
    const engine = new FakeTimelineEngine();
    engine.pageSize = 2;
    const roomId = await engine.asBob.createRoom('r');
    for (const body of ['a', 'b', 'c']) await engine.asBob.send(roomId, body);

    await engine.asAlice.join(roomId);

    const first = await firstValueFrom(
      engine.timeline(engine.alice, roomId, LIVE),
    );
    expect(
      first.kind === 'items' &&
        first.diffs[0].op === 'reset' &&
        first.diffs[0].values.map((i) => i.uniqueId),
    ).toEqual(['ev:$fake-2', 'ev:$fake-3']);
    expect(roomId).toBe('!fake-1:example.org');
  });
});
