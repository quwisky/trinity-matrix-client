export const REQUIRED_API_LEVEL = '36';
export const REQUIRED_ABI = 'x86_64';
export const DEFAULT_AVD = 'Trinity_API_36';

export interface DeviceProperties {
  apiLevel: string;
  abi: string;
  qemu: string;
}

export interface AdbDevice {
  serial: string;
  state: string;
}

/** Parse every adb target state so booting/offline emulator ports remain reserved. */
export function parseDevices(output: string): AdbDevice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/, 2))
    .filter(([serial, state]) => Boolean(serial && state))
    .map(([serial, state]) => ({ serial: serial!, state: state! }));
}

/** Parse only fully-online devices; offline/unauthorised targets are never candidates. */
export function parseOnlineDevices(output: string): string[] {
  return parseDevices(output)
    .filter(({ state }) => state === 'device')
    .map(({ serial }) => serial);
}

/** Return an existing reverse target for one local socket, if the device has one. */
export function reverseTarget(output: string, local: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const [, candidateLocal, remote] = line.trim().split(/\s+/);
    if (candidateLocal === local) return remote;
  }
  return undefined;
}

export function validateEmulator(properties: DeviceProperties): string[] {
  const problems: string[] = [];
  if (properties.qemu !== '1') problems.push('target is not an emulator');
  if (properties.apiLevel !== REQUIRED_API_LEVEL) {
    problems.push(
      `API ${properties.apiLevel || '<unknown>'} is not ${REQUIRED_API_LEVEL}`,
    );
  }
  if (properties.abi !== REQUIRED_ABI) {
    problems.push(`ABI ${properties.abi || '<unknown>'} is not ${REQUIRED_ABI}`);
  }
  return problems;
}

/** Allocate an unused even emulator console port without guessing a connected target. */
export function chooseEmulatorPort(serials: readonly string[]): number {
  const occupied = new Set(
    serials
      .map((serial) => /^emulator-(\d+)$/.exec(serial)?.[1])
      .filter((port): port is string => Boolean(port))
      .map(Number),
  );
  for (let port = 5554; port <= 5584; port += 2) {
    if (!occupied.has(port)) return port;
  }
  throw new Error('No free Android emulator console port in 5554-5584');
}
