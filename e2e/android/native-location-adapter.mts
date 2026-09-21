import assert from 'node:assert/strict';
import type { MaestroDevice } from './maestro-session.mts';

const locationPermissions = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
] as const;

type LocationPermission = (typeof locationPermissions)[number];
type MockLocationMode =
  | 'allow'
  | 'default'
  | 'deny'
  | 'foreground'
  | 'ignore';

export interface NativeLocationPosition {
  readonly latitude: number;
  readonly longitude: number;
}

export interface NativeLocationProof {
  readonly position: NativeLocationPosition;
  readonly permissionBaselines: Readonly<Record<LocationPermission, boolean>>;
  readonly providerBaseline: { readonly enabled: boolean };
  readonly mockLocationBaseline: MockLocationMode;
  readonly pulseIntervalMs: 1_000;
}

export interface NativeLocationAdapter {
  readonly proof: NativeLocationProof;
  close(): Promise<void>;
}

function parsePermission(
  packageDump: string,
  permission: LocationPermission,
): boolean {
  const escapedPermission = permission.replaceAll('.', '\\.');
  const matches = [
    ...packageDump.matchAll(
      new RegExp(
        `^\\s*${escapedPermission}:\\s+granted=(true|false)\\b`,
        'gmu',
      ),
    ),
  ];
  assert(
    matches.length > 0,
    `Android package dump omitted ${permission}`,
  );
  return matches.at(-1)![1] === 'true';
}

function parseProviderEnabled(value: string): boolean {
  const normalized = value.trim();
  assert(
    /^\d+$/u.test(normalized),
    `Unexpected Android location-mode baseline: ${normalized || '<empty>'}`,
  );
  return Number(normalized) > 0;
}

function parseMockLocationMode(value: string): MockLocationMode {
  const match = value.match(
    /(?:MOCK_LOCATION|android:mock_location):\s*(allow|default|deny|foreground|ignore)\b/iu,
  );
  if (!match) return 'default';
  return match[1]!.toLowerCase() as MockLocationMode;
}

async function setLocation(
  device: MaestroDevice,
  position: NativeLocationPosition,
): Promise<void> {
  await device.adb(
    'shell',
    'cmd',
    'location',
    'providers',
    'set-test-provider-location',
    'gps',
    '--location',
    `${String(position.latitude)},${String(position.longitude)}`,
    '--accuracy',
    '1',
  );
}

export async function openNativeLocationAdapter(
  device: MaestroDevice,
  applicationId: 'eu.qwky.trinity',
  position: NativeLocationPosition,
  signal: AbortSignal,
): Promise<NativeLocationAdapter> {
  assert(Number.isFinite(position.latitude));
  assert(Number.isFinite(position.longitude));
  signal.throwIfAborted();

  const packageDump = await device.adb(
    'shell',
    'dumpsys',
    'package',
    applicationId,
  );
  const permissionBaselines = Object.fromEntries(
    locationPermissions.map((permission) => [
      permission,
      parsePermission(packageDump, permission),
    ]),
  ) as Record<LocationPermission, boolean>;
  const providerBaseline = {
    enabled: parseProviderEnabled(
      await device.adb(
        'shell',
        'settings',
        'get',
        'secure',
        'location_mode',
      ),
    ),
  };
  const mockLocationBaseline = parseMockLocationMode(
    await device.adb(
      'shell',
      'appops',
      'get',
      'com.android.shell',
      'android:mock_location',
    ),
  );

  let providerAdded = false;
  let locationPulse: ReturnType<typeof setInterval> | undefined;
  let locationPulseTask: Promise<void> | undefined;
  let locationPulseFailure: unknown;
  let closing: Promise<void> | undefined;

  const restore = async (): Promise<void> => {
    if (locationPulse) clearInterval(locationPulse);
    locationPulse = undefined;
    const failures: unknown[] = [];
    try {
      await locationPulseTask;
    } catch (error) {
      failures.push(error);
    }
    if (locationPulseFailure !== undefined) {
      failures.push(locationPulseFailure);
    }
    if (providerAdded) {
      try {
        await device.adb(
          'shell',
          'cmd',
          'location',
          'providers',
          'remove-test-provider',
          'gps',
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await device.adb(
        'shell',
        'appops',
        'set',
        'com.android.shell',
        'android:mock_location',
        mockLocationBaseline,
      );
    } catch (error) {
      failures.push(error);
    }
    for (const permission of [...locationPermissions].reverse()) {
      if (permissionBaselines[permission]) continue;
      try {
        await device.adb(
          'shell',
          'pm',
          'revoke',
          applicationId,
          permission,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(failures, 'Native location restore failed');
    }
  };

  try {
    for (const permission of locationPermissions) {
      if (permissionBaselines[permission]) continue;
      await device.adb('shell', 'pm', 'grant', applicationId, permission);
    }
    await device.adb(
      'shell',
      'appops',
      'set',
      'com.android.shell',
      'android:mock_location',
      'allow',
    );
    await device.adb(
      'shell',
      'cmd',
      'location',
      'providers',
      'add-test-provider',
      'gps',
      '--requiresSatellite',
      '--supportsAltitude',
      '--supportsSpeed',
      '--supportsBearing',
      '--powerRequirement',
      '3',
    );
    providerAdded = true;
    await device.adb(
      'shell',
      'cmd',
      'location',
      'providers',
      'set-test-provider-enabled',
      'gps',
      'true',
    );
    await setLocation(device, position);
    const pulse = (): void => {
      if (locationPulseTask) return;
      locationPulseTask = setLocation(device, position)
        .catch((error: unknown) => {
          locationPulseFailure ??= error;
        })
        .finally(() => {
          locationPulseTask = undefined;
        });
    };
    locationPulse = setInterval(pulse, 1_000);
  } catch (error) {
    try {
      await restore();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Native location setup and restore failed',
      );
    }
    throw error;
  }

  return {
    proof: {
      position,
      permissionBaselines,
      providerBaseline,
      mockLocationBaseline,
      pulseIntervalMs: 1_000,
    },
    close(): Promise<void> {
      return (closing ??= restore());
    },
  };
}
