import { describe, expect, it, vi } from 'vitest';
import {
  ADB_FAILURE_LIMIT,
  ANDROID_INFRASTRUCTURE_FAILURE,
  crashProcessNames,
  nextAdbFailureCount,
  parseInfrastructureFailure,
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
