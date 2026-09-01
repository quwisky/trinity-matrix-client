import { describe, expect, it, vi } from 'vitest';
import {
  ADB_FAILURE_LIMIT,
  ANDROID_SURFACE_INITIAL_TIMEOUT_MS,
  ANDROID_SURFACE_RECOVERY_TIMEOUT_MS,
  ANDROID_WEBVIEW_LIVENESS_TIMEOUT_MS,
  ANDROID_INFRASTRUCTURE_FAILURE,
  crashProcessNames,
  isAndroidWebViewProbeUnavailable,
  isPlaywrightTargetLoss,
  nextAdbFailureCount,
  parseInfrastructureFailure,
  runAndroidInfrastructureOperation,
  startAndroidInfrastructureWatchdog,
  stabilizeApplicationSurface,
  trinityCrashProcessNames,
} from '../e2e/android/health.mts';

describe('Android E2E infrastructure health', () => {
  it('requires consecutive failed adb probes before aborting the suite', () => {
    expect(nextAdbFailureCount(0, undefined)).toBe(1);
    expect(nextAdbFailureCount(1, 'offline')).toBe(ADB_FAILURE_LIMIT);
    expect(nextAdbFailureCount(1, 'device')).toBe(0);
  });

  it('validates the fatal marker shared by the fixture and outer runner', () => {
    const failure = {
      kind: ANDROID_INFRASTRUCTURE_FAILURE,
      version: 1,
      layer: 'playwright-driver',
      serial: 'emulator-5554',
      summary: 'driver disappeared',
      recordedAt: '2026-09-01T00:00:00.000Z',
    };
    expect(parseInfrastructureFailure(JSON.stringify(failure))).toEqual(
      failure,
    );
    expect(() =>
      parseInfrastructureFailure('{"kind":"ordinary-test-failure"}'),
    ).toThrow('Invalid Android infrastructure failure marker');
    expect(() =>
      parseInfrastructureFailure(
        JSON.stringify({ ...failure, layer: 'unknown-layer' }),
      ),
    ).toThrow('Invalid Android infrastructure failure marker');
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

  it('classifies only verified target loss and preserves ordinary navigation errors', async () => {
    const classified = new Error('application-webview lost');
    const ordinary = new Error('page.goto: Timeout 30000ms exceeded');
    await expect(
      runAndroidInfrastructureOperation(
        async () => {
          throw new Error('Target page, context or browser has been closed');
        },
        isPlaywrightTargetLoss,
        () => classified,
      ),
    ).rejects.toBe(classified);
    await expect(
      runAndroidInfrastructureOperation(
        async () => {
          throw ordinary;
        },
        isPlaywrightTargetLoss,
        () => classified,
      ),
    ).rejects.toBe(ordinary);
    expect(
      isPlaywrightTargetLoss(
        new Error('page.goto: net::ERR_CONNECTION_CLOSED at https://localhost'),
      ),
    ).toBe(false);
    await expect(
      runAndroidInfrastructureOperation(
        async () => 'ready',
        isPlaywrightTargetLoss,
        () => classified,
      ),
    ).resolves.toBe('ready');
  });

  it('bounds a nonresponsive WebView liveness probe and clears a completed timer', async () => {
    vi.useFakeTimers();
    try {
      const unavailable = isAndroidWebViewProbeUnavailable(
        () => new Promise(() => undefined),
      );
      await vi.advanceTimersByTimeAsync(ANDROID_WEBVIEW_LIVENESS_TIMEOUT_MS);
      await expect(unavailable).resolves.toBe(true);

      await expect(
        isAndroidWebViewProbeUnavailable(async () => true),
      ).resolves.toBe(false);
      await expect(
        isAndroidWebViewProbeUnavailable(() => {
          throw new Error('Page has been closed');
        }),
      ).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scopes crash-buffer failures to Trinity package processes', () => {
    const crashLog = `
09-01 00:00:00.000  100  100 E AndroidRuntime: Process: com.google.android.bluetooth, PID: 100
09-01 00:00:01.000  200  200 F DEBUG: Cmdline: eu.qwky.trinity
09-01 00:00:02.000  300  300 F DEBUG: >>> eu.qwky.trinity.secondary:crypto <<<
`;
    expect(crashProcessNames(crashLog)).toEqual([
      'com.google.android.bluetooth',
      'eu.qwky.trinity',
      'eu.qwky.trinity.secondary:crypto',
    ]);
    expect(trinityCrashProcessNames(crashLog)).toEqual([
      'eu.qwky.trinity',
      'eu.qwky.trinity.secondary:crypto',
    ]);
    expect(
      trinityCrashProcessNames(
        'AndroidRuntime: Process: com.google.android.bluetooth, PID: 100',
      ),
    ).toEqual([]);
  });

  it('uses at most one bounded recovery for a stalled application surface', async () => {
    expect(ANDROID_SURFACE_INITIAL_TIMEOUT_MS).toBe(10_000);
    expect(ANDROID_SURFACE_RECOVERY_TIMEOUT_MS).toBe(30_000);
    const states = ['runtime-restoring', 'ready'];
    const inspect = vi.fn(async () => states.shift());
    const recover = vi.fn(async () => undefined);

    await expect(
      stabilizeApplicationSurface(inspect, recover),
    ).resolves.toEqual({
      state: 'ready',
      recovered: true,
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('preserves a final stall or blocked startup for classification', async () => {
    const stalled = vi
      .fn()
      .mockResolvedValueOnce('runtime-restoring')
      .mockResolvedValueOnce('runtime-restoring');
    const recover = vi.fn(async () => undefined);

    await expect(
      stabilizeApplicationSurface(stalled, recover),
    ).resolves.toEqual({
      state: 'runtime-restoring',
      recovered: true,
    });
    expect(recover).toHaveBeenCalledTimes(1);

    recover.mockClear();
    await expect(
      stabilizeApplicationSurface(async () => 'runtime-blocked', recover),
    ).resolves.toEqual({ state: 'runtime-blocked', recovered: false });
    expect(recover).not.toHaveBeenCalled();
  });
});
