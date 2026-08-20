import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delayedBusy } from './delayed-busy';

describe('delayedBusy', () => {
  let injector: Injector;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    injector = TestBed.inject(Injector);
  });

  afterEach(() => vi.useRealTimers());

  /** Advance both the clock the timers use and the one `Date.now()` reads. */
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
    TestBed.tick();
  };

  /** Create the derived signal and flush the effect's first run. */
  function setup(busy = signal(false), options = {}) {
    const visible = delayedBusy(busy, injector, options);
    TestBed.tick();
    return { busy, visible };
  }

  it('says nothing about work that finishes quickly', () => {
    // The flicker case: a request that returns in 80ms should never put anything on screen.
    //
    // Sampled at every step rather than checked at the end, because the end state is false
    // either way — a version with no delay at all shows the spinner immediately, holds it
    // for its 400ms minimum and then hides it, which an end-state assertion calls a pass.
    // What is being claimed is that it never appeared, so that is what is recorded.
    const { busy, visible } = setup();
    const seen: boolean[] = [];
    const sample = (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 10) {
        advance(10);
        seen.push(visible());
      }
    };

    busy.set(true);
    TestBed.tick();
    sample(80);
    busy.set(false);
    TestBed.tick();
    sample(1000);

    expect(seen).not.toContain(true);
  });

  it('appears once the work outlasts the delay', () => {
    const { busy, visible } = setup();

    busy.set(true);
    TestBed.tick();
    advance(149);
    expect(visible()).toBe(false);

    advance(1);
    expect(visible()).toBe(true);
  });

  it('stays long enough to be read, even when the work ends immediately after', () => {
    // Without a minimum the delay just moves the flicker: 160ms of work would show a
    // spinner for 10ms.
    const { busy, visible } = setup();

    busy.set(true);
    TestBed.tick();
    advance(150);
    expect(visible()).toBe(true);

    busy.set(false);
    TestBed.tick();
    advance(399);
    expect(visible()).toBe(true);

    advance(1);
    expect(visible()).toBe(false);
  });

  it('leaves immediately when it has already served its minimum', () => {
    const { busy, visible } = setup();

    busy.set(true);
    TestBed.tick();
    advance(150 + 400 + 50);
    expect(visible()).toBe(true);

    busy.set(false);
    TestBed.tick();

    expect(visible()).toBe(false);
  });

  it('keeps showing when work restarts before the minimum has elapsed', () => {
    // A second request arriving on the heels of the first is one continuous wait to the
    // person watching, not two.
    const { busy, visible } = setup();

    busy.set(true);
    TestBed.tick();
    advance(150);
    busy.set(false);
    TestBed.tick();
    advance(100);
    busy.set(true);
    TestBed.tick();
    advance(1000);

    expect(visible()).toBe(true);
  });

  it('honours the timings it is given', () => {
    const { busy, visible } = setup(signal(false), {
      delayMs: 10,
      minimumMs: 20,
    });

    busy.set(true);
    TestBed.tick();
    advance(10);
    expect(visible()).toBe(true);

    busy.set(false);
    TestBed.tick();
    advance(19);
    expect(visible()).toBe(true);
    advance(1);
    expect(visible()).toBe(false);
  });

  it('drops a pending appearance when the caller is destroyed', () => {
    // The timer outlives the component otherwise, and fires into a signal nothing reads —
    // harmless here, but it is the shape of a leak and the cleanup is what prevents it.
    const child = Injector.create({ providers: [], parent: injector });
    const busy = signal(false);
    const visible = delayedBusy(busy, child);
    TestBed.tick();

    busy.set(true);
    TestBed.tick();
    (child as unknown as { destroy: () => void }).destroy();
    advance(1000);

    expect(visible()).toBe(false);
  });
});
