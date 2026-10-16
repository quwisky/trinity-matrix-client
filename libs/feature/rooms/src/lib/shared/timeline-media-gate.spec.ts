import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineMediaGate } from './timeline-media-gate';
import { TimelineScrollActivity } from './timeline-scroll-activity';
import {
  TestIntersectionObserver,
  stubIntersectionObserver,
} from '../testing/intersection-observer.stub';

describe('TimelineMediaGate', () => {
  let activity: TimelineScrollActivity;
  let gate: TimelineMediaGate;
  let scroller: HTMLElement;

  beforeEach(() => {
    stubIntersectionObserver();
    TestBed.configureTestingModule({
      providers: [TimelineScrollActivity, TimelineMediaGate],
    });
    activity = TestBed.inject(TimelineScrollActivity);
    gate = TestBed.inject(TimelineMediaGate);
    scroller = document.createElement('div');
  });

  afterEach(() => vi.unstubAllGlobals());

  function observer(): TestIntersectionObserver {
    const [only] = TestIntersectionObserver.instances;
    if (!only) throw new Error('the gate has no observer');
    return only;
  }

  function target(): HTMLElement {
    const el = document.createElement('div');
    scroller.append(el);
    return el;
  }

  /** Move the list at `pxPerS` for one 100 ms sample (which replaces the estimate outright). */
  function scrollAt(pxPerS: number): void {
    activity.start();
    activity.moved(0, 0);
    activity.moved(pxPerS / 10, 100);
  }

  describe('off (the default)', () => {
    it('starts every load at once, as the timeline always has', () => {
      gate.connect(scroller);
      scrollAt(10_000);
      const start = vi.fn();

      gate.whenReady(target(), start);

      expect(start).toHaveBeenCalledOnce();
    });
  });

  describe('on', () => {
    beforeEach(() => {
      gate.setEnabled(true);
      gate.connect(scroller);
    });

    it('watches for rows near the list’s own viewport, not the page’s', () => {
      expect(observer().root).toBe(scroller);
    });

    it('starts a load once its row is near the viewport while the list is still', () => {
      const el = target();
      const start = vi.fn();

      gate.whenReady(el, start);
      expect(start).not.toHaveBeenCalled();

      observer().report(el, true);
      expect(start).toHaveBeenCalledOnce();
      // Done with it: nothing more to watch.
      expect(observer().observed.has(el)).toBe(false);
    });

    it('leaves a row that is mounted but off screen alone until it comes near', () => {
      const el = target();
      const start = vi.fn();
      gate.whenReady(el, start);

      observer().report(el, false);
      expect(start).not.toHaveBeenCalled();

      observer().report(el, true);
      expect(start).toHaveBeenCalledOnce();
    });

    it('holds a row passing by during a fast scroll, and starts it when the scroll settles', () => {
      const el = target();
      const start = vi.fn();
      gate.whenReady(el, start);

      scrollAt(6_000);
      observer().report(el, true);
      expect(start).not.toHaveBeenCalled();

      activity.settle();
      expect(start).toHaveBeenCalledOnce();
    });

    it('starts a held row as soon as the scroll slows to reading speed', () => {
      const el = target();
      const start = vi.fn();
      gate.whenReady(el, start);
      scrollAt(6_000);
      observer().report(el, true);

      // 1,600 px/s is still faster than anyone reads.
      activity.moved(760, 200);
      expect(start).not.toHaveBeenCalled();

      activity.moved(900, 300);
      expect(activity.speed).toBeCloseTo(1_400);
      expect(start).toHaveBeenCalledOnce();
    });

    it('never starts a row that left the viewport before the scroll settled', () => {
      const el = target();
      const start = vi.fn();
      gate.whenReady(el, start);
      scrollAt(6_000);
      observer().report(el, true);
      observer().report(el, false);

      activity.settle();

      expect(start).not.toHaveBeenCalled();
    });

    it('starts only the rows near the viewport when the scroll settles', () => {
      const near = target();
      const far = target();
      const startNear = vi.fn();
      const startFar = vi.fn();
      gate.whenReady(near, startNear);
      gate.whenReady(far, startFar);
      scrollAt(6_000);
      observer().report(near, true);
      observer().report(far, false);

      activity.settle();

      expect(startNear).toHaveBeenCalledOnce();
      expect(startFar).not.toHaveBeenCalled();
    });

    it('forgets a row whose load is cancelled', () => {
      const el = target();
      const start = vi.fn();
      const cancel = gate.whenReady(el, start);
      scrollAt(6_000);
      observer().report(el, true);

      cancel();
      activity.settle();

      expect(start).not.toHaveBeenCalled();
      expect(observer().observed.has(el)).toBe(false);
    });

    it('starts everything still held when it is turned off', () => {
      const near = target();
      const far = target();
      const startNear = vi.fn();
      const startFar = vi.fn();
      gate.whenReady(near, startNear);
      gate.whenReady(far, startFar);
      scrollAt(6_000);
      observer().report(near, true);

      gate.setEnabled(false);

      expect(startNear).toHaveBeenCalledOnce();
      expect(startFar).toHaveBeenCalledOnce();
      expect(observer().observed.size).toBe(0);
    });

    it('stops watching when the list goes away', () => {
      const el = target();
      const start = vi.fn();
      gate.whenReady(el, start);
      scrollAt(6_000);
      observer().report(el, true);

      TestBed.resetTestingModule();
      activity.settle();

      expect(start).not.toHaveBeenCalled();
      expect(observer().disconnected).toBe(true);
    });
  });

  it('observes rows registered before the list rendered once it connects', () => {
    gate.setEnabled(true);
    const el = target();
    const start = vi.fn();
    gate.whenReady(el, start);

    gate.connect(scroller);
    observer().report(el, true);

    expect(start).toHaveBeenCalledOnce();
  });

  it('counts every row as near where IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    gate.setEnabled(true);
    gate.connect(scroller);
    const start = vi.fn();
    scrollAt(6_000);

    gate.whenReady(target(), start);
    expect(start).not.toHaveBeenCalled();

    activity.settle();
    expect(start).toHaveBeenCalledOnce();
  });
});
