import { Subject, delayWhen, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineFail } from '@trinity/util/matrix';
import { FakeNotificationEngine } from '../contract/fake-notification-engine';
import type { ReactionAnnotation } from './notification-engine';
import { ReactionNotificationBatch } from './reaction-notification-batch';

const BODY = 'Please review the release notes';

function setup({ encrypted = false } = {}) {
  const engine = new FakeNotificationEngine();
  const me = engine.alice;
  const room = engine.createRoom('General', { encrypted });
  const target = engine.send(me, room, BODY);
  /** While set, lookups wait for it to emit. */
  let gate: Subject<void> | null = null;
  const lookup = vi.fn(
    (roomId: string, targetId: string, ids: readonly string[]) => {
      const answer = engine.reactionTarget(me, roomId, targetId, ids);
      const held = gate;
      return held ? answer.pipe(delayWhen(() => held)) : answer;
    },
  );
  const allowed = vi.fn(() => true);
  const present = vi.fn();
  const batch = new ReactionNotificationBatch({
    accountId: me,
    allowed,
    lookup,
    present,
  });
  const annotations: ReactionAnnotation[] = [];
  const feed = engine.notifications(me).subscribe((item) => {
    if (item.kind !== 'reaction-annotation') return;
    annotations.push(item);
    batch.add(item);
  });
  return {
    engine,
    me,
    room,
    target,
    batch,
    lookup,
    allowed,
    present,
    annotations,
    feed,
    react: (sender = '@alice:hs', key = '👍', on = target) =>
      engine.react(sender, room, on, key),
    hold: () => (gate = new Subject<void>()),
    release: () => {
      const held = gate;
      gate = null;
      held?.next();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ReactionNotificationBatch', () => {
  it('groups five people into one notification for the original message', async () => {
    const { react, present, me, room, target } = setup();
    for (let i = 0; i < 5; i++) {
      react(i ? `@user${i}:hs` : '@alice:hs');
    }
    await vi.advanceTimersByTimeAsync(1999);
    expect(present).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(present).toHaveBeenCalledExactlyOnceWith({
      kind: 'reaction',
      accountId: me,
      roomId: room,
      eventId: target,
      senderId: '@alice:hs',
      senderName: 'alice',
      senderCount: 5,
      reactionKeys: ['👍'],
      roomName: 'General',
      body: BODY,
    });
  });

  it('counts people once across multiple emojis and deduplicates reaction events', async () => {
    const { react, present, batch, annotations } = setup();
    react();
    batch.add(annotations[0]);
    react('@alice:hs', '✅');
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        senderCount: 1,
        reactionKeys: ['👍', '✅'],
      }),
    );
    batch.add(annotations[0]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('waits for a quiet period but flushes a continuous burst within ten seconds', async () => {
    const { react, present } = setup();
    for (let i = 0; i < 10; i++) {
      react();
      await vi.advanceTimersByTimeAsync(1000);
      if (i < 9) expect(present).not.toHaveBeenCalled();
    }
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('keeps different message targets separate', async () => {
    const { engine, me, room, target, react, present } = setup();
    const second = engine.send(me, room, 'second');
    react();
    react('@bob:hs', '👍', second);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present.mock.calls.map(([event]) => event.eventId)).toEqual([
      target,
      second,
    ]);
  });

  it('never notifies for a reaction to someone else’s message', async () => {
    const { engine, room, react, present } = setup();
    const theirs = engine.send('@bob:hs', room, 'theirs');
    react('@alice:hs', '👍', theirs);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).not.toHaveBeenCalled();
  });

  it('rechecks redactions at delivery time, asking once per batch', async () => {
    const { engine, room, target, react, present, lookup } = setup();
    const removed = react();
    react('@bob:hs');
    engine.redact(room, removed);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lookup).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ senderId: '@bob:hs', senderCount: 1 }),
    );
    react();
    engine.redact(room, target);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('includes reactions arriving during the lookup', async () => {
    const { react, present, lookup, hold, release } = setup();
    hold();
    react();
    await vi.advanceTimersByTimeAsync(2000);
    react('@bob:hs');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ senderCount: 2 }),
    );
  });

  it('presents the preview the engine allows', async () => {
    const { react, present } = setup({ encrypted: true });
    react();
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ body: null }),
    );
  });

  it('suppresses failed and erroring lookups', async () => {
    const { react, present, lookup } = setup();
    lookup.mockReturnValueOnce(
      of(
        engineFail({
          kind: 'http',
          code: 'request-failed',
          diagnostic: { kind: 'http', httpStatus: 404 },
        }),
      ),
    );
    react();
    await vi.advanceTimersByTimeAsync(2000);
    lookup.mockImplementationOnce(() => {
      throw new Error('Missing key');
    });
    react('@bob:hs');
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).not.toHaveBeenCalled();
  });

  it('drops batches if the preference, mute or session changes', async () => {
    const { react, present, allowed } = setup();
    react();
    allowed.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).not.toHaveBeenCalled();
  });

  it('cancels timers and ignores a looked-up target after disposal', async () => {
    const { react, present, lookup, hold, release, batch } = setup();
    hold();
    react();
    await vi.advanceTimersByTimeAsync(2000);
    batch.dispose();
    release();
    react('@bob:hs');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(present).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('releases a timed-out lookup and ignores its late result', async () => {
    const { react, present, hold, release } = setup();
    hold();
    react();
    await vi.advanceTimersByTimeAsync(12_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(present).not.toHaveBeenCalled();

    react('@bob:hs');
    await vi.advanceTimersByTimeAsync(2000);
    expect(present).toHaveBeenCalledTimes(1);
  });
});
