import { describe, expect, it } from 'vitest';
import {
  ADB_FAILURE_LIMIT,
  ANDROID_INFRASTRUCTURE_FAILURE,
  crashProcessNames,
  nextAdbFailureCount,
  parseInfrastructureFailure,
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
});
