/** Pure helpers that choose the iOS Simulator the mobile suite runs on. */

/** The device and runtime the macos-26 runner image ships (Xcode 26.6, simulator SDK 26.5). */
export const DEFAULT_IOS_DEVICE = 'iPhone 17';
export const DEFAULT_IOS_RUNTIME = 'iOS 26.5';

export interface Simulator {
  readonly udid: string;
  readonly name: string;
  /** CoreSimulator runtime key, e.g. com.apple.CoreSimulator.SimRuntime.iOS-26-5. */
  readonly runtime: string;
  readonly booted: boolean;
}

const RUNTIME_PREFIX = 'com.apple.CoreSimulator.SimRuntime.';

/** 'iOS 26.5' → com.apple.CoreSimulator.SimRuntime.iOS-26-5. */
export function runtimeIdentifier(runtime: string): string {
  const match = /^iOS (\d+)\.(\d+)$/u.exec(runtime.trim());
  if (!match) {
    throw new Error(
      `Unrecognised iOS runtime "${runtime}"; expected e.g. "iOS 26.5"`,
    );
  }
  return `${RUNTIME_PREFIX}iOS-${match[1]}-${match[2]}`;
}

interface SimctlDevice {
  readonly udid?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
  readonly isAvailable?: unknown;
}

/** Available devices from `xcrun simctl list -j devices available`. */
export function parseSimulators(json: string): Simulator[] {
  const parsed = JSON.parse(json) as {
    devices?: Record<string, readonly SimctlDevice[]>;
  };
  return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) =>
    devices
      .filter(
        (device) =>
          device.isAvailable !== false &&
          typeof device.udid === 'string' &&
          typeof device.name === 'string',
      )
      .map((device) => ({
        udid: device.udid as string,
        name: device.name as string,
        runtime,
        booted: device.state === 'Booted',
      })),
  );
}

/** The pinned device type on the pinned runtime, a booted one first; never a stand-in. */
export function selectSimulator(
  simulators: readonly Simulator[],
  wanted: {
    readonly device: string;
    readonly runtime: string;
    readonly udid?: string;
  },
): Simulator {
  if (wanted.udid) {
    const exact = simulators.find(({ udid }) => udid === wanted.udid);
    if (!exact)
      throw new Error(
        `TRINITY_IOS_UDID ${wanted.udid} is not an available simulator`,
      );
    return exact;
  }
  const runtime = runtimeIdentifier(wanted.runtime);
  const matches = simulators.filter(
    (simulator) =>
      simulator.name === wanted.device && simulator.runtime === runtime,
  );
  const chosen = matches.find(({ booted }) => booted) ?? matches[0];
  if (!chosen) {
    const available =
      simulators
        .map(
          ({ name, runtime: key }) =>
            `${name} (${key.replace(RUNTIME_PREFIX, '')})`,
        )
        .join(', ') || 'none';
    throw new Error(
      `No available ${wanted.device} simulator on ${wanted.runtime}; available: ${available}. ` +
        'Set TRINITY_IOS_DEVICE and TRINITY_IOS_RUNTIME, or TRINITY_IOS_UDID.',
    );
  }
  return chosen;
}
