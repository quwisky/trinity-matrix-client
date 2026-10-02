import { describe, expect, it, vi } from 'vitest';
import {
  ADB_FAILURE_LIMIT,
  nextAdbFailureCount,
  startAndroidInfrastructureWatchdog,
} from '../e2e/mobile/health.mts';

describe('Android E2E infrastructure health', () => {
  it('requires consecutive failed adb probes before aborting the suite', () => {
    expect(nextAdbFailureCount(0, undefined)).toBe(1);
    expect(nextAdbFailureCount(1, 'offline')).toBe(ADB_FAILURE_LIMIT);
    expect(nextAdbFailureCount(1, 'device')).toBe(0);
  });

  it('terminates once only after two failed adb probes and clears its force-kill timer', async () => {
    vi.useFakeTimers();
    try {
      const states = [undefined, 'offline'];
      let failureCount = 0;
      const inspect = vi.fn(async () => {
        failureCount = nextAdbFailureCount(failureCount, states.shift());
        return failureCount >= ADB_FAILURE_LIMIT
          ? new Error('transport lost')
          : undefined;
      });
      const terminate = vi.fn();
      const watchdog = startAndroidInfrastructureWatchdog({
        inspect,
        terminate,
        intervalMs: 10,
        forceKillAfterMs: 20,
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledWith('SIGTERM');
      expect(watchdog.failure?.message).toBe('transport lost');

      watchdog.stop();
      await vi.advanceTimersByTimeAsync(30);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-kills one unresponsive child after a classified failure', async () => {
    vi.useFakeTimers();
    try {
      const terminate = vi.fn();
      const watchdog = startAndroidInfrastructureWatchdog({
        inspect: async () => new Error('driver lost'),
        terminate,
        intervalMs: 10,
        forceKillAfterMs: 20,
      });

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(20);
      expect(terminate.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);

      watchdog.stop();
      await vi.advanceTimersByTimeAsync(30);
      expect(terminate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
