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

    await engine.asBob.invite(roomId, engine.alice);
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

  it('alice cannot join without an invite', async () => {
    const engine = new FakeTimelineEngine();
    const roomId = await engine.asBob.createRoom('r');

    await expect(engine.asAlice.join(roomId)).rejects.toThrow();
  });

  it('a repeated reaction key counts in its group', async () => {
    const engine = new FakeTimelineEngine();
    const roomId = await engine.asBob.createRoom('r');
    const eventId = await engine.asBob.send(roomId, 'hi');
    await engine.asBob.invite(roomId, engine.alice);
    await engine.asAlice.join(roomId);

    await engine.asBob.react(roomId, eventId, '👍');
    await engine.asBob.react(roomId, eventId, '👍');

    const details = await firstValueFrom(
      engine.reactionDetails(engine.alice, roomId, eventId),
    );
    expect(details.ok && details.value.map((g) => g.key)).toEqual(['👍']);
    const first = await firstValueFrom(
      engine.timeline(engine.alice, roomId, LIVE),
    );
    const item =
      first.kind === 'items' && first.diffs[0].op === 'reset'
        ? first.diffs[0].values[0]
        : null;
    expect(item?.kind === 'event' && item.reactions).toEqual([
      { key: '👍', count: 2, reactedByMe: false, senders: [engine.bob] },
    ]);
  });

  it('emitDiffs emits granular diffs and keeps them in later snapshots', async () => {
    const engine = new FakeTimelineEngine();
    const item = fakeEventItem('$a', engine.bob);
    engine.seed(engine.alice, '!r:example.org', [item]);
    const marker = { kind: 'readMarker', uniqueId: 'read-marker' } as const;
    const updates: TimelineUpdate[] = [];
    const sub = engine
      .timeline(engine.alice, '!r:example.org', LIVE)
      .subscribe((u) => updates.push(u));

    engine.emitDiffs(engine.alice, '!r:example.org', [
      { op: 'insert', index: 0, value: marker },
    ]);
    sub.unsubscribe();

    expect(updates[1]).toMatchObject({
      kind: 'items',
      diffs: [{ op: 'insert', index: 0, value: marker }],
    });
    const later = await firstValueFrom(
      engine.timeline(engine.alice, '!r:example.org', LIVE),
    );
    expect(later).toMatchObject({
      diffs: [{ op: 'reset', values: [marker, item] }],
    });
  });
});
