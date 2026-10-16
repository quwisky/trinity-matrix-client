import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeScrollerHeight } from './scroller-height-anchor';

interface TestRO {
  observed: Set<Element>;
  emit(entries: ResizeObserverEntry[]): void;
}

describe('observeScrollerHeight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the pin it writes when the composer shrinks a pinned viewport', () => {
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
      frame(0);
      return 1;
    });
    const el = document.createElement('div');
    const box = { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400 };
    Object.defineProperties(el, {
      clientHeight: { get: () => box.clientHeight },
      scrollHeight: { get: () => box.scrollHeight },
      scrollTop: {
        get: () => box.scrollTop,
        set: (value: number) => (box.scrollTop = value),
      },
    });
    const wrote = vi.fn();
    observeScrollerHeight(el, undefined, wrote);
    const observer = (
      ResizeObserver as unknown as { instances: TestRO[] }
    ).instances.find((o) => o.observed.has(el)) as TestRO;

    // The composer grows by 100 px: the pinned reader stays pinned, 100 px further down.
    box.clientHeight = 500;
    observer.emit([]);

    expect(box.scrollTop).toBe(1500);
    expect(wrote).toHaveBeenCalledExactlyOnceWith(100);
  });
});
