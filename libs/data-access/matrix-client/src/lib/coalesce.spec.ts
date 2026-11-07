import { afterEach, describe, expect, it, vi } from 'vitest';
import { coalesce } from './coalesce';

/** Drain the microtask queue, which is where a coalesced run lands. */
const flush = () => Promise.resolve();

describe('coalesce', () => {
  it('collapses a burst into one run', async () => {
    const fn = vi.fn();
    const c = coalesce(fn);

    c.schedule();
    c.schedule();
    c.schedule();
    // The point of the primitive: nothing has run yet, the burst is still collapsing.
    expect(fn).not.toHaveBeenCalled();
    await flush();

    expect(fn).toHaveBeenCalledOnce();
  });

  it('runs again for a burst in a later turn', async () => {
    const fn = vi.fn();
    const c = coalesce(fn);

    c.schedule();
    await flush();
    c.schedule();
    await flush();

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('drops a queued run when cancelled', async () => {
    const fn = vi.fn();
    const c = coalesce(fn);

    c.schedule();
    c.cancel();
    // Flushed BEFORE asserting: without this the assertion passes whether or not cancel
    // works, because the run was only ever queued.
    await flush();

    expect(fn).not.toHaveBeenCalled();
  });

  it('queues the next run for an event arriving during the rebuild', async () => {
    const fn = vi.fn();
    // An event landing WHILE the model is being rebuilt must not be swallowed — which is
    // why the flag clears before `fn` runs rather than after.
    const c = coalesce(() => {
      fn();
      if (fn.mock.calls.length === 1) {
        c.schedule();
      }
    });

    c.schedule();
    await flush();
    expect(fn).toHaveBeenCalledOnce();

    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reports whether a run is queued', async () => {
    const c = coalesce(() => undefined);

    expect(c.pending()).toBe(false);
    c.schedule();
    expect(c.pending()).toBe(true);
    await flush();

    expect(c.pending()).toBe(false);
  });

  describe('with a delay', () => {
    afterEach(() => vi.useRealTimers());

    it('collapses calls spread over several tasks into one run at the end of the delay', async () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const c = coalesce(fn, 100);

      c.schedule();
      await vi.advanceTimersByTimeAsync(60);
      c.schedule();
      await vi.advanceTimersByTimeAsync(39);
      expect(fn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledOnce();
      expect(c.pending()).toBe(false);
    });

    it('runs a queued call at once on flush, and only once', async () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const c = coalesce(fn, 100);

      c.flush(); // nothing queued
      expect(fn).not.toHaveBeenCalled();
      c.schedule();
      c.flush();
      expect(fn).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('clears the timer when cancelled', async () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const c = coalesce(fn, 100);

      c.schedule();
      c.cancel();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
