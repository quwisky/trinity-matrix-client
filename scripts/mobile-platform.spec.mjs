import { describe, expect, it, vi } from 'vitest';
import { onlyOn } from '../e2e/mobile/support/platform.mts';

describe('mobile platform guard', () => {
  it('skips on the other platform and logs why', () => {
    const skip = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    onlyOn('android', 'no system Back on iOS', () => 'ios').call({
      skip,
      test: { fullTitle: () => 'mobile navigation Back' },
    });
    expect(skip).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[mobile] skipped on ios: mobile navigation Back — no system Back on iOS',
    );
    log.mockRestore();
  });

  it('runs on its own platform', () => {
    const skip = vi.fn();
    onlyOn('ios', 'reason', () => 'ios').call({
      skip,
      test: { fullTitle: () => 't' },
    });
    expect(skip).not.toHaveBeenCalled();
  });
});
