import { describe, expect, it, vi } from 'vitest';
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
});
