import { describe, expect, it, vi } from 'vitest';
import { TimelineScrollActivity } from './timeline-scroll-activity';

describe('TimelineScrollActivity', () => {
  describe('scroll speed', () => {
    it('has no speed at rest or from a single position', () => {
      const activity = new TimelineScrollActivity();
      expect(activity.speed).toBe(0);

      activity.moved(4_000, 1_000);

      expect(activity.speed).toBe(0);
    });

    it('follows the reader’s movement, smoothed over about 100 ms', () => {
      const activity = new TimelineScrollActivity();
      activity.moved(10_000, 0);

      // 120 px in 20 ms is 6,000 px/s; each 20 ms sample moves the estimate a fifth of the way.
      activity.moved(9_880, 20);
      expect(activity.speed).toBeCloseTo(1_200);
      activity.moved(9_760, 40);
      expect(activity.speed).toBeCloseTo(2_160);

      // A sample 100 ms after the last replaces the estimate outright.
      activity.moved(9_660, 140);
      expect(activity.speed).toBeCloseTo(1_000);
    });

    it('counts movement in either direction', () => {
      const activity = new TimelineScrollActivity();
      activity.moved(0, 0);
      activity.moved(300, 100);

      expect(activity.speed).toBeCloseTo(3_000);
    });

    it('starts afresh after a pause instead of averaging across it', () => {
      const activity = new TimelineScrollActivity();
      activity.moved(0, 0);
      activity.moved(500, 100);
      expect(activity.speed).toBeCloseTo(5_000);

      // 151 ms without a scroll event: the reader paused; this position starts a new estimate.
      activity.moved(520, 251);
      expect(activity.speed).toBe(0);
      activity.moved(560, 351);
      expect(activity.speed).toBeCloseTo(400);
    });

    it('does not count the list’s own scroll writes as movement', () => {
      const activity = new TimelineScrollActivity();
      activity.moved(1_000, 0);

      // History landed above: the list moved the scroll position 3,000 px to keep the
      // reader's row in place. Nothing moved under the reader.
      activity.shifted(3_000);
      activity.moved(4_010, 100);

      expect(activity.speed).toBeCloseTo(100);
    });

    it('takes only the list’s write out of a scroll event that also carries the reader’s movement', () => {
      const activity = new TimelineScrollActivity();
      activity.moved(0, 0);

      // A row above grew by 236 px and the list compensated, while the reader kept scrolling:
      // the browser reports both in one event.
      activity.shifted(236);
      activity.moved(236 + 130, 100);

      expect(activity.speed).toBeCloseTo(1_300);
    });

    it('ignores a write while no estimate is running', () => {
      const activity = new TimelineScrollActivity();
      activity.shifted(500);
      activity.moved(500, 0);
      activity.moved(600, 100);

      expect(activity.speed).toBeCloseTo(1_000);
    });

    it('forgets the estimate for a new room', () => {
      const activity = new TimelineScrollActivity();
      activity.moved(0, 0);
      activity.moved(600, 100);

      activity.reset();

      expect(activity.speed).toBe(0);
      // The new room's first position starts a new estimate.
      activity.moved(9_000, 120);
      expect(activity.speed).toBe(0);
    });

    it('drops to zero once the scroll settles', () => {
      const activity = new TimelineScrollActivity();
      activity.start();
      activity.moved(0, 0);
      activity.moved(600, 100);
      expect(activity.speed).toBeCloseTo(6_000);

      activity.settle();

      expect(activity.speed).toBe(0);
      expect(activity.active).toBe(false);
      // The next movement starts a new estimate.
      activity.moved(620, 120);
      expect(activity.speed).toBe(0);
    });
  });

  describe('watchers', () => {
    it('hears every movement and the settle, until it stops watching', () => {
      const activity = new TimelineScrollActivity();
      const heard = vi.fn(() => activity.speed);
      const stop = activity.watch(heard);

      activity.start();
      activity.moved(0, 0);
      activity.moved(200, 100);
      activity.settle();

      // Each call saw the speed as it stood after that change.
      expect(heard.mock.results.map((result) => result.value)).toEqual([
        0, 2_000, 0,
      ]);

      stop();
      activity.moved(400, 200);
      activity.settle();
      expect(heard).toHaveBeenCalledTimes(3);
    });

    it('does not tell watchers about a write, which moves nothing', () => {
      const activity = new TimelineScrollActivity();
      const heard = vi.fn();
      activity.watch(heard);
      activity.moved(0, 0);
      heard.mockClear();

      activity.shifted(500);

      expect(heard).not.toHaveBeenCalled();
    });
  });
});
