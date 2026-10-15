import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterPaint } from './after-paint';

function holdFrames(): { frame(): void; cancel: ReturnType<typeof vi.fn> } {
  const queued = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    next += 1;
    queued.set(next, callback);
    return next;
  });
  const cancel = vi.fn((id: number) => void queued.delete(id));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(cancel);
  return {
    frame: () => {
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback(0);
    },
    cancel,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('afterPaint', () => {
  it('emits once, after the second animation frame', () => {
    const { frame } = holdFrames();
    const seen = vi.fn();
    const done = vi.fn();
    afterPaint(window).subscribe({ next: seen, complete: done });
    frame();
    expect(seen).not.toHaveBeenCalled();
    frame();
    expect(seen).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });

  it('cancels the frame it waits for when unsubscribed', () => {
    const { frame, cancel } = holdFrames();
    const seen = vi.fn();
    const waiting = afterPaint(window).subscribe(seen);
    frame();
    waiting.unsubscribe();
    expect(cancel).toHaveBeenCalledWith(2);
    frame();
    expect(seen).not.toHaveBeenCalled();
  });
});
